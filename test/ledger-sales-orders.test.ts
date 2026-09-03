import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createOrder, updateOrder,
  sendOrder, acceptOrder, declineOrder, cancelOrder,
  convertToOrder, invoiceOrder, expireQuotes,
  listOrders, orderDetail, lineNet,
  type NewSalesOrder, type NewSalesOrderLine,
} from "@/lib/server/ledger/sales-orders";
import { LedgerError } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-so";
const ENT = "t-ent-so";
/** A neighbour in the same database: every read must be blind to it. */
const OTHER_ORG = "t-org-so-neighbour";

async function wipe() {
  for (const org of [ORG, OTHER_ORG]) {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(`DELETE FROM "SalesOrderLine" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "SalesOrder" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${org}'`),
    ]);
  }
}

/* Ten surveys at 1,250.00, ten percent off, standard rated:
   125000 × 10 × 0.9 = 1,125,000 fils net. */
const survey = (): NewSalesOrderLine => ({
  description: "Site survey",
  sku: "SURVEY",
  quantityMilli: 10_000,
  unitPriceMinor: 1_250_00,
  discountBps: 1000,
  taxCode: "SR",
});

/* Four weeks of scaffold at 300.00, no discount: 120,000 fils net. */
const scaffold = (): NewSalesOrderLine => ({
  description: "Scaffold hire",
  quantityMilli: 4_000,
  unitPriceMinor: 300_00,
});

/* One export freight charge at 500.00, zero rated: 50,000 fils net, no tax. */
const freight = (): NewSalesOrderLine => ({
  description: "Export freight",
  quantityMilli: 1_000,
  unitPriceMinor: 500_00,
  taxCode: "ZERO_EXPORT",
});

async function raise(order: Partial<NewSalesOrder> = {}) {
  return createOrder({
    orgId: ORG,
    entityId: ENT,
    order: { customerName: "Marri Trading LLC", issuedOn: "2026-05-01", ...order } as NewSalesOrder,
  });
}

/** A document the customer has been sent. */
async function sent(order: Partial<NewSalesOrder> = {}) {
  const doc = await raise({ lines: [survey()], ...order });
  await sendOrder({ orgId: ORG, orderId: doc.id, entityId: ENT });
  return doc;
}

/** A document the customer has agreed to. */
async function agreed(order: Partial<NewSalesOrder> = {}) {
  const doc = await sent(order);
  await acceptOrder({ orgId: ORG, orderId: doc.id, entityId: ENT });
  return doc;
}

const statusOf = async (id: string) =>
  (await db.salesOrder.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

d("quotations and sales orders", () => {
  beforeAll(async () => { await wipe(); });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------- raising one --- */

  it("numbers a quotation from the entity's own sequence and posts nothing", async () => {
    const quote = await raise({
      validUntil: "2026-05-31",
      customerCode: "MARRI",
      lines: [survey(), scaffold(), freight()],
    });

    expect(quote.number).toBe("SQ-00001");
    expect(quote.kind).toBe("QUOTE");
    expect(quote.status).toBe("draft");
    expect(quote.lines).toHaveLength(3);
    expect(quote.lines[0].lineNo).toBe(1);
    expect(quote.lines[0].invoicedMilli).toBe(0n);

    const second = await raise({ lines: [scaffold()] });
    expect(second.number).toBe("SQ-00002");

    // Orders are counted separately: two documents sharing a number are two
    // documents somebody will file as one.
    const order = await raise({ kind: "ORDER", lines: [scaffold()] });
    expect(order.number).toBe("SO-00001");
    expect(order.kind).toBe("ORDER");
  });

  it("prices each line after its discount and taxes it at its own code", async () => {
    const quote = await db.salesOrder.findFirstOrThrow({ where: { orgId: ORG, number: "SQ-00001" } });
    const detail = await orderDetail({ orgId: ORG, orderId: quote.id, entityId: ENT });

    expect(detail.lines[0].netMinor).toBe("1125000");
    expect(detail.lines[1].netMinor).toBe("120000");
    expect(detail.lines[2].netMinor).toBe("50000");

    // 1,245,000 standard rated at five percent, and the freight zero rated.
    expect(detail.totals.netMinor).toBe("1295000");
    expect(detail.totals.vatMinor).toBe("62250");
    expect(detail.totals.grossMinor).toBe("1357250");

    const standard = detail.totals.taxes.find((t) => t.taxCode === "STANDARD_5");
    const zero = detail.totals.taxes.find((t) => t.taxCode === "ZERO_EXPORT");
    expect(standard?.netMinor).toBe("1245000");
    expect(standard?.vatMinor).toBe("62250");
    expect(zero?.vatMinor).toBe("0");
    expect(detail.lines[2].ratePercent).toBe(0);

    // Nothing invoiced yet, so the whole document is still to come.
    expect(detail.invoiced.netMinor).toBe("0");
    expect(detail.remaining.netMinor).toBe("1295000");
  });

  it("rounds a line once, half up, rather than twice", async () => {
    // 33 fils for one and a half units is 49.5 — rounded up, and rounded only
    // after the discount, never before it.
    expect(lineNet(33n, 1_500n, 0)).toBe(50n);
    expect(lineNet(1_250_00n, 10_000n, 1000)).toBe(1_125_000n);
    expect(lineNet(100_00n, 3_000n, 10_000)).toBe(0n);

    const odd = await raise({ lines: [{ description: "Consumables", quantityMilli: 1_500, unitPriceMinor: 33 }] });
    const detail = await orderDetail({ orgId: ORG, orderId: odd.id });
    expect(detail.totals.netMinor).toBe("50");
    // Five percent of 50 fils is 2.5, which is 3 the way tax rounds.
    expect(detail.totals.vatMinor).toBe("3");
  });

  /* ------------------------------------- refusing what the database would */

  it("refuses a line the database would refuse, and says which line and why", async () => {
    await expect(raise({ lines: [{ ...survey(), discountBps: 12_000 }] }))
      .rejects.toThrow(/discount runs from nothing to the whole of the line/i);
    await expect(raise({ lines: [{ ...survey(), quantityMilli: 0 }] }))
      .rejects.toThrow(/Offering nothing is not an offer/i);
    await expect(raise({ lines: [{ ...survey(), unitPriceMinor: -100 }] }))
      .rejects.toThrow(/credit note/i);
    await expect(raise({ lines: [{ ...survey(), taxCode: "STANDARD_FIVE" }] }))
      .rejects.toThrow(/does not know/i);
    await expect(raise({ lines: [{ ...survey(), description: "  " }] }))
      .rejects.toThrow(/needs a description/i);
  });

  it("refuses a validity date before the issue date, and a number already in use", async () => {
    await expect(raise({ issuedOn: "2026-05-01", validUntil: "2026-04-01", lines: [survey()] }))
      .rejects.toThrow(/expires before it is made/i);

    await raise({ number: "SQ-MANUAL", lines: [survey()] });
    await expect(raise({ number: "SQ-MANUAL", lines: [survey()] }))
      .rejects.toThrow(/already in use/i);
  });

  /* ------------------------------------------------- the state machine --- */

  it("refuses an illegal transition, naming the state and what it allows", async () => {
    const draft = await raise({ lines: [survey()] });

    const refusal = acceptOrder({ orgId: ORG, orderId: draft.id, entityId: ENT });
    await expect(refusal).rejects.toBeInstanceOf(LedgerError);
    await expect(refusal).rejects.toThrow(/is draft/i);
    await expect(refusal).rejects.toThrow(/send it to the customer/i);

    const empty = await raise();
    await expect(sendOrder({ orgId: ORG, orderId: empty.id, entityId: ENT }))
      .rejects.toThrow(/nothing to send/i);

    expect((await sendOrder({ orgId: ORG, orderId: draft.id, entityId: ENT })).status).toBe("sent");
    await expect(sendOrder({ orgId: ORG, orderId: draft.id, entityId: ENT }))
      .rejects.toThrow(/is sent/i);

    expect((await acceptOrder({ orgId: ORG, orderId: draft.id, entityId: ENT })).status).toBe("accepted");
    await expect(declineOrder({ orgId: ORG, orderId: draft.id, entityId: ENT, reason: "Too late" }))
      .rejects.toThrow(/is accepted/i);
  });

  it("cancels what nobody has been billed for, and records why", async () => {
    const doc = await sent({ customerName: "Al Noor Interiors" });
    const cancelled = await cancelOrder({ orgId: ORG, orderId: doc.id, entityId: ENT, reason: "Customer went elsewhere" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.notes).toContain("Customer went elsewhere");

    // Cancelling twice is the same act, not an error.
    expect((await cancelOrder({ orgId: ORG, orderId: doc.id, entityId: ENT })).status).toBe("cancelled");
  });

  /* -------------------------------------------------------- conversion --- */

  it("carries an accepted quotation onto an order, and leaves the quotation as it was", async () => {
    const quote = await agreed({
      customerCode: "MARRI",
      customerTrn: "100123456789003",
      validUntil: "2026-06-30",
      lines: [survey(), freight()],
    });

    const order = await convertToOrder({ orgId: ORG, quoteId: quote.id, entityId: ENT });
    expect(order.kind).toBe("ORDER");
    expect(order.number).toMatch(/^SO-\d{5}$/);
    expect(order.status).toBe("accepted");
    expect(order.customerTrn).toBe("100123456789003");
    // An agreement does not lapse because a quotation's validity date passed.
    expect(order.validUntil).toBeNull();
    expect(order.lines).toHaveLength(2);
    expect(order.lines[0].quantityMilli).toBe(10_000n);
    expect(order.lines[0].discountBps).toBe(1000);
    expect(order.lines[1].taxCode).toBe("ZERO_EXPORT");
    expect(order.lines[0].invoicedMilli).toBe(0n);
    expect(order.notes).toContain(`Converted from ${quote.number}`);

    // The quotation is the evidence of what was agreed; it stays agreed.
    expect(await statusOf(quote.id)).toBe("accepted");

    await expect(convertToOrder({ orgId: ORG, quoteId: quote.id, entityId: ENT }))
      .rejects.toThrow(new RegExp(`already become ${order.number}`, "i"));
    await expect(convertToOrder({ orgId: ORG, quoteId: order.id, entityId: ENT }))
      .rejects.toThrow(/already a sales order/i);
  });

  it("refuses to convert a quotation the customer turned down or let lapse", async () => {
    const declined = await sent({ customerName: "Bright Facilities" });
    await declineOrder({ orgId: ORG, orderId: declined.id, entityId: ENT, reason: "Price" });
    await expect(convertToOrder({ orgId: ORG, quoteId: declined.id, entityId: ENT }))
      .rejects.toThrow(/is declined/i);

    const lapsed = await sent({ customerName: "Cove Marine", issuedOn: "2025-11-01", validUntil: "2025-11-30" });
    await expireQuotes({ orgId: ORG, entityId: ENT, asOf: "2025-12-01" });
    expect(await statusOf(lapsed.id)).toBe("expired");
    await expect(convertToOrder({ orgId: ORG, quoteId: lapsed.id, entityId: ENT }))
      .rejects.toThrow(/is expired/i);
  });

  /* --------------------------------------------------------- invoicing --- */

  it("records what has been invoiced, refuses more than is left, and posts nothing", async () => {
    const quote = await agreed({ customerName: "Harbour Fitout", lines: [survey(), scaffold()] });
    const order = await convertToOrder({ orgId: ORG, quoteId: quote.id, entityId: ENT });
    const line = order.lines[0];

    const first = await invoiceOrder({
      orgId: ORG, orderId: order.id, entityId: ENT,
      lines: [{ orderLineId: line.id, quantityMilli: 4_000 }],
    });
    expect(first.status).toBe("part_invoiced");
    // Four surveys at 1,250.00 less ten percent, and the tax on them.
    expect(first.totals.netMinor).toBe("450000");
    expect(first.totals.vatMinor).toBe("22500");
    expect(first.lines[0].remainingMilli).toBe("6000");
    expect(await statusOf(order.id)).toBe("part_invoiced");

    const detail = await orderDetail({ orgId: ORG, orderId: order.id, entityId: ENT });
    expect(detail.invoiced.netMinor).toBe("450000");
    expect(detail.remaining.netMinor).toBe("795000");
    expect(detail.lines[0].remainingMilli).toBe("6000");

    await expect(invoiceOrder({
      orgId: ORG, orderId: order.id, entityId: ENT,
      lines: [{ orderLineId: line.id, quantityMilli: 7_000 }],
    })).rejects.toThrow(/only 6 is left to invoice/i);

    // No lines given: everything still outstanding.
    const rest = await invoiceOrder({ orgId: ORG, orderId: order.id, entityId: ENT });
    expect(rest.status).toBe("invoiced");
    expect(rest.lines).toHaveLength(2);
    expect(rest.totals.netMinor).toBe("795000");

    await expect(invoiceOrder({ orgId: ORG, orderId: order.id, entityId: ENT }))
      .rejects.toThrow(/every line has been invoiced in full/i);
  });

  it("refuses to invoice a quotation, or an order nobody has accepted", async () => {
    const quote = await agreed({ customerName: "Pearl Joinery" });
    await expect(invoiceOrder({ orgId: ORG, orderId: quote.id, entityId: ENT }))
      .rejects.toThrow(/quotation, not a sales order/i);

    const order = await raise({ kind: "ORDER", customerName: "Pearl Joinery", lines: [scaffold()] });
    await expect(invoiceOrder({ orgId: ORG, orderId: order.id, entityId: ENT }))
      .rejects.toThrow(/is draft/i);
  });

  /* ----------------------------------------------------------- editing --- */

  it("will not cut a line below what has already been invoiced", async () => {
    const quote = await agreed({ customerName: "Souk Retail", lines: [survey(), scaffold()] });
    const order = await convertToOrder({ orgId: ORG, quoteId: quote.id, entityId: ENT });
    const [first, second] = order.lines;

    await invoiceOrder({
      orgId: ORG, orderId: order.id, entityId: ENT,
      lines: [{ orderLineId: first.id, quantityMilli: 4_000 }],
    });

    const cut = updateOrder({
      orgId: ORG, orderId: order.id, entityId: ENT,
      patch: {
        lines: [
          { id: first.id, description: "Site survey", quantityMilli: 2_000, unitPriceMinor: 1_250_00, discountBps: 1000 },
          { id: second.id, description: "Scaffold hire", quantityMilli: 4_000, unitPriceMinor: 300_00 },
        ],
      },
    });
    await expect(cut).rejects.toThrow(/already been invoiced for 4/i);
    await expect(cut).rejects.toThrow(/cannot be cut to 2/i);

    // Dropping the line altogether is the same cut by another route.
    await expect(updateOrder({
      orgId: ORG, orderId: order.id, entityId: ENT,
      patch: { lines: [{ id: second.id, description: "Scaffold hire", quantityMilli: 4_000, unitPriceMinor: 300_00 }] },
    })).rejects.toThrow(/cannot be taken off the order/i);

    // Varying it upward is what a customer asking for more looks like.
    const grown = await updateOrder({
      orgId: ORG, orderId: order.id, entityId: ENT,
      patch: {
        customerCode: "SOUK",
        lines: [
          { id: first.id, description: "Site survey", quantityMilli: 12_000, unitPriceMinor: 1_250_00, discountBps: 1000 },
          { id: second.id, description: "Scaffold hire", quantityMilli: 4_000, unitPriceMinor: 300_00 },
          { description: "Out of hours cover", quantityMilli: 2_000, unitPriceMinor: 90_00 },
        ],
      },
    });
    expect(grown.lines).toHaveLength(3);
    expect(grown.lines[0].quantityMilli).toBe(12_000n);
    expect(grown.lines[0].invoicedMilli).toBe(4_000n);
    expect(grown.customerCode).toBe("SOUK");
    expect(grown.lines[2].lineNo).toBe(3);
  });

  it("will not edit a document whose whole value is that it says what it said", async () => {
    const dead = await sent({ customerName: "Rimal Contracting" });
    await cancelOrder({ orgId: ORG, orderId: dead.id, entityId: ENT, reason: "Withdrawn" });
    await expect(updateOrder({
      orgId: ORG, orderId: dead.id, entityId: ENT, patch: { customerName: "Someone else" },
    })).rejects.toThrow(/is cancelled/i);
  });

  /* ------------------------------------------------------------ expiry --- */

  it("expires the quotes that lapsed, leaves the rest, and does nothing the second time", async () => {
    const lapses = await sent({ customerName: "Delta Signage", issuedOn: "2026-01-01", validUntil: "2026-01-31" });
    const laterQuote = await sent({ customerName: "Echo Systems", issuedOn: "2026-01-01", validUntil: "2026-02-15" });
    const agreedQuote = await agreed({ customerName: "Fujairah Stone", issuedOn: "2026-01-01", validUntil: "2026-01-15" });

    const first = await expireQuotes({ orgId: ORG, entityId: ENT, asOf: "2026-02-01" });
    expect(first.asOf).toBe("2026-02-01");
    expect(first.expired).toBe(1);
    expect(first.quotes.map((q) => q.number)).toEqual([lapses.number]);
    expect(await statusOf(lapses.id)).toBe("expired");

    // Only a quote expires, and it stays a quote when it does.
    const expired = await db.salesOrder.findUniqueOrThrow({ where: { id: lapses.id } });
    expect(expired.kind).toBe("QUOTE");

    // The customer already said yes, so the date does not undo it.
    expect(await statusOf(agreedQuote.id)).toBe("accepted");

    const again = await expireQuotes({ orgId: ORG, entityId: ENT, asOf: "2026-02-01" });
    expect(again.expired).toBe(0);
    expect(again.quotes).toEqual([]);

    // Valid *until* the 15th means it is still an offer on the 15th.
    expect((await expireQuotes({ orgId: ORG, entityId: ENT, asOf: "2026-02-15" })).expired).toBe(0);
    expect(await statusOf(laterQuote.id)).toBe("sent");
    expect((await expireQuotes({ orgId: ORG, entityId: ENT, asOf: "2026-02-16" })).expired).toBe(1);
    expect(await statusOf(laterQuote.id)).toBe("expired");
  });

  /* ----------------------------------------------------------- reading --- */

  it("lists what was asked for and nothing else", async () => {
    const all = await listOrders({ orgId: ORG, entityId: ENT });
    expect(all.orders.length).toBeGreaterThan(5);

    const quotes = await listOrders({ orgId: ORG, entityId: ENT, kind: "QUOTE" });
    expect(quotes.orders.every((o) => o.kind === "QUOTE")).toBe(true);
    expect(quotes.orders.length).toBeLessThan(all.orders.length);

    const invoiced = await listOrders({ orgId: ORG, entityId: ENT, status: "invoiced" });
    expect(invoiced.orders.length).toBeGreaterThan(0);
    expect(invoiced.orders.every((o) => o.status === "invoiced")).toBe(true);
    expect(invoiced.orders.every((o) => o.remainingNetMinor === "0")).toBe(true);

    const souk = await listOrders({ orgId: ORG, entityId: ENT, customerCode: "SOUK" });
    expect(souk.orders).toHaveLength(1);
    expect(souk.orders[0].customerName).toBe("Souk Retail");
    // Twelve surveys less ten percent (1,350,000), four weeks of scaffold
    // (120,000) and two of out-of-hours cover (18,000).
    expect(souk.orders[0].netMinor).toBe("1488000");
    expect(souk.orders[0].vatMinor).toBe("74400");
    expect(souk.orders[0].grossMinor).toBe("1562400");
    expect(souk.totals.grossMinor).toBe("1562400");
  });

  /* -------------------------------------------------------- other orgs --- */

  it("is blind to another organisation's documents, and to another entity's", async () => {
    const quote = await raise({ customerName: "Private Ltd", lines: [survey()] });

    await expect(orderDetail({ orgId: OTHER_ORG, orderId: quote.id }))
      .rejects.toThrow(/does not exist/i);
    await expect(sendOrder({ orgId: OTHER_ORG, orderId: quote.id }))
      .rejects.toThrow(/does not exist/i);
    await expect(invoiceOrder({ orgId: OTHER_ORG, orderId: quote.id }))
      .rejects.toThrow(/does not exist/i);
    await expect(updateOrder({ orgId: OTHER_ORG, orderId: quote.id, patch: { customerName: "Theirs" } }))
      .rejects.toThrow(/does not exist/i);
    await expect(cancelOrder({ orgId: OTHER_ORG, orderId: quote.id }))
      .rejects.toThrow(/does not exist/i);

    // The right organisation, the wrong entity, is still the wrong document.
    await expect(orderDetail({ orgId: ORG, orderId: quote.id, entityId: "t-ent-so-other" }))
      .rejects.toThrow(/does not exist/i);

    expect((await listOrders({ orgId: OTHER_ORG, entityId: ENT })).orders).toHaveLength(0);
    expect((await expireQuotes({ orgId: OTHER_ORG, entityId: ENT, asOf: "2030-01-01" })).expired).toBe(0);
    // …and the neighbour's sweep left ours exactly where it was.
    expect(await statusOf(quote.id)).toBe("draft");
  });
});
