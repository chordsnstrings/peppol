/**
 * Locations, batches, serials, expiry and reorder levels — the rules only.
 *
 * The same division as inventory-fifo.ts. Everything that needs a database —
 * the postings, the balances carried on the item, which batch actually exists —
 * stays in inventory.ts, which owns them. What is left here is the part that
 * can be argued about on paper: where a movement lands when nobody said, what a
 * batch is allowed to give up, whether an item is below its level, and how a
 * single carried value is split across the places the goods are sitting.
 *
 * Quantities are thousandths and money is minor units, as everywhere else in
 * the stock module. Neither is ever a float.
 */

const MILLI = 1000n;

/** One whole unit. A serial number is exactly this much of a thing, or none. */
export const SERIAL_UNIT = MILLI;

export const BATCH_KINDS = ["BATCH", "SERIAL"] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

export function isBatchKind(value: string): value is BatchKind {
  return (BATCH_KINDS as readonly string[]).includes(value);
}

/**
 * Read a batch kind off the wire.
 *
 * Returns null rather than throwing, because the message that names the SKU and
 * the batch code belongs where those are known.
 */
export function readBatchKind(value: string | null | undefined, fallback: BatchKind = "BATCH"): BatchKind | null {
  if (value === undefined || value === null || value === "") return fallback;
  const k = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return isBatchKind(k) ? k : null;
}

/**
 * Where a movement lands when nobody said.
 *
 * Explicit, then the item's own shelf, then the entity's default, then nowhere.
 * Nowhere is a real answer: a business that has never opened a second location
 * should not be forced to invent one, and a movement with no location is
 * reported as unassigned rather than quietly attributed to the first location
 * somebody happened to create.
 */
export function resolveLocation(
  explicit: string | null | undefined,
  itemDefault: string | null | undefined,
  entityDefault: string | null | undefined,
): string | null {
  return explicit || itemDefault || entityDefault || null;
}

/** Why a batch cannot give up what is being asked of it. */
export type TakeRefusal =
  | { ok: false; reason: "serial-split" }
  | { ok: false; reason: "short"; heldMilli: bigint };

/**
 * What a batch is allowed to give up.
 *
 * A serial goes whole or not at all — half a serial number identifies half a
 * thing, which is the one job a serial number has to refuse. A batch goes as
 * far as it holds and no further: taking more than a batch holds means the next
 * batch is being consumed, and pretending otherwise is how a recall stops being
 * traceable.
 */
export function batchTake(a: { kind: BatchKind; heldMilli: bigint; wantedMilli: bigint }): { ok: true } | TakeRefusal {
  if (a.kind === "SERIAL" && a.wantedMilli !== SERIAL_UNIT) return { ok: false, reason: "serial-split" };
  if (a.wantedMilli > a.heldMilli) return { ok: false, reason: "short", heldMilli: a.heldMilli };
  return { ok: true };
}

/** What a batch is allowed to take in. A serial holds one unit or none. */
export function batchPut(a: { kind: BatchKind; heldMilli: bigint; addingMilli: bigint }): { ok: true } | { ok: false; reason: "serial-split" | "serial-reused" } {
  if (a.kind !== "SERIAL") return { ok: true };
  if (a.addingMilli !== SERIAL_UNIT) return { ok: false, reason: "serial-split" };
  if (a.heldMilli !== 0n) return { ok: false, reason: "serial-reused" };
  return { ok: true };
}

export interface ReorderVerdict {
  /**
   * Somebody has set a level. Nil and nought are different facts: nil is "no
   * one has decided what low means for this item", nought is "tell me the
   * moment it runs out". Collapsing them turns an unmanaged item into a
   * healthy one.
   */
  monitored: boolean;
  /** At or under the level. At is under: the level is where reordering starts. */
  below: boolean;
  /** How far under. Nought at exactly the level, which is still below. */
  shortfallMilli: bigint;
  /** What is already on order brings it back above the level. */
  covered: boolean;
}

export function reorderVerdict(a: {
  quantityMilli: bigint;
  reorderLevelMilli: bigint | null;
  onOrderMilli: bigint;
}): ReorderVerdict {
  if (a.reorderLevelMilli === null || a.reorderLevelMilli === undefined) {
    return { monitored: false, below: false, shortfallMilli: 0n, covered: false };
  }
  const below = a.quantityMilli <= a.reorderLevelMilli;
  return {
    monitored: true,
    below,
    shortfallMilli: below ? a.reorderLevelMilli - a.quantityMilli : 0n,
    // An order in flight is not stock, so it never suppresses the finding — it
    // only says somebody has already acted on it.
    covered: below && a.quantityMilli + a.onOrderMilli > a.reorderLevelMilli,
  };
}

/**
 * Split one carried value across the places the goods are sitting.
 *
 * The item is the authority on what its stock cost — the module's first opinion
 * — and a location holds a quantity, not a cost of its own. So a value per
 * location is derived, and the derivation must not lose or invent a fil: the
 * shares are floored and the residue goes on the largest holding, the same
 * discipline as settling a rounding residue onto the last FIFO layer touched.
 */
export function apportion(totalMinor: bigint, weights: bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, w) => a + w, 0n);
  if (sum <= 0n || totalMinor === 0n) return weights.map(() => 0n);

  const shares = weights.map((w) => (w <= 0n ? 0n : (totalMinor * w) / sum));
  const residue = totalMinor - shares.reduce((a, s) => a + s, 0n);
  if (residue !== 0n) {
    let biggest = 0;
    for (let i = 1; i < weights.length; i++) if (weights[i] > weights[biggest]) biggest = i;
    shares[biggest] += residue;
  }
  return shares;
}

/** The far edge of an expiry window, in whole days from the date asked about. */
export function expiryHorizon(asOf: Date, withinDays: number): Date {
  const out = new Date(asOf.getTime());
  out.setUTCDate(out.getUTCDate() + withinDays);
  return out;
}

/** Whole days from one date to another; negative once the date has passed. */
export function daysUntil(when: Date, asOf: Date): number {
  return Math.floor((startOfDay(when) - startOfDay(asOf)) / 86_400_000);
}

const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

export interface BatchTie {
  itemMilli: bigint;
  batchMilli: bigint;
  differenceMilli: bigint;
  agrees: boolean;
}

/**
 * The invariant that makes a batch register worth having.
 *
 * Two records built by different routes — the quantity carried on the item and
 * the quantities carried on its batches — compared rather than reconciled away.
 * A register that has never been tied to the item it describes is a list of
 * labels, and a recall run off it reaches the wrong shelves.
 */
export function tieBatches(itemMilli: bigint, batchMilli: bigint): BatchTie {
  return {
    itemMilli,
    batchMilli,
    differenceMilli: itemMilli - batchMilli,
    agrees: itemMilli === batchMilli,
  };
}
