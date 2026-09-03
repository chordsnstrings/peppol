import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post } from "@/lib/server/ledger/post";
import { profitAndLoss, balanceSheet } from "@/lib/server/ledger/statements";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { closeYear } from "@/lib/server/ledger/close";
import type { LayoutInput } from "@/lib/server/ledger/layouts";
import {
  commonSize,
  comparativeBalanceSheet,
  comparativeLayout,
  comparativeProfitAndLoss,
  ratios,
  trend,
} from "@/lib/server/ledger/comparatives";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-cmp";
const ENT = "t-ent-cmp";

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
  ]);
}

const P = (
  entryDate: string,
  lines: { account: string; debit?: number; credit?: number }[],
  memo = "",
  // Control accounts refuse a manual posting; the subledger sources are how a
  // receivable, a payable or a stock movement legitimately reaches them.
  source: "manual" | "invoice" | "bill" | "inventory" = "manual",
) => post({ orgId: ORG, entityId: ENT, entryDate, memo, source, lines });

d("comparative and analytical reporting", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2027", startsOn: "2027-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    /* 2026 — the first year of trading.
       Revenue 2,000,000 · cost of sales 800,000 · gross profit 1,200,000
       Operating expenses 750,000 (rent 300,000, salaries 400,000, interest
       100,000, less a 50,000 exchange gain booked to the exchange loss
       account, which is what puts a negative figure in a comparative base).
       Net profit 450,000. */
    await P("2026-01-05", [{ account: "1010", debit: 10_000_000 }, { account: "3000", credit: 10_000_000 }], "Share capital");
    await P("2026-03-10", [{ account: "1010", debit: 2_000_000 }, { account: "4000", credit: 2_000_000 }], "Sales");
    await P("2026-03-12", [{ account: "5000", debit: 800_000 }, { account: "1010", credit: 800_000 }], "Cost of goods sold");
    await P("2026-05-01", [{ account: "1010", debit: 50_000 }, { account: "6800", credit: 50_000 }], "Exchange gain");
    await P("2026-06-15", [{ account: "6100", debit: 300_000 }, { account: "1010", credit: 300_000 }], "Rent");
    await P("2026-09-20", [{ account: "6000", debit: 400_000 }, { account: "1010", credit: 400_000 }], "Salaries");
    await P("2026-11-10", [{ account: "6360", debit: 100_000 }, { account: "1010", credit: 100_000 }], "Loan interest");

    /* 2027 — bigger, with working capital in it.
       Revenue 3,600,000 · cost of sales 1,200,000 · gross profit 2,400,000
       Operating expenses 870,000 · net profit 1,530,000. */
    await P("2027-03-10", [{ account: "1010", debit: 3_000_000 }, { account: "4000", credit: 3_000_000 }], "Sales");
    await P("2027-03-12", [{ account: "5000", debit: 1_000_000 }, { account: "1010", credit: 1_000_000 }], "Cost of goods sold");
    await P("2027-05-01", [{ account: "1010", debit: 30_000 }, { account: "6800", credit: 30_000 }], "Exchange gain");
    await P("2027-06-15", [{ account: "6100", debit: 300_000 }, { account: "1010", credit: 300_000 }], "Rent");
    await P("2027-09-20", [{ account: "6000", debit: 500_000 }, { account: "1010", credit: 500_000 }], "Salaries");
    await P("2027-11-10", [{ account: "6360", debit: 100_000 }, { account: "1010", credit: 100_000 }], "Loan interest");
    await P("2027-12-01", [{ account: "1100", debit: 600_000 }, { account: "4100", credit: 600_000 }], "Services invoice", "invoice");
    await P("2027-12-05", [{ account: "5200", debit: 200_000 }, { account: "2000", credit: 200_000 }], "Freight bill", "bill");
    await P("2027-12-10", [{ account: "1200", debit: 800_000 }, { account: "1010", credit: 800_000 }], "Stock purchase", "inventory");

    // Close 2026 for real. Everything below is then read against a prior year
    // whose income and expense accounts have been brought to nil by a posting
    // dated inside it — which is the case a comparative gets wrong.
    const year2026 = await db.fiscalYear.findFirstOrThrow({ where: { orgId: ORG, entityId: ENT, label: "2026" } });
    await db.accountingPeriod.updateMany({
      where: { orgId: ORG, entityId: ENT, fiscalYearId: year2026.id, isAdjustment: false },
      data: { status: "hard_closed" },
    });
    await closeYear({ orgId: ORG, entityId: ENT, fiscalYear: "2026" });
  });

  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------- the two columns ----- */

  it("puts the same figures side by side that each statement gives on its own", async () => {
    const cmp = await comparativeProfitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31", against: "prior_year" });
    const now = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31" });
    const then = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-12-31" });

    expect(cmp.revenue.currentMinor).toBe(now.revenue.totalMinor);
    expect(cmp.revenue.priorMinor).toBe(then.revenue.totalMinor);
    expect(cmp.costOfSales.currentMinor).toBe(now.costOfSales.totalMinor);
    expect(cmp.costOfSales.priorMinor).toBe(then.costOfSales.totalMinor);
    expect(cmp.grossProfit.currentMinor).toBe(now.grossProfitMinor);
    expect(cmp.grossProfit.priorMinor).toBe(then.grossProfitMinor);
    expect(cmp.netProfit.currentMinor).toBe(now.netProfitMinor);
    expect(cmp.netProfit.priorMinor).toBe(then.netProfitMinor);
  });

  it("still reports a closed prior year's trading rather than a column of nil", async () => {
    // Closing 2026 debited every income account and credited every expense
    // account to nothing on 31 December. A comparative built from balances
    // rather than from `profitAndLoss` reads the whole prior column as nil, and
    // the movement column then claims this year's whole revenue as growth.
    const cmp = await comparativeProfitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31", against: "prior_year" });
    expect(cmp.revenue.priorMinor).toBe("2000000");
    expect(cmp.netProfit.priorMinor).toBe("450000");
    expect(cmp.revenue.movementMinor).toBe("1600000");
  });

  it("gives the movement and the movement in basis points", async () => {
    const cmp = await comparativeProfitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31", against: "prior_year" });
    expect(cmp.revenue.currentMinor).toBe("3600000");
    expect(cmp.revenue.movementBps).toBe(8000); // 1,600,000 on a base of 2,000,000
    expect(cmp.netProfit.movementMinor).toBe("1080000");
    expect(cmp.netProfit.movementBps).toBe(24_000);
    expect(cmp.revenue.reason).toBeNull();
  });

  it("reads the change in a margin as basis points, not as a percentage of a percentage", async () => {
    const cmp = await comparativeProfitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31", against: "prior_year" });
    expect(cmp.grossMargin.priorBps).toBe(6000);
    expect(cmp.grossMargin.currentBps).toBe(6667);
    expect(cmp.grossMargin.movementBpsPoints).toBe(667);
  });

  it("resolves the prior period, the prior year and explicit dates", async () => {
    const year = await comparativeProfitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31", against: "prior_year" });
    expect(year.prior).toEqual({ from: "2026-01-01", to: "2026-12-31" });

    // The immediately preceding span of the same length — 365 days back from
    // the day before this one started.
    const period = await comparativeProfitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31", against: "prior_period" });
    expect(period.prior).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(period.against).toBe("prior_period");

    const explicit = await comparativeProfitAndLoss({
      orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31",
      against: { from: "2026-01-01", to: "2026-06-30" },
    });
    expect(explicit.against).toBe("explicit");
    expect(explicit.prior).toEqual({ from: "2026-01-01", to: "2026-06-30" });
    expect(explicit.revenue.priorMinor).toBe("2000000");
  });

  it("counts a prior period in days, so a half-year is compared against the same number of days", async () => {
    // July to December is 184 days and January to June is 181, so the two
    // calendar halves are not the same period at all. Counting in days is what
    // makes the comparison one of like with like; anyone who wants the calendar
    // half asks for it by its dates.
    const cmp = await comparativeProfitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-07-01", to: "2027-12-31", against: "prior_period" });
    expect(cmp.prior).toEqual({ from: "2026-12-29", to: "2027-06-30" });
  });

  /* ------------------------------------------- an absent comparative ----- */

  it("reports a first year as having no comparative rather than as a column of zeros", async () => {
    const cmp = await comparativeProfitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-12-31", against: "prior_year" });
    expect(cmp.comparativeAbsent).toBe(true);
    expect(cmp.prior).toBeNull();
    expect(cmp.revenue.priorMinor).toBeNull();
    expect(cmp.revenue.priorMinor).not.toBe("0");
    expect(cmp.revenue.movementMinor).toBeNull();
    expect(cmp.revenue.movementBps).toBeNull();
    expect(cmp.revenue.reason).toBe("no_comparative");
    expect(cmp.netProfit.priorMinor).toBeNull();
    expect(cmp.absenceReason).toMatch(/first posting/i);
    // The current column is still a complete statement.
    expect(cmp.revenue.currentMinor).toBe("2000000");
  });

  it("reports an absent comparative on a balance sheet too", async () => {
    const cmp = await comparativeBalanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-06-30", against: "prior_year" });
    expect(cmp.comparativeAbsent).toBe(true);
    expect(cmp.prior).toBeNull();
    expect(cmp.totalAssets.priorMinor).toBeNull();
    expect(cmp.balanced.prior).toBeNull();
    expect(cmp.balanced.current).toBe(true);
  });

  /* --------------------------------------------- a base for a rate ------- */

  it("returns no percentage against a nil base, and the movement in money regardless", async () => {
    const cmp = await comparativeProfitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31", against: "prior_year" });
    // 4100 first earned anything in 2027. Its prior figure is a real nil.
    const services = cmp.revenue.lines.find((l) => l.code === "4100")!;
    expect(services.priorMinor).toBe("0");
    expect(services.currentMinor).toBe("600000");
    expect(services.movementMinor).toBe("600000");
    expect(services.movementBps).toBeNull();
    expect(services.reason).toBe("nil_base");
  });

  it("returns no percentage against a negative base, because the sign would reverse its meaning", async () => {
    // The decision, stated once and applied everywhere: a percentage change is
    // given only against a strictly positive base. 6800 carries an exchange
    // gain, so it presents negative in both columns; the movement from
    // (50,000) to (30,000) is an improvement of 20,000, and a percentage taken
    // on a negative base would render that as a fall.
    const cmp = await comparativeProfitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31", against: "prior_year" });
    const fx = cmp.expenses.lines.find((l) => l.code === "6800")!;
    expect(fx.priorMinor).toBe("-50000");
    expect(fx.currentMinor).toBe("-30000");
    expect(fx.movementMinor).toBe("20000");
    expect(fx.movementBps).toBeNull();
    expect(fx.reason).toBe("negative_base");
  });

  /* --------------------------------------------------- balance sheet ----- */

  it("sets two balance sheets side by side and keeps both balanced", async () => {
    const cmp = await comparativeBalanceSheet({ orgId: ORG, entityId: ENT, asOf: "2027-12-31", against: "prior_year" });
    const then = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
    expect(cmp.prior).toEqual({ asOf: "2026-12-31" });
    expect(cmp.totalAssets.currentMinor).toBe("12180000");
    expect(cmp.totalAssets.priorMinor).toBe(then.totalAssetsMinor);
    expect(cmp.totalAssets.movementMinor).toBe("1730000");
    expect(cmp.balanced.current).toBe(true);
    expect(cmp.balanced.prior).toBe(true);
    // The close moved 2026's result into retained earnings, so the prior
    // column's current-year earnings are nil while its trading was not.
    expect(cmp.currentYearEarnings.currentMinor).toBe("1530000");
    expect(cmp.currentYearEarnings.priorMinor).toBe("0");
  });

  it("takes a balance sheet's prior period back one month, clamped to the month end", async () => {
    const cmp = await comparativeBalanceSheet({ orgId: ORG, entityId: ENT, asOf: "2027-12-31", against: "prior_period" });
    expect(cmp.prior).toEqual({ asOf: "2027-11-30" });
  });

  /* ----------------------------------------------------- common size ----- */

  it("expresses every profit-and-loss line as a proportion of revenue that adds to 10,000 basis points", async () => {
    const size = await commonSize({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31" });
    const pl = size.profitAndLoss;
    expect(pl.computable).toBe(true);
    expect(pl.baseMinor).toBe("3600000");

    const revenue = pl.sections.find((s) => s.key === "revenue")!;
    expect(revenue.totalBps).toBe(10_000);
    expect(revenue.lines.reduce((a, l) => a + (l.bps ?? 0), 0)).toBe(10_000);

    // Cost of sales is a proportion of revenue and has no reason to come to any
    // particular figure, but its own lines must still add to its own total.
    const cos = pl.sections.find((s) => s.key === "cost_of_sales")!;
    expect(cos.totalBps).toBe(3333);
    expect(cos.lines.reduce((a, l) => a + (l.bps ?? 0), 0)).toBe(3333);
  });

  it("expresses every balance-sheet line as a proportion of total assets that adds to 10,000 basis points", async () => {
    const size = await commonSize({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31" });
    const bs = size.balanceSheet;
    expect(bs.baseMinor).toBe("12180000");

    const assets = bs.sections.find((s) => s.key === "assets")!;
    expect(assets.totalBps).toBe(10_000);
    expect(assets.lines.reduce((a, l) => a + (l.bps ?? 0), 0)).toBe(10_000);

    const liabilities = bs.sections.find((s) => s.key === "liabilities")!;
    const equity = bs.sections.find((s) => s.key === "equity")!;
    expect((liabilities.totalBps ?? 0) + (equity.totalBps ?? 0)).toBe(10_000);
    expect(liabilities.lines.reduce((a, l) => a + (l.bps ?? 0), 0)).toBe(liabilities.totalBps);
    expect(equity.lines.reduce((a, l) => a + (l.bps ?? 0), 0)).toBe(equity.totalBps);
  });

  it("withholds every proportion when there is no revenue to be a proportion of", async () => {
    const size = await commonSize({ orgId: ORG, entityId: ENT, from: "2027-04-01", to: "2027-04-30" });
    expect(size.profitAndLoss.computable).toBe(false);
    expect(size.profitAndLoss.baseMinor).toBe("0");
    expect(size.profitAndLoss.note).toMatch(/no revenue/i);
    expect(size.profitAndLoss.sections.every((s) => s.totalBps === null)).toBe(true);
    expect(size.profitAndLoss.memos.every((m) => m.bps === null)).toBe(true);
  });

  /* ---------------------------------------------------------- ratios ----- */

  it("returns every ratio an accountant asks for", async () => {
    const set = await ratios({ orgId: ORG, entityId: ENT, asOf: "2027-12-31" });
    const keys = set.ratios.map((r) => r.key);
    for (const key of [
      "current", "quick", "gearing", "interest_cover", "gross_margin", "net_margin",
      "return_on_capital_employed", "receivable_days", "payable_days", "inventory_days",
      "cash_conversion_cycle",
    ]) {
      expect(keys).toContain(key);
    }
    // The flow figures default to the twelve months ending at the date asked for.
    expect(set.from).toBe("2027-01-01");
    expect(set.days).toBe(365);
  });

  it("hands back the numerator and the denominator of every ratio, and they reconstruct it", async () => {
    const set = await ratios({ orgId: ORG, entityId: ENT, asOf: "2027-12-31" });
    for (const r of set.ratios) {
      expect(r.numerator.label.length).toBeGreaterThan(0);
      expect(r.denominator.label.length).toBeGreaterThan(0);
      expect(r.basis.length).toBeGreaterThan(0);
      expect(r.interpretation.length).toBeGreaterThan(0);
    }

    // A quotient can be checked from its own two terms and its day multiplier.
    for (const r of set.ratios.filter((x) => x.op === "divide" && x.computable)) {
      const numerator = BigInt(r.numerator.value!) * BigInt(r.factor) * 10_000n;
      expect(Number(numerator / BigInt(r.denominator.value!))).toBe(r.valueBps);
    }

    // And the one that is a difference rather than a quotient.
    const cycle = set.ratios.find((r) => r.key === "cash_conversion_cycle")!;
    expect(cycle.op).toBe("less");
    expect(Number(BigInt(cycle.numerator.value!) - BigInt(cycle.denominator.value!))).toBe(cycle.valueBps);
  });

  it("computes the figures a lender reads first", async () => {
    const set = await ratios({ orgId: ORG, entityId: ENT, asOf: "2027-12-31" });
    const by = new Map(set.ratios.map((r) => [r.key, r]));

    expect(by.get("current")!.valueBps).toBe(609_000);           // 12,180,000 ÷ 200,000
    expect(by.get("quick")!.valueBps).toBe(569_000);             // stock excluded
    expect(by.get("gross_margin")!.valueBps).toBe(6666);
    expect(by.get("net_margin")!.valueBps).toBe(4250);
    // Profit before interest and tax is 1,530,000 + 100,000 of interest.
    expect(by.get("interest_cover")!.numerator.value).toBe("1630000");
    expect(by.get("interest_cover")!.valueBps).toBe(163_000);
    // Capital employed is total assets less what falls due within the year.
    expect(by.get("return_on_capital_employed")!.denominator.value).toBe("11980000");
    expect(by.get("return_on_capital_employed")!.valueBps).toBe(1360);
  });

  it("measures the working-capital cycle from its three legs", async () => {
    const set = await ratios({ orgId: ORG, entityId: ENT, asOf: "2027-12-31" });
    const by = new Map(set.ratios.map((r) => [r.key, r]));
    expect(by.get("receivable_days")!.valueBps).toBe(608_333);   // 60.83 days
    expect(by.get("payable_days")!.valueBps).toBe(608_333);
    expect(by.get("inventory_days")!.valueBps).toBe(1_216_666);  // 121.67 days
    expect(by.get("cash_conversion_cycle")!.valueBps).toBe(1_216_666);
    expect(by.get("receivable_days")!.factor).toBe(365);
  });

  it("leaves a ratio with a nil denominator undefined rather than zero", async () => {
    // At the end of 2026 nothing was owed within the year, so there is no
    // denominator for the liquidity ratios. That is a fact about the company,
    // not a value of nought.
    const set = await ratios({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
    const by = new Map(set.ratios.map((r) => [r.key, r]));

    expect(by.get("current")!.denominator.value).toBe("0");
    expect(by.get("current")!.valueBps).toBeNull();
    expect(by.get("current")!.valueBps).not.toBe(0);
    expect(by.get("current")!.computable).toBe(false);
    expect(by.get("current")!.undefinedReason).toMatch(/nil/i);
    expect(by.get("quick")!.valueBps).toBeNull();
    // The prior year traded, so the margins are still there to read.
    expect(by.get("gross_margin")!.valueBps).toBe(6000);
  });

  /* ----------------------------------------------------------- trend ----- */

  it("shows revenue, gross profit, net profit and cash month by month", async () => {
    const series = await trend({ orgId: ORG, entityId: ENT, months: 12, to: "2027-12-31" });
    expect(series.months).toHaveLength(12);
    expect(series.months[0].month).toBe("2027-01");
    expect(series.months[11].month).toBe("2027-12");
    expect(series.months.every((m) => m.partial === false)).toBe(true);

    const march = series.months.find((m) => m.month === "2027-03")!;
    expect(march.revenueMinor).toBe("3000000");
    expect(march.grossProfitMinor).toBe("2000000");

    const december = series.months.find((m) => m.month === "2027-12")!;
    expect(december.revenueMinor).toBe("600000");
    expect(december.cashMinor).toBe("10780000");
  });

  it("makes a fall visible without arithmetic, and gives no rate for the first month", async () => {
    const series = await trend({ orgId: ORG, entityId: ENT, months: 12, to: "2027-12-31" });
    expect(series.months[0].revenueMovementMinor).toBeNull();
    expect(series.months[0].revenueMovementReason).toBe("no_comparative");

    const april = series.months.find((m) => m.month === "2027-04")!;
    expect(april.revenueMovementMinor).toBe("-3000000");
    expect(april.revenueMovementBps).toBe(-10_000);
  });

  it("refuses a trend longer than anybody can read", async () => {
    await expect(trend({ orgId: ORG, entityId: ENT, months: 240, to: "2027-12-31" })).rejects.toThrow(/1 and 60 months/i);
  });

  /* ---------------------------------------------------------- layout ----- */

  it("draws a saved layout for both periods through the same renderer", async () => {
    const layout: LayoutInput = {
      code: "MGMT",
      name: "Management pack",
      basis: "PROFIT",
      rows: [
        { key: "rev", label: "Revenue", kind: "accounts", from: "4000", to: "4999", invert: true },
        { key: "cos", label: "Cost of sales", kind: "accounts", from: "5000", to: "5999", invert: true },
        { key: "gp", label: "Gross profit", kind: "total", of: ["rev", "cos"], bold: true },
      ],
    };
    const cmp = await comparativeLayout({
      orgId: ORG, entityId: ENT, layout, from: "2027-01-01", to: "2027-12-31", against: "prior_year",
    });
    expect(cmp.rows).toHaveLength(3);
    expect(cmp.prior).toEqual({ from: "2026-01-01", to: "2026-12-31" });

    const gross = cmp.rows.find((r) => r.key === "gp")!;
    expect(gross.figures!.currentMinor).toBe("2400000");
    expect(gross.figures!.priorMinor).toBe("1200000");
    expect(gross.figures!.movementMinor).toBe("1200000");
    expect(gross.figures!.movementBps).toBe(10_000);
  });

  /* --------------------------------------------------------- refusals ---- */

  it("refuses a period that ends before it starts", async () => {
    await expect(
      comparativeProfitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-12-31", to: "2027-01-01" }),
    ).rejects.toThrow(/ends before it starts/i);
    await expect(
      comparativeProfitAndLoss({
        orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31",
        against: { from: "2026-12-31", to: "2026-01-01" },
      }),
    ).rejects.toThrow(/ends before it starts/i);
  });

  it("refuses a date that is not a date", async () => {
    await expect(
      comparativeBalanceSheet({ orgId: ORG, entityId: ENT, asOf: "the end of last year" }),
    ).rejects.toThrow(/valid date/i);
  });

  it("is scoped to the organisation as well as to the entity", async () => {
    await expect(
      comparativeProfitAndLoss({ orgId: "t-org-cmp-other", entityId: ENT, from: "2027-01-01", to: "2027-12-31" }),
    ).rejects.toThrow(/no ledger/i);
    await expect(
      comparativeProfitAndLoss({ orgId: ORG, entityId: "t-ent-cmp-other", from: "2027-01-01", to: "2027-12-31" }),
    ).rejects.toThrow(/no ledger/i);
  });
});
