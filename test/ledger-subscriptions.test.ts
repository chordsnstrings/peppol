import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  nextDate, createSubscription, pauseSubscription, resumeSubscription, endSubscription,
  dueSubscriptions, issueDue, issueAllDue, subscriptionRegister,
} from "@/lib/server/ledger/subscriptions";
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
});
