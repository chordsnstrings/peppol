import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post, reverse } from "@/lib/server/ledger/post";
import { profitAndLoss } from "@/lib/server/ledger/statements";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { createDimension, listDimensions } from "@/lib/server/ledger/dimensions";
import {
  UNASSIGNED,
  PROJECT_DIMENSION,
  createProject,
  updateProject,
  closeProject,
  listProjects,
  projectProfitability,
  projectSummary,
  workInProgress,
  projectDetail,
} from "@/lib/server/ledger/projects";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-proj";
const ENT = "t-ent-proj";

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
    db.$executeRawUnsafe(`DELETE FROM "Project" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DimensionValue" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Dimension" WHERE "orgId" = '${ORG}'`),
  ]);
}

type L = { account: string; debit?: number; credit?: number; dimensions?: Record<string, string> };
const P = (entryDate: string, lines: L[], memo = "") =>
  post({ orgId: ORG, entityId: ENT, entryDate, memo, source: "manual", lines });

/** Tag a line to a job — the ordinary dimension mechanism, nothing special. */
const J = (code: string) => ({ [PROJECT_DIMENSION]: code });

const E = { orgId: ORG, entityId: ENT };
const FEB = { ...E, from: "2026-02-01", to: "2026-02-28" };

d("projects and job costing", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // A second dimension, so the report has to prove it reads the project axis
    // and not "whatever tag happened to be on the line".
    await createDimension({ orgId: ORG, code: "COST_CENTRE", name: "Cost centre", values: [{ code: "OPS", name: "Operations" }] });

    // ── The jobs. Each one exists to make a different figure provable.
    await createProject({
      ...E, code: "SITE_A", name: "Marina Tower fit-out", customerName: "Emaar",
      startsOn: "2026-01-01", budgetMinor: 1_000_000,
    });
    // Comfortably profitable and still over the price it was quoted at — the
    // case that proves overBudget is a flag and not the sign of anything.
    await createProject({ ...E, code: "SITE_B", name: "Deira warehouse", startsOn: "2026-01-01", budgetMinor: 200_000 });
    // No budget at all.
    await createProject({ ...E, code: "SITE_C", name: "Racking survey", startsOn: "2026-01-01" });
    // Cost ahead of billing — work in progress.
    await createProject({ ...E, code: "SITE_D", name: "Al Quoz workshop", startsOn: "2026-01-01", budgetMinor: 400_000 });

    await P("2026-01-05", [{ account: "1010", debit: 5_000_000 }, { account: "3000", credit: 5_000_000 }], "Share capital");

    // ── February: the fixture every arithmetic assertion below is measured on.
    await P("2026-02-10", [
      { account: "1010", debit: 1_000_000 },
      { account: "4100", credit: 1_000_000, dimensions: J("SITE_A") },
    ], "Marina Tower — stage 1 invoiced");
    await P("2026-02-12", [
      { account: "5000", debit: 400_000, dimensions: J("SITE_A") },
      { account: "1010", credit: 400_000 },
    ], "Marina Tower — materials");
    await P("2026-02-13", [
      { account: "6000", debit: 200_000, dimensions: J("SITE_A") },
      { account: "1010", credit: 200_000 },
    ], "Marina Tower — site wages");

    await P("2026-02-14", [
      { account: "1010", debit: 500_000 },
      { account: "4100", credit: 500_000, dimensions: J("SITE_B") },
    ], "Deira warehouse — invoiced");
    await P("2026-02-15", [
      { account: "5100", debit: 250_000, dimensions: J("SITE_B") },
      { account: "1010", credit: 250_000 },
    ], "Deira warehouse — subcontractor");

    await P("2026-02-16", [
      { account: "6250", debit: 100_000, dimensions: J("SITE_C") },
      { account: "1010", credit: 100_000 },
    ], "Racking survey — engineer");

    await P("2026-02-17", [
      { account: "5100", debit: 300_000, dimensions: J("SITE_D") },
      { account: "1010", credit: 300_000 },
    ], "Al Quoz — labour");
    await P("2026-02-18", [
      { account: "1010", debit: 120_000 },
      { account: "4100", credit: 120_000, dimensions: J("SITE_D") },
    ], "Al Quoz — first application");

    // Nobody said which job this belongs to. It must show as Unassigned.
    await P("2026-02-20", [{ account: "6900", debit: 175_000 }, { account: "1010", credit: 175_000 }], "Sundry site costs");
    // Tagged on a different dimension only — carrying one is not carrying this one.
    await P("2026-02-21", [
      { account: "6150", debit: 25_000, dimensions: { COST_CENTRE: "OPS" } },
      { account: "1010", credit: 25_000 },
    ], "Utilities");

    // ── March: for the mid-period cut-off.
    await P("2026-03-10", [
      { account: "6100", debit: 90_000, dimensions: J("SITE_A") },
      { account: "1010", credit: 90_000 },
    ], "Marina Tower — hoist hire");
    await P("2026-03-25", [
      { account: "6100", debit: 60_000, dimensions: J("SITE_A") },
      { account: "1010", credit: 60_000 },
    ], "Marina Tower — scaffold hire");
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  const row = async (key: string, opts = FEB) => {
    const s = await projectSummary(opts);
    return s.rows.find((r) => r.key === key)!;
  };

  it("creates a project, and with it the dimension value costs are tagged to", async () => {
    // The project is not a parallel tagging mechanism: it is a value of the
    // ordinary PROJECT dimension, which is what makes post.ts able to attribute
    // to it at all.
    const dims = await listDimensions({ orgId: ORG });
    const project = dims.find((x) => x.code === PROJECT_DIMENSION)!;
    expect(project.name).toBe("Project");
    expect(project.values.map((v) => v.code)).toEqual(["SITE_A", "SITE_B", "SITE_C", "SITE_D"]);
    expect(project.values.find((v) => v.code === "SITE_A")!.name).toBe("Marina Tower fit-out");

    // And the row holds what the ledger cannot: a customer, a budget, dates.
    const projects = await listProjects(E);
    expect(projects.map((p) => p.code)).toEqual(["SITE_A", "SITE_B", "SITE_C", "SITE_D"]);
    const a = projects[0];
    expect(a.customerName).toBe("Emaar");
    expect(a.budgetMinor).toBe("1000000");
    expect(a.startsOn).toBe("2026-01-01");
    expect(a.endsOn).toBeNull();
    expect(a.status).toBe("active");
  });

  it("refuses a code that could not be a dimension value", async () => {
    await expect(createProject({ ...E, code: "UNASSIGNED", name: "Nope", startsOn: "2026-01-01" }))
      .rejects.toThrow(/cannot also be a project/i);
    // The residual's own key, which is what the Unassigned row is keyed by.
    await expect(createProject({ ...E, code: UNASSIGNED, name: "Nope", startsOn: "2026-01-01" }))
      .rejects.toThrow(/cannot also be a project/i);
    // A colon would break the `dimensionCode:valueCode` lookup in post.ts.
    await expect(createProject({ ...E, code: "SITE:X", name: "Nope", startsOn: "2026-01-01" }))
      .rejects.toThrow(/letters, digits and underscores/i);
    await expect(createProject({ ...E, code: "SITE_X", name: "  ", startsOn: "2026-01-01" }))
      .rejects.toThrow(/needs a name/i);
    await expect(createProject({ ...E, code: "SITE_X", name: "Nope", startsOn: "2026-01-01", budgetMinor: -1 }))
      .rejects.toThrow(/cannot be negative/i);
  });

  it("refuses a second project on the same code, naming the one that exists", async () => {
    await expect(createProject({ ...E, code: "SITE_A", name: "Another one", startsOn: "2026-01-01" }))
      .rejects.toThrow(/already exists .*Marina Tower fit-out/is);
  });

  it("refuses a job that ends before it starts", async () => {
    await expect(createProject({ ...E, code: "SITE_Z", name: "Backwards", startsOn: "2026-05-01", endsOn: "2026-04-01" }))
      .rejects.toThrow(/before it starts/i);
    // And nothing was left behind by the refusal.
    expect((await listProjects(E)).some((p) => p.code === "SITE_Z")).toBe(false);
  });

  it("puts a cost tagged to a job against that job", async () => {
    const a = await row("SITE_A");
    expect(a.revenueMinor).toBe("1000000");
    expect(a.costMinor).toBe("600000"); // 400,000 materials + 200,000 wages
    expect(a.netMinor).toBe("400000");
    expect(a.customerName).toBe("Emaar");
    expect(a.isUnassigned).toBe(false);
    // And nothing of another job's leaks into it.
    expect((await row("SITE_B")).costMinor).toBe("250000");
  });

  it("puts a cost carrying no job under Unassigned, as a visible row", async () => {
    const s = await projectSummary(FEB);
    const unassigned = s.rows.find((r) => r.isUnassigned)!;
    expect(unassigned.key).toBe(UNASSIGNED);
    expect(unassigned.label).toBe("Unassigned");
    // Last, so it reads as the residual it is — never hidden, never spread.
    expect(s.rows[s.rows.length - 1].key).toBe(UNASSIGNED);
    // 175,000 with no dimension at all, plus 25,000 carrying only a cost centre.
    expect(unassigned.costMinor).toBe("200000");
    expect(unassigned.budgetMinor).toBeNull();
    expect(unassigned.overBudget).toBe(false);
    expect(s.unassignedCostMinor).toBe("200000");
    // 200,000 of 1,450,000 is 13.7931%, truncated to 1379 basis points.
    expect(s.unassignedShareBps).toBe("1379");
  });

  it("adds every project plus Unassigned back to the profit and loss for the period", async () => {
    const s = await projectSummary(FEB);
    const control = await profitAndLoss({ ...E, from: FEB.from, to: FEB.to });

    expect(s.reconciles).toBe(true);
    expect(s.differenceMinor).toBe("0");
    expect(s.totalNetMinor).toBe(control.netProfitMinor);
    expect(control.netProfitMinor).toBe("170000");

    // Added up here rather than trusted: the rows really do sum to it.
    const summed = s.rows.reduce((a, r) => a + BigInt(r.netMinor), 0n);
    expect(summed.toString()).toBe(control.netProfitMinor);
    expect(s.totalRevenueMinor).toBe(control.revenue.totalMinor);
    expect(BigInt(s.totalCostMinor)).toBe(BigInt(control.costOfSales.totalMinor) + BigInt(control.expenses.totalMinor));
    expect(s.rows.map((r) => r.key)).toEqual(["SITE_A", "SITE_B", "SITE_C", "SITE_D", UNASSIGNED]);
  });

  it("states the margin in basis points, on a figure worked out by hand", async () => {
    const a = await projectProfitability({ ...E, projectCode: "SITE_A", from: FEB.from, to: FEB.to });
    // 1,000,000 revenue less 600,000 cost is 400,000; 400,000/1,000,000 is 4000
    // basis points, which is 40.00% and is exactly representable as an integer.
    expect(a.revenueMinor).toBe("1000000");
    expect(a.costMinor).toBe("600000");
    expect(a.grossProfitMinor).toBe("400000");
    expect(a.grossMarginBps).toBe("4000");
    expect(BigInt(a.grossMarginBps!)).toBe(4000n);
    expect(a.reconciles).toBe(true);
    expect(a.differenceMinor).toBe("0");

    // Cost is the same figure as spent — there is not a second definition.
    expect(a.spentMinor).toBe(a.costMinor);
    expect(a.percentOfBudgetBps).toBe("6000");
    expect(a.remainingMinor).toBe("400000");
    expect(a.overBudget).toBe(false);

    // A loss-making job reports a negative margin rather than nothing.
    const dd = await projectProfitability({ ...E, projectCode: "SITE_D", from: FEB.from, to: FEB.to });
    expect(dd.grossMarginBps).toBe("-15000");
  });

  it("flags an over-budget job with the flag, not with a sign", async () => {
    const b = await projectProfitability({ ...E, projectCode: "SITE_B", from: FEB.from, to: FEB.to });
    // The job is making money — reading the sign of anything here would say it
    // is fine. It is over the price it was quoted at, and only the flag says so.
    expect(b.grossProfitMinor).toBe("250000");
    expect(BigInt(b.grossProfitMinor) > 0n).toBe(true);
    expect(b.hasBudget).toBe(true);
    expect(b.overBudget).toBe(true);
    expect(b.overBudgetByMinor).toBe("50000");
    expect(b.remainingMinor).toBe("-50000");
    expect(b.percentOfBudgetBps).toBe("12500"); // 250,000 spent of a 200,000 budget

    expect((await row("SITE_B")).overBudget).toBe(true);
    expect((await row("SITE_A")).overBudget).toBe(false);
  });

  it("reports no percentage at all for a job with no budget, rather than infinity", async () => {
    const c = await projectProfitability({ ...E, projectCode: "SITE_C", from: FEB.from, to: FEB.to });
    expect(c.budgetMinor).toBe("0");
    expect(c.hasBudget).toBe(false);
    expect(c.spentMinor).toBe("100000");
    // No budget is not the same fact as no overrun, and neither is 0%.
    expect(c.percentOfBudgetBps).toBeNull();
    expect(c.overBudget).toBe(false);
    expect(c.overBudgetByMinor).toBe("0");
    expect(c.remainingMinor).toBe("-100000");
    // Nor is there a margin on a job that has invoiced nothing.
    expect(c.revenueMinor).toBe("0");
    expect(c.grossMarginBps).toBeNull();

    const summaryRow = await row("SITE_C");
    expect(summaryRow.percentOfBudgetBps).toBeNull();
    expect(summaryRow.marginBps).toBeNull();
  });

  it("covers the project's own life when no dates are given", async () => {
    const a = await projectProfitability({ ...E, projectCode: "SITE_A" });
    expect(a.from).toBe("2026-01-01"); // the day it started
    expect(a.to).toBe(new Date().toISOString().slice(0, 10)); // still running, so today
    expect(a.reconciles).toBe(true);
    // Which picks up the March costs February alone does not.
    expect(BigInt(a.costMinor) >= 750_000n).toBe(true);
  });

  it("traces a figure to the postings that made it", async () => {
    const detail = await projectDetail({ ...E, projectCode: "SITE_A", from: FEB.from, to: FEB.to });
    expect(detail.lines.map((l) => l.accountCode)).toEqual(["4100", "5000", "6000"]);
    expect(detail.lines[0].reference).toMatch(/^GJ-/);
    expect(detail.lines[0].memo).toBe("Marina Tower — stage 1 invoiced");
    expect(detail.lines[1].debitMinor).toBe("400000");
    expect(detail.lines[0].creditMinor).toBe("1000000");
    // Running down the page, debit-positive: the last one is the negative of
    // what the job made.
    expect(detail.lines[2].runningMinor).toBe("-400000");

    // The drill-down and the report agree because they are the same lines.
    const a = await projectProfitability({ ...E, projectCode: "SITE_A", from: FEB.from, to: FEB.to });
    expect(detail.totals!.revenueMinor).toBe(a.revenueMinor);
    expect(detail.totals!.costMinor).toBe(a.costMinor);
    expect(detail.totals!.otherMinor).toBe("0");
    expect(detail.truncated).toBe(false);
  });

  it("prints no total under a truncated list of lines", async () => {
    const cut = await projectDetail({ ...E, projectCode: "SITE_A", from: FEB.from, to: FEB.to, limit: 1 });
    expect(cut.lines).toHaveLength(1);
    expect(cut.truncated).toBe(true);
    // A total of some of the lines is not a total, so none is offered.
    expect(cut.totals).toBeNull();
  });

  it("reports work in progress as cost incurred less amounts invoiced", async () => {
    const wip = await workInProgress({ ...E, asOf: "2026-02-28" });
    expect(wip.basis).toBe("cost-to-date");
    expect(wip.excludedStatuses).toEqual(["complete", "cancelled"]);

    const dd = wip.rows.find((r) => r.code === "SITE_D")!;
    expect(dd.costToDateMinor).toBe("300000");
    expect(dd.invoicedMinor).toBe("120000");
    expect(dd.wipMinor).toBe("180000");
    expect(dd.overBilled).toBe(false);

    // Billed ahead of cost is stated, not left to the reader to spot a minus.
    const a = wip.rows.find((r) => r.code === "SITE_A")!;
    expect(a.wipMinor).toBe("-400000");
    expect(a.overBilled).toBe(true);

    // Every running job, and the totals add up across them.
    expect(wip.rows.map((r) => r.code)).toEqual(["SITE_A", "SITE_B", "SITE_C", "SITE_D"]);
    expect(wip.totalCostMinor).toBe("1250000"); // 600 + 250 + 100 + 300 thousand
    expect(wip.totalInvoicedMinor).toBe("1620000");
    expect(wip.totalWipMinor).toBe("-370000");
  });

  it("closes a project, idempotently, without touching the ledger", async () => {
    const before = await profitAndLoss({ ...E, from: FEB.from, to: FEB.to });

    const closed = await closeProject({ ...E, code: "SITE_D", endsOn: "2026-02-28" });
    expect(closed.status).toBe("complete");
    expect(closed.endsOn).toBe("2026-02-28");

    // Re-running a month-end routine must not fail on what it already closed.
    const again = await closeProject({ ...E, code: "SITE_D", endsOn: "2026-03-31" });
    expect(again.status).toBe("complete");
    expect(again.endsOn).toBe("2026-02-28"); // the first close stands

    // Closing is administrative: not one figure in the accounts moved.
    const after = await profitAndLoss({ ...E, from: FEB.from, to: FEB.to });
    expect(after.netProfitMinor).toBe(before.netProfitMinor);

    // The dimension value is archived — intent recorded, and dimensions.ts
    // deliberately keeps an archived value as a column.
    const value = await db.dimensionValue.findFirst({ where: { orgId: ORG, code: "SITE_D" } });
    expect(value?.status).toBe("archived");

    await expect(closeProject({ ...E, code: "GHOST" })).rejects.toThrow(/no project GHOST/i);
    await expect(closeProject({ ...E, code: "SITE_A", endsOn: "2025-12-31" })).rejects.toThrow(/before it started/i);
  });

  it("drops a closed job out of work in progress but keeps its cost on the report", async () => {
    const wip = await workInProgress({ ...E, asOf: "2026-02-28" });
    expect(wip.rows.map((r) => r.code)).toEqual(["SITE_A", "SITE_B", "SITE_C"]);
    expect(wip.totalCostMinor).toBe("950000");

    // The job still has a column and still has its cost — archiving a value
    // must never move last month's spend into Unassigned.
    const s = await projectSummary(FEB);
    const dd = s.rows.find((r) => r.key === "SITE_D")!;
    expect(dd.costMinor).toBe("300000");
    expect(dd.status).toBe("complete");
    expect(s.reconciles).toBe(true);
    expect(s.unassignedCostMinor).toBe("200000");
  });

  it("cuts a mid-period range exactly where profitAndLoss does", async () => {
    // 1–20 March is partial at both ends: the 10th is in, the 25th is not, and
    // neither end may swallow the rest of the month.
    const mid = await projectSummary({ ...E, from: "2026-03-01", to: "2026-03-20" });
    const control = await profitAndLoss({ ...E, from: "2026-03-01", to: "2026-03-20" });
    expect(mid.reconciles).toBe(true);
    expect(mid.differenceMinor).toBe("0");
    expect(mid.totalNetMinor).toBe(control.netProfitMinor);
    expect(control.netProfitMinor).toBe("-90000");
    expect(mid.rows.find((r) => r.key === "SITE_A")!.costMinor).toBe("90000");
    expect(mid.unassignedCostMinor).toBe("0");

    const whole = await projectSummary({ ...E, from: "2026-03-01", to: "2026-03-31" });
    const wholeControl = await profitAndLoss({ ...E, from: "2026-03-01", to: "2026-03-31" });
    expect(whole.rows.find((r) => r.key === "SITE_A")!.costMinor).toBe("150000");
    expect(whole.totalNetMinor).toBe(wholeControl.netProfitMinor);
    expect(whole.reconciles).toBe(true);

    // A single project's figures follow the same rule as the summary above it.
    const a = await projectProfitability({ ...E, projectCode: "SITE_A", from: "2026-03-01", to: "2026-03-20" });
    expect(a.costMinor).toBe("90000");
  });

  it("refuses to report on a job nobody created, or on a backwards range", async () => {
    await expect(projectProfitability({ ...E, projectCode: "GHOST" })).rejects.toThrow(/no project GHOST/i);
    await expect(projectDetail({ ...E, projectCode: "SITE_A", from: "2026-03-31", to: "2026-03-01" }))
      .rejects.toThrow(/ends before it starts/i);
    await expect(workInProgress({ ...E, asOf: "not-a-date" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("keeps both the total and the column split right through a reversal", async () => {
    // Nothing else touches June, so this cannot disturb the figures above.
    const entry = await P("2026-06-10", [
      { account: "6100", debit: 300_000, dimensions: J("SITE_A") },
      { account: "1010", credit: 300_000 },
    ], "Marina Tower — hoist hire, raised in error");
    await reverse({ orgId: ORG, entryId: entry.id });

    const s = await projectSummary({ ...E, from: "2026-06-01", to: "2026-06-30" });
    // A reversed entry's own lines still stand — correction is by mirror entry —
    // so the pair has to net to zero rather than the original vanishing.
    expect(s.totalCostMinor).toBe("0");
    expect(s.reconciles).toBe(true);
    expect(s.differenceMinor).toBe("0");
    // And the reversal carried the project with it: the split is right too, not
    // merely the total. Without that, SITE_A would show 300,000 of cost and
    // Unassigned minus 300,000, and the reconciliation would not catch it.
    expect(s.rows.find((r) => r.key === "SITE_A")!.costMinor).toBe("0");
    expect(s.unassignedCostMinor).toBe("0");
  });

  it("renames both halves of a project, and tells 0% apart from no budget", async () => {
    await createProject({ ...E, code: "SITE_E", name: "Ras Al Khor yard", startsOn: "2026-02-01", budgetMinor: 500_000 });
    const renamed = await updateProject({ ...E, code: "SITE_E", name: "Ras Al Khor yard — phase 2", customerName: "DP World" });
    expect(renamed.name).toBe("Ras Al Khor yard — phase 2");
    expect(renamed.customerName).toBe("DP World");

    // The report reads its label from the dimension value, so both halves move.
    const dims = await listDimensions({ orgId: ORG });
    const value = dims.find((x) => x.code === PROJECT_DIMENSION)!.values.find((v) => v.code === "SITE_E")!;
    expect(value.name).toBe("Ras Al Khor yard — phase 2");

    // Budgeted and untouched is 0%, which is a different fact from having no
    // budget at all — that one is null, and they must not print the same.
    const e = await projectProfitability({ ...E, projectCode: "SITE_E", from: FEB.from, to: FEB.to });
    expect(e.hasBudget).toBe(true);
    expect(e.spentMinor).toBe("0");
    expect(e.percentOfBudgetBps).toBe("0");
    expect(e.remainingMinor).toBe("500000");

    // A job with no postings is still a row, at zero, and the report still ties.
    const s = await projectSummary(FEB);
    expect(s.rows.find((r) => r.key === "SITE_E")!.costMinor).toBe("0");
    expect(s.reconciles).toBe(true);

    await expect(updateProject({ ...E, code: "SITE_E", status: "finished" })).rejects.toThrow(/active, on_hold, complete, cancelled/);
    await expect(updateProject({ ...E, code: "SITE_E", status: "complete" })).rejects.toThrow(/without the date it finished/i);
  });
});
