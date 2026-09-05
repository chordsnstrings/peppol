import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { post, LedgerError } from "./post";
import { capitaliseCost, receiptsUnder, type ReceiptLot } from "./inventory";

/**
 * Landed cost — freight, insurance, customs duty and handling carried onto the
 * goods they brought in.
 *
 * IAS 2.10: the cost of inventories comprises the purchase price, import duties
 * and other non-recoverable taxes, transport, handling and other costs directly
 * attributable to the acquisition of the goods, less trade discounts and
 * rebates. IAS 2.11 adds that those charges are net of anything recoverable, so
 * recoverable input VAT never reaches this module — it is not a cost of the
 * goods, it is a receivable from the FTA.
 *
 * Until this existed the product expensed the freight invoice. That is wrong in
 * both directions across a period end: inventory is understated and cost of
 * sales overstated in the month the container lands, and the month the goods
 * are finally sold is flattered by exactly the same amount. The error is
 * largest when stock is largest, which for most importers is the year end, and
 * it is invisible — the freight sits in a cost-of-sales account looking
 * entirely ordinary, and nothing anywhere records which goods it belonged to.
 *
 * Four opinions, stated because they are opinions.
 *
 *  - **The basis belongs to the charge, not to the voucher.** Freight is
 *    charged by weight or by volume and duty is charged on value, so one basis
 *    for a whole voucher is wrong for at least one charge on it. A product that
 *    offers a single basis is inviting its user to be wrong quietly.
 *
 *  - **A missing weight is refused, never read as nought.** An item with no
 *    weight recorded would take no share of the freight, so every other item
 *    would carry its share — the goods that cannot be measured get in free, at
 *    the expense of the ones that can. The refusal names the items, because
 *    "some item somewhere has no weight" is not something anybody can act on.
 *
 *  - **The allocation adds to the charge exactly.** Largest-remainder, so AED
 *    1,000 across three equal items is 333.34, 333.33, 333.33 rather than three
 *    times 333.33 and a fil nobody owns. A residue left over would have to go
 *    somewhere, and everywhere it could go is a lie about something.
 *
 *  - **Goods already sold do not come back to absorb their share.** That is the
 *    hard one, and it is answered in `splitAlreadySold` below.
 *
 * Money is minor units, quantities are thousandths, weights are grams and
 * volumes are litres — all integers, none of them ever a float.
 */

const MILLI = 1000n;

/** How a charge is spread over the goods it applied to. */
export const ALLOCATION_BASES = ["VALUE", "QUANTITY", "WEIGHT", "VOLUME"] as const;
export type AllocationBasis = (typeof ALLOCATION_BASES)[number];

export const BASIS_LABEL: Record<AllocationBasis, string> = {
  VALUE: "value of the goods",
  QUANTITY: "quantity received",
  WEIGHT: "shipped weight",
  VOLUME: "shipped volume",
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

/** Thousandths as a figure somebody would write on a note. */
export function fmtQty(milli: bigint): string {
  const neg = milli < 0n;
  const s = (neg ? -milli : milli).toString().padStart(4, "0");
  const body = `${s.slice(0, -3)}.${s.slice(-3)}`.replace(/\.?0+$/, "");
  return `${neg ? "-" : ""}${body || "0"}`;
}

/**
 * Minor units as a figure a bookkeeper would recognise in a refusal, in the
 * currency of the book the voucher sits in. `fmtMinor` knows each currency's
 * exponent; splitting the digits two from the right is right for a dirham and
 * wrong by a factor of ten for a Kuwaiti or Bahraini dinar or an Omani rial.
 */
const fmtMoneyIn = (currency: string) => (minor: bigint) =>
  fmtMinor(minor, currency, { sign: "minus", zero: "zero" });

/** The currency this entity keeps its books in. */
async function bookCurrency(orgId: string, entityId: string): Promise<string> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  return book?.functionalCurrency ?? "AED";
}

function readBasis(value: string | undefined | null): AllocationBasis {
  if (!value?.trim()) return "VALUE";
  const b = value.trim().toUpperCase();
  if ((ALLOCATION_BASES as readonly string[]).includes(b)) return b as AllocationBasis;
  throw new LedgerError(
    `"${value}" is not a way of spreading a charge. A charge follows ${ALLOCATION_BASES.join(", ")} — ` +
      `freight usually by weight or volume, duty by value.`,
  );
}

function amountOf(v: number | bigint | string, what: string): bigint {
  try {
    const b = typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.round(v) : String(v).trim());
    if (b <= 0n) throw new Error();
    return b;
  } catch {
    throw new LedgerError(`${what} has to be a figure above nothing, in whole minor units.`);
  }
}

function onDate(v: string | Date | undefined | null, what: string): Date {
  if (!v) throw new LedgerError(`${what} needs a date.`);
  const d = typeof v === "string" ? day(v) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} needs a date I can read, not "${String(v)}".`);
  return d;
}

/* ================================================================ arithmetic */

/**
 * Largest-remainder allocation: split a total across weights so that the shares
 * add back to the total exactly.
 *
 * Every share is floored first, which always leaves a residue of fewer units
 * than there are shares. Those units go to the shares whose exact answer was
 * furthest above its floor — the ones most nearly entitled to the next fil.
 * Ties fall to the larger weight and then to the earlier line, so the same
 * inputs always give the same answer and a voucher recomputed a year later
 * agrees with the entry that was posted.
 *
 * Handing the whole residue to the largest weight would be simpler, and is what
 * this codebase does where the residue is a rounding artefact of a derived
 * figure. Here the shares are the answer, so a systematic bias towards the
 * biggest line would be a systematic misstatement of that line's cost.
 *
 * No share is ever negative: the total cannot be negative and the weights
 * cannot be, so every floor is at nil or above and the residue only ever adds.
 */
export function largestRemainder(totalMinor: bigint, weights: bigint[]): bigint[] {
  if (!weights.length) return [];
  if (totalMinor < 0n) throw new LedgerError("A charge being spread cannot be negative.");
  for (const w of weights) {
    if (w < 0n) throw new LedgerError("A charge cannot be spread on a negative weight.");
  }
  const sum = weights.reduce((a, w) => a + w, 0n);
  if (sum === 0n) {
    throw new LedgerError(
      "Every one of these goods measures nothing on the basis the charge is spread by, so there is nothing to " +
        "spread it over. Pick a basis the goods actually have.",
    );
  }
  if (totalMinor === 0n) return weights.map(() => 0n);

  const shares = weights.map((w) => (totalMinor * w) / sum);
  const remainders = weights.map((w, i) => totalMinor * w - shares[i] * sum);
  let residue = totalMinor - shares.reduce((a, s) => a + s, 0n);

  const order = weights
    .map((_, i) => i)
    .sort((a, b) =>
      remainders[b] > remainders[a] ? 1
        : remainders[b] < remainders[a] ? -1
          : weights[b] > weights[a] ? 1
            : weights[b] < weights[a] ? -1
              : a - b);

  for (const i of order) {
    if (residue <= 0n) break;
    shares[i] += 1n;
    residue -= 1n;
  }
  return shares;
}

/** One lot of goods, as much of it as the allocation needs to know. */
export interface AllocatableLine {
  sku: string;
  /** What came in, and what it cost before anything was landed on it. */
  quantityMilli: bigint;
  valueMinor: bigint;
  /** How much of that is still on the shelf. */
  onHandMilli: bigint;
  /** Grams and litres for the whole lot. Nil where none is recorded. */
  weightMilli: bigint | null;
  volumeMilli: bigint | null;
}

export interface AllocatableCharge {
  description: string;
  amountMinor: bigint;
  basis: AllocationBasis;
}

export interface ChargeShare {
  basisWeight: bigint;
  allocatedMinor: bigint;
  inventoryMinor: bigint;
  cogsMinor: bigint;
}

export interface LineSplit {
  allocatedMinor: bigint;
  inventoryMinor: bigint;
  cogsMinor: bigint;
}

export interface Spread {
  /** shares[chargeIndex][lineIndex] */
  shares: ChargeShare[][];
  lines: LineSplit[];
  totals: { chargeMinor: bigint; inventoryMinor: bigint; cogsMinor: bigint };
}

function basisWeights(basis: AllocationBasis, lines: AllocatableLine[]): bigint[] {
  if (basis === "VALUE") return lines.map((l) => l.valueMinor);
  if (basis === "QUANTITY") return lines.map((l) => l.quantityMilli);
  const pick = (l: AllocatableLine) => (basis === "WEIGHT" ? l.weightMilli : l.volumeMilli);
  const missing = [...new Set(lines.filter((l) => pick(l) === null || pick(l) === 0n).map((l) => l.sku))];
  if (missing.length) {
    throw new LedgerError(
      `That charge is spread by ${BASIS_LABEL[basis]}, and ${missing.join(", ")} ` +
        `${missing.length === 1 ? "has" : "have"} none recorded. Reading a missing measure as nothing would ` +
        `give those goods a free ride at the expense of everything else on the shipment.`,
    );
  }
  return lines.map((l) => pick(l)!);
}

/**
 * What happens to the share belonging to goods that have already been sold.
 *
 * If 60 of 100 units went out before the freight invoice arrived, only 40 are
 * left to carry the cost. There are two defensible answers and one indefensible
 * one, and the indefensible one is the easy one.
 *
 *   1. Put the whole charge on the 40 that remain. Easy, and wrong: those 40
 *      units did not cost that much. Their carrying amount would be inflated by
 *      the freight of goods that are no longer there, which overstates the
 *      balance sheet now and understates the margin of whoever buys them later.
 *      IAS 2.10 measures the cost of *these* goods, not of the consignment.
 *   2. Restate the cost of sales already posted. Right in principle, and the
 *      product will not do it: it means reaching back into postings that have
 *      been reported, in periods that may be closed, to change the cost of
 *      sales of a month somebody has already signed off.
 *   3. Charge the sold units' share to cost of sales now. This is what happens
 *      here.
 *
 * Answer 3 is right for the reason answer 1 is wrong. The 60 units are not
 * inventories any more — they were derecognised when they were issued, and
 * IAS 2.34 recognises the carrying amount of inventories sold as an expense in
 * the period the related revenue is recognised. Their freight is an expense of
 * the business whichever way it is routed; the only question is whether it
 * arrives as cost of sales, where the rest of their cost already went, or hides
 * on the balance sheet inside the 40 units that are left.
 *
 * The period is the honest weakness, and it is stated rather than papered over:
 * the sold units' share lands in the period the voucher is applied, not in the
 * period they were sold. Where those are the same period — the ordinary case,
 * because a freight invoice follows its container by days rather than by
 * quarters — the accounts are exactly right. Where they are not, the timing is
 * out by the lag and the amount is not. A restatement would fix the timing at
 * the cost of reopening closed periods, and that is not a trade worth making
 * for the freight on goods already sold.
 *
 * Multiplication before division, floored once: the part still on the shelf is
 * computed and the remainder is what is expensed, so the two always add back to
 * the share exactly and the entry balances by construction.
 */
function splitAlreadySold(allocatedMinor: bigint, onHandMilli: bigint, receivedMilli: bigint): LineSplit {
  if (receivedMilli <= 0n || onHandMilli <= 0n) {
    return { allocatedMinor, inventoryMinor: 0n, cogsMinor: allocatedMinor };
  }
  const held = onHandMilli >= receivedMilli ? receivedMilli : onHandMilli;
  const inventoryMinor = (allocatedMinor * held) / receivedMilli;
  return { allocatedMinor, inventoryMinor, cogsMinor: allocatedMinor - inventoryMinor };
}

/**
 * Spread every charge over every lot, and split each lot's total between the
 * stock still held and the stock already sold.
 *
 * The split is decided once per lot, on that lot's whole share, and only then
 * shared back out over the charges that made it up — so the rounding happens
 * once rather than once per charge, and the per-charge figures still add to the
 * lot's figures and to the charges' totals exactly.
 */
export function spreadCharges(charges: AllocatableCharge[], lines: AllocatableLine[]): Spread {
  if (!charges.length) throw new LedgerError("A landed cost voucher with no charges on it carries nothing.");
  if (!lines.length) throw new LedgerError("A landed cost voucher has to name the goods the charges are carried onto.");

  const weights = charges.map((c) => basisWeights(c.basis, lines));
  const allocated = charges.map((c, ci) => largestRemainder(c.amountMinor, weights[ci]));

  const splits = lines.map((l, li) => {
    const total = allocated.reduce((a, row) => a + row[li], 0n);
    return splitAlreadySold(total, l.onHandMilli, l.quantityMilli);
  });

  const shares: ChargeShare[][] = charges.map(() => []);
  for (let li = 0; li < lines.length; li++) {
    const byCharge = charges.map((_, ci) => allocated[ci][li]);
    // The lot's inventory portion, shared back over the charges that made it
    // up. A lot allocated nothing has nothing to share, and largest-remainder
    // refuses a nil total weight rather than pretending it has an answer.
    const inv = splits[li].allocatedMinor === 0n
      ? byCharge.map(() => 0n)
      : largestRemainder(splits[li].inventoryMinor, byCharge);
    for (let ci = 0; ci < charges.length; ci++) {
      shares[ci].push({
        basisWeight: weights[ci][li],
        allocatedMinor: byCharge[ci],
        inventoryMinor: inv[ci],
        cogsMinor: byCharge[ci] - inv[ci],
      });
    }
  }

  return {
    shares,
    lines: splits,
    totals: {
      chargeMinor: charges.reduce((a, c) => a + c.amountMinor, 0n),
      inventoryMinor: splits.reduce((a, s) => a + s.inventoryMinor, 0n),
      cogsMinor: splits.reduce((a, s) => a + s.cogsMinor, 0n),
    },
  };
}

/* =========================================== what a unit weighs and displaces */

/**
 * Record what one unit of an item weighs and how much room it takes up.
 *
 * Grams and litres per whole unit, in thousandths like every other quantity
 * here, so 2.5 kg is 2500000 and half a litre is 500. Neither is a fact about a
 * transaction, so neither is asked for on a voucher: they are facts about the
 * item, recorded once and used by every shipment it ever appears on.
 */
export async function recordMeasure(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  /** Grams per whole unit, in thousandths. Nil clears it. */
  unitWeightMilli?: number | bigint | string | null;
  /** Litres per whole unit, in thousandths. Nil clears it. */
  unitVolumeMilli?: number | bigint | string | null;
}) {
  const item = await prisma.inventoryItem.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, sku: opts.sku?.trim() },
  });
  if (!item) throw new LedgerError(`SKU ${opts.sku} is not on the item list.`);

  const read = (v: number | bigint | string | null | undefined, what: string): bigint | null =>
    v === null || v === undefined || v === "" ? null : amountOf(v, `The ${what} of one ${item.sku}`);

  const unitWeightMilli = read(opts.unitWeightMilli, "weight");
  const unitVolumeMilli = read(opts.unitVolumeMilli, "volume");

  const row = await prisma.landedCostMeasure.upsert({
    where: { orgId_entityId_itemId: { orgId: opts.orgId, entityId: opts.entityId, itemId: item.id } },
    create: {
      orgId: opts.orgId, entityId: opts.entityId, itemId: item.id, sku: item.sku,
      unitWeightMilli, unitVolumeMilli,
    },
    update: { unitWeightMilli, unitVolumeMilli },
  });

  return {
    sku: row.sku,
    unitWeightMilli: row.unitWeightMilli?.toString() ?? null,
    unitVolumeMilli: row.unitVolumeMilli?.toString() ?? null,
  };
}

/** Every item and what is known about its weight, for the screen that fills the gaps. */
export async function measureList(opts: { orgId: string; entityId: string }) {
  const [items, measures] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, status: "active" },
      orderBy: { sku: "asc" },
      select: { id: true, sku: true, name: true, uom: true },
    }),
    prisma.landedCostMeasure.findMany({ where: { orgId: opts.orgId, entityId: opts.entityId } }),
  ]);
  const by = new Map(measures.map((m) => [m.itemId, m]));
  return {
    items: items.map((i) => ({
      sku: i.sku,
      name: i.name,
      uom: i.uom,
      unitWeightMilli: by.get(i.id)?.unitWeightMilli?.toString() ?? null,
      unitVolumeMilli: by.get(i.id)?.unitVolumeMilli?.toString() ?? null,
    })),
  };
}

/* ================================================================== vouchers */

export interface NewCharge {
  description: string;
  amountMinor: number | bigint | string;
  /** The account the charge is sitting in now — usually 5200. */
  accountCode: string;
  /** VALUE | QUANTITY | WEIGHT | VOLUME. Value where nobody says. */
  basis?: string;
}

export interface NewVoucher {
  number: string;
  /** The shipment, container or bill of lading these charges belong to. */
  shipmentRef: string;
  voucherDate: string;
  notes?: string;
  charges: NewCharge[];
  /** The goods received notes the charges are carried onto. */
  receipts: string[];
}

function findVoucher(orgId: string, entityId: string, number: string) {
  return prisma.landedCostVoucher.findFirst({
    where: { orgId, entityId, number: number.trim() },
    include: {
      charges: { orderBy: { lineNo: "asc" } },
      lines: { orderBy: { lineNo: "asc" } },
      allocations: true,
    },
  });
}

type VoucherRow = NonNullable<Awaited<ReturnType<typeof findVoucher>>>;

async function loadVoucher(orgId: string, entityId: string, number: string): Promise<VoucherRow> {
  if (!number?.trim()) throw new LedgerError("Which landed cost voucher?");
  const v = await findVoucher(orgId, entityId, number);
  if (!v) throw new LedgerError(`There is no landed cost voucher ${number}.`);
  return v;
}

/**
 * Raise a landed cost voucher.
 *
 * Nothing is posted and nothing moves. The voucher is a document: it says which
 * charges are to be carried onto which goods, and applying it is a separate act
 * by somebody who has looked at the allocation. That separation is the one a
 * delivery note keeps from an invoice, and for the same reason — the allocation
 * is a judgement, and a judgement made silently at the moment of data entry is
 * a judgement nobody made.
 *
 * The goods are named by their goods received notes. Each note is resolved to
 * the inventory receipts recorded under it, so the lots on the voucher are the
 * same lots that debited account 1200. There is no second list of what arrived
 * that could disagree with the first.
 */
export async function createVoucher(opts: { orgId: string; entityId: string; voucher: NewVoucher }) {
  const v = opts.voucher;
  const number = v?.number?.trim();
  const shipmentRef = v?.shipmentRef?.trim();
  if (!number) throw new LedgerError("A landed cost voucher needs a number.");
  if (!shipmentRef) {
    throw new LedgerError(
      "A landed cost voucher needs the shipment it belongs to. Charges with no shipment behind them cannot be " +
        "reported against the goods they brought in, which is the whole point of recording them here.",
    );
  }
  const voucherDate = onDate(v.voucherDate, "A landed cost voucher");

  if (!v.charges?.length) throw new LedgerError("A landed cost voucher with no charges on it carries nothing.");
  if (!v.receipts?.length) {
    throw new LedgerError("A landed cost voucher has to name the goods received notes the charges are carried onto.");
  }

  const clash = await prisma.landedCostVoucher.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, number },
  });
  if (clash) throw new LedgerError(`Landed cost voucher ${number} already exists.`);

  const charges = v.charges.map((c, i) => {
    const description = c.description?.trim();
    if (!description) {
      throw new LedgerError(`Charge ${i + 1} needs a description — freight and duty are different things.`);
    }
    const accountCode = c.accountCode?.trim();
    if (!accountCode) {
      throw new LedgerError(
        `Charge ${i + 1} (${description}) has to say which account it is sitting in. Landing it moves the cost ` +
          `out of that account and onto the goods, and without it there is nothing to move it out of.`,
      );
    }
    return {
      lineNo: i + 1,
      description,
      amountMinor: amountOf(c.amountMinor, `Charge ${i + 1} (${description})`),
      accountCode,
      basis: readBasis(c.basis),
    };
  });

  const codes = [...new Set(charges.map((c) => c.accountCode))];
  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: codes } },
    select: { code: true },
  });
  const known = new Set(accounts.map((a) => a.code));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length) {
    throw new LedgerError(`Account ${unknown.join(", ")} does not exist in this entity's chart of accounts.`);
  }

  const lines: {
    lineNo: number; itemId: string; sku: string; receiptRef: string; movementId: string;
    quantityMilli: bigint; valueMinor: bigint;
  }[] = [];
  const refs = [...new Set((v.receipts ?? []).map((r) => r?.trim()).filter(Boolean) as string[])];
  for (const ref of refs) {
    const lots = await receiptsUnder({ orgId: opts.orgId, entityId: opts.entityId, reference: ref });
    if (!lots.length) {
      throw new LedgerError(
        `No stock was received under ${ref}. A charge can only be carried onto goods the books know arrived — ` +
          `record the receipt first, then land the charge on it.`,
      );
    }
    for (const lot of lots) {
      if (day(lot.movedOn) > voucherDate) {
        throw new LedgerError(
          `${ref} brought ${lot.sku} in on ${lot.movedOn}, which is after the voucher date ${iso(voucherDate)}. ` +
            `A charge cannot land on goods before they arrived — check which way round the dates went in.`,
        );
      }
      lines.push({
        lineNo: lines.length + 1,
        itemId: lot.itemId,
        sku: lot.sku,
        receiptRef: ref,
        movementId: lot.movementId,
        quantityMilli: lot.quantityMilli,
        valueMinor: lot.valueMinor,
      });
    }
  }

  const created = await prisma.landedCostVoucher.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId,
      number, shipmentRef, voucherDate, notes: v.notes?.trim() || null,
      charges: { create: charges.map((c) => ({ orgId: opts.orgId, ...c })) },
      lines: { create: lines.map((l) => ({ orgId: opts.orgId, ...l })) },
    },
  });

  return {
    id: created.id,
    number: created.number,
    shipmentRef: created.shipmentRef,
    voucherDate: iso(created.voucherDate),
    status: created.status,
    chargeCount: charges.length,
    lineCount: lines.length,
  };
}

/* ============================================================= the allocation */

export interface PlannedLine {
  lineNo: number;
  itemId: string;
  sku: string;
  name: string;
  uom: string;
  receiptRef: string;
  movementId: string;
  quantityMilli: bigint;
  valueMinor: bigint;
  onHandMilli: bigint;
  soldMilli: bigint;
  weightMilli: bigint | null;
  volumeMilli: bigint | null;
  allocatedMinor: bigint;
  inventoryMinor: bigint;
  cogsMinor: bigint;
  unitCostBeforeMinor: bigint;
  unitCostAfterMinor: bigint;
  stockAccount: string;
  cogsAccount: string;
}

export interface PlannedCharge {
  lineNo: number;
  description: string;
  amountMinor: bigint;
  accountCode: string;
  basis: AllocationBasis;
  shares: {
    lineNo: number; sku: string; basisWeight: bigint;
    allocatedMinor: bigint; inventoryMinor: bigint; cogsMinor: bigint;
  }[];
}

export interface Plan {
  charges: PlannedCharge[];
  lines: PlannedLine[];
  totals: { chargeMinor: bigint; inventoryMinor: bigint; cogsMinor: bigint };
}

/**
 * Work out what the voucher would do, against the stock as it stands now.
 *
 * Everything that can be refused is refused here rather than half way through
 * posting: a missing weight, a basis the goods do not have, a receipt that has
 * since gone. What is left of each lot is read fresh every time, because the
 * answer changes with every sale and an allocation worked against a shelf that
 * emptied last week is worth nothing.
 */
async function planVoucher(v: VoucherRow): Promise<Plan> {
  const fmtMoney = fmtMoneyIn(await bookCurrency(v.orgId, v.entityId));
  if (!v.charges.length) throw new LedgerError(`Voucher ${v.number} has no charges on it.`);
  if (!v.lines.length) throw new LedgerError(`Voucher ${v.number} names no goods.`);

  const itemIds = [...new Set(v.lines.map((l) => l.itemId))];
  const [items, measures] = await Promise.all([
    prisma.inventoryItem.findMany({ where: { orgId: v.orgId, id: { in: itemIds } } }),
    prisma.landedCostMeasure.findMany({
      where: { orgId: v.orgId, entityId: v.entityId, itemId: { in: itemIds } },
    }),
  ]);
  const byItem = new Map(items.map((i) => [i.id, i]));
  const byMeasure = new Map(measures.map((m) => [m.itemId, m]));

  const lots = new Map<string, ReceiptLot>();
  for (const ref of [...new Set(v.lines.map((l) => l.receiptRef))]) {
    for (const lot of await receiptsUnder({ orgId: v.orgId, entityId: v.entityId, reference: ref })) {
      lots.set(lot.movementId, lot);
    }
  }

  const allocatable: AllocatableLine[] = [];
  const context: {
    line: VoucherRow["lines"][number];
    lot: ReceiptLot;
    weightMilli: bigint | null;
    volumeMilli: bigint | null;
  }[] = [];

  for (const line of v.lines) {
    const item = byItem.get(line.itemId);
    const lot = lots.get(line.movementId);
    if (!item || !lot) {
      throw new LedgerError(
        `The receipt of ${line.sku} under ${line.receiptRef} is no longer on the books, so voucher ${v.number} ` +
          `has nothing to land onto. Raise it again against the receipts that are.`,
      );
    }
    const m = byMeasure.get(line.itemId);
    // Grams and litres for the whole lot: the measure per unit, times what came
    // in. Multiplication first and floored once — a weight is a measurement, and
    // a fraction of a gram is not one.
    const weightMilli = m?.unitWeightMilli != null ? (m.unitWeightMilli * lot.quantityMilli) / MILLI : null;
    const volumeMilli = m?.unitVolumeMilli != null ? (m.unitVolumeMilli * lot.quantityMilli) / MILLI : null;

    allocatable.push({
      sku: line.sku,
      quantityMilli: lot.quantityMilli,
      valueMinor: lot.valueMinor,
      onHandMilli: lot.remainingMilli,
      weightMilli,
      volumeMilli,
    });
    context.push({ line, lot, weightMilli, volumeMilli });
  }

  // Named before the spread is attempted, so the refusal says which charge, on
  // which basis, and which items — all three of which somebody needs to fix it.
  for (const c of v.charges) {
    const basis = readBasis(c.basis);
    if (basis !== "WEIGHT" && basis !== "VOLUME") continue;
    const measured = (x: (typeof context)[number]) => (basis === "WEIGHT" ? x.weightMilli : x.volumeMilli);
    const missing = [...new Set(context.filter((x) => measured(x) === null).map((x) => x.line.sku))];
    const nil = [...new Set(context.filter((x) => measured(x) === 0n).map((x) => x.line.sku))];
    if (missing.length || nil.length) {
      const what = basis === "WEIGHT" ? "weight" : "volume";
      const parts: string[] = [];
      if (missing.length) parts.push(`no ${what} is recorded for ${missing.join(", ")}`);
      if (nil.length) {
        parts.push(`${nil.join(", ")} ${nil.length === 1 ? "measures" : "measure"} nothing at the quantity received`);
      }
      throw new LedgerError(
        `${c.description} (${fmtMoney(c.amountMinor)}) is spread by ${BASIS_LABEL[basis]}, and ${parts.join("; and ")}. ` +
          `Record a ${what} per unit for them, or spread this charge by value — reading a missing ${what} as ` +
          `nothing would give those goods a free ride at the expense of everything else on the shipment.`,
      );
    }
  }

  const spread = spreadCharges(
    v.charges.map((c) => ({ description: c.description, amountMinor: c.amountMinor, basis: readBasis(c.basis) })),
    allocatable,
  );

  const lines: PlannedLine[] = context.map((x, li) => {
    const split = spread.lines[li];
    const item = byItem.get(x.line.itemId)!;
    const before = (x.lot.valueMinor * MILLI) / x.lot.quantityMilli;
    const after = ((x.lot.valueMinor + split.allocatedMinor) * MILLI) / x.lot.quantityMilli;
    return {
      lineNo: x.line.lineNo,
      itemId: item.id,
      sku: x.line.sku,
      name: item.name,
      uom: item.uom,
      receiptRef: x.line.receiptRef,
      movementId: x.line.movementId,
      quantityMilli: x.lot.quantityMilli,
      valueMinor: x.lot.valueMinor,
      onHandMilli: x.lot.remainingMilli,
      soldMilli: x.lot.quantityMilli - x.lot.remainingMilli,
      weightMilli: x.weightMilli,
      volumeMilli: x.volumeMilli,
      allocatedMinor: split.allocatedMinor,
      inventoryMinor: split.inventoryMinor,
      cogsMinor: split.cogsMinor,
      unitCostBeforeMinor: before,
      unitCostAfterMinor: after,
      stockAccount: item.stockAccount,
      cogsAccount: item.cogsAccount,
    };
  });

  const charges: PlannedCharge[] = v.charges.map((c, ci) => ({
    lineNo: c.lineNo,
    description: c.description,
    amountMinor: c.amountMinor,
    accountCode: c.accountCode,
    basis: readBasis(c.basis),
    shares: spread.shares[ci].map((s, li) => ({
      lineNo: context[li].line.lineNo,
      sku: context[li].line.sku,
      basisWeight: s.basisWeight,
      allocatedMinor: s.allocatedMinor,
      inventoryMinor: s.inventoryMinor,
      cogsMinor: s.cogsMinor,
    })),
  }));

  return { charges, lines, totals: spread.totals };
}

/* =================================================================== applying */

/**
 * Carry the charges onto the goods.
 *
 *   Dr  1200  Inventory           the share belonging to stock still held
 *   Dr  5000  Cost of goods sold  the share belonging to stock already sold
 *     Cr  the account each charge is sitting in
 *
 * One entry for the whole voucher, because a voucher covering four charges and
 * nine items is one transaction and nine entries would be nine things nobody
 * can read. Every line names its item and the goods received note behind it, so
 * the entry still leads back to the goods.
 *
 * Idempotent twice over. The posting carries an `externalKey` naming the
 * voucher, so a retry after a half failure returns the entry that already
 * exists rather than posting a second one; and each inventory movement carries
 * its voucher line as its reference, so a retry after the entry landed but the
 * movements did not finishes the job rather than adding the cost twice. A
 * voucher already applied hands back what it did and moves nothing.
 */
export async function applyVoucher(opts: {
  orgId: string;
  entityId: string;
  number: string;
  actorId?: string;
}) {
  const v = await loadVoucher(opts.orgId, opts.entityId, opts.number);
  if (v.status === "cancelled") {
    throw new LedgerError(`Voucher ${v.number} was cancelled. Raise a new one rather than reviving it.`);
  }
  if (v.status === "applied") {
    // The same shape a first application returns, so a caller never has to ask
    // which of the two it got before it can read the answer.
    const already = v.entryId
      ? await prisma.journalEntry.findFirst({
          where: { id: v.entryId, orgId: opts.orgId },
          select: { series: true, number: true },
        })
      : null;
    return {
      ...(await voucherDetail(opts)),
      reference: already ? `${already.series}-${already.number}` : null,
      replayed: true,
    };
  }

  const key = `landedcost:apply:${v.id}`;
  // An attempt that posted its entry and then stopped is picked up where it
  // stopped rather than worked out again. The entry is fixed — `post` hands the
  // same one back — so the allocation behind it has to be fixed too. Planning
  // afresh against a shelf that has sold something in the meantime would move
  // cost the entry never posted, and the item would stop agreeing with 1200.
  const already = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey: key },
    select: { id: true },
  });
  const resuming = Boolean(already) && v.lines.every((l) => l.allocatedMinor !== null);
  const plan = resuming ? await storedPlan(v) : await planVoucher(v);
  const on = iso(v.voucherDate);

  // Written before the entry, which is what makes resuming possible at all: an
  // allocation nobody recorded is an allocation a retry has to invent.
  if (!resuming) await recordPlan(v, plan);

  const lines = [
    ...plan.lines
      .filter((l) => l.inventoryMinor > 0n)
      .map((l) => ({
        account: l.stockAccount,
        debit: l.inventoryMinor,
        memo: `${l.sku} — landed cost on ${l.receiptRef}`,
      })),
    ...plan.lines
      .filter((l) => l.cogsMinor > 0n)
      .map((l) => ({
        account: l.cogsAccount,
        debit: l.cogsMinor,
        memo: `${l.sku} — landed cost on ${fmtQty(l.soldMilli)} ${l.uom} already sold`,
      })),
    ...plan.charges.map((c) => ({
      account: c.accountCode,
      credit: c.amountMinor,
      memo: `${c.description} — carried onto ${v.shipmentRef}`,
    })),
  ];

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: on,
    memo: `Landed cost ${v.number} — ${v.shipmentRef}`,
    source: "inventory",
    sourceType: "LANDED_COST",
    sourceId: v.id,
    externalKey: key,
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "LC",
    lines,
  });
  const reference = `${entry.series}-${entry.number}`;

  // The cost reaches the items one lot at a time, each movement naming its own
  // voucher line so a retry recognises what it already did. Under FIFO the
  // charge is added to the layer that receipt opened, which is the only place
  // it belongs: the goods it paid for are in that layer and nowhere else.
  for (const l of plan.lines) {
    if (l.inventoryMinor <= 0n) continue;
    await capitaliseCost({
      orgId: opts.orgId,
      entityId: opts.entityId,
      sku: l.sku,
      movedOn: on,
      valueMinor: l.inventoryMinor,
      entryId: entry.id,
      entryReference: reference,
      ontoMovementId: l.movementId,
      reference: `${v.number}/${l.lineNo}`,
      memo: `Landed cost ${v.number} — ${v.shipmentRef}`,
      actorId: opts.actorId,
    });
  }

  await prisma.landedCostVoucher.update({
    where: { id: v.id },
    data: { status: "applied", appliedOn: v.voucherDate, entryId: entry.id },
  });

  return { ...(await voucherDetail(opts)), reference: reference as string | null, replayed: false };
}

/** What the voucher decided, written down before any of it reaches the ledger. */
async function recordPlan(v: VoucherRow, plan: Plan) {
  await prisma.$transaction(async (tx) => {
    for (const l of plan.lines) {
      await tx.landedCostLine.update({
        where: { voucherId_lineNo: { voucherId: v.id, lineNo: l.lineNo } },
        data: {
          quantityMilli: l.quantityMilli,
          valueMinor: l.valueMinor,
          weightMilli: l.weightMilli,
          volumeMilli: l.volumeMilli,
          onHandMilli: l.onHandMilli,
          allocatedMinor: l.allocatedMinor,
          inventoryMinor: l.inventoryMinor,
          cogsMinor: l.cogsMinor,
        },
      });
    }
    const stored = await tx.landedCostLine.findMany({
      where: { voucherId: v.id },
      select: { id: true, lineNo: true },
    });
    const lineIds = new Map(stored.map((r) => [r.lineNo, r.id]));
    const chargeIds = new Map(v.charges.map((c) => [c.lineNo, c.id]));
    await tx.landedCostAllocation.deleteMany({ where: { voucherId: v.id } });
    await tx.landedCostAllocation.createMany({
      data: plan.charges.flatMap((c) =>
        c.shares.map((s) => ({
          orgId: v.orgId,
          voucherId: v.id,
          chargeId: chargeIds.get(c.lineNo)!,
          lineId: lineIds.get(s.lineNo)!,
          basisWeight: s.basisWeight,
          allocatedMinor: s.allocatedMinor,
          inventoryMinor: s.inventoryMinor,
          cogsMinor: s.cogsMinor,
        })),
      ),
    });
  });
}

/**
 * The plan as it was recorded, rather than as it would be worked out today.
 *
 * Used only to finish an application that had already posted. Nothing here is
 * recomputed from the stock: the whole point is that the shelf may have moved.
 */
async function storedPlan(v: VoucherRow): Promise<Plan> {
  const items = await prisma.inventoryItem.findMany({
    where: { orgId: v.orgId, id: { in: [...new Set(v.lines.map((l) => l.itemId))] } },
  });
  const byItem = new Map(items.map((i) => [i.id, i]));
  const byLineId = new Map(v.lines.map((l) => [l.id, l]));

  const lines: PlannedLine[] = v.lines.map((l) => {
    const item = byItem.get(l.itemId);
    if (!item) throw new LedgerError(`${l.sku} is no longer on the item list, so voucher ${v.number} cannot be finished.`);
    const allocated = l.allocatedMinor ?? 0n;
    const onHand = l.onHandMilli ?? 0n;
    return {
      lineNo: l.lineNo,
      itemId: l.itemId,
      sku: l.sku,
      name: item.name,
      uom: item.uom,
      receiptRef: l.receiptRef,
      movementId: l.movementId,
      quantityMilli: l.quantityMilli,
      valueMinor: l.valueMinor,
      onHandMilli: onHand,
      soldMilli: l.quantityMilli - onHand,
      weightMilli: l.weightMilli,
      volumeMilli: l.volumeMilli,
      allocatedMinor: allocated,
      inventoryMinor: l.inventoryMinor ?? 0n,
      cogsMinor: l.cogsMinor ?? 0n,
      unitCostBeforeMinor: l.quantityMilli > 0n ? (l.valueMinor * MILLI) / l.quantityMilli : 0n,
      unitCostAfterMinor: l.quantityMilli > 0n ? ((l.valueMinor + allocated) * MILLI) / l.quantityMilli : 0n,
      stockAccount: item.stockAccount,
      cogsAccount: item.cogsAccount,
    };
  });

  const charges: PlannedCharge[] = v.charges.map((c) => ({
    lineNo: c.lineNo,
    description: c.description,
    amountMinor: c.amountMinor,
    accountCode: c.accountCode,
    basis: readBasis(c.basis),
    shares: v.allocations
      .filter((a) => a.chargeId === c.id)
      .map((a) => ({
        lineNo: byLineId.get(a.lineId)?.lineNo ?? 0,
        sku: byLineId.get(a.lineId)?.sku ?? "",
        basisWeight: a.basisWeight,
        allocatedMinor: a.allocatedMinor,
        inventoryMinor: a.inventoryMinor,
        cogsMinor: a.cogsMinor,
      }))
      .sort((a, b) => a.lineNo - b.lineNo),
  }));

  return {
    charges,
    lines,
    totals: {
      chargeMinor: v.charges.reduce((a, c) => a + c.amountMinor, 0n),
      inventoryMinor: lines.reduce((a, l) => a + l.inventoryMinor, 0n),
      cogsMinor: lines.reduce((a, l) => a + l.cogsMinor, 0n),
    },
  };
}

/**
 * Cancel a voucher that has not been applied.
 *
 * An applied one is not cancelled, because the cost has reached the goods and
 * the ledger. Correcting it is a reversal of the entry and a new voucher, as it
 * is everywhere else here — a document that could be un-applied would let
 * account 1200 and the item disagree with no record of when they parted.
 */
export async function cancelVoucher(opts: {
  orgId: string; entityId: string; number: string; reason?: string;
}) {
  const v = await loadVoucher(opts.orgId, opts.entityId, opts.number);
  if (v.status === "applied") {
    throw new LedgerError(
      `Voucher ${v.number} has been applied: the cost is on the goods and in the ledger. Reverse the entry it ` +
        `posted and raise a corrected voucher — cancelling the paper would leave the stock carrying a cost with ` +
        `nothing behind it.`,
    );
  }
  if (v.status === "cancelled") return { number: v.number, status: v.status };
  const reason = opts.reason?.trim();
  const updated = await prisma.landedCostVoucher.update({
    where: { id: v.id },
    data: {
      status: "cancelled",
      notes: reason ? `${v.notes ? `${v.notes} — ` : ""}Cancelled: ${reason}` : v.notes,
    },
  });
  return { number: updated.number, status: updated.status };
}

/* ==================================================================== reading */

const showLine = (l: PlannedLine) => ({
  lineNo: l.lineNo,
  sku: l.sku,
  name: l.name,
  uom: l.uom,
  receiptRef: l.receiptRef,
  quantityMilli: l.quantityMilli.toString(),
  quantity: fmtQty(l.quantityMilli),
  valueMinor: l.valueMinor.toString(),
  onHandMilli: l.onHandMilli.toString(),
  onHand: fmtQty(l.onHandMilli),
  soldMilli: l.soldMilli.toString(),
  sold: fmtQty(l.soldMilli),
  weightMilli: l.weightMilli === null ? null : l.weightMilli.toString(),
  volumeMilli: l.volumeMilli === null ? null : l.volumeMilli.toString(),
  allocatedMinor: l.allocatedMinor.toString(),
  inventoryMinor: l.inventoryMinor.toString(),
  cogsMinor: l.cogsMinor.toString(),
  unitCostBeforeMinor: l.unitCostBeforeMinor.toString(),
  unitCostAfterMinor: l.unitCostAfterMinor.toString(),
  unitCostLiftMinor: (l.unitCostAfterMinor - l.unitCostBeforeMinor).toString(),
});

/**
 * One voucher, with what it did or with what it would do.
 *
 * A draft is worked against the stock as it stands, so what is on the screen is
 * what will be posted if it is applied now. An applied one reads back what was
 * actually recorded, because the shelf has moved on since and recomputing it
 * would show figures that were never posted.
 *
 * A refusal comes back as a field rather than as a crash. The voucher is real
 * and worth showing, and the reason it cannot be applied yet is the most useful
 * thing on the page.
 */
export async function voucherDetail(opts: { orgId: string; entityId: string; number: string }) {
  const v = await loadVoucher(opts.orgId, opts.entityId, opts.number);

  const head = {
    number: v.number,
    shipmentRef: v.shipmentRef,
    voucherDate: iso(v.voucherDate),
    status: v.status,
    notes: v.notes,
    appliedOn: v.appliedOn ? iso(v.appliedOn) : null,
    entryId: v.entryId,
    chargeMinor: v.charges.reduce((a, c) => a + c.amountMinor, 0n).toString(),
  };

  if (v.status !== "applied") {
    let plan: Plan | null = null;
    let refusal: string | null = null;
    try {
      plan = await planVoucher(v);
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      refusal = e.message;
    }
    return {
      ...head,
      applied: false,
      refusal,
      charges: v.charges.map((c) => ({
        lineNo: c.lineNo,
        description: c.description,
        amountMinor: c.amountMinor.toString(),
        accountCode: c.accountCode,
        basis: c.basis,
        basisLabel: BASIS_LABEL[readBasis(c.basis)],
        shares:
          plan?.charges.find((p) => p.lineNo === c.lineNo)?.shares.map((s) => ({
            lineNo: s.lineNo,
            sku: s.sku,
            basisWeight: s.basisWeight.toString(),
            allocatedMinor: s.allocatedMinor.toString(),
          })) ?? [],
      })),
      lines: plan ? plan.lines.map(showLine) : [],
      totals: {
        chargeMinor: head.chargeMinor,
        inventoryMinor: (plan?.totals.inventoryMinor ?? 0n).toString(),
        cogsMinor: (plan?.totals.cogsMinor ?? 0n).toString(),
      },
    };
  }

  const byLine = new Map(v.lines.map((l) => [l.id, l]));
  // The item is read for its name and unit only. Everything else on an applied
  // voucher comes off the voucher itself, because the shelf has moved on and
  // the item's figures today are not the ones that were posted.
  const named = await prisma.inventoryItem.findMany({
    where: { orgId: v.orgId, id: { in: [...new Set(v.lines.map((l) => l.itemId))] } },
    select: { id: true, name: true, uom: true },
  });
  const byItem = new Map(named.map((i) => [i.id, i]));
  return {
    ...head,
    applied: true,
    refusal: null as string | null,
    charges: v.charges.map((c) => ({
      lineNo: c.lineNo,
      description: c.description,
      amountMinor: c.amountMinor.toString(),
      accountCode: c.accountCode,
      basis: c.basis,
      basisLabel: BASIS_LABEL[readBasis(c.basis)],
      shares: v.allocations
        .filter((a) => a.chargeId === c.id)
        .map((a) => ({
          lineNo: byLine.get(a.lineId)?.lineNo ?? 0,
          sku: byLine.get(a.lineId)?.sku ?? "",
          basisWeight: a.basisWeight.toString(),
          allocatedMinor: a.allocatedMinor.toString(),
        }))
        .sort((a, b) => a.lineNo - b.lineNo),
    })),
    lines: v.lines.map((l) => {
      const allocated = l.allocatedMinor ?? 0n;
      const onHand = l.onHandMilli ?? 0n;
      const before = l.quantityMilli > 0n ? (l.valueMinor * MILLI) / l.quantityMilli : 0n;
      const after = l.quantityMilli > 0n ? ((l.valueMinor + allocated) * MILLI) / l.quantityMilli : 0n;
      return {
        lineNo: l.lineNo,
        sku: l.sku,
        name: byItem.get(l.itemId)?.name ?? l.sku,
        uom: byItem.get(l.itemId)?.uom ?? "",
        receiptRef: l.receiptRef,
        quantityMilli: l.quantityMilli.toString(),
        quantity: fmtQty(l.quantityMilli),
        valueMinor: l.valueMinor.toString(),
        onHandMilli: onHand.toString(),
        onHand: fmtQty(onHand),
        soldMilli: (l.quantityMilli - onHand).toString(),
        sold: fmtQty(l.quantityMilli - onHand),
        weightMilli: l.weightMilli === null ? null : l.weightMilli.toString(),
        volumeMilli: l.volumeMilli === null ? null : l.volumeMilli.toString(),
        allocatedMinor: allocated.toString(),
        inventoryMinor: (l.inventoryMinor ?? 0n).toString(),
        cogsMinor: (l.cogsMinor ?? 0n).toString(),
        unitCostBeforeMinor: before.toString(),
        unitCostAfterMinor: after.toString(),
        unitCostLiftMinor: (after - before).toString(),
      };
    }),
    totals: {
      chargeMinor: head.chargeMinor,
      inventoryMinor: v.lines.reduce((a, l) => a + (l.inventoryMinor ?? 0n), 0n).toString(),
      cogsMinor: v.lines.reduce((a, l) => a + (l.cogsMinor ?? 0n), 0n).toString(),
    },
  };
}

/**
 * What has been landed onto each shipment, what is still waiting, and what the
 * charges did to the cost of a unit.
 *
 * The third section is the one that makes the report worth reading. It lists
 * every account the vouchers draw from and compares what the ledger carries on
 * it against what has actually been landed out of it. The difference is freight
 * and duty still sitting in the profit and loss, which is either correct — it
 * belonged to goods long gone — or an understatement of inventory nobody has
 * got round to. The report cannot tell which, and says so rather than guessing.
 */
export async function landedCostReport(opts: {
  orgId: string;
  entityId: string;
  from?: string;
  to?: string;
}) {
  const to = opts.to?.trim() ? onDate(opts.to, "The report end") : new Date();
  const from = opts.from?.trim()
    ? onDate(opts.from, "The report start")
    : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 11, 1));
  if (from > to) throw new LedgerError(`${iso(from)} is after ${iso(to)}. The dates are the wrong way round.`);

  const vouchers = await prisma.landedCostVoucher.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, voucherDate: { gte: from, lte: to } },
    include: { charges: { orderBy: { lineNo: "asc" } }, lines: { orderBy: { lineNo: "asc" } } },
    orderBy: [{ voucherDate: "asc" }, { number: "asc" }],
  });

  interface ShipmentAcc {
    shipmentRef: string;
    vouchers: { number: string; voucherDate: string; status: string; chargeMinor: bigint; entryId: string | null }[];
    landedMinor: bigint;
    unallocatedMinor: bigint;
    inventoryMinor: bigint;
    cogsMinor: bigint;
    items: Map<string, { sku: string; receiptRef: string; quantityMilli: bigint; valueMinor: bigint; allocatedMinor: bigint }>;
  }
  const shipments = new Map<string, ShipmentAcc>();

  for (const v of vouchers) {
    if (v.status === "cancelled") continue;
    const chargeMinor = v.charges.reduce((a, c) => a + c.amountMinor, 0n);
    const s: ShipmentAcc = shipments.get(v.shipmentRef) ?? {
      shipmentRef: v.shipmentRef, vouchers: [], landedMinor: 0n, unallocatedMinor: 0n,
      inventoryMinor: 0n, cogsMinor: 0n, items: new Map(),
    };
    s.vouchers.push({
      number: v.number, voucherDate: iso(v.voucherDate), status: v.status, chargeMinor, entryId: v.entryId,
    });
    if (v.status === "applied") {
      s.landedMinor += chargeMinor;
      s.inventoryMinor += v.lines.reduce((a, l) => a + (l.inventoryMinor ?? 0n), 0n);
      s.cogsMinor += v.lines.reduce((a, l) => a + (l.cogsMinor ?? 0n), 0n);
      for (const l of v.lines) {
        const key = `${l.sku}\u0000${l.receiptRef}`;
        const row = s.items.get(key) ?? {
          sku: l.sku, receiptRef: l.receiptRef,
          quantityMilli: l.quantityMilli, valueMinor: l.valueMinor, allocatedMinor: 0n,
        };
        row.allocatedMinor += l.allocatedMinor ?? 0n;
        s.items.set(key, row);
      }
    } else {
      s.unallocatedMinor += chargeMinor;
    }
    shipments.set(v.shipmentRef, s);
  }

  // What the ledger carries on the accounts these vouchers draw from, against
  // what has been landed out of them.
  const codes = [...new Set(vouchers.flatMap((v) => v.charges.map((c) => c.accountCode)))];
  const accounts = codes.length
    ? await prisma.account.findMany({
        where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: codes } },
        select: { id: true, code: true, name: true },
      })
    : [];
  const movement = new Map<string, bigint>();
  if (accounts.length) {
    const rows = await prisma.journalLine.findMany({
      where: {
        orgId: opts.orgId,
        accountId: { in: accounts.map((a) => a.id) },
        entry: {
          entityId: opts.entityId,
          // A reversed entry is still part of the history. Leaving it out would
          // report a charge that was posted and then reversed as though it had
          // never happened, and the pair nets to nothing in any case.
          status: { in: ["posted", "reversed"] },
          entryDate: { gte: from, lte: to },
        },
      },
      select: { accountId: true, functionalAmountMinor: true },
    });
    for (const r of rows) {
      movement.set(r.accountId, (movement.get(r.accountId) ?? 0n) + r.functionalAmountMinor);
    }
  }
  const landedByCode = new Map<string, bigint>();
  for (const v of vouchers) {
    if (v.status !== "applied") continue;
    for (const c of v.charges) {
      landedByCode.set(c.accountCode, (landedByCode.get(c.accountCode) ?? 0n) + c.amountMinor);
    }
  }

  const shipmentRows = [...shipments.values()]
    .map((s) => ({
      shipmentRef: s.shipmentRef,
      vouchers: s.vouchers.map((x) => ({ ...x, chargeMinor: x.chargeMinor.toString() })),
      landedMinor: s.landedMinor.toString(),
      unallocatedMinor: s.unallocatedMinor.toString(),
      inventoryMinor: s.inventoryMinor.toString(),
      cogsMinor: s.cogsMinor.toString(),
      items: [...s.items.values()]
        .map((i) => {
          const before = i.quantityMilli > 0n ? (i.valueMinor * MILLI) / i.quantityMilli : 0n;
          const after = i.quantityMilli > 0n ? ((i.valueMinor + i.allocatedMinor) * MILLI) / i.quantityMilli : 0n;
          return {
            sku: i.sku,
            receiptRef: i.receiptRef,
            quantityMilli: i.quantityMilli.toString(),
            quantity: fmtQty(i.quantityMilli),
            valueMinor: i.valueMinor.toString(),
            allocatedMinor: i.allocatedMinor.toString(),
            unitCostBeforeMinor: before.toString(),
            unitCostAfterMinor: after.toString(),
            unitCostLiftMinor: (after - before).toString(),
          };
        })
        .sort((a, b) => a.sku.localeCompare(b.sku) || a.receiptRef.localeCompare(b.receiptRef)),
    }))
    .sort((a, b) => a.shipmentRef.localeCompare(b.shipmentRef));

  return {
    from: iso(from),
    to: iso(to),
    shipments: shipmentRows,
    unapplied: vouchers
      .filter((v) => v.status === "draft")
      .map((v) => ({
        number: v.number,
        shipmentRef: v.shipmentRef,
        voucherDate: iso(v.voucherDate),
        chargeMinor: v.charges.reduce((a, c) => a + c.amountMinor, 0n).toString(),
        lineCount: v.lines.length,
      })),
    chargeAccounts: accounts
      .map((a) => {
        const net = movement.get(a.id) ?? 0n;
        const landed = landedByCode.get(a.code) ?? 0n;
        return {
          code: a.code,
          name: a.name,
          /** What the account still carries for the window, after the vouchers credited it. */
          balanceMinor: net.toString(),
          landedMinor: landed.toString(),
          /** What went through the account before anything was landed out of it. */
          chargedMinor: (net + landed).toString(),
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code)),
    totals: {
      landedMinor: shipmentRows.reduce((a, s) => a + BigInt(s.landedMinor), 0n).toString(),
      unallocatedMinor: shipmentRows.reduce((a, s) => a + BigInt(s.unallocatedMinor), 0n).toString(),
      inventoryMinor: shipmentRows.reduce((a, s) => a + BigInt(s.inventoryMinor), 0n).toString(),
      cogsMinor: shipmentRows.reduce((a, s) => a + BigInt(s.cogsMinor), 0n).toString(),
    },
    note:
      "A balance left on a charge account is not by itself a fault. Freight on goods that were sold before the " +
      "invoice arrived belongs in cost of sales and stays there. What the figure shows is how much cost nobody " +
      "has looked at, and IAS 2.10 puts it on the goods wherever the goods are still here.",
  };
}

/** Every voucher, newest first, with what it holds and what it has done. */
export async function voucherList(opts: { orgId: string; entityId: string; status?: string }) {
  const vouchers = await prisma.landedCostVoucher.findMany({
    where: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      ...(opts.status?.trim() ? { status: opts.status.trim() } : {}),
    },
    include: { charges: true, lines: true },
    orderBy: [{ voucherDate: "desc" }, { number: "desc" }],
    take: 200,
  });
  return {
    vouchers: vouchers.map((v) => ({
      number: v.number,
      shipmentRef: v.shipmentRef,
      voucherDate: iso(v.voucherDate),
      status: v.status,
      appliedOn: v.appliedOn ? iso(v.appliedOn) : null,
      chargeMinor: v.charges.reduce((a, c) => a + c.amountMinor, 0n).toString(),
      // Only an applied voucher has landed anything. A draft can carry figures
      // — an application that stopped half way records its plan before it posts
      // — and reading those as landed would report cost that never moved.
      inventoryMinor: (v.status === "applied" ? v.lines.reduce((a, l) => a + (l.inventoryMinor ?? 0n), 0n) : 0n).toString(),
      cogsMinor: (v.status === "applied" ? v.lines.reduce((a, l) => a + (l.cogsMinor ?? 0n), 0n) : 0n).toString(),
      chargeCount: v.charges.length,
      lineCount: v.lines.length,
    })),
  };
}
