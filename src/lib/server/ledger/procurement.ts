import { prisma } from "@/lib/server/prisma";
import { post, LedgerError, type PostLine } from "./post";
import { receive as receiveStock } from "./inventory";

/**
 * Purchase orders, goods receipts and the three-way match.
 *
 * A purchase order is a COMMITMENT, not an accounting entry. Raising one
 * changes nothing in the general ledger and this module posts nothing when it
 * is raised: no obligation has arisen, no asset has been acquired, and nothing
 * has been consumed. An order is a promise, and promises are not double-entry.
 * (What an order *is* good for is the commitment report a budget holder needs —
 * money spoken for but not yet spent — which is a different question from what
 * the ledger holds.)
 *
 * The entry that matters is the one almost nobody makes. Between the lorry
 * arriving and the supplier's invoice arriving, the business is holding stock
 * it has not been billed for. It owes for it. Skip that and the balance sheet
 * understates both stock and liabilities for however long the supplier takes —
 * which at a month end is exactly the wrong number in exactly the wrong place.
 * That accrual is Goods Received Not Invoiced, account 1250:
 *
 *   On receipt:   Dr  1200  Inventory (or the line's expense account)
 *                   Cr  1250  Goods received not invoiced
 *
 *   On invoice:   Dr  1250  GRNI            what the receipt put there
 *                 Dr  1350  VAT input       the tax we can reclaim
 *                   Cr  2000  Trade payables  gross, what we now owe
 *
 * 1250 therefore empties itself as invoices arrive, and whatever is left in it
 * is a list of deliveries nobody has been billed for yet. That list has to be
 * explainable order by order — see `grniReport`. A GRNI balance nobody can
 * explain is where stock losses hide: it is the one account where a delivery
 * that never happened and an invoice that never came look identical.
 *
 * The three-way match compares the three documents that should agree — the
 * order (what we asked for and at what price), the receipt (what actually
 * turned up) and the invoice (what we are being asked to pay for). Two of the
 * three agreeing proves nothing. The case worth the whole module is the third
 * one: an invoice for goods that never arrived. A two-way match against the
 * order alone passes it happily.
 *
 * Quantities are thousandths, money is minor units, and neither is ever a float.
 */

/* ------------------------------------------------------------------ accounts */

const GRNI = "1250";
const AP_CONTROL = "2000";
const VAT_INPUT = "1350";
const INVENTORY = "1200";

/**
 * Where an uncoded, non-stock order line lands. Same reasoning as ap.ts: a
 * purchase nobody has coded is not evidence about which cost centre it belongs
 * to, so it goes to other operating expenses rather than to a guess.
 */
const DEFAULT_EXPENSE = "6900";

/**
 * Where a difference between what the order committed to and what the invoice
 * asked for is booked.
 *
 * This chart has no dedicated purchase price variance account, and inventing
 * one here would put an account in the ledger that setup.ts has never heard of.
 * 5300 Inventory adjustments is already the account carrying "stock cost what
 * we did not expect it to cost", which is precisely what a purchase price
 * variance is. A caller with a better answer passes `varianceAccount`.
 */
const PURCHASE_VARIANCE = "5300";

const MILLI = 1000n;

/* ------------------------------------------------------------------- helpers */

export type OrderStatus = "draft" | "open" | "part_received" | "received" | "closed" | "cancelled";

function milli(v: number | bigint | string | undefined, what: string): bigint {
  if (v === undefined || v === null || v === "") return 0n;
  if (typeof v === "number" && !Number.isInteger(v)) {
    throw new LedgerError(`${what} must be in whole thousandths, got ${v}. Quantities are milli-units, never a decimal.`);
  }
  if (typeof v === "string" && !/^-?\d+$/.test(v.trim())) {
    throw new LedgerError(`${what} must be in whole thousandths, got "${v}".`);
  }
  return BigInt(typeof v === "string" ? v.trim() : v);
}

function minor(v: number | bigint | string | undefined, what: string): bigint {
  if (v === undefined || v === null || v === "") return 0n;
  if (typeof v === "number" && !Number.isInteger(v)) {
    throw new LedgerError(`${what} must be in whole minor units, got ${v}. Amounts are fils, never a decimal.`);
  }
  if (typeof v === "string" && !/^-?\d+$/.test(v.trim())) {
    throw new LedgerError(`${what} must be in whole minor units, got "${v}".`);
  }
  return BigInt(typeof v === "string" ? v.trim() : v);
}

const asDate = (d: Date | string) => (typeof d === "string" ? new Date(d) : d);

/** Thousandths as a human reads them: 1500 → "1.5". */
function qty(m: bigint): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const whole = abs / MILLI;
  const frac = (abs % MILLI).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

/** Minor units as a human reads them, for a message rather than a report. */
function money(m: bigint): string {
  const neg = m < 0n;
  const abs = (neg ? -m : m).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

/**
 * What a quantity is worth at a unit price.
 *
 * Rounded down, for the same reason inventory rounds its weighted average
 * down: a receipt must never be valued above what the order actually committed
 * to, and a drift upward compounds across every partial delivery.
 */
export function lineValue(unitPriceMinor: bigint, quantityMilli: bigint): bigint {
  return (unitPriceMinor * quantityMilli) / MILLI;
}

interface ReceiptSlice {
  quantityMilli: bigint;
  valueMinor: bigint;
}

/**
 * What the first `quantityMilli` of a line's deliveries actually cost, taking
 * the receipts in the order they arrived.
 *
 * Invoices consume receipts oldest-first, which matters because two deliveries
 * of the same line can be valued differently once an order is amended or a
 * partial receipt rounds. Doing it this way means that when the last unit is
 * invoiced the cleared value is *exactly* the value the receipts put into 1250 —
 * no pro-rata remainder stranded against zero quantity. That is the difference
 * between GRNI emptying to zero and GRNI emptying to seven fils nobody can
 * explain, forever.
 */
function receivedValueUpTo(slices: ReceiptSlice[], quantityMilli: bigint): bigint {
  let remaining = quantityMilli;
  let value = 0n;
  for (const s of slices) {
    if (remaining <= 0n) break;
    if (remaining >= s.quantityMilli) {
      value += s.valueMinor;
      remaining -= s.quantityMilli;
    } else {
      value += (s.valueMinor * remaining) / s.quantityMilli;
      remaining = 0n;
    }
  }
  return value;
}

type LoadedOrder = Awaited<ReturnType<typeof loadOrder>>;

async function loadOrder(orgId: string, orderId: string) {
  const order = await prisma.purchaseOrder.findFirst({
    where: { id: orderId, orgId },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      // Oldest first: `receivedValueUpTo` depends on the arrival order.
      receipts: { include: { lines: true }, orderBy: [{ receivedOn: "asc" }, { createdAt: "asc" }] },
    },
  });
  if (!order) throw new LedgerError("That purchase order does not exist.");
  return order;
}

/** Every delivery against one order line, oldest first. */
function slicesFor(order: LoadedOrder, orderLineId: string): ReceiptSlice[] {
  return order.receipts.flatMap((r) =>
    r.lines
      .filter((l) => l.orderLineId === orderLineId)
      .map((l) => ({ quantityMilli: l.quantityMilli, valueMinor: l.valueMinor })),
  );
}

/**
 * A purchase order in a currency the book does not keep needs a rate policy —
 * which rate values the receipt, which values the invoice, and where the
 * difference between them goes. This module does not have one, and guessing
 * would put a wrong number into 1250 rather than no number. Refuse and say so.
 */
async function bookFor(order: { orgId: string; entityId: string; number: string; currency: string }) {
  const book = await prisma.book.findFirst({
    where: { orgId: order.orgId, entityId: order.entityId, code: "PRIMARY" },
  });
  if (!book) {
    throw new LedgerError(`No ledger has been opened for this entity. Open the books before posting against ${order.number}.`);
  }
  if (order.currency !== book.functionalCurrency) {
    throw new LedgerError(
      `${order.number} is in ${order.currency} but this book is kept in ${book.functionalCurrency}. ` +
        `Raise the order in ${book.functionalCurrency}, or post the supplier's bill through the payables subledger, which carries an exchange rate.`,
    );
  }
  return book;
}

/* -------------------------------------------------------------- the order --- */

export interface NewOrderLine {
  description: string;
  /** Ties the line to the item list, so a receipt also moves stock. */
  sku?: string;
  quantityMilli: number | bigint | string;
  unitPriceMinor: number | bigint | string;
  /** Where the receipt is debited. Omit on a stock line — the item decides. */
  accountCode?: string;
}

export interface NewOrder {
  number: string;
  supplierName: string;
  supplierTrn?: string;
  orderedOn: Date | string;
  expectedOn?: Date | string;
  currency?: string;
  notes?: string;
  lines?: NewOrderLine[];
}

function prepareLine(orderNumber: string, lineNo: number, l: NewOrderLine) {
  const description = (l.description ?? "").trim();
  if (!description) throw new LedgerError(`Line ${lineNo} of ${orderNumber} needs a description. A line nobody can read is a line nobody can check a delivery against.`);

  const quantityMilli = milli(l.quantityMilli, `Line ${lineNo} quantity`);
  if (quantityMilli <= 0n) {
    throw new LedgerError(`Line ${lineNo} of ${orderNumber} orders ${qty(quantityMilli)}. Ordering nothing is not an order, and a negative order is a return.`);
  }

  const unitPriceMinor = minor(l.unitPriceMinor, `Line ${lineNo} unit price`);
  if (unitPriceMinor < 0n) {
    throw new LedgerError(`Line ${lineNo} of ${orderNumber} has a negative unit price. A credit is a supplier credit note, not a purchase order.`);
  }

  return {
    lineNo,
    description,
    sku: l.sku?.trim() || null,
    quantityMilli,
    unitPriceMinor,
    accountCode: l.accountCode?.trim() || null,
  };
}

/**
 * Raise a purchase order. Nothing is posted — see the header. The order starts
 * as a draft so that it can still be corrected; issuing it is the act that says
 * a supplier has been told.
 */
export async function createOrder(opts: { orgId: string; entityId: string; order: NewOrder }) {
  const o = opts.order;
  const number = (o.number ?? "").trim();
  const supplierName = (o.supplierName ?? "").trim();

  if (!number) throw new LedgerError("A purchase order needs a number — it is what the delivery note and the supplier's invoice will both quote.");
  if (!supplierName) throw new LedgerError(`${number} needs a supplier. An order with nobody to send it to commits to nothing.`);
  if (!o.orderedOn) throw new LedgerError(`${number} needs an order date.`);

  const clash = await prisma.purchaseOrder.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, number },
    select: { id: true, status: true },
  });
  if (clash) {
    throw new LedgerError(`Purchase order number ${number} is already in use by a ${clash.status.replace("_", " ")} order. Give this one its own number.`);
  }

  const lines = (o.lines ?? []).map((l, i) => prepareLine(number, i + 1, l));

  return prisma.purchaseOrder.create({
    data: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      number,
      supplierName,
      supplierTrn: o.supplierTrn?.trim() || null,
      orderedOn: asDate(o.orderedOn),
      expectedOn: o.expectedOn ? asDate(o.expectedOn) : null,
      currency: o.currency ?? "AED",
      status: "draft",
      notes: o.notes ?? null,
      lines: { create: lines.map((l) => ({ orgId: opts.orgId, ...l })) },
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
}

/**
 * Add a line to a draft order.
 *
 * Only to a draft. Once an order is issued the supplier is working to it, and
 * quietly growing it here would mean the document they hold and the document
 * we match against are different documents — which is the failure three-way
 * matching exists to detect, introduced by us. Amend by raising another order.
 */
export async function addLine(opts: { orgId: string; orderId: string; line: NewOrderLine }) {
  const order = await loadOrder(opts.orgId, opts.orderId);
  if (order.status !== "draft") {
    throw new LedgerError(
      `${order.number} is ${order.status.replace("_", " ")} and can no longer be added to. ` +
        `Raise a second order for the extra goods rather than editing one the supplier is already working to.`,
    );
  }
  const lineNo = order.lines.reduce((a, l) => Math.max(a, l.lineNo), 0) + 1;
  const line = prepareLine(order.number, lineNo, opts.line);
  return prisma.purchaseOrderLine.create({ data: { orgId: opts.orgId, orderId: order.id, ...line } });
}

/** Issue a draft order to the supplier: draft → open. Still not an entry. */
export async function issueOrder(opts: { orgId: string; orderId: string }) {
  const order = await loadOrder(opts.orgId, opts.orderId);
  if (order.status !== "draft") {
    throw new LedgerError(`${order.number} is already ${order.status.replace("_", " ")}. Only a draft order can be issued.`);
  }
  if (order.lines.length === 0) {
    throw new LedgerError(`${order.number} has no lines. An order with nothing on it commits to nothing, so there is nothing to issue.`);
  }
  return prisma.purchaseOrder.update({ where: { id: order.id }, data: { status: "open" } });
}

/**
 * Cancel an order nobody has delivered against.
 *
 * Once goods have arrived the commitment has been partly performed: 1250 holds
 * a real liability for them, and cancelling the order would leave that balance
 * pointing at a document that says nothing was ever ordered. Such an order is
 * closed short, not cancelled.
 */
export async function cancelOrder(opts: { orgId: string; orderId: string; reason?: string }) {
  const order = await loadOrder(opts.orgId, opts.orderId);
  if (order.status === "cancelled") return order;
  if (order.status !== "draft" && order.status !== "open") {
    throw new LedgerError(`${order.number} is ${order.status.replace("_", " ")} and cannot be cancelled.`);
  }
  const received = order.lines.reduce((a, l) => a + l.receivedMilli, 0n);
  if (received > 0n) {
    throw new LedgerError(
      `${order.number} already has ${qty(received)} delivered against it, so it cannot be cancelled — ` +
        `account ${GRNI} holds the accrual for goods that really did arrive. Close the order short instead, and match or credit what was delivered.`,
    );
  }
  return prisma.purchaseOrder.update({
    where: { id: order.id },
    data: {
      status: "cancelled",
      notes: opts.reason ? [order.notes, `Cancelled: ${opts.reason}`].filter(Boolean).join("\n") : order.notes,
    },
  });
}

/* ------------------------------------------------------------ the receipt --- */

export interface ReceiptLineInput {
  orderLineId: string;
  quantityMilli: number | bigint | string;
}

export interface ReceiveResult {
  receiptId: string;
  number: string;
  entryId: string | null;
  reference: string | null;
  /** A retry of the same receipt number returns the original rather than doubling it. */
  alreadyPosted: boolean;
  /** What this delivery put into 1250. */
  valueMinor: string;
  orderStatus: OrderStatus;
  lines: {
    orderLineId: string;
    lineNo: number;
    description: string;
    account: string;
    quantityMilli: string;
    valueMinor: string;
    receivedMilli: string;
    outstandingMilli: string;
    movedStock: boolean;
  }[];
}

/**
 * Record goods arriving, and accrue for them.
 *
 *   Dr  1200 Inventory, or the line's expense account   what the order priced it at
 *     Cr  1250 Goods received not invoiced
 *
 * Valued at the order's unit price, because that is the only price anyone has
 * agreed at this point — the invoice has not arrived, and valuing a receipt at
 * a price the supplier has not yet claimed would be inventing the number the
 * three-way match is supposed to test.
 */
export async function receiveGoods(opts: {
  orgId: string;
  orderId: string;
  receivedOn: Date | string;
  /** The delivery note number. Supply it and the receipt is idempotent on it. */
  number?: string;
  lines: ReceiptLineInput[];
  notes?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<ReceiveResult> {
  const order = await loadOrder(opts.orgId, opts.orderId);
  await bookFor(order);

  if (order.status === "draft") {
    throw new LedgerError(`${order.number} has not been issued yet. Issue it before recording a delivery against it — otherwise the goods arrived against an order the supplier never received.`);
  }
  if (order.status === "cancelled" || order.status === "closed") {
    throw new LedgerError(`${order.number} is ${order.status} and cannot take a delivery. Raise a new order for these goods.`);
  }
  if (order.status === "received") {
    throw new LedgerError(`Every line on ${order.number} has already been received in full, so there is nothing left to deliver against it.`);
  }
  if (!opts.lines?.length) {
    throw new LedgerError(`The goods receipt against ${order.number} has no lines on it. A delivery of nothing is not a delivery.`);
  }

  const number = (opts.number ?? "").trim() || `${order.number}-GRN${order.receipts.length + 1}`;

  // Idempotency, at the document level: the same delivery note keyed twice is
  // one delivery, not two. Doing it on the number rather than only on the
  // ledger's externalKey means the quantities on the order are not advanced
  // twice either.
  const existing = await prisma.goodsReceipt.findFirst({
    where: { orgId: opts.orgId, entityId: order.entityId, number },
    include: { lines: true },
  });
  if (existing) {
    const entry = existing.entryId
      ? await prisma.journalEntry.findUnique({ where: { id: existing.entryId }, select: { series: true, number: true } })
      : null;
    return {
      receiptId: existing.id,
      number: existing.number,
      entryId: existing.entryId,
      reference: entry ? `${entry.series}-${entry.number}` : null,
      alreadyPosted: true,
      valueMinor: existing.lines.reduce((a, l) => a + l.valueMinor, 0n).toString(),
      orderStatus: order.status as OrderStatus,
      lines: [],
    };
  }

  const byId = new Map(order.lines.map((l) => [l.id, l]));
  const seen = new Set<string>();

  const prepared = opts.lines.map((input) => {
    const line = byId.get(input.orderLineId);
    if (!line) {
      throw new LedgerError(`${order.number} has no line ${input.orderLineId}. Check the delivery note against the order.`);
    }
    if (seen.has(line.id)) {
      throw new LedgerError(`Line ${line.lineNo} of ${order.number} (${line.description}) appears twice on the same goods receipt. Put the whole delivered quantity on one line.`);
    }
    seen.add(line.id);

    const quantityMilli = milli(input.quantityMilli, `Line ${line.lineNo} delivered quantity`);
    if (quantityMilli <= 0n) {
      throw new LedgerError(`Line ${line.lineNo} of ${order.number} (${line.description}) records a delivery of ${qty(quantityMilli)}. A receipt has to be a positive quantity; a return is a separate document.`);
    }

    const outstanding = line.quantityMilli - line.receivedMilli;
    if (quantityMilli > outstanding) {
      // The single most useful refusal in the module: name the line, what was
      // ordered, what has already arrived, and what is therefore left. An
      // over-receipt is either a supplier shipping more than was agreed or a
      // delivery note keyed twice, and the reader can only tell which from
      // those three numbers.
      throw new LedgerError(
        `Line ${line.lineNo} of ${order.number} (${line.description}) was ordered ${qty(line.quantityMilli)} and ` +
          `${qty(line.receivedMilli)} has already arrived, so ${qty(quantityMilli)} cannot be received — only ${qty(outstanding)} is still outstanding. ` +
          `Check the delivery note against the order, and raise a new order if the supplier really has sent more.`,
      );
    }

    return { line, quantityMilli, valueMinor: lineValue(line.unitPriceMinor, quantityMilli) };
  });

  // Stock lines have to reach the item list, so the item has to exist and its
  // own stock account has to be the account we debit — see below.
  const skus = [...new Set(prepared.map((p) => p.line.sku).filter((s): s is string => Boolean(s)))];
  const items = skus.length
    ? await prisma.inventoryItem.findMany({ where: { orgId: opts.orgId, entityId: order.entityId, sku: { in: skus } } })
    : [];
  const itemBySku = new Map(items.map((i) => [i.sku, i]));

  const resolved = prepared.map((p) => {
    const { line } = p;
    if (!line.sku) return { ...p, account: line.accountCode ?? DEFAULT_EXPENSE, sku: null as string | null };

    const item = itemBySku.get(line.sku);
    if (!item) {
      throw new LedgerError(
        `Line ${line.lineNo} of ${order.number} is coded to SKU ${line.sku}, which is not on the item list. ` +
          `Add the item before receiving against it — otherwise the stock account moves and the stock record does not.`,
      );
    }
    // A stock line is debited to the item's own stock account and nowhere else.
    // The movement is recorded with `alreadyPosted`, so if the two disagreed
    // the quantity would land on one account and the value on another, and the
    // stock valuation would stop tying to the ledger with nothing to show why.
    if (line.accountCode && line.accountCode !== item.stockAccount) {
      throw new LedgerError(
        `Line ${line.lineNo} of ${order.number} is coded to account ${line.accountCode}, but SKU ${line.sku} is carried in ${item.stockAccount}. ` +
          `A stock line is debited to its item's stock account, or the stock valuation stops agreeing with the ledger. Take the account code off the line, or take the SKU off it.`,
      );
    }
    return { ...p, account: item.stockAccount, sku: line.sku };
  });

  const total = resolved.reduce((a, p) => a + p.valueMinor, 0n);
  if (total <= 0n) {
    throw new LedgerError(
      `The delivery against ${order.number} is worth nothing at the ordered prices, so there is no accrual to raise. ` +
        `Price the order lines before receiving against them.`,
    );
  }

  // One debit per account, so a fifty-line delivery is not fifty journal lines.
  const byAccount = new Map<string, bigint>();
  for (const p of resolved) byAccount.set(p.account, (byAccount.get(p.account) ?? 0n) + p.valueMinor);

  const postLines: PostLine[] = [...byAccount].map(([account, amount]) => ({
    account,
    debit: amount,
    memo: `Received on ${number}`,
  }));
  postLines.push({
    account: GRNI,
    credit: total,
    memo: `${order.supplierName} — ${order.number}, not yet invoiced`,
  });

  const entry = await post({
    orgId: opts.orgId,
    entityId: order.entityId,
    entryDate: opts.receivedOn,
    memo: `Goods received ${number} — ${order.supplierName} (${order.number})`,
    source: "procurement",
    sourceType: "GOODS_RECEIPT",
    sourceId: order.id,
    externalKey: `goods-receipt:${order.entityId}:${number}`,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "GR",
    lines: postLines,
  });

  const allReceived = order.lines.every((l) => {
    const p = resolved.find((r) => r.line.id === l.id);
    return l.receivedMilli + (p?.quantityMilli ?? 0n) >= l.quantityMilli;
  });
  const nextStatus: OrderStatus = allReceived ? "received" : "part_received";

  // The receipt, its lines, the quantities on the order and the order's status
  // move together. A receipt recorded without advancing the order would let the
  // same goods be received twice; advancing without the receipt would leave
  // 1250 holding a balance with no delivery behind it.
  const receipt = await prisma.$transaction(async (tx) => {
    const created = await tx.goodsReceipt.create({
      data: {
        orgId: opts.orgId,
        entityId: order.entityId,
        orderId: order.id,
        number,
        receivedOn: asDate(opts.receivedOn),
        entryId: entry.id,
        notes: opts.notes ?? null,
        lines: {
          create: resolved.map((p) => ({
            orgId: opts.orgId,
            orderLineId: p.line.id,
            quantityMilli: p.quantityMilli,
            valueMinor: p.valueMinor,
          })),
        },
      },
      include: { lines: true },
    });
    for (const p of resolved) {
      await tx.purchaseOrderLine.update({
        where: { id: p.line.id },
        data: { receivedMilli: { increment: p.quantityMilli } },
      });
    }
    await tx.purchaseOrder.update({ where: { id: order.id }, data: { status: nextStatus } });
    return created;
  });

  // Stock quantity, with `alreadyPosted` set: the journal above has already
  // debited the item's stock account, and inventory.receive() would otherwise
  // post a second debit to it. The flag exists for exactly this case — the
  // value reached 1200 by another route, and only the quantity and the running
  // average still need recording.
  for (const p of resolved) {
    if (!p.sku) continue;
    await receiveStock({
      orgId: opts.orgId,
      entityId: order.entityId,
      sku: p.sku,
      movedOn: asDate(opts.receivedOn).toISOString().slice(0, 10),
      quantityMilli: p.quantityMilli,
      valueMinor: p.valueMinor,
      reference: number,
      memo: `Received on ${number} against ${order.number}`,
      alreadyPosted: true,
      actorId: opts.actorId,
    });
  }

  return {
    receiptId: receipt.id,
    number,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPosted: false,
    valueMinor: total.toString(),
    orderStatus: nextStatus,
    lines: resolved.map((p) => ({
      orderLineId: p.line.id,
      lineNo: p.line.lineNo,
      description: p.line.description,
      account: p.account,
      quantityMilli: p.quantityMilli.toString(),
      valueMinor: p.valueMinor.toString(),
      receivedMilli: (p.line.receivedMilli + p.quantityMilli).toString(),
      outstandingMilli: (p.line.quantityMilli - p.line.receivedMilli - p.quantityMilli).toString(),
      movedStock: p.sku !== null,
    })),
  };
}

/* --------------------------------------------------------- the three-way --- */

export interface MatchLineInput {
  orderLineId: string;
  /** What the invoice is billing for, in thousandths. */
  quantityMilli: number | bigint | string;
  /** What the invoice is charging per whole unit, in minor units. */
  unitPriceMinor: number | bigint | string;
}

/**
 * How much disagreement is allowed to pass without a human looking at it.
 *
 * Every field defaults to zero, deliberately. A tolerance nobody chose is a
 * control nobody set: if this module shipped with "a few fils is fine" built
 * in, that judgement would have been made by whoever wrote the file rather than
 * by the business carrying the loss.
 */
export interface MatchTolerance {
  /** Per line, in thousandths. */
  quantityMilli?: number | bigint | string;
  /** Per line, in minor units per whole unit. */
  unitPriceMinor?: number | bigint | string;
  /** On the invoice as a whole, in minor units. */
  totalMinor?: number | bigint | string;
}

export type MatchFinding =
  | "quantity_variance"
  | "price_variance"
  | "not_received"
  | "over_invoiced"
  | "header_variance";

export interface MatchLineResult {
  orderLineId: string;
  lineNo: number;
  description: string;
  sku: string | null;
  /** The three documents, side by side. */
  orderedMilli: string;
  receivedMilli: string;
  previouslyInvoicedMilli: string;
  invoicedMilli: string;
  /** Quantity received and not yet billed — what this invoice ought to cover. */
  availableMilli: string;
  orderUnitPriceMinor: string;
  invoiceUnitPriceMinor: string;
  /** The invoiced quantity, at the order's price and at the invoice's price. */
  orderValueMinor: string;
  invoiceValueMinor: string;
  /** What receipt actually put into 1250 for this quantity. */
  grniValueMinor: string;
  quantityVarianceMilli: string;
  priceVarianceMinor: string;
  /** What the invoice asks for, less what the receipts accrued. */
  varianceMinor: string;
  findings: MatchFinding[];
  matched: boolean;
  withinTolerance: boolean;
  /** Why, in a sentence a buyer can act on. */
  reason: string;
}

export interface MatchResult {
  orderId: string;
  orderNumber: string;
  supplierName: string;
  lines: MatchLineResult[];
  invoiceTotalMinor: string;
  vatMinor: string;
  /** The invoice's own net, from its lines. */
  invoiceNetMinor: string;
  /** The same quantities at the order's prices. */
  expectedNetMinor: string;
  /** What would come out of 1250 if this invoice were posted. */
  grniValueMinor: string;
  varianceMinor: string;
  /** Invoice total against its own lines plus its own VAT — the arithmetic check. */
  headerVarianceMinor: string;
  findings: MatchFinding[];
  matched: boolean;
  withinTolerance: boolean;
  summary: string;
}

/**
 * The three-way match: order against receipt against invoice.
 *
 * Two of the three agreeing proves nothing, which is why the interesting
 * finding here is `not_received` — an invoice billing for goods that never
 * turned up. A two-way match against the order passes that happily, because the
 * supplier is billing for exactly what was ordered; only the receipt knows the
 * lorry never came.
 *
 * Nothing is posted here. This function's whole job is to produce the report a
 * human reads before deciding, and it is safe to call as often as anyone likes.
 */
export async function matchInvoice(opts: {
  orgId: string;
  orderId: string;
  /** The bill this invoice is, if it has already been captured in payables. */
  billId?: string;
  invoiceNumber?: string;
  lines: MatchLineInput[];
  invoiceTotalMinor: number | bigint | string;
  vatMinor?: number | bigint | string;
  tolerance?: MatchTolerance;
}): Promise<MatchResult> {
  const order = await loadOrder(opts.orgId, opts.orderId);
  if (!opts.lines?.length) {
    throw new LedgerError(`The invoice matched against ${order.number} has no lines on it. There is nothing to compare.`);
  }

  const tolQty = milli(opts.tolerance?.quantityMilli, "Quantity tolerance");
  const tolPrice = minor(opts.tolerance?.unitPriceMinor, "Price tolerance");
  const tolTotal = minor(opts.tolerance?.totalMinor, "Total tolerance");

  const invoiceTotal = minor(opts.invoiceTotalMinor, "Invoice total");
  const vat = minor(opts.vatMinor, "Invoice VAT");

  const byId = new Map(order.lines.map((l) => [l.id, l]));
  const seen = new Set<string>();

  const rows: MatchLineResult[] = opts.lines.map((input) => {
    const line = byId.get(input.orderLineId);
    if (!line) {
      throw new LedgerError(`${order.number} has no line ${input.orderLineId}. An invoice line that matches nothing on the order cannot be three-way matched at all — check the order number on the invoice.`);
    }
    if (seen.has(line.id)) {
      throw new LedgerError(`Line ${line.lineNo} of ${order.number} (${line.description}) appears twice on the same invoice. Put the whole invoiced quantity on one line.`);
    }
    seen.add(line.id);

    const invoicedMilli = milli(input.quantityMilli, `Line ${line.lineNo} invoiced quantity`);
    if (invoicedMilli <= 0n) {
      throw new LedgerError(`Line ${line.lineNo} of ${order.number} is invoiced for ${qty(invoicedMilli)}. A supplier billing for nothing, or for a negative, is a credit note rather than an invoice.`);
    }
    const invoicePrice = minor(input.unitPriceMinor, `Line ${line.lineNo} invoiced unit price`);
    if (invoicePrice < 0n) {
      throw new LedgerError(`Line ${line.lineNo} of ${order.number} is invoiced at a negative unit price. That is a credit note, not an invoice.`);
    }

    const available = line.receivedMilli - line.invoicedMilli;
    const quantityVariance = invoicedMilli - available;
    const priceDiff = invoicePrice - line.unitPriceMinor;
    const priceVariance = lineValue(priceDiff, invoicedMilli);

    const slices = slicesFor(order, line.id);
    // What is actually still sitting in 1250 for this line, and how much of it
    // this invoice would take out.
    const clearedAlready = receivedValueUpTo(slices, line.invoicedMilli);
    const consumable = invoicedMilli < available ? invoicedMilli : available > 0n ? available : 0n;
    const grniValue = receivedValueUpTo(slices, line.invoicedMilli + consumable) - clearedAlready;

    const orderValue = lineValue(line.unitPriceMinor, invoicedMilli);
    const invoiceValue = lineValue(invoicePrice, invoicedMilli);

    const findings: MatchFinding[] = [];
    let withinTolerance = true;

    if (line.receivedMilli === 0n) {
      findings.push("not_received");
      // Never tolerated. A line billed for goods that never arrived is not a
      // rounding difference, and a tolerance set for rounding must not be the
      // thing that waves it through.
      withinTolerance = false;
    } else if (quantityVariance !== 0n) {
      findings.push("quantity_variance");
      if (quantityVariance > tolQty || -quantityVariance > tolQty) withinTolerance = false;
    }

    if (line.invoicedMilli + invoicedMilli > line.quantityMilli) {
      findings.push("over_invoiced");
      withinTolerance = false;
    }

    if (priceDiff !== 0n) {
      findings.push("price_variance");
      if (priceDiff > tolPrice || -priceDiff > tolPrice) withinTolerance = false;
    }

    return {
      orderLineId: line.id,
      lineNo: line.lineNo,
      description: line.description,
      sku: line.sku,
      orderedMilli: line.quantityMilli.toString(),
      receivedMilli: line.receivedMilli.toString(),
      previouslyInvoicedMilli: line.invoicedMilli.toString(),
      invoicedMilli: invoicedMilli.toString(),
      availableMilli: available.toString(),
      orderUnitPriceMinor: line.unitPriceMinor.toString(),
      invoiceUnitPriceMinor: invoicePrice.toString(),
      orderValueMinor: orderValue.toString(),
      invoiceValueMinor: invoiceValue.toString(),
      grniValueMinor: grniValue.toString(),
      quantityVarianceMilli: quantityVariance.toString(),
      priceVarianceMinor: priceVariance.toString(),
      varianceMinor: (invoiceValue - grniValue).toString(),
      findings,
      matched: findings.length === 0,
      withinTolerance,
      reason: reasonFor({
        orderNumber: order.number,
        lineNo: line.lineNo,
        description: line.description,
        findings,
        orderedMilli: line.quantityMilli,
        receivedMilli: line.receivedMilli,
        previouslyInvoicedMilli: line.invoicedMilli,
        invoicedMilli,
        availableMilli: available,
        orderPrice: line.unitPriceMinor,
        invoicePrice,
        priceVariance,
      }),
    };
  });

  const invoiceNet = rows.reduce((a, r) => a + BigInt(r.invoiceValueMinor), 0n);
  const expectedNet = rows.reduce((a, r) => a + BigInt(r.orderValueMinor), 0n);
  const grniValue = rows.reduce((a, r) => a + BigInt(r.grniValueMinor), 0n);
  const headerVariance = invoiceTotal - (invoiceNet + vat);
  const variance = invoiceTotal - vat - grniValue;

  const findings = [...new Set(rows.flatMap((r) => r.findings))];
  if (headerVariance !== 0n) findings.push("header_variance");

  // Matched means all three documents say the same thing and nothing at all
  // would need to be booked to a variance account. `variance` is checked as
  // well as the findings because truncation across several partial deliveries
  // can leave a fil that no single line is responsible for.
  const matched = findings.length === 0 && variance === 0n;
  // Within tolerance is a judgement about each disagreement, line by line,
  // against a limit the caller chose. The header check is separate: an invoice
  // whose own total disagrees with its own lines is an arithmetic error, not a
  // procurement one.
  const withinTolerance =
    rows.every((r) => r.withinTolerance) && !(headerVariance > tolTotal || -headerVariance > tolTotal);

  return {
    orderId: order.id,
    orderNumber: order.number,
    supplierName: order.supplierName,
    lines: rows,
    invoiceTotalMinor: invoiceTotal.toString(),
    vatMinor: vat.toString(),
    invoiceNetMinor: invoiceNet.toString(),
    expectedNetMinor: expectedNet.toString(),
    grniValueMinor: grniValue.toString(),
    varianceMinor: variance.toString(),
    headerVarianceMinor: headerVariance.toString(),
    findings,
    matched,
    withinTolerance,
    summary: summaryFor({
      orderNumber: order.number,
      supplierName: order.supplierName,
      invoiceNumber: opts.invoiceNumber,
      rows,
      matched,
      withinTolerance,
      variance,
      headerVariance,
    }),
  };
}

/** A finding said as a sentence, with the three numbers that produced it. */
function reasonFor(a: {
  orderNumber: string;
  lineNo: number;
  description: string;
  findings: MatchFinding[];
  orderedMilli: bigint;
  receivedMilli: bigint;
  previouslyInvoicedMilli: bigint;
  invoicedMilli: bigint;
  availableMilli: bigint;
  orderPrice: bigint;
  invoicePrice: bigint;
  priceVariance: bigint;
}): string {
  const where = `Line ${a.lineNo} (${a.description})`;
  if (a.findings.length === 0) {
    return `${where} agrees: ${qty(a.orderedMilli)} ordered, ${qty(a.receivedMilli)} received, ${qty(a.invoicedMilli)} invoiced at the ordered price of ${money(a.orderPrice)}.`;
  }

  const parts: string[] = [];
  if (a.findings.includes("not_received")) {
    parts.push(
      `${where} is invoiced for ${qty(a.invoicedMilli)} but nothing has ever been received against it — ` +
        `${qty(a.orderedMilli)} was ordered and no delivery has been recorded. ` +
        `Do not pay this line until the goods are found or the supplier withdraws it.`,
    );
  } else if (a.findings.includes("quantity_variance")) {
    const diff = a.invoicedMilli - a.availableMilli;
    parts.push(
      diff > 0n
        ? `${where} is invoiced for ${qty(a.invoicedMilli)} but only ${qty(a.availableMilli)} has been received and not yet billed ` +
          `(${qty(a.receivedMilli)} received, ${qty(a.previouslyInvoicedMilli)} already invoiced), so ${qty(diff)} is being billed for goods that have not arrived.`
        : `${where} is invoiced for ${qty(a.invoicedMilli)} against ${qty(a.availableMilli)} received and not yet billed, ` +
          `so ${qty(-diff)} of what has arrived is still unbilled — expect a further invoice.`,
    );
  }

  if (a.findings.includes("over_invoiced")) {
    parts.push(
      `Together with ${qty(a.previouslyInvoicedMilli)} already invoiced this would bill ` +
        `more than the ${qty(a.orderedMilli)} ordered.`,
    );
  }

  if (a.findings.includes("price_variance")) {
    const diff = a.invoicePrice - a.orderPrice;
    parts.push(
      `The order priced it at ${money(a.orderPrice)} a unit and the invoice charges ${money(a.invoicePrice)}, ` +
        `${diff > 0n ? "an increase" : "a reduction"} of ${money(diff > 0n ? diff : -diff)} a unit and ` +
        `${money(a.priceVariance > 0n ? a.priceVariance : -a.priceVariance)} ${a.priceVariance > 0n ? "more" : "less"} on this line.`,
    );
  }

  return parts.join(" ");
}

function summaryFor(a: {
  orderNumber: string;
  supplierName: string;
  invoiceNumber?: string;
  rows: MatchLineResult[];
  matched: boolean;
  withinTolerance: boolean;
  variance: bigint;
  headerVariance: bigint;
}): string {
  const doc = a.invoiceNumber ? `Invoice ${a.invoiceNumber}` : "The invoice";
  if (a.matched) {
    return `${doc} agrees with ${a.orderNumber} and with what was received: ${a.rows.length} line${a.rows.length === 1 ? "" : "s"}, no variance.`;
  }
  const failed = a.rows.filter((r) => !r.matched);
  const heads = failed.map((r) => `line ${r.lineNo}`).join(", ");
  const head =
    `${doc} from ${a.supplierName} does not match ${a.orderNumber} on ${heads}. ` +
    `It asks for ${money(a.variance > 0n ? a.variance : -a.variance)} ${a.variance > 0n ? "more" : "less"} than the receipts accrued.`;
  const header =
    a.headerVariance !== 0n
      ? ` Its own total is also out by ${money(a.headerVariance > 0n ? a.headerVariance : -a.headerVariance)} against its lines plus its VAT.`
      : "";
  const verdict = a.withinTolerance ? " Every difference is inside the tolerance supplied." : "";
  return head + header + verdict;
}

/* ------------------------------------------------- posting a matched bill --- */

export interface PostMatchedResult {
  entryId: string;
  reference: string;
  alreadyPosted: boolean;
  match: MatchResult;
  /** What came out of 1250. */
  grniClearedMinor: string;
  /** What did not, and went to the variance account instead. */
  varianceMinor: string;
  overrideReason: string | null;
  orderStatus: OrderStatus;
}

/**
 * Post a supplier invoice against the order it belongs to.
 *
 *   Dr  1250  GRNI            what the receipts accrued for these quantities
 *   Dr  1350  VAT input       the reclaimable tax
 *   Dr  5300  Variance        anything the invoice asks for beyond the receipts
 *     Cr  2000  Trade payables  the gross invoice
 *
 * A failing match is refused. It can be forced, because sometimes the buyer
 * genuinely knows the freight was agreed by telephone — but only with a reason,
 * and the reason goes on the entry memo where the auditor will find it. An
 * override with no reason is not an override, it is a bypass, and a bypass that
 * leaves no trace is indistinguishable from the fraud this control exists to
 * catch.
 */
export async function postMatchedInvoice(opts: {
  orgId: string;
  orderId: string;
  invoiceNumber: string;
  invoicedOn: Date | string;
  billId?: string;
  lines: MatchLineInput[];
  invoiceTotalMinor: number | bigint | string;
  vatMinor?: number | bigint | string;
  tolerance?: MatchTolerance;
  /** Required to post a match that failed. Recorded on the entry memo. */
  overrideReason?: string;
  varianceAccount?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<PostMatchedResult> {
  const order = await loadOrder(opts.orgId, opts.orderId);
  await bookFor(order);

  const invoiceNumber = (opts.invoiceNumber ?? "").trim();
  if (!invoiceNumber) {
    throw new LedgerError(`The invoice matched against ${order.number} needs its own number. It is what the payment and the supplier statement will both quote.`);
  }

  const externalKey = `po-invoice:${order.entityId}:${opts.billId ?? `${order.number}:${invoiceNumber}`}`;
  const existing = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey },
    select: { id: true, series: true, number: true },
  });

  const match = await matchInvoice({
    orgId: opts.orgId,
    orderId: opts.orderId,
    billId: opts.billId,
    invoiceNumber,
    lines: opts.lines,
    invoiceTotalMinor: opts.invoiceTotalMinor,
    vatMinor: opts.vatMinor,
    tolerance: opts.tolerance,
  });

  if (existing) {
    return {
      entryId: existing.id,
      reference: `${existing.series}-${existing.number}`,
      alreadyPosted: true,
      match,
      grniClearedMinor: "0",
      varianceMinor: "0",
      overrideReason: null,
      orderStatus: order.status as OrderStatus,
    };
  }

  // Over-invoicing is the one finding no override can carry. The order line
  // physically cannot record more invoiced than was ordered — the database
  // refuses it — so posting the entry would clear 1250 against quantities the
  // order would never show, and the GRNI report would stop reconciling. Amend
  // the order, or take the excess off the invoice.
  const over = match.lines.filter((r) => r.findings.includes("over_invoiced"));
  if (over.length) {
    throw new LedgerError(
      `Invoice ${invoiceNumber} bills more than ${order.number} ordered on ` +
        `${over.map((r) => `line ${r.lineNo} (${r.description})`).join(", ")}. ` +
        `An order cannot record more invoiced than it ordered, so this cannot be overridden: ` +
        `raise a second order for the extra, or ask the supplier to correct the invoice.`,
    );
  }

  const reason = opts.overrideReason?.trim() || "";
  if (!match.withinTolerance && !reason) {
    // The refusal carries the reason for every line that failed, not just the
    // headline. A message that says only "does not match" sends the buyer back
    // to the documents to work out which of three quite different problems
    // they have — a price nobody agreed, a quantity that has not arrived, or a
    // line that was never delivered at all.
    const why = match.lines.filter((r) => !r.withinTolerance).map((r) => r.reason).join(" ");
    throw new LedgerError(
      `${match.summary} ${why} Posting it would accept that without anyone recording that they accepted it. ` +
        `Correct the invoice, record the missing receipt, or supply an override reason — an override with no reason is not an override, it is a bypass.`,
    );
  }

  const grniCleared = BigInt(match.grniValueMinor);
  const vat = BigInt(match.vatMinor);
  const gross = BigInt(match.invoiceTotalMinor);
  if (gross <= 0n) {
    throw new LedgerError(`Invoice ${invoiceNumber} has a total of ${money(gross)}. A supplier invoice for nothing is not a document this ledger can post; a negative one is a credit note.`);
  }

  // Whatever the invoice asks for beyond what the receipts accrued. On a clean
  // match this is zero and no variance line is written at all.
  const variance = gross - vat - grniCleared;

  const postLines: PostLine[] = [];
  if (grniCleared !== 0n) {
    postLines.push({
      account: GRNI,
      ...(grniCleared > 0n ? { debit: grniCleared } : { credit: -grniCleared }),
      memo: `Cleared by ${invoiceNumber} — ${order.number}`,
    });
  }
  if (vat !== 0n) {
    postLines.push({
      account: VAT_INPUT,
      ...(vat > 0n ? { debit: vat } : { credit: -vat }),
      memo: "Recoverable input VAT",
      taxCode: "INPUT_VAT",
    });
  }
  if (variance !== 0n) {
    postLines.push({
      account: opts.varianceAccount ?? PURCHASE_VARIANCE,
      ...(variance > 0n ? { debit: variance } : { credit: -variance }),
      memo: `Variance against ${order.number} — ${match.findings.join(", ") || "unexplained"}`,
    });
  }
  postLines.push({
    account: AP_CONTROL,
    credit: gross,
    memo: `${order.supplierName} — ${invoiceNumber}`,
  });

  const entry = await post({
    orgId: opts.orgId,
    entityId: order.entityId,
    entryDate: opts.invoicedOn,
    memo:
      `Invoice ${invoiceNumber} matched to ${order.number} — ${order.supplierName}` +
      (reason ? ` — match override: ${reason}` : ""),
    source: "procurement",
    sourceType: "MATCHED_INVOICE",
    sourceId: order.id,
    settlesId: opts.billId,
    externalKey,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "PI",
    lines: postLines,
  });

  // Advance the invoiced quantities together with the entry that relies on
  // them, so a half-applied match cannot leave 1250 cleared against quantities
  // the order still thinks are outstanding.
  await prisma.$transaction(async (tx) => {
    for (const row of match.lines) {
      await tx.purchaseOrderLine.update({
        where: { id: row.orderLineId },
        data: { invoicedMilli: { increment: BigInt(row.invoicedMilli) } },
      });
    }
  });

  return {
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPosted: false,
    match,
    grniClearedMinor: grniCleared.toString(),
    varianceMinor: variance.toString(),
    overrideReason: reason || null,
    orderStatus: order.status as OrderStatus,
  };
}

/* ------------------------------------------------------------- the report --- */

export interface GrniOrderLine {
  orderLineId: string;
  lineNo: number;
  description: string;
  sku: string | null;
  orderedMilli: string;
  receivedMilli: string;
  invoicedMilli: string;
  receivedValueMinor: string;
  invoicedValueMinor: string;
  outstandingMinor: string;
}

export interface GrniOrder {
  orderId: string;
  number: string;
  supplierName: string;
  status: OrderStatus;
  /** The oldest delivery still sitting unbilled — the number that ages. */
  oldestReceiptOn: string | null;
  daysOld: number | null;
  receivedValueMinor: string;
  invoicedValueMinor: string;
  outstandingMinor: string;
  lines: GrniOrderLine[];
}

/**
 * What is in 1250, and why — order by order, reconciled to the ledger.
 *
 * The same discipline as the stock valuation and the fixed-asset register: two
 * records built by different routes, compared. Here the subledger side is built
 * from the delivery documents and the quantities invoiced against them, and the
 * ledger side is account 1250's own balance. They agree, or the difference is
 * shown — a manual journal into 1250, a receipt posted without a document
 * behind it, an entry reversed on one side only.
 *
 * A GRNI balance nobody can explain is where stock losses hide, because an
 * unbilled delivery and a delivery that never happened leave the same trace.
 * The ageing on each order is what turns the balance into a question: a receipt
 * six months old with no invoice behind it is either a supplier who has
 * forgotten to bill, or goods that were never really received.
 */
export async function grniReport(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date | string;
}) {
  const asOf = opts.asOf ? asDate(opts.asOf) : new Date();

  const orders = await prisma.purchaseOrder.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      receipts: {
        where: { receivedOn: { lte: asOf } },
        include: { lines: true },
        orderBy: [{ receivedOn: "asc" }, { createdAt: "asc" }],
      },
    },
    orderBy: { number: "asc" },
  });

  const rows: GrniOrder[] = [];
  let total = 0n;

  for (const order of orders) {
    const lines: GrniOrderLine[] = [];
    let received = 0n;
    let invoiced = 0n;
    let oldest: Date | null = null;

    for (const line of order.lines) {
      const slices = order.receipts.flatMap((r) =>
        r.lines
          .filter((l) => l.orderLineId === line.id)
          .map((l) => ({ quantityMilli: l.quantityMilli, valueMinor: l.valueMinor, receivedOn: r.receivedOn })),
      );
      if (slices.length === 0 && line.invoicedMilli === 0n) continue;

      const receivedMilli = slices.reduce((a, s) => a + s.quantityMilli, 0n);
      const receivedValue = slices.reduce((a, s) => a + s.valueMinor, 0n);

      // A purchase order line carries how much has been invoiced but not when,
      // so an as-of date can only filter the delivery side. Capping the
      // invoiced quantity at what had arrived by that date keeps the figure
      // from going negative on a back-dated report; a report run before the
      // latest match will still understate the balance, and the `agrees` flag
      // is what says so rather than hiding it.
      const invoicedMilli = line.invoicedMilli < receivedMilli ? line.invoicedMilli : receivedMilli;
      const invoicedValue = receivedValueUpTo(slices, invoicedMilli);
      const outstanding = receivedValue - invoicedValue;

      if (outstanding !== 0n && slices.length) {
        const first = slices[0];
        if (oldest === null || first.receivedOn < oldest) oldest = first.receivedOn;
      }

      received += receivedValue;
      invoiced += invoicedValue;
      lines.push({
        orderLineId: line.id,
        lineNo: line.lineNo,
        description: line.description,
        sku: line.sku,
        orderedMilli: line.quantityMilli.toString(),
        receivedMilli: receivedMilli.toString(),
        invoicedMilli: invoicedMilli.toString(),
        receivedValueMinor: receivedValue.toString(),
        invoicedValueMinor: invoicedValue.toString(),
        outstandingMinor: outstanding.toString(),
      });
    }

    const outstanding = received - invoiced;
    if (lines.length === 0) continue;
    total += outstanding;
    rows.push({
      orderId: order.id,
      number: order.number,
      supplierName: order.supplierName,
      status: order.status as OrderStatus,
      oldestReceiptOn: oldest ? oldest.toISOString().slice(0, 10) : null,
      daysOld: oldest ? Math.floor((asOf.getTime() - oldest.getTime()) / 86_400_000) : null,
      receivedValueMinor: received.toString(),
      invoicedValueMinor: invoiced.toString(),
      outstandingMinor: outstanding.toString(),
      lines,
    });
  }

  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: GRNI },
    select: { id: true },
  });
  const ledgerLines = account
    ? await prisma.journalLine.findMany({
        where: {
          orgId: opts.orgId,
          accountId: account.id,
          // A reversed entry's own lines are still real postings — the
          // reversal is a second entry beside it, not a deletion. Counting
          // only "posted" would drop the original and leave the report short
          // by exactly the amount that was reversed.
          entry: { status: { in: ["posted", "reversed"] }, entryDate: { lte: asOf } },
        },
        select: { functionalAmountMinor: true },
      })
    : [];
  const ledgerBalance = ledgerLines.reduce((a, l) => a + l.functionalAmountMinor, 0n);

  // 1250 is an asset: a receipt credits it, an invoice debits it back out, so
  // the balance sits on the credit side and the ledger holds it negative. What
  // is owed is reported as a positive figure, the way the ageing reports do.
  const ledgerOutstanding = -ledgerBalance;

  return {
    asOf: asOf.toISOString().slice(0, 10),
    orders: rows.filter((r) => BigInt(r.outstandingMinor) !== 0n),
    /** Every order that has ever had a receipt, including the settled ones. */
    allOrders: rows,
    totals: { outstandingMinor: total.toString() },
    ledger: {
      account: GRNI,
      outstandingMinor: ledgerOutstanding.toString(),
      differenceMinor: (ledgerOutstanding - total).toString(),
      agrees: ledgerOutstanding === total,
    },
  };
}

/* ---------------------------------------------------------------- reading --- */

/** The order list, with what each one still owes the ledger. */
export async function orderList(opts: { orgId: string; entityId: string; status?: OrderStatus }) {
  const orders = await prisma.purchaseOrder.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, ...(opts.status ? { status: opts.status } : {}) },
    include: { lines: { orderBy: { lineNo: "asc" } }, receipts: { select: { id: true } } },
    orderBy: [{ orderedOn: "desc" }, { number: "desc" }],
  });

  return {
    orders: orders.map((o) => {
      const ordered = o.lines.reduce((a, l) => a + lineValue(l.unitPriceMinor, l.quantityMilli), 0n);
      const received = o.lines.reduce((a, l) => a + lineValue(l.unitPriceMinor, l.receivedMilli), 0n);
      const invoiced = o.lines.reduce((a, l) => a + lineValue(l.unitPriceMinor, l.invoicedMilli), 0n);
      return {
        id: o.id,
        number: o.number,
        supplierName: o.supplierName,
        orderedOn: o.orderedOn.toISOString().slice(0, 10),
        expectedOn: o.expectedOn ? o.expectedOn.toISOString().slice(0, 10) : null,
        currency: o.currency,
        status: o.status as OrderStatus,
        lineCount: o.lines.length,
        receiptCount: o.receipts.length,
        orderedMinor: ordered.toString(),
        receivedMinor: received.toString(),
        invoicedMinor: invoiced.toString(),
      };
    }),
  };
}

/** One order in full — its lines, its deliveries and what each still owes. */
export async function orderDetail(opts: { orgId: string; orderId: string }) {
  const order = await loadOrder(opts.orgId, opts.orderId);
  return {
    id: order.id,
    number: order.number,
    supplierName: order.supplierName,
    supplierTrn: order.supplierTrn,
    orderedOn: order.orderedOn.toISOString().slice(0, 10),
    expectedOn: order.expectedOn ? order.expectedOn.toISOString().slice(0, 10) : null,
    currency: order.currency,
    status: order.status as OrderStatus,
    notes: order.notes,
    lines: order.lines.map((l) => {
      const slices = slicesFor(order, l.id);
      const receivedValue = slices.reduce((a, s) => a + s.valueMinor, 0n);
      const invoicedValue = receivedValueUpTo(slices, l.invoicedMilli);
      return {
        id: l.id,
        lineNo: l.lineNo,
        description: l.description,
        sku: l.sku,
        accountCode: l.accountCode,
        quantityMilli: l.quantityMilli.toString(),
        unitPriceMinor: l.unitPriceMinor.toString(),
        lineValueMinor: lineValue(l.unitPriceMinor, l.quantityMilli).toString(),
        receivedMilli: l.receivedMilli.toString(),
        invoicedMilli: l.invoicedMilli.toString(),
        outstandingMilli: (l.quantityMilli - l.receivedMilli).toString(),
        grniMinor: (receivedValue - invoicedValue).toString(),
      };
    }),
    receipts: order.receipts.map((r) => ({
      id: r.id,
      number: r.number,
      receivedOn: r.receivedOn.toISOString().slice(0, 10),
      entryId: r.entryId,
      notes: r.notes,
      valueMinor: r.lines.reduce((a, l) => a + l.valueMinor, 0n).toString(),
      lines: r.lines.map((l) => ({
        orderLineId: l.orderLineId,
        quantityMilli: l.quantityMilli.toString(),
        valueMinor: l.valueMinor.toString(),
      })),
    })),
  };
}

export { GRNI as GRNI_ACCOUNT, INVENTORY as INVENTORY_ACCOUNT, PURCHASE_VARIANCE as PURCHASE_VARIANCE_ACCOUNT };
