import { prisma } from "@/lib/server/prisma";
import { post, LedgerError } from "./post";

/**
 * Inventory, valued at weighted average cost.
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
 * Quantities are thousandths, so 1.5 kg is 1500. Money is minor units. Neither
 * is ever a float.
 */

const MILLI = 1000n;

export interface NewItem {
  sku: string;
  name: string;
  nameAr?: string;
  uom?: string;
  stockAccount?: string;
  cogsAccount?: string;
  varianceAccount?: string;
}

export async function addItem(opts: { orgId: string; entityId: string; item: NewItem }) {
  const i = opts.item;
  if (!i.sku?.trim()) throw new LedgerError("An item needs a SKU.");
  if (!i.name?.trim()) throw new LedgerError("An item needs a name.");

  const clash = await prisma.inventoryItem.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, sku: i.sku.trim() },
  });
  if (clash) throw new LedgerError(`SKU ${i.sku} already exists.`);

  return prisma.inventoryItem.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId,
      sku: i.sku.trim(), name: i.name.trim(), nameAr: i.nameAr ?? null,
      uom: i.uom ?? "EA",
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

export interface MovementResult {
  movementId: string;
  entryId: string | null;
  reference: string | null;
  quantityMilli: string;
  valueMinor: string;
  unitCostMinor: string;
  balanceQtyMilli: string;
  balanceValueMinor: string;
}

async function loadItem(orgId: string, entityId: string, sku: string) {
  const item = await prisma.inventoryItem.findFirst({ where: { orgId, entityId, sku } });
  if (!item) throw new LedgerError(`SKU ${sku} is not on the item list.`);
  if (item.status !== "active") throw new LedgerError(`SKU ${sku} is archived.`);
  return item;
}

/**
 * Receive stock.
 *
 *   Dr  1200  Inventory     what it cost
 *     Cr  the contra          where the cost came from — a supplier, or cash
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
  const newQty = item.quantityMilli + qty;
  const newValue = item.valueMinor + value;

  let entryId: string | null = null;
  let reference: string | null = null;
  if (!opts.alreadyPosted && value > 0n) {
    const entry = await post({
      orgId: opts.orgId, entityId: opts.entityId, entryDate: opts.movedOn,
      memo: opts.memo ?? `Stock received — ${item.sku}`,
      source: "inventory", sourceType: "RECEIPT", sourceId: item.id,
      actorType: "HUMAN", actorId: opts.actorId, series: "IN",
      lines: [
        { account: item.stockAccount, debit: value, memo: `${item.sku} ${item.name}` },
        { account: opts.contraAccount ?? "2000", credit: value, memo: `${item.sku} received` },
      ],
    });
    entryId = entry.id;
    reference = `${entry.series}-${entry.number}`;
  }

  return record({
    item, kind: "RECEIPT", movedOn: opts.movedOn, qty, value,
    newQty, newValue, entryId, reference, ref: opts.reference, memo: opts.memo,
  });
}

/**
 * Issue stock — a sale, or consumption.
 *
 *   Dr  5000  Cost of goods sold   at the weighted average
 *     Cr  1200  Inventory
 *
 * The value is what the stock is carried at, not what it sold for. Confusing
 * the two is how gross margin ends up meaningless.
 */
export async function issue(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  movedOn: string;
  quantityMilli: number | bigint | string;
  reference?: string;
  memo?: string;
  actorId?: string;
}): Promise<MovementResult> {
  const qty = BigInt(opts.quantityMilli);
  if (qty <= 0n) throw new LedgerError("An issue has to be a positive quantity.");

  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  if (qty > item.quantityMilli) {
    throw new LedgerError(
      `There are only ${fmtQty(item.quantityMilli)} ${item.uom} of ${item.sku} in stock, and ${fmtQty(qty)} was issued. ` +
        `A receipt is probably missing — issuing stock the system has no cost for would mean inventing one.`,
    );
  }

  const value = issueValue(item, qty);
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
  });
}

/**
 * A stock count adjustment or a write-off.
 *
 * The difference between what the shelf holds and what the system says is a
 * real cost, and it goes to its own account rather than being buried in cost of
 * sales — a business that cannot see its shrinkage cannot manage it.
 */
export async function adjust(opts: {
  orgId: string;
  entityId: string;
  sku: string;
  movedOn: string;
  /** The quantity actually counted, in thousandths. */
  countedMilli: number | bigint | string;
  reason?: string;
  actorId?: string;
}): Promise<MovementResult> {
  const counted = BigInt(opts.countedMilli);
  if (counted < 0n) throw new LedgerError("A stock count cannot be negative.");

  const item = await loadItem(opts.orgId, opts.entityId, opts.sku);
  const delta = counted - item.quantityMilli;
  if (delta === 0n) throw new LedgerError(`The count agrees with the system: ${fmtQty(counted)} ${item.uom}. Nothing to adjust.`);

  const rate = unitCost(item.valueMinor, item.quantityMilli);
  // A surplus is valued at the current average. A shortfall removes what that
  // quantity was carried at, and the last unit takes the remainder.
  const value = delta > 0n
    ? (rate * delta) / MILLI
    : -issueValue(item, -delta);

  const newQty = counted;
  const newValue = newQty === 0n ? 0n : item.valueMinor + value;

  let entryId: string | null = null;
  let reference: string | null = null;
  if (value !== 0n) {
    const entry = await post({
      orgId: opts.orgId, entityId: opts.entityId, entryDate: opts.movedOn,
      memo: opts.reason ?? `Stock adjustment — ${item.sku}`,
      source: "inventory", sourceType: "ADJUSTMENT", sourceId: item.id,
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

  return record({
    item, kind: delta < 0n ? "WRITE_OFF" : "ADJUSTMENT", movedOn: opts.movedOn,
    qty: delta, value, newQty, newValue, entryId, reference,
    ref: undefined, memo: opts.reason,
  });
}

async function record(a: {
  item: { id: string; orgId: string };
  kind: string; movedOn: string; qty: bigint; value: bigint;
  newQty: bigint; newValue: bigint;
  entryId: string | null; reference: string | null;
  ref?: string; memo?: string;
}): Promise<MovementResult> {
  const rate = unitCost(a.newValue, a.newQty);

  // The item and its movement commit together. An item updated without a
  // movement is stock with no history; a movement without the update is history
  // that does not add up.
  const [movement] = await prisma.$transaction([
    prisma.inventoryMovement.create({
      data: {
        orgId: a.item.orgId, itemId: a.item.id, movedOn: new Date(a.movedOn),
        kind: a.kind, quantityMilli: a.qty, valueMinor: a.value,
        unitCostMinor: rate, balanceQtyMilli: a.newQty, balanceValueMinor: a.newValue,
        reference: a.ref ?? null, memo: a.memo ?? null, entryId: a.entryId,
      },
    }),
    prisma.inventoryItem.update({
      where: { id: a.item.id },
      data: { quantityMilli: a.newQty, valueMinor: a.newValue },
    }),
  ]);

  return {
    movementId: movement.id,
    entryId: a.entryId,
    reference: a.reference,
    quantityMilli: a.qty.toString(),
    valueMinor: a.value.toString(),
    unitCostMinor: rate.toString(),
    balanceQtyMilli: a.newQty.toString(),
    balanceValueMinor: a.newValue.toString(),
  };
}

const fmtQty = (milli: bigint) => {
  const neg = milli < 0n;
  const abs = neg ? -milli : milli;
  const whole = abs / MILLI;
  const frac = (abs % MILLI).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
};

/**
 * The stock valuation report, against the ledger account it must agree with.
 *
 * Same principle as the fixed-asset register: two records, compared. A stock
 * list that has never been checked against 1200 is a list of hopes.
 */
export async function stockValuation(opts: { orgId: string; entityId: string }) {
  const items = await prisma.inventoryItem.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { sku: "asc" },
  });

  const registerValue = items.reduce((a, i) => a + i.valueMinor, 0n);

  const codes = [...new Set(items.map((i) => i.stockAccount))];
  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: codes.length ? codes : ["1200"] } },
    select: { id: true },
  });
  const lines = accounts.length
    ? await prisma.journalLine.findMany({
        // Both halves of a reversed pair, or the ledger side of this comparison
        // is short by the reversal and the valuation appears not to tie.
        where: {
          orgId: opts.orgId, accountId: { in: accounts.map((a) => a.id) },
          entry: { status: { in: ["posted", "reversed"] } },
        },
        select: { functionalAmountMinor: true },
      })
    : [];
  const ledgerValue = lines.reduce((a, l) => a + l.functionalAmountMinor, 0n);

  return {
    items: items.map((i) => ({
      sku: i.sku, name: i.name, uom: i.uom, status: i.status,
      quantityMilli: i.quantityMilli.toString(),
      quantity: fmtQty(i.quantityMilli),
      valueMinor: i.valueMinor.toString(),
      unitCostMinor: unitCost(i.valueMinor, i.quantityMilli).toString(),
    })),
    totals: { valueMinor: registerValue.toString() },
    ledger: {
      valueMinor: ledgerValue.toString(),
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
  return {
    item: { sku: item.sku, name: item.name, uom: item.uom },
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
