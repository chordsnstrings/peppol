import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  nextDate, createSubscription, pauseSubscription, resumeSubscription, endSubscription,
  dueSubscriptions, issueDue, issueAllDue, subscriptionRegister,
} from "@/lib/server/ledger/subscriptions";
import { createCounterparty, placeOnHold, releaseHold } from "@/lib/server/ledger/counterparties";
import { receivablesAgeing } from "@/lib/server/ledger/ar";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-sub";
const ENT = "t-ent-sub";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "RecurringInvoiceIssue" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "RecurringInvoice" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Record" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "CreditHold" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "CreditLimit" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Counterparty" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FxRate" WHERE "orgId" = '${ORG}'`),
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

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("the schedule", () => {
  it("adds a week, a month, a quarter and a year", () => {
    expect(iso(nextDate(D("2026-01-05"), "WEEKLY"))).toBe("2026-01-12");
    expect(iso(nextDate(D("2026-01-05"), "MONTHLY"))).toBe("2026-02-05");
    expect(iso(nextDate(D("2026-01-05"), "QUARTERLY"))).toBe("2026-04-05");
    expect(iso(nextDate(D("2026-01-05"), "ANNUAL"))).toBe("2027-01-05");
  });

  it("keeps a month-end run on the month end rather than skipping a month", () => {
    // The 31st plus a month is where every recurring biller goes wrong. Rolling
    // forward into March would silently miss February altogether.
    expect(iso(nextDate(D("2026-01-31"), "MONTHLY"))).toBe("2026-02-28");
    expect(iso(nextDate(D("2026-03-31"), "MONTHLY"))).toBe("2026-04-30");
    expect(iso(nextDate(D("2024-01-31"), "MONTHLY"))).toBe("2024-02-29");
  });

  it("does not creep earlier once it has rolled back", () => {
    // February the 28th plus a month is March the 28th, not the 31st — the
    // schedule is walked one step at a time from where it actually is.
    expect(iso(nextDate(D("2026-02-28"), "MONTHLY"))).toBe("2026-03-28");
  });
});

d("subscriptions", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("records a subscription and prices it before storing it", async () => {
    const t = await createSubscription({
      ...S,
      subscription: {
        code: "SUB-1", customerName: "Gulf Logistics LLC", customerTrn: "100000000000003",
        frequency: "MONTHLY", startsOn: "2026-01-01", paymentTerms: 30,
        lines: [
          { description: "Platform licence", quantityMilli: 1000, unitPriceMinor: 200_000 },
          { description: "Support", quantityMilli: 2000, unitPriceMinor: 25_000 },
        ],
      },
    });
    expect(t.code).toBe("SUB-1");
    expect(iso(t.nextOn)).toBe("2026-01-01");
    expect(t.status).toBe("active");
  });

  it("refuses a template with a tax code the ledger does not know", async () => {
    await expect(createSubscription({
      ...S,
      subscription: {
        code: "SUB-BAD", customerName: "Nobody", startsOn: "2026-01-01",
        lines: [{ description: "x", quantityMilli: 1000, unitPriceMinor: 100, taxCode: "VAT5" }],
      },
    })).rejects.toThrow(/does not know/);
  });

  it("refuses a margin-scheme line, because a template has no purchase cost", async () => {
    // The margin scheme prices from what the particular item cost, and a
    // subscription bills the same line every period. Computing 5% of the whole
    // price — which is what this used to do — would charge the customer a tax
    // the scheme exists to avoid, on an invoice that must not show tax at all.
    await expect(createSubscription({
      ...S,
      subscription: {
        code: "SUB-MARGIN", customerName: "Nobody", startsOn: "2026-01-01",
        lines: [{ description: "x", quantityMilli: 1000, unitPriceMinor: 100, taxCode: "MARGIN_SCHEME" }],
      },
    })).rejects.toThrow(/prices from what the particular item cost/);
  });

  it("refuses one that ends before it begins", async () => {
    await expect(createSubscription({
      ...S,
      subscription: {
        code: "SUB-BACK", customerName: "Nobody", startsOn: "2026-06-01", endsOn: "2026-01-01",
        lines: [{ description: "x", quantityMilli: 1000, unitPriceMinor: 100 }],
      },
    })).rejects.toThrow(/nobody notices for a quarter/i);
  });

  it("refuses a duplicate code, naming who it bills", async () => {
    await expect(createSubscription({
      ...S,
      subscription: {
        code: "SUB-1", customerName: "Someone else", startsOn: "2026-01-01",
        lines: [{ description: "x", quantityMilli: 1000, unitPriceMinor: 100 }],
      },
    })).rejects.toThrow(/already exists — it bills Gulf Logistics LLC/);
  });

  it("counts every period that is due, not just the next one", async () => {
    // Three months since it started, so three invoices are owed — folding them
    // into one would lose which period each part was for.
    const due = await dueSubscriptions({ ...S, asOf: "2026-03-15" });
    const one = due.due.find((x) => x.code === "SUB-1")!;
    expect(one.periodsDue).toBe(3);
    // 200,000 + 2 × 25,000 = 250,000 net, plus 5% = 262,500 per invoice.
    expect(one.totalMinor).toBe(262_500n * 3n);
  });

  it("raises one invoice per period and posts each through receivables", async () => {
    const r = await issueDue({ ...S, code: "SUB-1", asOf: "2026-03-15" });
    expect(r.raised).toHaveLength(3);
    expect(r.raised.map((x) => x.scheduledOn)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(r.raised.every((x) => x.totalMinor === 262_500n)).toBe(true);
    expect(r.nextOn).toBe("2026-04-01");

    // Each is a real document, not just a ledger entry.
    const docs = await db.record.count({ where: { orgId: ORG, store: "invoices" } });
    expect(docs).toBe(3);

    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-03-15") });
    expect(ageing.totalMinor).toBe((262_500n * 3n).toString());
  });

  it("carries the payment terms onto the invoice, so the ageing knows when it is due", async () => {
    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-03-15") });
    const first = ageing.open.find((o) => o.date === "2026-01-01")!;
    expect(first.dueDate).toBe("2026-01-31");
    expect(first.daysOverdue).toBeGreaterThan(0);
  });

  it("cannot bill the same period twice, however often the run is repeated", async () => {
    const again = await issueDue({ ...S, code: "SUB-1", asOf: "2026-03-15" });
    expect(again.raised).toHaveLength(0);
    expect(again.alreadyRaised).toEqual([]);

    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-03-15") });
    expect(ageing.totalMinor).toBe((262_500n * 3n).toString());
  });

  it("holds that rule in the database, not only in the code", async () => {
    const t = await db.recurringInvoice.findFirstOrThrow({ where: { orgId: ORG, code: "SUB-1" } });
    await expect(db.recurringInvoiceIssue.create({
      data: {
        orgId: ORG, templateId: t.id,
        scheduledOn: new Date("2026-01-01"), issuedOn: new Date(),
        invoiceId: "dup", invoiceNumber: "DUP-1", totalMinor: 1n,
      },
    })).rejects.toThrow();
  });

  it("does not catch up the periods a pause was meant to skip", async () => {
    await pauseSubscription({ ...S, code: "SUB-1" });
    const paused = await dueSubscriptions({ ...S, asOf: "2026-07-15" });
    expect(paused.due.find((x) => x.code === "SUB-1")).toBeUndefined();

    const r = await resumeSubscription({ ...S, code: "SUB-1", asOf: "2026-07-15" });
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.note).toMatch(/several invoices on one day/);
    expect(iso(r.nextOn)).toBe("2026-08-01");
  });

  it("refuses to pause or resume something that has ended", async () => {
    await createSubscription({
      ...S,
      subscription: {
        code: "SUB-2", customerName: "Sharjah Media", startsOn: "2026-01-01",
        lines: [{ description: "Retainer", quantityMilli: 1000, unitPriceMinor: 500_000 }],
      },
    });
    await endSubscription({ ...S, code: "SUB-2", on: "2026-02-01" });
    await expect(pauseSubscription({ ...S, code: "SUB-2" })).rejects.toThrow(/has ended/);
    await expect(resumeSubscription({ ...S, code: "SUB-2" })).rejects.toThrow(/cannot be resumed/);
  });

  it("stops on its own end date rather than running for ever", async () => {
    await createSubscription({
      ...S,
      subscription: {
        code: "SUB-3", customerName: "Ajman Steel", startsOn: "2026-01-01", endsOn: "2026-03-01",
        lines: [{ description: "Pilot", quantityMilli: 1000, unitPriceMinor: 100_000 }],
      },
    });
    const r = await issueDue({ ...S, code: "SUB-3", asOf: "2026-12-31" });
    expect(r.raised.map((x) => x.scheduledOn)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);

    const t = await db.recurringInvoice.findFirstOrThrow({ where: { orgId: ORG, code: "SUB-3" } });
    expect(t.status).toBe("ended");
  });

  it("raises every due subscription in one pass", async () => {
    await createSubscription({
      ...S,
      subscription: {
        code: "SUB-4", customerName: "Fujairah Foods", startsOn: "2026-04-01", frequency: "QUARTERLY",
        lines: [{ description: "Quarterly fee", quantityMilli: 1000, unitPriceMinor: 300_000 }],
      },
    });
    const all = await issueAllDue({ ...S, asOf: "2026-04-30" });
    expect(all.invoicesRaised).toBeGreaterThanOrEqual(1);
    expect(all.totalMinor > 0n).toBe(true);
  });

  it("says what the book is worth in a year, which no statement does", async () => {
    const reg = await subscriptionRegister({ ...S, asOf: "2026-04-30" });
    const sub1 = reg.subscriptions.find((s) => s.code === "SUB-1")!;
    expect(sub1.perInvoiceMinor).toBe(262_500n);
    expect(sub1.issuedCount).toBe(3);
    // A quarterly subscription at 315,000 a quarter is 1,260,000 a year.
    expect(reg.summary.annualisedMinor > 0n).toBe(true);
    expect(reg.summary.activeCount).toBeGreaterThan(0);
  });

  it("bills the whole history, not the six invoices the screen happens to list", async () => {
    // The register read the last six invoices and reduced them, beside
    // `issuedCount`, which counts all of them. Past the sixth invoice the two
    // columns described different sets: "48 issued, AED 30,000 billed" against
    // a real AED 240,000, with nothing on the row to say so.
    await createSubscription({
      ...S,
      subscription: {
        code: "SUB-LONG", customerName: "Deira Marine LLC", customerTrn: "100000000000009",
        frequency: "MONTHLY", startsOn: "2026-01-01", paymentTerms: 30,
        lines: [{ description: "Monitoring", quantityMilli: 1000, unitPriceMinor: 100_000 }],
      },
    });
    // Ten months of it, which is more than the six the screen lists.
    const issued = await issueDue({ ...S, code: "SUB-LONG", asOf: "2026-10-01" });
    expect(issued.raised).toHaveLength(10);

    const reg = await subscriptionRegister({ ...S, asOf: "2026-10-31" });
    const long = reg.subscriptions.find((s) => s.code === "SUB-LONG")!;
    const everyInvoice = issued.raised.reduce((a, r) => a + r.totalMinor, 0n);

    expect(long.issuedCount).toBe(10);
    expect(long.billedCount).toBe(10);
    expect(long.billedMinor).toBe(everyInvoice);
    // The list is still a list of the recent ones, and the total is not a total
    // of the list — which is the distinction the row was getting wrong.
    expect(long.recent).toHaveLength(6);
    expect(long.recent.reduce((a, r) => a + r.totalMinor, 0n)).toBeLessThan(long.billedMinor);
  });

  it("leaves the books balanced after all of it", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-04" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });

  it("does not raise another organisation's subscription", async () => {
    await expect(issueDue({ orgId: "someone-else", entityId: ENT, code: "SUB-1" }))
      .rejects.toThrow(/no subscription SUB-1/i);
  });

  /**
   * Credit control on the one sale nobody is present for.
   *
   * The gate on the invoice screen catches a person about to finalise a
   * document. A standing arrangement has no such moment, so a customer put on
   * hold went on being invoiced every month by the arrangement — and the ledger
   * ended up holding exactly the debt the hold was placed to prevent.
   */
  it("stops invoicing a customer who has been put on credit hold", async () => {
    await createCounterparty({
      ...S, counterparty: { code: "HELDCO", name: "Held Company LLC", kind: "CUSTOMER" },
    });
    await placeOnHold({ ...S, code: "HELDCO", reason: "Cheque returned unpaid twice", actorId: "u1" });
    await createSubscription({
      ...S,
      subscription: {
        code: "SUB-HOLD", customerCode: "HELDCO", customerName: "Held Company LLC",
        frequency: "MONTHLY", startsOn: "2026-05-01", paymentTerms: 30,
        lines: [{ description: "Retainer", quantityMilli: 1000, unitPriceMinor: 400_000 }],
      },
    });

    const run = await issueDue({ ...S, code: "SUB-HOLD", asOf: "2026-06-15" });
    expect(run.raised).toHaveLength(0);
    expect(run.refused.map((r) => r.scheduledOn)).toEqual(["2026-05-01"]);
    expect(run.refused[0].reasons.join(" ")).toContain("Cheque returned unpaid twice");
    expect(run.refused[0].overridePermission).toBe("ar.credit_hold");

    // The period is not skipped. The supply is still owed, so it stays due and
    // the run stops there rather than stepping over a month's billing.
    expect(run.nextOn).toBe("2026-05-01");
    expect(run.note).toContain("still due");

    const t = await db.recurringInvoice.findFirstOrThrow({ where: { orgId: ORG, code: "SUB-HOLD" } });
    expect(iso(t.nextOn)).toBe("2026-05-01");
    expect(t.issuedCount).toBe(0);
    // Nothing reached the store and nothing reached the books.
    expect(await db.recurringInvoiceIssue.count({ where: { templateId: t.id } })).toBe(0);
    expect(await db.record.count({ where: { orgId: ORG, store: "invoices", id: { startsWith: t.id } } })).toBe(0);
  });

  it("says so where somebody will see it, and says it once", async () => {
    // A refusal on an unattended run that only ever went back to the worker is
    // a refusal nobody reads until they wonder why a customer stopped paying.
    const notices = await db.record.findMany({ where: { orgId: ORG, store: "notifications" } });
    expect(notices).toHaveLength(1);
    const notice = JSON.parse(notices[0].data) as { type: string; title: string; body: string; tone: string };
    expect(notice.type).toBe("subscription.credit_refused");
    expect(notice.title).toContain("SUB-HOLD");
    expect(notice.title).toContain("Held Company LLC");
    expect(notice.body).toContain("2026-05-01");
    expect(notice.tone).toBe("warning");

    // A hold that stands for a month must not file thirty of these, nor un-read
    // the one somebody has already dealt with.
    await issueDue({ ...S, code: "SUB-HOLD", asOf: "2026-06-15" });
    expect(await db.record.count({ where: { orgId: ORG, store: "notifications" } })).toBe(1);
  });

  it("bills the periods it held back once the account is released", async () => {
    await releaseHold({ ...S, code: "HELDCO", reason: "Replacement cheque cleared", actorId: "u1" });
    const run = await issueDue({ ...S, code: "SUB-HOLD", asOf: "2026-06-15" });
    expect(run.refused).toEqual([]);
    expect(run.raised.map((r) => r.scheduledOn)).toEqual(["2026-05-01", "2026-06-01"]);
    // The refusals consumed no numbers, so the first invoice this arrangement
    // ever raises is still its first.
    expect(run.raised.map((r) => r.number)).toEqual(["SUB-HOLD-0001", "SUB-HOLD-0002"]);
  });

  /**
   * The AED figures a foreign-currency invoice has to carry.
   *
   * Article 69 of Federal Decree-Law 8/2017 converts the tax on a
   * foreign-currency document to dirhams and Article 59(1)(k) of the Executive
   * Regulation puts the converted figure and the rate on the document. A
   * template carries a currency and no rate — it is written once and billed for
   * years — so the rate is the one on file for the day the period fell due.
   */
  it("states the tax in AED on a foreign-currency invoice, at the rate on file for that period", async () => {
    await db.fxRate.create({
      data: { orgId: ORG, entityId: ENT, currency: "USD", rate: "3.6725", rateDate: D("2026-08-01"), source: "CBUAE" },
    });
    await createSubscription({
      ...S,
      subscription: {
        code: "SUB-USD", customerName: "Jebel Ali Freight FZE", currency: "USD",
        frequency: "MONTHLY", startsOn: "2026-09-01", paymentTerms: 30,
        lines: [{ description: "Platform licence", quantityMilli: 1000, unitPriceMinor: 200_000 }],
      },
    });

    const run = await issueDue({ ...S, code: "SUB-USD", asOf: "2026-09-15" });
    expect(run.raised).toHaveLength(1);

    const row = await db.record.findFirstOrThrow({
      where: { orgId: ORG, store: "invoices", id: run.raised[0].invoiceId },
    });
    const inv = JSON.parse(row.data) as {
      currency: string;
      fx: { rateToAED: string; source: string; rateDate: string };
      totals: { vatMinor: number; vatMinorAED?: number; payableMinorAED?: number };
    };
    expect(inv.currency).toBe("USD");
    // On the face of the document as well as in its totals: the printed invoice
    // and the UBL both derive the conversion from the rate the document carries.
    expect(Number(inv.fx.rateToAED)).toBe(3.6725);
    expect(inv.fx.source).toBe("CBUAE");
    expect(inv.fx.rateDate).toBe("2026-08-01");
    // 2,000.00 USD at 5% is 100.00 USD of tax; at 3.6725 that is 367.25 AED,
    // and the payable of 2,100.00 is 7,712.25.
    expect(inv.totals.vatMinor).toBe(10_000);
    expect(inv.totals.vatMinorAED).toBe(36_725);
    expect(inv.totals.payableMinorAED).toBe(771_225);
  });

  it("raises no foreign-currency invoice at a rate nobody recorded", async () => {
    // The alternative is an invoice whose AED tax was made up, and the books
    // would carry the conversion too. `postInvoice` refuses it for the same
    // reason, which is why this comes back as an error rather than a document.
    await createSubscription({
      ...S,
      subscription: {
        code: "SUB-EUR", customerName: "Rotterdam Chartering BV", currency: "EUR",
        frequency: "MONTHLY", startsOn: "2026-09-01", paymentTerms: 30,
        lines: [{ description: "Platform licence", quantityMilli: 1000, unitPriceMinor: 200_000 }],
      },
    });
    await expect(issueDue({ ...S, code: "SUB-EUR", asOf: "2026-09-15" }))
      .rejects.toThrow(/no exchange rate to AED/i);
  });
});
