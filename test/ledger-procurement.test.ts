import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createOrder, addLine, issueOrder, cancelOrder,
  receiveGoods, matchInvoice, postMatchedInvoice, grniReport,
  orderDetail, orderList, lineValue,
  type NewOrderLine,
} from "@/lib/server/ledger/procurement";
import { addItem, stockValuation } from "@/lib/server/ledger/inventory";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { LedgerError } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-po";
const ENT = "t-ent-po";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "GoodsReceiptLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "GoodsReceipt" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "PurchaseOrderLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "PurchaseOrder" WHERE "orgId" = '${ORG}'`),
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

/** Every account touched by one entry, netted — a debit positive, a credit negative. */
async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { lineNo: "asc" } });
  const out: Record<string, bigint> = {};
  for (const r of rows) out[r.account.code] = (out[r.account.code] ?? 0n) + r.txnAmountMinor;
  return out;
}

const memoOf = async (entryId: string) =>
  (await db.journalEntry.findUnique({ where: { id: entryId }, select: { memo: true } }))?.memo ?? "";

const entryCount = () => db.journalEntry.count({ where: { orgId: ORG } });

/** Where 1250 actually stands, straight out of the ledger. */
async function grniBalance() {
  const account = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code: "1250" }, select: { id: true } });
  const rows = await db.journalLine.findMany({
    where: { orgId: ORG, accountId: account!.id, entry: { status: { in: ["posted", "reversed"] } } },
    select: { functionalAmountMinor: true },
  });
  return rows.reduce((a, r) => a + r.functionalAmountMinor, 0n);
}

/** A stock line: 100 units at 100.00 unless told otherwise. */
const steel = (units: number, priceMinor: number): NewOrderLine => ({
  description: "Steel bar 12mm",
  sku: "STEEL",
  quantityMilli: units * 1000,
  unitPriceMinor: priceMinor,
});

const service = (description: string, units: number, priceMinor: number): NewOrderLine => ({
  description,
  quantityMilli: units * 1000,
  unitPriceMinor: priceMinor,
  accountCode: "6900",
});

async function raise(number: string, lines: NewOrderLine[], issue = true) {
  const order = await createOrder({
    orgId: ORG, entityId: ENT,
    order: { number, supplierName: "Gulf Steel LLC", orderedOn: "2026-04-01", lines },
  });
  if (issue) await issueOrder({ orgId: ORG, orderId: order.id });
  return order;
}

d("purchase orders, goods receipts and three-way matching", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
    await addItem({ orgId: ORG, entityId: ENT, item: { sku: "STEEL", name: "Steel bar 12mm", uom: "EA" } });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------------- the order */

  it("posts nothing to the ledger when an order is raised — an order is a commitment", async () => {
    const before = await entryCount();
    const order = await createOrder({
      orgId: ORG, entityId: ENT,
      order: {
        number: "PO-COMMIT", supplierName: "Gulf Steel LLC", orderedOn: "2026-04-01",
        lines: [service("Scaffold hire", 4, 125_00)],
      },
    });
    expect(order.status).toBe("draft");

    await addLine({ orgId: ORG, orderId: order.id, line: service("Site survey", 1, 900_00) });
    const issued = await issueOrder({ orgId: ORG, orderId: order.id });
    expect(issued.status).toBe("open");

    // Nothing has been received and nothing has been billed, so nothing has
    // happened that double entry has anything to say about.
    expect(await entryCount()).toBe(before);
  });

  it("refuses to issue an order with no lines on it", async () => {
    const empty = await createOrder({
      orgId: ORG, entityId: ENT,
      order: { number: "PO-EMPTY", supplierName: "Gulf Steel LLC", orderedOn: "2026-04-01" },
    });
    await expect(issueOrder({ orgId: ORG, orderId: empty.id })).rejects.toThrow(/commits to nothing/i);
  });

  it("refuses a second order with a number already in use", async () => {
    await expect(
      createOrder({
        orgId: ORG, entityId: ENT,
        order: { number: "PO-COMMIT", supplierName: "Someone else", orderedOn: "2026-04-02" },
      }),
    ).rejects.toThrow(/already in use/i);
  });

  it("refuses to grow an order the supplier is already working to", async () => {
    const order = await raise("PO-FROZEN", [service("Cabling", 2, 300_00)]);
    await expect(
      addLine({ orgId: ORG, orderId: order.id, line: service("More cabling", 2, 300_00) }),
    ).rejects.toThrow(/Raise a second order/i);
  });

  it("cancels an order nobody has delivered against, and refuses once they have", async () => {
    const draft = await raise("PO-CANCEL", [service("Signage", 1, 500_00)], false);
    const cancelled = await cancelOrder({ orgId: ORG, orderId: draft.id, reason: "Supplier withdrew the quote" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.notes).toContain("Supplier withdrew the quote");

    const started = await raise("PO-STARTED", [service("Ducting", 10, 100_00)]);
    await receiveGoods({
      orgId: ORG, orderId: started.id, receivedOn: "2026-04-05", number: "GRN-STARTED",
      lines: [{ orderLineId: started.lines[0].id, quantityMilli: 4_000 }],
    });
    await expect(cancelOrder({ orgId: ORG, orderId: started.id })).rejects.toThrow(/cannot be cancelled/i);
  });

  /* ----------------------------------------------------------- the receipt */

  it("will not take a delivery against an order that was never issued", async () => {
    const draft = await raise("PO-DRAFT", [service("Paint", 5, 60_00)], false);
    await expect(
      receiveGoods({
        orgId: ORG, orderId: draft.id, receivedOn: "2026-04-05",
        lines: [{ orderLineId: draft.lines[0].id, quantityMilli: 1_000 }],
      }),
    ).rejects.toThrow(/has not been issued/i);
  });

  it("debits stock and credits GRNI at the ordered price when goods arrive", async () => {
    const order = await raise("PO-A", [steel(100, 100_00)]);
    const r = await receiveGoods({
      orgId: ORG, orderId: order.id, receivedOn: "2026-04-06", number: "GRN-A1",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 40_000 }],
    });

    // 40 units at 100.00 = 4,000.00. The business now holds the steel and owes
    // for it, with no invoice anywhere in sight.
    expect(await linesOf(r.entryId!)).toEqual({ "1200": 400_000n, "1250": -400_000n });
    expect(r.valueMinor).toBe("400000");
    expect(r.orderStatus).toBe("part_received");
  });

  it("advances the order from part_received to received as the rest arrives", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-A" }, include: { lines: true } });
    expect(order.status).toBe("part_received");
    expect(order.lines[0].receivedMilli).toBe(40_000n);

    const r = await receiveGoods({
      orgId: ORG, orderId: order.id, receivedOn: "2026-04-09", number: "GRN-A2",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 60_000 }],
    });
    expect(await linesOf(r.entryId!)).toEqual({ "1200": 600_000n, "1250": -600_000n });
    expect(r.orderStatus).toBe("received");
  });

  it("refuses an over-receipt, naming the line, what was ordered and what already arrived", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-STARTED" }, include: { lines: true } });
    const before = await entryCount();
    const attempt = receiveGoods({
      orgId: ORG, orderId: order.id, receivedOn: "2026-04-10",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 8_000 }],
    });
    await expect(attempt).rejects.toThrow(LedgerError);
    // The message has to carry all three numbers, or the reader cannot tell a
    // supplier over-shipping from a delivery note keyed twice.
    await expect(attempt).rejects.toThrow(/Line 1 of PO-STARTED \(Ducting\)/);
    await expect(attempt).rejects.toThrow(/ordered 10/);
    await expect(attempt).rejects.toThrow(/4 has already arrived/);
    await expect(attempt).rejects.toThrow(/only 6 is still outstanding/);
    expect(await entryCount()).toBe(before);
  });

  it("refuses a further delivery once every line has been received in full", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-A" }, include: { lines: true } });
    await expect(
      receiveGoods({
        orgId: ORG, orderId: order.id, receivedOn: "2026-04-11",
        lines: [{ orderLineId: order.lines[0].id, quantityMilli: 1_000 }],
      }),
    ).rejects.toThrow(/already been received in full/i);
  });

  it("records the same delivery note only once", async () => {
    const order = await raise("PO-IDEM", [service("Timber", 10, 40_00)]);
    const first = await receiveGoods({
      orgId: ORG, orderId: order.id, receivedOn: "2026-04-07", number: "GRN-IDEM",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 6_000 }],
    });
    const second = await receiveGoods({
      orgId: ORG, orderId: order.id, receivedOn: "2026-04-07", number: "GRN-IDEM",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 6_000 }],
    });
    expect(second.alreadyPosted).toBe(true);
    expect(second.entryId).toBe(first.entryId);

    // And the quantity on the order was not advanced twice either — which is
    // the half a ledger-only idempotency key would have missed.
    const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { orderId: order.id } });
    expect(line.receivedMilli).toBe(6_000n);
  });

  it("moves inventory quantity on a stock line without debiting 1200 twice", async () => {
    // 100 units of STEEL arrived across PO-A's two deliveries at 100.00 each.
    const valuation = await stockValuation({ orgId: ORG, entityId: ENT });
    const item = valuation.items.find((i) => i.sku === "STEEL");
    expect(item?.quantityMilli).toBe("100000");
    expect(item?.valueMinor).toBe("1000000");
    // The receipt journal already debited 1200; inventory.receive was called
    // with alreadyPosted, so the stock account was hit exactly once.
    expect(valuation.ledger.valueMinor).toBe("1000000");
    expect(valuation.ledger.agrees).toBe(true);
  });

  it("debits an expense line to its own account rather than to inventory", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-IDEM" } });
    const entry = await db.goodsReceipt.findFirstOrThrow({ where: { orgId: ORG, orderId: order.id } });
    const l = await linesOf(entry.entryId!);
    expect(l["6900"]).toBe(24_000n);   // 6 units at 40.00
    expect(l["1250"]).toBe(-24_000n);
    expect(l["1200"]).toBeUndefined();
  });

  it("refuses a stock line coded away from its item's stock account", async () => {
    const order = await raise("PO-MISCODE", [{ ...steel(5, 100_00), accountCode: "6900" }]);
    await expect(
      receiveGoods({
        orgId: ORG, orderId: order.id, receivedOn: "2026-04-08",
        lines: [{ orderLineId: order.lines[0].id, quantityMilli: 5_000 }],
      }),
    ).rejects.toThrow(/stock valuation stops agreeing with the ledger/i);
  });

  it("refuses a line coded to a SKU that is not on the item list", async () => {
    const order = await raise("PO-GHOST", [{ description: "Ghost part", sku: "NOPE", quantityMilli: 1_000, unitPriceMinor: 100_00 }]);
    await expect(
      receiveGoods({
        orgId: ORG, orderId: order.id, receivedOn: "2026-04-08",
        lines: [{ orderLineId: order.lines[0].id, quantityMilli: 1_000 }],
      }),
    ).rejects.toThrow(/not on the item list/i);
  });

  /* ------------------------------------------------------------- the match */

  it("matches an invoice that agrees with the order and the delivery", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-A" }, include: { lines: true } });
    const m = await matchInvoice({
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-A",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 100_000, unitPriceMinor: 100_00 }],
      invoiceTotalMinor: 1_050_000, vatMinor: 50_000,
    });
    expect(m.matched).toBe(true);
    expect(m.withinTolerance).toBe(true);
    expect(m.findings).toEqual([]);
    expect(m.grniValueMinor).toBe("1000000");
    expect(m.varianceMinor).toBe("0");
    expect(m.lines[0].reason).toMatch(/agrees: 100 ordered, 100 received, 100 invoiced/);
  });

  it("clears 1250 to exactly zero for the order the invoice belongs to", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-A" }, include: { lines: true } });
    const r = await postMatchedInvoice({
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-A", invoicedOn: "2026-04-15",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 100_000, unitPriceMinor: 100_00 }],
      invoiceTotalMinor: 1_050_000, vatMinor: 50_000,
    });

    expect(await linesOf(r.entryId)).toEqual({
      "1250": 1_000_000n,    // Dr — the accrual the deliveries raised, discharged
      "1350": 50_000n,       // Dr — recoverable input VAT
      "2000": -1_050_000n,   // Cr — what we now actually owe the supplier
    });
    expect(r.varianceMinor).toBe("0");

    const report = await grniReport({ orgId: ORG, entityId: ENT, asOf: "2026-04-30" });
    expect(report.orders.find((o) => o.number === "PO-A")).toBeUndefined();
    // And it has left the report altogether rather than sitting in it at zero:
    // a line invoiced for everything it received holds nothing in 1250, so the
    // report no longer reads the order at all.
    const detail = await orderDetail({ orgId: ORG, orderId: order.id });
    expect(detail.lines[0].grniMinor).toBe("0");
  });

  it("does not post the same supplier invoice twice", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-A" }, include: { lines: true } });
    const again = await postMatchedInvoice({
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-A", invoicedOn: "2026-04-15",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 100_000, unitPriceMinor: 100_00 }],
      invoiceTotalMinor: 1_050_000, vatMinor: 50_000,
    });
    expect(again.alreadyPosted).toBe(true);
    const line = await db.purchaseOrderLine.findFirstOrThrow({ where: { orderId: order.id } });
    expect(line.invoicedMilli).toBe(100_000n);
  });

  it("detects a price variance and describes it in a sentence", async () => {
    const order = await raise("PO-B", [service("Concrete", 10, 250_00)]);
    await receiveGoods({
      orgId: ORG, orderId: order.id, receivedOn: "2026-04-12", number: "GRN-B1",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 10_000 }],
    });

    const m = await matchInvoice({
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-B",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 10_000, unitPriceMinor: 260_00 }],
      invoiceTotalMinor: 273_000, vatMinor: 13_000,
    });

    expect(m.matched).toBe(false);
    expect(m.findings).toContain("price_variance");
    expect(m.lines[0].priceVarianceMinor).toBe("10000");   // 10.00 a unit over ten units
    expect(m.lines[0].reason).toMatch(/order priced it at 250\.00 a unit and the invoice charges 260\.00/);
    expect(m.lines[0].reason).toMatch(/100\.00 more on this line/);
    // With no tolerance chosen, a price nobody agreed is not within tolerance.
    expect(m.withinTolerance).toBe(false);
  });

  it("lets a price difference through only when the caller chose a tolerance for it", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-B" }, include: { lines: true } });
    const args = {
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-B",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 10_000, unitPriceMinor: 260_00 }],
      invoiceTotalMinor: 273_000, vatMinor: 13_000,
    };
    const strict = await matchInvoice(args);
    expect(strict.withinTolerance).toBe(false);

    const tolerant = await matchInvoice({ ...args, tolerance: { unitPriceMinor: 10_00 } });
    expect(tolerant.withinTolerance).toBe(true);
    // Tolerated is not the same as matched: the difference is still reported.
    expect(tolerant.matched).toBe(false);
    expect(tolerant.findings).toContain("price_variance");
  });

  it("books a tolerated price difference to the variance account, not to stock", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-B" }, include: { lines: true } });
    const r = await postMatchedInvoice({
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-B", invoicedOn: "2026-04-16",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 10_000, unitPriceMinor: 260_00 }],
      invoiceTotalMinor: 273_000, vatMinor: 13_000,
      tolerance: { unitPriceMinor: 10_00 },
    });
    expect(await linesOf(r.entryId)).toEqual({
      "1250": 250_000n,     // only ever what the receipt accrued
      "1350": 13_000n,
      "5300": 10_000n,      // the extra the supplier charged
      "2000": -273_000n,
    });
  });

  it("detects a quantity variance against what was actually received", async () => {
    const order = await raise("PO-C", [service("Rebar ties", 20, 50_00)]);
    await receiveGoods({
      orgId: ORG, orderId: order.id, receivedOn: "2026-04-13", number: "GRN-C1",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 12_000 }],
    });

    const m = await matchInvoice({
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-C",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 20_000, unitPriceMinor: 50_00 }],
      invoiceTotalMinor: 100_000,
    });
    expect(m.findings).toContain("quantity_variance");
    expect(m.lines[0].quantityVarianceMilli).toBe("8000");
    expect(m.lines[0].reason).toMatch(/invoiced for 20 but only 12 has been received and not yet billed/);
    expect(m.lines[0].reason).toMatch(/8 is being billed for goods that have not arrived/);
    // Only the twelve that arrived are sitting in 1250.
    expect(m.grniValueMinor).toBe("60000");
    expect(m.varianceMinor).toBe("40000");
  });

  it("refuses to post a failed match without a reason", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-C" }, include: { lines: true } });
    const before = await entryCount();
    await expect(
      postMatchedInvoice({
        orgId: ORG, orderId: order.id, invoiceNumber: "SI-C", invoicedOn: "2026-04-17",
        lines: [{ orderLineId: order.lines[0].id, quantityMilli: 20_000, unitPriceMinor: 50_00 }],
        invoiceTotalMinor: 100_000,
      }),
    ).rejects.toThrow(/an override with no reason is not an override, it is a bypass/i);
    expect(await entryCount()).toBe(before);
  });

  it("posts an override and records the reason on the entry", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-C" }, include: { lines: true } });
    const r = await postMatchedInvoice({
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-C", invoicedOn: "2026-04-17",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 20_000, unitPriceMinor: 50_00 }],
      invoiceTotalMinor: 100_000,
      overrideReason: "Balance shipped direct to site by the supplier; site manager confirmed receipt",
    });
    expect(r.overrideReason).toContain("site manager confirmed receipt");
    expect(await memoOf(r.entryId)).toMatch(/match override: Balance shipped direct to site/);
    expect(await linesOf(r.entryId)).toEqual({
      "1250": 60_000n,    // only what really arrived comes out of the accrual
      "5300": 40_000n,    // the rest is a variance somebody has signed for
      "2000": -100_000n,
    });
  });

  /* -------------------------------------------- billed but never delivered */

  it("catches an invoice for goods that never arrived, and refuses it", async () => {
    const order = await raise("PO-D", [service("Delivered pallet", 5, 100_00), service("Phantom pallet", 5, 100_00)]);
    await receiveGoods({
      orgId: ORG, orderId: order.id, receivedOn: "2026-04-14", number: "GRN-D1",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 5_000 }],
    });

    const args = {
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-D",
      lines: [
        { orderLineId: order.lines[0].id, quantityMilli: 5_000, unitPriceMinor: 100_00 },
        { orderLineId: order.lines[1].id, quantityMilli: 5_000, unitPriceMinor: 100_00 },
      ],
      invoiceTotalMinor: 100_000,
    };

    const m = await matchInvoice(args);
    expect(m.lines[0].findings).toEqual([]);
    expect(m.lines[1].findings).toEqual(["not_received"]);
    expect(m.lines[1].reason).toMatch(/nothing has ever been received against it/);
    expect(m.lines[1].reason).toMatch(/Do not pay this line/);
    // A two-way match against the order alone would have passed this happily:
    // the supplier is billing for exactly what was ordered.
    expect(m.lines[1].quantityVarianceMilli).toBe("5000");
    expect(m.matched).toBe(false);

    await expect(
      postMatchedInvoice({ ...args, invoicedOn: "2026-04-18" }),
    ).rejects.toThrow(/nothing has ever been received against it/);
  });

  it("will not tolerate a never-received line however wide the tolerance", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-D" }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    const m = await matchInvoice({
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-D",
      lines: [{ orderLineId: order.lines[1].id, quantityMilli: 5_000, unitPriceMinor: 100_00 }],
      invoiceTotalMinor: 50_000,
      // Wide enough to swallow the whole line, and it still must not.
      tolerance: { quantityMilli: 1_000_000, unitPriceMinor: 1_000_000, totalMinor: 1_000_000 },
    });
    expect(m.withinTolerance).toBe(false);
    expect(m.findings).toContain("not_received");
  });

  it("posts the override for a phantom line to variance and leaves 1250 alone", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-D" }, include: { lines: { orderBy: { lineNo: "asc" } } } });
    const r = await postMatchedInvoice({
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-D", invoicedOn: "2026-04-18",
      lines: [
        { orderLineId: order.lines[0].id, quantityMilli: 5_000, unitPriceMinor: 100_00 },
        { orderLineId: order.lines[1].id, quantityMilli: 5_000, unitPriceMinor: 100_00 },
      ],
      invoiceTotalMinor: 100_000,
      overrideReason: "Buyer accepts the second pallet is in transit and will chase the delivery note",
    });
    expect(await linesOf(r.entryId)).toEqual({
      "1250": 50_000n,     // only the pallet that arrived
      "5300": 50_000n,     // the phantom one, visible rather than buried in stock
      "2000": -100_000n,
    });
  });

  it("refuses to bill more than was ordered, with or without an override", async () => {
    const order = await raise("PO-E", [service("Anchors", 10, 100_00)]);
    await receiveGoods({
      orgId: ORG, orderId: order.id, receivedOn: "2026-04-14", number: "GRN-E1",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 10_000 }],
    });

    const m = await matchInvoice({
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-E",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 15_000, unitPriceMinor: 100_00 }],
      invoiceTotalMinor: 150_000,
    });
    expect(m.findings).toContain("over_invoiced");

    await expect(
      postMatchedInvoice({
        orgId: ORG, orderId: order.id, invoiceNumber: "SI-E", invoicedOn: "2026-04-19",
        lines: [{ orderLineId: order.lines[0].id, quantityMilli: 15_000, unitPriceMinor: 100_00 }],
        invoiceTotalMinor: 150_000,
        overrideReason: "Buyer says it is fine",
      }),
    ).rejects.toThrow(/cannot be overridden/i);
  });

  it("refuses an invoice whose own total disagrees with its own lines", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-E" }, include: { lines: true } });
    const m = await matchInvoice({
      orgId: ORG, orderId: order.id, invoiceNumber: "SI-E2",
      lines: [{ orderLineId: order.lines[0].id, quantityMilli: 10_000, unitPriceMinor: 100_00 }],
      invoiceTotalMinor: 111_111, vatMinor: 5_000,
    });
    expect(m.findings).toContain("header_variance");
    expect(m.headerVarianceMinor).toBe("6111");
    expect(m.summary).toMatch(/own total is also out by 61\.11/);
  });

  /* ------------------------------------------------------------ the report */

  it("explains the GRNI balance order by order, and ties it to account 1250", async () => {
    const report = await grniReport({ orgId: ORG, entityId: ENT, asOf: "2026-04-30" });

    // Two records built by different routes: the delivery documents on one
    // side, account 1250's own balance on the other.
    expect(report.ledger.account).toBe("1250");
    expect(report.ledger.outstandingMinor).toBe((-(await grniBalance())).toString());
    expect(report.ledger.agrees).toBe(true);
    expect(report.ledger.differenceMinor).toBe("0");
    expect(report.totals.outstandingMinor).toBe(report.ledger.outstandingMinor);

    // And the total is the sum of the orders shown, so a reader can see where
    // every fil of it came from.
    const summed = report.orders.reduce((a, o) => a + BigInt(o.outstandingMinor), 0n);
    expect(summed.toString()).toBe(report.totals.outstandingMinor);

    const e = report.orders.find((o) => o.number === "PO-E");
    expect(e?.outstandingMinor).toBe("100000");   // received, invoice refused
    expect(e?.lines[0].description).toBe("Anchors");
    expect(e?.daysOld).toBeGreaterThan(0);

    // A settled order drops out of the list rather than sitting there at zero.
    expect(report.orders.find((o) => o.number === "PO-B")).toBeUndefined();
  });

  it("shows a manual journal into 1250 as a balance the orders cannot explain", async () => {
    // 1250 is not a control account, so somebody can post straight into it.
    // The whole point of the reconciliation is that this shows up.
    const { post } = await import("@/lib/server/ledger/post");
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-04-20", memo: "Unexplained accrual",
      series: "GJ",
      lines: [
        { account: "6900", debit: 12_345 },
        { account: "1250", credit: 12_345 },
      ],
    });

    const report = await grniReport({ orgId: ORG, entityId: ENT, asOf: "2026-04-30" });
    expect(report.ledger.agrees).toBe(false);
    expect(report.ledger.differenceMinor).toBe("12345");
  });

  /* ------------------------------------------------------------ the ledger */

  it("reads back an order with its deliveries and what each line still owes", async () => {
    const order = await db.purchaseOrder.findFirstOrThrow({ where: { orgId: ORG, number: "PO-E" } });
    const detail = await orderDetail({ orgId: ORG, orderId: order.id });
    expect(detail.status).toBe("received");
    expect(detail.lines[0].grniMinor).toBe("100000");
    expect(detail.receipts).toHaveLength(1);
    expect(detail.receipts[0].number).toBe("GRN-E1");

    const list = await orderList({ orgId: ORG, entityId: ENT });
    expect(list.orders.find((o) => o.number === "PO-A")?.status).toBe("received");
    expect(list.orders.find((o) => o.number === "PO-CANCEL")?.status).toBe("cancelled");
  });

  it("reads only the orders that can be holding a balance, not every order ever raised", async () => {
    /*
     * The report used to load every purchase order the business had ever
     * raised — with its lines, its receipts and every receipt line — onto a
     * dashboard, and return all of them. Goods received and not invoiced is a
     * question about deliveries nobody has billed yet: an order whose every
     * line has been invoiced for at least as much as it received holds nothing
     * in 1250 and cannot start holding something by being read.
     */
    const before = await grniReport({ orgId: ORG, entityId: ENT, asOf: "2026-04-30" });

    // A drawer full of orders that cannot contribute a fil.
    for (let i = 0; i < 10; i++) {
      await createOrder({
        orgId: ORG, entityId: ENT,
        order: {
          number: `PO-QUIET-${i}`, supplierName: "Gulf Steel LLC", orderedOn: "2026-04-01",
          lines: [service("Nothing delivered", 1, 100_00)],
        },
      });
    }

    const after = await grniReport({ orgId: ORG, entityId: ENT, asOf: "2026-04-30" });
    expect(after.orders.map((o) => o.number)).toEqual(before.orders.map((o) => o.number));
    expect(after.totals.outstandingMinor).toBe(before.totals.outstandingMinor);
    // The ledger side is summed by the database now rather than by fetching a
    // row for every posting ever made to 1250; it has to reach the same figure.
    expect(after.ledger.outstandingMinor).toBe(before.ledger.outstandingMinor);
    expect(after.ledger.differenceMinor).toBe(before.ledger.differenceMinor);
    expect(after.note).toBe(before.note);

    // And what it read is the orders with an unbilled delivery on them, which
    // is fewer than the orders on file — said out loud rather than assumed.
    const lines = await db.purchaseOrderLine.findMany({
      where: { orgId: ORG, order: { entityId: ENT } },
      select: { orderId: true, receivedMilli: true, invoicedMilli: true },
    });
    const unbilled = new Set(
      lines.filter((l) => l.receivedMilli > l.invoicedMilli).map((l) => l.orderId),
    ).size;
    const onFile = await db.purchaseOrder.count({ where: { orgId: ORG, entityId: ENT } });
    expect(unbilled).toBeLessThan(onFile);
    expect(after.note).toContain(`Read from ${unbilled} purchase order`);
    expect(after.note).toMatch(/is not read/);
  });

  it("values a quantity at a unit price without ever seeing a float", () => {
    // 2.5 units at 33.33 — the case a float gets wrong by a fil.
    expect(lineValue(3_333n, 2_500n)).toBe(8_332n);
    expect(lineValue(100_00n, 100_000n)).toBe(1_000_000n);
  });

  it("keeps the trial balance tied after everything above", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-04" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });
});
