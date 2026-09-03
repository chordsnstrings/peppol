/**
 * FIFO cost layers — the arithmetic only.
 *
 * Weighted average carries one number and needs no history: the average after
 * each movement is enough to value what is left. First-in-first-out cannot be
 * reconstructed from that, because an average is precisely the thing that
 * forgets which receipt a unit came from. So the layers are the record, and
 * this file is the part of it that can be reasoned about without a database:
 * given the open layers and a quantity, what did that quantity cost.
 *
 * The ledger postings, the balances carried on the item and the decision about
 * which method an item is on all stay in inventory.ts, which owns them.
 */

const MILLI = 1000n;

/** One open receipt, as much of it as is left. */
export interface CostLayer {
  id: string;
  seq: number;
  receivedOn: Date;
  remainingMilli: bigint;
  unitCostMinor: bigint;
}

/** What one issue took out of one layer. */
export interface LayerTake {
  layerId: string;
  seq: number;
  receivedOn: Date;
  quantityMilli: bigint;
  unitCostMinor: bigint;
  costMinor: bigint;
  /** The take emptied the layer. */
  exhausted: boolean;
}

export interface Consumption {
  takes: LayerTake[];
  costMinor: bigint;
  /** What the layers could not cover. Anything above nil is a broken invariant. */
  shortMilli: bigint;
}

/**
 * Oldest first, by the date the goods arrived rather than the order somebody
 * keyed them. FIFO is a statement about the goods, and a receipt entered a week
 * late is still the earlier receipt. Movements already recorded are not
 * rewritten by it — they are append-only — so a back-dated receipt changes the
 * cost of future issues and of nothing else.
 */
export function oldestFirst<T extends { receivedOn: Date; seq: number }>(layers: T[]): T[] {
  return [...layers].sort((a, b) => a.receivedOn.getTime() - b.receivedOn.getTime() || a.seq - b.seq);
}

/**
 * Take a quantity out of the layers, oldest first.
 *
 * The cost of the issue is the sum of what it took from each layer, so an issue
 * that spans layers has no single unit cost — only an effective one, which is
 * what `effectiveUnitCost` below is for.
 */
export function planConsumption(layers: CostLayer[], quantityMilli: bigint): Consumption {
  const takes: LayerTake[] = [];
  let left = quantityMilli;
  let costMinor = 0n;

  for (const layer of oldestFirst(layers)) {
    if (left <= 0n) break;
    if (layer.remainingMilli <= 0n) continue;
    const take = layer.remainingMilli < left ? layer.remainingMilli : left;
    // Floored for the same reason the weighted average is floored: a cost
    // rounded up drifts above what was actually paid, and the drift compounds.
    const cost = (layer.unitCostMinor * take) / MILLI;
    takes.push({
      layerId: layer.id,
      seq: layer.seq,
      receivedOn: layer.receivedOn,
      quantityMilli: take,
      unitCostMinor: layer.unitCostMinor,
      costMinor: cost,
      exhausted: take === layer.remainingMilli,
    });
    costMinor += cost;
    left -= take;
  }

  return { takes, costMinor, shortMilli: left };
}

/**
 * The cost per whole unit an issue actually bore.
 *
 * Not a price anyone paid: an issue spanning three layers bought at three
 * prices bore all three, and this is their average weighted by how much came
 * out of each. It is recorded on the movement so the row reads on its own,
 * never used to value anything else.
 */
export function effectiveUnitCost(costMinor: bigint, quantityMilli: bigint): bigint {
  if (quantityMilli <= 0n) return 0n;
  return (costMinor * MILLI) / quantityMilli;
}

/** What a layer still holds, in minor units. */
export function layerValue(layer: { remainingMilli: bigint; unitCostMinor: bigint }): bigint {
  return (layer.unitCostMinor * layer.remainingMilli) / MILLI;
}

/**
 * Put a rounding residue on the last layer the issue touched.
 *
 * Flooring each take leaves a few fils unallocated, and the item's carried
 * value — not the layers — is the authority on what the stock cost. When the
 * two must agree exactly (the issue that empties the item takes the whole
 * remaining value) the difference belongs on the last layer touched, because
 * that is the one still being drawn from.
 */
export function settleTakes(takes: LayerTake[], costMinor: bigint): LayerTake[] {
  if (!takes.length) return takes;
  const planned = takes.reduce((a, t) => a + t.costMinor, 0n);
  if (planned === costMinor) return takes;
  const out = takes.map((t) => ({ ...t }));
  out[out.length - 1].costMinor += costMinor - planned;
  return out;
}
