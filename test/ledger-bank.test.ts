import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post, reverse } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import {
  importStatement, suggestMatches, confirmMatch, unmatch, postFromBankLine, reconcile,
  reconciliationSummary, fingerprintOf,
} from "@/lib/server/ledger/bank";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-bank";
const ENT = "t-ent-bank";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "BankStatementLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${ORG}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
  ]);
}

const P = (entryDate: string, lines: { account: string; debit?: number; credit?: number }[], memo = "") =>
  post({ orgId: ORG, entityId: ENT, entryDate, memo, source: "manual", lines });

const imp = (lines: Parameters<typeof importStatement>[0]["lines"], batch?: string) =>
  importStatement({ orgId: ORG, entityId: ENT, accountCode: "1010", lines, batch });

d("bank reconciliation", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  beforeEach(async () => {
    // Each test starts from an empty bank statement so ordering cannot matter.
    await db.$executeRawUnsafe(`DELETE FROM "BankStatementLine" WHERE "orgId" = '${ORG}'`);
  });

  it("refuses to import a statement onto an account that is not a bank account", async () => {
    await expect(
      importStatement({
        orgId: ORG, entityId: ENT, accountCode: "4000",
        lines: [{ postedOn: "2026-06-01", description: "x", amountMinor: 100 }],
      }),
    ).rejects.toThrow(/not a bank account/i);
  });

  it("refuses a zero-amount line, which cannot be reconciled to anything", async () => {
    await expect(imp([{ postedOn: "2026-06-01", description: "Nil", amountMinor: 0 }]))
      .rejects.toThrow(/zero amount/i);
  });

  it("imports a statement", async () => {
    const r = await imp([
      { postedOn: "2026-06-01", description: "Customer receipt", reference: "FT001", amountMinor: 250_000, balanceMinor: 250_000 },
      { postedOn: "2026-06-03", description: "Monthly account fee", amountMinor: -5_000, balanceMinor: 245_000 },
    ]);
    expect(r).toMatchObject({ imported: 2, duplicates: 0, total: 2 });
  });

  it("re-importing an overlapping file adds nothing", async () => {
    const lines = [
      { postedOn: "2026-06-01", description: "Customer receipt", reference: "FT001", amountMinor: 250_000, balanceMinor: 250_000 },
      { postedOn: "2026-06-03", description: "Monthly account fee", amountMinor: -5_000, balanceMinor: 245_000 },
    ];
    await imp(lines);
    // The same fortnight arrives again inside a wider export, plus one new line.
    const second = await imp([...lines, { postedOn: "2026-06-05", description: "New line", amountMinor: -1_000, balanceMinor: 244_000 }]);
    expect(second).toMatchObject({ imported: 1, duplicates: 2, total: 3 });
  });

  it("keeps two identical same-day transactions apart", async () => {
    // Two 50.00 card payments to the same merchant on the same day are two
    // real events. The running balance is what distinguishes them.
    const r = await imp([
      { postedOn: "2026-06-10", description: "Cafe", amountMinor: -5_000, balanceMinor: 100_000 },
      { postedOn: "2026-06-10", description: "Cafe", amountMinor: -5_000, balanceMinor: 95_000 },
    ]);
    expect(r.imported).toBe(2);
  });

  it("hashes the same line to the same fingerprint regardless of spacing or case", async () => {
    const a = fingerprintOf({ postedOn: "2026-06-01", description: "Customer  RECEIPT", amountMinor: 100n });
    const b = fingerprintOf({ postedOn: "2026-06-01", description: "customer receipt", amountMinor: 100n });
    expect(a).toBe(b);
  });

  it("suggests a match and says why", async () => {
    await P("2026-06-01", [{ account: "1010", debit: 250_000 }, { account: "4000", credit: 250_000 }], "Consulting receipt");
    await imp([{ postedOn: "2026-06-01", description: "Customer receipt", amountMinor: 250_000, balanceMinor: 250_000 }]);

    const s = await suggestMatches({ orgId: ORG, entityId: ENT, accountCode: "1010" });
    expect(s).toHaveLength(1);
    expect(s[0].dayGap).toBe(0);
    expect(s[0].confidence).toBeGreaterThanOrEqual(80);
    expect(s[0].why).toContain("the amount is identical");
    expect(s[0].why).toContain("same date");
  });

  it("suggests nothing when the amounts differ", async () => {
    await P("2026-06-02", [{ account: "1010", debit: 111_111 }, { account: "4000", credit: 111_111 }], "Odd receipt");
    await imp([{ postedOn: "2026-06-02", description: "Something else", amountMinor: 222_222 }]);
    const s = await suggestMatches({ orgId: ORG, entityId: ENT, accountCode: "1010" });
    expect(s.find((x) => x.amountMinor === "222222")).toBeUndefined();
  });

  it("drops its confidence when several postings fit equally well", async () => {
    await P("2026-06-15", [{ account: "1010", debit: 77_000 }, { account: "4000", credit: 77_000 }], "Twin one");
    await P("2026-06-15", [{ account: "1010", debit: 77_000 }, { account: "4000", credit: 77_000 }], "Twin two");
    await imp([{ postedOn: "2026-06-15", description: "Ambiguous", amountMinor: 77_000 }]);

    const s = await suggestMatches({ orgId: ORG, entityId: ENT, accountCode: "1010" });
    const amb = s.find((x) => x.amountMinor === "77000")!;
    expect(amb.confidence).toBeLessThanOrEqual(45);
    expect(amb.why.join(" ")).toMatch(/fit equally well/);
  });

  it("still reaches a posting at the far edge of the window, and no further", async () => {
    /*
     * The candidate postings are now asked for by date rather than read whole
     * and sifted, because reading every posting an account has ever carried is
     * what a five-year-old bank account makes expensive. The band has to be the
     * same rule the scoring already applied — three windows either side — or a
     * suggestion that used to be made silently stops being made.
     */
    await P("2026-06-16", [{ account: "1010", debit: 66_000 }, { account: "4000", credit: 66_000 }], "Fifteen days early");
    await P("2026-05-01", [{ account: "1010", debit: 55_000 }, { account: "4000", credit: 55_000 }], "Two months early");
    await imp([
      { postedOn: "2026-07-01", description: "Edge of the window", amountMinor: 66_000 },
      { postedOn: "2026-07-01", description: "Far outside it", amountMinor: 55_000 },
    ]);

    const s = await suggestMatches({ orgId: ORG, entityId: ENT, accountCode: "1010" });
    const edge = s.find((x) => x.amountMinor === "66000")!;
    expect(edge.dayGap).toBe(15);
    expect(s.find((x) => x.amountMinor === "55000")).toBeUndefined();
  });

  it("matches, and refuses to match the same posting twice", async () => {
    const e = await P("2026-06-20", [{ account: "1010", debit: 90_000 }, { account: "4000", credit: 90_000 }], "Receipt");
    await imp([
      { postedOn: "2026-06-20", description: "Receipt A", amountMinor: 90_000 },
      { postedOn: "2026-06-20", description: "Receipt B", amountMinor: 90_000, balanceMinor: 1 },
    ]);
    const bankLines = await db.bankStatementLine.findMany({ where: { orgId: ORG }, orderBy: { description: "asc" } });
    const journalLine = await db.journalLine.findFirst({ where: { entryId: e.id, account: { code: "1010" } } });

    await confirmMatch({ orgId: ORG, bankLineId: bankLines[0].id, journalLineId: journalLine!.id });
    // A second bank line claiming the same posting would let the reconciliation
    // appear to tie while double-counting. It is refused, and the refusal says
    // which line already claims it rather than surfacing a constraint error.
    await expect(confirmMatch({ orgId: ORG, bankLineId: bankLines[1].id, journalLineId: journalLine!.id }))
      .rejects.toThrow(/already matched to the bank line "Receipt A"/);
  });

  it("refuses to match two different amounts", async () => {
    const e = await P("2026-06-22", [{ account: "1010", debit: 30_000 }, { account: "4000", credit: 30_000 }]);
    await imp([{ postedOn: "2026-06-22", description: "Short payment", amountMinor: 29_500 }]);
    const b = await db.bankStatementLine.findFirst({ where: { orgId: ORG } });
    const j = await db.journalLine.findFirst({ where: { entryId: e.id, account: { code: "1010" } } });
    await expect(confirmMatch({ orgId: ORG, bankLineId: b!.id, journalLineId: j!.id }))
      .rejects.toThrow(/different amounts/i);
  });

  it("unmatches, so a mistake can be undone", async () => {
    const e = await P("2026-06-25", [{ account: "1010", debit: 60_000 }, { account: "4000", credit: 60_000 }]);
    await imp([{ postedOn: "2026-06-25", description: "Receipt", amountMinor: 60_000 }]);
    const b = await db.bankStatementLine.findFirst({ where: { orgId: ORG } });
    const j = await db.journalLine.findFirst({ where: { entryId: e.id, account: { code: "1010" } } });
    await confirmMatch({ orgId: ORG, bankLineId: b!.id, journalLineId: j!.id });
    const back = await unmatch({ orgId: ORG, bankLineId: b!.id });
    expect(back.status).toBe("unmatched");
    expect(back.matchedLineId).toBeNull();
  });

  it("books a bank charge nobody had recorded, and matches it in the same act", async () => {
    await imp([{ postedOn: "2026-07-02", description: "Monthly account fee", amountMinor: -5_000 }]);
    const b = await db.bankStatementLine.findFirst({ where: { orgId: ORG } });

    const r = await postFromBankLine({
      orgId: ORG, entityId: ENT, bankLineId: b!.id, contraAccount: "6350",
    });
    expect(r.reference).toMatch(/^BK-/);

    const after = await db.bankStatementLine.findUnique({ where: { id: b!.id } });
    expect(after?.status).toBe("matched");
    expect(after?.matchedLineId).not.toBeNull();

    const lines = await db.journalLine.findMany({ where: { entryId: r.entryId }, include: { account: true } });
    const charge = lines.find((l) => l.account.code === "6350");
    expect(charge?.txnAmountMinor).toBe(5_000n); // Dr expense
  });

  it("will not book the same bank line twice", async () => {
    await imp([{ postedOn: "2026-07-03", description: "Fee", amountMinor: -2_000 }]);
    const b = await db.bankStatementLine.findFirst({ where: { orgId: ORG } });
    await postFromBankLine({ orgId: ORG, entityId: ENT, bankLineId: b!.id, contraAccount: "6350" });
    await expect(postFromBankLine({ orgId: ORG, entityId: ENT, bankLineId: b!.id, contraAccount: "6350" }))
      .rejects.toThrow(/already matched/i);
  });

  it("explains the gap between our balance and the bank's, item by item", async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // Two receipts we posted; only the first has reached the bank.
    const a = await P("2026-08-01", [{ account: "1010", debit: 100_000 }, { account: "4000", credit: 100_000 }], "Receipt A");
    await P("2026-08-30", [{ account: "1010", debit: 40_000 }, { account: "4000", credit: 40_000 }], "Cheque in transit");
    // And a charge the bank took that we have not booked.
    await imp([
      { postedOn: "2026-08-01", description: "Receipt A", amountMinor: 100_000, balanceMinor: 100_000 },
      { postedOn: "2026-08-15", description: "Account fee", amountMinor: -3_000, balanceMinor: 97_000 },
    ]);
    const bankA = await db.bankStatementLine.findFirst({ where: { orgId: ORG, description: "Receipt A" } });
    const jA = await db.journalLine.findFirst({ where: { entryId: a.id, account: { code: "1010" } } });
    await confirmMatch({ orgId: ORG, bankLineId: bankA!.id, journalLineId: jA!.id });

    const rec = await reconcile({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf: new Date("2026-08-31") });
    expect(rec.ledgerBalanceMinor).toBe("140000");        // what our books say
    expect(rec.statementBalanceMinor).toBe("97000");      // what the bank says
    expect(rec.outstandingInLedgerMinor).toBe("40000");   // the cheque in transit
    expect(rec.unrecordedInBankMinor).toBe("-3000");      // the fee we never booked
    expect(rec.reconciledBalanceMinor).toBe("97000");
    expect(rec.reconciled).toBe(true);
    expect(rec.differenceMinor).toBe("0");

    // And the items are named, because "out by 43,000" is not an answer.
    expect(rec.unmatchedLedger.map((l) => l.memo)).toContain("Cheque in transit");
    expect(rec.unmatchedBank.map((b) => b.description)).toContain("Account fee");
  });

  it("reports zero difference rather than a false failure when the file gave no balance", async () => {
    await db.$executeRawUnsafe(`DELETE FROM "BankStatementLine" WHERE "orgId" = '${ORG}'`);
    await imp([{ postedOn: "2026-09-01", description: "No running balance", amountMinor: -1_500 }]);
    const rec = await reconcile({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf: new Date("2026-09-30") });
    expect(rec.statementBalanceMinor).toBeNull();
    expect(rec.reconciled).toBe(false); // unproven, not proven wrong
    expect(rec.differenceMinor).toBe("0");
  });

  it("lists the pairs already matched, so a wrong match can be seen at all", async () => {
    const e = await P("2026-10-05", [{ account: "1010", debit: 12_000 }, { account: "4000", credit: 12_000 }], "Deposit");
    await imp([{ postedOn: "2026-10-05", description: "Deposit", amountMinor: 12_000 }]);
    const b = await db.bankStatementLine.findFirst({ where: { orgId: ORG } });
    const j = await db.journalLine.findFirst({ where: { entryId: e.id, account: { code: "1010" } } });
    await confirmMatch({ orgId: ORG, bankLineId: b!.id, journalLineId: j!.id });

    const rec = await reconcile({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf: new Date("2026-10-31") });
    expect(rec.matched).toHaveLength(1);
    expect(rec.matched[0]).toMatchObject({
      bankLineId: b!.id,
      description: "Deposit",
      amountMinor: "12000",
      reference: `${e.series}-${e.number}`,
      entryStatus: "posted",
      reversedBy: null,
    });
    // A matched line belongs on neither open list — it is explained.
    expect(rec.unmatchedBank.map((x) => x.id)).not.toContain(b!.id);
    expect(rec.unmatchedLedger.map((x) => x.id)).not.toContain(j!.id);
  });

  it("names the reversal when a matched posting has been undone, and unmatch clears it", async () => {
    const e = await P("2026-10-10", [{ account: "1010", debit: 8_000 }, { account: "4900", credit: 8_000 }], "Booked to the wrong account");
    await imp([{ postedOn: "2026-10-10", description: "Transfer in", amountMinor: 8_000 }]);
    const b = await db.bankStatementLine.findFirst({ where: { orgId: ORG } });
    const j = await db.journalLine.findFirst({ where: { entryId: e.id, account: { code: "1010" } } });
    await confirmMatch({ orgId: ORG, bankLineId: b!.id, journalLineId: j!.id });

    // Reversing does not touch the match, so the statement line is left
    // pointing at an entry that has been undone.
    const rev = await reverse({ orgId: ORG, entryId: e.id });

    const rec = await reconcile({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf: new Date("2026-10-31") });
    const pair = rec.matched.find((m) => m.bankLineId === b!.id)!;
    expect(pair.entryStatus).toBe("reversed");
    expect(pair.reversedBy).toBe(`${rev.series}-${rev.number}`);

    // And the reversal's own bank line is an outstanding item that can never
    // clear, because the bank never saw either half of the pair.
    const phantom = rec.unmatchedLedger.filter((l) => l.reference === `${rev.series}-${rev.number}`);
    expect(phantom).toHaveLength(1);
    expect(phantom[0].amountMinor).toBe("-8000");

    await unmatch({ orgId: ORG, bankLineId: b!.id });
    const after = await reconcile({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf: new Date("2026-10-31") });
    expect(after.matched).toHaveLength(0);
    expect(after.unmatchedBank.map((x) => x.description)).toContain("Transfer in");
  });

  it("refuses to book a bank line twice rather than handing back the first entry", async () => {
    await imp([{ postedOn: "2026-11-02", description: "Card fee", amountMinor: -1_200 }]);
    const b = await db.bankStatementLine.findFirst({ where: { orgId: ORG } });
    const first = await postFromBankLine({ orgId: ORG, entityId: ENT, bankLineId: b!.id, contraAccount: "6350" });
    await unmatch({ orgId: ORG, bankLineId: b!.id });

    // post() is idempotent on its externalKey, so without an explicit refusal
    // a second attempt with a different contra account would silently return
    // the first entry and re-match to it — the wrong posting, reported as a
    // success.
    await expect(postFromBankLine({ orgId: ORG, entityId: ENT, bankLineId: b!.id, contraAccount: "6900" }))
      .rejects.toThrow(new RegExp(`already booked as ${first.reference}`));
  });

  /* ------------------------------------------------- reading a long history */

  /*
   * The reconciliation used to read every statement line and every posting the
   * account had ever carried, and return all of them — matched pairs included.
   * At two thousand transactions a month that is a hundred and twenty thousand
   * rows of each after five years, on a page nobody scrolls past the first
   * screen of, and it was called in a loop by the month-end checklist and the
   * attention list once per bank account. The figures are now asked of the
   * database and the lists are pages; these say the figures did not move.
   */
  describe("on an account with more history than anyone will read", () => {
    const asOf = new Date("2027-03-31");
    const DAYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const day = (month: string, n: number) => `2027-${month}-${String(n).padStart(2, "0")}`;
    /** The postings the bank has never seen, in the order they were made. */
    const inFlight = new Map<number, string>();
    /** The postings a statement line agreed with, keyed the same way. */
    const cleared = new Map<number, string>();

    beforeAll(async () => {
      await wipe();
      await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2027", startsOn: "2027-01-01" });
      await openBooks({ orgId: ORG, entityId: ENT });

      // Twelve receipts the bank has seen and agreed, and twelve it has not.
      for (const n of DAYS) {
        const e = await P(day("02", n), [{ account: "1010", debit: 1_000 * n }, { account: "4000", credit: 1_000 * n }], `Cleared ${n}`);
        const j = await db.journalLine.findFirst({ where: { entryId: e.id, account: { code: "1010" } } });
        cleared.set(n, j!.id);
      }
      for (const n of DAYS) {
        const e = await P(day("03", n), [{ account: "1010", debit: 100 * n }, { account: "4000", credit: 100 * n }], `In flight ${n}`);
        const j = await db.journalLine.findFirst({ where: { entryId: e.id, account: { code: "1010" } } });
        inFlight.set(n, j!.id);
      }
    });

    // The statement is emptied before every test in this file, so the bank's
    // side of the history is laid down again here rather than once above.
    beforeEach(async () => {
      await imp(
        DAYS.map((n) => ({ postedOn: day("02", n), description: `Cleared ${n}`, amountMinor: 1_000 * n })),
        "cleared",
      );
      await imp(
        DAYS.map((n) => ({ postedOn: day("03", n), description: `Unexplained ${n}`, amountMinor: -10 * n })),
        "unexplained",
      );
      const lines = await db.bankStatementLine.findMany({ where: { orgId: ORG, importBatch: "cleared" } });
      for (const b of lines) {
        const n = Number(b.description.replace("Cleared ", ""));
        await confirmMatch({ orgId: ORG, bankLineId: b.id, journalLineId: cleared.get(n)! });
      }
    });

    it("gives the same figures whether it lists four items or all of them", async () => {
      const whole = await reconcile({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf, limit: 1_000 });
      const paged = await reconcile({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf, limit: 4 });

      for (const k of [
        "ledgerBalanceMinor", "statementBalanceMinor", "outstandingInLedgerMinor",
        "unrecordedInBankMinor", "reconciledBalanceMinor", "differenceMinor",
        "unmatchedBankCount", "unmatchedLedgerCount", "matchedCount",
      ] as const) {
        expect(paged[k]).toEqual(whole[k]);
      }
      expect(paged.reconciled).toBe(whole.reconciled);

      // And the counts are the whole account, not the length of the page.
      expect(paged.unmatchedBank).toHaveLength(4);
      expect(paged.unmatchedLedger).toHaveLength(4);
      expect(paged.matched).toHaveLength(4);
      expect(paged.unmatchedBankCount).toBe(12);
      expect(paged.unmatchedLedgerCount).toBe(12);
      expect(paged.matchedCount).toBe(12);
    });

    it("says what the lists leave out rather than quietly returning less", async () => {
      const paged = await reconcile({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf, limit: 4 });
      expect(paged.itemLimit).toBe(4);
      expect(paged.itemsNote).toMatch(/oldest 4 of each/);
      expect(paged.itemsNote).toMatch(/4 of 12 unexplained statement lines/);
      expect(paged.itemsNote).toMatch(/4 of 12 postings the bank has not seen/);

      // Oldest first, so the item worth chasing is the one on the page.
      expect(paged.unmatchedBank[0].description).toBe("Unexplained 1");
      expect(paged.unmatchedLedger[0].memo).toBe("In flight 1");

      const whole = await reconcile({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf, limit: 1_000 });
      expect(whole.itemsNote).toMatch(/Every item behind this reconciliation is listed/);
    });

    it("answers the summary without a single row of itemisation", async () => {
      const summary = await reconciliationSummary({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf });
      const whole = await reconcile({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf, limit: 1_000 });

      expect(summary.ledgerBalanceMinor).toBe(whole.ledgerBalanceMinor);
      expect(summary.outstandingInLedgerMinor).toBe(whole.outstandingInLedgerMinor);
      expect(summary.unrecordedInBankMinor).toBe(whole.unrecordedInBankMinor);
      expect(summary.reconciledBalanceMinor).toBe(whole.reconciledBalanceMinor);
      expect(summary.unmatchedBankCount).toBe(12);
      expect(summary.unmatchedLedgerCount).toBe(12);
      expect(summary.matchedCount).toBe(12);
      // The oldest unexplained line, so a caller measuring how long something
      // has been sitting there does not have to pull the list down to find it.
      expect(summary.oldestUnmatchedBankOn).toBe("2027-03-01");

      // The point of the split: no rows come back at all.
      expect(Object.keys(summary)).not.toContain("unmatchedBank");
      expect(Object.keys(summary)).not.toContain("matched");
    });

    it("still leaves a posting outstanding when the bank line that matched it falls after the date", async () => {
      // A statement line dated in April against a posting dated in March. Read
      // to 31 March the match has not happened yet, so the posting is money the
      // bank has not seen — which is what the row-by-row version said, and what
      // the aggregate has to keep saying.
      const j = inFlight.get(1)!;
      await imp([{ postedOn: "2027-04-02", description: "Late clearing", amountMinor: 100 }], "april");
      const late = await db.bankStatementLine.findFirst({ where: { orgId: ORG, description: "Late clearing" } });
      await confirmMatch({ orgId: ORG, bankLineId: late!.id, journalLineId: j });

      const march = await reconcile({ orgId: ORG, entityId: ENT, accountCode: "1010", asOf, limit: 1_000 });
      expect(march.unmatchedLedger.map((l) => l.id)).toContain(j);
      expect(march.unmatchedLedgerCount).toBe(12);

      const april = await reconcile({
        orgId: ORG, entityId: ENT, accountCode: "1010", asOf: new Date("2027-04-30"), limit: 1_000,
      });
      expect(april.unmatchedLedger.map((l) => l.id)).not.toContain(j);
      expect(april.unmatchedLedgerCount).toBe(11);
    });

    it("does not suggest a posting another statement line has already claimed", async () => {
      // The exclusion used to be written as `id: { notIn: taken }`, one bind
      // parameter per matched posting, which PostgreSQL refuses past 65,535 of
      // them. It is sifted in memory now, and it has to exclude exactly the
      // same postings.
      const claims = await db.bankStatementLine.findMany({
        where: { orgId: ORG, matchedLineId: { not: null } },
        select: { matchedLineId: true },
      });
      const taken = new Set(claims.map((c) => c.matchedLineId as string));
      expect(taken.size).toBeGreaterThan(0);

      const suggestions = await suggestMatches({ orgId: ORG, entityId: ENT, accountCode: "1010" });
      for (const s of suggestions) expect(taken.has(s.journalLineId)).toBe(false);
    });
  });
});
