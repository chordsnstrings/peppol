import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createDeliveryNote, dispatchNote, confirmDelivery, cancelDeliveryNote,
  returnGoods, outstandingOnOrder, deliveredNotInvoiced, deliveryRegister, fmtQty,
} from "@/lib/server/ledger/deliveries";
import { addItem, receive } from "@/lib/server/ledger/inventory";
import { createOrder, sendOrder, acceptOrder, invoiceOrder, updateOrder } from "@/lib/server/ledger/sales-orders";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { ledgerBalances } from "@/lib/server/ledger/balances";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-dn";
const ENT = "t-ent-dn";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "DeliveryNoteLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DeliveryNote" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryMovement" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "StockBatch" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "StockLocation" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryItem" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "SalesOrderLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "SalesOrder" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${ORG}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Dimension" WHERE "orgId" = '${ORG}'`),
  ]);
}

/**
 * A hundred widgets bought at 10.00 each, on an accepted order for sixty at
 * 25.00. Every figure below is worked from those two.
 */
async function seed() {
  await openFiscalYear({ ...S, label: "2026", startsOn: "2026-01-01" });
  await openBooks(S);
  await addItem({ ...S, item: { sku: "WIDGET", name: "Widget", uom: "ea" } });
  await receive({ ...S, sku: "WIDGET", movedOn: "2026-02-01", quantityMilli: 100_000n, valueMinor: 100_000n, reference: "GRN-1" });

  const quote = await createOrder({
    ...S,
    order: {
      number: "SO-1", kind: "ORDER", customerName: "Beta Trading", issuedOn: "2026-03-01",
      lines: [{ description: "Widget", sku: "WIDGET", quantityMilli: 60_000n, unitPriceMinor: 2_500n }],
    },
  });
  await sendOrder({ orgId: ORG, orderId: quote.id, entityId: ENT });
  await acceptOrder({ orgId: ORG, orderId: quote.id, entityId: ENT, acceptedOn: "2026-03-02" });
  return quote.id;
}

d("delivery notes", () => {
  let orderId = "";
  let orderLineId = "";

  beforeAll(async () => {
    await wipe();
    orderId = await seed();
    const line = await db.salesOrderLine.findFirst({ where: { orderId } });
    orderLineId = line!.id;
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("shows the whole order still to go before anything has left", async () => {
    const o = await outstandingOnOrder({ ...S, orderId });
    expect(o.lines[0].orderedMilli).toBe(60_000n);
    expect(o.lines[0].deliveredMilli).toBe(0n);
    expect(o.lines[0].outstandingMilli).toBe(60_000n);
  });

  it("refuses to deliver more than the order says, with the figures", async () => {
    await expect(createDeliveryNote({
      ...S,
      note: {
        number: "DN-BAD", orderId, deliveredOn: "2026-03-05",
        lines: [{ sku: "WIDGET", description: "Widget", quantityMilli: 61_000n, orderLineId }],
      },
    })).rejects.toThrow(/has 60 still to go and this note delivers 61/);
  });

  it("refuses a note with no lines and one with no customer", async () => {
    await expect(createDeliveryNote({ ...S, note: { number: "DN-X", deliveredOn: "2026-03-05", lines: [] } }))
      .rejects.toThrow(/delivered nothing/);
    await expect(createDeliveryNote({
      ...S, note: { number: "DN-X", deliveredOn: "2026-03-05", lines: [{ description: "Thing", quantityMilli: 1_000n }] },
    })).rejects.toThrow(/who it went to/);
  });

  it("takes a part delivery and moves no stock until it is dispatched", async () => {
    await createDeliveryNote({
      ...S,
      note: {
        number: "DN-1", orderId, deliveredOn: "2026-03-05", carrier: "Own van",
        lines: [{ sku: "WIDGET", description: "Widget", quantityMilli: 40_000n, orderLineId }],
      },
    });
    const stock = await db.inventoryItem.findFirst({ where: { orgId: ORG, sku: "WIDGET" } });
    expect(stock!.quantityMilli).toBe(100_000n);
    const o = await outstandingOnOrder({ ...S, orderId });
    // A draft counts against the order: two people must not each be told the
    // last of the stock is free.
    expect(o.lines[0].deliveredMilli).toBe(40_000n);
    expect(o.lines[0].outstandingMilli).toBe(20_000n);
  });

  it("moves cost out of inventory on dispatch, and nothing else", async () => {
    const r = await dispatchNote({ ...S, number: "DN-1" });
    // Forty at 1.00 cost is 400.00.
    expect(r.costMinor).toBe(40_000n);
    expect(r.lines[0].replayed).toBe(false);

    const bal = await ledgerBalances({ ...S, codes: ["1200", "5000", "4000", "1100"] });
    expect(bal.get("1200")).toBe(60_000n);   // 1,000.00 in less 400.00 out
    expect(bal.get("5000")).toBe(40_000n);   // cost of sales
    // Nothing was invoiced: no revenue, no receivable.
    expect(bal.get("4000") ?? 0n).toBe(0n);
    expect(bal.get("1100") ?? 0n).toBe(0n);
  });

  it("dispatches twice without issuing twice", async () => {
    await expect(dispatchNote({ ...S, number: "DN-1" })).rejects.toThrow(/already been dispatched/);
    const movements = await db.inventoryMovement.count({ where: { orgId: ORG, reference: "DN-1" } });
    expect(movements).toBe(1);
  });

  it("refuses a signature on a note that has not gone", async () => {
    await createDeliveryNote({
      ...S,
      note: {
        number: "DN-2", orderId, deliveredOn: "2026-03-08",
        lines: [{ sku: "WIDGET", description: "Widget", quantityMilli: 20_000n, orderLineId }],
      },
    });
    await expect(confirmDelivery({ ...S, number: "DN-2", signedBy: "R. Khan" }))
      .rejects.toThrow(/nobody can have signed for it/);
  });

  it("records who signed, without moving anything", async () => {
    await dispatchNote({ ...S, number: "DN-2" });
    const before = await ledgerBalances({ ...S, codes: ["1200"] });
    const n = await confirmDelivery({ ...S, number: "DN-2", signedBy: "R. Khan", signedOn: "2026-03-09" });
    expect(n.status).toBe("delivered");
    expect(n.signedBy).toBe("R. Khan");
    const after = await ledgerBalances({ ...S, codes: ["1200"] });
    expect(after.get("1200")).toBe(before.get("1200"));
  });

  it("has nothing left on the order once both notes have gone", async () => {
    const o = await outstandingOnOrder({ ...S, orderId });
    expect(o.lines[0].outstandingMilli).toBe(0n);
    await expect(createDeliveryNote({
      ...S,
      note: {
        number: "DN-3", orderId, deliveredOn: "2026-03-10",
        lines: [{ sku: "WIDGET", description: "Widget", quantityMilli: 1_000n, orderLineId }],
      },
    })).rejects.toThrow(/has 0 still to go/);
  });

  /*
   * The order cannot be cut below what has gone.
   *
   * `updateOrder` compared a new quantity against the invoiced quantity alone,
   * so an order line could be reduced under the despatched quantity and the
   * delivery note left quoting goods its own order no longer carried. Sixty
   * have left here and nothing has been billed, so the delivered quantity is
   * the only thing holding the line up.
   */
  it("refuses to cut an order line below what has already been delivered", async () => {
    await expect(updateOrder({
      orgId: ORG, entityId: ENT, orderId,
      patch: { lines: [{ id: orderLineId, description: "Widget", sku: "WIDGET", quantityMilli: 30_000n, unitPriceMinor: 2_500n }] },
    })).rejects.toThrow(/has already had 60 delivered.*cannot be cut to 30.*return note/s);
  });

  it("refuses to take a delivered line off the order altogether", async () => {
    await expect(updateOrder({
      orgId: ORG, entityId: ENT, orderId, patch: { lines: [] },
    })).rejects.toThrow(/has already had 60 delivered.*taken off the order.*return note/s);
  });

  it("allows a cut to exactly what has gone out", async () => {
    const r = await updateOrder({
      orgId: ORG, entityId: ENT, orderId,
      patch: { lines: [{ id: orderLineId, description: "Widget", sku: "WIDGET", quantityMilli: 60_000n, unitPriceMinor: 2_500n }] },
    });
    expect(r.lines[0].quantityMilli).toBe(60_000n);
    expect((await outstandingOnOrder({ ...S, orderId })).lines[0].outstandingMilli).toBe(0n);
  });

  it("lists everything delivered and not yet invoiced, at the order price", async () => {
    const r = await deliveredNotInvoiced({ ...S, asOf: "2026-03-31" });
    // Sixty at 25.00 is 1,500.00; it cost 600.00.
    expect(r.totals.valueMinor).toBe(150_000n);
    expect(r.totals.costMinor).toBe(60_000n);
    expect(r.totals.marginMinor).toBe(90_000n);
    expect(r.rows).toHaveLength(2);
    expect(r.note).toContain("memorandum");
  });

  it("consumes the invoiced quantity against the oldest delivery first", async () => {
    await invoiceOrder({ orgId: ORG, orderId, entityId: ENT, lines: [{ orderLineId, quantityMilli: "40000" }] });
    const r = await deliveredNotInvoiced({ ...S, asOf: "2026-03-31" });
    // The first forty are billed, so only DN-2's twenty remain.
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].number).toBe("DN-2");
    expect(r.rows[0].uninvoicedMilli).toBe(20_000n);
    expect(r.totals.valueMinor).toBe(50_000n);
  });

  /*
   * Both facts, and which of them binds. Forty are billed and sixty have gone,
   * so a cut to fifty clears the invoice and not the lorry — and a refusal that
   * named only the invoice would send the reader for a credit note when what
   * they need is a return.
   */
  it("names both quantities and says which one is binding", async () => {
    await expect(updateOrder({
      orgId: ORG, entityId: ENT, orderId,
      patch: { lines: [{ id: orderLineId, description: "Widget", sku: "WIDGET", quantityMilli: 50_000n, unitPriceMinor: 2_500n }] },
    })).rejects.toThrow(
      /invoiced for 40 and has had 60 delivered, and the delivered quantity is the binding one/,
    );
  });

  it("empties once the whole order is invoiced", async () => {
    await invoiceOrder({ orgId: ORG, orderId, entityId: ENT });
    const r = await deliveredNotInvoiced({ ...S, asOf: "2026-03-31" });
    expect(r.rows).toEqual([]);
    expect(r.totals.valueMinor).toBe(0n);
  });

  it("refuses to cancel a note the goods have left under", async () => {
    await expect(cancelDeliveryNote({ ...S, number: "DN-1", reason: "wrong address" }))
      .rejects.toThrow(/goods have physically left/);
  });

  it("cancels a draft, and stops it counting against the order", async () => {
    const other = await createOrder({
      ...S,
      order: {
        number: "SO-2", kind: "ORDER", customerName: "Gamma LLC", issuedOn: "2026-04-01",
        lines: [{ description: "Widget", sku: "WIDGET", quantityMilli: 10_000n, unitPriceMinor: 3_000n }],
      },
    });
    await sendOrder({ orgId: ORG, orderId: other.id, entityId: ENT });
    await acceptOrder({ orgId: ORG, orderId: other.id, entityId: ENT, acceptedOn: "2026-04-01" });
    const line = await db.salesOrderLine.findFirst({ where: { orderId: other.id } });

    await createDeliveryNote({
      ...S,
      note: {
        number: "DN-4", orderId: other.id, deliveredOn: "2026-04-02",
        lines: [{ sku: "WIDGET", description: "Widget", quantityMilli: 10_000n, orderLineId: line!.id }],
      },
    });
    expect((await outstandingOnOrder({ ...S, orderId: other.id })).lines[0].outstandingMilli).toBe(0n);

    await cancelDeliveryNote({ ...S, number: "DN-4", reason: "customer deferred" });
    expect((await outstandingOnOrder({ ...S, orderId: other.id })).lines[0].outstandingMilli).toBe(10_000n);
  });

  it("takes goods back at the cost they left at, not at today's", async () => {
    // A second purchase at 3.00 lifts the weighted average well above 1.00.
    await receive({ ...S, sku: "WIDGET", movedOn: "2026-04-10", quantityMilli: 40_000n, valueMinor: 120_000n, reference: "GRN-2" });
    const item = await db.inventoryItem.findFirst({ where: { orgId: ORG, sku: "WIDGET" } });
    // 40 left at 1.00 plus 40 at 3.00 is 160.00 over 80, i.e. 2.00 each.
    expect(item!.valueMinor).toBe(160_000n);

    const before = await ledgerBalances({ ...S, codes: ["1200"] });
    const r = await returnGoods({ ...S, number: "DN-2", lines: [{ lineNo: 1, quantityMilli: 10_000n }], returnedOn: "2026-04-12" });
    // Ten of the twenty that left at 1.00 each: 100.00, not 200.00.
    expect(r.valueMinor).toBe(10_000n);
    const after = await ledgerBalances({ ...S, codes: ["1200"] });
    expect(after.get("1200")! - before.get("1200")!).toBe(10_000n);
  });

  it("refuses to take back more than went out", async () => {
    await expect(returnGoods({ ...S, number: "DN-2", lines: [{ lineNo: 1, quantityMilli: 21_000n }] }))
      .rejects.toThrow(/More cannot return than went out/);
  });

  it("refuses a return against a note nothing has left under", async () => {
    await createDeliveryNote({
      ...S,
      note: {
        number: "DN-5", customerName: "Direct", deliveredOn: "2026-04-15",
        lines: [{ sku: "WIDGET", description: "Widget", quantityMilli: 1_000n }],
      },
    });
    await expect(returnGoods({ ...S, number: "DN-5" })).rejects.toThrow(/nothing can come back/);
  });

  it("delivers without an order at all", async () => {
    const r = await dispatchNote({ ...S, number: "DN-5" });
    // Ninety units carried at 170.00 after the return, so 1.888… each. The
    // return put stock back at 1.00 and moved the average down; that is the
    // whole point of receiving it at the cost it left at.
    expect(r.costMinor).toBe(1_888n);
    const o = await deliveredNotInvoiced({ ...S, asOf: "2026-04-30" });
    // It belongs to no order, so it has no price to be measured against and
    // is deliberately not in the uninvoiced list.
    expect(o.rows.some((x) => x.number === "DN-5")).toBe(false);
  });

  it("moves no stock for a line carrying no SKU", async () => {
    await createDeliveryNote({
      ...S,
      note: {
        number: "DN-6", customerName: "Direct", deliveredOn: "2026-04-16",
        lines: [{ description: "Carriage", quantityMilli: 1_000n }],
      },
    });
    const r = await dispatchNote({ ...S, number: "DN-6" });
    expect(r.costMinor).toBe(0n);
    expect(r.lines).toEqual([]);
    expect(r.note).toContain("No stock moved");
  });

  it("refuses a duplicate note number", async () => {
    await expect(createDeliveryNote({
      ...S, note: { number: "DN-1", customerName: "Direct", deliveredOn: "2026-04-17", lines: [{ description: "x", quantityMilli: 1_000n }] },
    })).rejects.toThrow(/already a delivery note DN-1/);
  });

  it("lists the register and names what nobody has signed for", async () => {
    const r = await deliveryRegister({ ...S, from: "2026-01-01", to: "2026-12-31" });
    expect(r.summary.total).toBeGreaterThanOrEqual(5);
    expect(r.summary.delivered).toBe(1);            // only DN-2 was signed
    expect(r.summary.unsigned).toContain("DN-1");
    expect(r.summary.unsigned).not.toContain("DN-2");
  });

  it("counts every note in the period, not the ones that fit on the page", async () => {
    // The four counts are a groupBy over the period. The page is a page: the
    // two are allowed to differ, and `truncated` is what says they do.
    const r = await deliveryRegister({ ...S, from: "2026-01-01", to: "2026-12-31" });
    const inPeriod = await db.deliveryNote.count({
      where: {
        orgId: ORG, entityId: ENT,
        deliveredOn: { gte: new Date("2026-01-01T00:00:00.000Z"), lte: new Date("2026-12-31T00:00:00.000Z") },
      },
    });
    expect(r.summary.total).toBe(inPeriod);
    expect(r.summary.draft + r.summary.dispatched + r.summary.delivered + r.summary.cancelled)
      .toBe(r.summary.total);
    expect(r.truncated).toBe(false);
    expect(r.listed).toBe(r.notes.length);
  });

  it("counts the filtered set when a status is asked for, and nothing else", async () => {
    const drafts = await deliveryRegister({ ...S, from: "2026-01-01", to: "2026-12-31", status: "draft" });
    expect(drafts.notes.every((n) => n.status === "draft")).toBe(true);
    expect(drafts.summary.total).toBe(drafts.summary.draft);
    expect(drafts.summary.dispatched).toBe(0);
    // A register narrowed to drafts must not answer a question about
    // dispatched notes: nothing here has gone out at all.
    expect(drafts.summary.unsigned).toEqual([]);
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(deliveryRegister({ ...S, from: "2026-12-31", to: "2026-01-01" }))
      .rejects.toThrow(/ends before it starts/);
  });

  it("keeps the trial balance tied after everything above", async () => {
    const tb = await trialBalance({ ...S, periodLabel: "2026-04" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });

  it("never lets one organisation reach another's notes", async () => {
    await expect(dispatchNote({ orgId: "t-org-dn-2", entityId: ENT, number: "DN-1" }))
      .rejects.toThrow(/no delivery note DN-1/);
  });
});

describe("quantities read as somebody would write them", () => {
  it("drops the trailing zeroes of a thousandth", () => {
    expect(fmtQty(60_000n)).toBe("60");
    expect(fmtQty(1_500n)).toBe("1.5");
    expect(fmtQty(1n)).toBe("0.001");
    expect(fmtQty(0n)).toBe("0");
  });
});
