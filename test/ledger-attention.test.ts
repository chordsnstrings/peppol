import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { attentionList, sharedReads, type Finding, type SharedReads } from "@/lib/server/ledger/attention";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { post } from "@/lib/server/ledger/post";
import { postInvoice } from "@/lib/server/ledger/ar";
import { postBill } from "@/lib/server/ledger/ap";
import { importStatement } from "@/lib/server/ledger/bank";
import { createTemplate } from "@/lib/server/ledger/recurring";
import { addAsset } from "@/lib/server/ledger/assets";
import { recordRegistration } from "@/lib/server/ledger/tax-periods";
import { createClaim, submitClaim } from "@/lib/server/ledger/expenses";
import { createOrder, issueOrder, receiveGoods } from "@/lib/server/ledger/procurement";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-att";
/** The entity with a mess in it — everything the list is meant to find. */
const ENT = "t-ent-att";
/** Books in good order: the empty state has to be reachable, or it is decoration. */
const CLEAN = "t-ent-att-clean";
/** A fiscal calendar and no ledger — the "one check throws" case. */
const BARE = "t-ent-att-bare";
/** Books whose balances have been corrupted behind the posting path. */
const BROKEN = "t-ent-att-broken";
/** Q1 traded and then closed behind itself: a filed return, as the books see it. */
const FILED = "t-ent-att-filed";
/** Trading straight past the VAT registration threshold with no registration recorded. */
const GROWING = "t-ent-att-growing";
/** Close enough to the threshold to be worth telling, and never over it. */
const NEARLY = "t-ent-att-nearly";

/**
 * The whole list is read as at one fixed day. A nag list is a function of the
 * date more than of anything else — every ageing, every deadline and every
 * "past its month end" is measured from it — so a test that ran against today
 * would pass in June and fail in July for reasons that have nothing to do with
 * the code.
 */
const AS_OF = "2026-06-15";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "GoodsReceiptLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "GoodsReceipt" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "PurchaseOrderLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "PurchaseOrder" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ExpenseClaimLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ExpenseClaim" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "RecurringJournal" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FixedAsset" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "BankStatementLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "TaxRegistration" WHERE "orgId" = '${ORG}'`),
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

let seq = 0;
const line = (net: number, vat: number, profile: TaxProfileCode = "STANDARD_5"): InvoiceLine => ({
  id: `l${++seq}`, lineNo: seq, description: "Consulting", qty: 1, unitCode: "C62",
  unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
});

function doc(
  entityId: string,
  direction: "OUTBOUND" | "INBOUND",
  issueDate: string,
  lines: InvoiceLine[],
  number?: string,
): Invoice {
  const net = lines.reduce((a, l) => a + l.lineNetMinor, 0);
  const vat = lines.reduce((a, l) => a + l.lineVatMinor, 0);
  const n = number ?? `DOC-${++seq}`;
  return {
    id: `att-${n}`, orgId: ORG, entityId, direction, docType: "TAX_INVOICE",
    number: n, issueDate, supplyDate: issueDate, currency: "AED",
    buyer: { nameEn: direction === "OUTBOUND" ? "Al Noor Trading" : "Seller" },
    seller: { nameEn: "Seller", address: { emirate: "DU", country: "AE" } },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED", source: "EDITOR",
    compliance: { taxableEventDate: issueDate, daysRemaining: 14, breached: false },
    createdAt: `${issueDate}T00:00:00Z`, updatedAt: `${issueDate}T00:00:00Z`,
  } as Invoice;
}

/**
 * Shut a run of months the way the periods screen does — one status change on
 * the period, which is the only record the books keep of a month being put to
 * bed. There is no exported helper for it: the state machine lives in the
 * PATCH handler, and reaching through it here would be testing the route.
 */
const closeMonths = (entityId: string, labels: string[]) =>
  db.accountingPeriod.updateMany({
    where: { orgId: ORG, entityId, label: { in: labels } },
    data: { status: "hard_closed", closedAt: new Date() },
  });

const read = (entityId: string, asOf: string = AS_OF) => attentionList({ orgId: ORG, entityId, asOf });
const find = (findings: Finding[], key: string) => findings.find((f) => f.key === key);
const keys = (findings: Finding[]) => findings.map((f) => f.key);

d("the attention list", () => {
  beforeAll(async () => {
    await wipe();

    /* ---- the entity with everything wrong with it ------------------------ */

    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // Two invoices past the thirty-day term and one still inside it. The March
    // one also gives the Q1 return something to be about.
    await postInvoice({ orgId: ORG, invoice: doc(ENT, "OUTBOUND", "2026-03-01", [line(1_000_000, 50_000)], "INV-MAR") });
    await postInvoice({ orgId: ORG, invoice: doc(ENT, "OUTBOUND", "2026-05-01", [line(200_000, 10_000)], "INV-MAY") });
    await postInvoice({ orgId: ORG, invoice: doc(ENT, "OUTBOUND", "2026-06-10", [line(100_000, 5_000)], "INV-JUN") });

    // One bill inside the seven-day window before its term, one too new to be
    // near it, one already past it.
    await postBill({ orgId: ORG, bill: doc(ENT, "INBOUND", "2026-05-20", [line(300_000, 15_000)], "BILL-DUE") });
    await postBill({ orgId: ORG, bill: doc(ENT, "INBOUND", "2026-06-01", [line(400_000, 20_000)], "BILL-NEW") });
    await postBill({ orgId: ORG, bill: doc(ENT, "INBOUND", "2026-04-01", [line(500_000, 25_000)], "BILL-OLD") });

    await importStatement({
      orgId: ORG, entityId: ENT, accountCode: "1010", batch: "att",
      lines: [
        { postedOn: "2026-04-01", description: "Deposit, no reference", amountMinor: 50_000 },
        { postedOn: "2026-06-05", description: "Card fee", amountMinor: -20_000 },
      ],
    });

    await createTemplate({
      orgId: ORG, entityId: ENT,
      template: {
        code: "RENT", name: "Office rent", frequency: "MONTHLY", kind: "STANDING",
        startsOn: "2026-01-01",
        lines: [{ account: "6100", debit: 1_500_000 }, { account: "1010", credit: 1_500_000 }],
      },
    });

    await addAsset({
      orgId: ORG, entityId: ENT,
      asset: { code: "FA-1", name: "Delivery van", acquiredOn: "2026-01-15", costMinor: 1_200_000, usefulLifeMonths: 60 },
    });
    // Bought after the last completed month, so it cannot be behind on it.
    await addAsset({
      orgId: ORG, entityId: ENT,
      asset: { code: "FA-2", name: "Laptop", acquiredOn: "2026-06-05", costMinor: 600_000, usefulLifeMonths: 36 },
    });

    const claim = await createClaim({
      orgId: ORG, entityId: ENT,
      claim: {
        reference: "EXP-ATT-1", employeeCode: "E-001", employeeName: "Layla Haddad", claimedOn: "2026-05-10",
        lines: [{
          spentOn: "2026-05-06", description: "Airport taxi", accountCode: "6400",
          netMinor: 100_000, vatMinor: 5_000, supplierTrn: "100123456700003", vatRecoverable: true,
        }],
      },
    });
    await submitClaim({ orgId: ORG, claimId: claim.id });

    const order = await createOrder({
      orgId: ORG, entityId: ENT,
      order: {
        number: "PO-ATT-1", supplierName: "Gulf Steel LLC", orderedOn: "2026-05-25",
        lines: [{ description: "Scaffold hire", quantityMilli: 4_000, unitPriceMinor: 125_00, accountCode: "6900" }],
      },
    });
    await issueOrder({ orgId: ORG, orderId: order.id });
    await receiveGoods({
      orgId: ORG, orderId: order.id, receivedOn: "2026-06-01", number: "GRN-ATT-1",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 4_000 }],
    });

    /* ---- books in good order --------------------------------------------- */

    await openFiscalYear({ orgId: ORG, entityId: CLEAN, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: CLEAN });
    await closeMonths(CLEAN, ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]);

    /* ---- a fiscal calendar with no ledger under it ------------------------ */

    await openFiscalYear({ orgId: ORG, entityId: BARE, label: "2026", startsOn: "2026-01-01" });

    /* ---- balances corrupted outside the posting path ---------------------- */

    await openFiscalYear({ orgId: ORG, entityId: BROKEN, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: BROKEN });
    await post({
      orgId: ORG, entityId: BROKEN, entryDate: "2026-06-02", source: "manual", memo: "Cash sale",
      lines: [{ account: "1010", debit: 500_000 }, { account: "4000", credit: 500_000, taxCode: "ZERO_OTHER" }],
    });
    // `post()` cannot produce this: it refuses an unbalanced entry, and the
    // balances are written inside the same transaction as the lines. Reaching
    // past it is the only way to reproduce a restore from the wrong backup,
    // which is the case the check exists for.
    await db.$executeRawUnsafe(
      `UPDATE "AccountBalance" SET "closingMinor" = "closingMinor" + 12345 ` +
        `WHERE "orgId" = '${ORG}' AND "entityId" = '${BROKEN}' AND "accountId" = ` +
        `(SELECT id FROM "Account" WHERE "orgId" = '${ORG}' AND "entityId" = '${BROKEN}' AND code = '1010')`,
    );

    /* ---- turnover past the VAT registration threshold --------------------- */

    // AED 400,000 of standard-rated supplies in one day, which puts the twelve
    // months ending on it over the AED 375,000 mandatory threshold. Two fiscal
    // years, because the window the law measures over reaches back into the one
    // before this.
    await openFiscalYear({ orgId: ORG, entityId: GROWING, label: "2025", startsOn: "2025-01-01" });
    await openFiscalYear({ orgId: ORG, entityId: GROWING, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: GROWING });
    await post({
      orgId: ORG, entityId: GROWING, entryDate: "2026-01-15", source: "invoice", memo: "Fit-out contract",
      lines: [
        { account: "1010", debit: 42_000_000 },
        { account: "4000", credit: 40_000_000, taxCode: "STANDARD_5", taxEmirate: "DU" },
        { account: "2100", credit: 2_000_000, taxCode: "OUTPUT_VAT", taxEmirate: "DU" },
      ],
    });

    // ...and AED 350,000, which is inside a tenth of the threshold and over
    // nothing at all.
    await openFiscalYear({ orgId: ORG, entityId: NEARLY, label: "2025", startsOn: "2025-01-01" });
    await openFiscalYear({ orgId: ORG, entityId: NEARLY, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: NEARLY });
    await post({
      orgId: ORG, entityId: NEARLY, entryDate: "2026-03-01", source: "invoice", memo: "Season's trade",
      lines: [
        { account: "1010", debit: 36_750_000 },
        { account: "4000", credit: 35_000_000, taxCode: "STANDARD_5", taxEmirate: "DU" },
        { account: "2100", credit: 1_750_000, taxCode: "OUTPUT_VAT", taxEmirate: "DU" },
      ],
    });

    /* ---- a quarter traded and then closed behind itself ------------------- */

    await openFiscalYear({ orgId: ORG, entityId: FILED, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: FILED });
    await postInvoice({ orgId: ORG, invoice: doc(FILED, "OUTBOUND", "2026-02-10", [line(800_000, 40_000)], "INV-FILED") });
    await closeMonths(FILED, ["2026-01", "2026-02", "2026-03"]);
  });

  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------------- the shape */

  it("returns every check in one read, urgent first", async () => {
    const list = await read(ENT);
    expect(list.checked).toBe(11);
    expect(list.entityId).toBe(ENT);
    expect(list.asOf).toBe(AS_OF);
    expect(list.currency).toBe("AED");

    const rank = { urgent: 0, soon: 1, note: 2 } as const;
    const order = list.findings.map((f) => rank[f.severity]);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    expect(list.counts.urgent).toBe(list.findings.filter((f) => f.severity === "urgent").length);
    expect(list.counts.urgent).toBeGreaterThan(0);
    expect(list.counts.soon).toBeGreaterThan(0);
    expect(list.counts.note).toBeGreaterThan(0);
  });

  it("gives every finding somewhere to go and something to read", async () => {
    const list = await read(ENT);
    expect(list.findings.length).toBeGreaterThan(5);
    for (const f of list.findings) {
      expect(f.href.startsWith("/accounting/")).toBe(true);
      expect(f.title.length).toBeGreaterThan(8);
      // A detail that just restates the title is a row nobody can act on.
      expect(f.detail.length).toBeGreaterThan(40);
      if (f.amountMinor !== undefined) {
        expect(typeof f.amountMinor).toBe("string");
        expect(() => BigInt(f.amountMinor!)).not.toThrow();
      }
    }
    // Keys are what a row is linked to and tested for, so they cannot collide.
    expect(new Set(keys(list.findings)).size).toBe(list.findings.length);
  });

  /* --------------------------------------------------------------- money owed */

  it("finds the receivables past their terms and names the worst offender", async () => {
    const f = find((await read(ENT)).findings, "ar_overdue")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("urgent");
    // The March and May invoices, not the June one that is still inside terms.
    expect(f.count).toBe(2);
    expect(f.amountMinor).toBe("1260000");
    expect(f.detail).toMatch(/INV-MAR/);
    // 106 days old against a 30-day term.
    expect(f.detail).toMatch(/76 days past due/);
    expect(f.href).toBe("/accounting/receivables");
  });

  it("counts only the bills falling due inside the next seven days", async () => {
    const f = find((await read(ENT)).findings, "ap_due_soon")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("soon");
    // BILL-DUE alone: BILL-NEW is 14 days old and BILL-OLD is already past term.
    expect(f.count).toBe(1);
    expect(f.amountMinor).toBe("315000");
    expect(f.detail).toMatch(/BILL-DUE/);
  });

  it("finds bank lines with nothing behind them and ages them from the oldest", async () => {
    const f = find((await read(ENT)).findings, "bank_unmatched")!;
    expect(f).toBeDefined();
    expect(f.count).toBe(2);
    // Net, the way the reconciliation states it: 500.00 in less 200.00 out.
    expect(f.amountMinor).toBe("30000");
    expect(f.detail).toMatch(/2026-04-01/);
    // The oldest is 75 days old, which is past a month and no longer a note.
    expect(f.severity).toBe("soon");
  });

  /* -------------------------------------------------------------- deadlines */

  it("reports a VAT return as late once the FTA's 28 days have gone", async () => {
    const f = find((await read(ENT)).findings, "vat_return")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("urgent");
    // The period the return actually covers, named the way the return and the
    // filing record name it. No registration is recorded for this entity, so
    // calendar quarters were assumed — and the finding says so, because being
    // told the wrong three months confidently is the failure this check exists
    // to prevent.
    expect(f.title).toMatch(/Jan-Mar 2026/);
    expect(f.detail).toMatch(/calendar quarters have been assumed/);
    // The March invoice's output tax, and nothing recoverable against it.
    expect(f.amountMinor).toBe("50000");
    expect(f.detail).toMatch(/2026-04-28/);
    expect(f.href).toBe("/accounting/vat");
  });

  it("reads the period from the FTA's stagger once one is recorded, not from the calendar", async () => {
    // Before: no registration, so calendar quarters are assumed and the last
    // one that ended at 15 June is January to March.
    const before = find((await read(ENT)).findings, "vat_return")!;
    expect(before.title).toMatch(/Jan-Mar 2026/);
    expect(before.detail).toMatch(/2026-04-28/);

    // A quarterly registrant the FTA put on February, May, August and
    // November. The last period to end before 15 June is March to May, and it
    // falls due on 28 June — not 28 April, which is the date the calendar
    // arithmetic gave and which is a month early. Told the wrong figure for
    // the wrong three months against the wrong deadline, every quarter, by the
    // list whose purpose is stopping exactly that.
    await recordRegistration({
      orgId: ORG, entityId: ENT, regime: "VAT",
      trn: "100000000000003", frequency: "QUARTERLY", firstPeriodEndMonth: 2,
    });

    const after = find((await read(ENT)).findings, "vat_return")!;
    expect(after.title).toMatch(/Mar-May 2026/);
    expect(after.detail).toMatch(/2026-06-28/);
    // And the assumption footnote is gone, because nothing is being assumed.
    expect(after.detail).not.toMatch(/calendar quarters have been assumed/);
    // Not late: 15 June is before 28 June. The old arithmetic called it urgent.
    expect(after.severity).toBe("soon");

    // Put it back, so the tests after this one see the entity they seeded.
    await db.$executeRawUnsafe(`DELETE FROM "TaxRegistration" WHERE "orgId" = '${ORG}'`);
  });

  it("treats a quarter whose months have been closed behind it as filed", async () => {
    const list = await read(FILED);
    // FILED traded 40,000 of output tax in Q1 and would otherwise be nagged.
    expect(keys(list.findings)).not.toContain("vat_return");
    // The rest of the list still works, so this is not silence from a failure.
    expect(keys(list.findings)).toContain("ar_overdue");
    expect(list.failed).toEqual([]);
  });

  it("finds the months that have ended and are still open", async () => {
    const f = find((await read(ENT)).findings, "periods_open")!;
    expect(f).toBeDefined();
    expect(f.count).toBe(5); // January through May; June has not ended.
    expect(f.detail).toMatch(/2026-01/);
    // January closed 135 days before the reading, which is well past late.
    expect(f.severity).toBe("urgent");
    expect(f.href).toBe("/accounting/periods");
  });

  /* ------------------------------------------------------- work not done yet */

  it("finds a standing journal that has not been posted for months", async () => {
    const f = find((await read(ENT)).findings, "recurring_behind")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("soon");
    expect(f.count).toBe(1);
    expect(f.amountMinor).toBe("1500000");
    expect(f.detail).toMatch(/RENT/);
    expect(f.detail).toMatch(/6 periods/);
  });

  it("finds assets with no depreciation for the last completed month", async () => {
    const f = find((await read(ENT)).findings, "depreciation_due")!;
    expect(f).toBeDefined();
    expect(f.title).toMatch(/2026-05/);
    expect(f.severity).toBe("soon");
    // The van only: the laptop was bought in June, after the month in question.
    expect(f.count).toBe(1);
    expect(f.detail).toMatch(/FA-1/);
    expect(f.detail).not.toMatch(/FA-2/);
  });

  it("finds claims sitting on nobody's desk", async () => {
    const f = find((await read(ENT)).findings, "claims_unapproved")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("note");
    expect(f.count).toBe(1);
    expect(f.amountMinor).toBe("105000");
    expect(f.href).toBe("/accounting/expenses");
  });

  it("finds deliveries that have arrived without an invoice", async () => {
    const f = find((await read(ENT)).findings, "grni_open")!;
    expect(f).toBeDefined();
    expect(f.count).toBe(1);
    // Four units of scaffold hire at 125.00.
    expect(f.amountMinor).toBe("50000");
    // Two weeks old: worth knowing, not yet worth chasing.
    expect(f.severity).toBe("note");
  });

  /* ------------------------------------------------- the impossible finding */

  it("says nothing about a trial balance that balances", async () => {
    expect(keys((await read(ENT)).findings)).not.toContain("trial_balance");
  });

  it("puts an unbalanced trial balance above everything else on the list", async () => {
    const list = await read(BROKEN);
    const f = list.findings[0];
    expect(f.key).toBe("trial_balance");
    expect(f.severity).toBe("urgent");
    expect(f.amountMinor).toBe("12345");
    expect(f.detail).toMatch(/unreliable/i);
    // It outranks the open periods that entity also has.
    expect(keys(list.findings)).toContain("periods_open");
  });

  /* ----------------------------------------- the registration threshold */

  it("says registration is required, by when, and what being late costs", async () => {
    const f = find((await read(GROWING)).findings, "vat_registration")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("urgent");
    expect(f.amountMinor).toBe("40000000");

    // The day the twelve-month window first went over, and thirty days after it.
    expect(f.detail).toMatch(/twelve months to 2026-01-15/);
    expect(f.detail).toMatch(/by 2026-02-14/);
    expect(f.dueOn).toBe("2026-02-14");
    expect(f.statutory).toBe(true);
    // 15 June is 121 days past 14 February, and the title says so.
    expect(f.title).toMatch(/has not been applied for/);
    expect(f.detail).toMatch(/121 days ago/);

    // The law, the threshold, and the thing that actually costs money.
    expect(f.detail).toMatch(/Article 13 of Federal Decree-Law 8\/2017/);
    expect(f.detail).toMatch(/AED 375,000/);
    expect(f.detail).toMatch(/cannot be added to invoices already sent/);
    expect(f.href).toBe("/accounting/vat");
  });

  it("tells a business approaching the threshold without telling it to do anything yet", async () => {
    const f = find((await read(NEARLY)).findings, "vat_registration")!;
    expect(f).toBeDefined();
    // Nothing is required, so nothing is urgent and there is no deadline to
    // carry — an invented one is how a list teaches people its dates mean
    // nothing.
    expect(f.severity).toBe("soon");
    expect(f.dueOn).toBeUndefined();
    expect(f.amountMinor).toBe("35000000");
    expect(f.detail).toMatch(/within a tenth of the AED 375,000/);
    // And the choice that is available now.
    expect(f.detail).toMatch(/voluntary threshold is AED 187,500/);
  });

  it("stops watching the threshold once a registration is recorded", async () => {
    // The threshold decides whether to register. Once that is answered the
    // question is not a live one, and a row about it is noise.
    await recordRegistration({
      orgId: ORG, entityId: NEARLY, regime: "VAT", trn: "100123456700003",
      frequency: "QUARTERLY", firstPeriodEndMonth: 3, registeredOn: "2026-04-01",
    });
    expect(keys((await read(NEARLY)).findings)).not.toContain("vat_registration");
  });

  it("says nothing about the threshold to a business nowhere near it", async () => {
    // ENT has traded AED 13,000 in the window. Registration is neither required
    // nor available, so there is nothing to say and nothing is said.
    expect(keys((await read(ENT)).findings)).not.toContain("vat_registration");
  });

  /* --------------------------------------------------------- the fan-out */

  it("makes one read for two callers asking the same question", async () => {
    const reads = sharedReads({ orgId: ORG, entityId: ENT });
    const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

    const [first, second] = await Promise.all([reads.receivables(day(AS_OF)), reads.receivables(day(AS_OF))]);
    // The very same object, which is only possible if the ageing was read once.
    expect(second).toBe(first);

    // A different day is a different fact, and answering it with this one would
    // be wrong rather than fast.
    const march = await reads.receivables(day("2026-03-15"));
    expect(march).not.toBe(first);
    expect(march.asOf).toBe("2026-03-15");
  });

  it("puts the checks' reads through the object it is handed rather than round it", async () => {
    const real = sharedReads({ orgId: ORG, entityId: ENT });
    const asked: string[] = [];
    const reads: SharedReads = {
      ...real,
      receivables(asOf) {
        asked.push(asOf.toISOString().slice(0, 10));
        return real.receivables(asOf);
      },
    };

    const list = await attentionList({ orgId: ORG, entityId: ENT, asOf: AS_OF, reads });
    // Asked once, by the one check that needs it — and asked at all, which it
    // would not be if the check went to the database on its own account.
    expect(asked).toEqual([AS_OF]);
    expect(find(list.findings, "ar_overdue")).toBeDefined();
  });

  /* ------------------------------------------------------------ good news */

  it("finds nothing at all in a set of books in good order", async () => {
    const list = await read(CLEAN);
    expect(list.findings).toEqual([]);
    expect(list.failed).toEqual([]);
    expect(list.counts).toEqual({ urgent: 0, soon: 0, note: 0 });
    // Every check ran and each declined to say anything, which is what makes
    // the empty state trustworthy rather than merely empty.
    expect(list.checked).toBe(11);
  });

  /* ------------------------------------------------------------ degradation */

  it("degrades one row when a check throws, and keeps the rest", async () => {
    const list = await read(BARE);

    // No book and no chart, so everything that reads the ledger refuses.
    const failedKeys = list.failed.map((f) => f.key);
    expect(failedKeys).toContain("ar_overdue");
    expect(failedKeys).toContain("ap_due_soon");
    expect(failedKeys).toContain("vat_return");
    expect(failedKeys.length).toBeGreaterThanOrEqual(4);

    // And the checks that do not need the ledger still ran.
    expect(keys(list.findings)).toContain("periods_open");
    expect(find(list.findings, "periods_open")!.count).toBe(5);

    // A failure is reported in words, not as an empty row.
    for (const f of list.failed) {
      expect(f.label.length).toBeGreaterThan(3);
      expect(f.reason.length).toBeGreaterThan(10);
    }
    expect(list.failed.map((f) => f.reason).join(" ")).toMatch(/does not exist|has been opened/i);
  });

  /* -------------------------------------------------------------- the date */

  it("is a function of the date it is read as at", async () => {
    const march = await read(ENT, "2026-03-15");
    // On 15 March the March invoice is a fortnight old, so nothing is overdue.
    expect(keys(march.findings)).not.toContain("ar_overdue");
    // Only January and February have ended by then.
    expect(find(march.findings, "periods_open")!.count).toBe(2);
    // And the quarter before that one had no trading in it to report.
    expect(keys(march.findings)).not.toContain("vat_return");
  });

  it("refuses a date it cannot read rather than quietly using today", async () => {
    await expect(attentionList({ orgId: ORG, entityId: ENT, asOf: "the fifteenth" }))
      .rejects.toThrow(/valid date/i);
  });
});
