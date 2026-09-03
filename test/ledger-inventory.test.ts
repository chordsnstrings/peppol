import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  addItem, receive, issue, adjust, assessNrv, setCostMethod, stockValuation, itemHistory,
  unitCost, issueValue, carryingAmount, writeDownHeld,
  addLocation, updateLocation, closeLocation, stockByLocation, transferStock,
  batchRegister, expiringStock, sweepExpired, belowReorderLevel, setReorderLevel,
  setDefaultLocation, locationList,
} from "@/lib/server/ledger/inventory";
import { planConsumption, effectiveUnitCost, settleTakes } from "@/lib/server/ledger/inventory-fifo";
import {
  apportion, batchPut, batchTake, reorderVerdict, resolveLocation, tieBatches,
} from "@/lib/server/ledger/inventory-tracking";
import { createOrder, issueOrder } from "@/lib/server/ledger/procurement";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-inv";
const ENT = "t-ent-inv";

async function wipe(org = ORG) {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "GoodsReceiptLine" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "GoodsReceipt" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "PurchaseOrderLine" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "PurchaseOrder" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryMovement" WHERE "orgId" = '${org}'`),
    // Replica mode disables the foreign keys, so the layers and batches do not
    // cascade away with the items and have to be cleared in their own right.
    db.$executeRawUnsafe(`DELETE FROM "InventoryLayer" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "StockBatch" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "StockLocation" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryItem" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${org}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${org}'`),
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
  // The connection is closed once, after the last block in the file.
  afterAll(async () => { await wipe(); });

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

describe("first-in-first-out arithmetic", () => {
  const layer = (seq: number, on: string, remainingMilli: bigint, unitCostMinor: bigint) =>
    ({ id: `L${seq}`, seq, receivedOn: new Date(on), remainingMilli, unitCostMinor });

  // Three receipts of 100 units at 10.00, 12.00 and 15.00.
  const three = () => [
    layer(1, "2026-01-05", 100_000n, 1_000n),
    layer(2, "2026-01-10", 100_000n, 1_200n),
    layer(3, "2026-01-15", 100_000n, 1_500n),
  ];

  it("takes from the oldest layer first", () => {
    const plan = planConsumption(three(), 40_000n);
    expect(plan.takes.length).toBe(1);
    expect(plan.takes[0].seq).toBe(1);
    // 40 units at 10.00 = 400.00, and nothing touched the dearer layers.
    expect(plan.costMinor).toBe(40_000n);
    expect(plan.shortMilli).toBe(0n);
  });

  it("orders by the date the goods arrived, not the order they were keyed", () => {
    // Layer 3 was keyed last but dated first, so it is the oldest.
    const late = [layer(1, "2026-03-01", 10_000n, 900n), layer(2, "2026-03-02", 10_000n, 800n), layer(3, "2026-02-01", 10_000n, 700n)];
    expect(planConsumption(late, 10_000n).takes[0].seq).toBe(3);
  });

  it("spans layers and adds up what it took from each", () => {
    // 220 units: 60 at 10.00 (600.00) + 100 at 12.00 (1,200.00) + 60 at 15.00 (900.00).
    const started = three();
    started[0].remainingMilli = 60_000n;
    const plan = planConsumption(started, 220_000n);
    expect(plan.takes.map((t) => t.costMinor)).toEqual([60_000n, 120_000n, 90_000n]);
    expect(plan.costMinor).toBe(270_000n);
    // 2,700.00 over 220 units is 12.2727…, which is no layer's price.
    expect(effectiveUnitCost(plan.costMinor, 220_000n)).toBe(1_227n);
  });

  it("marks a layer exhausted only when the take empties it", () => {
    const plan = planConsumption(three(), 150_000n);
    expect(plan.takes.map((t) => t.exhausted)).toEqual([true, false]);
  });

  it("reports what the layers cannot cover rather than inventing a cost", () => {
    const plan = planConsumption(three(), 500_000n);
    expect(plan.shortMilli).toBe(200_000n);
  });

  it("settles a rounding residue onto the last layer touched", () => {
    const plan = planConsumption([layer(1, "2026-01-05", 3_000n, 333n)], 3_000n);
    expect(plan.costMinor).toBe(999n);
    // The item carries 10.00 for those three units; the fil belongs on the layer
    // still being drawn from, not stranded.
    expect(settleTakes(plan.takes, 1_000n).reduce((a, t) => a + t.costMinor, 0n)).toBe(1_000n);
  });
});

describe("net realisable value", () => {
  it("carries stock at the lower of cost and net realisable value", () => {
    // 100 units costing 1,000.00, worth 8.00 each on the market.
    expect(carryingAmount(100_000n, 100_000n, 800n)).toBe(80_000n);
    expect(writeDownHeld(100_000n, 100_000n, 800n)).toBe(20_000n);
  });

  it("leaves cost alone where net realisable value is above it", () => {
    // IAS 2.9 is a ceiling, not a revaluation: stock is never written up.
    expect(carryingAmount(100_000n, 100_000n, 1_500n)).toBe(100_000n);
    expect(writeDownHeld(100_000n, 100_000n, 1_500n)).toBe(0n);
  });

  it("keeps never assessed and assessed at nothing apart", () => {
    expect(carryingAmount(100_000n, 100_000n, null)).toBe(100_000n);
    expect(carryingAmount(100_000n, 100_000n, 0n)).toBe(0n);
  });
});

/* ------------------------------------------------------------ FIFO, in full */

const ORG_F = "t-org-inv-fifo";
const ENT_F = "t-ent-inv-fifo";

d("FIFO costing", () => {
  const RF = (sku: string, qty: number, value: number, on: string) =>
    receive({ orgId: ORG_F, entityId: ENT_F, sku, movedOn: on, quantityMilli: qty, valueMinor: value });
  const IF = (sku: string, qty: number, on: string) =>
    issue({ orgId: ORG_F, entityId: ENT_F, sku, movedOn: on, quantityMilli: qty });

  beforeAll(async () => {
    await wipe(ORG_F);
    await openFiscalYear({ orgId: ORG_F, entityId: ENT_F, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG_F, entityId: ENT_F });
    await addItem({ orgId: ORG_F, entityId: ENT_F, item: { sku: "LAYERED", name: "Layered widget", uom: "EA", costMethod: "FIFO" } });
    // 100 at 10.00, then 100 at 12.00, then 100 at 15.00.
    await RF("LAYERED", 100_000, 100_000, "2026-01-05");
    await RF("LAYERED", 100_000, 120_000, "2026-01-10");
    await RF("LAYERED", 100_000, 150_000, "2026-01-15");
  });
  afterAll(async () => { await wipe(ORG_F); });

  it("opens a layer for every receipt", async () => {
    const h = await itemHistory({ orgId: ORG_F, entityId: ENT_F, sku: "LAYERED" });
    expect(h.item.costMethod).toBe("FIFO");
    expect(h.layers.map((l) => l.unitCostMinor)).toEqual(["1000", "1200", "1500"]);
    expect(h.layers.map((l) => l.remainingMilli)).toEqual(["100000", "100000", "100000"]);
    // 300 units for 3,700.00 in total.
    expect(h.item.costMinor).toBe("370000");
  });

  it("issues from within one layer at that layer's cost", async () => {
    const r = await IF("LAYERED", 40_000, "2026-01-20");
    // 40 of the oldest 100, bought at 10.00 → 400.00, not the 12.33 average.
    expect(r.valueMinor).toBe("-40000");
    expect(r.unitCostMinor).toBe("1000");
    expect(r.layers).toEqual([
      { seq: 1, receivedOn: "2026-01-05", quantityMilli: "40000", unitCostMinor: "1000", costMinor: "40000" },
    ]);
    expect(await linesOf(r.entryId!)).toEqual({ "5000": 40_000n, "1200": -40_000n });
    expect(r.balanceQtyMilli).toBe("260000");
    expect(r.balanceValueMinor).toBe("330000");
  });

  it("issues across three layers and costs it as the sum of what it took", async () => {
    const r = await IF("LAYERED", 220_000, "2026-01-21");
    // 60 left at 10.00 = 600.00, all 100 at 12.00 = 1,200.00, 60 at 15.00 = 900.00.
    expect(r.layers.map((l) => l.costMinor)).toEqual(["60000", "120000", "90000"]);
    expect(r.valueMinor).toBe("-270000");
    // 2,700.00 over 220 units — an effective rate, and no layer's price.
    expect(r.unitCostMinor).toBe("1227");
    expect(await linesOf(r.entryId!)).toEqual({ "5000": 270_000n, "1200": -270_000n });
    expect(r.balanceQtyMilli).toBe("40000");
    expect(r.balanceValueMinor).toBe("60000");
    const h = await itemHistory({ orgId: ORG_F, entityId: ENT_F, sku: "LAYERED" });
    expect(h.layers.map((l) => l.remainingMilli)).toEqual(["0", "0", "40000"]);
    expect(h.layers[2].remainingValueMinor).toBe("60000");
  });

  it("exhausts a layer exactly and leaves the next one untouched", async () => {
    // A fourth receipt so the exhausting issue is not also the last one.
    await RF("LAYERED", 50_000, 80_000, "2026-01-25"); // 50 at 16.00
    const r = await IF("LAYERED", 40_000, "2026-01-26");
    expect(r.layers.length).toBe(1);
    expect(r.layers[0].seq).toBe(3);
    expect(r.valueMinor).toBe("-60000");
    expect(r.unitCostMinor).toBe("1500");
    expect(r.balanceQtyMilli).toBe("50000");
    expect(r.balanceValueMinor).toBe("80000");
    const h = await itemHistory({ orgId: ORG_F, entityId: ENT_F, sku: "LAYERED" });
    expect(h.layers.filter((l) => l.exhausted).length).toBe(3);
    expect(h.layers[3].remainingMilli).toBe("50000");
  });

  it("strands nothing when a FIFO layer's cost does not divide", async () => {
    await addItem({ orgId: ORG_F, entityId: ENT_F, item: { sku: "ODD-F", name: "Odd lot", costMethod: "FIFO" } });
    await RF("ODD-F", 3_000, 1_000, "2026-02-01"); // 3 units for 10.00
    const a = await IF("ODD-F", 1_000, "2026-02-02");
    const b = await IF("ODD-F", 1_000, "2026-02-03");
    const c = await IF("ODD-F", 1_000, "2026-02-04");
    expect([a.valueMinor, b.valueMinor, c.valueMinor]).toEqual(["-333", "-333", "-334"]);
    expect(c.balanceValueMinor).toBe("0");
    const h = await itemHistory({ orgId: ORG_F, entityId: ENT_F, sku: "ODD-F" });
    expect(h.layers[0].remainingMilli).toBe("0");
  });

  it("gives a different cost of sales from weighted average on the same receipts", async () => {
    for (const [sku, method] of [["CMP-FIFO", "FIFO"], ["CMP-WAVG", "WEIGHTED_AVERAGE"]] as const) {
      await addItem({ orgId: ORG_F, entityId: ENT_F, item: { sku, name: `Comparison ${method}`, costMethod: method } });
      await RF(sku, 10_000, 10_000, "2026-02-05"); // 10 at 1.00
      await RF(sku, 10_000, 30_000, "2026-02-06"); // 10 at 3.00
    }
    const first = await IF("CMP-FIFO", 10_000, "2026-02-07");
    const avg = await IF("CMP-WAVG", 10_000, "2026-02-07");

    // FIFO takes the cheap layer whole: 10 at 1.00.
    expect(first.valueMinor).toBe("-10000");
    expect(first.unitCostMinor).toBe("1000");
    // Weighted average takes half of 400.00 across 20 units: 10 at 2.00.
    expect(avg.valueMinor).toBe("-20000");
    expect(avg.unitCostMinor).toBe("2000");
    // The methods must not silently agree — the difference is the whole point.
    expect(first.valueMinor).not.toBe(avg.valueMinor);
    // And what is left differs by the same 100.00, the other way round.
    expect(first.balanceValueMinor).toBe("30000");
    expect(avg.balanceValueMinor).toBe("20000");
  });

  it("refuses to change the cost method while there is stock on hand", async () => {
    await expect(setCostMethod({ orgId: ORG_F, entityId: ENT_F, sku: "CMP-FIFO", costMethod: "WEIGHTED_AVERAGE" }))
      .rejects.toThrow(/holds 10 EA/);
    await expect(setCostMethod({ orgId: ORG_F, entityId: ENT_F, sku: "CMP-FIFO", costMethod: "WEIGHTED_AVERAGE" }))
      .rejects.toThrow(/making one up would make up a cost/i);
    await expect(setCostMethod({ orgId: ORG_F, entityId: ENT_F, sku: "CMP-FIFO", costMethod: "WEIGHTED_AVERAGE" }))
      .rejects.toThrow(/count this stock in as a new item/i);
    // Refused means refused: the item is still on FIFO.
    const h = await itemHistory({ orgId: ORG_F, entityId: ENT_F, sku: "CMP-FIFO" });
    expect(h.item.costMethod).toBe("FIFO");
  });

  it("allows the change once the stock is at nil", async () => {
    await IF("CMP-FIFO", 10_000, "2026-02-08");
    const r = await setCostMethod({ orgId: ORG_F, entityId: ENT_F, sku: "CMP-FIFO", costMethod: "WEIGHTED_AVERAGE" });
    expect(r.costMethod).toBe("WEIGHTED_AVERAGE");
    expect(r.quantityMilli).toBe("0");
  });

  it("refuses a method that is not one of the two", async () => {
    await expect(setCostMethod({ orgId: ORG_F, entityId: ENT_F, sku: "CMP-FIFO", costMethod: "LIFO" }))
      .rejects.toThrow(/not a cost method/i);
    await expect(setCostMethod({ orgId: ORG_F, entityId: ENT_F, sku: "CMP-FIFO", costMethod: "WEIGHTED_AVERAGE" }))
      .rejects.toThrow(/already costed on weighted average/i);
  });

  it("ties the FIFO valuation to the ledger and keeps the trial balance square", async () => {
    const v = await stockValuation({ orgId: ORG_F, entityId: ENT_F });
    expect(v.ledger.agrees).toBe(true);
    expect(v.ledger.differenceMinor).toBe("0");
    expect(v.totals.carryingMinor).toBe(v.ledger.valueMinor);
    const tb = await trialBalance({ orgId: ORG_F, entityId: ENT_F, periodLabel: "2026-02" });
    expect(tb.balanced).toBe(true);
  });
});

/* -------------------------------------------- net realisable value, in full */

const ORG_N = "t-org-inv-nrv";
const ENT_N = "t-ent-inv-nrv";

d("inventory at net realisable value", () => {
  const RN = (sku: string, qty: number, value: number, on: string) =>
    receive({ orgId: ORG_N, entityId: ENT_N, sku, movedOn: on, quantityMilli: qty, valueMinor: value });
  const nrv = (sku: string, nrvMinor: number | null, on: string) =>
    assessNrv({ orgId: ORG_N, entityId: ENT_N, sku, nrvMinor, on });
  const row = async (sku: string) => {
    const v = await stockValuation({ orgId: ORG_N, entityId: ENT_N });
    return v.items.find((i) => i.sku === sku)!;
  };

  beforeAll(async () => {
    await wipe(ORG_N);
    await openFiscalYear({ orgId: ORG_N, entityId: ENT_N, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG_N, entityId: ENT_N });
    for (const sku of ["FALLEN", "HOLDING", "NEVER", "ATZERO"]) {
      await addItem({ orgId: ORG_N, entityId: ENT_N, item: { sku, name: `Item ${sku}` } });
      // 100 units costing 1,000.00 — 10.00 each.
      await RN(sku, 100_000, 100_000, "2026-03-01");
    }
  });
  afterAll(async () => { await wipe(ORG_N); });

  it("writes stock down where net realisable value has fallen below cost", async () => {
    // IAS 2.9: 100 units that cost 10.00 are only worth 8.00 each now.
    const a = await nrv("FALLEN", 800, "2026-03-05");
    expect(a.costMinor).toBe("100000");
    expect(a.nrvTotalMinor).toBe("80000");
    expect(a.writeDownMinor).toBe("20000");
    expect(a.carryingMinor).toBe("80000");
    expect(a.atCost).toBe(false);
    expect(await linesOf(a.entryId!)).toEqual({ "5300": 20_000n, "1200": -20_000n });
  });

  it("records the same assessment once, however often it is sent", async () => {
    const before = await db.journalEntry.count({ where: { orgId: ORG_N, sourceType: { in: ["NRV_WRITE_DOWN", "NRV_REVERSAL"] } } });
    // Twice more, and on a later date, which is how a scheduled reassessment
    // arrives. The allowance is derived, so an unchanged figure asks for an
    // unchanged allowance and nothing posts.
    const again = await nrv("FALLEN", 800, "2026-03-05");
    const later = await nrv("FALLEN", 800, "2026-03-08");
    expect(again.entryId).toBeNull();
    expect(later.entryId).toBeNull();
    expect(again.writeDownMinor).toBe("20000");
    expect(await db.journalEntry.count({ where: { orgId: ORG_N, sourceType: { in: ["NRV_WRITE_DOWN", "NRV_REVERSAL"] } } })).toBe(before);
    expect((await row("FALLEN")).carryingMinor).toBe("80000");
  });

  it("does nothing where net realisable value is above cost", async () => {
    // 12.00 a unit against a 10.00 cost: nothing to write down, and nothing to
    // write up either — IAS 2.9 is a ceiling on carrying amount, not a market value.
    const a = await nrv("HOLDING", 1_200, "2026-03-05");
    expect(a.entryId).toBeNull();
    expect(a.writeDownMinor).toBe("0");
    expect(a.carryingMinor).toBe("100000");
    expect(a.atCost).toBe(true);
    // The assessment itself is still on the record.
    expect((await row("HOLDING")).nrvMinor).toBe("1200");
  });

  it("reverses a write-down when the circumstances go away, but never above cost", async () => {
    // IAS 2.33: 8.00 recovers to 9.00, so half the write-down comes back.
    const part = await nrv("FALLEN", 900, "2026-03-10");
    expect(part.writeDownMinor).toBe("10000");
    expect(await linesOf(part.entryId!)).toEqual({ "1200": 10_000n, "5300": -10_000n });

    // And on to 15.00, which is well above the 10.00 the goods cost. The
    // reversal stops at cost; the rest is a profit that has not been earned.
    const full = await nrv("FALLEN", 1_500, "2026-03-15");
    expect(full.nrvTotalMinor).toBe("150000");
    expect(full.writeDownMinor).toBe("0");
    expect(full.carryingMinor).toBe("100000");
    expect(full.carryingMinor).toBe(full.costMinor);
    expect(await linesOf(full.entryId!)).toEqual({ "1200": 10_000n, "5300": -10_000n });
  });

  it("keeps never assessed and assessed at nothing apart, all the way to the report", async () => {
    const zero = await nrv("ATZERO", 0, "2026-03-05");
    expect(zero.writeDownMinor).toBe("100000");
    expect(await linesOf(zero.entryId!)).toEqual({ "5300": 100_000n, "1200": -100_000n });

    const never = await row("NEVER");
    const atZero = await row("ATZERO");
    // Nobody has looked at NEVER, so it stands at cost and says nothing.
    expect(never.nrvMinor).toBeNull();
    expect(never.nrvTotalMinor).toBeNull();
    expect(never.carryingMinor).toBe("100000");
    // ATZERO has been looked at and is worth nothing. Same shaped row, opposite fact.
    expect(atZero.nrvMinor).toBe("0");
    expect(atZero.nrvTotalMinor).toBe("0");
    expect(atZero.carryingMinor).toBe("0");
    expect(atZero.writeDownMinor).toBe("100000");
  });

  it("refuses an assessment with no figure rather than reading it as nil", async () => {
    await expect(nrv("NEVER", null, "2026-03-05")).rejects.toThrow(/said out loud/i);
    await expect(assessNrv({ orgId: ORG_N, entityId: ENT_N, sku: "NEVER", nrvMinor: -1, on: "2026-03-05" }))
      .rejects.toThrow(/cannot be negative/i);
  });

  it("releases the write-down as the written-down stock is issued (IAS 2.34)", async () => {
    // ATZERO is carried at nil, so issuing half of it costs the business nothing
    // more: the cost of sales is met by releasing the allowance against it.
    const r = await issue({ orgId: ORG_N, entityId: ENT_N, sku: "ATZERO", movedOn: "2026-03-20", quantityMilli: 50_000 });
    expect(r.valueMinor).toBe("-50000");
    expect(r.writeDownMinor).toBe("50000");
    expect(r.carryingValueMinor).toBe("0");
    const release = await db.journalEntry.findFirst({
      where: { orgId: ORG_N, sourceType: "NRV_REVERSAL", entryDate: new Date("2026-03-20") },
    });
    expect(await linesOf(release!.id)).toEqual({ "1200": 50_000n, "5300": -50_000n });
    // Cost of sales and the release net to nothing: stock already written off to
    // nil costs nothing more to sell.
    expect(await linesOf(r.entryId!)).toEqual({ "5000": 50_000n, "1200": -50_000n });
  });

  it("ties the valuation to account 1200 with a write-down held", async () => {
    const v = await stockValuation({ orgId: ORG_N, entityId: ENT_N });
    expect(v.ledger.agrees).toBe(true);
    expect(v.ledger.differenceMinor).toBe("0");
    expect(v.totals.valueMinor).toBe(v.ledger.valueMinor);
    // Cost and carrying amount are different numbers and both are reported —
    // netting the write-down into cost would hide it.
    expect(v.totals.writeDownMinor).toBe("50000");
    expect(BigInt(v.totals.costMinor) - BigInt(v.totals.writeDownMinor)).toBe(BigInt(v.totals.carryingMinor));
  });

  it("draws the valuation at a past date from the movements, not from today", async () => {
    // On 2 March the stock was in and nothing had been assessed yet.
    const before = await stockValuation({ orgId: ORG_N, entityId: ENT_N, asOf: "2026-03-02" });
    expect(before.asOf).toBe("2026-03-02");
    expect(before.items.find((i) => i.sku === "FALLEN")!.carryingMinor).toBe("100000");
    expect(before.items.find((i) => i.sku === "FALLEN")!.writeDownMinor).toBe("0");
    expect(before.ledger.agrees).toBe(true);

    // On 6 March the 8.00 assessment had landed and the later recoveries had not,
    // so the balance sheet showed 800.00 with 200.00 held against it.
    const during = await stockValuation({ orgId: ORG_N, entityId: ENT_N, asOf: "2026-03-06" });
    const fallen = during.items.find((i) => i.sku === "FALLEN")!;
    expect(fallen.costMinor).toBe("100000");
    expect(fallen.writeDownMinor).toBe("20000");
    expect(fallen.carryingMinor).toBe("80000");
    expect(during.ledger.agrees).toBe(true);
  });

  it("shows the write-down beside the movements, as the entries it posted", async () => {
    const h = await itemHistory({ orgId: ORG_N, entityId: ENT_N, sku: "ATZERO" });
    expect(h.assessments.map((a) => a.kind)).toEqual(["NRV_WRITE_DOWN", "NRV_REVERSAL"]);
    expect(h.assessments[0].valueMinor).toBe("-100000");
    expect(h.assessments[1].valueMinor).toBe("50000");
    // Cost is untouched by the write-down, because IAS 2.33 needs it to still be
    // there if the assessment is reversed.
    expect(h.item.costMinor).toBe("50000");
    expect(h.item.nrvMinor).toBe("0");
    expect(h.item.carryingMinor).toBe("0");
    // And no write-down was smuggled in as a movement of stock: nothing moved.
    expect(h.movements.map((m) => m.kind)).toEqual(["RECEIPT", "ISSUE"]);
  });

  it("keeps the trial balance square through write-downs and reversals", async () => {
    const tb = await trialBalance({ orgId: ORG_N, entityId: ENT_N, periodLabel: "2026-03" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });
});

/* ------------------------------------------------- retries, and what they do */

const ORG_R = "t-org-inv-retry";
const ENT_R = "t-ent-inv-retry";

d("a retried movement", () => {
  const stock = () => db.inventoryItem.findFirstOrThrow({ where: { orgId: ORG_R, entityId: ENT_R, sku: "RETRY" } });
  const entries = (sourceType: string) =>
    db.journalEntry.count({ where: { orgId: ORG_R, source: "inventory", sourceType } });

  beforeAll(async () => {
    await wipe(ORG_R);
    await openFiscalYear({ orgId: ORG_R, entityId: ENT_R, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG_R, entityId: ENT_R });
    await addItem({ orgId: ORG_R, entityId: ENT_R, item: { sku: "RETRY", name: "Retried widget" } });
  });
  // The connection is closed once, after the last block in the file.
  afterAll(async () => { await wipe(ORG_R); });

  it("receives once when the goods received note is sent twice", async () => {
    const body = {
      orgId: ORG_R, entityId: ENT_R, sku: "RETRY", movedOn: "2026-04-02",
      quantityMilli: 100_000, valueMinor: 500_000, reference: "GRN-1001",
    };
    const first = await receive(body);
    const again = await receive(body);
    expect(again.replayed).toBe(true);
    expect(again.movementId).toBe(first.movementId);
    expect(again.entryId).toBe(first.entryId);
    // One receipt, one posting, one lot of stock.
    expect(await entries("RECEIPT")).toBe(1);
    expect((await stock()).quantityMilli).toBe(100_000n);
    expect((await stock()).valueMinor).toBe(500_000n);
    expect(await db.inventoryMovement.count({ where: { orgId: ORG_R, kind: "RECEIPT" } })).toBe(1);
  });

  it("issues once when the despatch note is sent twice", async () => {
    const body = { orgId: ORG_R, entityId: ENT_R, sku: "RETRY", movedOn: "2026-04-03", quantityMilli: 20_000, reference: "DN-2001" };
    const first = await issue(body);
    const again = await issue(body);
    expect(again.movementId).toBe(first.movementId);
    expect(await entries("ISSUE")).toBe(1);
    expect((await stock()).quantityMilli).toBe(80_000n);
    expect((await stock()).valueMinor).toBe(400_000n);
  });

  it("adjusts once when the count sheet is sent twice", async () => {
    const body = { orgId: ORG_R, entityId: ENT_R, sku: "RETRY", movedOn: "2026-04-04", countedMilli: 78_000, reference: "COUNT-Q2" };
    const first = await adjust(body);
    const again = await adjust(body);
    expect(again.movementId).toBe(first.movementId);
    expect(await entries("ADJUSTMENT")).toBe(1);
    expect((await stock()).quantityMilli).toBe(78_000n);
    // A repeated count sheet is the same count, not a count that agrees.
    expect(again.quantityMilli).toBe("-2000");
  });

  it("keys the posting on the position it moves the stock to, so a half-failed act cannot double-post", async () => {
    // The gap this closes: the entry posted, the movement did not, and the caller
    // retried. The retry starts from the same balances, so it asks for the same
    // key and gets the entry that already exists rather than a second one.
    const before = await stock();
    const key = `inventory:receipt:${before.id}:${before.quantityMilli + 10_000n}:${before.valueMinor + 50_000n}`;
    await receive({ orgId: ORG_R, entityId: ENT_R, sku: "RETRY", movedOn: "2026-04-05", quantityMilli: 10_000, valueMinor: 50_000 });
    const posted = await db.journalEntry.findMany({ where: { orgId: ORG_R, externalKey: key } });
    expect(posted.length).toBe(1);
    // Two genuine receipts on one day are two receipts: the second moves the item
    // to different balances, so it carries a different key and posts.
    await receive({ orgId: ORG_R, entityId: ENT_R, sku: "RETRY", movedOn: "2026-04-05", quantityMilli: 10_000, valueMinor: 50_000 });
    expect(await entries("RECEIPT")).toBe(3);
    expect((await stock()).quantityMilli).toBe(98_000n);
  });

  it("records both lines when one document carries the same item twice", async () => {
    // A goods received note against two order lines of the same SKU is two
    // receipts under one number, and procurement.ts sends them exactly that way.
    // The reference identifies the document; the movement's own description is
    // what tells the two lines apart.
    const line = (quantityMilli: number, valueMinor: number) => receive({
      orgId: ORG_R, entityId: ENT_R, sku: "RETRY", movedOn: "2026-04-06",
      quantityMilli, valueMinor, reference: "GRN-1002",
    });
    const a = await line(5_000, 25_000);
    const b = await line(7_000, 35_000);
    expect(b.movementId).not.toBe(a.movementId);
    expect(b.replayed).toBeUndefined();
    expect((await stock()).quantityMilli).toBe(110_000n);
    // And the first line, sent again, is still recognised as the same line.
    expect((await line(5_000, 25_000)).movementId).toBe(a.movementId);
    expect((await stock()).quantityMilli).toBe(110_000n);
  });

  it("still ties to the ledger after all of that", async () => {
    const v = await stockValuation({ orgId: ORG_R, entityId: ENT_R });
    expect(v.ledger.agrees).toBe(true);
    expect(v.ledger.differenceMinor).toBe("0");
  });
});

/* ------------------------------- locations, batches and levels, on paper --- */

describe("where the goods are, on paper", () => {
  it("puts what the caller said ahead of any default", () => {
    expect(resolveLocation("SHOP", "MAIN", "WH")).toBe("SHOP");
    expect(resolveLocation(null, "MAIN", "WH")).toBe("MAIN");
    expect(resolveLocation(null, null, "WH")).toBe("WH");
    // Nowhere is a real answer. A business with one shed should not have to
    // invent a warehouse before it can record a receipt.
    expect(resolveLocation(null, null, null)).toBeNull();
  });

  it("will not split a serial number", () => {
    expect(batchTake({ kind: "SERIAL", heldMilli: 1_000n, wantedMilli: 500n })).toEqual({ ok: false, reason: "serial-split" });
    expect(batchTake({ kind: "SERIAL", heldMilli: 1_000n, wantedMilli: 1_000n })).toEqual({ ok: true });
    // A batch, by contrast, goes as far as it holds and no further: taking more
    // means the next batch is going out, not that this one owes goods.
    expect(batchTake({ kind: "BATCH", heldMilli: 400n, wantedMilli: 500n })).toEqual({ ok: false, reason: "short", heldMilli: 400n });
    expect(batchTake({ kind: "BATCH", heldMilli: 400n, wantedMilli: 400n })).toEqual({ ok: true });
  });

  it("will not put two things behind one serial number", () => {
    expect(batchPut({ kind: "SERIAL", heldMilli: 1_000n, addingMilli: 1_000n })).toEqual({ ok: false, reason: "serial-reused" });
    expect(batchPut({ kind: "SERIAL", heldMilli: 0n, addingMilli: 2_000n })).toEqual({ ok: false, reason: "serial-split" });
    expect(batchPut({ kind: "SERIAL", heldMilli: 0n, addingMilli: 1_000n })).toEqual({ ok: true });
    expect(batchPut({ kind: "BATCH", heldMilli: 5_000n, addingMilli: 2_000n })).toEqual({ ok: true });
  });

  it("keeps no reorder level and a level of nothing apart", () => {
    const none = reorderVerdict({ quantityMilli: 0n, reorderLevelMilli: null, onOrderMilli: 0n });
    const zero = reorderVerdict({ quantityMilli: 0n, reorderLevelMilli: 0n, onOrderMilli: 0n });
    // Nobody has decided what low means for this item, which is not the same
    // fact as the item being fine.
    expect(none.monitored).toBe(false);
    expect(none.below).toBe(false);
    // A level of nothing means "tell me the moment it runs out", and it has.
    expect(zero.monitored).toBe(true);
    expect(zero.below).toBe(true);
    expect(zero.shortfallMilli).toBe(0n);
  });

  it("treats being exactly at the level as being below it", () => {
    const at = reorderVerdict({ quantityMilli: 50_000n, reorderLevelMilli: 50_000n, onOrderMilli: 0n });
    expect(at.below).toBe(true);
    expect(at.shortfallMilli).toBe(0n);
    expect(at.covered).toBe(false);
    // Goods on a lorry are not goods on a shelf: an order says somebody has
    // acted, it does not make the finding go away.
    const ordered = reorderVerdict({ quantityMilli: 10_000n, reorderLevelMilli: 50_000n, onOrderMilli: 100_000n });
    expect(ordered.below).toBe(true);
    expect(ordered.shortfallMilli).toBe(40_000n);
    expect(ordered.covered).toBe(true);
  });

  it("splits one carried value across locations without losing a fil", () => {
    const shares = apportion(1_000n, [1_000n, 1_000n, 1_000n]);
    expect(shares.reduce((a, s) => a + s, 0n)).toBe(1_000n);
    expect(shares.filter((s) => s === 334n).length).toBe(1);
    expect(apportion(1_000n, [1_000n, 3_000n])).toEqual([250n, 750n]);
    // The residue lands on the largest holding rather than being spread thinly.
    expect(apportion(100n, [1n, 2n])).toEqual([33n, 67n]);
    expect(apportion(0n, [5n, 5n])).toEqual([0n, 0n]);
  });

  it("ties a batch register to the item it describes", () => {
    expect(tieBatches(100_000n, 100_000n).agrees).toBe(true);
    const gap = tieBatches(100_000n, 90_000n);
    expect(gap.agrees).toBe(false);
    expect(gap.differenceMilli).toBe(10_000n);
  });
});

/* ------------------------------------------------------ stock by location --- */

const ORG_S = "t-org-inv-stock";
const ENT_S = "t-ent-inv-stock";

d("stock locations", () => {
  const loc = { orgId: ORG_S, entityId: ENT_S };
  const RS = (sku: string, qty: number, value: number, on: string, location?: string) =>
    receive({ orgId: ORG_S, entityId: ENT_S, sku, movedOn: on, quantityMilli: qty, valueMinor: value, location });
  const at = async (code: string | null, sku: string) => {
    const v = await stockByLocation(loc);
    return v.locations.find((l) => l.code === code)!.lines.find((l) => l.sku === sku) ?? null;
  };
  const stockRow = async () => {
    const tb = await trialBalance({ orgId: ORG_S, entityId: ENT_S, periodLabel: "2026-05" });
    return tb.rows.find((r) => r.code === "1200")?.balanceMinor ?? 0n;
  };

  beforeAll(async () => {
    await wipe(ORG_S);
    await openFiscalYear({ orgId: ORG_S, entityId: ENT_S, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG_S, entityId: ENT_S });
    await addLocation({ ...loc, code: "MAIN", name: "Main warehouse", isDefault: true });
    await addLocation({ ...loc, code: "SHOP", name: "Shop floor" });
    await addItem({ ...loc, item: { sku: "BOLT", name: "Bolt", uom: "EA" } });
    await addItem({ ...loc, item: { sku: "NUT", name: "Nut", uom: "EA" } });
    await RS("BOLT", 100_000, 500_000, "2026-05-01", "MAIN"); // 100 at 5.00
    await RS("BOLT", 40_000, 200_000, "2026-05-02", "SHOP");  // 40 at 5.00
  });
  afterAll(async () => { await wipe(ORG_S); });

  it("records where the goods landed and ties each location back to the item", async () => {
    expect((await at("MAIN", "BOLT"))!.quantityMilli).toBe("100000");
    expect((await at("SHOP", "BOLT"))!.quantityMilli).toBe("40000");
    const v = await stockByLocation(loc);
    const bolt = v.items.find((i) => i.sku === "BOLT")!;
    expect(bolt.quantityMilli).toBe("140000");
    expect(bolt.unassignedMilli).toBe("0");
    expect(bolt.agrees).toBe(true);
    // A location holds a quantity, never a cost of its own: the value column is
    // the item's own cost apportioned, and the shares add back exactly.
    expect(v.totals.differenceMinor).toBe("0");
    expect(v.totals.agrees).toBe(true);
    expect(BigInt((await at("MAIN", "BOLT"))!.valueMinor)).toBe(500_000n);
  });

  it("lands stock on the item's own shelf, then the entity's default", async () => {
    await RS("NUT", 10_000, 20_000, "2026-05-03"); // nobody said: MAIN is the entity default
    expect((await at("MAIN", "NUT"))!.quantityMilli).toBe("10000");
    await setDefaultLocation({ ...loc, sku: "NUT", location: "SHOP" });
    await RS("NUT", 10_000, 20_000, "2026-05-04"); // the item's own shelf now wins
    expect((await at("SHOP", "NUT"))!.quantityMilli).toBe("10000");
    expect((await at("MAIN", "NUT"))!.quantityMilli).toBe("10000");
  });

  it("transfers between locations and leaves the ledger exactly as it was", async () => {
    const before = await stockRow();
    const tbBefore = await trialBalance({ orgId: ORG_S, entityId: ENT_S, periodLabel: "2026-05" });
    const entriesBefore = await db.journalEntry.count({ where: { orgId: ORG_S } });
    const item = await db.inventoryItem.findFirstOrThrow({ where: { orgId: ORG_S, sku: "BOLT" } });

    const t = await transferStock({ ...loc, sku: "BOLT", from: "MAIN", to: "SHOP", quantityMilli: 25_000, on: "2026-05-10", reference: "TN-1" });
    expect(t.posted).toBe(false);
    expect(t.entryId).toBeNull();
    expect(t.fromHoldsMilli).toBe("75000");
    expect(t.toHoldsMilli).toBe("65000");

    // Two movements, not one: a single row cannot say that a quantity left A
    // and arrived at B, and if it cannot say that neither total is right.
    expect(await db.inventoryMovement.count({ where: { orgId: ORG_S, itemId: item.id, reference: "TRF/TN-1" } })).toBe(2);

    // The item stays the authority on quantity and value, and a transfer moved
    // neither — the goods never left the business.
    const after = await db.inventoryItem.findFirstOrThrow({ where: { id: item.id } });
    expect(after.quantityMilli).toBe(item.quantityMilli);
    expect(after.valueMinor).toBe(item.valueMinor);

    // And the ledger did not twitch.
    expect(await db.journalEntry.count({ where: { orgId: ORG_S } })).toBe(entriesBefore);
    expect(await stockRow()).toBe(before);
    const tb = await trialBalance({ orgId: ORG_S, entityId: ENT_S, periodLabel: "2026-05" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
    expect(tb.totalDebitMinor).toBe(tbBefore.totalDebitMinor);
    expect(tb.totalCreditMinor).toBe(tbBefore.totalCreditMinor);
    const v = await stockValuation({ orgId: ORG_S, entityId: ENT_S });
    expect(v.ledger.agrees).toBe(true);
  });

  it("records the transfer once when the note is sent twice", async () => {
    const again = await transferStock({ ...loc, sku: "BOLT", from: "MAIN", to: "SHOP", quantityMilli: 25_000, on: "2026-05-10", reference: "TN-1" });
    expect(again.replayed).toBe(true);
    expect(again.fromHoldsMilli).toBe("75000");
    expect(await db.inventoryMovement.count({ where: { orgId: ORG_S, reference: "TRF/TN-1" } })).toBe(2);
  });

  it("refuses to move more than the location holds, or to move nothing anywhere", async () => {
    await expect(transferStock({ ...loc, sku: "BOLT", from: "SHOP", to: "MAIN", quantityMilli: 999_000, on: "2026-05-11" }))
      .rejects.toThrow(/SHOP Shop floor holds 65 EA of BOLT/);
    await expect(transferStock({ ...loc, sku: "BOLT", from: "MAIN", to: "MAIN", quantityMilli: 1_000, on: "2026-05-11" }))
      .rejects.toThrow(/both ends of that transfer/i);
  });

  it("refuses to close a location that still holds stock, and says what is on the shelf", async () => {
    await expect(closeLocation({ ...loc, code: "SHOP" })).rejects.toThrow(/still holds 65 EA of BOLT/);
    await expect(closeLocation({ ...loc, code: "SHOP" })).rejects.toThrow(/still on the balance sheet/i);
    // Refused means refused.
    expect((await locationList(loc)).locations.find((l) => l.code === "SHOP")!.status).toBe("active");
  });

  it("closes a location once it has been emptied, and stops stock moving through it", async () => {
    await addLocation({ ...loc, code: "TEMP", name: "Temporary bay" });
    await RS("BOLT", 5_000, 25_000, "2026-05-12", "TEMP");
    await expect(closeLocation({ ...loc, code: "TEMP" })).rejects.toThrow(/still holds 5 EA of BOLT/);
    await transferStock({ ...loc, sku: "BOLT", from: "TEMP", to: "MAIN", quantityMilli: 5_000, on: "2026-05-13" });
    expect((await closeLocation({ ...loc, code: "TEMP" })).status).toBe("closed");
    await expect(RS("BOLT", 1_000, 5_000, "2026-05-14", "TEMP")).rejects.toThrow(/is closed/i);
  });

  it("refuses to close the location everything lands in by default", async () => {
    await addLocation({ ...loc, code: "SPARE", name: "Spare bay", isDefault: true });
    // One default or none — the old one steps down as the new one takes over.
    expect((await locationList(loc)).locations.filter((l) => l.isDefault).map((l) => l.code)).toEqual(["SPARE"]);
    await expect(closeLocation({ ...loc, code: "SPARE" })).rejects.toThrow(/where stock lands when nobody says/i);
    await updateLocation({ ...loc, code: "MAIN", isDefault: true });
    expect((await locationList(loc)).locations.filter((l) => l.isDefault).map((l) => l.code)).toEqual(["MAIN"]);
  });

  it("reports stock nobody placed as unassigned rather than dropping it", async () => {
    await updateLocation({ ...loc, code: "MAIN", isDefault: false });
    await addItem({ ...loc, item: { sku: "WASHER", name: "Washer" } });
    await RS("WASHER", 8_000, 16_000, "2026-05-15");
    const v = await stockByLocation(loc);
    const nowhere = v.locations.find((l) => !l.assigned)!;
    expect(nowhere.code).toBeNull();
    expect(nowhere.lines.find((l) => l.sku === "WASHER")!.quantityMilli).toBe("8000");
    const washer = v.items.find((i) => i.sku === "WASHER")!;
    expect(washer.unassignedMilli).toBe("8000");
    expect(washer.locatedMilli).toBe("0");
    // Dropping it is exactly what would make the total stop tying.
    expect(washer.agrees).toBe(true);
    expect(v.totals.agrees).toBe(true);
    await updateLocation({ ...loc, code: "MAIN", isDefault: true });
  });

  it("draws stock by location at a past date from the movements", async () => {
    // On 1 May the second delivery had not arrived, so the shop floor was empty.
    const then = await stockByLocation({ ...loc, asOf: "2026-05-01" });
    expect(then.asOf).toBe("2026-05-01");
    expect(then.locations.find((l) => l.code === "MAIN")!.lines.find((l) => l.sku === "BOLT")!.quantityMilli).toBe("100000");
    expect(then.locations.find((l) => l.code === "SHOP")!.lines.length).toBe(0);
    expect(then.items.find((i) => i.sku === "BOLT")!.agrees).toBe(true);
    expect(then.totals.agrees).toBe(true);
  });
});

/* -------------------------------------------- batches, serials and expiry --- */

const ORG_B = "t-org-inv-batch";
const ENT_B = "t-ent-inv-batch";

d("batches, serials and expiry", () => {
  const ctx = { orgId: ORG_B, entityId: ENT_B };
  const RB = (sku: string, qty: number, value: number, on: string, batch: { code: string; kind?: string; expiresOn?: string }) =>
    receive({ ...ctx, sku, movedOn: on, quantityMilli: qty, valueMinor: value, batch });
  const IB = (sku: string, qty: number, on: string, batch?: string) =>
    issue({ ...ctx, sku, movedOn: on, quantityMilli: qty, batch });

  beforeAll(async () => {
    await wipe(ORG_B);
    await openFiscalYear({ orgId: ORG_B, entityId: ENT_B, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG_B, entityId: ENT_B });
    await addLocation({ ...ctx, code: "STORE", name: "Cold store", isDefault: true });
    await addItem({ ...ctx, item: { sku: "PILL", name: "Perishable", uom: "EA" } });
    await addItem({ ...ctx, item: { sku: "PUMP", name: "Serialised pump", uom: "EA" } });
  });
  afterAll(async () => { await wipe(ORG_B); });

  it("records which batch arrived, and ties the batches to the item", async () => {
    await RB("PILL", 100_000, 100_000, "2026-06-01", { code: "L-1", expiresOn: "2026-06-20" });
    await RB("PILL", 50_000, 60_000, "2026-06-02", { code: "L-2", expiresOn: "2026-12-31" });

    const reg = await batchRegister({ ...ctx, sku: "PILL" });
    expect(reg.batches.map((b) => b.code)).toEqual(["L-1", "L-2"]);
    expect(reg.batches.map((b) => b.quantityMilli)).toEqual(["100000", "50000"]);
    expect(reg.batches.map((b) => b.location)).toEqual(["STORE", "STORE"]);
    const tie = reg.reconciliation.items.find((r) => r.sku === "PILL")!;
    expect(tie.itemMilli).toBe("150000");
    expect(tie.batchMilli).toBe("150000");
    expect(tie.differenceMilli).toBe("0");
    expect(tie.agrees).toBe(true);
    expect(reg.reconciliation.agrees).toBe(true);
    // Each batch carries its share of the item's cost, and the shares add back.
    expect(reg.batches.reduce((a, b) => a + BigInt(b.valueMinor), 0n)).toBe(160_000n);
  });

  it("refuses an issue that does not say which batch left", async () => {
    await expect(IB("PILL", 10_000, "2026-06-05")).rejects.toThrow(/tracked by batch/i);
    await expect(IB("PILL", 10_000, "2026-06-05")).rejects.toThrow(/recall becomes impossible to trace/i);
    // Refused means refused: nothing moved and nothing posted.
    const item = await db.inventoryItem.findFirstOrThrow({ where: { orgId: ORG_B, sku: "PILL" } });
    expect(item.quantityMilli).toBe(150_000n);
  });

  it("refuses a receipt into a batch-tracked item that names no batch", async () => {
    await expect(receive({ ...ctx, sku: "PILL", movedOn: "2026-06-05", quantityMilli: 10_000, valueMinor: 10_000 }))
      .rejects.toThrow(/no later issue could name/i);
  });

  it("takes the batch that was named, and only that one", async () => {
    const r = await IB("PILL", 20_000, "2026-06-06", "L-2");
    expect(r.balanceQtyMilli).toBe("130000");
    const reg = await batchRegister({ ...ctx, sku: "PILL" });
    expect(reg.batches.find((b) => b.code === "L-1")!.quantityMilli).toBe("100000");
    expect(reg.batches.find((b) => b.code === "L-2")!.quantityMilli).toBe("30000");
    expect(reg.reconciliation.items[0].agrees).toBe(true);
    // And the movement says which lot it was, so a recall has something to go on.
    const h = await itemHistory({ ...ctx, sku: "PILL" });
    expect(h.movements[h.movements.length - 1].batch).toBe("L-2");
  });

  it("refuses to take more out of a batch than it holds", async () => {
    await expect(IB("PILL", 40_000, "2026-06-07", "L-2")).rejects.toThrow(/holds 30 EA/);
    await expect(IB("PILL", 40_000, "2026-06-07", "L-2")).rejects.toThrow(/next batch is going out/i);
    await expect(IB("PILL", 1_000, "2026-06-07", "L-9")).rejects.toThrow(/no batch L-9/i);
  });

  it("refuses to record one batch under two expiry dates", async () => {
    await expect(RB("PILL", 10_000, 10_000, "2026-06-08", { code: "L-2", expiresOn: "2027-01-31" }))
      .rejects.toThrow(/already expires on 2026-12-31/);
  });

  it("will not split a serial number, or hang two things off one", async () => {
    await RB("PUMP", 1_000, 250_000, "2026-06-03", { code: "SN-001", kind: "SERIAL" });
    await expect(RB("PUMP", 2_000, 500_000, "2026-06-04", { code: "SN-002", kind: "SERIAL" }))
      .rejects.toThrow(/cannot be split/i);
    await expect(RB("PUMP", 1_000, 250_000, "2026-06-04", { code: "SN-001", kind: "SERIAL" }))
      .rejects.toThrow(/already on the shelf/i);
    // What a code is was settled the first time it was seen.
    await expect(RB("PUMP", 5_000, 10_000, "2026-06-04", { code: "SN-001", kind: "BATCH" }))
      .rejects.toThrow(/One code cannot be both/i);
    // Half a serial number identifies half a thing, which is nothing.
    await expect(IB("PUMP", 500, "2026-06-05", "SN-001")).rejects.toThrow(/goes whole or not at all/i);

    const out = await IB("PUMP", 1_000, "2026-06-06", "SN-001");
    expect(out.balanceQtyMilli).toBe("0");
    const reg = await batchRegister({ ...ctx, sku: "PUMP" });
    expect(reg.batches.map((b) => b.code)).toEqual(["SN-001"]);
    expect(reg.batches[0].kind).toBe("SERIAL");
    expect(reg.batches[0].status).toBe("consumed");
    expect(reg.reconciliation.items[0].agrees).toBe(true);
  });

  it("reports what has gone off apart from what is about to", async () => {
    const near = await expiringStock({ ...ctx, within: 30, asOf: "2026-06-25" });
    expect(near.expired.map((b) => b.code)).toEqual(["L-1"]);
    expect(near.expired[0].daysToExpiry).toBe(-5);
    expect(near.expiring.map((b) => b.code)).toEqual([]);
    expect(BigInt(near.totals.expiredValueMinor)).toBeGreaterThan(0n);

    const wide = await expiringStock({ ...ctx, within: 400, asOf: "2026-06-25" });
    expect(wide.expiring.map((b) => b.code)).toEqual(["L-2"]);
    expect(wide.horizon).toBe("2027-07-30");
  });

  it("quarantines expired stock without saying anything about what it is worth", async () => {
    const before = await db.journalEntry.count({ where: { orgId: ORG_B } });
    const q = await sweepExpired({ ...ctx, on: "2026-06-25", action: "quarantine" });
    expect(q.swept.map((s) => s.code)).toEqual(["L-1"]);
    expect(q.totals.valueMinor).toBe("0");
    // Quarantine is a decision about sale, not about value, so it posts nothing.
    expect(await db.journalEntry.count({ where: { orgId: ORG_B } })).toBe(before);
    await expect(IB("PILL", 1_000, "2026-06-26", "L-1")).rejects.toThrow(/quarantined/i);
  });

  it("writes expired stock off through the ledger, because it is worth nothing", async () => {
    const w = await sweepExpired({ ...ctx, on: "2026-06-27", action: "write_off" });
    expect(w.swept.length).toBe(1);
    const swept = w.swept[0];
    expect(swept.code).toBe("L-1");
    expect(swept.status).toBe("expired");
    // 100 of the 130 on hand, at the 1,066.66… weighted average behind them.
    expect(w.totals.valueMinor).toBe("106666");
    // To stock variance, not to cost of sales: a business that cannot see what
    // it threw away cannot stop throwing it away.
    expect(await linesOf(swept.entryId!)).toEqual({ "5300": 106_666n, "1200": -106_666n });

    const item = await db.inventoryItem.findFirstOrThrow({ where: { orgId: ORG_B, sku: "PILL" } });
    expect(item.quantityMilli).toBe(30_000n);
    expect(item.valueMinor).toBe(32_001n);
    const reg = await batchRegister({ ...ctx, sku: "PILL" });
    expect(reg.batches.find((b) => b.code === "L-1")!.status).toBe("expired");
    expect(reg.batches.find((b) => b.code === "L-1")!.quantityMilli).toBe("0");
    // The register still ties to the item after the sweep.
    expect(reg.reconciliation.items[0].batchMilli).toBe("30000");
    expect(reg.reconciliation.agrees).toBe(true);
  });

  it("does not write the same batch off twice, and still ties to the ledger", async () => {
    const entries = await db.journalEntry.count({ where: { orgId: ORG_B } });
    const again = await sweepExpired({ ...ctx, on: "2026-06-27", action: "write_off" });
    expect(again.swept.length).toBe(0);
    expect(await db.journalEntry.count({ where: { orgId: ORG_B } })).toBe(entries);

    const v = await stockValuation(ctx);
    expect(v.ledger.agrees).toBe(true);
    expect(v.ledger.differenceMinor).toBe("0");
    const tb = await trialBalance({ orgId: ORG_B, entityId: ENT_B, periodLabel: "2026-06" });
    expect(tb.balanced).toBe(true);
  });
});

/* ------------------------------------------------------------ reorder levels */

const ORG_O = "t-org-inv-reorder";
const ENT_O = "t-ent-inv-reorder";

d("reorder levels", () => {
  const ctx = { orgId: ORG_O, entityId: ENT_O };

  beforeAll(async () => {
    await wipe(ORG_O);
    await openFiscalYear({ orgId: ORG_O, entityId: ENT_O, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG_O, entityId: ENT_O });
    for (const [sku, name] of [["SCREW", "Screw"], ["GLUE", "Glue"], ["PAINT", "Paint"], ["TAPE", "Tape"]]) {
      await addItem({ ...ctx, item: { sku, name } });
    }
    await receive({ ...ctx, sku: "SCREW", movedOn: "2026-07-01", quantityMilli: 40_000, valueMinor: 40_000 });
    await receive({ ...ctx, sku: "PAINT", movedOn: "2026-07-01", quantityMilli: 5_000, valueMinor: 50_000 });
    await receive({ ...ctx, sku: "TAPE", movedOn: "2026-07-01", quantityMilli: 200_000, valueMinor: 100_000 });
    // GLUE is deliberately never received: it stands at nothing.
    await setReorderLevel({ ...ctx, sku: "SCREW", reorderLevelMilli: 50_000 });
    await setReorderLevel({ ...ctx, sku: "GLUE", reorderLevelMilli: 0 });
    await setReorderLevel({ ...ctx, sku: "TAPE", reorderLevelMilli: 50_000 });
    // PAINT is deliberately left without a level.

    const order = await createOrder({
      ...ctx,
      order: {
        number: "PO-500", supplierName: "Fasteners LLC", orderedOn: "2026-07-02", expectedOn: "2026-07-20",
        lines: [{ description: "Screws", sku: "SCREW", quantityMilli: 100_000, unitPriceMinor: 100 }],
      },
    });
    await issueOrder({ orgId: ORG_O, orderId: order.id });
  });
  afterAll(async () => { await wipe(ORG_O); await db.$disconnect(); });

  it("keeps a nil level and a level of nothing apart, all the way to the report", async () => {
    const r = await belowReorderLevel(ctx);
    const skus = r.items.map((i) => i.sku);
    expect(skus).toContain("SCREW");
    // A level of nothing means "tell me the moment it runs out", and GLUE has.
    expect(skus).toContain("GLUE");
    // Nobody has set a level for PAINT, so it is not below one — and it is not
    // fine either, which is why it is reported rather than left out.
    expect(skus).not.toContain("PAINT");
    expect(r.unmonitored.map((i) => i.sku)).toEqual(["PAINT"]);
    // TAPE has a level and is comfortably above it.
    expect(skus).not.toContain("TAPE");
    expect(r.monitored).toBe(3);

    const glue = r.items.find((i) => i.sku === "GLUE")!;
    expect(glue.reorderLevelMilli).toBe("0");
    expect(glue.shortfallMilli).toBe("0");
    expect(glue.atLevel).toBe(true);
    expect(glue.covered).toBe(false);
  });

  it("says what is already on order without pretending it is on the shelf", async () => {
    const r = await belowReorderLevel(ctx);
    const screw = r.items.find((i) => i.sku === "SCREW")!;
    expect(screw.quantityMilli).toBe("40000");
    expect(screw.reorderLevelMilli).toBe("50000");
    expect(screw.shortfallMilli).toBe("10000");
    // Read off procurement's own idea of what is still outstanding.
    expect(screw.onOrderMilli).toBe("100000");
    expect(screw.orders.map((o) => o.number)).toEqual(["PO-500"]);
    expect(screw.orders[0].expectedOn).toBe("2026-07-20");
    // Still below its level: goods on a lorry are not goods on a shelf.
    expect(screw.covered).toBe(true);
    expect(r.totals.below).toBe(2);
    expect(r.totals.covered).toBe(1);
  });

  it("clears a level rather than reading an empty field as nothing", async () => {
    const cleared = await setReorderLevel({ ...ctx, sku: "GLUE", reorderLevelMilli: null });
    expect(cleared.reorderLevelMilli).toBeNull();
    expect(cleared.monitored).toBe(false);
    const r = await belowReorderLevel(ctx);
    expect(r.items.map((i) => i.sku)).not.toContain("GLUE");
    expect(r.unmonitored.map((i) => i.sku).sort()).toEqual(["GLUE", "PAINT"]);
    expect(r.monitored).toBe(2);
    await expect(setReorderLevel({ ...ctx, sku: "GLUE", reorderLevelMilli: -1 })).rejects.toThrow(/cannot be negative/i);
  });
});
