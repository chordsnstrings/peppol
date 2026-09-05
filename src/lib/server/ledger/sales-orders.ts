import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { TAX_PROFILES, getProfile } from "@/lib/domain/tax";
import type { TaxProfileCode } from "@/lib/domain/types";

/**
 * Quotations and sales orders — what has been offered, and what has been agreed.
 *
 * Nothing in this module posts. A quote is an offer and an order is a promise,
 * and neither is a transaction: no revenue has been earned, no receivable has
 * arisen and no tax has become due. Recognising any of it here would put
 * revenue on the books before the performance that earns it, which is the
 * single most common way a set of books stops being true. The entry comes later
 * and from somewhere else — the invoice, through the receivables subledger,
 * where the customer really does owe the money and the FTA really is owed the
 * tax.
 *
 * What this module does hold is the running invoiced quantity per line. That is
 * the one fact the ledger cannot answer: with it, an order can say what is
 * still to be delivered without anyone scanning every invoice raised against
 * it, and it can refuse to be billed twice for the same goods. `invoiceOrder`
 * therefore records quantity and nothing else — the money side of that same act
 * belongs to ar.ts.
 *
 * The life of a document:
 *
 *   draft ─send→ sent ─accept→ accepted ─invoice→ part_invoiced ─→ invoiced
 *                  │              │
 *                  ├─decline→ declined
 *                  └─(a quote past its validUntil)→ expired
 *
 * and cancelled from any of the first three, so long as nothing has been
 * invoiced. A quote that was accepted becomes an order by `convertToOrder`,
 * which copies the lines onto a new document rather than mutating the old one:
 * the quote is what the customer agreed to, and it has to stay readable exactly
 * as they agreed it.
 *
 * Quantities are thousandths, money is minor units, neither is ever a float,
 * and the VAT rate comes from the tax profiles the invoice editor uses — one
 * rate table for the whole product, so a quote and the invoice raised from it
 * can never disagree about what the tax is.
 */

const MILLI = 1000n;
const BPS = 10_000n;

/* ------------------------------------------------------------------- types */

export type SalesOrderKind = "QUOTE" | "ORDER";

export type SalesOrderStatus =
  | "draft" | "sent" | "accepted" | "part_invoiced"
  | "invoiced" | "declined" | "expired" | "cancelled";

/** What each state allows, phrased the way a refusal will have to say it. */
const MOVES: Record<SalesOrderStatus, string> = {
  draft: "send it to the customer, edit it, or cancel it",
  sent: "accept it, decline it, edit it, cancel it — or, for a quote, let it expire",
  accepted: "invoice an order, convert a quote into one, edit it, or cancel it",
  part_invoiced: "invoice the rest of it, or edit what is not yet invoiced",
  invoiced: "nothing — every line has been invoiced in full",
  declined: "nothing — the customer said no, so re-quote instead",
  expired: "nothing — a quote past its validity is re-quoted, not revived",
  cancelled: "nothing",
};

const say = (status: string) => status.replace(/_/g, " ");

/* ----------------------------------------------------------------- numbers */

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

function bps(v: number | string | undefined, what: string): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (!Number.isInteger(n)) {
    throw new LedgerError(`${what} must be whole basis points, got ${v}. Ten percent is 1000, not 10.`);
  }
  return n;
}

function asDate(d: Date | string, what: string): Date {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) {
    throw new LedgerError(`${what} is not a date this ledger can read ("${String(d)}"). Write it as YYYY-MM-DD.`);
  }
  return date;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Thousandths as a human reads them: 1500 → "1.5". */
function qty(m: bigint): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const frac = (abs % MILLI).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / MILLI}${frac ? "." + frac : ""}`;
}

/**
 * Half-up at the minor unit. Every figure here is non-negative — the database
 * refuses a negative price or quantity — so no sign handling is needed, and
 * half-up is what the tax rules and the invoice editor both round by.
 */
function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

/**
 * A line's net: quantity at the unit price, less the discount, rounded once.
 *
 * Once, deliberately. Discounting a rounded extension and rounding again drifts
 * by a fil per line in the customer's favour or ours, and on a hundred-line
 * quote that difference is what the customer queries.
 */
export function lineNet(unitPriceMinor: bigint, quantityMilli: bigint, discountBps = 0): bigint {
  return divHalfUp(unitPriceMinor * quantityMilli * (BPS - BigInt(discountBps)), MILLI * BPS);
}

/* --------------------------------------------------------------------- tax */

/**
 * The column defaults to 'SR', which is what a UAE bookkeeper writes for a
 * standard-rated supply; the rest of the product spells the same treatment
 * STANDARD_5. The alias is here so both read as one treatment rather than
 * quietly becoming two categories on the same document.
 */
const TAX_ALIAS: Record<string, TaxProfileCode> = {
  SR: "STANDARD_5",
  ZR: "ZERO_OTHER",
};

/**
 * The rate a line is quoted at. Looked up from the product's tax profiles
 * rather than restated here: a second rate table is a second thing to update
 * when the law changes, and the one that gets missed is always the copy.
 *
 * An unknown code is refused rather than defaulted. Defaulting to the standard
 * rate would put five percent on a zero-rated export because someone mistyped
 * the code, and the quote would look perfectly ordinary.
 */
function canonicalTax(taxCode: string, where: string): TaxProfileCode {
  const raw = (taxCode ?? "").trim().toUpperCase();
  const code = (TAX_ALIAS[raw] ?? raw) as TaxProfileCode;
  if (!(code in TAX_PROFILES)) {
    throw new LedgerError(
      `${where} carries tax code "${taxCode}", which this ledger does not know. ` +
        `Use one of ${Object.keys(TAX_PROFILES).join(", ")} — or SR for the standard rate.`,
    );
  }
  return code;
}

function profileFor(taxCode: string, where: string) {
  return getProfile(canonicalTax(taxCode, where));
}

export interface TaxSubtotal {
  taxCode: TaxProfileCode;
  label: string;
  ratePercent: number;
  netMinor: string;
  vatMinor: string;
}

export interface OrderTotals {
  netMinor: string;
  vatMinor: string;
  grossMinor: string;
  taxes: TaxSubtotal[];
}

interface LineLike {
  lineNo: number;
  quantityMilli: bigint;
  unitPriceMinor: bigint;
  discountBps: number;
  taxCode: string;
}

/**
 * What a set of lines comes to, at whichever quantity the caller is asking
 * about — the whole order, the part invoiced, or the part still to come.
 *
 * VAT is rounded once per tax treatment rather than once per line, which is the
 * rule EN 16931 sets and the rule the invoice editor already follows. Doing it
 * per line here would let a quote and the invoice raised from it differ by a
 * fil or two, and "your invoice does not match your quotation" is a call
 * nobody wants to take.
 */
function totalsOf<T extends LineLike>(lines: T[], quantityOf: (l: T) => bigint): OrderTotals {
  const netByCode = new Map<TaxProfileCode, bigint>();
  let net = 0n;

  for (const l of lines) {
    const profile = profileFor(l.taxCode, `Line ${l.lineNo}`);
    const amount = lineNet(l.unitPriceMinor, quantityOf(l), l.discountBps);
    net += amount;
    netByCode.set(profile.code, (netByCode.get(profile.code) ?? 0n) + amount);
  }

  const taxes: TaxSubtotal[] = [...netByCode].map(([code, netMinor]) => {
    const profile = getProfile(code);
    const rateBps = BigInt(Math.round(profile.ratePercent * 100));
    return {
      taxCode: code,
      label: profile.label,
      ratePercent: profile.ratePercent,
      netMinor: netMinor.toString(),
      vatMinor: divHalfUp(netMinor * rateBps, BPS).toString(),
    };
  });

  const vat = taxes.reduce((a, t) => a + BigInt(t.vatMinor), 0n);
  return { netMinor: net.toString(), vatMinor: vat.toString(), grossMinor: (net + vat).toString(), taxes };
}

/* ------------------------------------------------------------------ access */

type LoadedOrder = Prisma.SalesOrderGetPayload<{ include: { lines: true } }>;

/**
 * One order, scoped to the tenant that asked for it.
 *
 * The id is never trusted on its own. An id is guessable, quotable and
 * copy-pasteable between browser tabs, so every read and every write filters on
 * the organisation as well — and on the entity too, wherever the caller knows
 * which entity it is acting for.
 */
async function loadOrder(opts: { orgId: string; orderId: string; entityId?: string }): Promise<LoadedOrder> {
  const order = await prisma.salesOrder.findFirst({
    where: { id: opts.orderId, orgId: opts.orgId, ...(opts.entityId ? { entityId: opts.entityId } : {}) },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  if (!order) throw new LedgerError("That sales order does not exist.");
  return order;
}

function refuse(order: { number: string; status: string }, what: string): never {
  const status = order.status as SalesOrderStatus;
  throw new LedgerError(
    `${order.number} is ${say(status)}, so it cannot be ${what}. From ${say(status)} you can ${MOVES[status] ?? "do nothing"}.`,
  );
}

/**
 * The document number, taken from the entity's own sequence.
 *
 * Allocated by the same gapless counter the journal uses, inside the
 * transaction that writes the document, so a create that fails takes its number
 * back with it. Quotes and orders count separately: a customer who is sent
 * SQ-00007 and then SO-00007 has two documents, and two documents that share a
 * number are two documents somebody will file as one.
 */
async function nextNumber(tx: Prisma.TransactionClient, orgId: string, entityId: string, kind: SalesOrderKind) {
  const scope = kind === "QUOTE" ? "SQ" : "SO";
  const [{ n }] = await tx.$queryRaw<{ n: string }[]>`
    SELECT gl_next_number(${orgId}, ${entityId}, ${scope}) AS n`;
  return `${scope}-${n}`;
}

/* ------------------------------------------------------------ raising one */

export interface NewSalesOrderLine {
  description: string;
  sku?: string;
  quantityMilli: number | bigint | string;
  unitPriceMinor: number | bigint | string;
  /** Basis points off the line: 1000 is ten percent. */
  discountBps?: number | string;
  taxCode?: string;
  accountCode?: string;
}

export interface NewSalesOrder {
  /** Left out, the next number in the entity's quote or order sequence is used. */
  number?: string;
  kind?: SalesOrderKind;
  customerCode?: string;
  customerName: string;
  customerTrn?: string;
  issuedOn: Date | string;
  validUntil?: Date | string | null;
  currency?: string;
  notes?: string;
  lines?: NewSalesOrderLine[];
}

function prepareLine(documentNumber: string, lineNo: number, l: NewSalesOrderLine) {
  const description = (l.description ?? "").trim();
  if (!description) {
    throw new LedgerError(`Line ${lineNo} of ${documentNumber} needs a description. A customer cannot agree to a line nobody can read.`);
  }

  const quantityMilli = milli(l.quantityMilli, `Line ${lineNo} quantity`);
  if (quantityMilli <= 0n) {
    throw new LedgerError(
      `Line ${lineNo} of ${documentNumber} quotes ${qty(quantityMilli)}. Offering nothing is not an offer, and a negative quantity is a credit note.`,
    );
  }

  const unitPriceMinor = minor(l.unitPriceMinor, `Line ${lineNo} unit price`);
  if (unitPriceMinor < 0n) {
    throw new LedgerError(`Line ${lineNo} of ${documentNumber} has a negative unit price. Paying the customer to take the goods is a credit note, not a sale.`);
  }

  const discountBps = bps(l.discountBps, `Line ${lineNo} discount`);
  if (discountBps < 0 || discountBps > 10_000) {
    throw new LedgerError(
      `Line ${lineNo} of ${documentNumber} is discounted by ${(discountBps / 100).toFixed(2)}%. ` +
        `A discount runs from nothing to the whole of the line — more than that would invert the price.`,
    );
  }

  // Stored in the product's own spelling, not the bookkeeper's. An alias is a
  // convenience at the keyboard; persisting it would make "SR" and
  // "STANDARD_5" two categories on the VAT return that should have been one.
  const taxCode = canonicalTax(l.taxCode ?? "STANDARD_5", `Line ${lineNo} of ${documentNumber}`);

  return {
    lineNo,
    description,
    sku: l.sku?.trim() || null,
    quantityMilli,
    unitPriceMinor,
    discountBps,
    taxCode,
    accountCode: l.accountCode?.trim() || null,
  };
}

/** The validity window, checked before the database has to. */
function checkWindow(number: string, issuedOn: Date, validUntil: Date | null) {
  if (validUntil && validUntil < issuedOn) {
    throw new LedgerError(
      `${number} is issued on ${iso(issuedOn)} but stops being valid on ${iso(validUntil)}. ` +
        `An offer that expires before it is made is not an offer.`,
    );
  }
}

/**
 * Raise a quotation or a sales order. Nothing is posted — see the header.
 *
 * It starts as a draft, because until it has been sent the customer has not
 * been told anything and the document is still ours to correct.
 */
export async function createOrder(opts: { orgId: string; entityId: string; order: NewSalesOrder }) {
  const o = opts.order;
  const asked = (o.kind ?? "QUOTE").trim().toUpperCase();
  if (asked !== "QUOTE" && asked !== "ORDER") {
    throw new LedgerError(`"${o.kind}" is neither a QUOTE nor an ORDER. A document is one or the other.`);
  }
  const kind: SalesOrderKind = asked;

  const customerName = (o.customerName ?? "").trim();
  if (!customerName) {
    throw new LedgerError("A quotation needs a customer. An offer with nobody to make it to is not an offer.");
  }
  if (!o.issuedOn) throw new LedgerError(`${customerName}'s document needs an issue date.`);

  const issuedOn = asDate(o.issuedOn, "The issue date");
  const validUntil = o.validUntil ? asDate(o.validUntil, "The validity date") : null;

  const supplied = (o.number ?? "").trim();
  if (supplied) {
    const clash = await prisma.salesOrder.findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, number: supplied },
      select: { status: true },
    });
    if (clash) {
      throw new LedgerError(
        `Document number ${supplied} is already in use by a ${say(clash.status)} document. Give this one its own number, or leave it blank and take the next in the sequence.`,
      );
    }
  }
  checkWindow(supplied || "This document", issuedOn, validUntil);

  try {
    return await prisma.$transaction(async (tx) => {
      const number = supplied || (await nextNumber(tx, opts.orgId, opts.entityId, kind));
      const lines = (o.lines ?? []).map((l, i) => prepareLine(number, i + 1, l));
      return tx.salesOrder.create({
        data: {
          orgId: opts.orgId,
          entityId: opts.entityId,
          number,
          kind,
          customerCode: o.customerCode?.trim() || null,
          customerName,
          customerTrn: o.customerTrn?.trim() || null,
          issuedOn,
          validUntil,
          currency: o.currency ?? "AED",
          status: "draft",
          notes: o.notes ?? null,
          lines: { create: lines.map((l) => ({ orgId: opts.orgId, ...l })) },
        },
        include: { lines: { orderBy: { lineNo: "asc" } } },
      });
    });
  } catch (e) {
    // Two people raising a document at once, or two tabs of the same person.
    // The unique index is what actually decides it; this only turns the
    // database's answer into one a bookkeeper can act on.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new LedgerError(
        `Document number ${supplied || "that"} was taken by another document while this one was being raised. Try again — the next number in the sequence is free.`,
      );
    }
    throw e;
  }
}

/* -------------------------------------------------------------- editing it */

export interface OrderLinePatch extends Partial<NewSalesOrderLine> {
  /** The line being changed. Left out, the line is a new one. */
  id?: string;
  description: string;
  quantityMilli: number | bigint | string;
  unitPriceMinor: number | bigint | string;
}

export interface OrderPatch {
  customerCode?: string | null;
  customerName?: string;
  customerTrn?: string | null;
  issuedOn?: Date | string;
  validUntil?: Date | string | null;
  notes?: string | null;
  /** The whole set of lines. A line left out of it is removed. */
  lines?: OrderLinePatch[];
}

/**
 * Change a document that is still in play.
 *
 * Freely, while it is a draft or has merely been sent: the customer has an
 * offer, not an agreement, and correcting a typo is not a variation. Once it
 * has been accepted the customer can still vary what they asked for, and the
 * document has to be able to say so — but no line may then be cut below what
 * has already been invoiced. That number is not an intention, it is a tax
 * invoice somebody has been sent; making the order disagree with it would leave
 * the books billing for goods the order says were never ordered.
 *
 * A finished, refused or cancelled document is not edited at all. Its whole
 * value is that it says what it said.
 */
export async function updateOrder(opts: {
  orgId: string;
  orderId: string;
  entityId?: string;
  patch: OrderPatch;
}) {
  const order = await loadOrder(opts);
  const status = order.status as SalesOrderStatus;
  if (!["draft", "sent", "accepted", "part_invoiced"].includes(status)) {
    refuse(order, "changed");
  }

  const p = opts.patch ?? {};
  const customerName = p.customerName === undefined ? order.customerName : p.customerName.trim();
  if (!customerName) {
    throw new LedgerError(`${order.number} still needs a customer. Taking the name off it would leave an offer made to nobody.`);
  }
  const issuedOn = p.issuedOn === undefined ? order.issuedOn : asDate(p.issuedOn, "The issue date");
  const validUntil =
    p.validUntil === undefined ? order.validUntil : p.validUntil ? asDate(p.validUntil, "The validity date") : null;
  checkWindow(order.number, issuedOn, validUntil);

  const byId = new Map(order.lines.map((l) => [l.id, l]));
  const patchLines = p.lines;

  if (patchLines) {
    const seen = new Set<string>();
    for (const l of patchLines) {
      if (!l.id) continue;
      if (!byId.has(l.id)) {
        throw new LedgerError(`${order.number} has no line ${l.id}. Reload the order — someone else may have changed it.`);
      }
      if (seen.has(l.id)) {
        const line = byId.get(l.id)!;
        throw new LedgerError(`Line ${line.lineNo} of ${order.number} (${line.description}) appears twice in the same change. Put the whole quantity on one line.`);
      }
      seen.add(l.id);
    }

    // A line that has been invoiced cannot be dropped: dropping it is cutting
    // it to nothing, and the invoice would then be for a line the order has
    // never heard of.
    for (const line of order.lines) {
      if (!seen.has(line.id) && line.invoicedMilli > 0n) {
        throw new LedgerError(
          `Line ${line.lineNo} of ${order.number} (${line.description}) has already been invoiced for ${qty(line.invoicedMilli)}, so it cannot be taken off the order. ` +
            `Credit the invoice first, or leave the line where it is.`,
        );
      }
    }
  }

  return prisma.$transaction(async (tx) => {
    if (patchLines) {
      let nextLineNo = order.lines.reduce((a, l) => Math.max(a, l.lineNo), 0);

      for (const line of order.lines) {
        if (!patchLines.some((l) => l.id === line.id)) {
          await tx.salesOrderLine.delete({ where: { id: line.id } });
        }
      }

      for (const input of patchLines) {
        const existing = input.id ? byId.get(input.id)! : null;
        const lineNo = existing ? existing.lineNo : ++nextLineNo;
        const prepared = prepareLine(order.number, lineNo, {
          ...input,
          taxCode: input.taxCode ?? existing?.taxCode ?? "STANDARD_5",
          discountBps: input.discountBps ?? existing?.discountBps ?? 0,
        });

        if (existing && prepared.quantityMilli < existing.invoicedMilli) {
          throw new LedgerError(
            `Line ${existing.lineNo} of ${order.number} (${existing.description}) has already been invoiced for ${qty(existing.invoicedMilli)}, ` +
              `so its quantity cannot be cut to ${qty(prepared.quantityMilli)}. Raise a credit note for the difference first, or leave the line at ${qty(existing.invoicedMilli)} or more.`,
          );
        }

        if (existing) {
          await tx.salesOrderLine.update({ where: { id: existing.id }, data: prepared });
        } else {
          await tx.salesOrderLine.create({
            data: { orgId: opts.orgId, orderId: order.id, ...prepared },
          });
        }
      }
    }

    return tx.salesOrder.update({
      where: { id: order.id },
      data: {
        customerName,
        customerCode: p.customerCode === undefined ? order.customerCode : p.customerCode?.trim() || null,
        customerTrn: p.customerTrn === undefined ? order.customerTrn : p.customerTrn?.trim() || null,
        issuedOn,
        validUntil,
        notes: p.notes === undefined ? order.notes : p.notes,
      },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });
  });
}

/* ------------------------------------------------------- the state machine */

/** Send a draft to the customer: draft → sent. Still not an entry. */
export async function sendOrder(opts: { orgId: string; orderId: string; entityId?: string }) {
  const order = await loadOrder(opts);
  if (order.status !== "draft") refuse(order, "sent — only a draft can be sent");
  if (order.lines.length === 0) {
    throw new LedgerError(`${order.number} has nothing on it. A document with no lines offers the customer nothing, so there is nothing to send.`);
  }
  return prisma.salesOrder.update({
    where: { id: order.id },
    data: { status: "sent" },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
}

/**
 * The customer said yes: sent → accepted.
 *
 * Only from sent, because acceptance is acceptance *of something* — a document
 * the customer has never seen cannot have been agreed, and a document that has
 * expired or been declined is no longer on the table.
 */
export async function acceptOrder(opts: {
  orgId: string; orderId: string; entityId?: string; acceptedOn?: Date | string; reference?: string;
  /** Accept anyway, on the record, when credit refuses. */
  override?: { reason: string; actorId?: string } | null;
}) {
  const order = await loadOrder(opts);
  if (order.status !== "sent") refuse(order, "accepted — only a document the customer has been sent can be accepted");

  // Acceptance is the commitment. It is the last point at which declining
  // costs nothing but a conversation.
  const gate = await creditGate({
    orgId: opts.orgId, entityId: order.entityId,
    customerCode: order.customerCode, customerName: order.customerName,
    additionalMinor: BigInt(totalsOf(order.lines, (l) => l.quantityMilli).grossMinor),
    override: opts.override,
  });

  const notes = [
    order.notes,
    opts.reference?.trim()
      ? `Accepted${opts.acceptedOn ? ` on ${iso(asDate(opts.acceptedOn, "The acceptance date"))}` : ""}: ${opts.reference.trim()}`
      : null,
    gate.overrode
      ? `Credit refused and was overridden${opts.override?.actorId ? ` by ${opts.override.actorId}` : ""}: ` +
        `${opts.override?.reason?.trim()} (${gate.reasons.join(" ")})`
      : null,
  ].filter(Boolean).join("\n");

  const updated = await prisma.salesOrder.update({
    where: { id: order.id },
    data: { status: "accepted", notes: notes || order.notes },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
  return Object.assign(updated, { credit: gate });
}


/* ------------------------------------------------------------ credit gate */

export interface CreditGate {
  /** What the check said, or null where there was nobody to check against. */
  decision: "allow" | "review" | "refuse" | "unknown";
  headline: string;
  reasons: string[];
  overrode: boolean;
}

/**
 * Ask the credit check before committing to a sale.
 *
 * Neither credit check had a single call site outside an advisory GET endpoint,
 * so a customer on hold could have an order accepted and invoiced with nothing
 * said. The same `onHold` flag *is* enforced on the supplier side —
 * payment-runs.ts excludes a held supplier's bill from a run with a reason
 * sentence — so this was a one-sided omission rather than a stance about
 * controls.
 *
 * `creditCheck` is the one used, deliberately: it is the wider measure, adding
 * accepted-but-uninvoiced orders to ledger exposure, which is exactly the
 * figure that matters at the moment somebody commits to another one.
 *
 * Three things it does not do.
 *
 * It does not refuse an unrecognised customer. An order carries a free-text
 * customer code, so "no such counterparty" means the sales team typed a name,
 * not that the customer is bad for the money. That is a review.
 *
 * It does not block on `review`. Review is what a person is for, and the
 * decision is returned so the screen can put the sentence in front of them.
 *
 * And an override is allowed but never silent: it takes a reason, and the
 * reason goes on the order where the next person reads it.
 *
 * `postInvoice` deliberately still does not call this, and its own docstring
 * says why — refusing to post would leave the books denying a document the
 * customer is already holding. The gate belongs before the document exists.
 *
 * This is one of the two places it does. The other is `invoiceCreditGate` in
 * credit-control.ts, which runs when an invoice is finalised, for the business
 * that raises invoices without raising orders first — for whom everything here
 * would otherwise be an enforcement it never reaches.
 */
async function creditGate(opts: {
  orgId: string;
  entityId: string;
  customerCode: string | null;
  customerName: string;
  additionalMinor: bigint;
  override?: { reason: string; actorId?: string } | null;
}): Promise<CreditGate> {
  const key = (opts.customerCode ?? "").trim() || opts.customerName.trim();
  if (!key) {
    return {
      decision: "unknown",
      headline: "The document names no customer, so there is nobody to check credit against.",
      reasons: [],
      overrode: false,
    };
  }

  // Deferred: credit-control.ts imports this module, so a static import here
  // would be a cycle.
  const { creditCheck } = await import("./credit-control");

  let check;
  try {
    check = await creditCheck({
      orgId: opts.orgId, entityId: opts.entityId, partyKey: key,
      additionalMinor: opts.additionalMinor,
    });
  } catch (e) {
    // An unmatched or ambiguous code is a data problem, not a credit problem.
    return {
      decision: "unknown",
      headline:
        `Credit could not be checked for "${key}": ${e instanceof Error ? e.message : "the customer could not be resolved"} ` +
        `The order is not blocked by that — an unrecognised code means somebody typed a name, not that the ` +
        `customer is bad for the money.`,
      reasons: [],
      overrode: false,
    };
  }

  const reasons = (check.reasons ?? []).map((r: { message: string }) => r.message);
  if (check.decision !== "refuse") {
    return { decision: check.decision, headline: check.summary, reasons, overrode: false };
  }

  const reason = opts.override?.reason?.trim();
  if (!reason) {
    // `summary` already reads the reasons out; repeating them would print the
    // same sentence twice, which is how a refusal starts being skimmed.
    throw new LedgerError(
      `${check.summary} Release the hold, raise the limit, or override this with a reason — an override is ` +
        `allowed and is recorded on the order where the next person reads it.`,
    );
  }
  return { decision: "refuse", headline: check.summary, reasons, overrode: true };
}

/** The customer said no: sent → declined. The reason is the useful part. */
export async function declineOrder(opts: { orgId: string; orderId: string; entityId?: string; reason?: string }) {
  const order = await loadOrder(opts);
  if (order.status !== "declined" && order.status !== "sent") {
    refuse(order, "declined — only a document the customer has been sent can be turned down");
  }
  if (order.status === "declined") return order;
  return prisma.salesOrder.update({
    where: { id: order.id },
    data: {
      status: "declined",
      notes: opts.reason?.trim() ? [order.notes, `Declined: ${opts.reason.trim()}`].filter(Boolean).join("\n") : order.notes,
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
}

/**
 * Withdraw a document nothing has been invoiced against.
 *
 * Once any of it has been billed the promise has been partly performed and the
 * customer holds a tax invoice for it. Cancelling then would leave that invoice
 * pointing at a document that says the sale was called off — so such an order
 * is credited, not cancelled.
 */
export async function cancelOrder(opts: { orgId: string; orderId: string; entityId?: string; reason?: string }) {
  const order = await loadOrder(opts);
  if (order.status === "cancelled") return order;
  if (!["draft", "sent", "accepted"].includes(order.status)) refuse(order, "cancelled");

  const invoiced = order.lines.reduce((a, l) => a + l.invoicedMilli, 0n);
  if (invoiced > 0n) {
    throw new LedgerError(
      `${order.number} has already been invoiced for ${qty(invoiced)}, so it cannot be cancelled — the customer is holding a tax invoice for it. ` +
        `Raise a credit note for what was billed, and leave the order to show what really happened.`,
    );
  }

  return prisma.salesOrder.update({
    where: { id: order.id },
    data: {
      status: "cancelled",
      notes: opts.reason?.trim() ? [order.notes, `Cancelled: ${opts.reason.trim()}`].filter(Boolean).join("\n") : order.notes,
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
  });
}

/**
 * Turn an accepted quotation into a sales order.
 *
 * The quote is copied, never converted in place. What the customer accepted has
 * to stay readable exactly as they accepted it — that document is the evidence
 * of the agreement, and rewriting it into something else destroys the only
 * record of what was agreed. The order that comes out of it is a fresh document
 * with its own number and its own invoiced quantities, starting at nothing.
 */
export async function convertToOrder(opts: { orgId: string; quoteId: string; entityId?: string }) {
  const quote = await loadOrder({ orgId: opts.orgId, orderId: opts.quoteId, entityId: opts.entityId });

  if (quote.kind !== "QUOTE") {
    throw new LedgerError(`${quote.number} is already a sales order. There is nothing to convert.`);
  }
  if (quote.status !== "accepted") {
    refuse(quote, "converted into an order — only a quotation the customer has accepted becomes an order");
  }
  if (quote.lines.length === 0) {
    throw new LedgerError(`${quote.number} has no lines on it, so there is nothing to carry onto an order.`);
  }

  const already = await prisma.salesOrder.findFirst({
    where: { orgId: quote.orgId, entityId: quote.entityId, kind: "ORDER", notes: { contains: `Converted from ${quote.number}` } },
    select: { number: true },
  });
  if (already) {
    throw new LedgerError(`${quote.number} has already become ${already.number}. Converting it twice would sell the same goods to the same customer twice.`);
  }

  return prisma.$transaction(async (tx) => {
    const number = await nextNumber(tx, quote.orgId, quote.entityId, "ORDER");
    const order = await tx.salesOrder.create({
      data: {
        orgId: quote.orgId,
        entityId: quote.entityId,
        number,
        kind: "ORDER",
        customerCode: quote.customerCode,
        customerName: quote.customerName,
        customerTrn: quote.customerTrn,
        issuedOn: quote.issuedOn,
        // An order does not expire: the customer has agreed to it, and an
        // agreement does not lapse because a quotation's validity date passed.
        validUntil: null,
        currency: quote.currency,
        status: "accepted",
        notes: [quote.notes, `Converted from ${quote.number}`].filter(Boolean).join("\n"),
        lines: {
          create: quote.lines.map((l) => ({
            orgId: l.orgId,
            lineNo: l.lineNo,
            description: l.description,
            sku: l.sku,
            quantityMilli: l.quantityMilli,
            unitPriceMinor: l.unitPriceMinor,
            discountBps: l.discountBps,
            taxCode: l.taxCode,
            accountCode: l.accountCode,
          })),
        },
      },
      include: { lines: { orderBy: { lineNo: "asc" } } },
    });

    await tx.salesOrder.update({
      where: { id: quote.id },
      data: { notes: [quote.notes, `Converted to ${number}`].filter(Boolean).join("\n") },
    });

    return order;
  });
}

/* --------------------------------------------------------------- invoicing */

export interface InvoiceLineInput {
  orderLineId: string;
  /** Thousandths being invoiced now. Left out, the rest of the line. */
  quantityMilli?: number | bigint | string;
}

export interface InvoiceOrderResult {
  orderId: string;
  number: string;
  status: SalesOrderStatus;
  /** What this instalment is worth. Nothing has been posted for it. */
  totals: OrderTotals;
  /** What the credit check said, and whether somebody overrode it. */
  credit: CreditGate;
  lines: {
    orderLineId: string;
    lineNo: number;
    description: string;
    invoicedNowMilli: string;
    invoicedMilli: string;
    remainingMilli: string;
    netMinor: string;
  }[];
}

/**
 * Record that some of an order has been invoiced.
 *
 * This posts nothing, and that is the point. The entry for a sale is made by
 * the receivables subledger when the invoice itself is raised — debit
 * receivables, credit revenue and output tax. If this module posted as well,
 * the same sale would reach the books twice, and the second copy would have no
 * document behind it. What is recorded here is quantity: how much of each line
 * has now been billed, so the order can say what is left and can refuse to be
 * billed for it again.
 */
export async function invoiceOrder(opts: {
  orgId: string;
  orderId: string;
  entityId?: string;
  /** Left out, everything still outstanding is invoiced. */
  lines?: InvoiceLineInput[];
  /** Invoice anyway, on the record, when credit refuses. */
  override?: { reason: string; actorId?: string } | null;
}): Promise<InvoiceOrderResult> {
  const order = await loadOrder(opts);

  if (order.kind !== "ORDER") {
    throw new LedgerError(
      `${order.number} is a quotation, not a sales order. Convert it into an order first — an offer the customer has not turned into an order is not something to invoice.`,
    );
  }
  if (order.status !== "accepted" && order.status !== "part_invoiced") {
    refuse(order, "invoiced — only an accepted order can be billed");
  }

  const byId = new Map(order.lines.map((l) => [l.id, l]));
  const seen = new Set<string>();

  const requested = opts.lines?.length
    ? opts.lines.map((input) => {
        const line = byId.get(input.orderLineId);
        if (!line) {
          throw new LedgerError(`${order.number} has no line ${input.orderLineId}. Check the invoice against the order.`);
        }
        if (seen.has(line.id)) {
          throw new LedgerError(`Line ${line.lineNo} of ${order.number} (${line.description}) appears twice on the same invoice. Put the whole invoiced quantity on one line.`);
        }
        seen.add(line.id);

        const remaining = line.quantityMilli - line.invoicedMilli;
        const quantityMilli =
          input.quantityMilli === undefined || input.quantityMilli === null || input.quantityMilli === ""
            ? remaining
            : milli(input.quantityMilli, `Line ${line.lineNo} invoiced quantity`);

        if (quantityMilli <= 0n) {
          throw new LedgerError(
            `Line ${line.lineNo} of ${order.number} (${line.description}) is invoiced for ${qty(quantityMilli)}. Billing nothing is not an invoice, and billing a negative is a credit note.`,
          );
        }
        if (quantityMilli > remaining) {
          // The refusal a salesperson can act on: what was ordered, what has
          // already gone out, and therefore what is left. Over-invoicing is
          // either a second invoice for the same delivery or an order that was
          // never varied, and only these three numbers tell the reader which.
          throw new LedgerError(
            `Line ${line.lineNo} of ${order.number} (${line.description}) is for ${qty(line.quantityMilli)} and ${qty(line.invoicedMilli)} has already been invoiced, ` +
              `so ${qty(quantityMilli)} cannot be billed — only ${qty(remaining)} is left to invoice. ` +
              `Raise a variation to the order if the customer really has asked for more.`,
          );
        }
        return { line, quantityMilli };
      })
    : order.lines
        .filter((l) => l.quantityMilli > l.invoicedMilli)
        .map((line) => ({ line, quantityMilli: line.quantityMilli - line.invoicedMilli }));

  if (requested.length === 0) {
    throw new LedgerError(`Every line on ${order.number} has already been invoiced in full, so there is nothing left to bill.`);
  }

  const fullyInvoiced = order.lines.every((l) => {
    const now = requested.find((r) => r.line.id === l.id)?.quantityMilli ?? 0n;
    return l.invoicedMilli + now >= l.quantityMilli;
  });
  const nextStatus: SalesOrderStatus = fullyInvoiced ? "invoiced" : "part_invoiced";

  const instalmentNow = requested.map((r) => ({ ...r.line, invoicedNow: r.quantityMilli }));

  /*
   * The second commitment point.
   *
   * Acceptance is checked against the whole order; this is checked against
   * what is being billed now, because a customer who was inside their limit
   * when the order was taken may not be by the third instalment. The check
   * runs before the quantities move, so a refusal leaves the order exactly
   * where it was rather than half-advanced.
   */
  const gate = await creditGate({
    orgId: opts.orgId, entityId: order.entityId,
    customerCode: order.customerCode, customerName: order.customerName,
    additionalMinor: BigInt(totalsOf(instalmentNow, (l) => l.invoicedNow).grossMinor),
    override: opts.override,
  });
  if (gate.overrode) {
    await prisma.salesOrder.update({
      where: { id: order.id },
      data: {
        notes: [
          order.notes,
          `Credit refused at invoicing and was overridden${opts.override?.actorId ? ` by ${opts.override.actorId}` : ""}: ` +
            `${opts.override?.reason?.trim()} (${gate.reasons.join(" ")})`,
        ].filter(Boolean).join("\n"),
      },
    });
  }

  // The quantities and the status move together: a line advanced without the
  // status would leave an order that is fully billed still looking open, and a
  // status advanced without the quantities would let the rest be billed twice.
  await prisma.$transaction(async (tx) => {
    for (const r of requested) {
      await tx.salesOrderLine.update({
        where: { id: r.line.id },
        data: { invoicedMilli: { increment: r.quantityMilli } },
      });
    }
    await tx.salesOrder.update({ where: { id: order.id }, data: { status: nextStatus } });
  });

  return {
    orderId: order.id,
    number: order.number,
    status: nextStatus,
    credit: gate,
    totals: totalsOf(instalmentNow, (l) => l.invoicedNow),
    lines: requested.map((r) => ({
      orderLineId: r.line.id,
      lineNo: r.line.lineNo,
      description: r.line.description,
      invoicedNowMilli: r.quantityMilli.toString(),
      invoicedMilli: (r.line.invoicedMilli + r.quantityMilli).toString(),
      remainingMilli: (r.line.quantityMilli - r.line.invoicedMilli - r.quantityMilli).toString(),
      netMinor: lineNet(r.line.unitPriceMinor, r.quantityMilli, r.line.discountBps).toString(),
    })),
  };
}

/* ----------------------------------------------------------------- expiry */

export interface ExpireResult {
  asOf: string;
  expired: number;
  quotes: { id: string; number: string; customerName: string; validUntil: string | null }[];
}

/**
 * Move quotations past their validity, and never accepted, to expired.
 *
 * A quote nobody answered is not a pipeline. Left in "sent" it inflates every
 * forecast anyone builds off this list, and the older it is the more certain it
 * is that the customer is not coming back. The sweep says so on the date the
 * quote itself set.
 *
 * Idempotent by construction: it only ever touches quotes that are still draft
 * or sent, so running it twice on the same day expires nothing the second time,
 * and running it a month late still expires exactly the ones that lapsed.
 * `validUntil` is inclusive — a quote valid until the 30th is still an offer on
 * the 30th — so only a date strictly before `asOf` has passed.
 */
export async function expireQuotes(opts: { orgId: string; entityId: string; asOf?: Date | string }): Promise<ExpireResult> {
  const asOf = opts.asOf ? asDate(opts.asOf, "The sweep date") : new Date();

  const where = {
    orgId: opts.orgId,
    entityId: opts.entityId,
    // Only a quote may be expired — an order the customer agreed to does not
    // lapse, and the database refuses the state anyway.
    kind: "QUOTE",
    status: { in: ["draft", "sent"] },
    validUntil: { not: null, lt: asOf },
  } satisfies Prisma.SalesOrderWhereInput;

  const doomed = await prisma.salesOrder.findMany({
    where,
    select: { id: true, number: true, customerName: true, validUntil: true },
    orderBy: { number: "asc" },
  });
  if (doomed.length === 0) return { asOf: iso(asOf), expired: 0, quotes: [] };

  const { count } = await prisma.salesOrder.updateMany({ where, data: { status: "expired" } });

  return {
    asOf: iso(asOf),
    expired: count,
    quotes: doomed.map((q) => ({
      id: q.id,
      number: q.number,
      customerName: q.customerName,
      validUntil: q.validUntil ? iso(q.validUntil) : null,
    })),
  };
}

/* ----------------------------------------------------------------- reading */

export interface OrderRow {
  id: string;
  number: string;
  kind: SalesOrderKind;
  customerCode: string | null;
  customerName: string;
  issuedOn: string;
  validUntil: string | null;
  currency: string;
  status: SalesOrderStatus;
  lineCount: number;
  netMinor: string;
  vatMinor: string;
  grossMinor: string;
  /** What is still to be billed, at the quoted prices. */
  remainingNetMinor: string;
  /** Past its validity and still on offer — the sweep has not been run. */
  lapsed: boolean;
}

export interface OrderListTotals {
  netMinor: string;
  vatMinor: string;
  grossMinor: string;
  remainingNetMinor: string;
}

/** The list, with what each document is worth and what is still to be billed. */
export async function listOrders(opts: {
  orgId: string;
  entityId: string;
  status?: SalesOrderStatus;
  kind?: SalesOrderKind;
  customerCode?: string;
  asOf?: Date | string;
}): Promise<{ orders: OrderRow[]; totals: OrderListTotals }> {
  const asOf = opts.asOf ? asDate(opts.asOf, "The as-at date") : new Date();

  const orders = await prisma.salesOrder.findMany({
    where: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.customerCode ? { customerCode: opts.customerCode } : {}),
    },
    include: { lines: { orderBy: { lineNo: "asc" } } },
    orderBy: [{ issuedOn: "desc" }, { number: "desc" }],
  });

  const rows = orders.map((o) => {
    const totals = totalsOf(o.lines, (l) => l.quantityMilli);
    const remaining = totalsOf(o.lines, (l) => l.quantityMilli - l.invoicedMilli);
    return {
      id: o.id,
      number: o.number,
      kind: o.kind as SalesOrderKind,
      customerCode: o.customerCode,
      customerName: o.customerName,
      issuedOn: iso(o.issuedOn),
      validUntil: o.validUntil ? iso(o.validUntil) : null,
      currency: o.currency,
      status: o.status as SalesOrderStatus,
      lineCount: o.lines.length,
      netMinor: totals.netMinor,
      vatMinor: totals.vatMinor,
      grossMinor: totals.grossMinor,
      remainingNetMinor: remaining.netMinor,
      lapsed:
        o.kind === "QUOTE" && (o.status === "draft" || o.status === "sent") && o.validUntil !== null && o.validUntil < asOf,
    };
  });

  // Summed from the rows rather than recomputed across every line, so the
  // column on the screen adds up to the figure under it. Each document rounds
  // its own tax, and a total that rounded them again together could differ
  // from the documents it is a total of.
  const net = rows.reduce((a, r) => a + BigInt(r.netMinor), 0n);
  const vat = rows.reduce((a, r) => a + BigInt(r.vatMinor), 0n);
  return {
    orders: rows,
    totals: {
      netMinor: net.toString(),
      vatMinor: vat.toString(),
      grossMinor: (net + vat).toString(),
      remainingNetMinor: rows.reduce((a, r) => a + BigInt(r.remainingNetMinor), 0n).toString(),
    },
  };
}

export interface OrderDetail {
  id: string;
  number: string;
  kind: SalesOrderKind;
  customerCode: string | null;
  customerName: string;
  customerTrn: string | null;
  issuedOn: string;
  validUntil: string | null;
  currency: string;
  status: SalesOrderStatus;
  notes: string | null;
  lines: {
    id: string;
    lineNo: number;
    description: string;
    sku: string | null;
    accountCode: string | null;
    quantityMilli: string;
    unitPriceMinor: string;
    discountBps: number;
    taxCode: string;
    ratePercent: number;
    /** The line at its full quantity, after the discount. */
    netMinor: string;
    invoicedMilli: string;
    invoicedNetMinor: string;
    remainingMilli: string;
    remainingNetMinor: string;
  }[];
  totals: OrderTotals;
  invoiced: OrderTotals;
  remaining: OrderTotals;
  /** Whether the sweep would expire it, said before the sweep is run. */
  lapsed: boolean;
}

/** One document in full: its lines, its tax, and what is left to bill. */
export async function orderDetail(opts: { orgId: string; orderId: string; entityId?: string; asOf?: Date | string }): Promise<OrderDetail> {
  const order = await loadOrder(opts);
  const asOf = opts.asOf ? asDate(opts.asOf, "The as-at date") : new Date();

  return {
    id: order.id,
    number: order.number,
    kind: order.kind as SalesOrderKind,
    customerCode: order.customerCode,
    customerName: order.customerName,
    customerTrn: order.customerTrn,
    issuedOn: iso(order.issuedOn),
    validUntil: order.validUntil ? iso(order.validUntil) : null,
    currency: order.currency,
    status: order.status as SalesOrderStatus,
    notes: order.notes,
    lines: order.lines.map((l) => {
      const profile = profileFor(l.taxCode, `Line ${l.lineNo} of ${order.number}`);
      const remainingMilli = l.quantityMilli - l.invoicedMilli;
      return {
        id: l.id,
        lineNo: l.lineNo,
        description: l.description,
        sku: l.sku,
        accountCode: l.accountCode,
        quantityMilli: l.quantityMilli.toString(),
        unitPriceMinor: l.unitPriceMinor.toString(),
        discountBps: l.discountBps,
        taxCode: l.taxCode,
        ratePercent: profile.ratePercent,
        netMinor: lineNet(l.unitPriceMinor, l.quantityMilli, l.discountBps).toString(),
        invoicedMilli: l.invoicedMilli.toString(),
        invoicedNetMinor: lineNet(l.unitPriceMinor, l.invoicedMilli, l.discountBps).toString(),
        remainingMilli: remainingMilli.toString(),
        remainingNetMinor: lineNet(l.unitPriceMinor, remainingMilli, l.discountBps).toString(),
      };
    }),
    totals: totalsOf(order.lines, (l) => l.quantityMilli),
    invoiced: totalsOf(order.lines, (l) => l.invoicedMilli),
    remaining: totalsOf(order.lines, (l) => l.quantityMilli - l.invoicedMilli),
    lapsed:
      order.kind === "QUOTE" &&
      (order.status === "draft" || order.status === "sent") &&
      order.validUntil !== null &&
      order.validUntil < asOf,
  };
}
