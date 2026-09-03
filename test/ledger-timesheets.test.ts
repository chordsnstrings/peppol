import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  valueOf, asHours, recordTime, approveTime, writeOffTime, markInvoiced,
  wipAt, runWip, utilisation, timesheetRegister, WIP_ACCOUNT,
} from "@/lib/server/ledger/timesheets";
import { createProject } from "@/lib/server/ledger/projects";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-ts";
const ENT = "t-ent-ts";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "TimeEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "WipPosting" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Project" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${ORG}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Dimension" WHERE "orgId" = '${ORG}'`),
  ]);
}

async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true } });
  const by: Record<string, bigint> = {};
  for (const r of rows) by[r.account.code] = (by[r.account.code] ?? 0n) + r.txnAmountMinor;
  return by;
}

describe("valuing time", () => {
  it("prices a whole hour and a part hour at the rate", () => {
    expect(valueOf(60, 50_000n)).toBe(50_000n);
    expect(valueOf(90, 50_000n)).toBe(75_000n);
    expect(valueOf(15, 50_000n)).toBe(12_500n);
  });

  it("rounds half up, once, at the end", () => {
    // 7 minutes at 100.00 an hour is 11.666…, which rounds to 11.67.
    expect(valueOf(7, 10_000n)).toBe(1_167n);
    // 6 minutes at 33.33 is 3.333, which rounds down.
    expect(valueOf(6, 3_333n)).toBe(333n);
  });

  it("never drifts across a month of six-minute units", () => {
    // Ten six-minute units at 100.00 an hour is exactly one hour's charge.
    // Rounding each and summing would give 10 × 10.00, which happens to agree
    // here; the test that matters is a rate that does not divide.
    const perUnit = valueOf(6, 3_333n) * 10n;
    const whole = valueOf(60, 3_333n);
    expect(whole).toBe(3_333n);
    expect(perUnit).toBe(3_330n);
    // Which is exactly why the register values a stretch of time once rather
    // than adding up rounded pieces.
    expect(whole).not.toBe(perUnit);
  });

  it("reads minutes back as hours and minutes", () => {
    expect(asHours(90)).toBe("1h 30m");
    expect(asHours(60)).toBe("1h");
    expect(asHours(45)).toBe("45m");
  });

  it("is nothing for a stretch of no time", () => {
    expect(valueOf(0, 50_000n)).toBe(0n);
    expect(valueOf(-30, 50_000n)).toBe(0n);
  });
});

d("timesheets and work in progress", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
    await createProject({ ...S, code: "PRJ_1", name: "Tower fit-out", startsOn: "2026-01-01" });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("records time against a project", async () => {
    const t = await recordTime({
      ...S,
      entry: {
        employeeCode: "E-1", projectCode: "PRJ_1", workedOn: "2026-01-10",
        minutes: 480, rateMinor: 50_000, costRateMinor: 20_000,
        description: "Survey and measure",
      },
    });
    expect(t.status).toBe("draft");
    expect(t.minutes).toBe(480);
  });

  it("refuses an entry that says nothing about what the time was for", async () => {
    await expect(recordTime({
      ...S,
      entry: { employeeCode: "E-1", workedOn: "2026-01-10", minutes: 60, rateMinor: 50_000, description: "  " },
    })).rejects.toThrow(/nobody can defend when the client asks/i);
  });

  it("refuses more than a day in a day, and none at all", async () => {
    await expect(recordTime({
      ...S,
      entry: { employeeCode: "E-1", workedOn: "2026-01-10", minutes: 2000, rateMinor: 1, description: "Long day" },
    })).rejects.toThrow(/more than a day/i);
    await expect(recordTime({
      ...S,
      entry: { employeeCode: "E-1", workedOn: "2026-01-10", minutes: 0, rateMinor: 1, description: "Nothing" },
    })).rejects.toThrow(/an entry of none is not an entry/i);
  });

  it("refuses time booked to a project nobody has opened", async () => {
    await expect(recordTime({
      ...S,
      entry: { employeeCode: "E-1", projectCode: "PRJ_NONE", workedOn: "2026-01-10", minutes: 60, rateMinor: 1, description: "Lost time" },
    })).rejects.toThrow(/time nobody will find/i);
  });

  it("carries unbilled time at cost, not at what it will be billed for", async () => {
    const w = await wipAt({ ...S, asOf: "2026-01-31" });
    // Eight hours at 200.00 cost is 1,600.00; at 500.00 charge-out it is 4,000.
    expect(w.balanceMinor).toBe(160_000n);
    expect(w.chargeableMinor).toBe(400_000n);
    expect(w.minutes).toBe(480);
  });

  it("says how much of the register is carried at nothing for want of a cost rate", async () => {
    await recordTime({
      ...S,
      entry: {
        employeeCode: "E-2", projectCode: "PRJ_1", workedOn: "2026-01-12",
        minutes: 120, rateMinor: 40_000, costRateMinor: null, description: "Drafting",
      },
    });
    const w = await wipAt({ ...S, asOf: "2026-01-31" });
    expect(w.unratedMinutes).toBe(120);
    // The cost is unchanged: time with no cost rate is carried at nothing.
    expect(w.balanceMinor).toBe(160_000n);
    expect(w.chargeableMinor).toBe(400_000n + 80_000n);
  });

  it("holds back the cost of unbilled time, and says it is not income", async () => {
    const r = await runWip({ ...S, period: "2026-01" });
    expect(r.posted).toBe(true);
    expect(r.chargeMinor).toBe(160_000n);
    const by = await linesOf(r.entryId!);
    expect(by[WIP_ACCOUNT]).toBe(160_000n);
    expect(by["5100"]).toBe(-160_000n);
    expect(r.note).toMatch(/carried at cost — not at what it will be billed for/);
  });

  it("posts nothing on a second run, because the position has not moved", async () => {
    const again = await runWip({ ...S, period: "2026-01" });
    expect(again.posted).toBe(false);
    expect(again.chargeMinor).toBe(0n);
  });

  it("releases the cost as the work is billed", async () => {
    const drafts = await db.timeEntry.findMany({ where: { orgId: ORG, employeeCode: "E-1" } });
    await approveTime({ ...S, ids: drafts.map((t) => t.id) });
    await markInvoiced({ ...S, ids: drafts.map((t) => t.id), invoiceId: "inv-ts-1" });

    const r = await runWip({ ...S, period: "2026-02" });
    expect(r.chargeMinor).toBe(-160_000n);
    const by = await linesOf(r.entryId!);
    expect(by[WIP_ACCOUNT]).toBe(-160_000n);
    expect(by["5100"]).toBe(160_000n);
  });

  it("refuses to invoice time nobody has approved", async () => {
    const t = await recordTime({
      ...S,
      entry: { employeeCode: "E-3", projectCode: "PRJ_1", workedOn: "2026-02-03", minutes: 60, rateMinor: 30_000, description: "Site visit" },
    });
    await expect(markInvoiced({ ...S, ids: [t.id], invoiceId: "inv-x" }))
      .rejects.toThrow(/somebody other than the person who wrote the time/i);
  });

  it("refuses to invoice time marked non-billable", async () => {
    const t = await recordTime({
      ...S,
      entry: {
        employeeCode: "E-3", projectCode: "PRJ_1", workedOn: "2026-02-04",
        minutes: 60, rateMinor: 30_000, description: "Internal meeting", billable: false,
      },
    });
    await approveTime({ ...S, ids: [t.id] });
    await expect(markInvoiced({ ...S, ids: [t.id], invoiceId: "inv-x" }))
      .rejects.toThrow(/not because anybody is going to pay for it/i);
  });

  it("refuses a write-off with no reason, and says why the reason matters", async () => {
    const t = await recordTime({
      ...S,
      entry: { employeeCode: "E-3", projectCode: "PRJ_1", workedOn: "2026-02-05", minutes: 120, rateMinor: 30_000, description: "Rework" },
    });
    await expect(writeOffTime({ ...S, ids: [t.id], reason: "" }))
      .rejects.toThrow(/only honest measure a firm has of how well it estimates/i);

    const w = await writeOffTime({ ...S, ids: [t.id], reason: "Underestimated the survey; not chargeable." });
    expect(w.writtenOff).toBe(1);
  });

  it("refuses to write off time that has already been charged", async () => {
    const invoiced = await db.timeEntry.findFirstOrThrow({ where: { orgId: ORG, status: "invoiced" } });
    await expect(writeOffTime({ ...S, ids: [invoiced.id], reason: "Changed our minds." }))
      .rejects.toThrow(/written off with a credit note/i);
  });

  it("refuses to approve something twice", async () => {
    const approved = await db.timeEntry.findFirstOrThrow({ where: { orgId: ORG, status: "approved" } });
    await expect(approveTime({ ...S, ids: [approved.id] })).rejects.toThrow(/already approved/i);
  });

  it("measures how much of the time was billable and how much got paid for", async () => {
    const u = await utilisation({ ...S, from: "2026-01-01", to: "2026-02-28" });
    const e1 = u.people.find((p) => p.employeeCode === "E-1")!;
    expect(e1.minutes).toBe(480);
    expect(e1.utilisationBps).toBe(10_000);
    expect(e1.recoveryBps).toBe(10_000);

    const e3 = u.people.find((p) => p.employeeCode === "E-3")!;
    // One hour billable, one hour not, and two hours written off.
    expect(e3.utilisationBps).toBeLessThan(10_000);
    expect(e3.recoveryBps).toBe(0);
    expect(e3.writtenOffMinor > 0n).toBe(true);
  });

  it("answers a rate against no time with nothing rather than nought", async () => {
    const u = await utilisation({ ...S, from: "2030-01-01", to: "2030-01-31" });
    expect(u.people).toEqual([]);
    expect(u.totals.minutes).toBe(0);
  });

  it("ties the register to the ledger", async () => {
    await runWip({ ...S, period: "2026-02" });
    const reg = await timesheetRegister({ ...S, asOf: "2026-02-28" });
    expect(reg.reconciliation.agrees).toBe(true);
    expect(reg.reconciliation.differenceMinor).toBe(0n);
    expect(reg.entries.length).toBeGreaterThan(0);
  });

  it("leaves the books balanced", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-02" });
    expect(tb.balanced).toBe(true);
  });

  it("refuses a period that is not a month", async () => {
    await expect(runWip({ ...S, period: "February" })).rejects.toThrow(/not a month/i);
  });

  it("does not read another organisation's timesheets", async () => {
    const reg = await timesheetRegister({ orgId: "someone-else", entityId: ENT, asOf: "2026-02-28" });
    expect(reg.entries).toEqual([]);
    expect(reg.wip.balanceMinor).toBe(0n);
  });
});
