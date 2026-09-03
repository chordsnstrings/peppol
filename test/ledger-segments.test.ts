import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post, reverse } from "@/lib/server/ledger/post";
import { profitAndLoss, balanceSheet } from "@/lib/server/ledger/statements";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { createDimension } from "@/lib/server/ledger/dimensions";
import {
  NOT_ALLOCATED,
  OTHER_SEGMENTS,
  segmentReport,
  segmentBalanceSheet,
  segmentTrend,
} from "@/lib/server/ledger/segments";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-seg";
const ENT = "t-ent-seg";

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
    db.$executeRawUnsafe(`DELETE FROM "DimensionValue" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Dimension" WHERE "orgId" = '${ORG}'`),
  ]);
}

type L = { account: string; debit?: number; credit?: number; dimensions?: Record<string, string> };
const P = (entryDate: string, lines: L[], memo = "") =>
  post({ orgId: ORG, entityId: ENT, entryDate, memo, source: "manual", lines });

/** Tag a line with a segment. */
const S = (v: string) => ({ SEGMENT: v });

/** Revenue banked, optionally against a segment. */
const sale = (date: string, amount: number, segment?: string, memo = "Sales") =>
  P(date, [
    { account: "1010", debit: amount },
    { account: "4000", credit: amount, ...(segment ? { dimensions: S(segment) } : {}) },
  ], memo);

/** Cost paid from the bank, optionally against a segment. */
const spend = (date: string, account: string, amount: number, segment?: string, memo = "Cost") =>
  P(date, [
    { account, debit: amount, ...(segment ? { dimensions: S(segment) } : {}) },
    { account: "1010", credit: amount },
  ], memo);

const SEG = { orgId: ORG, entityId: ENT, dimensionCode: "SEGMENT" };

d("segment reporting (IFRS 8)", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    await createDimension({
      orgId: ORG,
      code: "SEGMENT",
      name: "Operating segment",
      values: [
        { code: "RETAIL", name: "Retail" },
        { code: "WHOLESALE", name: "Wholesale" },
        { code: "ONLINE", name: "Online" },
      ],
    });
    // A second axis, so the report has to prove it reads the one it was asked
    // for and not "whatever tag happened to be on the line".
    await createDimension({ orgId: ORG, code: "REGION", name: "Region", values: [{ code: "DXB", name: "Dubai" }] });

    await P("2026-01-05", [{ account: "1010", debit: 5_000_000 }, { account: "3000", credit: 5_000_000 }], "Share capital");

    // ── February. Designed so that ONLINE is below all three IFRS 8.13
    // thresholds and the 75% coverage rule in IFRS 8.15 has to promote it:
    // 2,000,000 of revenue carries no segment at all, which is what pushes the
    // two reportable segments under three quarters of the entity's revenue.
    await sale("2026-02-03", 5_000_000, "RETAIL");
    await sale("2026-02-04", 2_000_000, "WHOLESALE");
    await sale("2026-02-05", 700_000, "ONLINE");
    await sale("2026-02-06", 2_000_000, undefined, "Sales, segment not recorded");
    await spend("2026-02-10", "5000", 3_000_000, "RETAIL", "Cost of goods sold");
    await spend("2026-02-11", "5000", 1_200_000, "WHOLESALE", "Cost of goods sold");
    await spend("2026-02-12", "6000", 1_000_000, "RETAIL", "Salaries");
    await spend("2026-02-13", "6100", 400_000, "WHOLESALE", "Rent");
    await spend("2026-02-14", "6200", 650_000, "ONLINE", "Marketing");
    await spend("2026-02-15", "6900", 300_000, undefined, "Sundry costs");
    // The one balance-sheet posting anybody bothered to code — see the note on
    // segmentBalanceSheet about why there is usually not even one.
    await P("2026-02-27", [
      { account: "1300", debit: 60_000, dimensions: S("RETAIL") },
      { account: "1010", credit: 60_000 },
    ], "Prepaid insurance");

    // ── March. The same trading without the uncoded revenue, so the coverage
    // rule is satisfied without promoting anything and ONLINE falls into
    // "Other segments".
    await sale("2026-03-03", 5_000_000, "RETAIL");
    await sale("2026-03-04", 2_000_000, "WHOLESALE");
    await sale("2026-03-05", 700_000, "ONLINE");
    await spend("2026-03-10", "5000", 3_000_000, "RETAIL", "Cost of goods sold");
    await spend("2026-03-11", "5000", 1_200_000, "WHOLESALE", "Cost of goods sold");
    await spend("2026-03-12", "6000", 1_000_000, "RETAIL", "Salaries");
    await spend("2026-03-13", "6100", 360_000, "WHOLESALE", "Rent");
    await spend("2026-03-14", "6200", 650_000, "ONLINE", "Marketing");
    await spend("2026-03-15", "6900", 300_000, undefined, "Sundry costs");
    // Accrued, not paid — a liability carrying a segment, so the segment
    // balance sheet has something on both sides to prove.
    await P("2026-03-20", [
      { account: "6150", debit: 40_000, dimensions: S("WHOLESALE") },
      { account: "2050", credit: 40_000, dimensions: S("WHOLESALE") },
    ], "Accrued utilities");

    // ── April. WHOLESALE loses money, which is what makes IFRS 8.13(b)'s
    // "greater, in absolute amount, of combined profit and combined loss" do
    // something a netted total would not.
    await sale("2026-04-03", 1_000_000, "RETAIL");
    await sale("2026-04-04", 500_000, "WHOLESALE");
    await sale("2026-04-05", 100_000, "ONLINE");
    await spend("2026-04-10", "5000", 200_000, "RETAIL", "Cost of goods sold");
    await spend("2026-04-11", "6100", 700_000, "WHOLESALE", "Rent");
    await spend("2026-04-12", "6200", 20_000, "ONLINE", "Marketing");

    // ── May. Nothing but a cost nobody coded, tagged on the other dimension
    // only: carrying REGION is not carrying SEGMENT.
    await P("2026-05-06", [
      { account: "6900", debit: 100_000, dimensions: { REGION: "DXB" } },
      { account: "1010", credit: 100_000 },
    ], "Sundry costs, region only");

    // ── June. Raised in error and reversed. Nothing else touches June, so the
    // pair has to net out of ONLINE rather than counting once.
    const wrong = await sale("2026-06-10", 400_000, "ONLINE", "Sales, raised in error");
    await reverse({ orgId: ORG, entryId: wrong.id });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  const FEB = { ...SEG, from: "2026-02-01", to: "2026-02-28" };
  const MAR = { ...SEG, from: "2026-03-01", to: "2026-03-31" };
  const APR = { ...SEG, from: "2026-04-01", to: "2026-04-30" };
  const YEAR = { ...SEG, from: "2026-01-01", to: "2026-12-31" };

  const col = (r: Awaited<ReturnType<typeof segmentReport>>, measure: string, key: string) =>
    r.measures.find((m) => m.key === measure)!.byColumn[key];
  const seg = (r: Awaited<ReturnType<typeof segmentReport>>, key: string) => r.segments.find((s) => s.key === key)!;

  it("adds every column, including Not allocated, back to the entity's profit and loss", async () => {
    const r = await segmentReport(MAR);
    const control = await profitAndLoss({ orgId: ORG, entityId: ENT, from: MAR.from, to: MAR.to });

    expect(r.reconciles).toBe(true);
    expect(r.differenceMinor).toBe("0");
    expect(r.reconciliation.differencesMinor).toEqual({ revenue: "0", costOfSales: "0", expenses: "0", result: "0" });
    expect(r.reconciliation.controlNetProfitMinor).toBe(control.netProfitMinor);

    // Added up here rather than trusted: every printed column, summed by hand,
    // against the statement the entity files.
    const summed = (measure: string) =>
      r.columns.reduce((a, c) => a + BigInt(col(r, measure, c.key)), 0n).toString();
    expect(summed("revenue")).toBe(control.revenue.totalMinor);
    expect(summed("cost_of_sales")).toBe(control.costOfSales.totalMinor);
    expect(summed("expenses")).toBe(control.expenses.totalMinor);
    expect(summed("result")).toBe(control.netProfitMinor);
    expect(control.netProfitMinor).toBe("1150000");
  });

  it("holds the uncoded postings in the Not allocated column, and nowhere else", async () => {
    const r = await segmentReport(MAR);
    const notAllocated = r.columns.find((c) => c.isUnallocated)!;

    expect(notAllocated.key).toBe(NOT_ALLOCATED);
    expect(notAllocated.label).toBe("Not allocated");
    expect(notAllocated.reportable).toBe(false);
    // Last, so it reads as the residual it is.
    expect(r.columns[r.columns.length - 1].key).toBe(NOT_ALLOCATED);

    // 300,000 of sundry cost nobody coded — all of it here, none of it in the
    // segments and none of it folded into "Other segments".
    expect(col(r, "expenses", NOT_ALLOCATED)).toBe("300000");
    expect(col(r, "result", NOT_ALLOCATED)).toBe("-300000");
    expect(col(r, "revenue", NOT_ALLOCATED)).toBe("0");
    expect(col(r, "expenses", OTHER_SEGMENTS)).toBe("650000");
    expect(seg(r, "RETAIL").expensesMinor).toBe("1000000");
  });

  it("keeps the Not allocated column when it is empty, rather than making the reader infer it", async () => {
    const r = await segmentReport(APR);
    // Everything in April carries a segment. The column still has to be there.
    expect(r.columns.some((c) => c.isUnallocated)).toBe(true);
    expect(col(r, "revenue", NOT_ALLOCATED)).toBe("0");
    expect(col(r, "result", NOT_ALLOCATED)).toBe("0");
    expect(r.reconciles).toBe(true);
  });

  it("presents revenue and costs on their natural side, positive, as the statements do", async () => {
    const r = await segmentReport(MAR);
    expect(col(r, "revenue", "RETAIL")).toBe("5000000");
    expect(col(r, "cost_of_sales", "RETAIL")).toBe("3000000");
    expect(col(r, "gross_profit", "RETAIL")).toBe("2000000");
    expect(col(r, "expenses", "RETAIL")).toBe("1000000");
    expect(col(r, "result", "RETAIL")).toBe("1000000");
    // Cost of sales is the 5xxx block and does not leak into operating expenses.
    expect(col(r, "cost_of_sales", "WHOLESALE")).toBe("1200000");
    expect(col(r, "expenses", "WHOLESALE")).toBe("400000");
    expect(col(r, "result", "WHOLESALE")).toBe("400000");
  });

  it("applies the IFRS 8.13 thresholds, and fails the segment they were designed to fail", async () => {
    const r = await segmentReport(MAR);

    // Combined revenue of the operating segments — Not allocated is not one.
    expect(r.thresholds.combinedRevenueMinor).toBe("7700000");
    const retail = seg(r, "RETAIL");
    const wholesale = seg(r, "WHOLESALE");
    const online = seg(r, "ONLINE");

    expect(retail.test.revenuePasses).toBe(true);
    expect(retail.test.reportable).toBe(true);
    expect(wholesale.test.revenuePasses).toBe(true);
    // 700,000 against a 770,000 bar: below all three, and stated three times.
    expect(online.test.revenueShareBps).toBe("909");
    expect(online.test.revenuePasses).toBe(false);
    expect(online.test.resultPasses).toBe(false);
    expect(online.test.assetsPasses).toBe(false);
    expect(online.test.quantitativeThresholdMet).toBe(false);
    expect(online.test.reportable).toBe(false);
    expect(online.test.basis).toMatch(/IFRS 8\.13/);

    // The one coded balance-sheet posting makes RETAIL 100% of segment assets.
    expect(r.thresholds.combinedAssetsMinor).toBe("60000");
    expect(retail.test.assetsPasses).toBe(true);
    expect(wholesale.test.assetsPasses).toBe(false);
  });

  it("measures the result threshold on the greater of combined profit and combined loss", async () => {
    const r = await segmentReport(APR);
    // WHOLESALE lost 200,000 while RETAIL and ONLINE made 800,000 and 80,000.
    expect(seg(r, "WHOLESALE").resultMinor).toBe("-200000");
    expect(r.thresholds.combinedProfitMinor).toBe("880000");
    expect(r.thresholds.combinedLossMinor).toBe("200000");
    expect(r.thresholds.resultBasisMinor).toBe("880000");

    // A loss-making segment is reportable on the absolute amount of its result:
    // 200,000 is more than a tenth of 880,000.
    expect(seg(r, "WHOLESALE").test.resultPasses).toBe(true);
    // And ONLINE is not: 80,000 is under 88,000. Had the two been netted to
    // 680,000 the bar would have been 68,000 and ONLINE would have passed,
    // which is exactly the outcome IFRS 8.13(b) is written to prevent.
    expect(seg(r, "ONLINE").resultMinor).toBe("80000");
    expect(seg(r, "ONLINE").test.resultPasses).toBe(false);
  });

  it("aggregates the segments below every threshold into Other segments (IFRS 8.16)", async () => {
    const r = await segmentReport(APR);
    expect(r.columns.map((c) => c.key)).toEqual(["RETAIL", "WHOLESALE", OTHER_SEGMENTS, NOT_ALLOCATED]);
    const other = r.columns.find((c) => c.isOther)!;
    expect(other.label).toBe("Other segments");
    expect(other.reportable).toBe(false);
    expect(col(r, "revenue", OTHER_SEGMENTS)).toBe("100000");
    expect(col(r, "result", OTHER_SEGMENTS)).toBe("80000");
    // Aggregated for presentation, never lost: the segment is still there in
    // full, which is what the threshold table on the screen is drawn from.
    expect(seg(r, "ONLINE").revenueMinor).toBe("100000");
    expect(r.segments.map((s) => s.key)).toEqual(["ONLINE", "RETAIL", "WHOLESALE", NOT_ALLOCATED]);
  });

  it("promotes the next largest segment until the reportable ones cover 75% of revenue (IFRS 8.15)", async () => {
    const r = await segmentReport(FEB);

    // 2,000,000 of February's 9,700,000 revenue carries no segment, so RETAIL
    // and WHOLESALE alone reach only 72.16% and the rule bites.
    expect(r.thresholds.entityRevenueMinor).toBe("9700000");
    expect(r.thresholds.seventyFivePercentApplicable).toBe(true);
    expect(r.thresholds.promoted).toEqual(["ONLINE"]);

    const online = seg(r, "ONLINE");
    expect(online.test.quantitativeThresholdMet).toBe(false);
    expect(online.test.promotedForCoverage).toBe(true);
    expect(online.test.reportable).toBe(true);
    expect(online.test.basis).toMatch(/IFRS 8\.15/);

    // With it, 7,700,000 of 9,700,000 — 79.38%, and no Other segments column,
    // because nothing was left to aggregate.
    expect(r.thresholds.reportableRevenueMinor).toBe("7700000");
    expect(r.thresholds.revenueCoverageBps).toBe("7938");
    expect(r.thresholds.seventyFivePercentMet).toBe(true);
    expect(r.columns.map((c) => c.key)).toEqual(["ONLINE", "RETAIL", "WHOLESALE", NOT_ALLOCATED]);
    expect(r.columns.some((c) => c.isOther)).toBe(false);
    expect(r.reconciles).toBe(true);
  });

  it("does not promote when the coverage is already there", async () => {
    const r = await segmentReport(MAR);
    expect(r.thresholds.promoted).toEqual([]);
    expect(r.thresholds.reportableRevenueMinor).toBe("7000000");
    expect(r.thresholds.seventyFivePercentMet).toBe(true);
    expect(seg(r, "ONLINE").test.promotedForCoverage).toBe(false);
  });

  it("says the coverage test is not applicable rather than failing it, when there is no revenue", async () => {
    const r = await segmentReport({ ...SEG, from: "2026-05-01", to: "2026-05-31" });
    expect(r.thresholds.entityRevenueMinor).toBe("0");
    expect(r.thresholds.seventyFivePercentApplicable).toBe(false);
    expect(r.thresholds.revenueCoverageBps).toBeNull();
    // May's only posting carries REGION, not SEGMENT — a different dimension is
    // not this one, and the cost lands where it belongs.
    expect(col(r, "expenses", NOT_ALLOCATED)).toBe("100000");
    expect(r.reconciles).toBe(true);
  });

  it("nets a reversed entry out of its segment rather than counting it once", async () => {
    const r = await segmentReport({ ...SEG, from: "2026-06-01", to: "2026-06-30" });
    // The original entry stands and its mirror stands beside it. Reading only
    // "posted" would drop the original, keep the reversal, and report ONLINE
    // with negative revenue for the month.
    expect(seg(r, "ONLINE").revenueMinor).toBe("0");
    expect(seg(r, "ONLINE").resultMinor).toBe("0");
    expect(col(r, "revenue", NOT_ALLOCATED)).toBe("0");
    expect(r.measures.find((m) => m.key === "revenue")!.totalMinor).toBe("0");
    expect(r.reconciles).toBe(true);
    expect(r.differenceMinor).toBe("0");
  });

  it("reconciles over a whole year, with the segment detail intact", async () => {
    const r = await segmentReport(YEAR);
    const control = await profitAndLoss({ orgId: ORG, entityId: ENT, from: YEAR.from, to: YEAR.to });
    expect(r.reconciles).toBe(true);
    expect(control.netProfitMinor).toBe("4880000");
    expect(seg(r, "RETAIL").resultMinor).toBe("2800000");
    expect(seg(r, "WHOLESALE").resultMinor).toBe("600000");
    expect(seg(r, "ONLINE").resultMinor).toBe("180000");
    expect(seg(r, NOT_ALLOCATED).resultMinor).toBe("1300000");
    const summed = r.segments.reduce((a, s) => a + BigInt(s.resultMinor), 0n);
    expect(summed.toString()).toBe(control.netProfitMinor);
  });

  it("splits assets and liabilities by segment and ties to the balance sheet", async () => {
    const bs = await segmentBalanceSheet({ ...SEG, asOf: "2026-12-31" });
    const control = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });

    expect(bs.reconciles).toBe(true);
    expect(bs.differenceMinor).toBe("0");
    expect(bs.assets.grandTotalMinor).toBe(control.assets.totalMinor);
    expect(bs.liabilities.grandTotalMinor).toBe(control.liabilities.totalMinor);

    expect(bs.assets.totalMinor.RETAIL).toBe("60000");
    // The bank carries no segment on any line, which is the honest answer and
    // not a gap to be filled in.
    expect(bs.assets.lines.find((l) => l.code === "1010")!.presentedMinor[NOT_ALLOCATED]).toBe("9860000");
    expect(bs.assets.totalMinor[NOT_ALLOCATED]).toBe("9860000");
    // Liabilities are presented on their natural side, positive.
    expect(bs.liabilities.totalMinor.WHOLESALE).toBe("40000");
    expect(bs.liabilities.lines.find((l) => l.code === "2050")!.balanceMinor.WHOLESALE).toBe("-40000");
    // Equity and the profit and loss belong elsewhere.
    expect(bs.assets.lines.some((l) => l.code === "3000")).toBe(false);
    expect(bs.assets.lines.some((l) => l.code === "6100")).toBe(false);
    // The trust number, and the warning that goes with it.
    expect(bs.unallocatedAssetShareBps).toBe("9939");
    expect(bs.warnings.some((w) => /no SEGMENT value/.test(w))).toBe(true);
  });

  it("shows the same figures month by month, so a shrinking segment is visible", async () => {
    const t = await segmentTrend({ ...SEG, periods: 3, to: "2026-04-30" });
    expect(t.periods.map((p) => p.label)).toEqual(["2026-02", "2026-03", "2026-04"]);
    expect(t.periods[0].revenueMinor.RETAIL).toBe("5000000");
    expect(t.periods[2].revenueMinor.RETAIL).toBe("1000000");
    expect(t.periods[0].revenueMinor[NOT_ALLOCATED]).toBe("2000000");

    // Nothing is aggregated in a trend: a segment that vanished into "Other"
    // for the months it was shrinking is the thing this report exists to show.
    expect(t.columns.map((c) => c.key)).toEqual(["ONLINE", "RETAIL", "WHOLESALE", NOT_ALLOCATED]);

    const online = t.series.find((s) => s.key === "ONLINE")!;
    expect(online.firstRevenueMinor).toBe("700000");
    expect(online.lastRevenueMinor).toBe("100000");
    expect(online.revenueChangeMinor).toBe("-600000");
    expect(online.revenueChangeBps).toBe("-8571");
    expect(online.shrinking).toBe(true);

    // Every month is reconciled on its own, so one bad month cannot be averaged
    // into a year that happens to tie.
    expect(t.periods.every((p) => p.reconciles)).toBe(true);
    expect(t.reconciles).toBe(true);
    expect(t.unreconciledPeriods).toEqual([]);
  });

  it("refuses a trend over a number of months nobody reads", async () => {
    await expect(segmentTrend({ ...SEG, periods: 0, to: "2026-04-30" })).rejects.toThrow(/1 to 60 months/);
    await expect(segmentTrend({ ...SEG, periods: 61, to: "2026-04-30" })).rejects.toThrow(/1 to 60 months/);
  });

  it("refuses an unknown dimension, naming the ones this organisation does have", async () => {
    await expect(segmentReport({ ...YEAR, dimensionCode: "BRANCH" })).rejects.toThrow(/no BRANCH dimension/i);
    // The refusal is only useful if it says where to look instead.
    await expect(segmentReport({ ...YEAR, dimensionCode: "BRANCH" }))
      .rejects.toThrow(/SEGMENT \(Operating segment\)/);
    await expect(segmentBalanceSheet({ ...SEG, dimensionCode: "BRANCH", asOf: "2026-12-31" }))
      .rejects.toThrow(/REGION \(Region\)/);
    await expect(segmentTrend({ ...SEG, dimensionCode: "BRANCH", periods: 3, to: "2026-04-30" }))
      .rejects.toThrow(/no BRANCH dimension/i);
  });

  it("refuses a period that ends before it starts, as the statements do", async () => {
    await expect(segmentReport({ ...SEG, from: "2026-03-31", to: "2026-03-01" }))
      .rejects.toThrow(/ends before it starts/i);
    await expect(segmentReport({ ...SEG, from: "31-03-2026", to: "2026-03-31" }))
      .rejects.toThrow(/YYYY-MM-DD/);
  });

  it("reports the same segments on a second dimension over the same postings", async () => {
    const r = await segmentReport({ ...YEAR, dimensionCode: "REGION" });
    expect(r.reconciles).toBe(true);
    expect(r.dimensionName).toBe("Region");
    // Only the May cost was ever tagged with a region; everything else says so.
    expect(seg(r, "DXB").expensesMinor).toBe("100000");
    expect(col(r, "revenue", NOT_ALLOCATED)).toBe("19000000");
  });
});
