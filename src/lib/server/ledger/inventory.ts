import { prisma } from "@/lib/server/prisma";
import { Prisma } from "@prisma/client";
import { post, LedgerError, type PostInput } from "./post";
import { planConsumption, settleTakes, effectiveUnitCost, layerValue, oldestFirst, type LayerTake } from "./inventory-fifo";
import {
  apportion, batchPut, batchTake, daysUntil, expiryHorizon, readBatchKind, reorderVerdict,
  resolveLocation, tieBatches, type BatchKind,
} from "./inventory-tracking";

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
 * Locations, batches and expiry are those same four opinions applied to where
 * the goods are rather than to what they cost:
 *
 *  - A location holds a quantity, never a cost of its own. The item stays the
 *    authority on value, so a value per location is derived by apportioning the
 *    item's own — and the shares add back to it exactly rather than nearly.
 *  - A transfer between locations posts nothing at all. The goods have not left
 *    the business, nobody has been billed and nothing has been consumed, so no
 *    cost has moved and an entry would be inventing a transaction out of a
 *    forklift ride. It is still two movements, because one row cannot say that
 *    a quantity left A and arrived at B — and if it cannot say that, neither
 *    location's quantity is right.
 *  - Where an item is tracked by batch, a receipt into it and an issue out of it
 *    both name the batch. A guess about which lot went out is how a recall
 *    becomes impossible to trace, and a receipt with no batch would create
 *    stock that no later issue could name. A stock count is exempt, because a
 *    count is evidence about the shelf rather than an instruction: refusing to
 *    record what is there because the counter could not read a label would be
 *    worse than the gap, and the batch reconciliation reports the gap.
 *  - Expired stock still on the shelf is worth nothing. Carrying it at cost
 *    overstates the balance sheet, so the sweep writes it off through the
 *    ledger like any other loss instead of merely relabelling it.
 *
 * Two clerks at one SKU is the case every one of those opinions is decided
 * against, and it used to be the case none of them survived:
 *
 *  - Every movement read the item, worked out what the item would hold
 *    afterwards, posted, and then SET `quantityMilli` and `valueMinor` to the
 *    figures it had worked out. Two issues from one SKU both posted real cost
 *    of goods sold and the item card ended at one of the two answers, so the
 *    stock ledger and account 1200 disagreed permanently while the journal
 *    still balanced — the worst shape a defect can take here, because nothing
 *    on any screen says anything is wrong.
 *  - Equal quantities were worse still. Both issues computed the same closing
 *    balance, the posting key was made out of that balance, so the second
 *    posting was recognised as a retry of the first and never happened: two
 *    despatch notes, one charge to cost of sales.
 *
 * So the item's own row is the lock, and every figure a movement is settled
 * against is read while holding it (see `record`). The write is an INCREMENT of
 * what the row already holds rather than a SET of what the caller expected it
 * to hold, `InventoryItem_quantity_check` is what actually refuses an overdraw,
 * and a posting is keyed on the movement's own identity — which is unique to it
 * however many identical movements there are.
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

/**
 * Either the client or a transaction of it.
 *
 * Every read a movement is settled against takes one of these, because those
 * reads have to happen inside the transaction that holds the item's row — see
 * `record`. The same helpers still serve the reports, which pass `prisma` and
 * hold nothing.
 */
type Db = Prisma.TransactionClient;

/** What the item holds, as its own row states it. */
interface Held {
  quantityMilli: bigint;
  valueMinor: bigint;
  nrvMinor: bigint | null;
}

async function loadItem(orgId: string, entityId: string, sku: string) {
  const item = await prisma.inventoryItem.findFirst({ where: { orgId, entityId, sku } });
  if (!item) throw new LedgerError(`SKU ${sku} is not on the item list.`);
  if (item.status !== "active") throw new LedgerError(`SKU ${sku} is archived.`);
  return item;
}

/**
 * Take the item's row, and hold it until the transaction ends.
 *
 * The update is what takes the lock; the row it hands back is what the row
 * actually holds now, which is the whole point. A second clerk moving the same
 * SKU waits here and then settles against what the first one left, rather than
 * against the copy their own request read a moment earlier.
 */
async function lockItem(tx: Db, item: ItemRow): Promise<Held> {
  const row = await tx.inventoryItem.update({ where: { id: item.id }, data: { updatedAt: new Date() } });
  return { quantityMilli: row.quantityMilli, valueMinor: row.valueMinor, nrvMinor: row.nrvMinor };
}

/** The open layers of a FIFO item, oldest first. Scoped by org as well as item. */
async function openLayers(tx: Db, item: ItemRow) {
  const rows = await tx.inventoryLayer.findMany({
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
 * it. So a reference is the only thing that stops a complete, successful act
 * repeated in full from moving stock twice.
 *
 * The half-failed case — the stock moved and the posting did not — is not left
 * to this. The movement is written before the entry, keyed on it, and taken
 * back out if the entry is refused; see `record` and `postForMovement`.
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
 * It names the movement, and nothing else. The key used to name the position
 * the item was being moved *to* — item, kind and the two closing balances —
 * which is exactly the guess that fails when two people move one SKU at once:
 * two issues of 50 from a shelf of 200 both compute a closing balance of 150,
 * so they carry the same key, so only one of them ever posts. Two despatch
 * notes, one charge to cost of sales, and the difference sits in 1200 for good.
 *
 * The movement's row id cannot collide, because the database made it. It is
 * available because the movement is now written before the entry is posted
 * rather than after — see `record`, and `postForMovement` for what happens when
 * the posting is refused.
 */
const movementKey = (kind: string, movementId: string) => `inventory:${kind.toLowerCase()}:${movementId}`;

/* --------------------------------------------- where the goods actually are */

/**
 * Transfer legs carry their reference under a namespace of the module's own.
 *
 * The database allows a movement four kinds and a transfer is not one of them,
 * so a transfer borrows ISSUE for the leg that leaves and RECEIPT for the leg
 * that arrives — which is, after all, what happened at each shelf. Without the
 * prefix a despatch note and a transfer note carrying the same number on the
 * same day would look to `priorMovement` like retries of one another, and one
 * of the two would silently never happen.
 */
const TRANSFER_REF = "TRF/";

type LocationRow = NonNullable<Awaited<ReturnType<typeof prisma.stockLocation.findFirst>>>;
type BatchRow = NonNullable<Awaited<ReturnType<typeof prisma.stockBatch.findFirst>>>;

/** A batch or serial named on a receipt. */
export interface BatchRef {
  code: string;
  /** BATCH or SERIAL. A serial is one unit and cannot be split. */
  kind?: string;
  /** When the goods go off, where they do. */
  expiresOn?: string | null;
}

async function loadLocation(orgId: string, entityId: string, code: string): Promise<LocationRow> {
  const loc = await prisma.stockLocation.findFirst({ where: { orgId, entityId, code: code.trim() } });
  if (!loc) throw new LedgerError(`There is no stock location called ${code.trim()}. Add it before moving stock through it.`);
  return loc;
}

const entityDefaultLocation = (orgId: string, entityId: string) =>
  prisma.stockLocation.findFirst({ where: { orgId, entityId, isDefault: true, status: "active" } });

/**
 * Where a movement lands: what the caller said, then the item's own shelf, then
 * the entity's default, then nowhere.
 *
 * Nowhere is a real answer and is reported as unassigned rather than quietly
 * attributed to whichever location happens to exist. A business that has never
 * opened a second warehouse should not have to invent one to record a receipt.
 */
async function movementLocation(item: ItemRow, explicit?: string): Promise<LocationRow | null> {
  if (explicit?.trim()) {
    const loc = await loadLocation(item.orgId, item.entityId, explicit);
    if (loc.status !== "active") {
      throw new LedgerError(`${loc.code} ${loc.name} is closed, so no stock can move through it.`);
    }
    return loc;
  }
  // A closed location holds nothing by definition, so an item whose own shelf
  // has since been closed falls through to the entity's default. Recording the
  // goods into the closed one would be a statement about where they are that is
  // known to be false.
  const own = item.defaultLocationId
    ? await prisma.stockLocation.findFirst({
        where: { id: item.defaultLocationId, orgId: item.orgId, entityId: item.entityId, status: "active" },
      })
    : null;
  const fallback = own ? null : await entityDefaultLocation(item.orgId, item.entityId);
  return resolveLocation(null, own?.id, fallback?.id) ? (own ?? fallback) : null;
}

/** What one location holds of one item, from the movements that named it. */
async function heldAt(tx: Db, item: ItemRow, locationId: string): Promise<bigint> {
  const g = await tx.inventoryMovement.aggregate({
    where: { orgId: item.orgId, itemId: item.id, locationId },
    _sum: { quantityMilli: true },
  });
  return g._sum.quantityMilli ?? 0n;
}

/** Has this item ever been recorded anywhere in particular? */
async function everLocated(tx: Db, item: ItemRow): Promise<boolean> {
  const n = await tx.inventoryMovement.count({
    where: { orgId: item.orgId, itemId: item.id, locationId: { not: null } },
  });
  return n > 0;
}

/**
 * Refuse to take out of a location more than it holds — the third opinion, one
 * shelf at a time.
 *
 * It only applies once the item has been recorded somewhere in particular. An
 * item whose stock all predates the first location is not sitting at nil
 * everywhere; it is sitting somewhere nobody has said, and refusing every issue
 * of it would punish the business for having opened a warehouse.
 */
async function refuseOverdraw(tx: Db, item: ItemRow, location: LocationRow, qty: bigint) {
  if (!(await everLocated(tx, item))) return;
  const held = await heldAt(tx, item, location.id);
  if (qty > held) {
    throw new LedgerError(
      `${location.code} holds ${fmtQty(held)} ${item.uom} of ${item.sku}, and ${fmtQty(qty)} was taken out of it. ` +
        `Stock that is somewhere else has to be transferred before it can leave from here.`,
    );
  }
}

/** An item is tracked by batch once anything has ever been booked into one. */
async function isBatchTracked(tx: Db, item: ItemRow): Promise<boolean> {
  const n = await tx.stockBatch.count({
    where: { orgId: item.orgId, entityId: item.entityId, itemId: item.id },
  });
  return n > 0;
}

/**
 * The batch a receipt names — found where it already exists, opened where it
 * does not.
 *
 * The batch is not created here: it is described, and `record` brings it into
 * existence inside the same transaction as the movement (see the note there).
 */
async function intoBatch(
  tx: Db, item: ItemRow, ref: BatchRef, qty: bigint, on: string, locationId: string | null,
): Promise<{ batchId?: string; openBatch?: Settled["openBatch"]; batchDelta: bigint }> {
  const code = ref.code?.trim();
  if (!code) throw new LedgerError("A tracked lot needs a code — that is the whole of what a batch number is for.");

  const expiresOn = ref.expiresOn ? new Date(ref.expiresOn) : null;
  if (expiresOn && Number.isNaN(expiresOn.getTime())) {
    throw new LedgerError(`Batch ${code} needs an expiry date that can be read, or none at all.`);
  }
  if (expiresOn && expiresOn < new Date(on)) {
    throw new LedgerError(`Batch ${code} of ${item.sku} would expire on ${iso(expiresOn)}, before it arrived on ${on}.`);
  }

  const existing = await tx.stockBatch.findFirst({
    where: { orgId: item.orgId, entityId: item.entityId, itemId: item.id, code },
  });

  // Whether a lot is a batch or a serial is a fact about the goods, settled the
  // first time the code was seen. A caller who does not say inherits it rather
  // than silently asserting the default and being refused for disagreeing with
  // a record it never mentioned.
  const stated = ref.kind?.trim() ? readBatchKind(ref.kind) : null;
  if (ref.kind?.trim() && !stated) {
    throw new LedgerError(`"${ref.kind}" is not a kind of lot. A tracked lot is a BATCH or a SERIAL.`);
  }
  const kind = stated ?? ((existing?.kind as BatchKind) || "BATCH");

  if (existing) {
    if (existing.kind !== kind) {
      throw new LedgerError(
        `${code} is already a ${existing.kind === "SERIAL" ? "serial number" : "batch"} of ${item.sku}. ` +
          `One code cannot be both.`,
      );
    }
    // An expiry date is a fact about the goods, not an opinion the receiving
    // clerk holds. Two receipts into one batch cannot disagree about when it
    // goes off, because only one of them can be right.
    if (expiresOn && existing.expiresOn && expiresOn.getTime() !== existing.expiresOn.getTime()) {
      throw new LedgerError(
        `Batch ${code} of ${item.sku} already expires on ${iso(existing.expiresOn)}, not ${iso(expiresOn)}. ` +
          `Receive the later goods as their own batch.`,
      );
    }
    const room = batchPut({ kind, heldMilli: existing.quantityMilli, addingMilli: qty });
    if (!room.ok) throw serialRefusal(item, code, room.reason, qty);
    return { batchId: existing.id, batchDelta: qty };
  }

  const room = batchPut({ kind, heldMilli: 0n, addingMilli: qty });
  if (!room.ok) throw serialRefusal(item, code, room.reason, qty);
  return {
    openBatch: { code, kind, receivedOn: on, expiresOn, locationId },
    batchDelta: qty,
  };
}

function serialRefusal(item: ItemRow, code: string, reason: "serial-split" | "serial-reused", qty: bigint) {
  return reason === "serial-reused"
    ? new LedgerError(
        `Serial ${code} of ${item.sku} is already on the shelf. A serial number identifies one thing, ` +
          `so the same number cannot arrive twice.`,
      )
    : new LedgerError(
        `Serial ${code} of ${item.sku} is one ${item.uom}, and ${fmtQty(qty)} was recorded against it. ` +
          `A serial number cannot be split — number the units separately.`,
      );
}

/**
 * The batch a movement takes out of.
 *
 * Where the item is tracked by batch, an unnamed batch is refused rather than
 * guessed at. Which lot left is the only thing a recall has to go on, and the
 * system knowing "some of them" is the same as it knowing nothing.
 */
async function outOfBatch(
  tx: Db, item: ItemRow, code: string | undefined, qty: bigint, act: string,
  /**
   * Quarantined goods still have to be moved — usually into a quarantine bay,
   * which is the whole point of having one. Refusing to move them leaves them
   * on the shelf beside the good stock, which is worse than letting them go.
   */
  quarantineOk = false,
): Promise<{ batchId: string | null; batchDelta: bigint; batch: BatchRow | null }> {
  const named = code?.trim();
  if (!named) {
    if (!(await isBatchTracked(tx, item))) return { batchId: null, batchDelta: 0n, batch: null };
    throw new LedgerError(
      `${item.sku} is tracked by batch, so ${act} has to say which batch it came out of. ` +
        `Guessing which lot went out is how a recall becomes impossible to trace.`,
    );
  }

  const batch = await tx.stockBatch.findFirst({
    where: { orgId: item.orgId, entityId: item.entityId, itemId: item.id, code: named },
  });
  if (!batch) throw new LedgerError(`There is no batch ${named} of ${item.sku}.`);
  if (batch.status === "quarantined" && !quarantineOk) {
    throw new LedgerError(`Batch ${named} of ${item.sku} is quarantined. Release it or write it off — it cannot be sold from quarantine.`);
  }
  if (batch.status === "expired") {
    throw new LedgerError(`Batch ${named} of ${item.sku} has been written off as expired, so there is nothing in it to take.`);
  }

  const verdict = batchTake({ kind: batch.kind as BatchKind, heldMilli: batch.quantityMilli, wantedMilli: qty });
  if (!verdict.ok) {
    if (verdict.reason === "serial-split") {
      throw new LedgerError(
        `Serial ${named} of ${item.sku} is one ${item.uom} and goes whole or not at all; ${fmtQty(qty)} was asked for. ` +
          `A serial number that identifies half a thing identifies nothing.`,
      );
    }
    throw new LedgerError(
      `Batch ${named} of ${item.sku} holds ${fmtQty(verdict.heldMilli)} ${item.uom}, and ${fmtQty(qty)} was taken from it. ` +
        `Taking more than a batch holds means the next batch is going out, not that this one owes goods.`,
    );
  }
  return { batchId: batch.id, batchDelta: -qty, batch };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

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
  /** Which location took the goods in. Left out, the item's shelf, then the entity's default. */
  location?: string;
  /** The batch or serial that arrived. Required where the item is already tracked by batch. */
  batch?: BatchRef;
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

  const location = await movementLocation(item, opts.location);
  if (!opts.batch && (await isBatchTracked(prisma, item))) {
    throw new LedgerError(
      `${item.sku} is tracked by batch, so a receipt has to say which batch arrived. ` +
        `Stock booked into no batch is stock that no later issue could name.`,
    );
  }

  const fifo = item.costMethod === "FIFO";
  return record({
    item, movedOn: opts.movedOn, ref: opts.reference, memo: opts.memo, actorId: opts.actorId,
    // A receipt's own quantity and cost are the caller's, not the item's, so
    // nothing here depends on what the shelf held — but the batch it goes into
    // does, and a serial number already on the shelf has to be refused against
    // the register as it stands rather than as this request read it.
    settle: async (tx) => ({
      kind: "RECEIPT",
      qty,
      value,
      locationId: location?.id ?? null,
      ...(opts.batch ? await intoBatch(tx, item, opts.batch, qty, opts.movedOn, location?.id ?? null) : {}),
      // Under FIFO the receipt's own rate is the movement's rate; a running
      // average would describe stock this receipt is not part of.
      rate: fifo ? effectiveUnitCost(value, qty) : undefined,
      openLayer: fifo ? { receivedOn: opts.movedOn, quantityMilli: qty, unitCostMinor: effectiveUnitCost(value, qty) } : undefined,
    }),
    entryFor: opts.alreadyPosted || value === 0n ? undefined : (s, movementId) => ({
      orgId: opts.orgId, entityId: opts.entityId, entryDate: opts.movedOn,
      memo: opts.memo ?? `Stock received — ${item.sku}`,
      source: "inventory", sourceType: "RECEIPT", sourceId: item.id,
      externalKey: movementKey(s.kind, movementId),
      actorType: "HUMAN", actorId: opts.actorId, series: "IN",
      lines: [
        { account: item.stockAccount, debit: value, memo: `${item.sku} ${item.name}` },
        { account: opts.contraAccount ?? "2000", credit: value, memo: `${item.sku} received` },
      ],
    }),
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
  /** Which location the goods left. Left out, the item's shelf, then the entity's default. */
  location?: string;
  /** Which batch or serial left. Required where the item is tracked by batch. */
  batch?: string;
  actorId?: string;
}): Promise<MovementResult> {
  const qty = BigInt(opts.quantityMilli);
  if (qty <= 0n) throw new LedgerError("An issue has to be a positive quantity.");

  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  // The despatch note says how many went out, not what they cost, so the cost is
  // not part of what identifies the movement.
  const seen = await priorMovement(item, ["ISSUE"], opts.reference, { movedOn: opts.movedOn, quantityMilli: -qty });
  if (seen) return replay(item, seen);

  const location = await movementLocation(item, opts.location);

  return record({
    item, movedOn: opts.movedOn, ref: opts.reference, memo: opts.memo, actorId: opts.actorId,
    // Everything an issue costs depends on what the item holds, so all of it is
    // worked out here, against the row this transaction is holding. The
    // refusal below is the sentence a stock controller reads when they are the
    // only one issuing; `InventoryItem_quantity_check` is what refuses the
    // loser when they are not.
    settle: async (tx, held) => {
      if (qty > held.quantityMilli) {
        throw new LedgerError(
          `There are only ${fmtQty(held.quantityMilli)} ${item.uom} of ${item.sku} in stock, and ${fmtQty(qty)} was issued. ` +
            `A receipt is probably missing — issuing stock the system has no cost for would mean inventing one.`,
        );
      }
      if (location) await refuseOverdraw(tx, item, location, qty);
      const lot = await outOfBatch(tx, item, opts.batch, qty, "an issue");
      const consumed = await consume(tx, item, held, qty);
      return {
        kind: "ISSUE",
        qty: -qty,
        value: -consumed.costMinor,
        rate: consumed.rate,
        takes: consumed.takes,
        locationId: location?.id ?? null,
        batchId: lot.batchId,
        batchDelta: lot.batchDelta,
      };
    },
    // Stock that cost nothing raises no entry, and what it cost is only known
    // once the item has been asked — so the decision is made on the settled
    // figure rather than on anything read beforehand.
    entryFor: (s, movementId) => s.value === 0n ? null : {
      orgId: opts.orgId, entityId: opts.entityId, entryDate: opts.movedOn,
      memo: opts.memo ?? `Stock issued — ${item.sku}`,
      source: "inventory", sourceType: "ISSUE", sourceId: item.id,
      externalKey: movementKey(s.kind, movementId),
      actorType: "HUMAN", actorId: opts.actorId, series: "IN",
      lines: [
        { account: item.cogsAccount, debit: -s.value, memo: `${item.sku} ${item.name}` },
        { account: item.stockAccount, credit: -s.value, memo: `${item.sku} issued` },
      ],
    },
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
  /** Which location was counted. Left out, the item's shelf, then the entity's default. */
  location?: string;
  /**
   * Which batch the difference was found in, where the counter could tell. A
   * count is evidence rather than an instruction, so this is never required —
   * see the header, and the batch reconciliation that reports the gap.
   */
  batch?: string;
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

  const location = await movementLocation(item, opts.location);
  const fifo = item.costMethod === "FIFO";

  return record({
    item, movedOn: opts.movedOn, ref: opts.reference, memo: opts.reason, actorId: opts.actorId,
    // A count is a statement about the shelf, so the difference it closes is
    // the difference against what the system says NOW. Working it out from a
    // figure read a moment earlier would post a variance for stock that has
    // since been issued, and issue that stock a second time.
    settle: async (tx, held) => {
      const delta = counted - held.quantityMilli;
      if (delta === 0n) {
        throw new LedgerError(`The count agrees with the system: ${fmtQty(counted)} ${item.uom}. Nothing to adjust.`);
      }
      const named = opts.batch?.trim();
      const lot = !named
        ? null
        : delta < 0n
          ? await outOfBatch(tx, item, named, -delta, "a count")
          : await intoBatch(tx, item, { code: named }, delta, opts.movedOn, location?.id ?? null);

      const rate = unitCost(held.valueMinor, held.quantityMilli);
      // A surplus is valued at the current average — it has no receipt behind it, so
      // it has no cost of its own. A shortfall removes what that quantity was
      // carried at: oldest first under FIFO, at the average otherwise, and the last
      // unit takes the remainder either way.
      const shortfall = delta < 0n ? await consume(tx, item, held, -delta) : null;
      return {
        kind: delta < 0n ? "WRITE_OFF" : "ADJUSTMENT",
        qty: delta,
        value: shortfall ? -shortfall.costMinor : (rate * delta) / MILLI,
        rate: fifo ? (shortfall ? shortfall.rate : rate) : undefined,
        takes: shortfall?.takes,
        locationId: location?.id ?? null,
        batchId: lot?.batchId,
        openBatch: lot && "openBatch" in lot ? lot.openBatch : undefined,
        batchDelta: lot?.batchDelta,
        // A counted surplus takes its place as the newest layer: the system has no
        // evidence it arrived earlier, and dating it earlier would put a cost in
        // front of receipts that really were earlier.
        openLayer: fifo && delta > 0n
          ? { receivedOn: opts.movedOn, quantityMilli: delta, unitCostMinor: rate }
          : undefined,
      };
    },
    entryFor: (s, movementId) => s.value === 0n ? null : {
      orgId: opts.orgId, entityId: opts.entityId, entryDate: opts.movedOn,
      memo: opts.reason ?? `Stock adjustment — ${item.sku}`,
      source: "inventory", sourceType: "ADJUSTMENT", sourceId: item.id,
      externalKey: movementKey(s.kind, movementId),
      actorType: "HUMAN", actorId: opts.actorId, series: "IA",
      lines: s.value > 0n
        ? [
            { account: item.stockAccount, debit: s.value, memo: `${item.sku} surplus on count` },
            { account: item.varianceAccount, credit: s.value, memo: `${item.sku} surplus` },
          ]
        : [
            { account: item.varianceAccount, debit: -s.value, memo: `${item.sku} shortfall` },
            { account: item.stockAccount, credit: -s.value, memo: `${item.sku} shortfall on count` },
          ],
    },
  });
}

/**
 * What a quantity coming out of an item costs, by whichever method it is on.
 *
 * The two methods deliberately disagree — that is the whole reason a business
 * chooses one — so this is the single place the choice is made, and everything
 * that takes stock out goes through it.
 */
async function consume(
  tx: Db, item: ItemRow, held: Held, qtyMilli: bigint,
): Promise<{ costMinor: bigint; rate?: bigint; takes?: LayerTake[] }> {
  if (item.costMethod !== "FIFO") return { costMinor: issueValue(held, qtyMilli) };

  const layers = await openLayers(tx, item);
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
  const costMinor = qtyMilli >= held.quantityMilli ? held.valueMinor : plan.costMinor;
  return {
    costMinor,
    rate: effectiveUnitCost(costMinor, qtyMilli),
    takes: settleTakes(plan.takes, costMinor),
  };
}

/**
 * What a movement comes to, once the item's own row has said what it holds.
 *
 * Everything here is decided inside the transaction that holds that row, which
 * is why it is a return value rather than an argument: a caller cannot know an
 * issue's cost, a count's difference or a surplus's rate before the item has
 * been asked, and every attempt to know them beforehand is a figure that some
 * other clerk's movement can invalidate between the reading and the writing.
 */
interface Settled {
  /** RECEIPT, ISSUE, ADJUSTMENT, WRITE_OFF or LANDED_COST — a count picks between two. */
  kind: string;
  /** Signed thousandths: a receipt is positive, an issue negative. */
  qty: bigint;
  /** Signed minor units, matching the quantity's direction. */
  value: bigint;
  /** The effective unit cost of this movement, where the running average is not the answer. */
  rate?: bigint;
  openLayer?: { receivedOn: string; quantityMilli: bigint; unitCostMinor: bigint };
  takes?: LayerTake[];
  /** Where the goods moved, and which tracked lot they were. */
  locationId?: string | null;
  batchId?: string | null;
  /** A batch this movement brings into existence, opened in the same act. */
  openBatch?: {
    code: string; kind: BatchKind; receivedOn: string;
    expiresOn: Date | null; locationId: string | null;
  };
  /** Signed change to that batch's own quantity. */
  batchDelta?: bigint;
  /**
   * Cost added to one open FIFO layer with no quantity moving — landed cost.
   *
   * The layer named is the receipt the charge actually applied to, so the cost
   * lands on the goods it brought in rather than on whatever happens to be open.
   * Spreading it across every layer would say the freight applied to shipments
   * it never touched.
   */
  addToLayer?: { movementId: string; addMinor: bigint };
}

/** A settled movement, and the balances the item was left at. */
interface Recorded extends Settled {
  movementId: string;
  itemId: string;
  /** The item as the transaction found it — what the write-down moves from. */
  before: Held;
  newQty: bigint;
  newValue: bigint;
  unitCostMinor: bigint;
  /** What has to be taken back if the posting is refused. */
  openedLayerId: string | null;
  openedBatchId: string | null;
  /** The lot's status before this movement settled it, so an undo can restore it. */
  batchWasStatus: string | null;
  /** The landed-cost layer's rate before the charge was spread onto it. */
  layerWasCost: { id: string; unitCostMinor: bigint } | null;
}

interface RecordInput {
  item: ItemRow;
  movedOn: string;
  /**
   * What this movement is, worked out against the item's own row inside the
   * transaction that holds it. Refusals that depend on what is in stock belong
   * here rather than in the caller, because a check made outside the lock is a
   * check made against a figure somebody else is free to change.
   */
  settle: (tx: Db, held: Held) => Promise<Settled>;
  /** The entry the movement raises, given what it settled at. Nil raises none. */
  entryFor?: (settled: Settled, movementId: string) => PostInput | null;
  /** An entry the caller has already posted for this movement — see `capitaliseCost`. */
  given?: { entryId: string | null; reference: string | null };
  ref?: string;
  memo?: string;
  actorId?: string;
}

/**
 * Move the stock, then post for it.
 *
 * That order is the fix for the defect described at the top of this file, and
 * it is worth saying why it is the order rather than the other one.
 *
 * The item's row is taken first and held for the whole transaction, so the
 * figures the movement is settled against are the committed ones and a second
 * clerk moving the same SKU waits rather than overwriting. The item is then
 * INCREMENTED by what this movement moves rather than SET to what the caller
 * expected the total to become — so even if the lock were somehow not held, two
 * movements would add up instead of one erasing the other, and
 * `InventoryItem_quantity_check` would refuse the result if it went negative.
 * The balances written onto the movement row are read back out of that
 * increment, so the row says what the database ended up holding rather than
 * what this request predicted.
 *
 * The posting cannot join that transaction — `post()` opens one of its own, on
 * its own connection, and an entry written inside this one would commit
 * separately anyway — so it happens after, keyed on the movement's row id,
 * which is unique to it however many identical movements there are. A posting
 * that is then refused takes the movement back out with it (see
 * `postForMovement`): a movement that changed the stock and reached no ledger
 * is exactly the disagreement between the register and account 1200 that this
 * whole arrangement exists to prevent.
 *
 * The item, its movement, its layers and its batches still commit together. An
 * item updated without a movement is stock with no history; a movement without
 * the update is history that does not add up; a consumed layer that outlived a
 * rolled-back issue would hand the next sale someone else's cost; and a batch
 * that outlived one would send a recall to a shelf that was never emptied.
 */
async function record(a: RecordInput): Promise<MovementResult> {
  const done = await prisma.$transaction(async (tx): Promise<Recorded> => {
    const before = await lockItem(tx, a.item);
    const s = await a.settle(tx, before);

    // The batch is opened before the movement so the movement can name it. A
    // batch created outside this transaction and left behind by a failed
    // movement would make the item batch-tracked on the strength of a receipt
    // that never happened, and every later issue would be refused for naming no
    // batch of a register that holds nothing.
    let batchId = s.batchId ?? null;
    let openedBatchId: string | null = null;
    if (s.openBatch) {
      const opened = await tx.stockBatch.create({
        data: {
          orgId: a.item.orgId, entityId: a.item.entityId, itemId: a.item.id,
          code: s.openBatch.code, kind: s.openBatch.kind,
          receivedOn: new Date(s.openBatch.receivedOn),
          expiresOn: s.openBatch.expiresOn,
          locationId: s.openBatch.locationId,
          quantityMilli: 0n,
        },
      });
      batchId = opened.id;
      openedBatchId = opened.id;
    }

    const moved = await tx.inventoryItem.update({
      where: { id: a.item.id },
      data: { quantityMilli: { increment: s.qty }, valueMinor: { increment: s.value } },
    });
    // Weighted average records the running average after the movement, because
    // that is what the remaining stock is worth. FIFO has no such number, so the
    // caller supplies the effective unit cost of the movement itself.
    const rate = s.rate ?? unitCost(moved.valueMinor, moved.quantityMilli);

    const created = await tx.inventoryMovement.create({
      data: {
        orgId: a.item.orgId, itemId: a.item.id, movedOn: new Date(a.movedOn),
        kind: s.kind, quantityMilli: s.qty, valueMinor: s.value,
        unitCostMinor: rate, balanceQtyMilli: moved.quantityMilli, balanceValueMinor: moved.valueMinor,
        reference: a.ref?.trim() || null, memo: a.memo ?? null, entryId: a.given?.entryId ?? null,
        locationId: s.locationId ?? null, batchId,
      },
    });

    let openedLayerId: string | null = null;
    if (s.openLayer) {
      const top = await tx.inventoryLayer.aggregate({ where: { itemId: a.item.id }, _max: { seq: true } });
      const layer = await tx.inventoryLayer.create({
        data: {
          orgId: a.item.orgId, itemId: a.item.id, seq: (top._max.seq ?? 0) + 1,
          receivedOn: new Date(s.openLayer.receivedOn),
          quantityMilli: s.openLayer.quantityMilli,
          remainingMilli: s.openLayer.quantityMilli,
          unitCostMinor: s.openLayer.unitCostMinor,
          movementId: created.id,
        },
      });
      openedLayerId = layer.id;
    }
    for (const t of s.takes ?? []) {
      // The database refuses a layer with less than nothing left, so an issue that
      // somehow took more than a layer holds fails rather than borrowing.
      await tx.inventoryLayer.update({
        where: { id: t.layerId },
        data: { remainingMilli: { decrement: t.quantityMilli } },
      });
    }

    let layerWasCost: Recorded["layerWasCost"] = null;
    if (s.addToLayer) {
      const layer = await tx.inventoryLayer.findFirst({
        where: { orgId: a.item.orgId, itemId: a.item.id, movementId: s.addToLayer.movementId },
      });
      if (!layer || layer.remainingMilli <= 0n) {
        throw new LedgerError(
          `The receipt that cost is being added to has nothing left of it on the shelf, so there is no ` +
            `${a.item.sku} for it to be carried on. A charge on goods that have all gone belongs in cost of sales.`,
        );
      }
      // The layer's unit cost is restated from what it now holds: what was left
      // of it, plus the share of the charge those goods brought in. Flooring can
      // leave the layer a fils under the item's own figure, which is the
      // standing arrangement here — the item is the authority on the total and
      // the issue that empties it takes the whole remainder.
      const heldMinor = layerValue(layer);
      layerWasCost = { id: layer.id, unitCostMinor: layer.unitCostMinor };
      await tx.inventoryLayer.update({
        where: { id: layer.id },
        data: { unitCostMinor: ((heldMinor + s.addToLayer.addMinor) * MILLI) / layer.remainingMilli },
      });
    }

    let batchWasStatus: string | null = null;
    if (batchId && s.batchDelta) {
      const lot = await tx.stockBatch.update({
        where: { id: batchId },
        data: { quantityMilli: { increment: s.batchDelta } },
      });
      batchWasStatus = lot.status;
      // A batch with nothing left is not stock any more, and a register that
      // still lists it sends a picker to an empty shelf. It comes back if a
      // later count puts something into it.
      const settled = lot.quantityMilli === 0n ? "consumed" : "active";
      if ((lot.status === "active" || lot.status === "consumed") && lot.status !== settled) {
        await tx.stockBatch.update({ where: { id: batchId }, data: { status: settled } });
      }
    }

    return {
      ...s,
      movementId: created.id,
      itemId: a.item.id,
      // The lot the movement actually named, which is the one this act opened
      // where it opened one.
      batchId,
      before,
      newQty: moved.quantityMilli,
      newValue: moved.valueMinor,
      unitCostMinor: rate,
      openedLayerId,
      openedBatchId,
      batchWasStatus,
      layerWasCost,
    };
  });

  const entry = await postForMovement(a, done);

  // Cost has moved, so the allowance against it has to move with it, in the same
  // act — see the header. An issue of written-down stock releases its share,
  // which is IAS 2.34: the carrying amount is what reaches the expense.
  //
  // Both figures are taken from the row rather than from the caller's copy of
  // it, so two movements landing one after the other move the allowance in two
  // contiguous steps — the second from where the first left it — instead of
  // both moving it from the same starting point and posting the difference
  // twice.
  const held = writeDownHeld(done.before.valueMinor, done.before.quantityMilli, done.before.nrvMinor);
  const required = writeDownHeld(done.newValue, done.newQty, done.before.nrvMinor);
  await applyWriteDown({
    item: a.item, held, required, on: a.movedOn,
    qtyAfter: done.newQty, costAfter: done.newValue,
    nrvFrom: done.before.nrvMinor, nrvTo: done.before.nrvMinor,
    memo: `Write-down released as stock moved — ${a.item.sku}`,
    actorId: a.actorId,
  });

  return {
    movementId: done.movementId,
    entryId: entry.entryId,
    reference: entry.reference,
    quantityMilli: done.qty.toString(),
    valueMinor: done.value.toString(),
    unitCostMinor: done.unitCostMinor.toString(),
    balanceQtyMilli: done.newQty.toString(),
    balanceValueMinor: done.newValue.toString(),
    writeDownMinor: required.toString(),
    carryingValueMinor: (done.newValue - required).toString(),
    layers: (done.takes ?? []).map(showTake),
  };
}

/**
 * Post the entry a movement raises, and take the movement back out if the
 * posting is refused.
 *
 * A refusal here is not a race — it is a closed period, a missing account, a
 * control account refusing a manual source — and it will refuse the retry
 * exactly as it refused this attempt. So leaving the movement behind would
 * leave stock that has moved on the item card, on the shelf report and in the
 * batch register, and nothing at all in account 1200, permanently, with an
 * error message on the screen as the only evidence. The unwind is the same
 * arrangement `trade-finance.ts` uses for a drawing whose posting fails, and
 * for the same reason.
 *
 * The unwind is written as the reverse of what was done rather than as a
 * restore of what was read: the item is decremented by this movement's own
 * figures, so a movement that committed in between is not undone with it.
 */
async function postForMovement(
  a: RecordInput, done: Recorded,
): Promise<{ entryId: string | null; reference: string | null }> {
  if (a.given) return { entryId: a.given.entryId, reference: a.given.reference };
  const input = a.entryFor?.(done, done.movementId);
  if (!input) return { entryId: null, reference: null };

  let entry: Awaited<ReturnType<typeof post>>;
  try {
    entry = await post(input);
  } catch (e) {
    // The error the caller sees has to be the one that says what to do about
    // it, so a failure to unwind must not replace it.
    await unwind(done).catch(() => undefined);
    throw e;
  }

  await prisma.inventoryMovement.update({ where: { id: done.movementId }, data: { entryId: entry.id } });
  return { entryId: entry.id, reference: `${entry.series}-${entry.number}` };
}

/** Take a movement back out, in the reverse of the order it went in. */
async function unwind(done: Recorded): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (done.batchId && done.batchDelta) {
      await tx.stockBatch.update({
        where: { id: done.batchId },
        data: {
          quantityMilli: { decrement: done.batchDelta },
          ...(done.batchWasStatus ? { status: done.batchWasStatus } : {}),
        },
      });
    }
    if (done.layerWasCost) {
      await tx.inventoryLayer.update({
        where: { id: done.layerWasCost.id },
        data: { unitCostMinor: done.layerWasCost.unitCostMinor },
      });
    }
    for (const t of done.takes ?? []) {
      await tx.inventoryLayer.update({
        where: { id: t.layerId },
        data: { remainingMilli: { increment: t.quantityMilli } },
      });
    }
    if (done.openedLayerId) await tx.inventoryLayer.delete({ where: { id: done.openedLayerId } });
    await tx.inventoryMovement.delete({ where: { id: done.movementId } });
    if (done.openedBatchId) await tx.stockBatch.delete({ where: { id: done.openedBatchId } });
    await tx.inventoryItem.update({
      where: { id: done.itemId },
      data: { quantityMilli: { decrement: done.qty }, valueMinor: { decrement: done.value } },
    });
  });
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

  /*
   * The assessment is taken under the item's own lock, exactly as a movement
   * is, and for the same reason: the allowance is the difference between what
   * is held and what this assessment requires, so both figures have to come
   * from the row rather than from a copy of it. Two assessments recorded at
   * once against one item would otherwise both measure their difference from
   * the same starting allowance and both post it, moving 1200 twice for one
   * change in opinion.
   *
   * `nrvMinor` is written inside the same transaction, so the second assessment
   * finds the first one's opinion in `nrvFrom` and posts only the step from it.
   * The two steps are contiguous, so they add up whatever order they post in.
   */
  const assessed = await prisma.$transaction(async (tx) => {
    const before = await lockItem(tx, item);
    // The assessment is recorded whether or not it changed anything: IAS 2.33 asks
    // for one every period, and an item nobody has looked at must not read the same
    // as one looked at and found sound.
    await tx.inventoryItem.update({ where: { id: item.id }, data: { nrvMinor: nrv } });
    return before;
  });

  const held = writeDownHeld(assessed.valueMinor, assessed.quantityMilli, assessed.nrvMinor);
  const required = writeDownHeld(assessed.valueMinor, assessed.quantityMilli, nrv);

  let applied: { entryId: string | null; reference: string | null };
  try {
    applied = await applyWriteDown({
      item, held, required, qtyAfter: assessed.quantityMilli, costAfter: assessed.valueMinor,
      nrvFrom: assessed.nrvMinor, nrvTo: nrv,
      on: opts.on, memo: opts.memo ?? nrvMemo(item.sku, required - held), actorId: opts.actorId,
    });
  } catch (e) {
    // An assessment on file that never reached the ledger is an item whose
    // carrying amount on the screen and in 1200 disagree, which is the one
    // thing this module refuses to leave behind. The opinion goes back to what
    // it was and the caller gets the refusal that says why.
    await prisma.inventoryItem
      .updateMany({ where: { id: item.id, nrvMinor: nrv }, data: { nrvMinor: assessed.nrvMinor } })
      .catch(() => undefined);
    throw e;
  }

  return {
    sku: item.sku,
    assessedOn: opts.on,
    entryId: applied.entryId,
    reference: applied.reference,
    quantityMilli: assessed.quantityMilli.toString(),
    nrvMinor: nrv.toString(),
    nrvTotalMinor: ((nrv * assessed.quantityMilli) / MILLI).toString(),
    costMinor: assessed.valueMinor.toString(),
    writeDownMinor: required.toString(),
    carryingMinor: (assessed.valueMinor - required).toString(),
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

/** How many movements one read of an item's history lists, and the ceiling on asking for more. */
const HISTORY_PAGE = 200;
const HISTORY_MAX_PAGE = 2_000;

/**
 * The movement history for one item — where a valuation came from.
 *
 * The page is taken from the NEWEST end, the same way the general ledger's is
 * and for the same reason. It used to take the OLDEST 200 movements and print
 * them under a header carrying the item's quantity and value as at today, with
 * nothing saying the two did not belong together: on any item with a year of
 * trading behind it the table stopped somewhere in its first month while the
 * figures above it were current, and the reader was left to conclude that the
 * one had produced the other.
 *
 * So the newest movements are listed, `truncated` says when there are older
 * ones that are not, and `movementCount` says how many there are altogether.
 * The header's figures are the item's own and always were; what has changed is
 * that the screen can now say so.
 */
export async function itemHistory(opts: { orgId: string; entityId: string; sku: string; limit?: number }) {
  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);

  // A limit arriving from a query string is whatever the caller typed, so it is
  // clamped rather than trusted — `Number("all")` is NaN, and NaN reaches
  // Prisma as `take: NaN`, which fails the read rather than the parameter.
  const asked = Number(opts.limit ?? HISTORY_PAGE);
  const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), HISTORY_MAX_PAGE) : HISTORY_PAGE;

  const [movementCount, page] = await Promise.all([
    prisma.inventoryMovement.count({ where: { orgId: opts.orgId, itemId: item.id } }),
    prisma.inventoryMovement.findMany({
      where: { orgId: opts.orgId, itemId: item.id },
      // Newest first so the page is the newest movements; `createdAt` and the
      // row id break the ties within a day, so a movement cannot swap places
      // with its neighbour between two reads and land on a different page.
      orderBy: [{ movedOn: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: limit,
    }),
  ]);
  // Read newest-first, presented oldest-first: a stock card is read down the
  // page, and its running balance only makes sense in the order it happened.
  const movements = page.reverse();
  // Where the goods went, and which lot they were. A transfer reads as the pair
  // it is — a leg out of one location and a leg into another, both at nil value
  // with the running balance unmoved — which is the honest picture of an event
  // that changed nothing but the address.
  const [places, lots] = await Promise.all([
    prisma.stockLocation.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId }, select: { id: true, code: true },
    }),
    prisma.stockBatch.findMany({ where: { orgId: opts.orgId, itemId: item.id }, select: { id: true, code: true } }),
  ]);
  const placeCode = new Map(places.map((p) => [p.id, p.code]));
  const lotCode = new Map(lots.map((l) => [l.id, l.code]));
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
    /** How many movements this item has, listed or not. */
    movementCount,
    listed: movements.length,
    /** True when there are older movements this read did not list. */
    truncated: movementCount > movements.length,
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
      location: m.locationId ? placeCode.get(m.locationId) ?? null : null,
      batch: m.batchId ? lotCode.get(m.batchId) ?? null : null,
    })),
  };
}

/* ================================================================ locations */

const showLocation = (l: LocationRow) => ({
  code: l.code, name: l.name, nameAr: l.nameAr, address: l.address,
  isDefault: l.isDefault, status: l.status,
});

/**
 * Open a stock location.
 *
 * The database allows one default or none, so making this one the default steps
 * the old one down in the same act. Two defaults would make "where did it go"
 * ambiguous in exactly the case a default exists to answer.
 */
export async function addLocation(opts: {
  orgId: string;
  entityId: string;
  code: string;
  name: string;
  nameAr?: string;
  address?: string;
  isDefault?: boolean;
}) {
  const code = opts.code?.trim().toUpperCase();
  if (!code) throw new LedgerError("A location needs a code — that is what a movement names.");
  if (!opts.name?.trim()) throw new LedgerError("A location needs a name.");

  const clash = await prisma.stockLocation.findFirst({ where: { orgId: opts.orgId, entityId: opts.entityId, code } });
  if (clash) throw new LedgerError(`There is already a stock location called ${code}.`);

  return prisma.$transaction(async (tx) => {
    if (opts.isDefault) {
      await tx.stockLocation.updateMany({
        where: { orgId: opts.orgId, entityId: opts.entityId, isDefault: true },
        data: { isDefault: false },
      });
    }
    const created = await tx.stockLocation.create({
      data: {
        orgId: opts.orgId, entityId: opts.entityId, code,
        name: opts.name.trim(), nameAr: opts.nameAr ?? null, address: opts.address ?? null,
        isDefault: opts.isDefault ?? false,
      },
    });
    return showLocation(created);
  });
}

/** Rename a location, move it, or hand it the default. */
export async function updateLocation(opts: {
  orgId: string;
  entityId: string;
  code: string;
  name?: string;
  nameAr?: string | null;
  address?: string | null;
  isDefault?: boolean;
}) {
  const loc = await loadLocation(opts.orgId, opts.entityId, opts.code);
  if (opts.name !== undefined && !opts.name.trim()) throw new LedgerError("A location needs a name.");
  if (opts.isDefault && loc.status !== "active") {
    throw new LedgerError(
      `${loc.code} ${loc.name} is closed, so it cannot be where stock lands when nobody says. ` +
        `A closed location holds nothing.`,
    );
  }

  return prisma.$transaction(async (tx) => {
    if (opts.isDefault) {
      await tx.stockLocation.updateMany({
        where: { orgId: opts.orgId, entityId: opts.entityId, isDefault: true, id: { not: loc.id } },
        data: { isDefault: false },
      });
    }
    const updated = await tx.stockLocation.update({
      where: { id: loc.id },
      data: {
        ...(opts.name !== undefined ? { name: opts.name.trim() } : {}),
        ...(opts.nameAr !== undefined ? { nameAr: opts.nameAr } : {}),
        ...(opts.address !== undefined ? { address: opts.address } : {}),
        ...(opts.isDefault !== undefined ? { isDefault: opts.isDefault } : {}),
      },
    });
    return showLocation(updated);
  });
}

/**
 * Close a location.
 *
 * Refused while it holds stock, and the refusal names what is on the shelf. A
 * closed location that still holds goods is stock the business owns and can no
 * longer find: the quantity stays in account 1200 and nothing on any screen
 * says where to go and get it.
 */
export async function closeLocation(opts: { orgId: string; entityId: string; code: string }) {
  const loc = await loadLocation(opts.orgId, opts.entityId, opts.code);
  if (loc.status === "closed") throw new LedgerError(`${loc.code} ${loc.name} is already closed.`);

  const held = await prisma.inventoryMovement.groupBy({
    by: ["itemId"],
    where: { orgId: opts.orgId, locationId: loc.id },
    _sum: { quantityMilli: true },
  });
  const standing = held.filter((h) => (h._sum.quantityMilli ?? 0n) !== 0n);
  if (standing.length) {
    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: standing.map((s) => s.itemId) } },
      select: { id: true, sku: true, uom: true },
    });
    const by = new Map(items.map((i) => [i.id, i]));
    const named = standing
      .map((s) => {
        const i = by.get(s.itemId);
        return { sku: i?.sku ?? "", text: `${fmtQty(s._sum.quantityMilli ?? 0n)} ${i?.uom ?? "EA"} of ${i?.sku ?? "an unknown item"}` };
      })
      .sort((a, b) => a.sku.localeCompare(b.sku));
    const shown = named.slice(0, 3).map((n) => n.text).join(", ");
    throw new LedgerError(
      `${loc.code} ${loc.name} still holds ${shown}${named.length > 3 ? `, and ${named.length - 3} more` : ""}. ` +
        `Transfer it somewhere else or write it off before closing the location — stock in a location nobody can ` +
        `reach is still on the balance sheet.`,
    );
  }
  if (loc.isDefault) {
    throw new LedgerError(
      `${loc.code} ${loc.name} is where stock lands when nobody says. Make another location the default first, ` +
        `or every later receipt would land nowhere.`,
    );
  }

  const closed = await prisma.stockLocation.update({ where: { id: loc.id }, data: { status: "closed" } });
  return showLocation(closed);
}

const asOfDate = (v: Date | string | null | undefined): Date | null => {
  if (v === undefined || v === null || v === "") return null;
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError("That report needs a date it can read.");
  return d;
};

/**
 * What each item's position was at a date, from the running balances the
 * movements carry. The figures on the item itself are today's and no other.
 */
async function positionsAt(orgId: string, ids: string[], asOf: Date) {
  const at = new Map<string, { qty: bigint; cost: bigint }>();
  if (!ids.length) return at;
  const history = await prisma.inventoryMovement.findMany({
    where: { orgId, itemId: { in: ids }, movedOn: { lte: asOf } },
    orderBy: [{ movedOn: "asc" }, { createdAt: "asc" }],
    select: { itemId: true, balanceQtyMilli: true, balanceValueMinor: true },
  });
  for (const m of history) at.set(m.itemId, { qty: m.balanceQtyMilli, cost: m.balanceValueMinor });
  return at;
}

/**
 * Stock by location, and the tie back to the item it came off.
 *
 * A location holds a quantity, never a cost of its own — the item is the
 * authority on value — so the value column is the item's own cost apportioned
 * across the places the goods are sitting, and the shares add back to it
 * exactly. Stock recorded before anybody opened a location is reported as
 * unassigned rather than dropped, because dropping it is precisely what would
 * make the total stop tying.
 */
export interface LocationLine {
  sku: string; name: string; uom: string;
  quantityMilli: string; quantity: string; valueMinor: string;
}

export interface LocationStock {
  /** Nil on the one row that is not a location: stock nobody placed. */
  code: string | null;
  name: string;
  isDefault: boolean;
  status: string;
  assigned: boolean;
  lines: LocationLine[];
  itemCount: number;
  valueMinor: string;
}

export interface LocationTie {
  sku: string; name: string; uom: string;
  quantityMilli: string; quantity: string;
  locatedMilli: string; unassignedMilli: string; costMinor: string;
  differenceMilli: string; agrees: boolean;
}

export async function stockByLocation(opts: { orgId: string; entityId: string; asOf?: Date | string }) {
  const asOf = asOfDate(opts.asOf);

  const [items, locations] = await Promise.all([
    prisma.inventoryItem.findMany({ where: { orgId: opts.orgId, entityId: opts.entityId }, orderBy: { sku: "asc" } }),
    prisma.stockLocation.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId },
      orderBy: [{ isDefault: "desc" }, { code: "asc" }],
    }),
  ]);
  const ids = items.map((i) => i.id);

  const grouped = ids.length
    ? await prisma.inventoryMovement.groupBy({
        by: ["itemId", "locationId"],
        where: { orgId: opts.orgId, itemId: { in: ids }, ...(asOf ? { movedOn: { lte: asOf } } : {}) },
        _sum: { quantityMilli: true },
      })
    : [];

  const UNASSIGNED = "";
  const byItem = new Map<string, Map<string, bigint>>();
  for (const g of grouped) {
    const row = byItem.get(g.itemId) ?? new Map<string, bigint>();
    const key = g.locationId ?? UNASSIGNED;
    row.set(key, (row.get(key) ?? 0n) + (g._sum.quantityMilli ?? 0n));
    byItem.set(g.itemId, row);
  }

  const past = asOf ? await positionsAt(opts.orgId, ids, asOf) : null;
  const buckets = [...locations.map((l) => l.id), UNASSIGNED];
  const lines = new Map<string, { sku: string; name: string; uom: string; quantityMilli: bigint; valueMinor: bigint }[]>();
  const itemRows: LocationTie[] = [];
  let tied = true;

  for (const item of items) {
    const at = past ? past.get(item.id) ?? { qty: 0n, cost: 0n } : { qty: item.quantityMilli, cost: item.valueMinor };
    const held = byItem.get(item.id) ?? new Map<string, bigint>();
    const quantities = buckets.map((b) => held.get(b) ?? 0n);
    const values = apportion(at.cost, quantities);

    buckets.forEach((bucket, n) => {
      if (quantities[n] === 0n) return;
      const row = lines.get(bucket) ?? [];
      row.push({ sku: item.sku, name: item.name, uom: item.uom, quantityMilli: quantities[n], valueMinor: values[n] });
      lines.set(bucket, row);
    });

    const placed = quantities.reduce((a, q) => a + q, 0n);
    const unassigned = held.get(UNASSIGNED) ?? 0n;
    if (placed !== at.qty) tied = false;
    itemRows.push({
      sku: item.sku, name: item.name, uom: item.uom,
      quantityMilli: at.qty.toString(), quantity: fmtQty(at.qty),
      locatedMilli: (placed - unassigned).toString(),
      unassignedMilli: unassigned.toString(),
      costMinor: at.cost.toString(),
      // Two records built by different routes — the item's own quantity and the
      // sum of where its goods actually are — compared rather than reconciled.
      differenceMilli: (at.qty - placed).toString(),
      agrees: at.qty === placed,
    });
  }

  const shown = (bucket: string) => {
    const rows = (lines.get(bucket) ?? []).sort((a, b) => a.sku.localeCompare(b.sku));
    return {
      lines: rows.map((r) => ({
        sku: r.sku, name: r.name, uom: r.uom,
        quantityMilli: r.quantityMilli.toString(), quantity: fmtQty(r.quantityMilli),
        valueMinor: r.valueMinor.toString(),
      })),
      valueMinor: rows.reduce((a, r) => a + r.valueMinor, 0n),
    };
  };

  const rows: LocationStock[] = [
    ...locations.map((l) => {
      const s = shown(l.id);
      return {
        code: l.code, name: l.name, isDefault: l.isDefault, status: l.status, assigned: true,
        lines: s.lines, itemCount: s.lines.length, valueMinor: s.valueMinor.toString(),
      };
    }),
    (() => {
      const s = shown(UNASSIGNED);
      return {
        // Not a location, and deliberately not disguised as one: this is stock
        // that moved before anybody said where it was.
        code: null, name: "Not assigned to a location", isDefault: false, status: "active", assigned: false,
        lines: s.lines, itemCount: s.lines.length, valueMinor: s.valueMinor.toString(),
      };
    })(),
  ];

  const totalValue = rows.reduce((a, r) => a + BigInt(r.valueMinor), 0n);
  const registerValue = items.reduce(
    (a, i) => a + (past ? (past.get(i.id)?.cost ?? 0n) : i.valueMinor),
    0n,
  );

  return {
    asOf: asOf ? iso(asOf) : null,
    locations: rows,
    items: itemRows,
    totals: {
      valueMinor: totalValue.toString(),
      registerCostMinor: registerValue.toString(),
      differenceMinor: (registerValue - totalValue).toString(),
      agrees: tied && registerValue === totalValue,
    },
  };
}

/* ================================================================ transfers */

/**
 * Move stock from one location to another.
 *
 * This is the one movement with no ledger effect at all. The goods have not
 * left the business, nobody has been billed and nothing has been consumed, so
 * no cost has moved: the trial balance and account 1200 are exactly what they
 * were before. An entry here would be inventing a transaction out of a forklift
 * ride, and it would show up as cost of sales the business never bore.
 *
 * It is still two movements rather than one, because a single row cannot say
 * both that a quantity left A and that it arrived at B — and if it cannot say
 * that, neither location's quantity is right. Both legs carry the item's
 * balances unchanged and the item itself is not touched, which is what keeps
 * the first opinion intact: the item stays the authority on quantity and value,
 * and the legs only say where that quantity is.
 */
export async function transferStock(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  /** The location code the goods leave. */
  from: string;
  /** The location code they arrive at. */
  to: string;
  quantityMilli: number | bigint | string;
  on: string;
  /** Which batch or serial moved. Required where the item is tracked by batch. */
  batch?: string;
  /** The transfer note. Doubles as the idempotency key. */
  reference?: string;
  memo?: string;
  actorId?: string;
}) {
  const qty = BigInt(opts.quantityMilli);
  if (qty <= 0n) throw new LedgerError("A transfer has to be a positive quantity.");
  if (!opts.on || Number.isNaN(new Date(opts.on).getTime())) throw new LedgerError("A transfer needs the date it happened.");

  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  const from = await loadLocation(opts.orgId, opts.entityId, opts.from);
  const to = await loadLocation(opts.orgId, opts.entityId, opts.to);
  if (from.id === to.id) {
    throw new LedgerError(`${from.code} is both ends of that transfer. Stock that has not moved is not a transfer.`);
  }
  for (const loc of [from, to]) {
    if (loc.status !== "active") throw new LedgerError(`${loc.code} ${loc.name} is closed, so no stock can move through it.`);
  }

  const ref = opts.reference?.trim() ? TRANSFER_REF + opts.reference.trim() : null;
  const seen = ref
    ? await prisma.inventoryMovement.findFirst({
        where: {
          orgId: opts.orgId, itemId: item.id, kind: "ISSUE", reference: ref,
          movedOn: new Date(opts.on), quantityMilli: -qty, locationId: from.id,
        },
      })
    : null;

  if (!seen) {
    const note = opts.memo?.trim();
    // A transfer changes no total, but both legs carry the item's balances so a
    // movement can be read on its own — and a balance copied from a row read
    // before the lock was taken is a figure that was true a moment ago. The
    // shelf and batch checks are inside for the same reason as an issue's: what
    // a location holds is the sum of its movements, and another one can land
    // between a check outside the transaction and the write inside it.
    await prisma.$transaction(async (tx) => {
      const state = await lockItem(tx, item);
      const held = await heldAt(tx, item, from.id);
      if (qty > held) {
        throw new LedgerError(
          `${from.code} ${from.name} holds ${fmtQty(held)} ${item.uom} of ${item.sku}, and ${fmtQty(qty)} was moved out of it. ` +
            `Stock recorded before any location existed is unassigned, not sitting here — receive or count it in first.`,
        );
      }

      // The same reasoning as an issue: a batch that is recorded in the wrong
      // place is a recall sent to the wrong shelf, which is no better than a
      // recall with no shelf at all.
      const lot = await outOfBatch(tx, item, opts.batch, qty, "a transfer", true);

      const common = {
        orgId: opts.orgId, itemId: item.id, movedOn: new Date(opts.on),
        valueMinor: 0n, unitCostMinor: unitCost(state.valueMinor, state.quantityMilli),
        balanceQtyMilli: state.quantityMilli, balanceValueMinor: state.valueMinor,
        reference: ref, entryId: null, batchId: lot.batchId,
      };
      await tx.inventoryMovement.create({
        data: {
          ...common, kind: "ISSUE", quantityMilli: -qty, locationId: from.id,
          memo: note ?? `Transferred to ${to.code} — ${item.sku}`,
        },
      });
      await tx.inventoryMovement.create({
        data: {
          ...common, kind: "RECEIPT", quantityMilli: qty, locationId: to.id,
          memo: note ?? `Transferred from ${from.code} — ${item.sku}`,
        },
      });
      // The batch itself does not change size — it changes address.
      if (lot.batchId) await tx.stockBatch.update({ where: { id: lot.batchId }, data: { locationId: to.id } });
    });
  }

  // What the item holds is reported from the row rather than from the copy this
  // call started with, because a transfer takes long enough for somebody else's
  // issue to land inside it — and "unchanged" is only worth saying about a
  // figure that is current.
  const now = await prisma.inventoryItem.findUnique({
    where: { id: item.id }, select: { quantityMilli: true, valueMinor: true },
  });

  return {
    sku: item.sku,
    from: from.code,
    to: to.code,
    on: opts.on,
    quantityMilli: qty.toString(),
    quantity: fmtQty(qty),
    batch: opts.batch?.trim() || null,
    fromHoldsMilli: (await heldAt(prisma, item, from.id)).toString(),
    toHoldsMilli: (await heldAt(prisma, item, to.id)).toString(),
    /** Unchanged by this, and that is the point: nothing left the business. */
    balanceQtyMilli: (now?.quantityMilli ?? item.quantityMilli).toString(),
    balanceValueMinor: (now?.valueMinor ?? item.valueMinor).toString(),
    /** A transfer never posts. Nil here is the assertion, not an omission. */
    entryId: null,
    posted: false,
    ...(seen ? { replayed: true as const } : {}),
  };
}

/* ================================================== batches, serials, expiry */

/** What a batch is worth: the item's cost, apportioned over its batches. */
async function batchValues(items: { id: string; valueMinor: bigint }[], batches: { id: string; itemId: string; quantityMilli: bigint }[]) {
  const value = new Map<string, bigint>();
  for (const item of items) {
    const mine = batches.filter((b) => b.itemId === item.id);
    const shares = apportion(item.valueMinor, mine.map((b) => b.quantityMilli));
    mine.forEach((b, n) => value.set(b.id, shares[n]));
  }
  return value;
}

/**
 * The batch register, and the tie back to the item.
 *
 * Where an item is tracked by batch, the sum of its batches is its own
 * quantity. That is the invariant which makes the register worth having: a
 * register that has never been tied to the item it describes is a list of
 * labels, and a recall run off it reaches the wrong shelves. It is reported
 * rather than enforced, because a stock count may legitimately move the item
 * without saying which batch — see the header.
 */
export async function batchRegister(opts: { orgId: string; entityId: string; sku?: string }) {
  const items = await prisma.inventoryItem.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, ...(opts.sku ? { sku: opts.sku } : {}) },
    orderBy: { sku: "asc" },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const batches = items.length
    ? await prisma.stockBatch.findMany({
        where: { orgId: opts.orgId, entityId: opts.entityId, itemId: { in: items.map((i) => i.id) } },
        orderBy: [{ expiresOn: "asc" }, { receivedOn: "asc" }, { code: "asc" }],
      })
    : [];

  const locations = await prisma.stockLocation.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    select: { id: true, code: true },
  });
  const locationCode = new Map(locations.map((l) => [l.id, l.code]));
  const value = await batchValues(items, batches);
  const today = new Date();

  const rows = batches.map((b) => {
    const item = byId.get(b.itemId)!;
    return {
      sku: item.sku, name: item.name, uom: item.uom,
      code: b.code, kind: b.kind, status: b.status,
      location: b.locationId ? locationCode.get(b.locationId) ?? null : null,
      receivedOn: iso(b.receivedOn),
      expiresOn: b.expiresOn ? iso(b.expiresOn) : null,
      // Nil where the goods do not go off, which is a different fact from an
      // expiry that has not been reached yet.
      daysToExpiry: b.expiresOn ? daysUntil(b.expiresOn, today) : null,
      expired: b.expiresOn ? b.expiresOn < today && b.quantityMilli > 0n : false,
      quantityMilli: b.quantityMilli.toString(),
      quantity: fmtQty(b.quantityMilli),
      valueMinor: (value.get(b.id) ?? 0n).toString(),
    };
  });

  const tracked = items.filter((i) => batches.some((b) => b.itemId === i.id));
  const reconciliation = tracked.map((i) => {
    const held = batches.filter((b) => b.itemId === i.id).reduce((a, b) => a + b.quantityMilli, 0n);
    const tie = tieBatches(i.quantityMilli, held);
    return {
      sku: i.sku, name: i.name, uom: i.uom,
      itemMilli: tie.itemMilli.toString(), itemQuantity: fmtQty(tie.itemMilli),
      batchMilli: tie.batchMilli.toString(), batchQuantity: fmtQty(tie.batchMilli),
      batchCount: batches.filter((b) => b.itemId === i.id).length,
      differenceMilli: tie.differenceMilli.toString(),
      difference: fmtQty(tie.differenceMilli),
      agrees: tie.agrees,
    };
  });

  return {
    batches: rows,
    reconciliation: {
      items: reconciliation,
      tracked: reconciliation.length,
      differenceMilli: reconciliation.reduce((a, r) => a + BigInt(r.differenceMilli), 0n).toString(),
      agrees: reconciliation.every((r) => r.agrees),
    },
  };
}

/**
 * What is about to go off, and what already has.
 *
 * The two are reported apart because they call for different acts: stock
 * expiring is a selling problem, and stock expired is an accounting one.
 */
export async function expiringStock(opts: {
  orgId: string;
  entityId: string;
  /** How many days ahead to look. Nought is a real answer: only what has gone off. */
  within?: number;
  asOf?: Date | string;
}) {
  const within = opts.within ?? 30;
  if (!Number.isInteger(within) || within < 0) {
    throw new LedgerError("An expiry window is a whole number of days, and cannot look backwards.");
  }
  const asOf = asOfDate(opts.asOf) ?? new Date();
  const horizon = expiryHorizon(asOf, within);

  const items = await prisma.inventoryItem.findMany({ where: { orgId: opts.orgId, entityId: opts.entityId } });
  const byId = new Map(items.map((i) => [i.id, i]));
  const all = items.length
    ? await prisma.stockBatch.findMany({
        where: {
          orgId: opts.orgId, entityId: opts.entityId, itemId: { in: items.map((i) => i.id) },
          expiresOn: { not: null, lte: horizon },
          quantityMilli: { gt: 0n },
          status: { in: ["active", "quarantined"] },
        },
        orderBy: [{ expiresOn: "asc" }, { code: "asc" }],
      })
    : [];

  // Value is apportioned over ALL of an item's batches, not only the expiring
  // ones, or a batch would be worth more simply because its neighbours are
  // still fresh.
  const siblings = items.length
    ? await prisma.stockBatch.findMany({
        where: { orgId: opts.orgId, entityId: opts.entityId, itemId: { in: items.map((i) => i.id) } },
      })
    : [];
  const value = await batchValues(items, siblings);

  const row = (b: (typeof all)[number]) => {
    const item = byId.get(b.itemId)!;
    return {
      sku: item.sku, name: item.name, uom: item.uom,
      code: b.code, kind: b.kind, status: b.status,
      expiresOn: b.expiresOn ? iso(b.expiresOn) : null,
      daysToExpiry: b.expiresOn ? daysUntil(b.expiresOn, asOf) : null,
      quantityMilli: b.quantityMilli.toString(),
      quantity: fmtQty(b.quantityMilli),
      valueMinor: (value.get(b.id) ?? 0n).toString(),
    };
  };

  const gone = all.filter((b) => b.expiresOn! < asOf).map(row);
  const going = all.filter((b) => b.expiresOn! >= asOf).map(row);
  const sum = (rows: { valueMinor: string }[]) => rows.reduce((a, r) => a + BigInt(r.valueMinor), 0n).toString();

  return {
    asOf: iso(asOf),
    withinDays: within,
    horizon: iso(horizon),
    expired: gone,
    expiring: going,
    totals: {
      expiredValueMinor: sum(gone),
      expiringValueMinor: sum(going),
      expiredCount: gone.length,
      expiringCount: going.length,
    },
  };
}

/**
 * Sweep what has gone off.
 *
 * Quarantining takes the stock off sale without saying anything about what it
 * is worth: the goods are still there and somebody has to decide. Writing off
 * says the decision is made — expired stock still on hand is worth nothing, and
 * carrying it at cost overstates the balance sheet — so it goes through the
 * ledger like any other loss:
 *
 *   Dr  5300  Stock variance    what the expired goods cost
 *     Cr  1200  Inventory
 *
 * Not through cost of sales, for the same reason shrinkage is not: a business
 * that cannot see what it threw away cannot stop throwing it away.
 *
 * Each batch is swept under its own reference, so a half-finished sweep can be
 * run again and picks up only what it did not reach.
 */
export interface SweptBatch {
  sku: string;
  code: string;
  kind: string;
  expiresOn: string | null;
  quantityMilli: string;
  quantity: string;
  status: string;
  /** Nil where nothing was posted, which is always so for a quarantine. */
  entryId: string | null;
  reference: string | null;
  valueMinor: string;
  replayed: boolean;
}

export async function sweepExpired(opts: {
  orgId: string;
  entityId: string;
  /** The date the sweep is made. Anything that expired before it is caught. */
  on: string;
  action?: "quarantine" | "write_off";
  reason?: string;
  actorId?: string;
}) {
  if (!opts.on || Number.isNaN(new Date(opts.on).getTime())) throw new LedgerError("A sweep needs the date it was made.");
  const on = new Date(opts.on);
  const action = opts.action ?? "quarantine";
  if (action !== "quarantine" && action !== "write_off") {
    throw new LedgerError(`"${action}" is not something to do with expired stock. Quarantine it, or write it off.`);
  }

  const items = await prisma.inventoryItem.findMany({ where: { orgId: opts.orgId, entityId: opts.entityId } });
  const byId = new Map(items.map((i) => [i.id, i]));
  const expired = items.length
    ? await prisma.stockBatch.findMany({
        where: {
          orgId: opts.orgId, entityId: opts.entityId, itemId: { in: items.map((i) => i.id) },
          expiresOn: { not: null, lt: on },
          quantityMilli: { gt: 0n },
          status: { in: action === "quarantine" ? ["active"] : ["active", "quarantined"] },
        },
        orderBy: [{ expiresOn: "asc" }, { code: "asc" }],
      })
    : [];

  const swept: SweptBatch[] = [];
  let writtenOff = 0n;

  for (const batch of expired) {
    const item = byId.get(batch.itemId)!;
    if (action === "quarantine") {
      await prisma.stockBatch.update({ where: { id: batch.id }, data: { status: "quarantined" } });
      swept.push({
        sku: item.sku, code: batch.code, kind: batch.kind,
        expiresOn: batch.expiresOn ? iso(batch.expiresOn) : null,
        quantityMilli: batch.quantityMilli.toString(), quantity: fmtQty(batch.quantityMilli),
        status: "quarantined",
        // Quarantine says nothing about value, so it posts nothing.
        entryId: null, reference: null, valueMinor: "0", replayed: false,
      });
      continue;
    }

    const result = await writeOffBatch({
      orgId: opts.orgId, entityId: opts.entityId, sku: item.sku, batchId: batch.id,
      on: opts.on, reason: opts.reason, actorId: opts.actorId,
    });
    writtenOff += -BigInt(result.valueMinor);
    swept.push({
      sku: item.sku, code: batch.code, kind: batch.kind,
      expiresOn: batch.expiresOn ? iso(batch.expiresOn) : null,
      quantityMilli: batch.quantityMilli.toString(), quantity: fmtQty(batch.quantityMilli),
      status: "expired",
      entryId: result.entryId, reference: result.reference,
      valueMinor: (-BigInt(result.valueMinor)).toString(),
      replayed: result.replayed === true,
    });
  }

  return {
    on: opts.on,
    action,
    swept,
    totals: {
      batches: swept.length,
      valueMinor: writtenOff.toString(),
    },
  };
}

/**
 * Write one batch off in full.
 *
 * Kept apart from `adjust` because a count and a write-off are different
 * statements: a count says what is on the shelf, and this says what is on the
 * shelf is worthless. It goes through the same `record` as everything else, so
 * the item, the movement, the FIFO layers, the batch and the net realisable
 * value allowance all move together.
 */
async function writeOffBatch(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  batchId: string;
  on: string;
  reason?: string;
  actorId?: string;
}): Promise<MovementResult> {
  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  const batch = await prisma.stockBatch.findFirst({ where: { id: opts.batchId, orgId: opts.orgId } });
  if (!batch) throw new LedgerError("That batch does not exist.");
  if (batch.quantityMilli <= 0n) {
    throw new LedgerError(`Batch ${batch.code} of ${item.sku} holds nothing, so there is nothing to write off.`);
  }

  // The batch's own reference, so a sweep run twice writes each batch off once.
  // What is on the reference is the batch and the day, not the quantity: how
  // much was in the batch is settled under the item's lock now, so a retry
  // whose first attempt already emptied it would no longer match on a figure.
  const reference = `EXP/${batch.code}`;
  const seen = await priorMovement(item, ["WRITE_OFF"], reference, { movedOn: opts.on });
  if (seen) return replay(item, seen);

  const out = await record({
    item, movedOn: opts.on, ref: reference,
    memo: opts.reason ?? `Expired — batch ${batch.code}`,
    actorId: opts.actorId,
    settle: async (tx, held) => {
      // The lot is read again inside the lock: an issue out of it between the
      // sweep listing it and this writing it off would leave the quantity above
      // taking more off the item than the batch has left.
      const lot = await tx.stockBatch.findFirst({ where: { id: batch.id, orgId: opts.orgId } });
      if (!lot || lot.quantityMilli <= 0n) {
        throw new LedgerError(`Batch ${batch.code} of ${item.sku} holds nothing, so there is nothing to write off.`);
      }
      const qty = lot.quantityMilli;
      if (qty > held.quantityMilli) {
        throw new LedgerError(
          `Batch ${batch.code} says it holds ${fmtQty(qty)} ${item.uom} of ${item.sku} but the item only holds ` +
            `${fmtQty(held.quantityMilli)}. The batch register and the item disagree; settle that before writing anything off, ` +
            `because writing off stock the system has no cost for would mean inventing one.`,
        );
      }
      const consumed = await consume(tx, item, held, qty);
      return {
        kind: "WRITE_OFF",
        qty: -qty,
        value: -consumed.costMinor,
        rate: consumed.rate,
        takes: consumed.takes,
        locationId: lot.locationId,
        batchId: lot.id,
        batchDelta: -qty,
      };
    },
    entryFor: (s, movementId) => s.value === 0n ? null : {
      orgId: opts.orgId, entityId: opts.entityId, entryDate: opts.on,
      memo: opts.reason ?? `Expired stock written off — ${item.sku} batch ${batch.code}`,
      source: "inventory", sourceType: "EXPIRY", sourceId: item.id,
      externalKey: movementKey(s.kind, movementId),
      actorType: "HUMAN", actorId: opts.actorId, series: "IA",
      lines: [
        { account: item.varianceAccount, debit: -s.value, memo: `${item.sku} batch ${batch.code} expired` },
        { account: item.stockAccount, credit: -s.value, memo: `${item.sku} batch ${batch.code} written off` },
      ],
    },
  });

  // `record` settles an emptied batch to "consumed", which is the right word
  // for stock that was sold and the wrong one for stock that went off. The
  // register has to be able to tell those apart afterwards.
  await prisma.stockBatch.update({ where: { id: batch.id }, data: { status: "expired" } });
  return out;
}

/* ========================================================== reorder levels */

/**
 * What is on order, per SKU.
 *
 * procurement.ts already owns what "still on order" means — which statuses are
 * live, and how much of a line has arrived — so it is asked rather than
 * re-derived here. Two modules deriving the same figure from the same tables is
 * how the two figures start to disagree. The import is deferred because
 * procurement.ts imports `receive` from this module, and a static import back
 * would be a cycle.
 */
export interface OnOrderLine {
  number: string;
  supplierName: string;
  expectedOn: string | null;
  outstandingMilli: string;
}

async function onOrderBySku(orgId: string, entityId: string) {
  const { orderList, orderDetail } = await import("./procurement");
  const live = (await orderList({ orgId, entityId })).orders.filter(
    (o) => o.status === "open" || o.status === "part_received",
  );

  const out = new Map<string, { milli: bigint; orders: OnOrderLine[] }>();
  for (const order of live) {
    const detail = await orderDetail({ orgId, orderId: order.id });
    for (const line of detail.lines) {
      const outstanding = BigInt(line.outstandingMilli);
      if (!line.sku || outstanding <= 0n) continue;
      const row = out.get(line.sku) ?? { milli: 0n, orders: [] };
      row.milli += outstanding;
      row.orders.push({
        number: order.number, supplierName: order.supplierName,
        expectedOn: order.expectedOn, outstandingMilli: outstanding.toString(),
      });
      out.set(line.sku, row);
    }
  }
  return out;
}

/**
 * Items at or under their reorder level, with what is already on order.
 *
 * Nil and nought are different facts and stay different all the way to the
 * screen: nil is "nobody has decided what low means for this item", nought is
 * "tell me the moment it runs out". An unmonitored item is not a healthy one,
 * so it is reported separately rather than left out.
 *
 * An order in flight never suppresses the finding — goods on a lorry are not
 * goods on a shelf — it only says somebody has already acted on it.
 */
export interface ReorderRow {
  sku: string; name: string; uom: string;
  quantityMilli: string; quantity: string;
  reorderLevelMilli: string; reorderLevel: string;
  onOrderMilli: string; onOrder: string;
  shortfallMilli: string; shortfall: string;
  /** At the level exactly, which is still below it — the level is where reordering starts. */
  atLevel: boolean;
  /** What is on order brings it back above the level. It is still below it today. */
  covered: boolean;
  orders: OnOrderLine[];
}

export interface UnmonitoredItem {
  sku: string; name: string; uom: string;
  quantityMilli: string; quantity: string;
}

export async function belowReorderLevel(opts: { orgId: string; entityId: string }) {
  const items = await prisma.inventoryItem.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: "active" },
    orderBy: { sku: "asc" },
  });
  const onOrder = await onOrderBySku(opts.orgId, opts.entityId);

  const below: ReorderRow[] = [];
  const unmonitored: UnmonitoredItem[] = [];
  let monitored = 0;
  let covered = 0;

  for (const item of items) {
    const ordered = onOrder.get(item.sku) ?? { milli: 0n, orders: [] };
    const verdict = reorderVerdict({
      quantityMilli: item.quantityMilli,
      reorderLevelMilli: item.reorderLevelMilli,
      onOrderMilli: ordered.milli,
    });
    if (!verdict.monitored) {
      unmonitored.push({
        sku: item.sku, name: item.name, uom: item.uom,
        quantityMilli: item.quantityMilli.toString(), quantity: fmtQty(item.quantityMilli),
      });
      continue;
    }
    monitored += 1;
    if (!verdict.below) continue;
    if (verdict.covered) covered += 1;
    below.push({
      sku: item.sku, name: item.name, uom: item.uom,
      quantityMilli: item.quantityMilli.toString(), quantity: fmtQty(item.quantityMilli),
      reorderLevelMilli: item.reorderLevelMilli!.toString(),
      reorderLevel: fmtQty(item.reorderLevelMilli!),
      onOrderMilli: ordered.milli.toString(), onOrder: fmtQty(ordered.milli),
      shortfallMilli: verdict.shortfallMilli.toString(), shortfall: fmtQty(verdict.shortfallMilli),
      /** At the level exactly, which is still below it — the level is where reordering starts. */
      atLevel: verdict.shortfallMilli === 0n,
      covered: verdict.covered,
      orders: ordered.orders,
    });
  }

  return {
    items: below,
    /** Items with a level set that are above it. */
    monitored,
    /** Nobody has set a level for these. Nil is not "fine"; it is "nobody has said". */
    unmonitored,
    totals: { below: below.length, covered, unmonitored: unmonitored.length },
  };
}

/**
 * Set, change or clear an item's reorder level.
 *
 * Clearing it is said out loud rather than inferred from an empty field, for
 * the same reason a net realisable value of nothing is: no level and a level of
 * nothing are different statements about the same item.
 */
export async function setReorderLevel(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  /** Thousandths. Nil clears the level; nought is a level of nothing. */
  reorderLevelMilli: number | bigint | string | null;
}) {
  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  const level = opts.reorderLevelMilli === null || opts.reorderLevelMilli === undefined || opts.reorderLevelMilli === ""
    ? null
    : BigInt(opts.reorderLevelMilli);
  if (level !== null && level < 0n) {
    throw new LedgerError("A reorder level cannot be negative. The floor is nothing, which means tell me the moment it runs out.");
  }

  const updated = await prisma.inventoryItem.update({ where: { id: item.id }, data: { reorderLevelMilli: level } });
  return {
    sku: updated.sku,
    reorderLevelMilli: updated.reorderLevelMilli === null ? null : updated.reorderLevelMilli.toString(),
    reorderLevel: updated.reorderLevelMilli === null ? null : fmtQty(updated.reorderLevelMilli),
    quantityMilli: updated.quantityMilli.toString(),
    monitored: updated.reorderLevelMilli !== null,
  };
}

/** Where this item is normally kept, so a movement need not say every time. */
export async function setDefaultLocation(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  /** The location code, or nil to fall back on the entity's default. */
  location: string | null;
}) {
  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  const loc = opts.location?.trim() ? await loadLocation(opts.orgId, opts.entityId, opts.location) : null;
  if (loc && loc.status !== "active") {
    throw new LedgerError(`${loc.code} ${loc.name} is closed, so it cannot be where ${item.sku} lives.`);
  }
  const updated = await prisma.inventoryItem.update({
    where: { id: item.id },
    data: { defaultLocationId: loc?.id ?? null },
  });
  return { sku: updated.sku, location: loc?.code ?? null };
}

/** Every location on the books, with whether it is the default. */
export async function locationList(opts: { orgId: string; entityId: string }) {
  const rows = await prisma.stockLocation.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: [{ isDefault: "desc" }, { code: "asc" }],
  });
  return { locations: rows.map(showLocation) };
}

/* ============================================ cost added after the goods are in */

/**
 * What arrived under one goods received note, and how much of it is still here.
 *
 * IAS 2.10 puts freight, duty, insurance and handling into the cost of the
 * goods they brought in, and a charge invoice almost always turns up after the
 * goods themselves. Landing it needs two facts this module already holds and
 * nothing else does: which items came in under that note, and — because some of
 * them will have been sold in the meantime — how much of each is left to carry
 * the cost.
 *
 * "How much is left" is answered first-in-first-out in both cases, and
 * deliberately so. A FIFO item has a layer per receipt and the layer is the
 * record, so the answer is read off it. A weighted-average item keeps no layers,
 * so the answer is worked from the movements: what was on the shelf immediately
 * before the receipt is consumed by later issues first, and only what is left
 * over comes out of this receipt. Assuming the opposite — that the newest goods
 * go first — would report a shipment as long gone while its stock sat on the
 * shelf, and the charge would be expensed against goods nobody had sold.
 *
 * Transfer legs are excluded. A transfer moved the goods between shelves; it did
 * not sell them, and counting it would report a warehouse move as a sale.
 */
export interface ReceiptLot {
  movementId: string;
  itemId: string;
  sku: string;
  name: string;
  uom: string;
  costMethod: string;
  stockAccount: string;
  cogsAccount: string;
  movedOn: string;
  /** What came in under the note, and what it cost before any charge landed. */
  quantityMilli: bigint;
  valueMinor: bigint;
  /** How much of that receipt is still on the shelf. */
  remainingMilli: bigint;
  /** The item as it stands, which is what a unit cost has to be read against. */
  itemQuantityMilli: bigint;
  itemValueMinor: bigint;
}

export async function receiptsUnder(opts: {
  orgId: string;
  entityId: string;
  reference: string;
}): Promise<ReceiptLot[]> {
  const ref = opts.reference?.trim();
  if (!ref) throw new LedgerError("A goods receipt has to be named before anything can be landed onto it.");
  if (ref.startsWith(TRANSFER_REF)) {
    throw new LedgerError(
      `${ref} is a transfer between locations rather than a receipt of goods. Nothing came into the business ` +
        `under it, so there is nothing for a charge to be carried on.`,
    );
  }

  const items = await prisma.inventoryItem.findMany({ where: { orgId: opts.orgId, entityId: opts.entityId } });
  if (!items.length) return [];
  const byId = new Map(items.map((i) => [i.id, i]));

  const movements = await prisma.inventoryMovement.findMany({
    where: { orgId: opts.orgId, itemId: { in: items.map((i) => i.id) }, kind: "RECEIPT", reference: ref },
    orderBy: [{ movedOn: "asc" }, { createdAt: "asc" }],
  });

  const out: ReceiptLot[] = [];
  for (const m of movements) {
    const item = byId.get(m.itemId);
    if (!item) continue;
    out.push({
      movementId: m.id,
      itemId: item.id,
      sku: item.sku,
      name: item.name,
      uom: item.uom,
      costMethod: item.costMethod,
      stockAccount: item.stockAccount,
      cogsAccount: item.cogsAccount,
      movedOn: iso(m.movedOn),
      quantityMilli: m.quantityMilli,
      valueMinor: m.valueMinor,
      remainingMilli: await receiptRemaining(item, m),
      itemQuantityMilli: item.quantityMilli,
      itemValueMinor: item.valueMinor,
    });
  }
  return out;
}

/** How much of one receipt is still on the shelf — see `receiptsUnder`. */
async function receiptRemaining(item: ItemRow, m: { id: string; quantityMilli: bigint; balanceQtyMilli: bigint }): Promise<bigint> {
  if (item.costMethod === "FIFO") {
    const layer = await prisma.inventoryLayer.findFirst({
      where: { orgId: item.orgId, itemId: item.id, movementId: m.id },
    });
    // The layer is the record under FIFO. An item with no layer for its own
    // receipt is a broken invariant rather than a nil answer, so it falls
    // through to the movements instead of quietly reporting nothing left.
    if (layer) return layer.remainingMilli;
  }

  // Ordered the way the rest of this module orders movements, and then walked
  // by position rather than compared by timestamp: two movements recorded in
  // the same millisecond are ordered here by the same rule the history uses,
  // so the answer cannot depend on how fast the machine happened to be.
  const all = await prisma.inventoryMovement.findMany({
    where: { orgId: item.orgId, itemId: item.id },
    orderBy: [{ movedOn: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, quantityMilli: true, reference: true },
  });
  const at = all.findIndex((x) => x.id === m.id);
  if (at < 0) return 0n;

  // What was on the shelf before this receipt is consumed first, and only what
  // the later issues take beyond it comes out of this receipt. Transfer legs
  // are left out: the goods changed shelf, not owner, and counting the leg that
  // left would report a forklift ride as a sale.
  const issued = all
    .slice(at + 1)
    .filter((x) => x.quantityMilli < 0n && !(x.reference ?? "").startsWith(TRANSFER_REF))
    .reduce((a, x) => a - x.quantityMilli, 0n);

  const before = m.balanceQtyMilli - m.quantityMilli;
  const consumed = issued > before ? issued - before : 0n;
  const left = m.quantityMilli - consumed;
  if (left <= 0n) return 0n;
  return left > item.quantityMilli ? item.quantityMilli : left;
}

/**
 * Add cost to stock without adding stock.
 *
 * The one movement that changes value and leaves quantity alone. IAS 2.10 makes
 * import duty, freight, insurance and handling part of what the goods cost, and
 * they are almost always billed after the goods have been received — so there
 * has to be a way of saying "these same units now cost more" that is not a
 * receipt of phantom quantity and not a stock count.
 *
 * It does not post. The charge reaches the ledger as one entry raised by whoever
 * is landing it, because a voucher covering four charge accounts and nine items
 * is one transaction and splitting it into nine would make it unreadable. The
 * movement names that entry, so the row still leads to the posting behind it.
 */
export async function capitaliseCost(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  movedOn: string;
  /** What to add to the cost of the stock, in minor units. Always positive. */
  valueMinor: number | bigint | string;
  /** The entry the caller has already posted for this cost. */
  entryId?: string | null;
  /** That entry's series and number, for the movement to read on its own. */
  entryReference?: string | null;
  /** Under FIFO, the receipt whose layer the cost belongs to. */
  ontoMovementId?: string | null;
  /** The voucher line. Doubles as the idempotency key. */
  reference?: string;
  memo?: string;
  actorId?: string;
}): Promise<MovementResult> {
  const value = BigInt(opts.valueMinor);
  if (value <= 0n) {
    throw new LedgerError(
      "Capitalising nothing onto stock is not a movement. A charge that reduces what goods cost is a credit " +
        "note against the supplier, and it belongs on the bill rather than here.",
    );
  }
  if (!opts.movedOn || Number.isNaN(new Date(opts.movedOn).getTime())) {
    throw new LedgerError("A cost added to stock needs the date it was added.");
  }

  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  const seen = await priorMovement(item, ["LANDED_COST"], opts.reference, { movedOn: opts.movedOn, valueMinor: value });
  if (seen) return replay(item, seen);

  const fifo = item.costMethod === "FIFO";
  if (fifo && !opts.ontoMovementId) {
    throw new LedgerError(
      `${item.sku} is costed first-in-first-out, so a cost added to it has to name the receipt it belongs to. ` +
        `Spreading it over every open layer would say the charge applied to shipments it never touched.`,
    );
  }

  return record({
    item,
    movedOn: opts.movedOn,
    ref: opts.reference,
    memo: opts.memo,
    actorId: opts.actorId,
    settle: async (_tx, held) => {
      // Asked of the row rather than of the copy this call read: the last unit
      // can be issued while a freight invoice is being landed on it, and a
      // charge capitalised onto nothing is cost stranded in 1200 for good.
      if (held.quantityMilli <= 0n) {
        throw new LedgerError(
          `${item.sku} holds no stock, so there is nothing left for that cost to be carried on. ` +
            `A charge on goods that have all been sold is an expense of the period they were sold in.`,
        );
      }
      return {
        kind: "LANDED_COST",
        qty: 0n,
        value,
        // No rate is supplied on purpose. A movement of nil quantity has no
        // effective unit cost of its own, so the row carries the item's average
        // after the cost landed, which is the figure a reader of that row wants.
        addToLayer: fifo && opts.ontoMovementId ? { movementId: opts.ontoMovementId, addMinor: value } : undefined,
      };
    },
    // The charge reached the ledger as one entry raised by whoever landed it,
    // so this movement names that entry rather than raising one of its own.
    given: { entryId: opts.entryId ?? null, reference: opts.entryReference ?? null },
  });
}
