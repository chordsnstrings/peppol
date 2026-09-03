import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { profitAndLoss } from "@/lib/server/ledger/statements";
import {
  setBudget, copyScenario, budgetVsActual, budgetSummary,
  type VarianceSection,
} from "@/lib/server/ledger/budget";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-bud";
const ENT = "t-ent-bud";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${ORG}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "BudgetLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
  ]);
}

const P = (entryDate: string, lines: { account: string; debit?: number; credit?: number }[], memo = "") =>
  post({ orgId: ORG, entityId: ENT, entryDate, memo, source: "manual", lines });

const JAN_FEB = { from: "2026-01-01", to: "2026-02-28" };
const vs = (range: { from: string; to: string }, scenario = "BUDGET") =>
  budgetVsActual({ orgId: ORG, entityId: ENT, scenario, ...range });
const line = (section: VarianceSection, code: string) => section.lines.find((l) => l.code === code);

d("budgets and variance", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2027", startsOn: "2027-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // Two months of trading, then a third that is still running.
    await P("2026-01-15", [{ account: "1010", debit: 1_000_000 }, { account: "4000", credit: 1_000_000 }], "January sales");
    await P("2026-01-20", [{ account: "6100", debit: 100_000 }, { account: "1010", credit: 100_000 }], "January rent");
    await P("2026-02-15", [{ account: "1010", debit: 1_400_000 }, { account: "4000", credit: 1_400_000 }], "February sales");
    await P("2026-02-20", [{ account: "6100", debit: 100_000 }, { account: "1010", credit: 100_000 }], "February rent");
    // Nobody budgeted for this one.
    await P("2026-02-25", [{ account: "6200", debit: 300_000 }, { account: "1010", credit: 300_000 }], "Campaign");
    // Budgeted at zero, and then incurred anyway.
    await P("2026-03-10", [{ account: "6350", debit: 5_000 }, { account: "1010", credit: 5_000 }], "Bank charges");
    await P("2026-03-20", [{ account: "1010", debit: 200_000 }, { account: "4000", credit: 200_000 }], "March sales");

    await setBudget({
      orgId: ORG, entityId: ENT, fiscalYear: "2026",
      lines: [
        { period: "2026-01", accountCode: "4000", amountMinor: 900_000 },
        { period: "2026-02", accountCode: "4000", amountMinor: 1_000_000 },
        { period: "2026-03", accountCode: "4000", amountMinor: 1_000_000 },
        { period: "2026-01", accountCode: "6100", amountMinor: 100_000 },
        { period: "2026-02", accountCode: "6100", amountMinor: 80_000 },
        { period: "2026-03", accountCode: "6100", amountMinor: 100_000 },
        // Budgeted, never spent.
        { period: "2026-02", accountCode: "6250", amountMinor: 50_000, note: "Audit fee" },
        // Deliberately zero: we plan to incur no bank charges.
        { period: "2026-03", accountCode: "6350", amountMinor: 0 },
        // Parked in June so it only shows up in the full-year figures.
        { period: "2026-06", accountCode: "6500", amountMinor: 33_333 },
      ],
    });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("writes a budget and reports it against the accounts it was set on", async () => {
    const report = await vs(JAN_FEB);
    expect(report.scenario).toBe("BUDGET");
    expect(report.periods).toEqual(["2026-01", "2026-02"]);
    // 900,000 + 1,000,000 planned income for the two months.
    expect(report.income.budgetMinor).toBe("1900000");
    expect(line(report.income, "4000")?.name).toBe("Sales — goods");
  });

  it("refuses a budget against a balance-sheet account, naming it", async () => {
    await expect(
      setBudget({
        orgId: ORG, entityId: ENT, fiscalYear: "2026",
        lines: [{ period: "2026-01", accountCode: "1010", amountMinor: 500_000 }],
      }),
    ).rejects.toThrow(/1010 Bank — current account/);
    await expect(
      setBudget({
        orgId: ORG, entityId: ENT, fiscalYear: "2026",
        lines: [{ period: "2026-01", accountCode: "1010", amountMinor: 500_000 }],
      }),
    ).rejects.toThrow(/balance-sheet account \(ASSET\)/);
  });

  it("refuses a period that falls outside the fiscal year it is filed under", async () => {
    await expect(
      setBudget({
        orgId: ORG, entityId: ENT, fiscalYear: "2026",
        lines: [{ period: "2027-01", accountCode: "4000", amountMinor: 100_000 }],
      }),
    ).rejects.toThrow(/2027-01 falls outside fiscal year 2026, which runs from 2026-01-01 to 2026-12-31/);
  });

  it("refuses two figures for the same account and month", async () => {
    await expect(
      setBudget({
        orgId: ORG, entityId: ENT, fiscalYear: "2026",
        lines: [
          { period: "2026-05", accountCode: "6100", amountMinor: 10_000 },
          { period: "2026-05", accountCode: "6100", amountMinor: 20_000 },
        ],
      }),
    ).rejects.toThrow(/appears twice for 2026-05/);
  });

  it("calls revenue above budget favourable", async () => {
    const sales = line((await vs(JAN_FEB)).income, "4000")!;
    expect(sales.actualMinor).toBe("2400000");
    expect(sales.varianceMinor).toBe("500000");
    expect(sales.favourable).toBe(true);
  });

  it("calls expenses above budget adverse, though the variance has the same sign", async () => {
    const rent = line((await vs(JAN_FEB)).expenses, "6100")!;
    expect(rent.actualMinor).toBe("200000");
    expect(rent.varianceMinor).toBe("20000"); // positive, exactly like the favourable sales variance
    expect(rent.favourable).toBe(false);
    expect((await vs(JAN_FEB)).expenses.favourableWhen).toBe("below");
  });

  it("shows an account that was budgeted and never spent", async () => {
    const audit = line((await vs(JAN_FEB)).expenses, "6250")!;
    expect(audit.budgetMinor).toBe("50000");
    expect(audit.actualMinor).toBe("0");
    expect(audit.varianceMinor).toBe("-50000");
    expect(audit.varianceBps).toBe(-10_000); // the whole budget, unspent
    expect(audit.favourable).toBe(true);
    expect(audit.unbudgeted).toBe(false);
  });

  it("shows spend nobody budgeted for, and flags it", async () => {
    const report = await vs(JAN_FEB);
    const campaign = line(report.expenses, "6200")!;
    expect(campaign.actualMinor).toBe("300000");
    expect(campaign.budgetMinor).toBe("0");
    expect(campaign.unbudgeted).toBe(true);
    expect(campaign.favourable).toBe(false);
    expect(report.unbudgetedCount).toBe(1);
    expect(report.warnings.some((w) => /6200 Marketing and advertising/.test(w))).toBe(true);
  });

  it("gives no percentage variance against a zero budget, rather than infinity", async () => {
    const march = await vs({ from: "2026-03-01", to: "2026-03-31" });
    const charges = line(march.expenses, "6350")!;
    expect(charges.budgetMinor).toBe("0");
    expect(charges.actualMinor).toBe("5000");
    expect(charges.varianceBps).toBeNull();
    expect(Number.isFinite(charges.varianceBps as unknown as number)).toBe(false);
    // A budget deliberately set to zero is a plan, not a missing line.
    expect(charges.unbudgeted).toBe(false);
    expect(charges.favourable).toBe(false);
  });

  it("computes variance rates in basis points", async () => {
    const report = await vs(JAN_FEB);
    expect(report.income.varianceBps).toBe(2631); // 500,000 over 1,900,000
    expect(line(report.expenses, "6100")?.varianceBps).toBe(1111); // 20,000 over 180,000
    expect(report.netVarianceBps).toBe(1377); // 230,000 over 1,670,000
  });

  it("totals each section and the net result", async () => {
    const report = await vs(JAN_FEB);
    expect(report.expenses.budgetMinor).toBe("230000");
    expect(report.expenses.actualMinor).toBe("500000");
    expect(report.expenses.favourable).toBe(false);
    expect(report.netBudgetMinor).toBe("1670000");
    expect(report.netActualMinor).toBe("1900000");
    expect(report.netVarianceMinor).toBe("230000");
    expect(report.netFavourable).toBe(true);
  });

  it("reports the same actuals as the profit and loss for the same period", async () => {
    const report = await vs(JAN_FEB);
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, ...JAN_FEB });
    expect(report.income.actualMinor).toBe(pl.revenue.totalMinor);
    expect(report.expenses.actualMinor).toBe(
      (BigInt(pl.costOfSales.totalMinor) + BigInt(pl.expenses.totalMinor)).toString(),
    );
    expect(report.netActualMinor).toBe(pl.netProfitMinor);
  });

  it("stops at a mid-period cut-off exactly as the statements do", async () => {
    // 14 March is inside the March period: the 20 March sale is out, the
    // 10 March bank charge is in. The budget for the month is included whole,
    // because there is no honest way to split a month's plan across its days —
    // so the report says so rather than pro-rating a figure nobody planned.
    const range = { from: "2026-03-01", to: "2026-03-14" };
    const report = await vs(range);
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, ...range });
    expect(report.income.actualMinor).toBe("0");
    expect(report.income.actualMinor).toBe(pl.revenue.totalMinor);
    expect(report.expenses.actualMinor).toBe("5000");
    expect(report.netActualMinor).toBe(pl.netProfitMinor);
    expect(report.partialPeriods).toEqual(["2026-03"]);
    expect(report.income.budgetMinor).toBe("1000000"); // the whole month's plan
    expect(report.warnings.some((w) => /only part of 2026-03/.test(w))).toBe(true);
  });

  it("copies a scenario, uplifted by basis points", async () => {
    const copy = await copyScenario({
      orgId: ORG, entityId: ENT, from: "BUDGET", to: "FORECAST", fiscalYear: "2026", upliftBps: 500,
    });
    expect(copy.copied).toBe(9);
    expect(copy.replaced).toBe(0);

    const forecast = await vs(JAN_FEB, "FORECAST");
    expect(line(forecast.income, "4000")?.budgetMinor).toBe("1995000"); // (900,000 + 1,000,000) + 5%
    expect(line(forecast.expenses, "6100")?.budgetMinor).toBe("189000"); // (100,000 + 80,000) + 5%
    // 33,333 + 5% is 34,999.65 — rounded on the minor unit, in BigInt.
    const june = await db.budgetLine.findFirst({
      where: { orgId: ORG, entityId: ENT, scenario: "FORECAST", period: "2026-06", accountCode: "6500" },
    });
    expect(june?.amountMinor).toBe(35_000n);
  });

  it("refuses to overwrite a scenario that already holds work unless told to", async () => {
    await expect(
      copyScenario({ orgId: ORG, entityId: ENT, from: "BUDGET", to: "FORECAST", fiscalYear: "2026" }),
    ).rejects.toThrow(/already holds 9 lines for 2026/);

    const again = await copyScenario({
      orgId: ORG, entityId: ENT, from: "BUDGET", to: "FORECAST", fiscalYear: "2026",
      upliftBps: 1_000, overwrite: true,
    });
    expect(again.replaced).toBe(9);
    expect((await vs(JAN_FEB, "FORECAST")).income.budgetMinor).toBe("2090000"); // 1,900,000 + 10%
  });

  it("refuses to copy a scenario onto itself", async () => {
    await expect(
      copyScenario({ orgId: ORG, entityId: ENT, from: "BUDGET", to: "BUDGET", fiscalYear: "2026" }),
    ).rejects.toThrow(/cannot be copied onto itself/);
  });

  it("rolls a scenario into the next fiscal year, shifting every month", async () => {
    const rolled = await copyScenario({
      orgId: ORG, entityId: ENT, from: "BUDGET", to: "BUDGET",
      fiscalYear: "2026", toFiscalYear: "2027", upliftBps: 0,
    });
    expect(rolled.copied).toBe(9);
    const next = await vs({ from: "2027-01-01", to: "2027-02-28" });
    expect(next.income.budgetMinor).toBe("1900000"); // the same plan, a year later
    expect(next.income.actualMinor).toBe("0"); // nothing has been posted in 2027
    expect(line(next.income, "4000")?.favourable).toBe(false); // no revenue against a plan is adverse
  });

  it("separates what has happened from what is only projected", async () => {
    const s = await budgetSummary({ orgId: ORG, entityId: ENT, fiscalYear: "2026", asOf: "2026-03-31" });
    expect(s.elapsedDays).toBe(90);
    expect(s.totalDays).toBe(365);
    // Fact: three months of sales.
    expect(s.income.actualToDateMinor).toBe("2600000");
    expect(s.income.budgetToDateMinor).toBe("2900000");
    expect(s.income.favourableToDate).toBe(false);
    // Plan: only Q1 and one June line were ever budgeted.
    expect(s.income.budgetFullYearMinor).toBe("2900000");
    expect(s.expenses.budgetFullYearMinor).toBe("363333");
    // Arithmetic: 2,600,000 × 365 ÷ 90, kept in its own field.
    expect(s.income.projectedFullYearMinor).toBe("10544444");
    expect(s.net.actualToDateMinor).toBe("2095000");
    expect(s.projectionBasis).toMatch(/run rate, not a forecast/);
  });

  it("warns when the run rate is built on very little of the year", async () => {
    const s = await budgetSummary({ orgId: ORG, entityId: ENT, fiscalYear: "2026", asOf: "2026-01-31" });
    expect(s.elapsedDays).toBe(31);
    expect(s.warnings.some((w) => /projection multiplies the year to date/.test(w))).toBe(true);
  });

  it("refuses a summary as at a date before the year began", async () => {
    await expect(
      budgetSummary({ orgId: ORG, entityId: ENT, fiscalYear: "2026", asOf: "2025-12-31" }),
    ).rejects.toThrow(/before fiscal year 2026 starts on 2026-01-01/);
  });
});
