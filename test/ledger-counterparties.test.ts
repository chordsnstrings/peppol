import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postInvoice, postReceipt, receivablesAgeing } from "@/lib/server/ledger/ar";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  createCounterparty, updateCounterparty, archiveCounterparty,
  counterpartyStatement, creditStatus, dunningList,
  placeOnHold, releaseHold, checkCreditBeforeSale, listCounterparties,
} from "@/lib/server/ledger/counterparties";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-cp";
const ENT = "t-ent-cp";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
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

let seq = 0;
const line = (net: number, vat: number, profile: TaxProfileCode = "STANDARD_5"): InvoiceLine => ({
  id: `cpl${++seq}`, lineNo: seq, description: "Consulting", qty: 1, unitCode: "C62",
  unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
});

function doc(over: Partial<Invoice>, lines: InvoiceLine[]): Invoice {
  const net = lines.reduce((a, l) => a + l.lineNetMinor, 0);
  const vat = lines.reduce((a, l) => a + l.lineVatMinor, 0);
  return {
    id: `cp-${++seq}`, orgId: ORG, entityId: ENT, direction: "OUTBOUND", docType: "TAX_INVOICE",
    number: `INV-${seq}`, issueDate: "2026-03-10", supplyDate: "2026-03-10", currency: "AED",
    buyer: { nameEn: "Al Marri Trading LLC" }, seller: { nameEn: "Our Company" },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED", source: "EDITOR",
    compliance: { taxableEventDate: "2026-03-10", daysRemaining: 14, breached: false },
    createdAt: "2026-03-10T00:00:00Z", updatedAt: "2026-03-10T00:00:00Z",
    ...over,
  } as Invoice;
}

/**
 * Put the document in the tenant store and post it.
 *
 * The store is where a journal entry's counterparty comes from — a journal line
 * records what an entry did to the books, never who it was with — so a document
 * that never reaches the store is a document no statement can attribute.
 */
async function issue(inv: Invoice) {
  await db.record.create({
    data: { id: inv.id, orgId: ORG, store: "invoices", entityId: ENT, data: JSON.stringify(inv) },
  });
  await postInvoice({ orgId: ORG, invoice: inv });
  return inv;
}

/** 31 March 2026 — the date every hand-computed figure below is stated at. */
const ASOF = new Date("2026-03-31");

/*
 * The book these tests read, all of it stated here so nothing below has to be
 * reverse-engineered from the assertions.
 *
 *   C-ALM   Al Marri Trading LLC   30-day terms   limit 5,000.00
 *     INV-A2  05 Jan  2,100.00  due 04 Feb  — 55 days late at 31 Mar
 *     INV-A1  10 Mar  1,050.00  less 400.00 received 22 Mar → 650.00 open,
 *                               due 09 Apr — not yet late at 31 Mar
 *     INV-A3  05 Apr    210.00  carries no customer link at all
 *   C-NAK   Nakheel Retail LLC      7-day terms   NO LIMIT SET
 *     INV-B1  10 Mar  1,050.00  due 17 Mar — 14 days late at 31 Mar
 *   C-CASH  Cash Only FZE           on receipt    limit 0.00 (no credit at all)
 *     INV-C1  10 Mar    525.00  due 10 Mar — 21 days late at 31 Mar
 *   C-QUIET Quiet Client LLC       nothing outstanding
 *   C-HOLD  Held Client LLC        nothing outstanding
 *
 * INV-A1 and INV-B1 are the same amount on the same day on purpose: the only
 * thing that makes one late and the other not is the customer's own terms.
 */
const A1 = "cp-inv-a1";
const A2 = "cp-inv-a2";
const A3 = "cp-inv-a3";
const B1 = "cp-inv-b1";
const C1 = "cp-inv-c1";

d("counterparties and credit control", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    await createCounterparty({
      orgId: ORG, entityId: ENT,
      counterparty: {
        code: "C-ALM", name: "Al Marri Trading LLC", nameAr: "المري للتجارة",
        trn: "100111222333444", email: "ap@almarri.example", paymentTerms: 30,
        creditLimitMinor: 500_000,
      },
    });
    await createCounterparty({
      orgId: ORG, entityId: ENT,
      // No limit named at all — the account has never been assessed.
      counterparty: { code: "C-NAK", name: "Nakheel Retail LLC", paymentTerms: 7 },
    });
    await createCounterparty({
      orgId: ORG, entityId: ENT,
      // A limit of nothing, decided deliberately. Not the same thing.
      counterparty: { code: "C-CASH", name: "Cash Only FZE", paymentTerms: 0, creditLimitMinor: 0 },
    });
    await createCounterparty({
      orgId: ORG, entityId: ENT,
      counterparty: { code: "C-QUIET", name: "Quiet Client LLC", creditLimitMinor: 100_000 },
    });
    await createCounterparty({
      orgId: ORG, entityId: ENT,
      counterparty: { code: "C-HOLD", name: "Held Client LLC", creditLimitMinor: 100_000 },
    });

    await issue(doc(
      { id: A2, number: "INV-A2", customerId: "C-ALM", issueDate: "2026-01-05", supplyDate: "2026-01-05" },
      [line(200_000, 10_000)],
    ));
    await issue(doc({ id: A1, number: "INV-A1", customerId: "C-ALM" }, [line(100_000, 5_000)]));
    await postReceipt({
      orgId: ORG, entityId: ENT, invoiceId: A1, invoiceNumber: "INV-A1",
      paymentId: "cp-pay-a1", receivedOn: "2026-03-22", bankAmountMinor: 40_000,
    });
    await issue(doc(
      { id: B1, number: "INV-B1", customerId: "C-NAK", buyer: { nameEn: "Nakheel Retail LLC" } },
      [line(100_000, 5_000)],
    ));
    await issue(doc(
      { id: C1, number: "INV-C1", customerId: "C-CASH", buyer: { nameEn: "Cash Only FZE" } },
      [line(50_000, 2_500)],
    ));
    // Deliberately no customerId: this one can only be attributed by the name
    // on the face of it.
    await issue(doc(
      { id: A3, number: "INV-A3", issueDate: "2026-04-05", supplyDate: "2026-04-05" },
      [line(20_000, 1_000)],
    ));
  });

  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------------- master data */

  it("creates a customer with terms, a TRN and a limit", async () => {
    const c = await createCounterparty({
      orgId: ORG, entityId: ENT,
      counterparty: {
        code: "C-NEW", name: "Sharjah Fitout LLC", trn: "100999888777666",
        paymentTerms: 45, creditLimitMinor: 250_000, email: "accounts@fitout.example",
      },
    });
    expect(c.code).toBe("C-NEW");
    expect(c.paymentTerms).toBe(45);
    expect(c.creditLimitMinor).toBe(250_000n);
    expect(c.onHold).toBe(false);
    expect(c.status).toBe("active");
  });

  it("refuses a TRN that is not fifteen digits", async () => {
    await expect(createCounterparty({
      orgId: ORG, entityId: ENT,
      counterparty: { code: "C-BADTRN", name: "Bad TRN LLC", trn: "1001112223" },
    })).rejects.toThrow(/fifteen digits/i);

    // And it says what goes wrong downstream rather than just "invalid".
    await expect(createCounterparty({
      orgId: ORG, entityId: ENT,
      counterparty: { code: "C-BADTRN2", name: "Bad TRN Two LLC", trn: "10011122233344X" },
    })).rejects.toThrow(/input tax/i);
  });

  it("refuses a duplicate code and a duplicate TRN", async () => {
    await expect(createCounterparty({
      orgId: ORG, entityId: ENT, counterparty: { code: "C-ALM", name: "Someone Else LLC" },
    })).rejects.toThrow(/already/i);

    // The same TRN twice is the same taxable person entered twice, and each
    // copy would be credit-checked against half the debt.
    await expect(createCounterparty({
      orgId: ORG, entityId: ENT,
      counterparty: { code: "C-TWIN", name: "Al Marri Trading Branch", trn: "100111222333444" },
    })).rejects.toThrow(/same customer entered twice/i);
  });

  it("refuses payment terms that could not mean anything", async () => {
    await expect(createCounterparty({
      orgId: ORG, entityId: ENT, counterparty: { code: "C-NEG", name: "Negative Terms LLC", paymentTerms: -5 },
    })).rejects.toThrow(/due before it was raised/i);
    await expect(createCounterparty({
      orgId: ORG, entityId: ENT, counterparty: { code: "C-LONG", name: "Long Terms LLC", paymentTerms: 400 },
    })).rejects.toThrow(LedgerError);
  });

  /* ----------------------------------------------- the null-vs-zero distinction */

  it("keeps a nil credit limit and a limit of zero completely apart", async () => {
    // Nakheel: nobody has set a limit. There is no headroom figure to give,
    // they are not over anything, and the sentence says why.
    const unassessed = await creditStatus({ orgId: ORG, entityId: ENT, code: "C-NAK", asOf: ASOF });
    expect(unassessed.limitSet).toBe(false);
    expect(unassessed.creditLimitMinor).toBeNull();
    expect(unassessed.headroomMinor).toBeNull();
    expect(unassessed.overLimit).toBe(false);
    expect(unassessed.outstandingMinor).toBe("105000");
    expect(unassessed.summary).toMatch(/no credit limit has been set/i);

    // Cash Only: somebody assessed them and the answer was nothing. They owe
    // 525.00 against a limit of nil, so they are over it by all of it.
    const cashOnly = await creditStatus({ orgId: ORG, entityId: ENT, code: "C-CASH", asOf: ASOF });
    expect(cashOnly.limitSet).toBe(true);
    expect(cashOnly.creditLimitMinor).toBe("0");
    expect(cashOnly.headroomMinor).toBe("-52500");
    expect(cashOnly.overLimit).toBe(true);
    expect(cashOnly.summary).toMatch(/no credit at all/i);

    // The two must not be reachable from each other by any coercion: the whole
    // failure mode is code that treats one as the other.
    expect(unassessed.creditLimitMinor).not.toBe("0");
    expect(cashOnly.creditLimitMinor).not.toBeNull();
    expect(unassessed.headroomMinor).not.toBe(cashOnly.headroomMinor);
  });

  it("reports headroom as null with a sentence rather than as a very large number", async () => {
    const s = await creditStatus({ orgId: ORG, entityId: ENT, code: "C-NAK", asOf: ASOF });
    expect(s.headroomMinor).toBeNull();
    // Never Infinity, never a stand-in ceiling.
    expect(JSON.stringify(s)).not.toMatch(/Infinity|null_limit|9999999/);
    expect(s.summary).toMatch(/not a limit of nothing|never been assessed/i);
    expect(s.summary).toMatch(/no headroom to report/i);
  });

  it("keeps the two apart across an update as well", async () => {
    const cp = { orgId: ORG, entityId: ENT, code: "C-FLIP" };
    await createCounterparty({
      orgId: ORG, entityId: ENT, counterparty: { code: "C-FLIP", name: "Flip Trading LLC" },
    });
    // Created with nothing said about a limit → no limit set.
    expect((await creditStatus({ ...cp, asOf: ASOF })).limitSet).toBe(false);

    // Setting it to zero is a decision, and it shows as one.
    await updateCounterparty({ ...cp, change: { creditLimitMinor: 0 } });
    const nil = await creditStatus({ ...cp, asOf: ASOF });
    expect(nil.limitSet).toBe(true);
    expect(nil.creditLimitMinor).toBe("0");
    expect(nil.headroomMinor).toBe("0");

    // Clearing it puts the account back to unassessed rather than to nil.
    await updateCounterparty({ ...cp, change: { creditLimitMinor: null } });
    const cleared = await creditStatus({ ...cp, asOf: ASOF });
    expect(cleared.limitSet).toBe(false);
    expect(cleared.creditLimitMinor).toBeNull();
    expect(cleared.headroomMinor).toBeNull();
  });

  it("refuses a negative credit limit and says both of the legitimate answers", async () => {
    await expect(updateCounterparty({
      orgId: ORG, entityId: ENT, code: "C-FLIP", change: { creditLimitMinor: -1 },
    })).rejects.toThrow(/clear the limit entirely/i);
  });

  /* ------------------------------------------------------ statement of account */

  it("builds a statement of account with a running balance", async () => {
    const s = await counterpartyStatement({
      orgId: ORG, entityId: ENT, code: "C-ALM", from: "2026-02-01", to: ASOF,
    });
    // January's invoice is before the window, so it is brought forward rather
    // than dropped — otherwise the statement would not add up on its own.
    expect(s.openingMinor).toBe("210000");
    expect(s.lines.map((l) => [l.number, l.debitMinor, l.creditMinor, l.balanceMinor])).toEqual([
      ["INV-A1", "105000", "0", "315000"],
      ["INV-A1", "0", "40000", "275000"],   // the receipt lands on the invoice it settles
    ]);
    expect(s.closingMinor).toBe("275000");
  });

  it("closes at exactly this customer's share of the receivables ageing", async () => {
    const s = await counterpartyStatement({
      orgId: ORG, entityId: ENT, code: "C-ALM", from: "2026-02-01", to: ASOF,
    });
    expect(s.agrees).toBe(true);
    expect(s.ageingShareMinor).toBe(s.closingMinor);

    // And independently: the same figure taken out of the ageing report itself.
    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: ASOF });
    const share = ageing.open
      .filter((o) => o.sourceId === A1 || o.sourceId === A2)
      .reduce((a, o) => a + BigInt(o.outstandingMinor), 0n);
    expect(share.toString()).toBe("275000");
    expect(s.note).toMatch(/ties this statement/i);
  });

  it("leaves another customer's documents off the statement", async () => {
    const s = await counterpartyStatement({
      orgId: ORG, entityId: ENT, code: "C-ALM", from: "2026-01-01", to: ASOF,
    });
    expect(s.lines.some((l) => l.documentId === B1)).toBe(false);
    expect(s.lines.some((l) => l.documentId === C1)).toBe(false);
    expect(s.lines.some((l) => l.documentId === A2)).toBe(true);
  });

  it("attributes a document that carries no customer link by the name on it", async () => {
    // INV-A3 names no customerId at all; only "Al Marri Trading LLC" on its face
    // connects it to the account, and it still has to reach the statement.
    const s = await counterpartyStatement({
      orgId: ORG, entityId: ENT, code: "C-ALM", from: "2026-01-01", to: "2026-04-30",
    });
    expect(s.lines.some((l) => l.documentId === A3)).toBe(true);
    expect(s.closingMinor).toBe("296000");   // 275,000 + 21,000
    expect(s.agrees).toBe(true);
  });

  /* ----------------------------------------------------------- credit standing */

  it("works overdue out from the customer's own terms, not a fixed thirty days", async () => {
    const alm = await creditStatus({ orgId: ORG, entityId: ENT, code: "C-ALM", asOf: ASOF });
    const nak = await creditStatus({ orgId: ORG, entityId: ENT, code: "C-NAK", asOf: ASOF });

    const almMarch = alm.items.find((i) => i.documentId === A1)!;
    const nakMarch = nak.items.find((i) => i.documentId === B1)!;

    // Same amount, same day, 21 days old apiece. A fixed 30-day rule would call
    // neither of them late; their own terms disagree about one of them.
    expect(almMarch.daysOld).toBe(21);
    expect(nakMarch.daysOld).toBe(21);
    expect(almMarch.dueDate).toBe("2026-04-09");
    expect(almMarch.daysOverdue).toBe(0);
    expect(nakMarch.dueDate).toBe("2026-03-17");
    expect(nakMarch.daysOverdue).toBe(14);
    expect(nak.overdue).toBe(true);
    expect(nak.summary).toMatch(/7-day terms/);
  });

  it("flags being over a limit with the flag, not by leaving it to the reader", async () => {
    const cash = await creditStatus({ orgId: ORG, entityId: ENT, code: "C-CASH", asOf: ASOF });
    expect(cash.overLimit).toBe(true);
    expect(cash.overdue).toBe(true);
    expect(cash.oldestOverdueDays).toBe(21);   // due on receipt, 10 March

    const alm = await creditStatus({ orgId: ORG, entityId: ENT, code: "C-ALM", asOf: ASOF });
    expect(alm.outstandingMinor).toBe("275000");
    expect(alm.headroomMinor).toBe("225000");
    expect(alm.overLimit).toBe(false);         // owing money is not being over the limit
    expect(alm.overdue).toBe(true);            // but January's invoice is 55 days late
    expect(alm.oldestOverdueDays).toBe(55);
  });

  /* ----------------------------------------------------------------- dunning */

  it("lists who to chase worst first, with a reason on every line", async () => {
    const list = await dunningList({ orgId: ORG, entityId: ENT, asOf: ASOF });
    expect(list.rows.map((r) => r.code)).toEqual(["C-ALM", "C-CASH", "C-NAK"]);
    expect(list.rows.map((r) => r.oldestOverdueDays)).toEqual([55, 21, 14]);
    expect(list.rows.map((r) => r.suggested)).toEqual(["hold", "demand", "remind"]);
    for (const r of list.rows) {
      expect(r.reason.length).toBeGreaterThan(40);
      expect(r.reason).toContain(r.name);
      expect(r.reason).toMatch(/terms/);
    }
    expect(list.totalOverdueMinor).toBe("367500");  // 210,000 + 52,500 + 105,000
  });

  it("suggests a hold and does not place one", async () => {
    const before = await db.counterparty.findFirst({ where: { orgId: ORG, entityId: ENT, code: "C-ALM" } });
    const list = await dunningList({ orgId: ORG, entityId: ENT, asOf: ASOF });
    const alm = list.rows.find((r) => r.code === "C-ALM")!;
    expect(alm.suggested).toBe("hold");

    const after = await db.counterparty.findFirst({ where: { orgId: ORG, entityId: ENT, code: "C-ALM" } });
    expect(after!.onHold).toBe(false);
    expect(after!.onHold).toBe(before!.onHold);
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
    expect(alm.reason).toMatch(/this is a suggestion/i);
    expect(list.note).toMatch(/no account has been held/i);
  });

  it("honours a minimum age so a list can be worth reading", async () => {
    const list = await dunningList({ orgId: ORG, entityId: ENT, asOf: ASOF, minAgeDays: 20 });
    expect(list.rows.map((r) => r.code)).toEqual(["C-ALM", "C-CASH"]);
    expect(list.minAgeDays).toBe(20);
  });

  it("escalates to referral once a debt is old enough", async () => {
    // The same January invoice, 146 days late by the end of June.
    const list = await dunningList({ orgId: ORG, entityId: ENT, asOf: new Date("2026-06-30") });
    const alm = list.rows.find((r) => r.code === "C-ALM")!;
    expect(alm.oldestOverdueDays).toBe(146);
    expect(alm.suggested).toBe("refer");
    expect(alm.reason).toMatch(/recovery/i);
  });

  /* ------------------------------------------------------------------- holds */

  it("refuses a hold that does not say why", async () => {
    await expect(placeOnHold({ orgId: ORG, entityId: ENT, code: "C-HOLD", reason: "" }))
      .rejects.toThrow(/needs a reason/i);
    await expect(placeOnHold({ orgId: ORG, entityId: ENT, code: "C-HOLD", reason: "   " }))
      .rejects.toThrow(LedgerError);
    const party = await db.counterparty.findFirst({ where: { orgId: ORG, entityId: ENT, code: "C-HOLD" } });
    expect(party!.onHold).toBe(false);
  });

  it("records a hold and stops sales while it stands", async () => {
    const held = await placeOnHold({
      orgId: ORG, entityId: ENT, code: "C-HOLD",
      reason: "Two cheques returned unpaid", actorId: "u-fatima", at: "2026-03-31",
    });
    expect(held.counterparty.onHold).toBe(true);
    expect(held.counterparty.holdReason).toBe("Two cheques returned unpaid");
    // Recorded, not just flagged — whoever is asked to release it can see when
    // it was placed and by whom.
    expect(held.counterparty.notes).toMatch(/2026-03-31 Placed on hold by u-fatima: Two cheques returned unpaid/);

    const sale = await checkCreditBeforeSale({
      orgId: ORG, entityId: ENT, code: "C-HOLD", amountMinor: 10_000, asOf: ASOF,
    });
    expect(sale.allowed).toBe(false);
    expect(sale.reason).toMatch(/Two cheques returned unpaid/);
    expect(sale.reason).toMatch(/commercial decision/i);

    // Holding it twice would overwrite the first reason silently.
    await expect(placeOnHold({ orgId: ORG, entityId: ENT, code: "C-HOLD", reason: "Something else" }))
      .rejects.toThrow(/already on hold/i);
  });

  it("refuses a release with no reason, and records the one it gets", async () => {
    await expect(releaseHold({ orgId: ORG, entityId: ENT, code: "C-HOLD", reason: "" }))
      .rejects.toThrow(/needs a reason/i);

    const released = await releaseHold({
      orgId: ORG, entityId: ENT, code: "C-HOLD",
      reason: "Cleared in full by bank transfer", actorId: "u-fatima", at: "2026-04-02",
    });
    expect(released.counterparty.onHold).toBe(false);
    expect(released.counterparty.holdReason).toBeNull();
    // Both decisions survive: holdReason alone would have lost the history the
    // moment the hold came off, and that is the history anyone asks about.
    expect(released.counterparty.notes).toMatch(/Placed on hold/);
    expect(released.counterparty.notes).toMatch(/2026-04-02 Hold released by u-fatima: Cleared in full/);
    expect(released.counterparty.notes).toMatch(/was held for: Two cheques returned unpaid/);
  });

  it("refuses to move a hold through the ordinary edit path", async () => {
    await expect(updateCounterparty({
      orgId: ORG, entityId: ENT, code: "C-HOLD", change: { onHold: true },
    })).rejects.toThrow(/place on hold|release hold/i);
  });

  /* ------------------------------------------------------- the sale-time gate */

  it("allows a sale that stays inside the limit", async () => {
    const r = await checkCreditBeforeSale({
      orgId: ORG, entityId: ENT, code: "C-ALM", amountMinor: 200_000, asOf: ASOF,
    });
    expect(r.allowed).toBe(true);
    expect(r.wouldBeMinor).toBe("475000");
    expect(r.overByMinor).toBeNull();
    expect(r.reason).toMatch(/leaving AED 250\.00/);
  });

  it("refuses a sale that goes over the limit, and names the numbers", async () => {
    const r = await checkCreditBeforeSale({
      orgId: ORG, entityId: ENT, code: "C-ALM", amountMinor: 300_000, asOf: ASOF,
    });
    expect(r.allowed).toBe(false);
    expect(r.overByMinor).toBe("75000");
    // The limit, the balance and what would be over — all three, in the
    // sentence, because "credit check failed" sends the salesperson to accounts
    // and accounts back to the salesperson.
    expect(r.reason).toContain("AED 5,000.00");   // the limit
    expect(r.reason).toContain("AED 2,750.00");   // what they owe now
    expect(r.reason).toContain("AED 3,000.00");   // this sale
    expect(r.reason).toContain("AED 750.00");     // what would be over
  });

  it("refuses any sale at all to a customer whose limit is nil", async () => {
    const r = await checkCreditBeforeSale({
      orgId: ORG, entityId: ENT, code: "C-CASH", amountMinor: 100, asOf: ASOF,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cash-up-front/i);
  });

  it("checks nothing, and says so, where no limit has been set", async () => {
    const r = await checkCreditBeforeSale({
      orgId: ORG, entityId: ENT, code: "C-NAK", amountMinor: 5_000_000, asOf: ASOF,
    });
    // Five million against an unassessed account is still allowed, because
    // refusing it would mean treating "not assessed" as "no credit".
    expect(r.allowed).toBe(true);
    expect(r.limitSet).toBe(false);
    expect(r.headroomMinor).toBeNull();
    expect(r.reason).toMatch(/was not checked against one/i);
    expect(r.reason).toMatch(/not a limit of zero/i);
  });

  /* ---------------------------------------------------------------- archiving */

  it("refuses to archive a customer who still owes money", async () => {
    await expect(archiveCounterparty({ orgId: ORG, entityId: ENT, code: "C-ALM" }))
      .rejects.toThrow(/still owes/i);
  });

  it("archives a customer with nothing outstanding, and then refuses to sell to them", async () => {
    const archived = await archiveCounterparty({ orgId: ORG, entityId: ENT, code: "C-QUIET" });
    expect(archived.status).toBe("archived");

    const r = await checkCreditBeforeSale({
      orgId: ORG, entityId: ENT, code: "C-QUIET", amountMinor: 1_000, asOf: ASOF,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/archived/i);

    // Archived is not deleted: everything about them is still there.
    const still = await db.counterparty.findFirst({ where: { orgId: ORG, entityId: ENT, code: "C-QUIET" } });
    expect(still).not.toBeNull();
    await expect(archiveCounterparty({ orgId: ORG, entityId: ENT, code: "C-QUIET" }))
      .rejects.toThrow(/already archived/i);
  });

  /* ------------------------------------------------------------------ listing */

  it("lists every customer with where they stand in one call", async () => {
    const list = await listCounterparties({ orgId: ORG, entityId: ENT, asOf: ASOF });
    const codes = list.counterparties.map((c) => c.code);
    expect(codes).toContain("C-ALM");
    expect(codes).not.toContain("C-QUIET");   // archived, and off the working screen

    const alm = list.counterparties.find((c) => c.code === "C-ALM")!;
    expect(alm.outstandingMinor).toBe("275000");
    expect(alm.headroomMinor).toBe("225000");
    expect(alm.openItems).toBe(2);

    const nak = list.counterparties.find((c) => c.code === "C-NAK")!;
    expect(nak.headroomMinor).toBeNull();
    expect(nak.limitSet).toBe(false);

    const withArchived = await listCounterparties({
      orgId: ORG, entityId: ENT, asOf: ASOF, includeArchived: true,
    });
    expect(withArchived.counterparties.map((c) => c.code)).toContain("C-QUIET");
  });

  it("refuses to narrow a customer to supplier-only while they still owe", async () => {
    await expect(updateCounterparty({
      orgId: ORG, entityId: ENT, code: "C-ALM", change: { kind: "SUPPLIER" },
    })).rejects.toThrow(/still carries/i);
  });

  /* ------------------------------------- what a long-lived ledger costs to read */

  /*
   * The statement used to read every posting the receivables control account
   * had ever carried, and then ask the document store who every one of those
   * documents belonged to in a single `id: { in: [...] }`. That list is one
   * bind parameter per sales document ever raised, and PostgreSQL refuses a
   * statement past 65,535 of them — about eleven hundred invoices a month for
   * five years, at which point the customer statement stops working entirely
   * rather than merely slowly. The read is chunked now and bounded below by the
   * period asked for; these say the answer did not move.
   */

  it("reads the ledger only from the start of the period, and closes at the same figure", async () => {
    const bounded = await counterpartyStatement({
      orgId: ORG, entityId: ENT, code: "C-ALM", from: "2026-03-01", to: ASOF,
    });
    const whole = await counterpartyStatement({ orgId: ORG, entityId: ENT, code: "C-ALM", to: ASOF });

    expect(bounded.readFrom).toBe("2026-03-01");
    expect(whole.readFrom).toBeNull();
    expect(bounded.closingMinor).toBe(whole.closingMinor);
    expect(bounded.agrees).toBe(true);

    // January's invoice had no movement in March at all, so it is carried in at
    // its balance rather than read line by line — and it is not itemised twice.
    expect(bounded.openingMinor).toBe("210000");
    expect(bounded.lines.some((l) => l.documentId === A2)).toBe(false);
    expect(bounded.note).toMatch(/ledger was read from 2026-03-01/i);
  });

  it("still nets a receipt against the invoice it settles when the invoice is older than the window", async () => {
    // The trap in bounding the read: INV-A1 was raised on 10 March and part-paid
    // on 22 March. Read from 15 March the receipt is inside the window and the
    // invoice is not, so a read that stopped at the boundary would show this
    // customer 400.00 in credit — money the business owes them — when they
    // actually owe 2,750.00.
    const s = await counterpartyStatement({
      orgId: ORG, entityId: ENT, code: "C-ALM", from: "2026-03-15", to: ASOF,
    });
    expect(s.readFrom).toBe("2026-03-15");
    expect(s.openingMinor).toBe("315000");
    expect(s.lines.map((l) => [l.number, l.debitMinor, l.creditMinor, l.balanceMinor])).toEqual([
      ["INV-A1", "0", "40000", "275000"],
    ]);
    expect(s.closingMinor).toBe("275000");
    expect(s.agrees).toBe(true);
  });

  it("gives a customer with nothing on the ledger a statement of nil rather than an error", async () => {
    // The chunked lookup has to survive an empty list of documents: the loop
    // that replaced the single query must simply not run.
    const s = await counterpartyStatement({
      orgId: ORG, entityId: ENT, code: "C-HOLD", from: "2026-01-01", to: ASOF,
    });
    expect(s.lines).toEqual([]);
    expect(s.openingMinor).toBe("0");
    expect(s.closingMinor).toBe("0");
    expect(s.agrees).toBe(true);
  });

  it("gives each customer only their own open items, however many customers there are", async () => {
    // `openItemsOf` used to walk every document in the ledger once per party,
    // which on a thousand customers and a hundred thousand documents is a
    // hundred million comparisons on the event loop — and the event loop is
    // what every other request on the process is waiting on. The documents are
    // bucketed by party once; the answer has to be the one they gave before.
    const list = await listCounterparties({ orgId: ORG, entityId: ENT, asOf: ASOF, includeArchived: true });
    const alm = await creditStatus({ orgId: ORG, entityId: ENT, code: "C-ALM", asOf: ASOF });
    const nak = await creditStatus({ orgId: ORG, entityId: ENT, code: "C-NAK", asOf: ASOF });
    const cash = await creditStatus({ orgId: ORG, entityId: ENT, code: "C-CASH", asOf: ASOF });

    expect([...alm.items].map((i) => i.documentId).sort()).toEqual([A1, A2].sort());
    expect(nak.items.map((i) => i.documentId)).toEqual([B1]);
    expect(cash.items.map((i) => i.documentId)).toEqual([C1]);

    // No document is on two accounts, and one pass over the ledger says the
    // same as reading each customer on their own.
    const ids = [alm, nak, cash].flatMap((c) => c.items.map((i) => i.documentId));
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of [alm, nak, cash]) {
      expect(list.counterparties.find((x) => x.code === c.code)!.openItems).toBe(c.items.length);
    }
  });
});
