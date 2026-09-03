import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { closeYear } from "@/lib/server/ledger/close";
import { profitAndLoss, balanceSheet } from "@/lib/server/ledger/statements";
import {
  saveLayout, listLayouts, getLayout, setLayoutStatus,
  renderLayout, duplicateLayout, seedStarterLayouts,
  type LayoutRow, type RenderedLayout,
} from "@/lib/server/ledger/layouts";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-lay";
const ENT = "t-ent-lay";
/** A second entity in the same organisation — the one layouts get copied to. */
const ENT2 = "t-ent-lay-2";
/** A second organisation, to prove one org's layouts are invisible to another. */
const ORG2 = "t-org-lay-b";

async function wipe() {
  for (const org of [ORG, ORG2]) {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${org}')`),
      db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "ReportLayout" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${org}'`),
    ]);
  }
}

const P = (entryDate: string, lines: { account: string; debit?: number; credit?: number }[], memo = "") =>
  post({ orgId: ORG, entityId: ENT, entryDate, memo, source: "manual", lines });

const PERIOD = { from: "2026-01-01", to: "2026-02-28" };

const render = (rows: LayoutRow[], basis: "PROFIT" | "BALANCE" = "PROFIT") =>
  renderLayout({
    orgId: ORG, entityId: ENT,
    layout: { code: "DRAFT", name: "Draft", basis, rows },
    ...(basis === "PROFIT" ? PERIOD : { to: PERIOD.to }),
  });

const value = (r: RenderedLayout, key: string) => r.rows.find((row) => row.key === key)?.valueMinor;

const save = (code: string, rows: LayoutRow[], basis: "PROFIT" | "BALANCE" = "PROFIT", name = code) =>
  saveLayout({ orgId: ORG, entityId: ENT, code, name, basis, rows });

/** A complete management profit and loss written by hand, covering every account. */
const FULL: LayoutRow[] = [
  { kind: "heading", label: "Trading" },
  { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999", invert: true },
  { key: "cost_of_sales", kind: "accounts", label: "Cost of sales", from: "5000", to: "5999", invert: true },
  { key: "gross_margin", kind: "total", label: "Gross margin", of: ["revenue", "cost_of_sales"], bold: true },
  { kind: "spacer", label: "" },
  { key: "people", kind: "accounts", label: "People", codes: ["6000"], invert: true },
  { key: "premises", kind: "accounts", label: "Premises", codes: ["6100"], invert: true },
  { key: "other", kind: "accounts", label: "Other overheads", from: "6150", to: "6999", invert: true },
  { key: "tax", kind: "accounts", label: "Tax", from: "7000", to: "7999", invert: true },
  {
    key: "net", kind: "total", label: "Result for the period", bold: true,
    of: ["gross_margin", "people", "premises", "other", "tax"],
  },
];

/** The same report with bank charges and tax left out — the mistake nobody notices. */
const GAPPED: LayoutRow[] = [
  { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999", invert: true },
  { key: "cost_of_sales", kind: "accounts", label: "Cost of sales", from: "5000", to: "5999", invert: true },
  { key: "payroll", kind: "accounts", label: "Payroll", codes: ["6000"], invert: true },
  { key: "rent", kind: "accounts", label: "Rent", codes: ["6100"], invert: true },
  { key: "result", kind: "total", label: "Result", of: ["revenue", "cost_of_sales", "payroll", "rent"] },
];

d("custom report layouts", () => {
  beforeAll(async () => {
    await wipe();
    for (const entityId of [ENT, ENT2]) {
      await openFiscalYear({ orgId: ORG, entityId, label: "2026", startsOn: "2026-01-01" });
      await openBooks({ orgId: ORG, entityId });
    }
    // In one entity's chart and not the other's, so a copy has something to refuse.
    await db.account.create({
      data: { orgId: ORG, entityId: ENT, code: "6910", name: "Studio hire", type: "EXPENSE" },
    });

    await P("2026-01-05", [{ account: "1010", debit: 5_000_000 }, { account: "3000", credit: 5_000_000 }], "Share capital");
    await P("2026-01-20", [{ account: "1010", debit: 2_000_000 }, { account: "4000", credit: 2_000_000 }], "Goods sold");
    await P("2026-01-25", [{ account: "1020", debit: 800_000 }, { account: "4100", credit: 800_000 }], "Services billed");
    await P("2026-02-05", [{ account: "5000", debit: 1_200_000 }, { account: "1010", credit: 1_200_000 }], "Cost of goods sold");
    await P("2026-02-10", [{ account: "5200", debit: 100_000 }, { account: "2050", credit: 100_000 }], "Freight accrued");
    await P("2026-02-15", [{ account: "6100", debit: 300_000 }, { account: "1010", credit: 300_000 }], "Rent");
    await P("2026-02-20", [{ account: "6000", debit: 500_000 }, { account: "1010", credit: 500_000 }], "Salaries");
    await P("2026-02-25", [{ account: "6350", debit: 20_000 }, { account: "1010", credit: 20_000 }], "Bank charges");
    await P("2026-02-28", [{ account: "7000", debit: 50_000 }, { account: "2400", credit: 50_000 }], "Corporate tax");
    await P("2026-02-28", [{ account: "1300", debit: 60_000 }, { account: "1010", credit: 60_000 }], "Insurance prepaid");

    await seedStarterLayouts({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------------- rendering */

  it("sums a code range and presents a credit balance positively when inverted", async () => {
    const r = await render(FULL);
    // 2,000,000 goods + 800,000 services, held in the ledger as credits.
    expect(value(r, "revenue")).toBe("2800000");
    expect(r.currency).toBe("AED");
    const raw = await render([
      { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999" },
    ]);
    // Without invert it is the ledger's own sign, which is how a report shows
    // income as a negative number.
    expect(value(raw, "revenue")).toBe("-2800000");
  });

  it("presents a cost as the deduction it is, so a total is a plain sum", async () => {
    const r = await render(FULL);
    expect(value(r, "cost_of_sales")).toBe("-1300000");
    expect(value(r, "gross_margin")).toBe("1500000");
    const gross = await profitAndLoss({ orgId: ORG, entityId: ENT, ...PERIOD });
    expect(value(r, "gross_margin")).toBe(gross.grossProfitMinor);
  });

  it("adds up the rows a total names, including earlier totals", async () => {
    const r = await render(FULL);
    expect(value(r, "people")).toBe("-500000");
    expect(value(r, "premises")).toBe("-300000");
    expect(value(r, "other")).toBe("-20000"); // 6350 alone carries a balance in 6150–6999
    expect(value(r, "tax")).toBe("-50000");
    // 1,500,000 gross margin less 870,000 of overheads and tax.
    expect(value(r, "net")).toBe("630000");
    expect(r.bottomLineMinor).toBe("630000");
  });

  it("renders a heading and a spacer without a figure", async () => {
    const r = await render(FULL);
    expect(r.rows[0].kind).toBe("heading");
    expect(r.rows[0].valueMinor).toBeNull();
    expect(r.rows[4].kind).toBe("spacer");
    expect(r.rows[4].valueMinor).toBeNull();
    expect(r.rows.filter((row) => row.valueMinor !== null)).toHaveLength(8);
  });

  it("names the accounts a range actually caught", async () => {
    const r = await render(FULL);
    const revenue = r.rows.find((row) => row.key === "revenue")!;
    expect(revenue.codes).toContain("4000");
    expect(revenue.codes).toContain("4950");
    expect(revenue.codes).not.toContain("5000");
    expect(r.rows.find((row) => row.key === "people")!.codes).toEqual(["6000"]);
  });

  /* -------------------------------------------------------------- coverage */

  it("agrees with the profit and loss when the layout covers every account", async () => {
    const r = await render(FULL);
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, ...PERIOD });
    expect(r.netProfitMinor).toBe(pl.netProfitMinor);
    expect(r.bottomLineDifferenceMinor).toBe("0");
    expect(r.coverage.unmatched).toEqual([]);
    expect(r.coverage.overlapping).toEqual([]);
    expect(r.coverage.considered).toBe(8);
    expect(r.coverage.matched).toBe(8);
    expect(r.warnings).toEqual([]);
  });

  it("catches an account the layout leaves out, and says what it costs", async () => {
    const r = await render(GAPPED);
    // 2,800,000 − 1,300,000 − 500,000 − 300,000, with nothing for bank charges or tax.
    expect(r.bottomLineMinor).toBe("700000");
    expect(r.netProfitMinor).toBe("630000");
    expect(r.bottomLineDifferenceMinor).toBe("70000");
    expect(r.coverage.unmatched.map((u) => u.code)).toEqual(["6350", "7000"]);
    expect(r.coverage.unmatched[0].name).toBe("Bank charges");
    expect(r.coverage.unmatched[0].balanceMinor).toBe("20000");
    expect(r.coverage.unmatchedTotalMinor).toBe("70000");
    expect(r.coverage.matched).toBe(6);
    expect(r.warnings.some((w) => /6350 Bank charges/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /away from the profit and loss/.test(w))).toBe(true);
  });

  it("catches an account two rows both claim", async () => {
    const r = await render([
      { key: "all_sales", kind: "accounts", label: "All sales", from: "4000", to: "4999", invert: true },
      { key: "goods", kind: "accounts", label: "Goods", from: "4000", to: "4099", invert: true },
      { key: "total", kind: "total", label: "Total", of: ["all_sales", "goods"] },
    ]);
    expect(r.coverage.overlapping.map((o) => o.code)).toEqual(["4000"]);
    // 2,800,000 with 2,000,000 of it counted a second time.
    expect(r.bottomLineMinor).toBe("4800000");
    expect(r.warnings.some((w) => /picked up by more than one row/.test(w))).toBe(true);
  });

  it("holds a profit layout to the whole of income and expenses, and nothing else", async () => {
    const r = await render(GAPPED);
    // The bank account is not something a profit and loss is answerable for.
    expect(r.coverage.unmatched.some((u) => u.code === "1010")).toBe(false);
    expect(r.coverage.considered).toBe(8);
  });

  /* --------------------------------------------------------- balance basis */

  it("renders a balance sheet layout that balances, as at a date", async () => {
    const r = await renderLayout({ orgId: ORG, entityId: ENT, code: "BS_SUMMARY", to: PERIOD.to });
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: PERIOD.to });
    expect(value(r, "cash")).toBe("5720000");        // 1010 4,920,000 + 1020 800,000
    expect(value(r, "receivables")).toBe("60000");   // the insurance prepayment
    expect(value(r, "total_assets")).toBe("5780000");
    expect(value(r, "total_assets")).toBe(bs.totalAssetsMinor);
    expect(value(r, "payables")).toBe("150000");     // accrual and tax payable, presented positively
    expect(value(r, "capital")).toBe("5000000");
    // Profit not yet closed to equity is the income and expense accounts themselves.
    expect(value(r, "result")).toBe("630000");
    expect(value(r, "result")).toBe(bs.currentYearEarningsMinor);
    expect(value(r, "total_le")).toBe("5780000");
    expect(r.from).toBeNull();
    expect(r.netProfitMinor).toBeNull();
    expect(r.bottomLineDifferenceMinor).toBeNull();
    expect(r.coverage.unmatched).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("refuses a profit layout with no period to draw it over", async () => {
    await expect(
      renderLayout({ orgId: ORG, entityId: ENT, code: "MGMT_PL", to: PERIOD.to }),
    ).rejects.toThrow(/drawn on a profit basis.*Give the date it runs from/s);
  });

  /* ------------------------------------------------------------- refusals */

  it("refuses a duplicate row key, naming both rows", async () => {
    await expect(
      save("DUPKEY", [
        { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999" },
        { key: "revenue", kind: "accounts", label: "Other income", from: "4900", to: "4999" },
      ]),
    ).rejects.toThrow(/Row 2 "Other income" repeats the key "revenue", which row 1 already uses/);
  });

  it("refuses a total that names a key no row has", async () => {
    await expect(
      save("NOKEY", [
        { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999" },
        { kind: "total", label: "Gross margin", of: ["cost_of_sales"] },
      ]),
    ).rejects.toThrow(/Row 2 "Gross margin" adds up "cost_of_sales", but no row has that key/);
  });

  it("refuses a total that reaches forward to a row below it", async () => {
    await expect(
      save("FORWARD", [
        { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999" },
        { kind: "total", label: "Gross margin", of: ["cost_of_sales"] },
        { key: "cost_of_sales", kind: "accounts", label: "Cost of sales", from: "5000", to: "5999" },
      ]),
    ).rejects.toThrow(/Row 2 "Gross margin" adds up "cost_of_sales", which is defined later at row 3/);
  });

  it("refuses a total that adds up itself", async () => {
    await expect(
      save("SELF", [
        { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999" },
        { key: "net", kind: "total", label: "Net", of: ["revenue", "net"] },
      ]),
    ).rejects.toThrow(/Row 2 "Net" adds up itself/);
  });

  it("refuses a total that adds up itself through a chain", async () => {
    await expect(
      save("CHAIN", [
        { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999" },
        { key: "b", kind: "total", label: "B", of: ["c"] },
        { key: "c", kind: "total", label: "C", of: ["b"] },
      ]),
    ).rejects.toThrow(/Row 2 "B" adds up itself through b → c → b/);
  });

  it("refuses an accounts row with neither a range nor a list of codes", async () => {
    await expect(
      save("EMPTYROW", [{ key: "revenue", kind: "accounts", label: "Revenue" }]),
    ).rejects.toThrow(/Row 1 "Revenue" sums accounts but names neither a code range nor a list of codes/);
  });

  it("refuses a range that runs backwards", async () => {
    await expect(
      save("BACKWARDS", [{ kind: "accounts", label: "Revenue", from: "4999", to: "4000" }]),
    ).rejects.toThrow(/Row 1 "Revenue" runs from 4999 down to 4000, which is backwards/);
  });

  it("refuses a code the entity's chart does not have", async () => {
    await expect(
      save("GHOST", [{ kind: "accounts", label: "Consultancy", codes: ["6000", "6999"] }]),
    ).rejects.toThrow(/Row 1 "Consultancy" names account 6999, which is not in this entity's chart/);
  });

  it("refuses a row that draws a line on the page with no words on it", async () => {
    await expect(
      save("NOLABEL", [
        { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999" },
        { kind: "heading", label: "  " },
      ]),
    ).rejects.toThrow(/Row 2 is a heading row with no label/);
  });

  it("refuses a total of a row that renders no figure", async () => {
    await expect(
      save("HEADTOTAL", [
        { key: "trading", kind: "heading", label: "Trading" },
        { kind: "total", label: "Total", of: ["trading"] },
      ]),
    ).rejects.toThrow(/adds up "trading", which is a heading row and renders no figure/);
  });

  it("refuses a layout with no rows at all", async () => {
    await expect(save("NOTHING", [])).rejects.toThrow(/needs at least one row/);
  });

  /* -------------------------------------------------------------- storage */

  it("saves a layout, lists it, and reads it back with its rows intact", async () => {
    const saved = await save("QUARTER", FULL, "PROFIT", "Quarterly pack");
    expect(saved.code).toBe("QUARTER");
    expect(saved.name).toBe("Quarterly pack");
    expect(saved.rows).toHaveLength(FULL.length);
    expect(saved.rows[1]).toMatchObject({ key: "revenue", from: "4000", to: "4999", invert: true });

    const read = await getLayout({ orgId: ORG, entityId: ENT, code: "quarter" });
    expect(read.id).toBe(saved.id);
    const codes = (await listLayouts({ orgId: ORG, entityId: ENT })).map((l) => l.code);
    expect(codes).toContain("MGMT_PL");
    expect(codes).toContain("QUARTER");
  });

  it("saves over a layout of the same code rather than making a second", async () => {
    const again = await save("QUARTER", GAPPED, "PROFIT", "Quarterly pack, revised");
    const all = (await listLayouts({ orgId: ORG, entityId: ENT })).filter((l) => l.code === "QUARTER");
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("Quarterly pack, revised");
    expect(again.rows).toHaveLength(GAPPED.length);
  });

  it("archives a layout instead of deleting it", async () => {
    await setLayoutStatus({ orgId: ORG, entityId: ENT, code: "QUARTER", status: "archived" });
    expect((await listLayouts({ orgId: ORG, entityId: ENT })).map((l) => l.code)).not.toContain("QUARTER");
    expect(
      (await listLayouts({ orgId: ORG, entityId: ENT, includeArchived: true })).map((l) => l.code),
    ).toContain("QUARTER");
    await setLayoutStatus({ orgId: ORG, entityId: ENT, code: "QUARTER", status: "active" });
  });

  /* ---------------------------------------------------------------- seeds */

  it("seeds two starting layouts that cover the standard chart completely", async () => {
    const again = await seedStarterLayouts({ orgId: ORG, entityId: ENT });
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual(["MGMT_PL", "BS_SUMMARY"]);

    const pack = await renderLayout({ orgId: ORG, entityId: ENT, code: "MGMT_PL", ...PERIOD });
    expect(pack.coverage.unmatched).toEqual([]);
    expect(pack.coverage.overlapping).toEqual([]);
    expect(pack.bottomLineDifferenceMinor).toBe("0");
    expect(value(pack, "gross_margin")).toBe("1500000");
    expect(value(pack, "operating_profit")).toBe("680000");
    expect(value(pack, "net_result")).toBe("630000");
    expect(pack.warnings).toEqual([]);
  });

  /* ----------------------------------------------------------- duplication */

  it("copies a layout to another entity in the same organisation", async () => {
    const copy = await duplicateLayout({
      orgId: ORG, from: { entityId: ENT, code: "MGMT_PL" }, toEntityId: ENT2,
    });
    expect(copy.toEntityId).toBe(ENT2);
    expect(copy.emptyRows).toEqual([]);
    expect(copy.layout.entityId).toBe(ENT2);
    expect(copy.layout.rows).toHaveLength(16);
    expect((await listLayouts({ orgId: ORG, entityId: ENT2 })).map((l) => l.code)).toEqual(["MGMT_PL"]);

    // The copy renders against the other entity's ledger, which has no postings.
    const r = await renderLayout({ orgId: ORG, entityId: ENT2, code: "MGMT_PL", ...PERIOD });
    expect(r.bottomLineMinor).toBe("0");
    expect(r.coverage.considered).toBe(0);
  });

  it("refuses to overwrite a layout the other entity already holds", async () => {
    await expect(
      duplicateLayout({ orgId: ORG, from: { entityId: ENT, code: "MGMT_PL" }, toEntityId: ENT2 }),
    ).rejects.toThrow(/already has a layout "MGMT_PL"/);
    const forced = await duplicateLayout({
      orgId: ORG, from: { entityId: ENT, code: "MGMT_PL" }, toEntityId: ENT2, overwrite: true,
    });
    expect(forced.layout.code).toBe("MGMT_PL");
  });

  it("refuses to copy a layout naming an account the other entity does not have", async () => {
    await save("STUDIO", [
      { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999", invert: true },
      { key: "studio", kind: "accounts", label: "Studio hire", codes: ["6910"], invert: true },
      { key: "net", kind: "total", label: "Net", of: ["revenue", "studio"] },
    ]);
    await expect(
      duplicateLayout({ orgId: ORG, from: { entityId: ENT, code: "STUDIO" }, toEntityId: ENT2 }),
    ).rejects.toThrow(/Row 2 "Studio hire" names account 6910, which is not in this entity's chart/);
    // Nothing was written to the other entity.
    expect((await listLayouts({ orgId: ORG, entityId: ENT2 })).map((l) => l.code)).not.toContain("STUDIO");
  });

  it("copies a range that catches nothing, and says which row is blank", async () => {
    await save("SPARE", [
      { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999", invert: true },
      { key: "unused", kind: "accounts", label: "Unused block", from: "8000", to: "8999", invert: true },
      { key: "net", kind: "total", label: "Net", of: ["revenue", "unused"] },
    ]);
    const copy = await duplicateLayout({
      orgId: ORG, from: { entityId: ENT, code: "SPARE" }, toEntityId: ENT2,
    });
    expect(copy.emptyRows).toEqual(["Unused block"]);
  });

  it("refuses to copy a layout onto itself", async () => {
    await expect(
      duplicateLayout({ orgId: ORG, from: { entityId: ENT, code: "MGMT_PL" }, toEntityId: ENT }),
    ).rejects.toThrow(/cannot be copied onto itself/);
  });

  /* ------------------------------------------------------------- isolation */

  it("keeps one organisation's layouts out of another's", async () => {
    await saveLayout({
      orgId: ORG2, entityId: ENT, code: "MGMT_PL", name: "Another org's pack", basis: "PROFIT",
      rows: [{ key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4999", invert: true }],
    });
    expect((await getLayout({ orgId: ORG2, entityId: ENT, code: "MGMT_PL" })).name).toBe("Another org's pack");
    expect((await getLayout({ orgId: ORG, entityId: ENT, code: "MGMT_PL" })).name).toBe("Management profit and loss");
    expect(await listLayouts({ orgId: ORG2, entityId: ENT2 })).toEqual([]);
    await expect(
      getLayout({ orgId: ORG2, entityId: ENT2, code: "MGMT_PL" }),
    ).rejects.toThrow(/There is no report layout "MGMT_PL" for this entity/);
    // The other organisation's ledger is not readable through its layout either.
    await expect(
      renderLayout({ orgId: ORG2, entityId: ENT, code: "MGMT_PL", ...PERIOD }),
    ).rejects.toThrow(/No ledger has been opened for this entity/);
  });

  it("still reports a closed year, because the close is not trading", async () => {
    // Closing a year brings every income and expense account to nothing. A
    // profit layout drawn over a range covering the close would read every
    // line as nil — and because a layout is checked against profitAndLoss(),
    // which also excludes it, the coverage difference would be zero and the
    // report would look correct and be empty.
    const before = await renderLayout({ orgId: ORG, entityId: ENT, code: "MGMT_PL", from: "2026-01-01", to: "2026-12-31" });
    const beforeBottom = before.rows[before.rows.length - 1].valueMinor;
    expect(before.bottomLineDifferenceMinor).toBe("0");

    await db.accountingPeriod.updateMany({
      where: { orgId: ORG, entityId: ENT, isAdjustment: false },
      data: { status: "hard_closed" },
    });
    await closeYear({ orgId: ORG, entityId: ENT, fiscalYear: "2026" });

    const after = await renderLayout({ orgId: ORG, entityId: ENT, code: "MGMT_PL", from: "2026-01-01", to: "2026-12-31" });
    expect(after.rows[after.rows.length - 1].valueMinor).toBe(beforeBottom);
    expect(after.bottomLineDifferenceMinor).toBe("0");
    expect(after.rows.some((r) => r.valueMinor !== "0" && r.valueMinor !== null)).toBe(true);
  });
});
