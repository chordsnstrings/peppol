import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { lineNet } from "./sales-orders";

/**
 * Price lists.
 *
 * A price typed onto a document by hand is a number with no provenance. Six
 * months later nobody can say whether it was the agreed price, a quantity
 * break, or somebody being generous on a Friday — and a discount that was
 * never recorded as a discount cannot be reported on, which is exactly how
 * margin leaks out of a business that thinks it is watching margin.
 *
 * The module answers one question: what does this item cost this party, in
 * this quantity, on this date? It answers it with the derivation attached —
 * which list, which quantity break, which row, and what would have applied
 * had the party had no list of its own. A price with its reasoning is
 * arguable; a price on its own can only be accepted or disputed.
 *
 * Two things it deliberately refuses to do.
 *
 * It does not convert. A list priced in USD does not become a price in AED
 * because the invoice happens to be in AED. Which rate — the day's, the
 * month's, the one in the contract? Picking one silently would put an
 * exchange difference inside the selling price, where nobody would ever find
 * it. It says the list is in the wrong currency and stops.
 *
 * It does not set prices on documents. Resolution is a read; the invoice, the
 * order and the subscription each keep their own price, because a price agreed
 * on the day the order was taken does not change because the list did. What
 * the list gives those documents is a default and, afterwards, something to
 * measure them against — see `priceVariance`.
 */

const MILLI = 1000n;
const BPS = 10_000n;

export type ListKind = "SELL" | "BUY";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

function asDate(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? day(v.slice(0, 10)) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date I can read.`);
  return d;
}

function minor(v: number | bigint | string, what: string): bigint {
  try {
    const b = typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.round(v) : v.trim());
    return b;
  } catch {
    throw new LedgerError(`${what} is not an amount I can read.`);
  }
}

/**
 * Party keys are folded to lower case on the way in and on the way out.
 *
 * The alternative is an assignment for "ACME" and another for "Acme" both
 * sitting in the table, each looking like the arrangement, and the price
 * depending on how the customer's name was typed on the day.
 */
export function partyKeyOf(v: string): string {
  return v.trim().toLowerCase();
}

/** Does a window contain a date? Ends are inclusive: a list valid to the 31st prices on the 31st. */
function inForce(from: Date, to: Date | null, on: Date): boolean {
  if (on < from) return false;
  return to === null || on <= to;
}

/**
 * Postgres raises 23P01 for an exclusion violation, and it is the only one in
 * this module.
 *
 * Prisma has no mapped error code for an exclusion constraint — it surfaces as
 * PrismaClientUnknownRequestError with the driver's message inside — so the
 * SQLSTATE is read out of the message. Matching on the constraint's name
 * instead would break the day somebody renames it in a migration; the SQLSTATE
 * is part of the protocol.
 */
function isOverlap(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (code === "23P01") return true;
  return /\b23P01\b/.test(String((e as { message?: unknown }).message ?? ""));
}

/* ---------------------------------------------------------------- the lists */

export interface NewPriceList {
  code: string;
  name: string;
  currency?: string;
  kind?: ListKind;
  isDefault?: boolean;
  validFrom: Date | string;
  validTo?: Date | string | null;
  notes?: string;
  /**
   * Close the outgoing default of the same kind to the day before this one
   * starts, as part of recording it.
   *
   * A price rise on a whole list is one event, and without this it cannot be
   * entered at all: the exclusion constraint refuses a second default over the
   * same days, and the only remedy — end the old list first — leaves a gap in
   * which nothing is priced if the new list is then not created. Asked for
   * explicitly, never assumed, because it edits a list somebody else set up.
   */
  supersedeDefault?: boolean;
}

export async function createPriceList(opts: {
  orgId: string; entityId: string; list: NewPriceList;
}) {
  const l = opts.list;
  const code = l.code.trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,32}$/.test(code)) {
    throw new LedgerError(`"${l.code}" is not a price-list code. Use letters, digits and underscores.`);
  }
  if (!l.name.trim()) throw new LedgerError("A price list needs a name somebody will recognise.");
  const currency = (l.currency ?? "AED").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new LedgerError(`"${l.currency}" is not a currency code.`);

  const validFrom = asDate(l.validFrom, "The date the list starts");
  const validTo = l.validTo ? asDate(l.validTo, "The date the list ends") : null;
  if (validTo && validTo < validFrom) throw new LedgerError("The list ends before it starts.");

  const existing = await prisma.priceList.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code },
  });
  if (existing) throw new LedgerError(`There is already a price list ${code}.`);

  const kind: ListKind = l.kind ?? "SELL";
  const isDefault = l.isDefault ?? false;

  // The outgoing default, where this one is asked to supersede it. Found
  // before anything is written so a list that cannot be closed refuses the
  // whole thing rather than closing one and failing to open the other.
  let outgoing: { id: string; code: string; validFrom: Date } | null = null;
  if (isDefault && l.supersedeDefault) {
    const current = await prisma.priceList.findFirst({
      where: {
        orgId: opts.orgId, entityId: opts.entityId, kind, isDefault: true,
        // Including one that starts on the same day, so the refusal below can
        // say what is actually wrong rather than leaving the database to
        // report an overlap to somebody who has already asked for it to be
        // closed.
        validFrom: { lte: validFrom },
        OR: [{ validTo: null }, { validTo: { gte: validFrom } }],
      },
      orderBy: { validFrom: "desc" },
    });
    if (current) outgoing = { id: current.id, code: current.code, validFrom: current.validFrom };
  }

  // The day before the new list starts. Ends are inclusive here, so this is
  // the last day the old list prices anything and the two never overlap.
  const closeOn = new Date(validFrom.getTime() - 86_400_000);
  if (outgoing && closeOn < outgoing.validFrom) {
    throw new LedgerError(
      `${outgoing.code} starts on ${iso(outgoing.validFrom)} and would have to be closed on ${iso(closeOn)} to make ` +
      `room for this one. A list cannot end before it starts — the new list has to start after the old one did.`,
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      if (outgoing) {
        await tx.priceList.update({ where: { id: outgoing.id }, data: { validTo: closeOn } });
      }
      return tx.priceList.create({
        data: {
          orgId: opts.orgId, entityId: opts.entityId, code, name: l.name.trim(),
          currency, kind, isDefault,
          validFrom, validTo, notes: l.notes?.trim() || null,
        },
      });
    });
  } catch (e) {
    if (isOverlap(e)) {
      throw new LedgerError(
        `There is already a default ${kind} list in force over those dates. ` +
        `Two defaults at once would make "the list used when a party has no list" a question with two answers — ` +
        `close the old one first, or tick the box that closes it the day before this one starts.`,
      );
    }
    throw e;
  }
}

async function listByCode(orgId: string, entityId: string, code: string) {
  const list = await prisma.priceList.findFirst({
    where: { orgId, entityId, code: code.trim().toUpperCase() },
  });
  if (!list) throw new LedgerError(`There is no price list ${code.trim().toUpperCase()}.`);
  return list;
}

export interface NewPrice {
  itemCode: string;
  unitPriceMinor: number | bigint | string;
  /** The quantity from which this row applies, in thousandths. Nought is the base price. */
  minQuantityMilli?: number | bigint | string;
  discountBps?: number;
  validFrom?: Date | string;
  validTo?: Date | string | null;
}

/**
 * Put prices on a list.
 *
 * An overlap is refused by the database rather than by a check here, because a
 * check would be racing: two people entering a price rise at the same moment
 * would both find nothing in their way. The message translates the exclusion
 * violation into what actually happened, which is that the old price was never
 * closed.
 */
export async function setPrices(opts: {
  orgId: string; entityId: string; listCode: string; prices: NewPrice[];
}) {
  const list = await listByCode(opts.orgId, opts.entityId, opts.listCode);
  if (!opts.prices.length) throw new LedgerError("There are no prices to set.");

  const rows = opts.prices.map((p, i) => {
    const itemCode = p.itemCode.trim();
    if (!itemCode) throw new LedgerError(`Price ${i + 1} does not say which item it is for.`);
    const unitPriceMinor = minor(p.unitPriceMinor, `Price ${i + 1}`);
    if (unitPriceMinor < 0n) {
      throw new LedgerError(`Price ${i + 1} is negative. A negative price is a credit, and a credit is a different document.`);
    }
    const minQuantityMilli = p.minQuantityMilli === undefined ? 0n : minor(p.minQuantityMilli, `Price ${i + 1} quantity break`);
    if (minQuantityMilli < 0n) throw new LedgerError(`Price ${i + 1} breaks at a negative quantity.`);
    const discountBps = p.discountBps ?? 0;
    if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10_000) {
      throw new LedgerError(`Price ${i + 1} has a discount outside nought and a hundred per cent.`);
    }
    const validFrom = p.validFrom ? asDate(p.validFrom, `Price ${i + 1} start`) : list.validFrom;
    const validTo = p.validTo ? asDate(p.validTo, `Price ${i + 1} end`) : null;
    if (validTo && validTo < validFrom) throw new LedgerError(`Price ${i + 1} ends before it starts.`);
    if (validFrom < list.validFrom) {
      throw new LedgerError(
        `Price ${i + 1} starts on ${iso(validFrom)}, before the list itself does on ${iso(list.validFrom)}. ` +
        `A price on a list that is not yet in force prices nothing.`,
      );
    }
    return {
      orgId: opts.orgId, priceListId: list.id, itemCode,
      unitPriceMinor, minQuantityMilli, discountBps, validFrom, validTo,
    };
  });

  try {
    await prisma.priceListEntry.createMany({ data: rows });
  } catch (e) {
    if (isOverlap(e)) {
      throw new LedgerError(
        `That price overlaps one already on ${list.code} for the same item and quantity break. ` +
        `A price rise entered without closing the old row leaves both live, and then what the item ` +
        `costs depends on which row is read first. Close the old price to the day before the new one starts.`,
      );
    }
    throw e;
  }

  return { listCode: list.code, added: rows.length };
}

/** End a price so a successor can start. Prices are closed, never deleted — a quote raised under it stays explicable. */
export async function closePrice(opts: {
  orgId: string; entityId: string; entryId: string; validTo: Date | string;
}) {
  const row = await prisma.priceListEntry.findFirst({
    where: { id: opts.entryId, orgId: opts.orgId },
  });
  if (!row) throw new LedgerError("There is no such price.");
  const validTo = asDate(opts.validTo, "The date the price ends");
  if (validTo < row.validFrom) throw new LedgerError("A price cannot end before it starts.");
  return prisma.priceListEntry.update({ where: { id: row.id }, data: { validTo } });
}

/**
 * End a price list.
 *
 * A list could be superseded — put a successor in and the old one closes to
 * the day before — and there was no way to simply stop one. A business that
 * withdraws a promotional list at the end of a month and has nothing to put in
 * its place had two options: leave it in force, or delete it. Deleting it takes
 * the prices with it, and then a quote raised last week cannot be explained.
 *
 * So a list is closed, never deleted, the same as a price. Its entries stay
 * exactly where they are: `resolvePrice` reads the LIST's validity as well as
 * the entry's, so closing the list is enough to stop it pricing anything, and
 * the rows are still there to explain a document raised while it was in force.
 */
export async function closePriceList(opts: {
  orgId: string; entityId: string; listCode: string; validTo: Date | string;
}) {
  const list = await listByCode(opts.orgId, opts.entityId, opts.listCode);
  const validTo = asDate(opts.validTo, "The date the list ends");
  if (validTo < list.validFrom) {
    throw new LedgerError(
      `${list.code} starts on ${iso(list.validFrom)} and cannot end on ${iso(validTo)}. A list that ended before ` +
      `it began never priced anything, so what is wanted is to withdraw it, not to close it.`,
    );
  }
  if (list.validTo && list.validTo <= validTo) {
    throw new LedgerError(
      `${list.code} already ended on ${iso(list.validTo)}. Extending a list that has closed would put prices back ` +
      `in force for days that have already been quoted and invoiced under whatever replaced it.`,
    );
  }
  return prisma.priceList.update({ where: { id: list.id }, data: { validTo } });
}

export async function assignPriceList(opts: {
  orgId: string; entityId: string; partyKey: string; listCode: string;
}) {
  const list = await listByCode(opts.orgId, opts.entityId, opts.listCode);
  const partyKey = partyKeyOf(opts.partyKey);
  if (!partyKey) throw new LedgerError("Which party?");

  const already = await prisma.priceListAssignment.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, partyKey },
    select: { priceListId: true },
  });
  const others = already.filter((a) => a.priceListId !== list.id);
  if (others.length) {
    const lists = await prisma.priceList.findMany({
      where: { id: { in: others.map((o) => o.priceListId) } },
      select: { code: true, kind: true },
    });
    const clash = lists.find((l) => l.kind === list.kind);
    if (clash) {
      throw new LedgerError(
        `That party is already priced from ${clash.code}. One party, one ${list.kind.toLowerCase()} list — ` +
        `two would price the same item two ways.`,
      );
    }
  }

  return prisma.priceListAssignment.upsert({
    where: {
      orgId_entityId_partyKey_priceListId: {
        orgId: opts.orgId, entityId: opts.entityId, partyKey, priceListId: list.id,
      },
    },
    create: { orgId: opts.orgId, entityId: opts.entityId, partyKey, priceListId: list.id },
    update: {},
  });
}

export async function unassignPriceList(opts: {
  orgId: string; entityId: string; partyKey: string; listCode: string;
}) {
  const list = await listByCode(opts.orgId, opts.entityId, opts.listCode);
  const { count } = await prisma.priceListAssignment.deleteMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      partyKey: partyKeyOf(opts.partyKey), priceListId: list.id,
    },
  });
  if (!count) throw new LedgerError("That party was not priced from that list.");
  return { removed: count };
}

/* ----------------------------------------------------------- the resolution */

export interface PriceQuote {
  itemCode: string;
  found: boolean;
  unitPriceMinor: bigint;
  discountBps: number;
  quantityMilli: bigint;
  /** The line, rounded once — not the unit price rounded and then extended. */
  netMinor: bigint;
  currency: string;
  source: {
    listCode: string;
    listName: string;
    entryId: string;
    minQuantityMilli: bigint;
    validFrom: string;
    validTo: string | null;
    /** True when the list is the party's own rather than the default. */
    assigned: boolean;
  } | null;
  /** What the default list would have charged, where the party has a list of its own. */
  defaultUnitPriceMinor: bigint | null;
  why: string;
}

/**
 * What does this item cost this party, in this quantity, on this date?
 *
 * Most specific wins, in this order and no other: the party's own list before
 * the default list, and within a list the highest quantity break the quantity
 * actually reaches. A break at a quantity above what is being bought does not
 * apply — that is the whole point of a break — and the resolver says so rather
 * than falling back silently to a base price that may not exist.
 */
export async function resolvePrice(opts: {
  orgId: string; entityId: string; itemCode: string;
  quantityMilli?: number | bigint | string;
  partyKey?: string | null;
  on?: Date | string;
  currency?: string;
  kind?: ListKind;
}): Promise<PriceQuote> {
  const quotes = await quoteLines({
    orgId: opts.orgId, entityId: opts.entityId, on: opts.on,
    partyKey: opts.partyKey, currency: opts.currency, kind: opts.kind,
    lines: [{ itemCode: opts.itemCode, quantityMilli: opts.quantityMilli }],
  });
  return quotes[0];
}

/**
 * The same resolution for a whole document, in one pass over the lists.
 *
 * A hundred-line quote resolving a hundred times would issue a hundred pairs
 * of queries, and the screen that offered to price a whole order would be the
 * slowest screen in the product.
 */
export async function quoteLines(opts: {
  orgId: string; entityId: string;
  lines: { itemCode: string; quantityMilli?: number | bigint | string }[];
  partyKey?: string | null;
  on?: Date | string;
  currency?: string;
  kind?: ListKind;
}): Promise<PriceQuote[]> {
  const on = opts.on ? asDate(opts.on, "The date") : new Date(iso(new Date()) + "T00:00:00.000Z");
  const kind: ListKind = opts.kind ?? "SELL";
  const currency = (opts.currency ?? "AED").trim().toUpperCase();
  const partyKey = opts.partyKey ? partyKeyOf(opts.partyKey) : null;

  const candidates = await prisma.priceList.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, kind },
  });
  const live = candidates.filter((l) => inForce(l.validFrom, l.validTo, on));

  const assignments = partyKey
    ? await prisma.priceListAssignment.findMany({
        where: { orgId: opts.orgId, entityId: opts.entityId, partyKey },
        select: { priceListId: true },
      })
    : [];
  const assignedIds = new Set(assignments.map((a) => a.priceListId));

  const own = live.find((l) => assignedIds.has(l.id)) ?? null;
  const fallback = live.find((l) => l.isDefault) ?? null;

  // The order the resolver tries, most specific first.
  const order = [own, fallback].filter((l): l is NonNullable<typeof l> => l !== null);

  const itemCodes = [...new Set(opts.lines.map((l) => l.itemCode.trim()))];
  const entries = order.length
    ? await prisma.priceListEntry.findMany({
        where: { orgId: opts.orgId, priceListId: { in: order.map((l) => l.id) }, itemCode: { in: itemCodes } },
        orderBy: { minQuantityMilli: "desc" },
      })
    : [];

  return opts.lines.map((line) => {
    const itemCode = line.itemCode.trim();
    const quantityMilli = line.quantityMilli === undefined ? MILLI : minor(line.quantityMilli, "The quantity");
    const nil: PriceQuote = {
      itemCode, found: false, unitPriceMinor: 0n, discountBps: 0, quantityMilli,
      netMinor: 0n, currency, source: null, defaultUnitPriceMinor: null, why: "",
    };

    if (!order.length) {
      return { ...nil, why: `No ${kind.toLowerCase()} price list is in force on ${iso(on)}.` };
    }

    const pick = (listId: string) =>
      entries.find(
        (e) => e.priceListId === listId && e.itemCode === itemCode &&
          e.minQuantityMilli <= quantityMilli && inForce(e.validFrom, e.validTo, on),
      ) ?? null;

    const fromDefault = fallback ? pick(fallback.id) : null;
    const defaultUnitPriceMinor = fromDefault ? fromDefault.unitPriceMinor : null;

    for (const list of order) {
      const assigned = own !== null && list.id === own.id;

      if (list.currency !== currency) {
        // Deliberately not converted. Which rate — the day's, the month's, the
        // one written into the contract? Any answer chosen here puts an
        // exchange difference inside the selling price.
        return {
          ...nil,
          defaultUnitPriceMinor,
          why:
            `${list.code} prices in ${list.currency} and this document is in ${currency}. ` +
            `The list is not converted: an exchange rate chosen here would end up inside the selling price, ` +
            `where nobody would find it. Price the item on a ${currency} list, or enter the price by hand.`,
        };
      }

      const hit = pick(list.id);
      if (!hit) {
        const breaks = entries.filter(
          (e) => e.priceListId === list.id && e.itemCode === itemCode && inForce(e.validFrom, e.validTo, on),
        );
        if (breaks.length) {
          const lowest = breaks.reduce((a, b) => (b.minQuantityMilli < a.minQuantityMilli ? b : a));
          return {
            ...nil,
            defaultUnitPriceMinor,
            why:
              `${list.code} prices ${itemCode} only from ${Number(lowest.minQuantityMilli) / 1000} units. ` +
              `A quantity break above what is being bought does not apply.`,
          };
        }
        continue;
      }

      const netMinor = lineNet(hit.unitPriceMinor, quantityMilli, hit.discountBps);
      const breakNote = hit.minQuantityMilli > 0n
        ? ` at the break from ${Number(hit.minQuantityMilli) / 1000} units`
        : "";
      const discountNote = hit.discountBps > 0
        ? `, less ${(hit.discountBps / 100).toFixed(2).replace(/\.?0+$/, "")}% carried by the list`
        : "";
      return {
        itemCode, found: true,
        unitPriceMinor: hit.unitPriceMinor,
        discountBps: hit.discountBps,
        quantityMilli, netMinor, currency,
        source: {
          listCode: list.code, listName: list.name, entryId: hit.id,
          minQuantityMilli: hit.minQuantityMilli,
          validFrom: iso(hit.validFrom),
          validTo: hit.validTo ? iso(hit.validTo) : null,
          assigned,
        },
        defaultUnitPriceMinor,
        why:
          `${assigned ? "The party's own list" : "The default list"} ${list.code}${breakNote}${discountNote}.`,
      };
    }

    return {
      ...nil,
      defaultUnitPriceMinor,
      why: `Neither ${order.map((l) => l.code).join(" nor ")} prices ${itemCode} on ${iso(on)}.`,
    };
  });
}

/* ------------------------------------------------------------- the variance */

export interface VarianceLine {
  itemCode: string;
  quantityMilli: bigint;
  chargedMinor: bigint;
  listMinor: bigint | null;
  varianceMinor: bigint;
  varianceBps: number | null;
  why: string;
}

/**
 * What was charged against what the list says, line by line.
 *
 * This is the report the list exists for. A discount nobody recorded as a
 * discount is invisible in the accounts — it shows up only as revenue that was
 * lower than expected, months later, with no way of telling which customer or
 * which salesperson it went to. Measuring the document against the list turns
 * that into a number.
 *
 * A line the list does not price has no variance. It is not nil per cent off;
 * it is a price nobody has an opinion about, and reporting it as nought would
 * bury the real discounts in a column of zeroes.
 */
export async function priceVariance(opts: {
  orgId: string; entityId: string;
  partyKey?: string | null;
  on?: Date | string;
  currency?: string;
  kind?: ListKind;
  lines: { itemCode: string; quantityMilli: number | bigint | string; chargedMinor: number | bigint | string }[];
}) {
  const quotes = await quoteLines({
    orgId: opts.orgId, entityId: opts.entityId, partyKey: opts.partyKey,
    on: opts.on, currency: opts.currency, kind: opts.kind,
    lines: opts.lines.map((l) => ({ itemCode: l.itemCode, quantityMilli: l.quantityMilli })),
  });

  const rows: VarianceLine[] = opts.lines.map((l, i) => {
    const q = quotes[i];
    const charged = minor(l.chargedMinor, `Line ${i + 1}`);
    const listMinor = q.found ? q.netMinor : null;
    const varianceMinor = listMinor === null ? 0n : charged - listMinor;
    return {
      itemCode: q.itemCode,
      quantityMilli: q.quantityMilli,
      chargedMinor: charged,
      listMinor,
      varianceMinor,
      varianceBps:
        listMinor === null || listMinor === 0n
          ? null
          : Number((varianceMinor * BPS) / listMinor),
      why: q.why,
    };
  });

  const priced = rows.filter((r) => r.listMinor !== null);
  const chargedTotal = priced.reduce((a, r) => a + r.chargedMinor, 0n);
  const listTotal = priced.reduce((a, r) => a + (r.listMinor ?? 0n), 0n);

  return {
    lines: rows,
    totals: {
      /** Only the lines the list has an opinion about are totalled — mixing in the rest would understate the discount. */
      pricedLines: priced.length,
      unpricedLines: rows.length - priced.length,
      chargedMinor: chargedTotal,
      listMinor: listTotal,
      varianceMinor: chargedTotal - listTotal,
      varianceBps: listTotal === 0n ? null : Number(((chargedTotal - listTotal) * BPS) / listTotal),
    },
  };
}

/* ----------------------------------------------------------------- the screen */

/**
 * The most prices one read will list.
 *
 * The filter is pushed into the query rather than applied to the page after
 * it: filtering in memory means the rows shown for a list are whichever of its
 * rows happened to fall inside the first page of every list's rows, sorted by
 * item code, which is nobody's idea of "the prices on this list".
 */
const MAX_PRICES = 2000;

export async function priceListRegister(opts: {
  orgId: string; entityId: string; on?: Date | string; listCode?: string;
}) {
  const on = opts.on ? asDate(opts.on, "The date") : new Date(iso(new Date()) + "T00:00:00.000Z");

  const lists = await prisma.priceList.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: [{ kind: "asc" }, { code: "asc" }],
  });
  const listIds = lists.map((l) => l.id);

  /* A list code that names nothing is a mistake, not a request for everything.
   * Falling back to every list's prices answers a question nobody asked: the
   * caller gets rows from lists they did not name, and nothing in the reply
   * says the filter was dropped, so a typo in an integration reads as "that
   * list holds all of these prices". The screen only ever sends a code it read
   * from this same reply; an API caller is the one who hits it. */
  const wanted = opts.listCode?.trim().toUpperCase() || null;
  const chosen = wanted ? lists.find((l) => l.code === wanted) ?? null : null;
  if (wanted && !chosen) throw new LedgerError(`There is no price list ${wanted}.`);

  // In force on the day, expressed as a where clause so the count is the
  // database's rather than a filter over whatever was read.
  const liveOn = { validFrom: { lte: on }, OR: [{ validTo: null }, { validTo: { gte: on } }] };

  const [totalCounts, liveCounts, partyCounts] = await Promise.all([
    prisma.priceListEntry.groupBy({
      by: ["priceListId"],
      where: { orgId: opts.orgId, priceListId: { in: listIds } },
      _count: { _all: true },
    }),
    prisma.priceListEntry.groupBy({
      by: ["priceListId"],
      where: { orgId: opts.orgId, priceListId: { in: listIds }, ...liveOn },
      _count: { _all: true },
    }),
    prisma.priceListAssignment.groupBy({
      by: ["priceListId"],
      where: { orgId: opts.orgId, entityId: opts.entityId },
      _count: { _all: true },
    }),
  ]);
  const countIn = (rows: { priceListId: string; _count: { _all: number } }[], id: string) =>
    rows.find((r) => r.priceListId === id)?._count._all ?? 0;

  const page = listIds.length
    ? await prisma.priceListEntry.findMany({
        where: {
          orgId: opts.orgId,
          priceListId: chosen ? chosen.id : { in: listIds },
        },
        orderBy: [{ itemCode: "asc" }, { minQuantityMilli: "asc" }, { validFrom: "asc" }],
        take: MAX_PRICES + 1,
      })
    : [];
  const truncated = page.length > MAX_PRICES;
  const entries = truncated ? page.slice(0, MAX_PRICES) : page;

  const assignments = await prisma.priceListAssignment.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { partyKey: "asc" },
  });

  const byList = new Map(lists.map((l) => [l.id, l]));

  return {
    on: iso(on),
    /** True when more prices matched than were listed. Every count below is still the whole count. */
    truncated,
    listed: entries.length,
    lists: lists.map((l) => ({
      code: l.code, name: l.name, currency: l.currency, kind: l.kind,
      isDefault: l.isDefault,
      validFrom: iso(l.validFrom),
      validTo: l.validTo ? iso(l.validTo) : null,
      inForce: inForce(l.validFrom, l.validTo, on),
      notes: l.notes,
      priceCount: countIn(totalCounts, l.id),
      livePriceCount: countIn(liveCounts, l.id),
      partyCount: countIn(partyCounts, l.id),
    })),
    prices: entries.map((e) => ({
      id: e.id,
      listCode: byList.get(e.priceListId)?.code ?? "",
      currency: byList.get(e.priceListId)?.currency ?? "AED",
      itemCode: e.itemCode,
      minQuantityMilli: e.minQuantityMilli,
      unitPriceMinor: e.unitPriceMinor,
      discountBps: e.discountBps,
      validFrom: iso(e.validFrom),
      validTo: e.validTo ? iso(e.validTo) : null,
      inForce: inForce(e.validFrom, e.validTo, on),
    })),
    parties: assignments.map((a) => ({
      partyKey: a.partyKey,
      listCode: byList.get(a.priceListId)?.code ?? "",
      kind: byList.get(a.priceListId)?.kind ?? "SELL",
    })),
    /**
     * A list with no default behind it prices only the parties assigned to it.
     * That is a legitimate arrangement and a common mistake, so it is stated
     * rather than left for somebody to notice from an empty quote.
     *
     * Both counts come from the groupBy above rather than from the listed
     * page: said of a list whose prices fell outside the page, "prices
     * nothing" is not a warning, it is a false statement.
     */
    findings: [
      ...(lists.some((l) => l.kind === "SELL" && l.isDefault && inForce(l.validFrom, l.validTo, on))
        ? []
        : ["No default sell list is in force. Any party without a list of its own will not be priced."]),
      ...lists
        .filter((l) => inForce(l.validFrom, l.validTo, on) && !l.isDefault && countIn(partyCounts, l.id) === 0)
        .map((l) => `${l.code} is in force but no party is priced from it.`),
      ...lists
        .filter((l) => inForce(l.validFrom, l.validTo, on) && countIn(liveCounts, l.id) === 0)
        .map((l) => `${l.code} is in force and prices nothing on ${iso(on)}.`),
    ],
  };
}
