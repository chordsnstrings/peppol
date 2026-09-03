import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  largestRemainder, spreadCharges, createVoucher, applyVoucher, cancelVoucher,
  voucherDetail, voucherList, landedCostReport, recordMeasure, measureList,
  type AllocatableLine,
} from "@/lib/server/ledger/landed-cost";
import { addItem, receive, issue, assessNrv, setCostMethod, stockValuation, itemHistory } from "@/lib/server/ledger/inventory";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-lc";
const ENT = "t-ent-lc";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "LandedCostAllocation" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "LandedCostLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "LandedCostCharge" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "LandedCostVoucher" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "LandedCostMeasure" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryMovement" WHERE "orgId" = '${ORG}'`),
    // Replica mode disables the foreign keys, so layers and batches do not
    // cascade away with the items and have to be cleared in their own right.
    db.$executeRawUnsafe(`DELETE FROM "InventoryLayer" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "StockBatch" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "StockLocation" WHERE "orgId" = '${ORG}'`),
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

/** The journal lines of one entry, by account code, in signed minor units. */
async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true } });
  const out: Record<string, bigint> = {};
  for (const r of rows) out[r.account.code] = (out[r.account.code] ?? 0n) + r.txnAmountMinor;
  return out;
}

const costOf = async (sku: string) => {
  const v = await stockValuation(S);
  return v.items.find((i) => i.sku === sku)!;
};

/* ============================================================= the arithmetic */

describe("largest-remainder allocation", () => {
  it("splits a charge that does not divide evenly and still adds back to it exactly", () => {
    // AED 1,000.00 over three equal items: 333.34 / 333.33 / 333.33.
    const shares = largestRemainder(100_000n, [1n, 1n, 1n]);
    expect(shares.map(String)).toEqual(["33334", "33333", "33333"]);
    expect(shares.reduce((a, s) => a + s, 0n)).toBe(100_000n);
  });

  it("gives the spare fils to the shares most nearly entitled to them", () => {
    // 10.00 over weights 7, 11 and 13 (31 in all).
    //   7  -> 7000/31  = 225.80  floored 225, remainder 25
    //   11 -> 11000/31 = 354.83  floored 354, remainder 26
    //   13 -> 13000/31 = 419.35  floored 419, remainder 11
    // 998 allocated, so two fils are left: they go to the 26 and then the 25.
    const shares = largestRemainder(1_000n, [7n, 11n, 13n]);
    expect(shares.map(String)).toEqual(["226", "355", "419"]);
    expect(shares.reduce((a, s) => a + s, 0n)).toBe(1_000n);
  });

  it("never hands out a negative share, however awkward the split", () => {
    for (const total of [1n, 2n, 7n, 99n, 100_001n]) {
      for (const weights of [[1n, 1n, 1n], [1n, 0n, 5_000n], [3n, 3n, 3n, 3n, 3n, 3n, 3n]]) {
        const shares = largestRemainder(total, weights);
        expect(shares.reduce((a, s) => a + s, 0n)).toBe(total);
        for (const s of shares) expect(s >= 0n).toBe(true);
      }
    }
  });

  it("gives a lone fil to one line rather than a third of a fil to three", () => {
    expect(largestRemainder(1n, [1n, 1n, 1n]).map(String)).toEqual(["1", "0", "0"]);
  });

  it("refuses to spread a charge over weights that are all nothing", () => {
    expect(() => largestRemainder(100n, [0n, 0n])).toThrow(/nothing to spread it over/i);
  });

  it("refuses a negative charge and a negative weight", () => {
    expect(() => largestRemainder(-1n, [1n])).toThrow(/cannot be negative/i);
    expect(() => largestRemainder(100n, [1n, -1n])).toThrow(/negative weight/i);
  });
});

describe("spreading charges over lots", () => {
  const lots: AllocatableLine[] = [
    { sku: "P", quantityMilli: 10_000n, valueMinor: 10_000n, onHandMilli: 10_000n, weightMilli: 40_000_000n, volumeMilli: null },
    { sku: "Q", quantityMilli: 10_000n, valueMinor: 30_000n, onHandMilli: 10_000n, weightMilli: 10_000_000n, volumeMilli: null },
  ];

  it("follows a different basis for each charge on one voucher", () => {
    // Duty 400.00 by value (100.00 : 300.00) is 100.00 and 300.00.
    // Freight 500.00 by weight (40 kg : 10 kg) is 400.00 and 100.00.
    const s = spreadCharges(
      [
        { description: "Customs duty", amountMinor: 40_000n, basis: "VALUE" },
        { description: "Ocean freight", amountMinor: 50_000n, basis: "WEIGHT" },
      ],
      lots,
    );
    expect(s.shares[0].map((x) => x.allocatedMinor.toString())).toEqual(["10000", "30000"]);
    expect(s.shares[1].map((x) => x.allocatedMinor.toString())).toEqual(["40000", "10000"]);
    expect(s.lines.map((l) => l.allocatedMinor.toString())).toEqual(["50000", "40000"]);
    expect(s.totals.chargeMinor).toBe(90_000n);
    expect(s.totals.inventoryMinor + s.totals.cogsMinor).toBe(90_000n);
  });

  it("refuses a weight basis where an item has no weight, and names it", () => {
    const noWeight = [lots[0], { ...lots[1], weightMilli: null }];
    expect(() => spreadCharges([{ description: "Freight", amountMinor: 50_000n, basis: "WEIGHT" }], noWeight))
      .toThrow(/Q have none recorded|Q has none recorded/);
  });

  it("puts the whole share of a lot that has all gone into cost of sales", () => {
    const gone = [{ ...lots[0], onHandMilli: 0n }];
    const s = spreadCharges([{ description: "Freight", amountMinor: 50_000n, basis: "QUANTITY" }], gone);
    expect(s.lines[0].inventoryMinor).toBe(0n);
    expect(s.lines[0].cogsMinor).toBe(50_000n);
  });
});

/* ================================================================ end to end */

d("landed cost", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ ...S, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);

    // Three identical lots on one shipment, so an uneven split is provable.
    for (const sku of ["LC-A", "LC-B", "LC-C"]) {
      await addItem({ ...S, item: { sku, name: `Item ${sku}`, uom: "ea" } });
      await receive({ ...S, sku, movedOn: "2026-02-01", quantityMilli: 10_000n, valueMinor: 10_000n, reference: "GRN-LC-1" });
    }

    // A hundred units at 10.00, sixty of them sold before the freight bill came.
    await addItem({ ...S, item: { sku: "LC-SOLD", name: "Sold before the invoice", uom: "ea" } });
    await receive({ ...S, sku: "LC-SOLD", movedOn: "2026-02-01", quantityMilli: 100_000n, valueMinor: 100_000n, reference: "GRN-LC-2" });
    await issue({ ...S, sku: "LC-SOLD", movedOn: "2026-02-05", quantityMilli: 60_000n, reference: "DN-LC-1" });

    // Five kilos each against one kilo each, for a freight bill by weight.
    for (const sku of ["LC-HEAVY", "LC-LIGHT"]) {
      await addItem({ ...S, item: { sku, name: `Item ${sku}`, uom: "ea" } });
      await receive({ ...S, sku, movedOn: "2026-02-01", quantityMilli: 10_000n, valueMinor: 20_000n, reference: "GRN-LC-3" });
    }
    await recordMeasure({ ...S, sku: "LC-HEAVY", unitWeightMilli: 5_000_000n });

    // Duty by value and freight by weight, pulling in opposite directions.
    await addItem({ ...S, item: { sku: "LC-P", name: "Light and dear", uom: "ea" } });
    await addItem({ ...S, item: { sku: "LC-Q", name: "Heavy and cheap", uom: "ea" } });
    await receive({ ...S, sku: "LC-P", movedOn: "2026-02-01", quantityMilli: 10_000n, valueMinor: 10_000n, reference: "GRN-LC-4" });
    await receive({ ...S, sku: "LC-Q", movedOn: "2026-02-01", quantityMilli: 10_000n, valueMinor: 30_000n, reference: "GRN-LC-4" });
    await recordMeasure({ ...S, sku: "LC-P", unitWeightMilli: 4_000_000n, unitVolumeMilli: 1_000n });
    await recordMeasure({ ...S, sku: "LC-Q", unitWeightMilli: 1_000_000n, unitVolumeMilli: 9_000n });

    // A first-in-first-out item, so the charge has to reach the layer as well.
    await addItem({ ...S, item: { sku: "LC-FIFO", name: "Costed in layers", uom: "ea" } });
    await setCostMethod({ ...S, sku: "LC-FIFO", costMethod: "FIFO" });
    await receive({ ...S, sku: "LC-FIFO", movedOn: "2026-02-01", quantityMilli: 20_000n, valueMinor: 20_000n, reference: "GRN-LC-5" });
    await issue({ ...S, sku: "LC-FIFO", movedOn: "2026-02-04", quantityMilli: 5_000n, reference: "DN-LC-2" });
  });

  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------- raising a voucher */

  it("resolves the goods from the notes they came in under", async () => {
    const v = await createVoucher({
      ...S,
      voucher: {
        number: "LCV-1", shipmentRef: "CONT-1", voucherDate: "2026-02-10",
        charges: [{ description: "Customs duty", amountMinor: 100_000n, accountCode: "5200", basis: "VALUE" }],
        receipts: ["GRN-LC-1"],
      },
    });
    expect(v.lineCount).toBe(3);
    expect(v.status).toBe("draft");
  });

  it("shows what it would do before it does it, and posts nothing meanwhile", async () => {
    const before = await db.journalEntry.count({ where: { orgId: ORG, sourceType: "LANDED_COST" } });
    const plan = await voucherDetail({ ...S, number: "LCV-1" });
    expect(plan.applied).toBe(false);
    expect(plan.refusal).toBeNull();
    expect(plan.lines.map((l) => l.allocatedMinor)).toEqual(["33334", "33333", "33333"]);
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceType: "LANDED_COST" } })).toBe(before);
  });

  it("refuses a note nothing came in under", async () => {
    await expect(createVoucher({
      ...S,
      voucher: {
        number: "LCV-BAD", shipmentRef: "CONT-X", voucherDate: "2026-02-10",
        charges: [{ description: "Freight", amountMinor: 1_000n, accountCode: "5200" }],
        receipts: ["GRN-NOPE"],
      },
    })).rejects.toThrow(/No stock was received under GRN-NOPE/);
  });

  it("refuses a charge that lands before the goods arrived", async () => {
    await expect(createVoucher({
      ...S,
      voucher: {
        number: "LCV-EARLY", shipmentRef: "CONT-1", voucherDate: "2026-01-15",
        charges: [{ description: "Freight", amountMinor: 1_000n, accountCode: "5200" }],
        receipts: ["GRN-LC-1"],
      },
    })).rejects.toThrow(/after the voucher date/);
  });

  it("refuses a charge sitting in an account that does not exist", async () => {
    await expect(createVoucher({
      ...S,
      voucher: {
        number: "LCV-ACCT", shipmentRef: "CONT-1", voucherDate: "2026-02-10",
        charges: [{ description: "Freight", amountMinor: 1_000n, accountCode: "9999" }],
        receipts: ["GRN-LC-1"],
      },
    })).rejects.toThrow(/9999 does not exist/);
  });

  it("refuses a charge of nothing and a basis that is not one of the four", async () => {
    const base = { shipmentRef: "CONT-1", voucherDate: "2026-02-10", receipts: ["GRN-LC-1"] };
    await expect(createVoucher({
      ...S,
      voucher: { ...base, number: "LCV-Z", charges: [{ description: "Freight", amountMinor: 0n, accountCode: "5200" }] },
    })).rejects.toThrow(/above nothing/);
    await expect(createVoucher({
      ...S,
      voucher: { ...base, number: "LCV-Z", charges: [{ description: "Freight", amountMinor: 100n, accountCode: "5200", basis: "GUESS" }] },
    })).rejects.toThrow(/not a way of spreading a charge/);
  });

  /* ---------------------------------------------------- the uneven allocation */

  it("lands a charge that does not divide, to the fil, and lifts the unit cost", async () => {
    // Three lots of ten at 100.00 each. Customs duty of 1,000.00 by value
    // splits 333.34 / 333.33 / 333.33 — 100,000 fils in all, not 99,999.
    const applied = await applyVoucher({ ...S, number: "LCV-1" });
    expect(applied.applied).toBe(true);
    expect(applied.totals.chargeMinor).toBe("100000");
    expect(applied.totals.inventoryMinor).toBe("100000");
    expect(applied.totals.cogsMinor).toBe("0");

    const allocated = applied.lines.map((l) => l.allocatedMinor);
    expect(allocated).toEqual(["33334", "33333", "33333"]);
    expect(allocated.reduce((a, s) => a + BigInt(s), 0n)).toBe(100_000n);

    // 100.00 for ten units was 10.00 each; 433.34 for ten is 43.334, floored.
    expect(applied.lines[0].unitCostBeforeMinor).toBe("1000");
    expect(applied.lines[0].unitCostAfterMinor).toBe("4333");

    const posted = await linesOf(applied.entryId!);
    expect(posted["1200"]).toBe(100_000n);
    expect(posted["5200"]).toBe(-100_000n);

    expect((await costOf("LC-A")).costMinor).toBe("43334");
    expect((await costOf("LC-B")).costMinor).toBe("43333");
    expect((await costOf("LC-C")).costMinor).toBe("43333");
  });

  it("posts once however often it is applied", async () => {
    const again = await applyVoucher({ ...S, number: "LCV-1" });
    expect(again.replayed).toBe(true);
    const entries = await db.journalEntry.count({ where: { orgId: ORG, sourceType: "LANDED_COST", sourceId: { not: null } } });
    const mine = await db.journalEntry.findMany({
      where: { orgId: ORG, sourceType: "LANDED_COST" },
      select: { memo: true },
    });
    expect(mine.filter((m) => m.memo?.includes("LCV-1")).length).toBe(1);
    expect(entries).toBeGreaterThan(0);
    // And the goods did not take the cost twice.
    expect((await costOf("LC-A")).costMinor).toBe("43334");
    const movements = await db.inventoryMovement.count({
      where: { orgId: ORG, kind: "LANDED_COST", reference: "LCV-1/1" },
    });
    expect(movements).toBe(1);
  });

  it("refuses to cancel a voucher whose cost has already reached the goods", async () => {
    await expect(cancelVoucher({ ...S, number: "LCV-1" })).rejects.toThrow(/Reverse the entry it posted/);
  });

  /* -------------------------------------------------- stock already sold */

  it("splits the charge between the stock left and the stock already sold", async () => {
    // A hundred units at 10.00 landed; sixty sold before the freight bill of
    // 500.00 arrived. Forty are left, so 500.00 x 40/100 = 200.00 goes onto the
    // shelf and the other 300.00 goes to cost of sales, where the sixty units'
    // own cost already went.
    await createVoucher({
      ...S,
      voucher: {
        number: "LCV-2", shipmentRef: "CONT-2", voucherDate: "2026-02-10",
        charges: [{ description: "Ocean freight", amountMinor: 50_000n, accountCode: "5200", basis: "QUANTITY" }],
        receipts: ["GRN-LC-2"],
      },
    });
    const applied = await applyVoucher({ ...S, number: "LCV-2" });

    expect(applied.lines[0].quantityMilli).toBe("100000");
    expect(applied.lines[0].onHandMilli).toBe("40000");
    expect(applied.lines[0].soldMilli).toBe("60000");
    expect(applied.lines[0].allocatedMinor).toBe("50000");
    expect(applied.lines[0].inventoryMinor).toBe("20000");
    expect(applied.lines[0].cogsMinor).toBe("30000");

    const posted = await linesOf(applied.entryId!);
    expect(posted["1200"]).toBe(20_000n);
    expect(posted["5000"]).toBe(30_000n);
    expect(posted["5200"]).toBe(-50_000n);

    // Forty units that cost 10.00 each and bore 5.00 of freight each: 15.00.
    const item = await costOf("LC-SOLD");
    expect(item.quantityMilli).toBe("40000");
    expect(item.costMinor).toBe("60000");
    expect(item.unitCostMinor).toBe("1500");
  });

  it("records the cost-only movement as a landed cost, moving no quantity", async () => {
    const h = await itemHistory({ ...S, sku: "LC-SOLD" });
    const landed = h.movements.find((m) => m.kind === "LANDED_COST")!;
    expect(landed.quantityMilli).toBe("0");
    expect(landed.valueMinor).toBe("20000");
    expect(landed.balanceQtyMilli).toBe("40000");
    expect(landed.balanceValueMinor).toBe("60000");
    expect(landed.entryId).not.toBeNull();
  });

  /* ------------------------------------------------------- weight and volume */

  it("refuses a freight bill by weight where an item has no weight, and names it", async () => {
    await createVoucher({
      ...S,
      voucher: {
        number: "LCV-3", shipmentRef: "CONT-3", voucherDate: "2026-02-10",
        charges: [{ description: "Air freight", amountMinor: 60_000n, accountCode: "5200", basis: "WEIGHT" }],
        receipts: ["GRN-LC-3"],
      },
    });
    await expect(applyVoucher({ ...S, number: "LCV-3" })).rejects.toThrow(/no weight is recorded for LC-LIGHT/);
    await expect(applyVoucher({ ...S, number: "LCV-3" })).rejects.toThrow(/free ride/);

    // And the screen says so rather than falling over.
    const seen = await voucherDetail({ ...S, number: "LCV-3" });
    expect(seen.refusal).toMatch(/LC-LIGHT/);
    expect(seen.lines).toEqual([]);
  });

  it("lands the freight by weight once the missing weight is recorded", async () => {
    await recordMeasure({ ...S, sku: "LC-LIGHT", unitWeightMilli: 1_000_000n });
    // Ten units at 5 kg is 50 kg; ten at 1 kg is 10 kg. 600.00 over 60 kg is
    // 10.00 a kilo: 500.00 on the heavy lot and 100.00 on the light one.
    const applied = await applyVoucher({ ...S, number: "LCV-3" });
    expect(applied.lines.map((l) => `${l.sku}:${l.allocatedMinor}`)).toEqual(["LC-HEAVY:50000", "LC-LIGHT:10000"]);
    expect(applied.lines[0].weightMilli).toBe("50000000");
    expect(applied.lines[1].weightMilli).toBe("10000000");
    expect((await costOf("LC-HEAVY")).costMinor).toBe("70000");
    expect((await costOf("LC-LIGHT")).costMinor).toBe("30000");
  });

  it("follows a different basis for each charge, because one basis would be wrong for one of them", async () => {
    // LC-P: ten units, 100.00, 4 kg each. LC-Q: ten units, 300.00, 1 kg each.
    // Duty 400.00 by value  -> 100.00 and 300.00.
    // Freight 500.00 by weight (40 kg : 10 kg) -> 400.00 and 100.00.
    // So LC-P carries 500.00 and LC-Q 400.00 — the reverse of what value alone
    // would have said, which is the whole reason the basis is per charge.
    await createVoucher({
      ...S,
      voucher: {
        number: "LCV-4", shipmentRef: "CONT-4", voucherDate: "2026-02-10",
        charges: [
          { description: "Customs duty", amountMinor: 40_000n, accountCode: "5200", basis: "VALUE" },
          { description: "Ocean freight", amountMinor: 50_000n, accountCode: "5200", basis: "WEIGHT" },
        ],
        receipts: ["GRN-LC-4"],
      },
    });
    const applied = await applyVoucher({ ...S, number: "LCV-4" });
    expect(applied.charges[0].shares.map((s) => s.allocatedMinor)).toEqual(["10000", "30000"]);
    expect(applied.charges[1].shares.map((s) => s.allocatedMinor)).toEqual(["40000", "10000"]);
    expect(applied.lines.map((l) => l.allocatedMinor)).toEqual(["50000", "40000"]);
    expect((await costOf("LC-P")).costMinor).toBe("60000");
    expect((await costOf("LC-Q")).costMinor).toBe("70000");
  });

  /* ------------------------------------------------------------------- FIFO */

  it("adds the cost to the layer the receipt opened, so the layers still account for the item", async () => {
    // Twenty units at 10.00 in one layer, five issued, fifteen left. Freight of
    // 100.00 by quantity: 15/20 of it — 75.00 — belongs to the fifteen still
    // here and 25.00 to the five that have gone.
    await createVoucher({
      ...S,
      voucher: {
        number: "LCV-5", shipmentRef: "CONT-5", voucherDate: "2026-02-10",
        charges: [{ description: "Ocean freight", amountMinor: 10_000n, accountCode: "5200", basis: "QUANTITY" }],
        receipts: ["GRN-LC-5"],
      },
    });
    const applied = await applyVoucher({ ...S, number: "LCV-5" });
    expect(applied.lines[0].onHandMilli).toBe("15000");
    expect(applied.lines[0].inventoryMinor).toBe("7500");
    expect(applied.lines[0].cogsMinor).toBe("2500");

    const h = await itemHistory({ ...S, sku: "LC-FIFO" });
    expect(h.item.costMinor).toBe("22500");
    // The layer is the record of what the stock cost, so it has to agree.
    const open = h.layers.filter((l) => !l.exhausted);
    expect(open.length).toBe(1);
    expect(open[0].remainingMilli).toBe("15000");
    expect(open[0].unitCostMinor).toBe("1500");
    expect(open[0].remainingValueMinor).toBe("22500");
  });

  /* ------------------------------------------- landed cost under a write-down */

  it("keeps a written-down item tied to 1200 when cost is added to it", async () => {
    // Ten units at 10.00, assessed at 8.00 each: cost 100.00, carried at 80.00
    // with a 20.00 allowance (IAS 2.9). Freight of 50.00 lands on all ten, so
    // cost becomes 150.00 and — net realisable value not having moved — the
    // allowance becomes 70.00. The carrying amount is still 80.00, which is
    // what account 1200 has to say.
    await addItem({ ...S, item: { sku: "LC-NRV", name: "Written down", uom: "ea" } });
    await receive({ ...S, sku: "LC-NRV", movedOn: "2026-02-01", quantityMilli: 10_000n, valueMinor: 10_000n, reference: "GRN-LC-7" });
    await assessNrv({ ...S, sku: "LC-NRV", nrvMinor: 800n, on: "2026-02-08" });

    await createVoucher({
      ...S,
      voucher: {
        number: "LCV-8", shipmentRef: "CONT-8", voucherDate: "2026-02-10",
        charges: [{ description: "Ocean freight", amountMinor: 5_000n, accountCode: "5200", basis: "QUANTITY" }],
        receipts: ["GRN-LC-7"],
      },
    });
    const applied = await applyVoucher({ ...S, number: "LCV-8" });
    expect(applied.lines[0].inventoryMinor).toBe("5000");

    const item = (await stockValuation(S)).items.find((i) => i.sku === "LC-NRV")!;
    expect(item.costMinor).toBe("15000");
    expect(item.writeDownMinor).toBe("7000");
    expect(item.carryingMinor).toBe("8000");
    expect(item.valueMinor).toBe("8000");
  });

  /* -------------------------------------------------------------- it all ties */

  it("keeps the trial balance square and the stock tied to account 1200", async () => {
    const tb = await trialBalance({ ...S, periodLabel: "2026-02" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);

    const v = await stockValuation(S);
    expect(v.ledger.agrees).toBe(true);
    expect(v.totals.valueMinor).toBe(v.ledger.valueMinor);
  });

  /* ----------------------------------------------------------------- report */

  it("reports what was landed on each shipment and what is still waiting", async () => {
    await createVoucher({
      ...S,
      voucher: {
        number: "LCV-6", shipmentRef: "CONT-6", voucherDate: "2026-02-20",
        charges: [{ description: "Handling", amountMinor: 7_500n, accountCode: "5200", basis: "VALUE" }],
        receipts: ["GRN-LC-4"],
      },
    });

    const r = await landedCostReport({ ...S, from: "2026-01-01", to: "2026-12-31" });
    const one = r.shipments.find((s) => s.shipmentRef === "CONT-1")!;
    expect(one.landedMinor).toBe("100000");
    expect(one.unallocatedMinor).toBe("0");
    expect(one.items.map((i) => `${i.sku}:${i.unitCostBeforeMinor}>${i.unitCostAfterMinor}`))
      .toEqual(["LC-A:1000>4333", "LC-B:1000>4333", "LC-C:1000>4333"]);

    const two = r.shipments.find((s) => s.shipmentRef === "CONT-2")!;
    expect(two.inventoryMinor).toBe("20000");
    expect(two.cogsMinor).toBe("30000");

    const six = r.shipments.find((s) => s.shipmentRef === "CONT-6")!;
    expect(six.landedMinor).toBe("0");
    expect(six.unallocatedMinor).toBe("7500");
    expect(r.unapplied.map((u) => u.number)).toEqual(["LCV-6"]);

    // Everything landed so far, out of the one account it all sat in.
    const account = r.chargeAccounts.find((a) => a.code === "5200")!;
    expect(account.landedMinor).toBe("315000");
    expect(BigInt(account.chargedMinor) - BigInt(account.landedMinor)).toBe(BigInt(account.balanceMinor));

    const list = await voucherList(S);
    expect(list.vouchers.filter((x) => x.status === "applied").length).toBe(6);
    expect(list.vouchers.find((x) => x.number === "LCV-6")!.status).toBe("draft");
  });

  it("cancels a voucher that has not been applied, and will not apply it afterwards", async () => {
    const c = await cancelVoucher({ ...S, number: "LCV-6", reason: "Billed to the wrong shipment" });
    expect(c.status).toBe("cancelled");
    await expect(applyVoucher({ ...S, number: "LCV-6" })).rejects.toThrow(/was cancelled/);
  });

  it("reads an applied voucher back rather than reworking it against a shelf that has moved", async () => {
    // LC-P carried 500.00 of duty and freight over ten units. Four of them are
    // sold afterwards. Applying the voucher again must hand back what it did —
    // recomputing it would say 200.00 of that charge now belongs in cost of
    // sales, which is a statement about a posting that was never made.
    await issue({ ...S, sku: "LC-P", movedOn: "2026-02-24", quantityMilli: 4_000n, reference: "DN-LC-4" });

    const again = await applyVoucher({ ...S, number: "LCV-4" });
    expect(again.replayed).toBe(true);
    expect(again.lines[0].allocatedMinor).toBe("50000");
    expect(again.lines[0].inventoryMinor).toBe("50000");
    expect(again.lines[0].cogsMinor).toBe("0");
    expect(await db.inventoryMovement.count({ where: { orgId: ORG, kind: "LANDED_COST", reference: "LCV-4/1" } })).toBe(1);

    const tb = await trialBalance({ ...S, periodLabel: "2026-02" });
    expect(tb.balanced).toBe(true);
    const v = await stockValuation(S);
    expect(v.ledger.agrees).toBe(true);
  });

  it("lists what each item weighs, and what nobody has said", async () => {
    const m = await measureList(S);
    const light = m.items.find((i) => i.sku === "LC-LIGHT")!;
    expect(light.unitWeightMilli).toBe("1000000");
    expect(light.unitVolumeMilli).toBeNull();
    const a = m.items.find((i) => i.sku === "LC-A")!;
    expect(a.unitWeightMilli).toBeNull();
  });

  it("refuses to carry a cost onto goods that have all gone", async () => {
    await addItem({ ...S, item: { sku: "LC-GONE", name: "All sold", uom: "ea" } });
    await receive({ ...S, sku: "LC-GONE", movedOn: "2026-02-01", quantityMilli: 5_000n, valueMinor: 5_000n, reference: "GRN-LC-6" });
    await issue({ ...S, sku: "LC-GONE", movedOn: "2026-02-06", quantityMilli: 5_000n, reference: "DN-LC-3" });

    await createVoucher({
      ...S,
      voucher: {
        number: "LCV-7", shipmentRef: "CONT-7", voucherDate: "2026-02-10",
        charges: [{ description: "Ocean freight", amountMinor: 4_000n, accountCode: "5200", basis: "QUANTITY" }],
        receipts: ["GRN-LC-6"],
      },
    });
    const applied = await applyVoucher({ ...S, number: "LCV-7" });
    // Nothing is left to carry it, so the whole charge is an expense of the
    // period rather than a cost of stock that no longer exists.
    expect(applied.lines[0].onHandMilli).toBe("0");
    expect(applied.lines[0].inventoryMinor).toBe("0");
    expect(applied.lines[0].cogsMinor).toBe("4000");
    const posted = await linesOf(applied.entryId!);
    expect(posted["5000"]).toBe(4_000n);
    expect(posted["5200"]).toBe(-4_000n);
    expect(posted["1200"]).toBeUndefined();

    const tb = await trialBalance({ ...S, periodLabel: "2026-02" });
    expect(tb.balanced).toBe(true);
    const v = await stockValuation(S);
    expect(v.ledger.agrees).toBe(true);
  });
});
