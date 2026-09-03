import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { issue, receive } from "./inventory";
import { lineNet } from "./sales-orders";

/**
 * Delivery notes.
 *
 * Between an order and an invoice there is a lorry, and the product had
 * nowhere to record it. The gap is not cosmetic. Goods delivered and not yet
 * invoiced are revenue the business has earned and cannot see, and the cost of
 * them has already left inventory — so a distribution business that cannot
 * list them is guessing at its own margin every month end, in the direction
 * that flatters it.
 *
 * A delivery note is a document, not a journal. Dispatching moves cost out of
 * inventory through the ordinary issue path, and nothing else: the revenue
 * stays on the invoice, where it belongs. Conflating the two is what produces
 * a ledger in which the stock is gone and nobody was ever billed.
 *
 * Three things it insists on.
 *
 * It will not deliver more than the order says. Cumulative delivery against an
 * order line is checked against the ordered quantity, across every note, and
 * over-delivery is refused with the figures. The answer to "they wanted more"
 * is to change the order — an order that says one thing while the lorries say
 * another is not a control, it is a decoration.
 *
 * It will not cancel goods that have gone. A dispatched note cannot be
 * cancelled, because the stock has physically left; the document for goods
 * coming back is a return, and returning them puts them back at the cost they
 * left at rather than at today's average. Taking them back at today's cost
 * would move the margin of a sale that has not happened.
 *
 * It will not invoice. Delivered-not-invoiced is a report, and the invoice is
 * raised on the sales order screen by somebody who has looked at it.
 */

const MILLI = 1000n;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

function asDate(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? day(v.slice(0, 10)) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date I can read.`);
  return d;
}

function qtyOf(v: number | bigint | string, what: string): bigint {
  try {
    const b = typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.round(v) : v.trim());
    if (b <= 0n) throw new Error();
    return b;
  } catch {
    throw new LedgerError(`${what} has to be a quantity above nothing.`);
  }
}

/** Thousandths, as a number somebody would write on a note. */
export function fmtQty(milli: bigint): string {
  const neg = milli < 0n;
  const s = (neg ? -milli : milli).toString().padStart(4, "0");
  const body = `${s.slice(0, -3)}.${s.slice(-3)}`.replace(/\.?0+$/, "");
  return `${neg ? "-" : ""}${body || "0"}`;
}

export type NoteStatus = "draft" | "dispatched" | "delivered" | "cancelled";

export interface NewDeliveryLine {
  sku?: string | null;
  description: string;
  quantityMilli: number | bigint | string;
  orderLineId?: string | null;
}

export interface NewDeliveryNote {
  number: string;
  orderId?: string | null;
  customerName?: string;
  deliveredOn: Date | string;
  carrier?: string;
  trackingRef?: string;
  notes?: string;
  lines: NewDeliveryLine[];
}

/* ------------------------------------------------------------- what is owed */

/**
 * How much of each order line is still to go, across every note that is not
 * cancelled.
 *
 * A draft note counts. It is a commitment somebody has made on paper, and
 * leaving it out means two people can each raise a draft for the last of the
 * stock and both be told it is available.
 */
export async function outstandingOnOrder(opts: { orgId: string; orderId: string }) {
  const order = await prisma.salesOrder.findFirst({
    where: { id: opts.orderId, orgId: opts.orgId },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!order) throw new LedgerError("There is no such order.");

  const delivered = await prisma.deliveryNoteLine.findMany({
    where: {
      orgId: opts.orgId,
      orderLineId: { in: order.lines.map((l) => l.id) },
      note: { status: { not: "cancelled" } },
    },
    select: { orderLineId: true, quantityMilli: true },
  });

  const by = new Map<string, bigint>();
  for (const d of delivered) {
    if (!d.orderLineId) continue;
    by.set(d.orderLineId, (by.get(d.orderLineId) ?? 0n) + d.quantityMilli);
  }

  return {
    orderId: order.id,
    number: order.number,
    customerName: order.customerName,
    lines: order.lines.map((l) => {
      const done = by.get(l.id) ?? 0n;
      return {
        orderLineId: l.id,
        lineNo: l.lineNo,
        sku: l.sku,
        description: l.description,
        orderedMilli: l.quantityMilli,
        deliveredMilli: done,
        outstandingMilli: l.quantityMilli - done,
        invoicedMilli: l.invoicedMilli,
        unitPriceMinor: l.unitPriceMinor,
        discountBps: l.discountBps,
      };
    }),
  };
}

/* ------------------------------------------------------------- the document */

export async function createDeliveryNote(opts: {
  orgId: string; entityId: string; note: NewDeliveryNote;
}) {
  const n = opts.note;
  const number = n.number.trim();
  if (!number) throw new LedgerError("A delivery note needs a number.");
  if (!n.lines.length) throw new LedgerError("A delivery note with no lines delivered nothing.");

  const deliveredOn = asDate(n.deliveredOn, "The delivery date");

  const clash = await prisma.deliveryNote.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, number },
  });
  if (clash) throw new LedgerError(`There is already a delivery note ${number}.`);

  let customerName = n.customerName?.trim() ?? "";
  let outstanding: Awaited<ReturnType<typeof outstandingOnOrder>> | null = null;

  if (n.orderId) {
    outstanding = await outstandingOnOrder({ orgId: opts.orgId, orderId: n.orderId });
    if (!customerName) customerName = outstanding.customerName;

    // Over-delivery is refused here rather than at dispatch, because the
    // person typing the note is the one who can still fix it.
    const wanted = new Map<string, bigint>();
    for (const l of n.lines) {
      if (!l.orderLineId) continue;
      wanted.set(l.orderLineId, (wanted.get(l.orderLineId) ?? 0n) + qtyOf(l.quantityMilli, "A delivered quantity"));
    }
    for (const [orderLineId, q] of wanted) {
      const line = outstanding.lines.find((x) => x.orderLineId === orderLineId);
      if (!line) throw new LedgerError("A line names an order line that is not on that order.");
      if (q > line.outstandingMilli) {
        throw new LedgerError(
          `Line ${line.lineNo} of ${outstanding.number} has ${fmtQty(line.outstandingMilli)} still to go and this ` +
          `note delivers ${fmtQty(q)}. Change the order if the customer wants more — an order that says one thing ` +
          `while the lorries say another is not a control.`,
        );
      }
    }
  }

  if (!customerName) throw new LedgerError("A delivery note has to say who it went to.");

  return prisma.deliveryNote.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId, number,
      orderId: n.orderId ?? null,
      customerName,
      deliveredOn,
      carrier: n.carrier?.trim() || null,
      trackingRef: n.trackingRef?.trim() || null,
      notes: n.notes?.trim() || null,
      lines: {
        create: n.lines.map((l, i) => ({
          orgId: opts.orgId,
          lineNo: i + 1,
          orderLineId: l.orderLineId ?? null,
          sku: l.sku?.trim() || null,
          description: l.description.trim() || l.sku?.trim() || "Goods",
          quantityMilli: qtyOf(l.quantityMilli, `Line ${i + 1}`),
        })),
      },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
}

async function loadNote(orgId: string, entityId: string, number: string) {
  const note = await prisma.deliveryNote.findFirst({
    where: { orgId, entityId, number: number.trim() },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!note) throw new LedgerError(`There is no delivery note ${number.trim()}.`);
  return note;
}

/**
 * The goods leave.
 *
 * Each line with a SKU issues stock under the note's number, so the issue is
 * idempotent on that reference: a dispatch interrupted halfway can simply be
 * run again and the movements that already happened are replayed rather than
 * repeated. A line with no SKU — a service, a carriage charge somebody wrote
 * on the note — moves no stock, and says nothing, because there is no cost of
 * its own to move.
 */
export async function dispatchNote(opts: {
  orgId: string; entityId: string; number: string; actorId?: string;
}) {
  const note = await loadNote(opts.orgId, opts.entityId, opts.number);
  if (note.status === "cancelled") throw new LedgerError(`${note.number} was cancelled.`);
  if (note.status !== "draft") throw new LedgerError(`${note.number} has already been dispatched.`);

  const moved: { lineNo: number; sku: string; quantityMilli: string; costMinor: string; replayed: boolean }[] = [];
  let costMinor = 0n;

  for (const line of note.lines) {
    if (!line.sku) continue;
    const r = await issue({
      orgId: opts.orgId, entityId: opts.entityId,
      sku: line.sku,
      movedOn: iso(note.deliveredOn),
      quantityMilli: line.quantityMilli,
      reference: note.number,
      memo: `Delivered to ${note.customerName}`,
      actorId: opts.actorId,
    });
    await prisma.deliveryNoteLine.update({
      where: { id: line.id },
      data: { costMinor: BigInt(r.valueMinor) < 0n ? -BigInt(r.valueMinor) : BigInt(r.valueMinor), movementId: r.movementId },
    });
    const cost = BigInt(r.valueMinor) < 0n ? -BigInt(r.valueMinor) : BigInt(r.valueMinor);
    costMinor += cost;
    moved.push({
      lineNo: line.lineNo, sku: line.sku,
      quantityMilli: line.quantityMilli.toString(),
      costMinor: cost.toString(),
      replayed: r.replayed === true,
    });
  }

  await prisma.deliveryNote.update({ where: { id: note.id }, data: { status: "dispatched" } });

  return {
    number: note.number,
    status: "dispatched" as NoteStatus,
    costMinor,
    lines: moved,
    note:
      moved.length === 0
        ? `${note.number} is dispatched. No stock moved — nothing on it carries a SKU.`
        : `${note.number} is dispatched. Cost of ${moved.length} line${moved.length === 1 ? "" : "s"} has left ` +
          `inventory; nothing has been invoiced.`,
  };
}

/** The customer signs. A signature is evidence, not a posting — nothing moves. */
export async function confirmDelivery(opts: {
  orgId: string; entityId: string; number: string; signedBy: string; signedOn?: Date | string;
}) {
  const note = await loadNote(opts.orgId, opts.entityId, opts.number);
  if (note.status === "draft") {
    throw new LedgerError(`${note.number} has not been dispatched, so nobody can have signed for it.`);
  }
  if (note.status === "cancelled") throw new LedgerError(`${note.number} was cancelled.`);
  const signedBy = opts.signedBy.trim();
  if (!signedBy) throw new LedgerError("Who signed for it?");

  return prisma.deliveryNote.update({
    where: { id: note.id },
    data: {
      status: "delivered",
      signedBy,
      signedOn: opts.signedOn ? asDate(opts.signedOn, "The date it was signed") : note.deliveredOn,
    },
  });
}

/** Cancel a note nothing has left under. Once the goods have gone, the document is a return. */
export async function cancelDeliveryNote(opts: {
  orgId: string; entityId: string; number: string; reason?: string;
}) {
  const note = await loadNote(opts.orgId, opts.entityId, opts.number);
  if (note.status !== "draft") {
    throw new LedgerError(
      `${note.number} has been dispatched — the goods have physically left, and cancelling the paper would not ` +
      `bring them back. Record a return instead, which puts the stock back at the cost it left at.`,
    );
  }
  return prisma.deliveryNote.update({
    where: { id: note.id },
    data: {
      status: "cancelled",
      notes: opts.reason?.trim() ? `${note.notes ? `${note.notes} — ` : ""}Cancelled: ${opts.reason.trim()}` : note.notes,
    },
  });
}

/**
 * Goods come back.
 *
 * They are received at the cost they left at, taken from the line's own
 * recorded cost, not at the item's cost today. Today's cost is an average that
 * has moved since — receiving a return at it would change the margin of a sale
 * that has not been made, in whichever direction the last purchase happened to
 * go.
 */
export async function returnGoods(opts: {
  orgId: string; entityId: string; number: string;
  lines?: { lineNo: number; quantityMilli: number | bigint | string }[];
  returnedOn?: Date | string;
  reference?: string;
  actorId?: string;
}) {
  const note = await loadNote(opts.orgId, opts.entityId, opts.number);
  if (note.status === "draft") throw new LedgerError(`Nothing has left under ${note.number}, so nothing can come back.`);
  if (note.status === "cancelled") throw new LedgerError(`${note.number} was cancelled.`);

  const returnedOn = opts.returnedOn ? asDate(opts.returnedOn, "The return date") : new Date();
  const reference = (opts.reference ?? `RTN/${note.number}`).trim();

  const wanted = new Map<number, bigint>();
  for (const l of opts.lines ?? note.lines.map((l) => ({ lineNo: l.lineNo, quantityMilli: l.quantityMilli }))) {
    wanted.set(l.lineNo, qtyOf(l.quantityMilli, `Line ${l.lineNo}`));
  }

  const back: { lineNo: number; sku: string; quantityMilli: string; valueMinor: string }[] = [];
  let valueMinor = 0n;

  for (const [lineNo, q] of wanted) {
    const line = note.lines.find((l) => l.lineNo === lineNo);
    if (!line) throw new LedgerError(`${note.number} has no line ${lineNo}.`);
    if (!line.sku) throw new LedgerError(`Line ${lineNo} carries no SKU, so no stock left under it.`);
    if (line.costMinor === null) throw new LedgerError(`Line ${lineNo} has no recorded cost — it was never dispatched.`);
    if (q > line.quantityMilli) {
      throw new LedgerError(
        `Line ${lineNo} delivered ${fmtQty(line.quantityMilli)} and ${fmtQty(q)} is coming back. ` +
        `More cannot return than went out.`,
      );
    }

    // The cost of the part returning, apportioned from what the whole line
    // cost. Multiplication first, so a part of an odd cost does not lose a fil
    // to an intermediate division.
    const share = (line.costMinor * q + line.quantityMilli / 2n) / line.quantityMilli;

    const r = await receive({
      orgId: opts.orgId, entityId: opts.entityId,
      sku: line.sku,
      movedOn: iso(returnedOn),
      quantityMilli: q,
      valueMinor: share,
      reference: `${reference}/${lineNo}`,
      memo: `Returned from ${note.customerName} against ${note.number}`,
      actorId: opts.actorId,
    });
    valueMinor += share;
    back.push({ lineNo, sku: line.sku, quantityMilli: q.toString(), valueMinor: r.valueMinor });
  }

  return {
    number: note.number,
    reference,
    returnedOn: iso(returnedOn),
    valueMinor,
    lines: back,
    note:
      `Stock is back at the cost it left at, not at today's. The customer's invoice is a separate question — ` +
      `if they were billed for it, they need a credit note.`,
  };
}

/* --------------------------------------------------------------- the screen */

/**
 * Delivered and not invoiced.
 *
 * This is the report the whole module exists for. The cost has left inventory
 * and no revenue has been recognised against it, so every figure here is
 * margin the accounts are currently understating. It is valued at the order
 * price — what will be billed — and that is a memorandum figure: nothing on
 * the ledger carries it, and it is deliberately not posted as accrued income,
 * because whether a delivery is a performance obligation satisfied is an
 * IFRS 15 question and it is answered on the revenue screen.
 */
export async function deliveredNotInvoiced(opts: {
  orgId: string; entityId: string; asOf?: Date | string;
}) {
  const asOf = opts.asOf ? asDate(opts.asOf, "The date") : new Date();

  const notes = await prisma.deliveryNote.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      status: { in: ["dispatched", "delivered"] },
      deliveredOn: { lte: asOf },
      orderId: { not: null },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
    orderBy: { deliveredOn: "asc" },
  });

  const orderLineIds = [...new Set(notes.flatMap((n) => n.lines.map((l) => l.orderLineId).filter(Boolean) as string[]))];
  const orderLines = orderLineIds.length
    ? await prisma.salesOrderLine.findMany({ where: { id: { in: orderLineIds } }, include: { order: true } })
    : [];
  const byLine = new Map(orderLines.map((l) => [l.id, l]));

  // Invoiced quantity belongs to the order line, not to any one note, so it is
  // consumed against the notes in the order they were delivered. Anything else
  // would report the oldest delivery as unbilled while a later one was
  // invoiced first, which is the wrong way round for both ageing and chasing.
  const consumed = new Map<string, bigint>();
  const rows: {
    number: string; deliveredOn: string; customerName: string;
    orderNumber: string; sku: string | null; description: string;
    quantityMilli: bigint; uninvoicedMilli: bigint;
    costMinor: bigint | null; valueMinor: bigint;
  }[] = [];

  for (const n of notes) {
    for (const l of n.lines) {
      if (!l.orderLineId) continue;
      const ol = byLine.get(l.orderLineId);
      if (!ol) continue;
      const already = consumed.get(l.orderLineId) ?? 0n;
      const covered = ol.invoicedMilli > already ? ol.invoicedMilli - already : 0n;
      const billed = covered > l.quantityMilli ? l.quantityMilli : covered;
      consumed.set(l.orderLineId, already + billed);
      const uninvoiced = l.quantityMilli - billed;
      if (uninvoiced <= 0n) continue;
      rows.push({
        number: n.number,
        deliveredOn: iso(n.deliveredOn),
        customerName: n.customerName,
        orderNumber: ol.order.number,
        sku: l.sku,
        description: l.description,
        quantityMilli: l.quantityMilli,
        uninvoicedMilli: uninvoiced,
        costMinor: l.costMinor === null ? null : (l.costMinor * uninvoiced) / l.quantityMilli,
        valueMinor: lineNet(ol.unitPriceMinor, uninvoiced, ol.discountBps),
      });
    }
  }

  const valueMinor = rows.reduce((a, r) => a + r.valueMinor, 0n);
  const costMinor = rows.reduce((a, r) => a + (r.costMinor ?? 0n), 0n);

  return {
    asOf: iso(asOf),
    rows,
    totals: {
      lines: rows.length,
      valueMinor,
      costMinor,
      /** What the accounts are understating by, if every delivery is billable. */
      marginMinor: valueMinor - costMinor,
    },
    note:
      "Valued at the order price. It is a memorandum figure — no ledger account carries it, and it is deliberately " +
      "not posted as accrued income: whether a delivery satisfies a performance obligation is an IFRS 15 question, " +
      "and it is answered on the revenue recognition screen rather than assumed here.",
  };
}

export async function deliveryRegister(opts: {
  orgId: string; entityId: string; from?: Date | string; to?: Date | string; status?: NoteStatus;
}) {
  const to = opts.to ? asDate(opts.to, "The end date") : new Date();
  const from = opts.from ? asDate(opts.from, "The start date") : new Date(to.getTime() - 90 * 86_400_000);
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const notes = await prisma.deliveryNote.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      deliveredOn: { gte: from, lte: to },
      ...(opts.status ? { status: opts.status } : {}),
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
    orderBy: [{ deliveredOn: "desc" }, { number: "desc" }],
    take: 500,
  });

  const orderIds = [...new Set(notes.map((n) => n.orderId).filter(Boolean) as string[])];
  const orders = orderIds.length
    ? await prisma.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } })
    : [];
  const byOrder = new Map(orders.map((o) => [o.id, o.number]));

  return {
    from: iso(from), to: iso(to),
    notes: notes.map((n) => ({
      number: n.number,
      orderNumber: n.orderId ? byOrder.get(n.orderId) ?? null : null,
      customerName: n.customerName,
      deliveredOn: iso(n.deliveredOn),
      status: n.status,
      carrier: n.carrier,
      trackingRef: n.trackingRef,
      signedBy: n.signedBy,
      signedOn: n.signedOn ? iso(n.signedOn) : null,
      lineCount: n.lines.length,
      quantityMilli: n.lines.reduce((a, l) => a + l.quantityMilli, 0n),
      costMinor: n.lines.reduce((a, l) => a + (l.costMinor ?? 0n), 0n),
      lines: n.lines.map((l) => ({
        lineNo: l.lineNo, sku: l.sku, description: l.description,
        quantityMilli: l.quantityMilli, costMinor: l.costMinor,
      })),
    })),
    summary: {
      total: notes.length,
      draft: notes.filter((n) => n.status === "draft").length,
      dispatched: notes.filter((n) => n.status === "dispatched").length,
      delivered: notes.filter((n) => n.status === "delivered").length,
      /**
       * Dispatched and never signed for. Not a finding in itself — plenty of
       * deliveries are never signed — but it is the list somebody reaches for
       * the day a customer says the goods never arrived.
       */
      unsigned: notes.filter((n) => n.status === "dispatched").map((n) => n.number),
    },
  };
}

export { MILLI as QUANTITY_SCALE };
