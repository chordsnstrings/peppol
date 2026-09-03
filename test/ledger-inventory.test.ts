import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { addItem, receive, issue, adjust, stockValuation, itemHistory, unitCost, issueValue } from "@/lib/server/ledger/inventory";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-inv";
const ENT = "t-ent-inv";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryMovement" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryItem" WHERE "orgId" = '${ORG}'`),
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

const R = (sku: string, qty: number, value: number, on = "2026-01-10") =>
  receive({ orgId: ORG, entityId: ENT, sku, movedOn: on, quantityMilli: qty, valueMinor: value });
const I = (sku: string, qty: number, on = "2026-01-20") =>
  issue({ orgId: ORG, entityId: ENT, sku, movedOn: on, quantityMilli: qty });

async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true } });
  return Object.fromEntries(rows.map((r) => [r.account.code, r.txnAmountMinor]));
}

describe("weighted average cost", () => {
  it("is value over quantity, per whole unit", () => {
    // 10 units costing 1,000.00 → 100.00 each.
    expect(unitCost(100_000n, 10_000n)).toBe(10_000n);
  });

  it("rounds down, so the running cost cannot drift above what was paid", () => {
    // 3 units costing 10.00 → 3.33 each, not 3.34. Rounding up compounds.
    expect(unitCost(1_000n, 3_000n)).toBe(333n);
  });

  it("is nothing when there is nothing in stock", () => {
    expect(unitCost(0n, 0n)).toBe(0n);
  });

  it("gives the last issue the whole remaining value", () => {
    // 1,000 across 3 units leaves a fil after two issues; the third takes it.
    const item = { valueMinor: 1_000n, quantityMilli: 3_000n };
    expect(issueValue(item, 3_000n)).toBe(1_000n);
    expect(issueValue(item, 1_000n)).toBe(333n);
  });
});

d("inventory", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
    await addItem({ orgId: ORG, entityId: ENT, item: { sku: "WIDGET", name: "Widget", uom: "EA" } });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("refuses a duplicate SKU", async () => {
    await expect(addItem({ orgId: ORG, entityId: ENT, item: { sku: "WIDGET", name: "Another" } }))
      .rejects.toThrow(/already exists/i);
  });

  it("receives stock and debits the stock account", async () => {
    // 100 units at 50.00 each.
    const r = await R("WIDGET", 100_000, 500_000);
    expect(r.balanceQtyMilli).toBe("100000");
    expect(r.balanceValueMinor).toBe("500000");
    expect(r.unitCostMinor).toBe("5000");
    expect(await linesOf(r.entryId!)).toEqual({ "1200": 500_000n, "2000": -500_000n });
  });

  it("averages a second receipt at a different price", async () => {
    // 100 more at 70.00 → 200 units carried at 12,000.00, so 60.00 each.
    const r = await R("WIDGET", 100_000, 700_000, "2026-01-12");
    expect(r.balanceQtyMilli).toBe("200000");
    expect(r.balanceValueMinor).toBe("1200000");
    expect(r.unitCostMinor).toBe("6000");
  });

  it("issues at the weighted average, not at what it sold for", async () => {
    const r = await I("WIDGET", 50_000);
    // 50 units at the 60.00 average = 3,000.00 of cost.
    expect(r.valueMinor).toBe("-300000");
    expect(await linesOf(r.entryId!)).toEqual({ "5000": 300_000n, "1200": -300_000n });
    expect(r.balanceQtyMilli).toBe("150000");
    expect(r.balanceValueMinor).toBe("900000");
    // The average is unchanged by an issue, which is the point of the method.
    expect(r.unitCostMinor).toBe("6000");
  });

  it("refuses to issue more than is held, and says why", async () => {
    await expect(I("WIDGET", 999_000)).rejects.toThrow(/only 150 EA of WIDGET in stock/i);
    await expect(I("WIDGET", 999_000)).rejects.toThrow(/receipt is probably missing/i);
  });

  it("refuses a zero or negative movement", async () => {
    await expect(I("WIDGET", 0)).rejects.toThrow(/positive quantity/i);
    await expect(R("WIDGET", -5_000, 100)).rejects.toThrow(/positive quantity/i);
  });

  it("handles fractional quantities", async () => {
    await addItem({ orgId: ORG, entityId: ENT, item: { sku: "CABLE", name: "Cable", uom: "M" } });
    // 2.5 metres costing 25.00 → 10.00 a metre.
    const r = await R("CABLE", 2_500, 2_500);
    expect(r.unitCostMinor).toBe("1000");
    const out = await I("CABLE", 1_500);
    expect(out.valueMinor).toBe("-1500");
    expect(out.balanceQtyMilli).toBe("1000");
  });

  it("books a shortfall found on a stock count to its own account", async () => {
    // 150 on the system, 148 on the shelf: two units of shrinkage at 60.00.
    const r = await adjust({ orgId: ORG, entityId: ENT, sku: "WIDGET", movedOn: "2026-01-25", countedMilli: 148_000, reason: "Quarterly count" });
    expect(r.quantityMilli).toBe("-2000");
    expect(r.valueMinor).toBe("-12000");
    // Shrinkage goes to 5300, not into cost of sales — a business that cannot
    // see it cannot manage it.
    expect(await linesOf(r.entryId!)).toEqual({ "5300": 12_000n, "1200": -12_000n });
  });

  it("books a surplus at the current average", async () => {
    const r = await adjust({ orgId: ORG, entityId: ENT, sku: "WIDGET", movedOn: "2026-01-26", countedMilli: 150_000 });
    expect(r.quantityMilli).toBe("2000");
    expect(await linesOf(r.entryId!)).toEqual({ "1200": 12_000n, "5300": -12_000n });
  });

  it("says so when a count agrees rather than posting nothing quietly", async () => {
    await expect(adjust({ orgId: ORG, entityId: ENT, sku: "WIDGET", movedOn: "2026-01-27", countedMilli: 150_000 }))
      .rejects.toThrow(/count agrees with the system/i);
  });

  it("leaves no value stranded when the last unit goes", async () => {
    await addItem({ orgId: ORG, entityId: ENT, item: { sku: "ODD", name: "Odd lot" } });
    await R("ODD", 3_000, 1_000, "2026-02-01"); // 3 units for 10.00 — does not divide
    const a = await issue({ orgId: ORG, entityId: ENT, sku: "ODD", movedOn: "2026-02-02", quantityMilli: 1_000 });
    const b = await issue({ orgId: ORG, entityId: ENT, sku: "ODD", movedOn: "2026-02-03", quantityMilli: 1_000 });
    const c = await issue({ orgId: ORG, entityId: ENT, sku: "ODD", movedOn: "2026-02-04", quantityMilli: 1_000 });
    // Every fil of cost reached the profit and loss, and nothing is left behind.
    expect(BigInt(a.valueMinor) + BigInt(b.valueMinor) + BigInt(c.valueMinor)).toBe(-1_000n);
    expect(c.balanceQtyMilli).toBe("0");
    expect(c.balanceValueMinor).toBe("0");
  });

  it("keeps a movement history that explains the valuation", async () => {
    const h = await itemHistory({ orgId: ORG, entityId: ENT, sku: "WIDGET" });
    expect(h.movements.length).toBeGreaterThanOrEqual(5);
    expect(h.movements[0].kind).toBe("RECEIPT");
    // Each movement carries the running balance, so it reads on its own.
    expect(h.movements[h.movements.length - 1].balanceQuantity).toBe("150");
  });

  it("ties the stock valuation to the ledger", async () => {
    const v = await stockValuation({ orgId: ORG, entityId: ENT });
    expect(v.ledger.agrees).toBe(true);
    expect(v.totals.valueMinor).toBe(v.ledger.valueMinor);
  });

  it("keeps the trial balance tied through receipts, issues and adjustments", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-02" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });

  it("refuses to record a movement against an unknown SKU", async () => {
    await expect(I("NOSUCH", 1_000)).rejects.toThrow(/not on the item list/i);
  });

  it("does not post twice when a bill already debited inventory", async () => {
    await addItem({ orgId: ORG, entityId: ENT, item: { sku: "VIABILL", name: "Bought on a bill" } });
    const r = await receive({
      orgId: ORG, entityId: ENT, sku: "VIABILL", movedOn: "2026-02-10",
      quantityMilli: 10_000, valueMinor: 50_000, alreadyPosted: true,
    });
    expect(r.entryId).toBeNull();
    expect(r.balanceValueMinor).toBe("50000");
    // The valuation now legitimately exceeds the ledger, because the bill's own
    // posting is what put it there — and that is exactly what the comparison is
    // for. It must not be hidden.
    const v = await stockValuation({ orgId: ORG, entityId: ENT });
    expect(v.ledger.agrees).toBe(false);
  });
});
