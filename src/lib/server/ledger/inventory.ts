import { prisma } from "@/lib/server/prisma";
import { post, LedgerError } from "./post";
import { planConsumption, settleTakes, effectiveUnitCost, layerValue, oldestFirst, type LayerTake } from "./inventory-fifo";

/**
 * Inventory, at weighted average cost or first-in-first-out, and never above
 * net realisable value.
 *
 * Stock is where an accounting system most often stops being arithmetic and
 * starts being opinion, so the opinions are stated here:
 *
 *  - Quantity and value are carried forward on the item, not summed from
 *    movements. Weighted average depends on the order things happened in; a
 *    receipt entered late must not silently rewrite the cost of goods already
 *    sold and already reported.
 *  - Movements are append-only. A correction is another movement, exactly as a
 *    correction to the ledger is another entry.
 *  - Negative stock is refused. It is nearly always a missing receipt rather
 *    than a real position, and issuing goods the system has no cost for means
 *    inventing one.
 *  - Every movement that changes value posts to the ledger in the same act. An
 *    inventory system whose numbers do not reach account 1200 is a spreadsheet.
 *
 * FIFO and net realisable value follow from those four rather than bending them:
 *
 *  - A FIFO item's layers are the record of what its stock cost, not a cache of
 *    the item's carried value. The item stays the authority on the total — the
 *    first opinion — and the layers say which receipts that total is made of,
 *    which an average cannot. The issue that empties an item still takes the
 *    whole remaining value, so flooring cannot strand fils against nil stock.
 *  - The cost method cannot change while an item holds stock, because stock
 *    costed on an average has no layers behind it and inventing them would
 *    invent a cost. That is the third opinion applied to a method change.
 *  - A write-down to net realisable value (IAS 2.9) is an allowance against
 *    cost, never a rewrite of cost, because IAS 2.33 requires the write-down to
 *    be reversed if the circumstances that caused it go away and that reversal
 *    needs the original cost to still exist. The allowance is derived — the gap
 *    between cost and the lower of cost and NRV — rather than accumulated, so it
 *    cannot drift, it can never go negative, and the IAS 2.33 ceiling holds by
 *    construction rather than by a guard somebody has to remember.
 *  - A write-down is not a movement of stock, so it is not recorded as one. It
 *    changes the assessment carried on the item and it posts; the ledger entry
 *    is its record, dated and referenced like every other.
 *  - Every act that moves cost or quantity re-posts the change in that allowance
 *    in the same breath, because an item whose carrying amount is right on the
 *    screen and stale in account 1200 is worse than no report at all.
 *
 * Quantities are thousandths, so 1.5 kg is 1500. Money is minor units. Neither
 * is ever a float.
 */

const MILLI = 1000n;

/** IAS 2.25 permits either; the same one has to be used for similar inventories. */
export const COST_METHODS = ["WEIGHTED_AVERAGE", "FIFO"] as const;
export type CostMethod = (typeof COST_METHODS)[number];

/** The two ways a net realisable value assessment reaches the ledger. */
const NRV_SOURCE_TYPES = ["NRV_WRITE_DOWN", "NRV_REVERSAL"];

export interface NewItem {
  sku: string;
  name: string;
  nameAr?: string;
  uom?: string;
  costMethod?: string;
  stockAccount?: string;
  cogsAccount?: string;
  varianceAccount?: string;
}

function readMethod(value: string | undefined, fallback: CostMethod = "WEIGHTED_AVERAGE"): CostMethod {
  if (value === undefined || value === null || value === "") return fallback;
  const m = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if ((COST_METHODS as readonly string[]).includes(m)) return m as CostMethod;
  throw new LedgerError(
    `"${value}" is not a cost method. Stock is costed on ${COST_METHODS.join(" or ")} — IAS 2.25 allows either, and nothing else.`,
  );
}

export async function addItem(opts: { orgId: string; entityId: string; item: NewItem }) {
  const i = opts.item;
  if (!i.sku?.trim()) throw new LedgerError("An item needs a SKU.");
  if (!i.name?.trim()) throw new LedgerError("An item needs a name.");
  const costMethod = readMethod(i.costMethod);

  const clash = await prisma.inventoryItem.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, sku: i.sku.trim() },
  });
  if (clash) throw new LedgerError(`SKU ${i.sku} already exists.`);

  return prisma.inventoryItem.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId,
      sku: i.sku.trim(), name: i.name.trim(), nameAr: i.nameAr ?? null,
      uom: i.uom ?? "EA",
      costMethod,
      stockAccount: i.stockAccount ?? "1200",
      cogsAccount: i.cogsAccount ?? "5000",
      varianceAccount: i.varianceAccount ?? "5300",
    },
  });
}

/**
 * Weighted average cost per whole unit, in minor units.
 *
 * Rounded down deliberately. Rounding up would let the running unit cost drift
 * above what was actually paid, and the drift compounds every receipt.
 */
export function unitCost(valueMinor: bigint, quantityMilli: bigint): bigint {
  if (quantityMilli <= 0n) return 0n;
  return (valueMinor * MILLI) / quantityMilli;
}

/** The cost of issuing a quantity at the current average — never more than is held. */
export function issueValue(item: { valueMinor: bigint; quantityMilli: bigint }, quantityMilli: bigint): bigint {
  if (quantityMilli >= item.quantityMilli) return item.valueMinor; // the last issue takes the remainder
  return (item.valueMinor * quantityMilli) / item.quantityMilli;
}

/**
 * IAS 2.9: inventories are carried at the lower of cost and net realisable
 * value. The assessed NRV is per whole unit, so the comparison is made across
 * the whole holding — floored, like every other quantity-to-value conversion
 * here.
 *
 * A nil assessment is not an assessment of nothing: nobody has looked, so cost
 * stands.
 */
export function carryingAmount(costMinor: bigint, quantityMilli: bigint, nrvPerUnitMinor: bigint | null): bigint {
  if (nrvPerUnitMinor === null || nrvPerUnitMinor === undefined) return costMinor;
  const nrvTotal = (nrvPerUnitMinor * quantityMilli) / MILLI;
  return nrvTotal < costMinor ? nrvTotal : costMinor;
}

/**
 * The write-down held against an item.
 *
 * Derived rather than accumulated, which is what enforces the IAS 2.33 ceiling
 * for free: the allowance is the gap between cost and the lower of cost and
 * NRV, so it can never be negative and a reversal can never lift the carrying
 * amount above what the stock originally cost. It is also what makes an
 * assessment idempotent without a key — the same figure assessed twice asks for
 * the same allowance, and a difference of nothing posts nothing.
 */
export function writeDownHeld(costMinor: bigint, quantityMilli: bigint, nrvPerUnitMinor: bigint | null): bigint {
  return costMinor - carryingAmount(costMinor, quantityMilli, nrvPerUnitMinor);
}

export interface MovementResult {
  movementId: string;
  entryId: string | null;
  reference: string | null;
  quantityMilli: string;
  valueMinor: string;
  unitCostMinor: string;
  balanceQtyMilli: string;
  balanceValueMinor: string;
  /** The write-down held against the item once this movement had landed. */
  writeDownMinor: string;
  /** Cost less that write-down — what account 1200 carries for this item. */
  carryingValueMinor: string;
  /** Which layers the movement took from, oldest first. Empty on weighted average. */
  layers: { seq: number; receivedOn: string; quantityMilli: string; unitCostMinor: string; costMinor: string }[];
  /** The movement already existed under the caller's reference and was not repeated. */
  replayed?: true;
}

type ItemRow = Awaited<ReturnType<typeof loadItem>>;

async function loadItem(orgId: string, entityId: string, sku: string) {
  const item = await prisma.inventoryItem.findFirst({ where: { orgId, entityId, sku } });
  if (!item) throw new LedgerError(`SKU ${sku} is not on the item list.`);
  if (item.status !== "active") throw new LedgerError(`SKU ${sku} is archived.`);
  return item;
}

/** The open layers of a FIFO item, oldest first. Scoped by org as well as item. */
async function openLayers(item: ItemRow) {
  const rows = await prisma.inventoryLayer.findMany({
    where: { orgId: item.orgId, itemId: item.id, remainingMilli: { gt: 0n } },
    orderBy: [{ receivedOn: "asc" }, { seq: "asc" }],
  });
  return oldestFirst(rows);
}

/**
 * Has this exact movement already been recorded under the reference the caller
 * gave it?
 *
 * A reference is the outside world's name for the movement — a goods received
 * note, a despatch note, a count sheet — and is therefore the strongest
 * idempotency key available: it identifies the act rather than the moment it was
 * attempted. Where one is given, a retry is recognised as a retry and returns
 * the movement that already exists instead of moving the stock a second time.
 *
 * The reference alone is not enough to match on, because one document can carry
 * the same item twice — a goods received note against two order lines of the
 * same SKU is two receipts under one number — so the movement's own description
 * has to agree as well. `describes` carries the fields that a retry reproduces
 * unchanged: what moved, when, and (for a count) the figure on the sheet. What
 * it never contains is anything derived from the item's state at the time, which
 * a retry would find already changed.
 *
 * Where a reference is NOT given the module cannot tell a retry from a genuine
 * second movement, and does not guess: two issues of 50 on one day are
 * ordinarily two issues, and refusing the second would be worse than repeating
 * it. The posting is still keyed (see `balanceKey`), so the half-failed case —
 * posted but not recorded — cannot double-post; only a complete, successful act
 * repeated in full moves stock twice, and a reference is what prevents that.
 */
async function priorMovement(
  item: ItemRow,
  kinds: string[],
  reference: string | undefined,
  describes: { movedOn: string; quantityMilli?: bigint; valueMinor?: bigint; balanceQtyMilli?: bigint },
) {
  if (!reference?.trim()) return null;
  return prisma.inventoryMovement.findFirst({
    where: {
      orgId: item.orgId, itemId: item.id, kind: { in: kinds }, reference: reference.trim(),
      movedOn: new Date(describes.movedOn),
      ...(describes.quantityMilli !== undefined ? { quantityMilli: describes.quantityMilli } : {}),
      ...(describes.valueMinor !== undefined ? { valueMinor: describes.valueMinor } : {}),
      ...(describes.balanceQtyMilli !== undefined ? { balanceQtyMilli: describes.balanceQtyMilli } : {}),
    },
    orderBy: { createdAt: "asc" },
  });
}

async function replay(item: ItemRow, m: NonNullable<Awaited<ReturnType<typeof priorMovement>>>): Promise<MovementResult> {
  const writeDown = writeDownHeld(m.balanceValueMinor, m.balanceQtyMilli, item.nrvMinor);
  // `reference` on a result is the journal entry's, not the caller's, so a
  // replay has to look it up rather than hand back the document number and
  // quietly change what the field means.
  const entry = m.entryId
    ? await prisma.journalEntry.findFirst({ where: { id: m.entryId, orgId: item.orgId }, select: { series: true, number: true } })
    : null;
  return {
    movementId: m.id,
    entryId: m.entryId,
    reference: entry ? `${entry.series}-${entry.number}` : null,
    quantityMilli: m.quantityMilli.toString(),
    valueMinor: m.valueMinor.toString(),
    unitCostMinor: m.unitCostMinor.toString(),
    balanceQtyMilli: m.balanceQtyMilli.toString(),
    balanceValueMinor: m.balanceValueMinor.toString(),
    writeDownMinor: writeDown.toString(),
    carryingValueMinor: (m.balanceValueMinor - writeDown).toString(),
    // Which layers the original issue took from is not kept on the movement, so
    // a replay reports none rather than recomputing against layers that have
    // moved on since.
    layers: [],
    replayed: true,
  };
}

/**
 * The idempotency key for a movement's posting.
 *
 * It names the position the item is being moved *to*, not the moment it moved —
 * the same shape as `revenue.ts`. Two genuine receipts of the same item on one
 * day move it to two different balances and so carry two different keys, while a
 * retry of an act whose posting landed but whose movement did not lands on the
 * same balances again and is recognised as the same posting. Dating the key
 * instead would collapse the first pair and miss the second.
 */
const balanceKey = (item: ItemRow, kind: string, newQty: bigint, newValue: bigint) =>
  `inventory:${kind.toLowerCase()}:${item.id}:${newQty}:${newValue}`;

/**
 * Change how an item is costed.
 *
 * Refused while there is stock on hand, and the refusal is the point. Stock
 * costed on a weighted average has no layers behind it, so switching it to FIFO
 * would mean either inventing layers — inventing a cost — or issuing goods the
 * system cannot price. Going the other way is no better: collapsing layers into
 * one average silently rewrites what the remaining goods cost.
 */
export async function setCostMethod(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  costMethod: string;
}) {
  const method = readMethod(opts.costMethod, "WEIGHTED_AVERAGE");
  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  if (item.costMethod === method) {
    throw new LedgerError(`${item.sku} is already costed on ${methodName(method)}.`);
  }
  if (item.quantityMilli !== 0n) {
    throw new LedgerError(
      `${item.sku} holds ${fmtQty(item.quantityMilli)} ${item.uom}, so it cannot move from ` +
        `${methodName(item.costMethod)} to ${methodName(method)}. What is on the shelf was costed the old way and has ` +
        `no ${methodName(method)} record behind it; making one up would make up a cost. ` +
        `Bring the stock to nil first — issue it or write it off — and change the method then, ` +
        `or count this stock in as a new item on the method you want.`,
    );
  }

  const updated = await prisma.inventoryItem.update({
    where: { id: item.id },
    data: { costMethod: method },
  });
  return { sku: updated.sku, costMethod: updated.costMethod, quantityMilli: updated.quantityMilli.toString() };
}

/**
 * Receive stock.
 *
 *   Dr  1200  Inventory     what it cost
 *     Cr  the contra          where the cost came from — a supplier, or cash
 *
 * On a FIFO item the receipt also opens a layer, which is what makes the cost of
 * a later sale checkable rather than merely plausible.
 *
 * When a bill has already been posted to inventory the caller passes
 * `alreadyPosted`, because posting again would double the stock account.
 */
export async function receive(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  movedOn: string;
  quantityMilli: number | bigint | string;
  /** Total cost of this receipt, in minor units — not the unit price. */
  valueMinor: number | bigint | string;
  contraAccount?: string;
  /** The goods received note or supplier reference. Doubles as the idempotency key. */
  reference?: string;
  memo?: string;
  /** The bill already debited inventory; record the movement without posting. */
  alreadyPosted?: boolean;
  actorId?: string;
}): Promise<MovementResult> {
  const qty = BigInt(opts.quantityMilli);
  const value = BigInt(opts.valueMinor);
  if (qty <= 0n) throw new LedgerError("A receipt has to be a positive quantity.");
  if (value < 0n) throw new LedgerError("A receipt cannot have a negative cost.");

  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  const seen = await priorMovement(item, ["RECEIPT"], opts.reference,
    { movedOn: opts.movedOn, quantityMilli: qty, valueMinor: value });
  if (seen) return replay(item, seen);

  const newQty = item.quantityMilli + qty;
  const newValue = item.valueMinor + value;

  let entryId: string | null = null;
  let reference: string | null = null;
  if (!opts.alreadyPosted && value > 0n) {
    const entry = await post({
      orgId: opts.orgId, entityId: opts.entityId, entryDate: opts.movedOn,
      memo: opts.memo ?? `Stock received — ${item.sku}`,
      source: "inventory", sourceType: "RECEIPT", sourceId: item.id,
      externalKey: balanceKey(item, "RECEIPT", newQty, newValue),
      actorType: "HUMAN", actorId: opts.actorId, series: "IN",
      lines: [
        { account: item.stockAccount, debit: value, memo: `${item.sku} ${item.name}` },
        { account: opts.contraAccount ?? "2000", credit: value, memo: `${item.sku} received` },
      ],
    });
    entryId = entry.id;
    reference = `${entry.series}-${entry.number}`;
  }

  const fifo = item.costMethod === "FIFO";
  return record({
    item, kind: "RECEIPT", movedOn: opts.movedOn, qty, value,
    newQty, newValue, entryId, reference, ref: opts.reference, memo: opts.memo,
    actorId: opts.actorId,
    // Under FIFO the receipt's own rate is the movement's rate; a running
    // average would describe stock this receipt is not part of.
    rate: fifo ? effectiveUnitCost(value, qty) : undefined,
    openLayer: fifo ? { receivedOn: opts.movedOn, quantityMilli: qty, unitCostMinor: effectiveUnitCost(value, qty) } : undefined,
  });
}

/**
 * Issue stock — a sale, or consumption.
 *
 *   Dr  5000  Cost of goods sold   at cost
 *     Cr  1200  Inventory
 *
 * The value is what the stock is carried at, not what it sold for. Confusing the
 * two is how gross margin ends up meaningless.
 *
 * Under FIFO the cost is the sum of what the issue took from each layer, oldest
 * first. That sum is generally not any one layer's price, so the movement records
 * the effective unit cost of this issue — see `effectiveUnitCost`.
 */
export async function issue(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  movedOn: string;
  quantityMilli: number | bigint | string;
  /** The picking list or despatch note. Doubles as the idempotency key. */
  reference?: string;
  memo?: string;
  actorId?: string;
}): Promise<MovementResult> {
  const qty = BigInt(opts.quantityMilli);
  if (qty <= 0n) throw new LedgerError("An issue has to be a positive quantity.");

  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  // The despatch note says how many went out, not what they cost, so the cost is
  // not part of what identifies the movement.
  const seen = await priorMovement(item, ["ISSUE"], opts.reference, { movedOn: opts.movedOn, quantityMilli: -qty });
  if (seen) return replay(item, seen);

  if (qty > item.quantityMilli) {
    throw new LedgerError(
      `There are only ${fmtQty(item.quantityMilli)} ${item.uom} of ${item.sku} in stock, and ${fmtQty(qty)} was issued. ` +
        `A receipt is probably missing — issuing stock the system has no cost for would mean inventing one.`,
    );
  }

  const consumed = await consume(item, qty);
  const value = consumed.costMinor;
  const newQty = item.quantityMilli - qty;
  // The last issue takes the whole remaining value, so rounding cannot strand
  // a few fils of cost against zero quantity.
  const newValue = newQty === 0n ? 0n : item.valueMinor - value;

  let entryId: string | null = null;
  let reference: string | null = null;
  if (value > 0n) {
    const entry = await post({
      orgId: opts.orgId, entityId: opts.entityId, entryDate: opts.movedOn,
      memo: opts.memo ?? `Stock issued — ${item.sku}`,
      source: "inventory", sourceType: "ISSUE", sourceId: item.id,
      externalKey: balanceKey(item, "ISSUE", newQty, newValue),
      actorType: "HUMAN", actorId: opts.actorId, series: "IN",
      lines: [
        { account: item.cogsAccount, debit: value, memo: `${item.sku} ${item.name}` },
        { account: item.stockAccount, credit: value, memo: `${item.sku} issued` },
      ],
    });
    entryId = entry.id;
    reference = `${entry.series}-${entry.number}`;
  }

  return record({
    item, kind: "ISSUE", movedOn: opts.movedOn, qty: -qty, value: -value,
    newQty, newValue, entryId, reference, ref: opts.reference, memo: opts.memo,
    actorId: opts.actorId, rate: consumed.rate, takes: consumed.takes,
  });
}

/**
 * A stock count adjustment or a write-off.
 *
 * The difference between what the shelf holds and what the system says is a real
 * cost, and it goes to its own account rather than being buried in cost of sales
 * — a business that cannot see its shrinkage cannot manage it.
 */
export async function adjust(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  movedOn: string;
  /** The quantity actually counted, in thousandths. */
  countedMilli: number | bigint | string;
  /** The count sheet this came off. Doubles as the idempotency key. */
  reference?: string;
  reason?: string;
  actorId?: string;
}): Promise<MovementResult> {
  const counted = BigInt(opts.countedMilli);
  if (counted < 0n) throw new LedgerError("A stock count cannot be negative.");

  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  // What the sheet says was on the shelf is what identifies the count, and it is
  // the one figure a retry reproduces: the difference cannot be, because the
  // first attempt has already closed it. Both kinds are searched, since which
  // one a count produced depends on which way the difference fell.
  const seen = await priorMovement(item, ["ADJUSTMENT", "WRITE_OFF"], opts.reference,
    { movedOn: opts.movedOn, balanceQtyMilli: counted });
  if (seen) return replay(item, seen);

  const delta = counted - item.quantityMilli;
  const kind = delta < 0n ? "WRITE_OFF" : "ADJUSTMENT";
  if (delta === 0n) throw new LedgerError(`The count agrees with the system: ${fmtQty(counted)} ${item.uom}. Nothing to adjust.`);

  const rate = unitCost(item.valueMinor, item.quantityMilli);
  // A surplus is valued at the current average — it has no receipt behind it, so
  // it has no cost of its own. A shortfall removes what that quantity was
  // carried at: oldest first under FIFO, at the average otherwise, and the last
  // unit takes the remainder either way.
  const shortfall = delta < 0n ? await consume(item, -delta) : null;
  const value = shortfall ? -shortfall.costMinor : (rate * delta) / MILLI;

  const newQty = counted;
  const newValue = newQty === 0n ? 0n : item.valueMinor + value;

  let entryId: string | null = null;
  let reference: string | null = null;
  if (value !== 0n) {
    const entry = await post({
      orgId: opts.orgId, entityId: opts.entityId, entryDate: opts.movedOn,
      memo: opts.reason ?? `Stock adjustment — ${item.sku}`,
      source: "inventory", sourceType: "ADJUSTMENT", sourceId: item.id,
      externalKey: balanceKey(item, kind, newQty, newValue),
      actorType: "HUMAN", actorId: opts.actorId, series: "IA",
      lines: value > 0n
        ? [
            { account: item.stockAccount, debit: value, memo: `${item.sku} surplus on count` },
            { account: item.varianceAccount, credit: value, memo: `${item.sku} surplus` },
          ]
        : [
            { account: item.varianceAccount, debit: -value, memo: `${item.sku} shortfall` },
            { account: item.stockAccount, credit: -value, memo: `${item.sku} shortfall on count` },
          ],
    });
    entryId = entry.id;
    reference = `${entry.series}-${entry.number}`;
  }

  const fifo = item.costMethod === "FIFO";
  return record({
    item, kind, movedOn: opts.movedOn,
    qty: delta, value, newQty, newValue, entryId, reference,
    ref: opts.reference, memo: opts.reason, actorId: opts.actorId,
    rate: fifo ? (shortfall ? shortfall.rate : rate) : undefined,
    takes: shortfall?.takes,
    // A counted surplus takes its place as the newest layer: the system has no
    // evidence it arrived earlier, and dating it earlier would put a cost in
    // front of receipts that really were earlier.
    openLayer: fifo && delta > 0n
      ? { receivedOn: opts.movedOn, quantityMilli: delta, unitCostMinor: rate }
      : undefined,
  });
}

/**
 * What a quantity coming out of an item costs, by whichever method it is on.
 *
 * The two methods deliberately disagree — that is the whole reason a business
 * chooses one — so this is the single place the choice is made, and everything
 * that takes stock out goes through it.
 */
async function consume(item: ItemRow, qtyMilli: bigint): Promise<{ costMinor: bigint; rate?: bigint; takes?: LayerTake[] }> {
  if (item.costMethod !== "FIFO") return { costMinor: issueValue(item, qtyMilli) };

  const layers = await openLayers(item);
  const plan = planConsumption(layers, qtyMilli);
  if (plan.shortMilli > 0n) {
    // The item says it holds stock the layers cannot account for. That is a
    // broken invariant rather than a user mistake, and guessing a cost for the
    // gap would bury it.
    throw new LedgerError(
      `${item.sku} is costed first-in-first-out but its layers only account for ` +
        `${fmtQty(qtyMilli - plan.shortMilli)} of the ${fmtQty(qtyMilli)} ${item.uom} being taken out. ` +
        `Count the item in again rather than issuing stock with no receipt behind it.`,
    );
  }
  // The item's carried value is the authority on what the stock cost, so the
  // issue that empties it takes the whole remainder and the layers are settled to
  // match rather than left a few fils apart.
  const costMinor = qtyMilli >= item.quantityMilli ? item.valueMinor : plan.costMinor;
  return {
    costMinor,
    rate: effectiveUnitCost(costMinor, qtyMilli),
    takes: settleTakes(plan.takes, costMinor),
  };
}

interface RecordInput {
  item: ItemRow;
  kind: string;
  movedOn: string;
  qty: bigint;
  value: bigint;
  newQty: bigint;
  newValue: bigint;
  entryId: string | null;
  reference: string | null;
  ref?: string;
  memo?: string;
  actorId?: string;
  /** The effective unit cost of this movement, where the running average is not the answer. */
  rate?: bigint;
  openLayer?: { receivedOn: string; quantityMilli: bigint; unitCostMinor: bigint };
  takes?: LayerTake[];
}

async function record(a: RecordInput): Promise<MovementResult> {
  // Weighted average records the running average after the movement, because
  // that is what the remaining stock is worth. FIFO has no such number, so the
  // caller supplies the effective unit cost of the movement itself.
  const rate = a.rate ?? unitCost(a.newValue, a.newQty);

  // The item, its movement and its layers commit together. An item updated
  // without a movement is stock with no history; a movement without the update is
  // history that does not add up; and a consumed layer that outlived a
  // rolled-back issue would hand the next sale someone else's cost.
  const movement = await prisma.$transaction(async (tx) => {
    const created = await tx.inventoryMovement.create({
      data: {
        orgId: a.item.orgId, itemId: a.item.id, movedOn: new Date(a.movedOn),
        kind: a.kind, quantityMilli: a.qty, valueMinor: a.value,
        unitCostMinor: rate, balanceQtyMilli: a.newQty, balanceValueMinor: a.newValue,
        reference: a.ref?.trim() || null, memo: a.memo ?? null, entryId: a.entryId,
      },
    });
    await tx.inventoryItem.update({
      where: { id: a.item.id },
      data: { quantityMilli: a.newQty, valueMinor: a.newValue },
    });
    if (a.openLayer) {
      const top = await tx.inventoryLayer.aggregate({ where: { itemId: a.item.id }, _max: { seq: true } });
      await tx.inventoryLayer.create({
        data: {
          orgId: a.item.orgId, itemId: a.item.id, seq: (top._max.seq ?? 0) + 1,
          receivedOn: new Date(a.openLayer.receivedOn),
          quantityMilli: a.openLayer.quantityMilli,
          remainingMilli: a.openLayer.quantityMilli,
          unitCostMinor: a.openLayer.unitCostMinor,
          movementId: created.id,
        },
      });
    }
    for (const t of a.takes ?? []) {
      // The database refuses a layer with less than nothing left, so an issue that
      // somehow took more than a layer holds fails rather than borrowing.
      await tx.inventoryLayer.update({
        where: { id: t.layerId },
        data: { remainingMilli: { decrement: t.quantityMilli } },
      });
    }
    return created;
  });

  // Cost has moved, so the allowance against it has to move with it, in the same
  // act — see the header. An issue of written-down stock releases its share,
  // which is IAS 2.34: the carrying amount is what reaches the expense.
  const held = writeDownHeld(a.item.valueMinor, a.item.quantityMilli, a.item.nrvMinor);
  const required = writeDownHeld(a.newValue, a.newQty, a.item.nrvMinor);
  await applyWriteDown({
    item: a.item, held, required, on: a.movedOn,
    qtyAfter: a.newQty, costAfter: a.newValue,
    nrvFrom: a.item.nrvMinor, nrvTo: a.item.nrvMinor,
    memo: `Write-down released as stock moved — ${a.item.sku}`,
    actorId: a.actorId,
  });

  return {
    movementId: movement.id,
    entryId: a.entryId,
    reference: a.reference,
    quantityMilli: a.qty.toString(),
    valueMinor: a.value.toString(),
    unitCostMinor: rate.toString(),
    balanceQtyMilli: a.newQty.toString(),
    balanceValueMinor: a.newValue.toString(),
    writeDownMinor: required.toString(),
    carryingValueMinor: (a.newValue - required).toString(),
    layers: (a.takes ?? []).map(showTake),
  };
}

const showTake = (t: LayerTake) => ({
  seq: t.seq,
  receivedOn: t.receivedOn.toISOString().slice(0, 10),
  quantityMilli: t.quantityMilli.toString(),
  unitCostMinor: t.unitCostMinor.toString(),
  costMinor: t.costMinor.toString(),
});

/**
 * Move the write-down held against an item to what it should be, and post the
 * difference.
 *
 *   Dr  5300  Stock variance    where NRV has fallen below cost (IAS 2.9)
 *     Cr  1200  Inventory
 *
 * and the mirror of it on the way back up (IAS 2.33). The allowance is never
 * accumulated, only recomputed, so this is always the difference between two
 * derived figures — which is why it cannot run away from the item it belongs to,
 * and why posting nothing is the right answer surprisingly often.
 */
async function applyWriteDown(a: {
  item: ItemRow;
  held: bigint;
  required: bigint;
  qtyAfter: bigint;
  costAfter: bigint;
  /** The assessment being moved from and to, which is what a reassessment changes. */
  nrvFrom: bigint | null;
  nrvTo: bigint | null;
  on: string;
  memo: string;
  actorId?: string;
}): Promise<{ entryId: string | null; reference: string | null }> {
  const delta = a.required - a.held;
  if (delta === 0n) return { entryId: null, reference: null };

  const entry = await post({
    orgId: a.item.orgId, entityId: a.item.entityId, entryDate: a.on, memo: a.memo,
    source: "inventory", sourceType: delta > 0n ? "NRV_WRITE_DOWN" : "NRV_REVERSAL", sourceId: a.item.id,
    actorType: "HUMAN", actorId: a.actorId, series: "IA",
    // The whole act: which assessment moved, against which stock, and to which
    // allowance. Naming only the allowance would let an item written down,
    // recovered and written down again on one day collide with itself and skip
    // the third posting, leaving the register right and 1200 wrong.
    externalKey: `inventory:nrv:${a.item.id}:${a.on}:${a.qtyAfter}:${a.costAfter}:` +
      `${a.nrvFrom ?? "none"}>${a.nrvTo ?? "none"}:${a.held}>${a.required}`,
    lines: delta > 0n
      ? [
          { account: a.item.varianceAccount, debit: delta, memo: `${a.item.sku} written down to net realisable value` },
          { account: a.item.stockAccount, credit: delta, memo: `${a.item.sku} write-down` },
        ]
      : [
          { account: a.item.stockAccount, debit: -delta, memo: `${a.item.sku} write-down reversed` },
          { account: a.item.varianceAccount, credit: -delta, memo: `${a.item.sku} write-down reversed` },
        ],
  });

  return { entryId: entry.id, reference: `${entry.series}-${entry.number}` };
}

/**
 * Assess net realisable value and carry the stock at the lower of cost and it
 * (IAS 2.9).
 *
 * `nrvMinor` is the estimated selling price less the costs of completion and
 * sale, per whole unit. Where it is below cost the difference is written down
 * through the variance account; where a previous write-down is no longer
 * warranted it is reversed (IAS 2.33), but only as far as the original cost — a
 * reversal undoes a write-down, it never revalues stock upwards.
 *
 * Idempotent by construction rather than by a key: the allowance is derived from
 * the assessment, so recording the same assessment again asks for the same
 * allowance, and a difference of nothing posts nothing.
 */
export async function assessNrv(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  /** Net realisable value per whole unit, in minor units. Zero is a real answer. */
  nrvMinor: number | bigint | string | null | undefined;
  on: string;
  memo?: string;
  actorId?: string;
}) {
  if (opts.nrvMinor === null || opts.nrvMinor === undefined || opts.nrvMinor === "") {
    throw new LedgerError(
      "An assessment needs a net realisable value. Leaving the item unassessed and assessing it at nothing are " +
        "different statements, so the second one has to be said out loud.",
    );
  }
  const nrv = BigInt(opts.nrvMinor);
  if (nrv < 0n) throw new LedgerError("Net realisable value cannot be negative — the floor is nil, not a liability.");
  if (!opts.on || Number.isNaN(new Date(opts.on).getTime())) {
    throw new LedgerError("An assessment needs the date it was made.");
  }

  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  const held = writeDownHeld(item.valueMinor, item.quantityMilli, item.nrvMinor);
  const required = writeDownHeld(item.valueMinor, item.quantityMilli, nrv);

  const applied = await applyWriteDown({
    item, held, required, qtyAfter: item.quantityMilli, costAfter: item.valueMinor,
    nrvFrom: item.nrvMinor, nrvTo: nrv,
    on: opts.on, memo: opts.memo ?? nrvMemo(item.sku, required - held), actorId: opts.actorId,
  });

  // The assessment is recorded whether or not it changed anything: IAS 2.33 asks
  // for one every period, and an item nobody has looked at must not read the same
  // as one looked at and found sound.
  await prisma.inventoryItem.update({ where: { id: item.id }, data: { nrvMinor: nrv } });

  return {
    sku: item.sku,
    assessedOn: opts.on,
    entryId: applied.entryId,
    reference: applied.reference,
    quantityMilli: item.quantityMilli.toString(),
    nrvMinor: nrv.toString(),
    nrvTotalMinor: ((nrv * item.quantityMilli) / MILLI).toString(),
    costMinor: item.valueMinor.toString(),
    writeDownMinor: required.toString(),
    carryingMinor: (item.valueMinor - required).toString(),
    /** True where cost stood below net realisable value and nothing was written down. */
    atCost: required === 0n,
  };
}

const nrvMemo = (sku: string, delta: bigint) =>
  delta > 0n ? `Written down to net realisable value — ${sku}`
    : delta < 0n ? `Write-down reversed, net realisable value recovered — ${sku}`
      : `Net realisable value assessed, no write-down needed — ${sku}`;

const fmtQty = (milli: bigint) => {
  const neg = milli < 0n;
  const abs = neg ? -milli : milli;
  const whole = abs / MILLI;
  const frac = (abs % MILLI).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
};

const methodName = (m: string) => (m === "FIFO" ? "first-in-first-out" : "weighted average");

/**
 * The stock valuation report, against the ledger account it must agree with.
 *
 * Same principle as the fixed-asset register: two records, compared. A stock list
 * that has never been checked against 1200 is a list of hopes.
 *
 * The figure that ties is the carrying amount — cost less any write-down —
 * because that is what the write-down posted to 1200. Cost is shown beside it so
 * the difference between the two is visible rather than netted away.
 */
export async function stockValuation(opts: {
  orgId: string;
  entityId: string;
  /**
   * The date to draw the valuation at. Left out, it is the stock as it stands,
   * which is the right answer for the screen and the wrong one for a note about
   * a year that has already closed.
   */
  asOf?: Date | string;
}) {
  const asOf = opts.asOf === undefined || opts.asOf === null || opts.asOf === ""
    ? null
    : typeof opts.asOf === "string" ? new Date(opts.asOf) : opts.asOf;
  if (asOf && Number.isNaN(asOf.getTime())) throw new LedgerError("A valuation needs a date it can read.");

  const items = await prisma.inventoryItem.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { sku: "asc" },
  });
  const ids = items.map((i) => i.id);

  const codes = [...new Set(items.map((i) => i.stockAccount))];
  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: codes.length ? codes : ["1200"] } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);

  // At a past date the item's carried figures are the wrong ones — they are
  // today's. Quantity and cost come from the running balances on the movements,
  // which exist for exactly this; the write-down held comes from what the
  // assessments actually posted to the stock account by then, which is the only
  // record of it that is dated. The assessment itself is carried on the item and
  // is therefore current only, so a past-dated valuation reports the carrying
  // amount and the write-down behind it rather than restating an NRV per unit it
  // cannot know.
  const past = new Map<string, { qty: bigint; cost: bigint }>();
  const pastWriteDown = new Map<string, bigint>();
  if (asOf && ids.length) {
    const history = await prisma.inventoryMovement.findMany({
      where: { orgId: opts.orgId, itemId: { in: ids }, movedOn: { lte: asOf } },
      orderBy: [{ movedOn: "asc" }, { createdAt: "asc" }],
      select: { itemId: true, balanceQtyMilli: true, balanceValueMinor: true },
    });
    for (const m of history) past.set(m.itemId, { qty: m.balanceQtyMilli, cost: m.balanceValueMinor });

    if (accountIds.length) {
      const nrvLines = await prisma.journalLine.findMany({
        where: {
          orgId: opts.orgId, accountId: { in: accountIds },
          entry: {
            entityId: opts.entityId, source: "inventory", sourceType: { in: NRV_SOURCE_TYPES },
            sourceId: { in: ids }, status: { in: ["posted", "reversed"] }, entryDate: { lte: asOf },
          },
        },
        select: { functionalAmountMinor: true, entry: { select: { sourceId: true } } },
      });
      // A write-down credits the stock account, so the allowance is the negative
      // of what those postings did to it.
      for (const l of nrvLines) {
        const id = l.entry.sourceId;
        if (!id) continue;
        pastWriteDown.set(id, (pastWriteDown.get(id) ?? 0n) - l.functionalAmountMinor);
      }
    }
  }

  // How many open layers stand behind each FIFO item, so the screen can say
  // whether there is a record to open rather than making the reader click.
  // What is left of a layer is today's figure and no other, so a past-dated
  // valuation reports no count rather than today's dressed as then.
  const fifoIds = items.filter((i) => i.costMethod === "FIFO").map((i) => i.id);
  const layerCounts = new Map<string, number>();
  if (fifoIds.length && !asOf) {
    const grouped = await prisma.inventoryLayer.groupBy({
      by: ["itemId"],
      where: { orgId: opts.orgId, itemId: { in: fifoIds }, remainingMilli: { gt: 0n } },
      _count: { _all: true },
    });
    for (const g of grouped) layerCounts.set(g.itemId, g._count._all);
  }

  let registerCost = 0n;
  let registerWriteDown = 0n;
  const rows = items.map((i) => {
    const at = asOf ? past.get(i.id) ?? { qty: 0n, cost: 0n } : { qty: i.quantityMilli, cost: i.valueMinor };
    const nrv = asOf ? null : i.nrvMinor;
    const writeDown = asOf ? pastWriteDown.get(i.id) ?? 0n : writeDownHeld(at.cost, at.qty, nrv);
    registerCost += at.cost;
    registerWriteDown += writeDown;
    return {
      sku: i.sku, name: i.name, uom: i.uom, status: i.status,
      costMethod: i.costMethod,
      quantityMilli: at.qty.toString(),
      quantity: fmtQty(at.qty),
      costMinor: at.cost.toString(),
      unitCostMinor: unitCost(at.cost, at.qty).toString(),
      // Nil means nobody has assessed this item, which is a different fact from
      // an assessment of nothing and stays different all the way to the screen.
      nrvMinor: nrv === null ? null : nrv.toString(),
      nrvTotalMinor: nrv === null ? null : ((nrv * at.qty) / MILLI).toString(),
      writeDownMinor: writeDown.toString(),
      carryingMinor: (at.cost - writeDown).toString(),
      /** What 1200 carries for this item — the same figure, under the name the older report used. */
      valueMinor: (at.cost - writeDown).toString(),
      openLayers: asOf ? null : layerCounts.get(i.id) ?? 0,
    };
  });
  const registerValue = registerCost - registerWriteDown;

  const lines = accountIds.length
    ? await prisma.journalLine.findMany({
        // Both halves of a reversed pair, or the ledger side of this comparison is
        // short by the reversal and the valuation appears not to tie.
        where: {
          orgId: opts.orgId, accountId: { in: accountIds },
          entry: { status: { in: ["posted", "reversed"] }, ...(asOf ? { entryDate: { lte: asOf } } : {}) },
        },
        select: { functionalAmountMinor: true },
      })
    : [];
  const ledgerValue = lines.reduce((a, l) => a + l.functionalAmountMinor, 0n);

  return {
    asOf: asOf ? asOf.toISOString().slice(0, 10) : null,
    items: rows,
    totals: {
      costMinor: registerCost.toString(),
      writeDownMinor: registerWriteDown.toString(),
      carryingMinor: registerValue.toString(),
      valueMinor: registerValue.toString(),
    },
    ledger: {
      valueMinor: ledgerValue.toString(),
      // A register that does not tie to the ledger is the finding, so the gap is
      // reported rather than reconciled away.
      differenceMinor: (registerValue - ledgerValue).toString(),
      agrees: ledgerValue === registerValue,
    },
  };
}

/** The movement history for one item — where a valuation came from. */
export async function itemHistory(opts: { orgId: string; entityId: string; sku: string; limit?: number }) {
  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  const movements = await prisma.inventoryMovement.findMany({
    where: { orgId: opts.orgId, itemId: item.id },
    orderBy: [{ movedOn: "asc" }, { createdAt: "asc" }],
    take: opts.limit ?? 200,
  });
  // Under FIFO the layers are the record of what the stock cost, so they come
  // back with the history. Hiding them would leave nobody able to check the cost
  // of a sale, which is the one thing the method is chosen for.
  const layers = item.costMethod === "FIFO"
    ? oldestFirst(await prisma.inventoryLayer.findMany({ where: { orgId: opts.orgId, itemId: item.id } }))
    : [];
  // A write-down is not a movement of stock, so its record is the journal entry
  // it posted. Listing them beside the movements is what lets a reader see why
  // the carrying amount is below cost.
  const assessments = await prisma.journalEntry.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId, source: "inventory",
      sourceType: { in: NRV_SOURCE_TYPES }, sourceId: item.id, status: { in: ["posted", "reversed"] },
    },
    orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
    select: { id: true, entryDate: true, series: true, number: true, sourceType: true, memo: true, lines: { select: { accountId: true, functionalAmountMinor: true } } },
  });
  const stockAccount = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: item.stockAccount },
    select: { id: true },
  });
  const writeDown = writeDownHeld(item.valueMinor, item.quantityMilli, item.nrvMinor);

  return {
    item: {
      sku: item.sku, name: item.name, uom: item.uom,
      costMethod: item.costMethod,
      quantityMilli: item.quantityMilli.toString(),
      quantity: fmtQty(item.quantityMilli),
      costMinor: item.valueMinor.toString(),
      nrvMinor: item.nrvMinor === null ? null : item.nrvMinor.toString(),
      nrvTotalMinor: item.nrvMinor === null ? null : ((item.nrvMinor * item.quantityMilli) / MILLI).toString(),
      writeDownMinor: writeDown.toString(),
      carryingMinor: (item.valueMinor - writeDown).toString(),
    },
    layers: layers.map((l) => ({
      seq: l.seq,
      receivedOn: l.receivedOn.toISOString().slice(0, 10),
      quantityMilli: l.quantityMilli.toString(),
      quantity: fmtQty(l.quantityMilli),
      remainingMilli: l.remainingMilli.toString(),
      remaining: fmtQty(l.remainingMilli),
      unitCostMinor: l.unitCostMinor.toString(),
      remainingValueMinor: layerValue(l).toString(),
      exhausted: l.remainingMilli === 0n,
      movementId: l.movementId,
    })),
    assessments: assessments.map((e) => ({
      entryId: e.id,
      on: e.entryDate.toISOString().slice(0, 10),
      reference: `${e.series}-${e.number}`,
      kind: e.sourceType,
      memo: e.memo,
      // Signed the way the item feels it: negative where the write-down grew.
      valueMinor: e.lines
        .filter((l) => l.accountId === stockAccount?.id)
        .reduce((a, l) => a + l.functionalAmountMinor, 0n)
        .toString(),
    })),
    movements: movements.map((m) => ({
      id: m.id,
      movedOn: m.movedOn.toISOString().slice(0, 10),
      kind: m.kind,
      quantity: fmtQty(m.quantityMilli),
      quantityMilli: m.quantityMilli.toString(),
      valueMinor: m.valueMinor.toString(),
      unitCostMinor: m.unitCostMinor.toString(),
      balanceQtyMilli: m.balanceQtyMilli.toString(),
      balanceQuantity: fmtQty(m.balanceQtyMilli),
      balanceValueMinor: m.balanceValueMinor.toString(),
      reference: m.reference,
      memo: m.memo,
      entryId: m.entryId,
    })),
  };
}
