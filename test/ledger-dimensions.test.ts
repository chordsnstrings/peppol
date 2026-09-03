import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post, reverse } from "@/lib/server/ledger/post";
import { profitAndLoss } from "@/lib/server/ledger/statements";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import {
  UNALLOCATED,
  createDimension,
  addValue,
  listDimensions,
  requireDimensionOn,
  dimensionalProfitAndLoss,
  dimensionSummary,
  dimensionalTrialBalance,
} from "@/lib/server/ledger/dimensions";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-dim";
const ENT = "t-ent-dim";

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

const CC = (v: string) => ({ COST_CENTRE: v });

d("dimensions and cost-centre reporting", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    await createDimension({
      orgId: ORG,
      code: "COST_CENTRE",
      name: "Cost centre",
      values: [
        { code: "OPS", name: "Operations" },
        { code: "SALES", name: "Sales" },
        { code: "ADMIN", name: "Administration" },
      ],
    });
    // A second dimension, so the report has to prove it reads one axis and not
    // "whatever tag happened to be on the line".
    await createDimension({ orgId: ORG, code: "PROJECT", name: "Project", values: [{ code: "SITE_A", name: "Site A" }] });

    // ── February: the fixture every arithmetic assertion below is measured on.
    await P("2026-01-05", [{ account: "1010", debit: 5_000_000 }, { account: "3000", credit: 5_000_000 }], "Share capital");
    await P("2026-02-10", [
      { account: "1010", debit: 1_200_000 },
      { account: "4000", credit: 1_200_000, dimensions: CC("SALES") },
    ], "Sales");
    await P("2026-02-12", [
      { account: "5000", debit: 500_000, dimensions: CC("SALES") },
      { account: "1010", credit: 500_000 },
    ], "Cost of goods sold");
    await P("2026-02-15", [
      { account: "6100", debit: 150_000, dimensions: CC("OPS") },
      { account: "1010", credit: 150_000 },
    ], "Rent");
    await P("2026-02-20", [
      { account: "6000", debit: 250_000, dimensions: CC("ADMIN") },
      { account: "1010", credit: 250_000 },
    ], "Salaries");
    // Nobody said where this belongs. It must show up as Unallocated.
    await P("2026-02-25", [{ account: "6900", debit: 100_000 }, { account: "1010", credit: 100_000 }], "Sundry costs");
    // Tagged on a different dimension only — for COST_CENTRE this is unallocated.
    await P("2026-02-26", [
      { account: "6150", debit: 40_000, dimensions: { PROJECT: "SITE_A" } },
      { account: "2050", credit: 40_000, dimensions: { PROJECT: "SITE_A" } },
    ], "Accrued utilities");
    // A balance-sheet account carrying a cost centre.
    await P("2026-02-27", [
      { account: "1300", debit: 60_000, dimensions: CC("OPS") },
      { account: "1010", credit: 60_000 },
    ], "Prepaid insurance");

    // ── March: for the mid-period cut-off.
    await P("2026-03-15", [
      { account: "6200", debit: 300_000, dimensions: CC("SALES") },
      { account: "1010", credit: 300_000 },
    ], "Marketing");
    await P("2026-03-25", [
      { account: "6300", debit: 90_000, dimensions: CC("OPS") },
      { account: "1010", credit: 90_000 },
    ], "Trade licence");
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  const FEB = { orgId: ORG, entityId: ENT, from: "2026-02-01", to: "2026-02-28", dimensionCode: "COST_CENTRE" };

  it("creates a dimension and its values", async () => {
    const dims = await listDimensions({ orgId: ORG });
    const cc = dims.find((x) => x.code === "COST_CENTRE")!;
    expect(cc.name).toBe("Cost centre");
    expect(cc.values.map((v) => v.code)).toEqual(["ADMIN", "OPS", "SALES"]);
    // Adding a value is separate from creating the dimension, and idempotent.
    await addValue({ orgId: ORG, dimensionCode: "COST_CENTRE", code: "ops", name: "Operations" });
    const again = await listDimensions({ orgId: ORG });
    expect(again.find((x) => x.code === "COST_CENTRE")!.values).toHaveLength(3);
  });

  it("refuses a value code that would collide with the Unallocated column", async () => {
    await expect(addValue({ orgId: ORG, dimensionCode: "COST_CENTRE", code: "UNALLOCATED", name: "Nope" }))
      .rejects.toThrow(/cannot also be a value/i);
    // And a code that would break the dimensionCode:valueCode lookup in post.ts.
    await expect(addValue({ orgId: ORG, dimensionCode: "COST_CENTRE", code: "OPS:X", name: "Nope" }))
      .rejects.toThrow(/letters, digits and underscores/i);
  });

  it("attributes a posting to the value it carries", async () => {
    const pl = await dimensionalProfitAndLoss(FEB);
    const rent = pl.expenses.lines.find((l) => l.code === "6100")!;
    expect(rent.presentedMinor.OPS).toBe("150000");
    expect(rent.presentedMinor.SALES).toBe("0");
    expect(rent.presentedMinor[UNALLOCATED]).toBe("0");
    const sales = pl.revenue.lines.find((l) => l.code === "4000")!;
    expect(sales.presentedMinor.SALES).toBe("1200000");
  });

  it("puts a posting with no value into Unallocated, as a visible column", async () => {
    const pl = await dimensionalProfitAndLoss(FEB);
    const unallocated = pl.columns.find((c) => c.isUnallocated)!;
    expect(unallocated.key).toBe(UNALLOCATED);
    expect(unallocated.label).toBe("Unallocated");
    // Last column, so it reads as the residual it is.
    expect(pl.columns[pl.columns.length - 1].key).toBe(UNALLOCATED);
    // 100,000 sundry with no dimension at all, plus 40,000 tagged only on
    // PROJECT — carrying another dimension is not carrying this one.
    expect(pl.expenses.totalMinor[UNALLOCATED]).toBe("140000");
    expect(pl.expenses.lines.find((l) => l.code === "6900")!.presentedMinor[UNALLOCATED]).toBe("100000");
    expect(pl.expenses.lines.find((l) => l.code === "6150")!.presentedMinor[UNALLOCATED]).toBe("40000");
  });

  it("shows the Unallocated column even when it is empty", async () => {
    // Nothing was posted in May. The column still has to be there: a reader must
    // never have to infer "nothing was unallocated" from a missing column.
    const pl = await dimensionalProfitAndLoss({ ...FEB, from: "2026-05-01", to: "2026-05-31" });
    expect(pl.columns.some((c) => c.isUnallocated)).toBe(true);
    expect(pl.expenses.totalMinor[UNALLOCATED]).toBe("0");
    expect(pl.reconciles).toBe(true);
  });

  it("adds up across every column, including Unallocated, to the real profit and loss", async () => {
    const pl = await dimensionalProfitAndLoss(FEB);
    const control = await profitAndLoss({ orgId: ORG, entityId: ENT, from: FEB.from, to: FEB.to });

    expect(pl.reconciles).toBe(true);
    expect(pl.differenceMinor).toBe("0");
    expect(pl.totalNetProfitMinor).toBe(control.netProfitMinor);
    expect(pl.revenue.grandTotalMinor).toBe(control.revenue.totalMinor);
    expect(pl.costOfSales.grandTotalMinor).toBe(control.costOfSales.totalMinor);
    expect(pl.expenses.grandTotalMinor).toBe(control.expenses.totalMinor);

    // And the columns really do sum to it, added up here rather than trusted.
    const summed = pl.columns.reduce((a, c) => a + BigInt(pl.netProfitMinor[c.key]), 0n);
    expect(summed.toString()).toBe(control.netProfitMinor);
    expect(control.netProfitMinor).toBe("160000");
    expect(pl.netProfitMinor.SALES).toBe("700000");
    expect(pl.netProfitMinor.OPS).toBe("-150000");
    expect(pl.netProfitMinor.ADMIN).toBe("-250000");
    expect(pl.netProfitMinor[UNALLOCATED]).toBe("-140000");
  });

  it("reconciles on a second dimension over the same postings", async () => {
    const pl = await dimensionalProfitAndLoss({ ...FEB, dimensionCode: "PROJECT" });
    expect(pl.reconciles).toBe(true);
    expect(pl.expenses.totalMinor.SITE_A).toBe("40000");
    // Everything else belongs to no project, and says so.
    expect(pl.expenses.totalMinor[UNALLOCATED]).toBe("500000");
    expect(pl.totalNetProfitMinor).toBe("160000");
  });

  it("presents revenue and expenses positive, in the right sections", async () => {
    const pl = await dimensionalProfitAndLoss(FEB);
    const sales = pl.revenue.lines.find((l) => l.code === "4000")!;
    // Presented on its natural side, while the ledger's own sign is untouched.
    expect(sales.presentedMinor.SALES).toBe("1200000");
    expect(sales.balanceMinor.SALES).toBe("-1200000");
    expect(pl.revenue.totalMinor.SALES).toBe("1200000");

    // Cost of sales is the 5xxx block and does not leak into operating expenses.
    expect(pl.costOfSales.lines.map((l) => l.code)).toEqual(["5000"]);
    expect(pl.costOfSales.totalMinor.SALES).toBe("500000");
    expect(pl.expenses.lines.some((l) => l.code === "5000")).toBe(false);
    expect(pl.expenses.lines.find((l) => l.code === "6000")!.presentedMinor.ADMIN).toBe("250000");
    expect(pl.grossProfitMinor.SALES).toBe("700000");
    // Capital is not income, in any column.
    expect(pl.revenue.lines.some((l) => l.code === "3000")).toBe(false);
  });

  it("cuts a mid-period range exactly where profitAndLoss does", async () => {
    // 1–20 March is a partial period at both ends: the 15th is in, the 25th is
    // not, and neither end may swallow the rest of the month.
    const mid = await dimensionalProfitAndLoss({ ...FEB, from: "2026-03-01", to: "2026-03-20" });
    const control = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: "2026-03-20" });
    expect(mid.reconciles).toBe(true);
    expect(mid.differenceMinor).toBe("0");
    expect(mid.expenses.grandTotalMinor).toBe(control.expenses.totalMinor);
    expect(mid.expenses.totalMinor.SALES).toBe("300000");
    expect(mid.expenses.totalMinor.OPS).toBe("0"); // the 25th is outside the range

    const whole = await dimensionalProfitAndLoss({ ...FEB, from: "2026-03-01", to: "2026-03-31" });
    expect(whole.reconciles).toBe(true);
    expect(whole.expenses.totalMinor.OPS).toBe("90000");
  });

  it("refuses a range that ends before it starts, as the statements do", async () => {
    await expect(dimensionalProfitAndLoss({ ...FEB, from: "2026-03-31", to: "2026-03-01" }))
      .rejects.toThrow(/ends before it starts/i);
  });

  it("refuses a dimension nobody has created", async () => {
    await expect(dimensionalProfitAndLoss({ ...FEB, dimensionCode: "BRANCH" }))
      .rejects.toThrow(/no BRANCH dimension/i);
  });

  it("shares out the basis in basis points, with the rounding remainder shown", async () => {
    const s = await dimensionSummary(FEB);
    expect(s.basis).toBe("expenses");
    expect(s.basisTotalMinor).toBe("1040000"); // 540,000 opex + 500,000 cost of sales
    const share = (k: string) => BigInt(s.rows.find((r) => r.key === k)!.shareBps!);
    // Truncated toward zero, so no column is ever overstated: 500,000/1,040,000
    // is 4807.69 bps, reported as 4807.
    expect(share("SALES")).toBe(4807n);
    expect(share("OPS")).toBe(1442n);
    expect(share("ADMIN")).toBe(2403n);
    expect(share(UNALLOCATED)).toBe(1346n);
    // The remainder is what truncation dropped — it is reported, not buried in
    // the largest column. Shares plus the remainder are exactly 10000.
    const summed = s.rows.reduce((a, r) => a + BigInt(r.shareBps ?? "0"), 0n);
    expect(summed).toBe(9998n);
    expect(BigInt(s.roundingRemainderBps)).toBe(2n);
    expect(summed + BigInt(s.roundingRemainderBps)).toBe(10_000n);
    expect(s.reconciles).toBe(true);
  });

  it("sums to exactly 10000 when the basis divides cleanly", async () => {
    const s = await dimensionSummary({ ...FEB, basis: "revenue" });
    const summed = s.rows.reduce((a, r) => a + BigInt(r.shareBps ?? "0"), 0n);
    expect(summed).toBe(10_000n);
    expect(s.rows.find((r) => r.key === "SALES")!.shareBps).toBe("10000");
    expect(BigInt(s.roundingRemainderBps)).toBe(0n);
  });

  it("reports no share rather than dividing by zero", async () => {
    const s = await dimensionSummary({ ...FEB, from: "2026-05-01", to: "2026-05-31" });
    expect(s.basisTotalMinor).toBe("0");
    expect(s.rows.every((r) => r.shareBps === null)).toBe(true);
  });

  it("splits the balance sheet by value and still ties to the trial balance", async () => {
    const tb = await dimensionalTrialBalance({
      orgId: ORG, entityId: ENT, periodLabel: "2026-02", dimensionCode: "COST_CENTRE",
    });
    expect(tb.reconciles).toBe(true);
    expect(tb.differenceMinor).toBe("0");

    // The bank account carries no cost centre on any line, so all of it is
    // unallocated — which is the honest answer, not a gap to be filled in.
    const bank = tb.rows.find((r) => r.code === "1010")!;
    expect(bank.balanceMinor[UNALLOCATED]).toBe("5140000");
    expect(bank.totalMinor).toBe(bank.controlMinor);

    const prepaid = tb.rows.find((r) => r.code === "1300")!;
    expect(prepaid.balanceMinor.OPS).toBe("60000");
    expect(prepaid.totalMinor).toBe("60000");
    // Income and expense accounts belong on the profit and loss, not here.
    expect(tb.rows.some((r) => r.code === "6100")).toBe(false);
  });

  it("filters to one value without switching the reconciliation off", async () => {
    const tb = await dimensionalTrialBalance({
      orgId: ORG, entityId: ENT, periodLabel: "2026-02", dimensionCode: "COST_CENTRE", valueCode: "OPS",
    });
    expect(tb.columns).toHaveLength(1);
    expect(tb.rows.map((r) => r.code)).toEqual(["1300"]);
    // Still checked across every column, not just the one on screen.
    expect(tb.reconciles).toBe(true);
    // And a one-cost-centre trial balance does not balance, because the other
    // side of the entry went to a bank account that carries no cost centre.
    // That is expected, and the report says so rather than hiding it.
    expect(tb.totalDebitMinor.OPS).toBe("60000");
    expect(tb.totalCreditMinor.OPS).toBe("0");
  });

  it("refuses to filter by a value that does not exist", async () => {
    await expect(dimensionalTrialBalance({
      orgId: ORG, entityId: ENT, periodLabel: "2026-02", dimensionCode: "COST_CENTRE", valueCode: "MARKETING",
    })).rejects.toThrow(/no COST_CENTRE value "MARKETING"/i);
  });

  it("refuses an unknown dimension value by name, at posting time", async () => {
    await expect(P("2026-04-05", [
      { account: "6900", debit: 10_000, dimensions: CC("MARKETING") },
      { account: "1010", credit: 10_000 },
      // The refusal names the value as the thing that is wrong, and lists the
      // ones that exist — blaming the dimension here would send someone looking
      // in the wrong place.
    ])).rejects.toThrow(/"MARKETING" is not a value of COST_CENTRE/);
  });

  it("refuses a posting to an account that requires a dimension it does not carry", async () => {
    await requireDimensionOn({ orgId: ORG, entityId: ENT, accountCode: "6250", dimensionCode: "COST_CENTRE" });
    const account = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code: "6250" } });
    expect(account?.requiresDimension).toBe("COST_CENTRE");

    // The refusal comes from post.ts's own requiresDimension check — the guard
    // lives on the posting path, so no report and no importer can go round it.
    await expect(P("2026-04-10", [
      { account: "6250", debit: 75_000 },
      { account: "1010", credit: 75_000 },
    ])).rejects.toThrow("Account 6250 requires a COST_CENTRE.");

    // Carrying a different dimension is not carrying this one.
    await expect(P("2026-04-10", [
      { account: "6250", debit: 75_000, dimensions: { PROJECT: "SITE_A" } },
      { account: "1010", credit: 75_000 },
    ])).rejects.toThrow("Account 6250 requires a COST_CENTRE.");

    // With it, the posting goes through and lands in its column.
    await P("2026-04-10", [
      { account: "6250", debit: 75_000, dimensions: CC("ADMIN") },
      { account: "1010", credit: 75_000 },
    ], "Audit fee");
    const pl = await dimensionalProfitAndLoss({ ...FEB, from: "2026-04-01", to: "2026-04-30" });
    expect(pl.expenses.totalMinor.ADMIN).toBe("75000");
    expect(pl.expenses.totalMinor[UNALLOCATED]).toBe("0");
    expect(pl.reconciles).toBe(true);
  });

  it("refuses to require a dimension that could never be satisfied", async () => {
    await createDimension({ orgId: ORG, code: "BRANCH", name: "Branch" });
    await expect(requireDimensionOn({ orgId: ORG, entityId: ENT, accountCode: "6400", dimensionCode: "BRANCH" }))
      .rejects.toThrow(/has no values yet/i);
    // And a heading is never posted to, so requiring it there would do nothing.
    await expect(requireDimensionOn({ orgId: ORG, entityId: ENT, accountCode: "6", dimensionCode: "COST_CENTRE" }))
      .rejects.toThrow(/is a heading/i);
  });

  it("survives a reversal without losing the entry from the report", async () => {
    // Nothing else touches June, so this cannot disturb the figures above.
    const entry = await P("2026-06-10", [
      { account: "6100", debit: 300_000, dimensions: CC("OPS") },
      { account: "1010", credit: 300_000 },
    ], "Rent, raised in error");
    await reverse({ orgId: ORG, entryId: entry.id });

    const pl = await dimensionalProfitAndLoss({ ...FEB, from: "2026-06-01", to: "2026-06-30" });
    // A reversed entry's own lines still stand — correction is by mirror entry —
    // so the pair has to net to zero here rather than the original vanishing and
    // only the reversal being counted.
    expect(pl.expenses.grandTotalMinor).toBe("0");
    expect(pl.reconciles).toBe(true);
    expect(pl.differenceMinor).toBe("0");
    // This once documented a defect: reverse() copied taxCode but not the
    // line's dimensions, so a reversal landed in Unallocated and left the
    // original cost centre overstated — the total right, the column split
    // wrong, and nothing that checked totals could see it. Fixed in post.ts,
    // which now loads dimensions.value.dimension for the purpose, so the
    // assertions below hold per column and not only in aggregate.
    // Read the per-column totals by key. Written with a lookup that would be
    // vacuous if the key were wrong, so both columns are asserted to exist
    // first — an assertion that passes because it matched nothing is worse
    // than no assertion.
    expect(pl.columns.map((c) => c.key)).toEqual(expect.arrayContaining(["OPS", "UNALLOCATED"]));
    expect(pl.expenses.totalMinor["OPS"]).toBe("0");
    expect(pl.expenses.totalMinor["UNALLOCATED"]).toBe("0");
  });
});
