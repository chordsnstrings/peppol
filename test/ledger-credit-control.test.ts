import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postInvoice, postReceipt } from "@/lib/server/ledger/ar";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { createCounterparty } from "@/lib/server/ledger/counterparties";
import { createOrder, sendOrder, acceptOrder } from "@/lib/server/ledger/sales-orders";
import {
  setCreditLimit, creditLimitHistory,
  placeCreditHold, releaseCreditHold, creditHoldHistory,
  creditStanding, creditCheck,
  dunningPlan, dunningLetter, recordDunning, dunningHistory,
  stageForDays, statementOfAccount, creditControlRegister,
} from "@/lib/server/ledger/credit-control";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-cc";
const ENT = "t-ent-cc";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "CreditLimit" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "CreditHold" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DunningNotice" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "SalesOrderLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "SalesOrder" WHERE "orgId" = '${ORG}'`),
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
  id: `ccl${++seq}`, lineNo: seq, description: "Consulting", qty: 1, unitCode: "C62",
  unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
});

function doc(over: Partial<Invoice>, lines: InvoiceLine[]): Invoice {
  const net = lines.reduce((a, l) => a + l.lineNetMinor, 0);
  const vat = lines.reduce((a, l) => a + l.lineVatMinor, 0);
  return {
    id: `cc-${++seq}`, orgId: ORG, entityId: ENT, direction: "OUTBOUND", docType: "TAX_INVOICE",
    number: `INV-${seq}`, issueDate: "2026-03-01", supplyDate: "2026-03-01", currency: "AED",
    buyer: { nameEn: "Buyer" }, seller: { nameEn: "Our Company" },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED", source: "EDITOR",
    compliance: { taxableEventDate: "2026-03-01", daysRemaining: 14, breached: false },
    createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z",
    ...over,
  } as Invoice;
}

/**
 * Put the document in the tenant store and post it. The store is where a
 * journal entry's counterparty comes from — a journal line records what an
 * entry did to the books, never who it was with — so a document that never
 * reaches the store is one no statement can attribute.
 */
async function issue(inv: Invoice) {
  await db.record.create({
    data: { id: inv.id, orgId: ORG, store: "invoices", entityId: ENT, data: JSON.stringify(inv) },
  });
  await postInvoice({ orgId: ORG, invoice: inv });
  return inv;
}

/** 30 June 2026 — the date every hand-worked figure below is stated at. */
const ASOF = "2026-06-30";

/*
 * The book these tests read, stated once here so nothing below has to be
 * reverse-engineered from an assertion. Every figure is in fils.
 *
 * C-DEEP  Deep Water Marine LLC   30-day terms   limit 500,000 from 1 Jan 2026,
 *                                                raised to 800,000 from 1 May
 *   INV-D1  10 Jan   105,000  due 09 Feb   — 141 days past due at 30 Jun
 *   RCT-D1  15 Mar   (40,000) received against INV-D1, so 65,000 is left on it
 *   INV-D2  01 Mar   210,000  due 31 Mar   —  91 days past due
 *   INV-D3  20 Jun    52,500  due 20 Jul   — not yet due
 *   CRN-D1  25 Jun   (21,000) a credit note nobody has set against an invoice
 *   SO-1    accepted order, 100,000 net + 5,000 VAT, none of it invoiced
 *   SQ-1    a quote for 945,000 — an offer, and therefore not exposure
 *
 *   Ledger open items    65,000 + 210,000 + 52,500 − 21,000 = 306,500
 *   Committed on orders                                       105,000
 *   Exposure                                                  411,500
 *   Limit in force at 30 Jun (the 1 May assessment)            800,000
 *   Headroom                                                  388,500
 *   Past due (the two positive items already due)              275,000
 *
 * C-SAND  Sand Dune Trading LLC   30-day terms   NO LIMIT EVER SET
 *   INV-S1  01 Jun    31,500  due 01 Jul   — not yet due at 30 Jun
 *
 * C-CASH  Cash Only FZE            due on receipt   limit 0 from 1 Jan 2026
 *   nothing outstanding
 *
 * C-MUTE  Silent Partner LLC       30-day terms     limit 50,000, no email
 *   INV-M1  01 May    10,500  due 31 May   —  30 days past due at 30 Jun
 *
 * C-PAID  Settled Client LLC       30-day terms     limit 100,000
 *   INV-P1  01 Apr    50,000  settled in full 10 Apr
 *   RCT-P2  20 Jun    (7,500) received on account, set against no invoice
 */
const D1 = "cc-inv-d1";
const D2 = "cc-inv-d2";
const D3 = "cc-inv-d3";
const DC = "cc-crn-d1";
const S1 = "cc-inv-s1";
const M1 = "cc-inv-m1";
const P1 = "cc-inv-p1";
/**
 * The document an unapplied receipt is filed against.
 *
 * Attribution comes from the invoice store — a journal line records what an
 * entry did to the books, never who it was with — so cash received on account
 * has to be filed against *something* in that store or no statement can say
 * whose money it is. This is that something: a customer document carrying no
 * charge, which the receipt settles.
 */
const ONACC = "cc-rct-p2-doc";

d("credit control", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);

    await createCounterparty({
      ...S,
      counterparty: {
        code: "C-DEEP", name: "Deep Water Marine LLC", paymentTerms: 30,
        email: "ap@deepwater.example",
      },
    });
    await createCounterparty({
      // Never assessed. Not the same as assessed at nothing.
      ...S,
      counterparty: { code: "C-SAND", name: "Sand Dune Trading LLC", paymentTerms: 30, email: "pay@sanddune.example" },
    });
    await createCounterparty({ ...S, counterparty: { code: "C-CASH", name: "Cash Only FZE", paymentTerms: 0 } });
    await createCounterparty({
      // Assessed, past due, and with nowhere to send a letter.
      ...S,
      counterparty: { code: "C-MUTE", name: "Silent Partner LLC", paymentTerms: 30 },
    });
    await createCounterparty({
      ...S,
      counterparty: { code: "C-PAID", name: "Settled Client LLC", paymentTerms: 30, email: "ap@settled.example" },
    });
    await createCounterparty({
      ...S,
      counterparty: { code: "C-SUPP", name: "Only A Supplier LLC", kind: "SUPPLIER" },
    });

    // Limits, with their dates. The 500,000 stands until 1 May.
    await setCreditLimit({
      ...S, partyKey: "C-DEEP", limitMinor: 500_000, effectiveFrom: "2026-01-01",
      basis: "Two years of trade, no arrears, trade references taken.", actorId: "u-fin",
    });
    await setCreditLimit({
      ...S, partyKey: "C-DEEP", limitMinor: 800_000, effectiveFrom: "2026-05-01",
      basis: "Raised for the marina contract; management accounts reviewed.", actorId: "u-fin",
    });
    await setCreditLimit({
      ...S, partyKey: "C-CASH", limitMinor: 0, effectiveFrom: "2026-01-01",
      basis: "Assessed and refused: no filed accounts, no references.", actorId: "u-fin",
    });
    await setCreditLimit({
      ...S, partyKey: "C-PAID", limitMinor: 100_000, effectiveFrom: "2026-01-01",
      basis: "Small account, pays on time.", actorId: "u-fin",
    });
    await setCreditLimit({
      ...S, partyKey: "C-MUTE", limitMinor: 50_000, effectiveFrom: "2026-01-01",
      basis: "Small account; introduced by a long-standing customer.", actorId: "u-fin",
    });

    await issue(doc(
      { id: D1, number: "INV-D1", customerId: "C-DEEP", issueDate: "2026-01-10", supplyDate: "2026-01-10", dueDate: "2026-02-09" },
      [line(100_000, 5_000)],
    ));
    await issue(doc(
      { id: D2, number: "INV-D2", customerId: "C-DEEP", issueDate: "2026-03-01", supplyDate: "2026-03-01", dueDate: "2026-03-31" },
      [line(200_000, 10_000)],
    ));
    await issue(doc(
      { id: D3, number: "INV-D3", customerId: "C-DEEP", issueDate: "2026-06-20", supplyDate: "2026-06-20", dueDate: "2026-07-20" },
      [line(50_000, 2_500)],
    ));
    // A credit note is the same entry with every side flipped. It carries no
    // link to the invoice it relates to — ar.ts posts one with no `settlesId`
    // — so it stands as an open item of its own with a credit balance, which
    // is exactly what an unapplied credit is.
    await issue(doc(
      {
        id: DC, number: "CRN-D1", customerId: "C-DEEP", docType: "TAX_CREDIT_NOTE",
        issueDate: "2026-06-25", supplyDate: "2026-06-25",
      },
      [line(20_000, 1_000)],
    ));
    await postReceipt({
      ...S, invoiceId: D1, invoiceNumber: "INV-D1", paymentId: "cc-rct-d1",
      receivedOn: "2026-03-15", bankAmountMinor: 40_000,
    });

    await issue(doc(
      { id: S1, number: "INV-S1", customerId: "C-SAND", issueDate: "2026-06-01", supplyDate: "2026-06-01", dueDate: "2026-07-01" },
      [line(30_000, 1_500)],
    ));

    await issue(doc(
      { id: M1, number: "INV-M1", customerId: "C-MUTE", issueDate: "2026-05-01", supplyDate: "2026-05-01", dueDate: "2026-05-31" },
      [line(10_000, 500)],
    ));

    await issue(doc(
      { id: P1, number: "INV-P1", customerId: "C-PAID", issueDate: "2026-04-01", supplyDate: "2026-04-01", dueDate: "2026-05-01" },
      [line(47_619, 2_381)],
    ));
    await postReceipt({
      ...S, invoiceId: P1, invoiceNumber: "INV-P1", paymentId: "cc-rct-p1",
      receivedOn: "2026-04-10", bankAmountMinor: 50_000,
    });
    // Cash received on account, filed against a customer document that carries
    // no charge. It stands as an open item with a credit balance: money the
    // business is holding and nobody has applied.
    await db.record.create({
      data: {
        id: ONACC, orgId: ORG, store: "invoices", entityId: ENT,
        data: JSON.stringify({ id: ONACC, number: "RCT-P2", direction: "OUTBOUND", customerId: "C-PAID" }),
      },
    });
    await postReceipt({
      ...S, invoiceId: ONACC, invoiceNumber: "RCT-P2 on account", paymentId: "cc-rct-p2",
      receivedOn: "2026-06-20", bankAmountMinor: 7_500,
    });

    // An accepted order: committed, not yet invoiced, and therefore exposure
    // that no receivables report can see.
    const order = await createOrder({
      ...S,
      order: {
        kind: "ORDER", customerCode: "C-DEEP", customerName: "Deep Water Marine LLC",
        issuedOn: "2026-06-10",
        lines: [{ description: "Hull survey", quantityMilli: 1_000, unitPriceMinor: 100_000, taxCode: "STANDARD_5" }],
      },
    });
    await sendOrder({ orgId: ORG, orderId: order.id, entityId: ENT });
    // This fixture deliberately builds a customer 208 days in arrears and then
    // accepts an order for them, so that later assertions have committed-but-
    // unbilled exposure to measure. Acceptance now runs the credit check and
    // refuses exactly that — which is the control working, not the fixture
    // being wrong — so the fixture states that it is overriding, on the record.
    await acceptOrder({
      orgId: ORG, orderId: order.id, entityId: ENT, acceptedOn: "2026-06-12",
      override: { reason: "Fixture: committed exposure is what this suite measures", actorId: "fixture" },
    });
    // A quote for the same customer, which is an offer and must not count.
    const quote = await createOrder({
      ...S,
      order: {
        kind: "QUOTE", customerCode: "C-DEEP", customerName: "Deep Water Marine LLC",
        issuedOn: "2026-06-15", validUntil: "2026-12-31",
        lines: [{ description: "Refit", quantityMilli: 1_000, unitPriceMinor: 900_000, taxCode: "STANDARD_5" }],
      },
    });
    await sendOrder({ orgId: ORG, orderId: quote.id, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------------- the ladder */

  it("puts a lateness on the right rung", () => {
    expect(stageForDays(0)).toBe(null);
    expect(stageForDays(6)).toBe(null);
    expect(stageForDays(7)).toBe("reminder");
    expect(stageForDays(13)).toBe("reminder");
    expect(stageForDays(14)).toBe("first");
    expect(stageForDays(29)).toBe("first");
    expect(stageForDays(30)).toBe("second");
    expect(stageForDays(59)).toBe("second");
    expect(stageForDays(60)).toBe("final");
    expect(stageForDays(400)).toBe("final");
  });

  /* -------------------------------------------------------------- the limit */

  it("reads the limit in force on a date, not the latest one ever set", async () => {
    const before = await creditStanding({ ...S, partyKey: "C-DEEP", asOf: "2026-04-30" });
    expect(before.limit.limitMinor).toBe("500000");
    expect(before.limit.effectiveFrom).toBe("2026-01-01");

    const after = await creditStanding({ ...S, partyKey: "C-DEEP", asOf: "2026-05-01" });
    expect(after.limit.limitMinor).toBe("800000");
    expect(after.limit.effectiveFrom).toBe("2026-05-01");
    expect(after.limit.source).toBe("assessment");
  });

  it("keeps every assessment, with the reason it was made", async () => {
    const h = await creditLimitHistory({ ...S, partyKey: "C-DEEP" });
    expect(h.limits.map((l) => l.effectiveFrom)).toEqual(["2026-05-01", "2026-01-01"]);
    expect(h.limits[0].basis).toMatch(/marina contract/);
    expect(h.limits[1].limitMinor).toBe("500000");
  });

  it("refuses a limit with no reason behind it", async () => {
    await expect(setCreditLimit({ ...S, partyKey: "C-DEEP", limitMinor: 1_000_000, basis: "   " }))
      .rejects.toThrow(/whole of a credit file/i);
  });

  it("refuses a negative limit, and says what one would mean", async () => {
    await expect(setCreditLimit({ ...S, partyKey: "C-DEEP", limitMinor: -1, basis: "Typo." }))
      .rejects.toThrow(/deposit arrangement, not a limit/i);
  });

  it("refuses two limits effective the same day", async () => {
    await expect(setCreditLimit({
      ...S, partyKey: "C-DEEP", limitMinor: 900_000, effectiveFrom: "2026-05-01",
      basis: "Second thoughts.",
    })).rejects.toThrow(/two answers/i);
  });

  it("refuses a credit limit on a supplier-only record", async () => {
    await expect(setCreditLimit({ ...S, partyKey: "C-SUPP", limitMinor: 10_000, basis: "Why not." }))
      .rejects.toThrow(/recorded as a supplier/i);
  });

  it("refuses a customer nobody has set up", async () => {
    await expect(creditCheck({ ...S, partyKey: "C-GHOST", additionalMinor: 100 }))
      .rejects.toThrow(/no customer with the code C-GHOST/i);
  });

  /* ----------------------------------------------------------- the exposure */

  it("builds exposure from the ledger and from what is committed but unbilled", async () => {
    const s = await creditStanding({ ...S, partyKey: "C-DEEP", asOf: ASOF });
    // 105,000 − 40,000 + 210,000 − 21,000 + 52,500 = 306,500
    expect(s.exposure.ledgerMinor).toBe("306500");
    // The accepted order at 100,000 net plus 5% VAT. The quote does not count.
    expect(s.exposure.committedMinor).toBe("105000");
    expect(s.exposure.totalMinor).toBe("411500");
    expect(s.exposure.orders).toHaveLength(1);
    // 800,000 − 411,500
    expect(s.headroomMinor).toBe("388500");
    // 411,500 / 800,000 = 51.4375% → 5,144 basis points, rounded once.
    expect(s.usedBps).toBe(5144);
  });

  it("counts only what is past its own due date as past due", async () => {
    const s = await creditStanding({ ...S, partyKey: "C-DEEP", asOf: ASOF });
    // INV-D1 65,000 remaining and INV-D2 210,000. INV-D3 is not due until
    // 20 July, and the credit note is money owed the other way, so neither is
    // past due.
    expect(s.exposure.pastDueMinor).toBe("275000");
    // INV-D1 fell due 9 February; 30 June is 141 days later.
    expect(s.exposure.oldestPastDueDays).toBe(141);
  });

  /* ----------------------------------------------------------- the decision */

  it("allows a sale that fits, and says what is left", async () => {
    const c = await creditCheck({ ...S, partyKey: "C-DEEP", additionalMinor: 100_000, asOf: ASOF, pastDueDays: null });
    expect(c.decision).toBe("allow");
    expect(c.allowed).toBe(true);
    expect(c.wouldBeMinor).toBe("511500");
    expect(c.overByMinor).toBe("0");
    expect(c.reasons).toEqual([]);
  });

  it("refuses the sale that passes the limit, and says by how much", async () => {
    const c = await creditCheck({ ...S, partyKey: "C-DEEP", additionalMinor: 400_000, asOf: ASOF, pastDueDays: null });
    expect(c.decision).toBe("refuse");
    expect(c.allowed).toBe(false);
    // 411,500 + 400,000 = 811,500, which is 11,500 over 800,000.
    expect(c.wouldBeMinor).toBe("811500");
    expect(c.overByMinor).toBe("11500");
    expect(c.reasons.map((r) => r.code)).toEqual(["would_exceed_limit"]);
    expect(c.reasons[0].message).toMatch(/AED 115\.00 over their limit of AED 8,000\.00/);
  });

  it("would have refused the same sale at the older limit, and says which limit it used", async () => {
    // At 30 April the limit was still 500,000 and only the ledger items existed
    // — 105,000 − 40,000 + 210,000 = 275,000, since the credit note and the
    // June invoice had not happened. A further 250,000 takes it to 525,000.
    const c = await creditCheck({ ...S, partyKey: "C-DEEP", additionalMinor: 250_000, asOf: "2026-04-30", pastDueDays: null });
    expect(c.creditLimitMinor).toBe("500000");
    expect(c.limitEffectiveFrom).toBe("2026-01-01");
    expect(c.decision).toBe("refuse");
    expect(c.overByMinor).toBe("25000");
  });

  it("reports every reason separately rather than one collapsed verdict", async () => {
    const c = await creditCheck({ ...S, partyKey: "C-DEEP", additionalMinor: 500_000, asOf: ASOF, pastDueDays: 60 });
    expect(c.reasons.map((r) => r.code).sort()).toEqual(["past_due", "would_exceed_limit"]);
    // Each stands on its own: fixing the limit alone would not clear the check.
    expect(c.reasons.every((r) => r.blocking)).toBe(true);
    expect(c.summary).toMatch(/141 days/);
  });

  it("separates being over the limit already from being taken over by this sale", async () => {
    await setCreditLimit({
      ...S, partyKey: "C-DEEP", limitMinor: 300_000, effectiveFrom: "2026-06-29",
      basis: "Cut after the marina contract slipped.",
    });
    const c = await creditCheck({ ...S, partyKey: "C-DEEP", additionalMinor: 1_000, asOf: ASOF, pastDueDays: null });
    // 411,500 against 300,000 — already over before anybody asked about a sale.
    expect(c.reasons.map((r) => r.code)).toEqual(["over_limit"]);
    expect(c.reasons[0].message).toMatch(/already AED 1,115\.00 over their credit limit/);
    expect(c.headroomMinor).toBe("-111500");
    // Put it back, so the rest of the file reads the book described at the top.
    await db.creditLimit.deleteMany({
      where: { orgId: ORG, entityId: ENT, partyKey: "C-DEEP", basis: { contains: "marina contract slipped" } },
    });
    await db.counterparty.updateMany({ where: { orgId: ORG, code: "C-DEEP" }, data: { creditLimitMinor: 800_000n } });
  });

  it("treats no limit set as a customer to look at, never as a limit of nothing", async () => {
    const c = await creditCheck({ ...S, partyKey: "C-SAND", additionalMinor: 1_000_000, asOf: ASOF });
    expect(c.limitSet).toBe(false);
    expect(c.creditLimitMinor).toBe(null);
    // Not refused: refusing every unassessed customer teaches people to type a
    // limit in to clear the block, which is how the whole table becomes fiction.
    expect(c.decision).toBe("review");
    expect(c.allowed).toBe(true);
    expect(c.reasons.map((r) => r.code)).toEqual(["no_limit_set"]);
    expect(c.reasons[0].blocking).toBe(false);
    expect(c.reasons[0].message).toMatch(/never been assessed/);
    // And there is no headroom figure invented for it.
    expect(c.headroomMinor).toBe(null);
    expect(c.overByMinor).toBe(null);
  });

  it("refuses any credit at all to a customer assessed at nothing", async () => {
    const c = await creditCheck({ ...S, partyKey: "C-CASH", additionalMinor: 1, asOf: ASOF });
    expect(c.limitSet).toBe(true);
    expect(c.creditLimitMinor).toBe("0");
    expect(c.decision).toBe("refuse");
    expect(c.reasons[0].code).toBe("would_exceed_limit");
    expect(c.reasons[0].message).toMatch(/cash-up-front/);
  });

  it("asks where they stand when the sale is nothing", async () => {
    const c = await creditCheck({ ...S, partyKey: "C-CASH", additionalMinor: 0, asOf: ASOF });
    expect(c.decision).toBe("allow");
    expect(c.wouldBeMinor).toBe("0");
  });

  it("refuses a negative amount rather than reading it as a credit", async () => {
    await expect(creditCheck({ ...S, partyKey: "C-DEEP", additionalMinor: -100, asOf: ASOF }))
      .rejects.toThrow(/credit note reduces the balance/i);
  });

  it("refuses a sale to a supplier-only record", async () => {
    const c = await creditCheck({ ...S, partyKey: "C-SUPP", additionalMinor: 100, asOf: ASOF });
    expect(c.decision).toBe("refuse");
    expect(c.reasons.some((r) => r.code === "not_a_customer")).toBe(true);
  });

  it("stops on age alone where nothing is over the limit", async () => {
    const c = await creditCheck({ ...S, partyKey: "C-DEEP", additionalMinor: 1_000, asOf: ASOF, pastDueDays: 90 });
    expect(c.decision).toBe("refuse");
    expect(c.reasons.map((r) => r.code)).toEqual(["past_due"]);
    // The limit is untouched; only the age is the problem.
    expect(c.overByMinor).toBe("0");
  });

  it("lets a business turn the age test off rather than pretend it has no policy", async () => {
    const c = await creditCheck({ ...S, partyKey: "C-DEEP", additionalMinor: 1_000, asOf: ASOF, pastDueDays: null });
    expect(c.decision).toBe("allow");
    expect(c.pastDueDays).toBe(null);
  });

  /* --------------------------------------------------------------- the hold */

  it("refuses a hold with no reason", async () => {
    await expect(placeCreditHold({ ...S, partyKey: "C-PAID", reason: "  " }))
      .rejects.toThrow(/blocks a sale nobody can explain/i);
  });

  it("holds an account, with who and why and when", async () => {
    const h = await placeCreditHold({
      ...S, partyKey: "C-PAID", reason: "Cheque returned unpaid twice; awaiting a bank confirmation.",
      on: "2026-06-05", actorId: "u-credit",
    });
    expect(h.hold.placedBy).toBe("u-credit");
    expect(h.note).toMatch(/on hold from 2026-06-05/);

    const c = await creditCheck({ ...S, partyKey: "C-PAID", additionalMinor: 100, asOf: ASOF });
    expect(c.decision).toBe("refuse");
    expect(c.reasons.map((r) => r.code)).toContain("on_hold");
    expect(c.reasons.find((r) => r.code === "on_hold")!.message).toMatch(/Cheque returned unpaid twice/);
  });

  it("refuses a second hold over the top of the first", async () => {
    await expect(placeCreditHold({ ...S, partyKey: "C-PAID", reason: "Something else." }))
      .rejects.toThrow(/already on hold since 2026-06-05/i);
  });

  it("refuses a release with no reason", async () => {
    await expect(releaseCreditHold({ ...S, partyKey: "C-PAID", reason: "" }))
      .rejects.toThrow(/lifted silently/i);
  });

  it("records the release rather than deleting the hold", async () => {
    await releaseCreditHold({
      ...S, partyKey: "C-PAID", reason: "Bank confirmed the funds cleared on 24 June.",
      on: "2026-06-25", actorId: "u-fin",
    });
    const h = await creditHoldHistory({ ...S, partyKey: "C-PAID" });
    expect(h.holds).toHaveLength(1);
    expect(h.holds[0].inForce).toBe(false);
    expect(h.holds[0].reason).toMatch(/Cheque returned unpaid twice/);
    expect(h.holds[0].releaseReason).toMatch(/funds cleared/);
    expect(h.holds[0].releasedBy).toBe("u-fin");
    expect(h.holds[0].heldDays).toBe(20);

    const c = await creditCheck({ ...S, partyKey: "C-PAID", additionalMinor: 100, asOf: ASOF });
    expect(c.reasons.map((r) => r.code)).not.toContain("on_hold");
  });

  it("refuses to release a hold that is not there", async () => {
    await expect(releaseCreditHold({ ...S, partyKey: "C-PAID", reason: "Again." }))
      .rejects.toThrow(/not on hold/i);
  });

  it("refuses a release dated before the hold existed", async () => {
    await placeCreditHold({ ...S, partyKey: "C-CASH", reason: "Cash terms; no orders to be taken on credit.", on: "2026-06-10" });
    await expect(releaseCreditHold({ ...S, partyKey: "C-CASH", reason: "Too early.", on: "2026-06-01" }))
      .rejects.toThrow(/before it existed/i);
    await releaseCreditHold({ ...S, partyKey: "C-CASH", reason: "Nothing outstanding; the hold added nothing.", on: "2026-06-12" });
  });

  /* ------------------------------------------------------------- the letters */

  it("puts the worst debt at the top and says what drove each row", async () => {
    const plan = await dunningPlan({ ...S, asOf: ASOF });
    expect(plan.rows[0].code).toBe("C-DEEP");
    expect(plan.rows[0].oldestPastDueDays).toBe(141);
    expect(plan.rows[0].pastDueMinor).toBe("275000");
    // 141 days puts it on the last rung, and nothing has been sent yet.
    expect(plan.rows[0].stageByAge).toBe("final");
    expect(plan.rows[0].stageDue).toBe("final");
    expect(plan.rows[0].lastStage).toBe(null);
    expect(plan.rows[0].reason).toMatch(/Nothing has been sent yet/);
    // Silent Partner is thirty days late, which is the third rung.
    const mute = plan.rows.find((r) => r.code === "C-MUTE")!;
    expect(mute.oldestPastDueDays).toBe(30);
    expect(mute.stageByAge).toBe("second");
    // Sand Dune is not late at all — its invoice is due 1 July.
    expect(plan.rows.map((r) => r.code)).not.toContain("C-SAND");
    expect(plan.totalPastDueMinor).toBe("285500");
    expect(plan.note).toMatch(/no mail transport/);
  });

  it("writes a letter that says what is owed without threatening what it cannot do", async () => {
    const l = await dunningLetter({ ...S, partyKey: "C-DEEP", stage: "reminder", asOf: ASOF, from: "Our Company LLC" });
    expect(l.pastDueMinor).toBe("275000");
    expect(l.itemCount).toBe(2);
    expect(l.body).toMatch(/INV-D1/);
    expect(l.body).toMatch(/INV-D2/);
    // Not yet due, so it is not in the past-due table.
    expect(l.body).not.toMatch(/INV-D3\s/);
    expect(l.body).toMatch(/Total past due: AED 2,750\.00/);
    // The credit note is money held the other way, and the letter says so
    // rather than demanding the gross and letting the customer find it.
    expect(l.body).toMatch(/We also hold AED 210\.00 on your account/);
    expect(l.body).toMatch(/Our Company LLC/);
    // Nothing it cannot back.
    expect(l.body).not.toMatch(/legal action|court|solicitor|interest will/i);
    // Nothing is six months late yet, so the bad-debt paragraph stays out.
    expect(l.body).not.toMatch(/Article 64/);
    expect(l.note).toMatch(/has not been sent and cannot be/);

    // INV-D1 fell due on 9 February, so by 15 August it is 187 days past due.
    // Article 64(1) of Federal Decree-Law No. 8 of 2017 makes notifying the
    // customer of a written-off amount a condition of adjusting the output tax,
    // so the letter raises it once the six months are up.
    const later = await dunningLetter({ ...S, partyKey: "C-DEEP", stage: "final", asOf: "2026-08-15" });
    expect(later.body).toMatch(/more than six months past due/);
    expect(later.body).toMatch(/Article 64\(1\) of Federal Decree-Law No\. 8 of 2017/);
    expect(later.body).toMatch(/This letter is not that notice/);
  });

  it("refuses to write to somebody who owes nothing late", async () => {
    await expect(dunningLetter({ ...S, partyKey: "C-SAND", asOf: ASOF }))
      .rejects.toThrow(/nothing past due/i);
  });

  it("records what was sent, to whom, and when", async () => {
    const r = await recordDunning({ ...S, partyKey: "C-DEEP", stage: "reminder", sentOn: "2026-06-30", actorId: "u-credit" });
    expect(r.notice.stage).toBe("reminder");
    expect(r.notice.sentTo).toBe("ap@deepwater.example");
    expect(r.notice.overdueMinor).toBe("275000");
    expect(r.note).toMatch(/did not send it/);

    const h = await dunningHistory({ ...S, partyKey: "C-DEEP" });
    expect(h.notices).toHaveLength(1);
    // The letter itself is kept, so a dispute is settled by reading it.
    expect(h.notices[0].letter).toMatch(/INV-D1/);
  });

  it("refuses to send the same letter twice in a week", async () => {
    await expect(recordDunning({ ...S, partyKey: "C-DEEP", stage: "reminder", sentOn: "2026-07-03" }))
      .rejects.toThrow(/Leave 7 days between letters/i);
  });

  it("advances the ladder instead of restarting it", async () => {
    const plan = await dunningPlan({ ...S, asOf: "2026-07-08" });
    const deep = plan.rows.find((r) => r.code === "C-DEEP")!;
    expect(deep.lastStage).toBe("reminder");
    expect(deep.daysSinceLast).toBe(8);
    expect(deep.suppressed).toBe(false);
    // The age alone still says "final"; what matters is that it does not repeat
    // the reminder.
    expect(deep.stageDue).toBe("final");
    expect(deep.reason).toMatch(/so the next rung is final/);
  });

  it("holds a row back while a letter is still fresh", async () => {
    const plan = await dunningPlan({ ...S, asOf: "2026-07-02" });
    const deep = plan.rows.find((r) => r.code === "C-DEEP")!;
    expect(deep.suppressed).toBe(true);
    expect(deep.reason).toMatch(/Held back/);
  });

  it("refuses to step back down the ladder", async () => {
    await recordDunning({ ...S, partyKey: "C-DEEP", stage: "second", sentOn: "2026-07-08" });
    await expect(recordDunning({ ...S, partyKey: "C-DEEP", stage: "reminder", sentOn: "2026-07-20" }))
      .rejects.toThrow(/step back down the ladder/i);
  });

  it("refuses to record a letter before the one already recorded", async () => {
    await expect(recordDunning({ ...S, partyKey: "C-DEEP", stage: "final", sentOn: "2026-07-01" }))
      .rejects.toThrow(/ladder reads backwards/i);
  });

  it("refuses to record a letter with nowhere to say it went", async () => {
    // Silent Partner is 30 days past due, so there is a letter to write — but
    // no email address on the record and none passed in.
    await expect(recordDunning({ ...S, partyKey: "C-MUTE", stage: "second", sentOn: "2026-06-30" }))
      .rejects.toThrow(/nowhere to say this letter went/i);
    // Given somewhere to send it, the same call records.
    const r = await recordDunning({
      ...S, partyKey: "C-MUTE", stage: "second", sentOn: "2026-06-30", sentTo: "owner@silent.example",
    });
    expect(r.notice.sentTo).toBe("owner@silent.example");
    expect(r.notice.overdueMinor).toBe("10500");
  });

  /* ---------------------------------------------------- statement of account */

  it("foots: opening plus invoiced, less received and credited, is the closing balance", async () => {
    // Hand-worked for Deep Water Marine, the window 1 April to 30 June 2026.
    //
    //   Opening at 31 March   INV-D1 105,000 − receipt 40,000 = 65,000
    //                         INV-D2 210,000                  = 210,000
    //                                                  opening  275,000
    //   In the window         INV-D3 raised 20 June             52,500
    //                         CRN-D1 credited 25 June          (21,000)
    //                         nothing received
    //   Closing               275,000 + 52,500 − 21,000       = 306,500
    const st = await statementOfAccount({ ...S, partyKey: "C-DEEP", from: "2026-04-01", asOf: ASOF });
    expect(st.openingMinor).toBe("275000");
    expect(st.invoicedMinor).toBe("52500");
    expect(st.receivedMinor).toBe("0");
    expect(st.creditedMinor).toBe("21000");
    expect(st.closingMinor).toBe("306500");
    expect(st.foots).toBe(true);
    expect(
      BigInt(st.openingMinor) + BigInt(st.invoicedMinor) - BigInt(st.receivedMinor) - BigInt(st.creditedMinor),
    ).toBe(BigInt(st.closingMinor));
  });

  it("foots from the beginning too, where there is no opening balance", async () => {
    //   Invoiced   105,000 + 210,000 + 52,500 = 367,500
    //   Received                                40,000
    //   Credited                                21,000
    //   Closing    367,500 − 40,000 − 21,000  = 306,500
    const st = await statementOfAccount({ ...S, partyKey: "C-DEEP", asOf: ASOF });
    expect(st.openingMinor).toBe("0");
    expect(st.invoicedMinor).toBe("367500");
    expect(st.receivedMinor).toBe("40000");
    expect(st.creditedMinor).toBe("21000");
    expect(st.closingMinor).toBe("306500");
    expect(st.foots).toBe(true);
  });

  it("bands the open items by how late they are, and the bands add to the total", async () => {
    const st = await statementOfAccount({ ...S, partyKey: "C-DEEP", asOf: ASOF });
    //   INV-D3  52,500  not yet due (due 20 July)
    //   INV-D2 189,000  due 31 March — 91 days past due, so over 90
    //   INV-D1  65,000  due 9 February — 141 days, so over 90
    expect(st.bands.notYetDue).toBe("52500");
    expect(st.bands.d1_30).toBe("0");
    expect(st.bands.d31_60).toBe("0");
    expect(st.bands.d61_90).toBe("0");
    expect(st.bands.over90).toBe("275000");
    expect(st.bandsTotalMinor).toBe("327500");
    // The unapplied credit note is not aged — nobody is late paying money the
    // business owes — so it is shown apart and brings the total back to the
    // closing balance.
    expect(st.unallocatedMinor).toBe("-21000");
    expect(st.totalMinor).toBe("306500");
    expect(st.totalMinor).toBe(st.closingMinor);
  });

  it("ties the statement to the receivables ageing the trial balance backs", async () => {
    const st = await statementOfAccount({ ...S, partyKey: "C-DEEP", asOf: ASOF });
    expect(st.ageingShareMinor).toBe("306500");
    expect(st.agrees).toBe(true);
    expect(st.note).toMatch(/ties this statement to the 1100 control account/);
  });

  it("shows a receipt nobody has applied as money held, not as a paid invoice", async () => {
    //   INV-P1 50,000 raised 1 April, settled in full on 10 April.
    //   A further 7,500 received on 20 June against nothing.
    const st = await statementOfAccount({ ...S, partyKey: "C-PAID", asOf: ASOF });
    expect(st.invoicedMinor).toBe("50000");
    expect(st.receivedMinor).toBe("57500");
    expect(st.closingMinor).toBe("-7500");
    expect(st.foots).toBe(true);
    expect(st.unallocated).toHaveLength(1);
    expect(st.unallocatedMinor).toBe("-7500");
    // It is not aged: nobody is late paying money the business is holding.
    expect(st.bandsTotalMinor).toBe("0");
    expect(st.totalMinor).toBe("-7500");
    expect(st.agrees).toBe(true);
  });

  it("refuses a statement that runs backwards", async () => {
    await expect(statementOfAccount({ ...S, partyKey: "C-DEEP", from: "2026-06-30", asOf: "2026-01-01" }))
      .rejects.toThrow(/cannot run from/i);
  });

  /* ---------------------------------------------------------------- the list */

  it("shows the whole book, and counts the unassessed separately from the nil", async () => {
    const reg = await creditControlRegister({ ...S, asOf: ASOF });
    expect(reg.summary.count).toBe(5);
    // Only Sand Dune has never been assessed. Cash Only was assessed at nought,
    // which is an answer rather than a gap.
    expect(reg.summary.unassessed).toBe(1);
    expect(reg.customers.find((c) => c.code === "C-SAND")!.limit.limitSet).toBe(false);
    expect(reg.customers.find((c) => c.code === "C-CASH")!.limit.limitMinor).toBe("0");
    // Ledger 306,500 + 31,500 + 0 + 10,500 + (7,500) = 341,000, plus 105,000
    // committed on the accepted order.
    expect(reg.summary.exposureMinor).toBe("446000");
    expect(reg.summary.committedMinor).toBe("105000");
    // The limits that exist: 800,000 + 0 + 100,000 + 50,000. Sand Dune adds
    // nothing rather than an assumed nought.
    expect(reg.summary.limitMinor).toBe("950000");
  });

  it("puts an account opened on hold on hold, not just a flag on it", async () => {
    // A customer arriving with a history is opened on hold. `placeOnHold` was
    // fixed to write a CreditHold row for exactly this reason — credit control
    // derives holds only from those rows and never reads the flag — and the
    // create verb was left behind, so the same defect stayed reachable through
    // the door such a customer actually comes through: the chip on the customer
    // screen said stopped, and creditCheck said allow.
    await createCounterparty({
      ...S,
      actorId: "u-controller",
      counterparty: {
        code: "C-ARRIVES-HELD", name: "Arrives Held LLC", kind: "CUSTOMER",
        onHold: true, holdReason: "Two defaults with their previous supplier.",
      },
    });

    const check = await creditCheck({ ...S, partyKey: "C-ARRIVES-HELD", asOf: ASOF });
    expect(check.decision).toBe("refuse");
    expect(check.reasons.map((r) => r.code)).toContain("on_hold");

    const history = await creditHoldHistory({ ...S, partyKey: "C-ARRIVES-HELD" });
    expect(history.holds).toHaveLength(1);
    expect(history.holds[0].reason).toMatch(/previous supplier/);
    expect(history.holds[0].releasedOn).toBeNull();

    const reg = await creditControlRegister({ ...S, asOf: ASOF });
    expect(reg.customers.find((c) => c.code === "C-ARRIVES-HELD")!.onHold).toBe(true);
    expect(reg.summary.onHold).toBeGreaterThan(0);
  });

  it("does not read another organisation's credit control", async () => {
    const reg = await creditControlRegister({ orgId: "someone-else", entityId: ENT, asOf: ASOF });
    expect(reg.customers).toEqual([]);
    expect(reg.summary.exposureMinor).toBe("0");
  });
});
