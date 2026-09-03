import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post } from "@/lib/server/ledger/post";
import { postInvoice } from "@/lib/server/ledger/ar";
import { postBill } from "@/lib/server/ledger/ap";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { balanceSheet } from "@/lib/server/ledger/statements";
import { createGroup, addMember } from "@/lib/server/ledger/consolidation";
import { createCounterparty } from "@/lib/server/ledger/counterparties";
import {
  findMatches,
  matchReport,
  eliminationSchedule,
  unrealisedProfit,
} from "@/lib/server/ledger/intercompany";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-ic";
const A = "t-ent-ic-a";
const B = "t-ent-ic-b";

const A_TRN = "100000000000001";
const B_TRN = "100000000000002";
const A_NAME = "Alpha Trading LLC";
const B_NAME = "Beta Distribution LLC";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "ConsolidationMember" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ConsolidationGroup" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${ORG}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Counterparty" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Record" WHERE "orgId" = '${ORG}'`),
  ]);
}

/* ---------------------------------------------------------------- seeding */

const P = (
  entityId: string,
  entryDate: string,
  lines: { account: string; debit?: number; credit?: number }[],
  memo = "",
  extra: { source?: string; sourceId?: string; settlesId?: string } = {},
) =>
  post({
    orgId: ORG, entityId, entryDate, memo,
    source: extra.source ?? "manual",
    sourceId: extra.sourceId,
    settlesId: extra.settlesId,
    lines,
  });

let seq = 0;
const netLine = (net: number, profile: TaxProfileCode = "ZERO_OTHER"): InvoiceLine => ({
  id: `icl${++seq}`, lineNo: seq, description: "Goods", qty: 1, unitCode: "C62",
  unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: 0,
});

/** A document in the tenant store, and the entry it made. Both, because attribution needs both. */
async function issueInvoice(opts: {
  id: string; entityId: string; number: string; issueDate: string; net: number;
  customerCode: string; buyerName: string; buyerTrn?: string;
}) {
  const inv = {
    id: opts.id, orgId: ORG, entityId: opts.entityId, direction: "OUTBOUND", docType: "TAX_INVOICE",
    number: opts.number, issueDate: opts.issueDate, supplyDate: opts.issueDate, currency: "AED",
    customerId: opts.customerCode,
    buyer: { nameEn: opts.buyerName, trn: opts.buyerTrn },
    seller: { nameEn: A_NAME },
    lines: [netLine(opts.net)],
    totals: { taxExclusiveMinor: opts.net, vatMinor: 0, taxInclusiveMinor: opts.net, payableMinor: opts.net, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED", source: "EDITOR",
    compliance: { taxableEventDate: opts.issueDate, daysRemaining: 14, breached: false },
    createdAt: `${opts.issueDate}T00:00:00Z`, updatedAt: `${opts.issueDate}T00:00:00Z`,
  } as unknown as Invoice;
  await db.record.create({
    data: { id: inv.id, orgId: ORG, store: "invoices", entityId: opts.entityId, data: JSON.stringify(inv) },
  });
  await postInvoice({ orgId: ORG, invoice: inv });
  return inv;
}

async function issueBill(opts: {
  id: string; entityId: string; number: string; issueDate: string; net: number; sellerName: string;
}) {
  const bill = {
    id: opts.id, orgId: ORG, entityId: opts.entityId, direction: "INBOUND", docType: "TAX_INVOICE",
    number: opts.number, issueDate: opts.issueDate, supplyDate: opts.issueDate, currency: "AED",
    buyer: { nameEn: B_NAME }, seller: { nameEn: opts.sellerName },
    lines: [netLine(opts.net)],
    totals: { taxExclusiveMinor: opts.net, vatMinor: 0, taxInclusiveMinor: opts.net, payableMinor: opts.net, perCategory: [] },
    lifecycleStatus: "RECEIVED", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED", source: "INGEST",
    compliance: { taxableEventDate: opts.issueDate, daysRemaining: 14, breached: false },
    createdAt: `${opts.issueDate}T00:00:00Z`, updatedAt: `${opts.issueDate}T00:00:00Z`,
  } as unknown as Invoice;
  await db.record.create({
    data: { id: bill.id, orgId: ORG, store: "invoices", entityId: opts.entityId, data: JSON.stringify(bill) },
  });
  await postBill({ orgId: ORG, bill });
  return bill;
}

/** The window every figure below is stated over. */
const YEAR = { from: "2026-01-01", to: "2026-12-31" };

/*
 * The two books these tests read, stated here so nothing below has to be
 * reverse-engineered from the assertions. A sells, B buys.
 *
 *   05 Mar  A invoices B 300,000  (INV-1 / BILL-1, both documents stored,
 *                                  A's counterparty IC-B carries B's TRN)
 *                                  → the clean pair: attributed, same amount,
 *                                    same day
 *   12 Mar  ONE document ic-doc-shared posted into both books at 120,000,
 *           A on the 12th and B on the 20th → the same document in both sets
 *           of books, eight days apart, which no amount-and-date rule would pair
 *   18 Mar  A invoices B 90,000 (INV-3) and B never posts the bill
 *                                  → a one-sided posting, reported, not dropped
 *   25 Mar  B bills a supplier outside the group 50,000
 *                                  → an unmatched payable that is not a defect
 *   02 Apr  A raises 75,000 on 1100 with no document in the store
 *   22 Apr  B raises 75,000 on 2000                    → same amount, 20 days
 *                                                        apart, nothing else
 *   10 Feb  A invoices B 40,000 (INV-SET / BILL-SET) and both settle it on
 *           20 Feb                → matched, but nothing left to eliminate on
 *                                   the balance sheet
 *   30 Jun  B distributes 200,000 and A recognises it as income
 */
const CLEAN_INV = "ic-inv-1";
const CLEAN_BILL = "ic-bill-1";
const SHARED_DOC = "ic-doc-shared";
const ONE_SIDED = "ic-inv-3";
const THIRD_PARTY = "ic-bill-outside";
const LOOSE_R = "ic-loose-r";
const LOOSE_P = "ic-loose-p";
const SETTLED_INV = "ic-inv-settled";
const SETTLED_BILL = "ic-bill-settled";

d("intercompany matching and elimination", () => {
  beforeAll(async () => {
    await wipe();

    for (const entityId of [A, B]) {
      await openFiscalYear({ orgId: ORG, entityId, label: "2026", startsOn: "2026-01-01" });
      await openBooks({ orgId: ORG, entityId });
    }

    // The entity records: a member's legal name and TRN live here, and they are
    // the only bridge between a counterparty in one member's ledger and another
    // member of the group.
    for (const [id, legalNameEn, trn] of [[A, A_NAME, A_TRN], [B, B_NAME, B_TRN]] as const) {
      await db.record.create({
        data: {
          id, orgId: ORG, store: "entities",
          data: JSON.stringify({ id, orgId: ORG, legalNameEn, trn, vatRegistered: true, defaultCurrency: "AED" }),
        },
      });
    }

    // Cash to trade with.
    await P(A, "2026-01-02", [{ account: "1010", debit: 5_000_000 }, { account: "3000", credit: 5_000_000 }], "Share capital");
    await P(B, "2026-01-02", [{ account: "1010", debit: 3_000_000 }, { account: "3000", credit: 3_000_000 }], "Share capital");

    await createCounterparty({
      orgId: ORG, entityId: A,
      counterparty: { code: "IC-B", name: B_NAME, trn: B_TRN, paymentTerms: 30 },
    });
    // A customer of A's that is nothing to do with the group, so attribution has
    // something to get wrong and does not.
    await createCounterparty({
      orgId: ORG, entityId: A,
      counterparty: { code: "OUTSIDE", name: "Somebody Else LLC", paymentTerms: 30 },
    });

    // 1. The clean pair.
    await issueInvoice({
      id: CLEAN_INV, entityId: A, number: "INV-1", issueDate: "2026-03-05", net: 300_000,
      customerCode: "IC-B", buyerName: B_NAME, buyerTrn: B_TRN,
    });
    await issueBill({
      id: CLEAN_BILL, entityId: B, number: "BILL-1", issueDate: "2026-03-05", net: 300_000, sellerName: A_NAME,
    });

    // 2. One document, both sets of books — a shared-services team posting the
    //    same intragroup invoice into the seller's and the buyer's ledger.
    await P(A, "2026-03-12", [{ account: "1100", debit: 120_000 }, { account: "4100", credit: 120_000 }],
      "Management fee to Beta", { source: "invoice", sourceId: SHARED_DOC });
    await P(B, "2026-03-20", [{ account: "6250", debit: 120_000 }, { account: "2000", credit: 120_000 }],
      "Management fee from Alpha", { source: "bill", sourceId: SHARED_DOC });

    // 3. One-sided: A invoices B and B never books it.
    await issueInvoice({
      id: ONE_SIDED, entityId: A, number: "INV-3", issueDate: "2026-03-18", net: 90_000,
      customerCode: "IC-B", buyerName: B_NAME, buyerTrn: B_TRN,
    });

    // 4. A genuine third-party payable in B.
    await P(B, "2026-03-25", [{ account: "6900", debit: 50_000 }, { account: "2000", credit: 50_000 }],
      "Office supplies from outside the group", { source: "bill", sourceId: THIRD_PARTY });

    // 5. Two equal amounts twenty days apart, with nothing else to go on.
    await P(A, "2026-04-02", [{ account: "1100", debit: 75_000 }, { account: "4000", credit: 75_000 }],
      "Unattributed sale", { source: "invoice", sourceId: LOOSE_R });
    await P(B, "2026-04-22", [{ account: "6900", debit: 75_000 }, { account: "2000", credit: 75_000 }],
      "Unattributed purchase", { source: "bill", sourceId: LOOSE_P });

    // 6. An intragroup sale that has been settled in cash.
    await issueInvoice({
      id: SETTLED_INV, entityId: A, number: "INV-SET", issueDate: "2026-02-10", net: 40_000,
      customerCode: "IC-B", buyerName: B_NAME, buyerTrn: B_TRN,
    });
    await issueBill({
      id: SETTLED_BILL, entityId: B, number: "BILL-SET", issueDate: "2026-02-10", net: 40_000, sellerName: A_NAME,
    });
    await P(A, "2026-02-20", [{ account: "1010", debit: 40_000 }, { account: "1100", credit: 40_000 }],
      "Receipt from Beta", { source: "payment", settlesId: SETTLED_INV });
    await P(B, "2026-02-20", [{ account: "2000", debit: 40_000 }, { account: "1010", credit: 40_000 }],
      "Payment to Alpha", { source: "payment", settlesId: SETTLED_BILL });

    // 7. A dividend inside the group.
    await P(B, "2026-06-30", [{ account: "3900", debit: 200_000 }, { account: "1010", credit: 200_000 }],
      "Dividend to the parent");
    await P(A, "2026-06-30", [{ account: "1010", debit: 200_000 }, { account: "4900", credit: 200_000 }],
      "Dividend from Beta");

    await createGroup({ orgId: ORG, code: "IC", name: "Intercompany group", currency: "AED" });
    await addMember({ orgId: ORG, groupCode: "IC", entityId: A, isParent: true });
    await addMember({ orgId: ORG, groupCode: "IC", entityId: B });

    // A second group, so a refusal has something to list and scoping has
    // something to exclude.
    await createGroup({ orgId: ORG, code: "SOLO", name: "One member only", currency: "AED" });
    await addMember({ orgId: ORG, groupCode: "SOLO", entityId: A, isParent: true });
  });

  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ----------------------------------------------------------- the matching */

  it("matches a clean pair at high confidence, naming the counterparty as the evidence", async () => {
    const m = await findMatches({ orgId: ORG, groupCode: "IC", ...YEAR });
    const pair = m.matches.find((x) => x.receivable.documentKey === CLEAN_INV)!;
    expect(pair).toBeDefined();
    expect(pair.confidence).toBe("high");
    expect(pair.receivable.entityId).toBe(A);
    expect(pair.payable.entityId).toBe(B);
    expect(pair.receivable.grossMinor).toBe("300000");
    expect(pair.payable.grossMinor).toBe("300000");
    expect(pair.dateGapDays).toBe(0);
    expect(pair.amountDifferenceMinor).toBe("0");
    expect(pair.evidence.map((e) => e.kind)).toContain("counterparty");
    expect(pair.receivable.counterpartyEntityId).toBe(B);
    expect(pair.receivable.attributionBasis).toMatch(/TRN/);
  });

  it("treats one document in both sets of books as certain, whatever the dates say", async () => {
    const m = await findMatches({ orgId: ORG, groupCode: "IC", ...YEAR });
    const pair = m.matches.find((x) => x.receivable.documentKey === SHARED_DOC)!;
    expect(pair).toBeDefined();
    expect(pair.confidence).toBe("certain");
    // Eight days apart, which no amount-and-date rule would call certain.
    expect(pair.dateGapDays).toBe(8);
    expect(pair.evidence.some((e) => e.kind === "document")).toBe(true);
    expect(pair.payable.documentKey).toBe(SHARED_DOC);
  });

  it("does not match two equal amounts on different dates at high confidence", async () => {
    const m = await findMatches({ orgId: ORG, groupCode: "IC", ...YEAR });
    const pair = m.matches.find((x) => x.receivable.documentKey === LOOSE_R)!;
    expect(pair).toBeDefined();
    expect(pair.dateGapDays).toBe(20);
    expect(pair.confidence).toBe("possible");
    expect(["certain", "high"]).not.toContain(pair.confidence);
    // Nothing attributes it, and the evidence says exactly that much.
    expect(pair.receivable.counterpartyEntityId).toBeNull();
    expect(pair.evidence.some((e) => e.kind === "counterparty")).toBe(false);
    expect(pair.basis).toMatch(/checked before it is believed/i);
  });

  it("reports a one-sided posting rather than dropping it, and says which member owes it", async () => {
    const m = await findMatches({ orgId: ORG, groupCode: "IC", ...YEAR });
    expect(m.matches.some((x) => x.receivable.documentKey === ONE_SIDED)).toBe(false);
    const stranded = m.unmatched.find((u) => u.documentKey === ONE_SIDED)!;
    expect(stranded).toBeDefined();
    expect(stranded.side).toBe("receivable");
    expect(stranded.entityId).toBe(A);
    expect(stranded.grossMinor).toBe("90000");
    expect(stranded.attributedToMember).toBe(true);
    expect(stranded.finding).toContain(B);
    expect(stranded.finding).toMatch(/has not posted the bill/);
    expect(m.totals.unmatchedAttributedMinor).toBe("90000");
  });

  it("says plainly that an unattributed unmatched balance may be a real third-party one", async () => {
    const m = await findMatches({ orgId: ORG, groupCode: "IC", ...YEAR });
    const outside = m.unmatched.find((u) => u.documentKey === THIRD_PARTY)!;
    expect(outside).toBeDefined();
    expect(outside.side).toBe("payable");
    expect(outside.entityId).toBe(B);
    expect(outside.attributedToMember).toBe(false);
    expect(outside.finding).toMatch(/outside IC there is nothing to eliminate/);
  });

  it("counts the matched amount once, not once per side", async () => {
    const m = await findMatches({ orgId: ORG, groupCode: "IC", ...YEAR });
    // 300,000 + 120,000 + 75,000 + 40,000.
    expect(m.totals.matchedCount).toBe(4);
    expect(m.totals.matchedMinor).toBe("535000");
    expect(m.totals.unmatchedReceivableMinor).toBe("90000");
    expect(m.totals.unmatchedPayableMinor).toBe("50000");
    expect(m.totals.carriedDifferenceMinor).toBe("40000");
  });

  it("produces the same pairs on every run", async () => {
    const first = await findMatches({ orgId: ORG, groupCode: "IC", ...YEAR });
    const second = await findMatches({ orgId: ORG, groupCode: "IC", ...YEAR });
    expect(second.matches.map((m) => `${m.receivable.documentKey}/${m.payable.documentKey}/${m.confidence}`))
      .toEqual(first.matches.map((m) => `${m.receivable.documentKey}/${m.payable.documentKey}/${m.confidence}`));
  });

  it("does not reach outside the named group's members", async () => {
    // SOLO holds A alone, so it has nothing to match against and is refused by
    // name rather than quietly returning nil.
    await expect(findMatches({ orgId: ORG, groupCode: "SOLO", ...YEAR }))
      .rejects.toThrow(/one member, t-ent-ic-a/);
  });

  /* ------------------------------------------------------------- the report */

  it("splits the findings by entity and by side", async () => {
    const r = await matchReport({ orgId: ORG, groupCode: "IC", ...YEAR });
    const arA = r.byEntity.find((x) => x.entityId === A && x.side === "receivable")!;
    const apB = r.byEntity.find((x) => x.entityId === B && x.side === "payable")!;
    expect(arA.matchedCount).toBe(4);
    expect(arA.unmatchedCount).toBe(1);
    expect(arA.unmatchedMinor).toBe("90000");
    expect(arA.totalMinor).toBe("625000"); // 535,000 matched + 90,000 not
    expect(apB.matchedCount).toBe(4);
    expect(apB.unmatchedMinor).toBe("50000");
    // B never sold to anybody, so its receivable side is present and empty
    // rather than missing — a blank row reads as "not applicable".
    const arB = r.byEntity.find((x) => x.entityId === B && x.side === "receivable")!;
    expect(arB).toBeDefined();
    expect(arB.totalMinor).toBe("0");
  });

  it("groups the matches by confidence with what each tier means", async () => {
    const r = await matchReport({ orgId: ORG, groupCode: "IC", ...YEAR });
    const byKey = Object.fromEntries(r.byConfidence.map((c) => [c.confidence, c]));
    expect(byKey.certain.count).toBe(1);
    expect(byKey.high.count).toBe(2); // the clean pair and the settled one
    expect(byKey.probable.count).toBe(0);
    expect(byKey.possible.count).toBe(1);
    expect(byKey.possible.meaning).toMatch(/Check it/);
    expect(r.byConfidence.reduce((a, c) => a + c.count, 0)).toBe(r.matches.length);
  });

  it("shows the members' own control balances beside the matched figures", async () => {
    const r = await matchReport({ orgId: ORG, groupCode: "IC", ...YEAR });
    const controlA = r.control.find((c) => c.entityId === A)!;
    const sheet = await balanceSheet({ orgId: ORG, entityId: A, asOf: YEAR.to });
    expect(controlA.receivableMinor).toBe(sheet.assets.lines.find((l) => l.code === "1100")!.presentedMinor);
    expect(r.summary).toMatch(/could not be paired/);
  });

  /* -------------------------------------------------- the elimination schedule */

  it("eliminates the receivable against the payable and nets both sides to nothing", async () => {
    const s = await eliminationSchedule({ orgId: ORG, groupCode: "IC", asOf: "2026-12-31", from: "2026-01-01" });
    const balances = s.entries.filter((e) => e.kind === "trade_balance");
    expect(balances.length).toBeGreaterThan(0);

    for (const e of balances) {
      const debit = e.lines.reduce((a, l) => a + BigInt(l.debitMinor), 0n);
      const credit = e.lines.reduce((a, l) => a + BigInt(l.creditMinor), 0n);
      expect(debit).toBe(credit);
      expect(e.lines.find((l) => l.accountCode === "2000")!.debitMinor).toBe(e.totalMinor);
      expect(e.lines.find((l) => l.accountCode === "1100")!.creditMinor).toBe(e.totalMinor);
      expect(e.authority).toMatch(/IFRS 10\.B86\(c\)/);
    }

    // 300,000 still open plus 120,000 still open. The 40,000 settled in
    // February left no balance, and the 75,000 pair did.
    const total = balances.reduce((a, e) => a + BigInt(e.totalMinor), 0n);
    expect(total).toBe(495_000n);
    expect(s.balanced).toBe(true);
    expect(s.totalDebitMinor).toBe(s.totalCreditMinor);
  });

  it("eliminates intercompany revenue against the cost the other member booked", async () => {
    const s = await eliminationSchedule({ orgId: ORG, groupCode: "IC", asOf: "2026-12-31", from: "2026-01-01" });
    const results = s.entries.filter((e) => e.kind === "trade_result");
    const clean = results.find((e) => e.key.includes(CLEAN_INV))!;
    expect(clean).toBeDefined();
    expect(clean.totalMinor).toBe("300000");
    expect(clean.lines.find((l) => l.entityId === A)!.debitMinor).toBe("300000");
    expect(clean.lines.find((l) => l.entityId === B)!.creditMinor).toBe("300000");

    // A sale settled in cash leaves nothing on the balance sheet and still has
    // to come out of revenue and cost — the group did not sell anything.
    const settled = results.find((e) => e.key.includes(SETTLED_INV))!;
    expect(settled).toBeDefined();
    expect(settled.totalMinor).toBe("40000");
    expect(s.entries.some((e) => e.kind === "trade_balance" && e.key.includes(SETTLED_INV))).toBe(false);
  });

  it("eliminates a dividend paid inside the group against the payer's retained earnings", async () => {
    const s = await eliminationSchedule({ orgId: ORG, groupCode: "IC", asOf: "2026-12-31", from: "2026-01-01" });
    const dividend = s.entries.find((e) => e.kind === "dividend")!;
    expect(dividend).toBeDefined();
    expect(dividend.totalMinor).toBe("200000");
    const income = dividend.lines.find((l) => l.accountCode === "4900")!;
    const equity = dividend.lines.find((l) => l.accountCode === "3900")!;
    expect(income.entityId).toBe(A);
    expect(income.debitMinor).toBe("200000");
    expect(equity.entityId).toBe(B);
    expect(equity.creditMinor).toBe("200000");
    // Nothing in the ledger records who holds the shares, so this is never certain.
    expect(dividend.confidence).not.toBe("certain");
    expect(dividend.narrative).toMatch(/who holds the shares/);
  });

  it("says on the schedule itself that it is not posted anywhere, and why", async () => {
    const s = await eliminationSchedule({ orgId: ORG, groupCode: "IC", asOf: "2026-12-31" });
    expect(s.posted).toBe(false);
    expect(s.postingNote).toMatch(/belongs to the group/i);
    expect(s.postingNote).toMatch(/statutory accounts/i);
    expect(s.postingNote).toContain(A);
    expect(s.postingNote).toContain(B);
  });

  it("defaults the period to the members' own fiscal year rather than guessing a calendar one", async () => {
    const s = await eliminationSchedule({ orgId: ORG, groupCode: "IC", asOf: "2026-12-31" });
    expect(s.from).toBe("2026-01-01");
    expect(s.asOf).toBe("2026-12-31");
  });

  /* ------------------------------------------------------ unrealised profit */

  it("eliminates the margin on stock still inside the group and not the cost", async () => {
    const u = await unrealisedProfit({
      orgId: ORG, groupCode: "IC", asOf: "2026-12-31", from: "2026-01-01",
      stock: [{
        sellerEntityId: A, holderEntityId: B, item: "Widgets",
        quantity: 10, unitTransferPriceMinor: 10_000, unitCostMinor: 6_000,
      }],
    });
    expect(u.totalCarryingMinor).toBe("100000");
    expect(u.totalCostMinor).toBe("60000");
    expect(u.totalUnrealisedProfitMinor).toBe("40000");
    expect(u.rows[0].basis).toBe("stated_cost");
    expect(u.rows[0].marginBps).toBe("4000");

    const e = u.elimination!;
    expect(e.totalMinor).toBe("40000");
    // The margin comes off; the 60,000 of cost stays exactly where it is.
    expect(e.lines.find((l) => l.accountCode === "1200")!.creditMinor).toBe("40000");
    expect(e.lines.find((l) => l.accountCode === "5000")!.debitMinor).toBe("40000");
    expect(e.lines.some((l) => l.creditMinor === "100000" || l.creditMinor === "60000")).toBe(false);
  });

  it("says that the quantities were supplied and could not have been derived", async () => {
    const u = await unrealisedProfit({
      orgId: ORG, groupCode: "IC", asOf: "2026-12-31",
      stock: [{ sellerEntityId: A, holderEntityId: B, quantity: 1, unitTransferPriceMinor: 100, unitCostMinor: 40 }],
    });
    expect(u.inputNote).toMatch(/supplied by whoever ran this/i);
    expect(u.inputNote).toMatch(/fungible/);
    expect(u.elimination!.narrative).toMatch(/supplied, not derived/);
  });

  it("falls back to the seller's own gross margin when no cost is given, and says it is an average", async () => {
    const u = await unrealisedProfit({
      orgId: ORG, groupCode: "IC", asOf: "2026-12-31", from: "2026-01-01",
      stock: [{ sellerEntityId: A, holderEntityId: B, quantity: 2, unitTransferPriceMinor: 50_000 }],
    });
    expect(u.rows[0].basis).toBe("seller_gross_margin");
    // A has revenue and no cost of sales at all, so its margin is 100% and the
    // whole transfer price is unrealised. That is what the ledger says, and the
    // warning is what stops it being mistaken for a measurement.
    expect(u.totalUnrealisedProfitMinor).toBe("100000");
    expect(u.warnings.some((w) => /average over everything it sold/.test(w))).toBe(true);
    expect(u.elimination!.confidence).toBe("probable");
  });

  it("refuses stock whose seller or holder is not in the group, and refuses a sale to itself", async () => {
    const base = { orgId: ORG, groupCode: "IC", asOf: "2026-12-31" };
    await expect(unrealisedProfit({
      ...base, stock: [{ sellerEntityId: "t-ent-ic-z", holderEntityId: B, quantity: 1, unitTransferPriceMinor: 10 }],
    })).rejects.toThrow(/not a member of IC/);
    await expect(unrealisedProfit({
      ...base, stock: [{ sellerEntityId: A, holderEntityId: A, quantity: 1, unitTransferPriceMinor: 10 }],
    })).rejects.toThrow(/selling to itself/);
  });

  /* ----------------------------------------------------------- posts nothing */

  it("posts nothing: every entity's trial balance is exactly what it was", async () => {
    const before = {
      entries: await db.journalEntry.count({ where: { orgId: ORG } }),
      lines: await db.journalLine.count({ where: { orgId: ORG } }),
      a: await trialBalance({ orgId: ORG, entityId: A, periodLabel: "2026-03" }),
      b: await trialBalance({ orgId: ORG, entityId: B, periodLabel: "2026-03" }),
      aSheet: await balanceSheet({ orgId: ORG, entityId: A, asOf: YEAR.to }),
      bSheet: await balanceSheet({ orgId: ORG, entityId: B, asOf: YEAR.to }),
    };

    await findMatches({ orgId: ORG, groupCode: "IC", ...YEAR });
    await matchReport({ orgId: ORG, groupCode: "IC", ...YEAR });
    await eliminationSchedule({
      orgId: ORG, groupCode: "IC", asOf: "2026-12-31", from: "2026-01-01",
      stock: [{ sellerEntityId: A, holderEntityId: B, quantity: 10, unitTransferPriceMinor: 10_000, unitCostMinor: 6_000 }],
    });
    await unrealisedProfit({
      orgId: ORG, groupCode: "IC", asOf: "2026-12-31",
      stock: [{ sellerEntityId: A, holderEntityId: B, quantity: 10, unitTransferPriceMinor: 10_000, unitCostMinor: 6_000 }],
    });

    expect(await db.journalEntry.count({ where: { orgId: ORG } })).toBe(before.entries);
    expect(await db.journalLine.count({ where: { orgId: ORG } })).toBe(before.lines);

    const afterA = await trialBalance({ orgId: ORG, entityId: A, periodLabel: "2026-03" });
    const afterB = await trialBalance({ orgId: ORG, entityId: B, periodLabel: "2026-03" });
    expect(afterA.rows).toEqual(before.a.rows);
    expect(afterB.rows).toEqual(before.b.rows);
    expect(afterA.totalDebitMinor).toBe(before.a.totalDebitMinor);
    expect(afterB.totalCreditMinor).toBe(before.b.totalCreditMinor);

    // And the members' own balance sheets still carry the intragroup balances in
    // full, which is the whole point: the receivable really is owed to A.
    const aSheet = await balanceSheet({ orgId: ORG, entityId: A, asOf: YEAR.to });
    const bSheet = await balanceSheet({ orgId: ORG, entityId: B, asOf: YEAR.to });
    expect(aSheet.assets.lines.find((l) => l.code === "1100")!.presentedMinor)
      .toBe(before.aSheet.assets.lines.find((l) => l.code === "1100")!.presentedMinor);
    expect(bSheet.liabilities.lines.find((l) => l.code === "2000")!.presentedMinor)
      .toBe(before.bSheet.liabilities.lines.find((l) => l.code === "2000")!.presentedMinor);
    expect(aSheet.balanced).toBe(true);
    expect(bSheet.balanced).toBe(true);
  });

  /* -------------------------------------------------------------- refusals */

  it("refuses an unknown group and names the groups that do exist", async () => {
    await expect(findMatches({ orgId: ORG, groupCode: "GHOST", ...YEAR }))
      .rejects.toThrow(/no consolidation group with code GHOST/i);
    await expect(findMatches({ orgId: ORG, groupCode: "GHOST", ...YEAR }))
      .rejects.toThrow(/IC \(Intercompany group/);
    await expect(eliminationSchedule({ orgId: ORG, groupCode: "GHOST", asOf: "2026-12-31" }))
      .rejects.toThrow(/SOLO \(One member only/);
    await expect(unrealisedProfit({ orgId: ORG, groupCode: "GHOST", asOf: "2026-12-31", stock: [] }))
      .rejects.toThrow(/no consolidation group with code GHOST/i);
    await expect(matchReport({ orgId: ORG, groupCode: "GHOST", ...YEAR }))
      .rejects.toThrow(/no consolidation group with code GHOST/i);
  });

  it("refuses a period that ends before it starts, and a date that is not one", async () => {
    await expect(findMatches({ orgId: ORG, groupCode: "IC", from: "2026-12-31", to: "2026-01-01" }))
      .rejects.toThrow(/ends before it starts/i);
    await expect(findMatches({ orgId: ORG, groupCode: "IC", from: "31/12/2026", to: "2026-01-01" }))
      .rejects.toThrow(/YYYY-MM-DD/);
  });

  it("keeps another organisation's group out of this one entirely", async () => {
    await expect(findMatches({ orgId: "t-org-ic-other", groupCode: "IC", ...YEAR }))
      .rejects.toThrow(/No consolidation groups have been set up/);
  });
});
