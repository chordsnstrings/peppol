import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post, reverse } from "@/lib/server/ledger/post";
import { profitAndLoss, balanceSheet } from "@/lib/server/ledger/statements";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-fs";
const ENT = "t-ent-fs";

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

const P = (entryDate: string, lines: { account: string; debit?: number; credit?: number }[], memo = "") =>
  post({ orgId: ORG, entityId: ENT, entryDate, memo, source: "manual", lines });

d("financial statements", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // Capital in.
    await P("2026-01-05", [{ account: "1010", debit: 5_000_000 }, { account: "3000", credit: 5_000_000 }], "Share capital");
    // Sales and the cost of making them.
    await P("2026-02-10", [{ account: "1010", debit: 1_200_000 }, { account: "4000", credit: 1_200_000 }], "Sales");
    await P("2026-02-12", [{ account: "5000", debit: 500_000 }, { account: "1010", credit: 500_000 }], "Cost of goods sold");
    // Running the business.
    await P("2026-02-20", [{ account: "6100", debit: 150_000 }, { account: "1010", credit: 150_000 }], "Rent");
    await P("2026-02-25", [{ account: "6000", debit: 250_000 }, { account: "1010", credit: 250_000 }], "Salaries");
    // Something owed at the period end.
    await P("2026-02-28", [{ account: "6150", debit: 40_000 }, { account: "2050", credit: 40_000 }], "Accrued utilities");
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("shows revenue as a positive figure, not as the credit the ledger holds", async () => {
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-02-28" });
    const sales = pl.revenue.lines.find((l) => l.code === "4000")!;
    expect(sales.presentedMinor).toBe("1200000");
    expect(sales.balanceMinor).toBe("-1200000"); // the ledger's own sign, unchanged
    expect(pl.revenue.totalMinor).toBe("1200000");
  });

  it("separates cost of sales from operating expenses", async () => {
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-02-28" });
    expect(pl.costOfSales.totalMinor).toBe("500000");
    expect(pl.grossProfitMinor).toBe("700000");
    // Rent + salaries + accrued utilities.
    expect(pl.expenses.totalMinor).toBe("440000");
    expect(pl.netProfitMinor).toBe("260000");
  });

  it("computes the gross margin exactly, in basis points", async () => {
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-02-28" });
    expect(pl.grossMarginBps).toBe(5833); // 700,000 / 1,200,000
  });

  it("reports no margin rather than a division by zero when there is no revenue", async () => {
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-04-01", to: "2026-04-30" });
    expect(pl.grossMarginBps).toBeNull();
    expect(pl.netProfitMinor).toBe("0");
  });

  it("excludes capital from the profit and loss", async () => {
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-02-28" });
    expect(pl.revenue.lines.find((l) => l.code === "3000")).toBeUndefined();
  });

  it("balances", async () => {
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-02-28" });
    expect(bs.balanced).toBe(true);
    expect(bs.differenceMinor).toBe("0");
  });

  it("carries the year's profit into equity, which is what makes it balance", async () => {
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-02-28" });
    // Cash: 5,000,000 + 1,200,000 − 500,000 − 150,000 − 250,000 = 5,300,000.
    expect(bs.totalAssetsMinor).toBe("5300000");
    // Capital 5,000,000 + profit 260,000, plus the 40,000 accrual = 5,300,000.
    expect(bs.currentYearEarningsMinor).toBe("260000");
    expect(bs.liabilities.totalMinor).toBe("40000");
    expect(bs.equity.totalMinor).toBe("5260000");
    expect(bs.totalLiabilitiesAndEquityMinor).toBe("5300000");
    // And it appears as a line a reader can see, not just as an adjustment.
    expect(bs.equity.lines.find((l) => l.code === "3950")?.presentedMinor).toBe("260000");
  });

  it("shows liabilities as positive amounts owed", async () => {
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-02-28" });
    const accrual = bs.liabilities.lines.find((l) => l.code === "2050")!;
    expect(accrual.presentedMinor).toBe("40000");
    expect(accrual.balanceMinor).toBe("-40000");
  });

  it("still balances after a loss-making period", async () => {
    await P("2026-03-15", [{ account: "6900", debit: 900_000 }, { account: "1010", credit: 900_000 }], "A bad month");
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-03-31" });
    expect(bs.balanced).toBe(true);
    // 260,000 profit less a 900,000 expense.
    expect(bs.currentYearEarningsMinor).toBe("-640000");
  });

  it("omits accounts that have netted to zero", async () => {
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-03-31" });
    expect(bs.assets.lines.every((l) => l.presentedMinor !== "0")).toBe(true);
  });

  it("includes the period still running, not only the ones that have closed", async () => {
    // The bug this pins: reading only fully-elapsed periods means a balance
    // sheet "as at today" omits the whole current month — the month anyone
    // actually asks about. 15 March is mid-period.
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-03-20" });
    // The 900,000 posted on 15 March must be in it.
    expect(bs.currentYearEarningsMinor).toBe("-640000");
    expect(bs.balanced).toBe(true);
  });

  it("stops at the as-at date rather than swallowing the rest of the period", async () => {
    // A cut-off before the 15 March posting must exclude it, even though both
    // dates fall inside the same accounting period.
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-03-10" });
    expect(bs.currentYearEarningsMinor).toBe("260000"); // February's result only
    expect(bs.balanced).toBe(true);
  });

  it("measures a profit and loss between two mid-period dates", async () => {
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: "2026-03-31" });
    expect(pl.expenses.totalMinor).toBe("900000");
    expect(pl.revenue.totalMinor).toBe("0");
    expect(pl.netProfitMinor).toBe("-900000");
  });

  it("excludes a posting that falls just after the cut-off", async () => {
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: "2026-03-14" });
    expect(pl.expenses.totalMinor).toBe("0");
  });

  it("treats a reversed entry and its reversal consistently mid-period", async () => {
    // A reversed entry's lines are real postings that happened; the separate
    // reversing entry offsets them. Counting only "posted" would drop the
    // original while keeping the reversal, so a statement cut mid-period would
    // be wrong by exactly the reversal — and in the wrong direction, since only
    // the offsetting half survived.
    // The cut-off has to fall INSIDE the period, or the read takes the cached
    // path where both halves are already netted and the bug cannot show.
    const CUT = "2026-03-25";
    const before = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: CUT });

    const e = await P("2026-03-20", [{ account: "6900", debit: 77_000 }, { account: "1010", credit: 77_000 }], "Booked in error");
    const withEntry = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: CUT });
    expect(BigInt(withEntry.expenses.totalMinor) - BigInt(before.expenses.totalMinor)).toBe(77_000n);

    await reverse({ orgId: ORG, entryId: e.id, entryDate: "2026-03-21", memo: "Reversing" });
    const after = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: CUT });
    // Back to where it started: the pair nets to nothing.
    expect(after.expenses.totalMinor).toBe(before.expenses.totalMinor);

    // And the balance sheet, read at the same mid-period date, still balances.
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: CUT });
    expect(bs.balanced).toBe(true);
  });

  it("balances at a date beyond every fiscal year", async () => {
    // 2027 has no fiscal year in this fixture. Deriving current-year earnings
    // from a FiscalYear row means it silently reads zero while the assets and
    // equity read the whole elapsed ledger — so the sheet reports itself
    // unbalanced, and the screen tells the reader to report a defect that is
    // not in their data.
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2027-06-30" });
    expect(bs.balanced).toBe(true);
    expect(bs.differenceMinor).toBe("0");
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-03-31", to: "2026-03-01" }))
      .rejects.toThrow(/ends before it starts/i);
  });
});
