import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { post, LedgerError, type PostLine } from "./post";
import { monthlyCharge } from "./assets";
import { ledgerBalances } from "./balances";

/**
 * Revaluation and impairment of fixed assets.
 *
 * One rule shapes everything here, and it is worth stating before any code.
 * IAS 16.39-40:
 *
 *   an increase in carrying amount goes to the revaluation surplus in equity —
 *   EXCEPT to the extent that it reverses a decrease previously charged to
 *   profit, which goes back to profit;
 *
 *   a decrease goes to profit — EXCEPT to the extent of a surplus already held
 *   for that asset, which comes out of equity first.
 *
 * Both exceptions are "for that asset". One building's surplus cannot absorb
 * another building's fall, and an entity-wide surplus balance therefore cannot
 * answer the question. That is why the surplus and the impairment charged so
 * far are carried on the asset, and why every event is kept rather than netted
 * into a running figure: the history is the rule's input.
 *
 * IAS 36.117 constrains the reversal of an impairment further — it can never
 * take the carrying amount above what it would have been had the impairment
 * never happened. That ceiling is computed from the asset's own schedule, not
 * remembered, so it stays right however many months have passed.
 *
 * Depreciation after a revaluation is charged on the new carrying amount over
 * the remaining life (IAS 16.31). The register keeps cost and accumulated
 * depreciation, so a revaluation restates the cost and clears the accumulated
 * depreciation against it — the "elimination" method of IAS 16.35(b), which is
 * the one that leaves the register readable afterwards.
 */

export const SURPLUS_ACCOUNT = "3300";
export const IMPAIRMENT_ACCOUNT = "6650";

export type RevaluationKind = "REVALUATION" | "IMPAIRMENT" | "REVERSAL";

type AssetRow = {
  id: string; code: string; name: string; method: string; acquiredOn: Date;
  costMinor: bigint; residualMinor: bigint; accumulatedMinor: bigint;
  usefulLifeMonths: number; ratePercent: unknown;
  assetAccount: string; accumAccount: string; expenseAccount: string;
  status: string; disposedOn: Date | null; depreciatedTo: string | null;
  surplusMinor: bigint; impairedMinor: bigint; basisFrom: Date | null;
};

function minor(v: number | bigint | string, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v.trim())) throw new LedgerError(`${what} must be a whole number of minor units.`);
    return BigInt(v.trim());
  }
  if (!Number.isInteger(v)) throw new LedgerError(`${what} must be in whole minor units, got ${v}.`);
  return BigInt(v);
}

function asDate(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date I can read.`);
  return d;
}

/**
 * A figure in the currency the asset is carried in, which is the book's.
 *
 * Through `fmtMinor`, the one function that knows each currency's exponent:
 * splitting the digits two from the right is right for a dirham and wrong by a
 * factor of ten for a Kuwaiti or Bahraini dinar or an Omani rial.
 */
const fmtIn = (currency: string) => (v: bigint) => fmtMinor(v, currency, { zero: "zero" });

/** The currency this entity keeps its books in. */
async function bookCurrency(orgId: string, entityId: string): Promise<string> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  return book?.functionalCurrency ?? "AED";
}

async function assetOf(scope: { orgId: string; entityId: string }, code: string): Promise<AssetRow> {
  const a = await prisma.fixedAsset.findFirst({
    where: { orgId: scope.orgId, entityId: scope.entityId, code },
  });
  if (!a) throw new LedgerError(`There is no asset ${code} on this entity's register.`);
  return a as unknown as AssetRow;
}

/** Carrying amount: cost less accumulated depreciation, as the register holds it. */
export const carryingOf = (a: Pick<AssetRow, "costMinor" | "accumulatedMinor">) =>
  a.costMinor - a.accumulatedMinor;

const monthsBetween = (from: Date, to: Date) =>
  (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());

/**
 * Depreciate a counterfactual carrying amount forward, using the asset's own
 * method over the life that remained when the path started.
 *
 * The month the path starts in is not charged: it has already been charged on
 * the register, and the two are meant to run in step from that point.
 */
function depreciateForward(
  a: AssetRow,
  path: { carrying: bigint; from: Date; life: number },
  to: Date,
): bigint {
  const months = monthsBetween(path.from, to);
  if (months <= 0) return path.carrying;

  const life = Math.max(1, path.life);
  let accumulated = 0n;
  const depreciable = path.carrying - a.residualMinor;
  for (let i = 1; i <= months && accumulated < depreciable; i++) {
    accumulated += monthlyCharge({
      method: a.method,
      costMinor: path.carrying,
      residualMinor: a.residualMinor,
      accumulatedMinor: accumulated,
      usefulLifeMonths: life,
      ratePercent: a.ratePercent === null ? null : Number(a.ratePercent),
    });
  }
  const left = path.carrying - (accumulated > depreciable ? depreciable : accumulated);
  return left < 0n ? 0n : left;
}

type EventRow = {
  seq: number; revaluedOn: Date; carryingBeforeMinor: bigint;
  toProfitMinor: bigint; lifeRemainingMonths: number;
};

/**
 * What the carrying amount would have been had nothing ever been impaired —
 * the IAS 36.117 ceiling on reversing an impairment.
 *
 * Replayed from the events rather than remembered, because the ceiling falls
 * every month as the asset would have gone on depreciating. A stored figure
 * would be right on the day it was written and slowly wrong afterwards, which
 * is the worst kind of wrong: nobody looks again.
 *
 * The path starts at the first impairment — the carrying amount immediately
 * before it, over the life that remained then — and only ever depreciates.
 * Later revaluations do not touch it: they are the events being capped, not
 * part of the counterfactual.
 */
export function unimpairedCarrying(a: AssetRow, events: EventRow[], asOf: Date): bigint {
  let path: { carrying: bigint; from: Date; life: number } | null = null;

  for (const e of [...events].sort((x, y) => x.seq - y.seq)) {
    if (e.revaluedOn > asOf) break;
    if (path) {
      const carried = depreciateForward(a, path, e.revaluedOn);
      path = {
        carrying: carried,
        from: e.revaluedOn,
        life: path.life - monthsBetween(path.from, e.revaluedOn),
      };
    } else if (e.toProfitMinor < 0n) {
      path = { carrying: e.carryingBeforeMinor, from: e.revaluedOn, life: e.lifeRemainingMonths };
    }
  }

  // Never impaired: there is nothing to reverse, so there is no room.
  if (!path) return carryingOf(a);
  return depreciateForward(a, path, asOf);
}

export interface Split {
  movementMinor: bigint;
  toSurplusMinor: bigint;
  toProfitMinor: bigint;
  kind: RevaluationKind;
  surplusAfterMinor: bigint;
  impairedAfterMinor: bigint;
  /** Said in words, because the split is the part a reader has to be able to check. */
  reasoning: string;
}

/**
 * The IAS 16.39-40 split, as a pure function so it can be reasoned about and
 * tested without a database anywhere near it.
 */
export function splitMovement(opts: {
  movementMinor: bigint;
  surplusMinor: bigint;
  impairedMinor: bigint;
  /** How much of an increase may go back to profit — the IAS 36.117 ceiling. */
  reversalRoomMinor: bigint;
  /**
   * The book's currency, for the figures in `reasoning`. This function is pure
   * arithmetic and has no book to ask, so a caller that has one passes it;
   * without it the reasoning reads in dirhams, which is what this ledger's
   * books are kept in unless somebody said otherwise.
   */
  currency?: string;
}): Split {
  const { movementMinor, surplusMinor, impairedMinor } = opts;
  const fmt = fmtIn(opts.currency ?? "AED");

  if (movementMinor === 0n) {
    return {
      movementMinor: 0n, toSurplusMinor: 0n, toProfitMinor: 0n, kind: "REVALUATION",
      surplusAfterMinor: surplusMinor, impairedAfterMinor: impairedMinor,
      reasoning: "The valuation is what the books already carry, so nothing moves.",
    };
  }

  if (movementMinor > 0n) {
    // An increase reverses a past charge to profit first, and only what is
    // left is a revaluation surplus. The room is capped both by what was
    // charged and by the IAS 36.117 ceiling, whichever binds first.
    const room = impairedMinor < opts.reversalRoomMinor ? impairedMinor : opts.reversalRoomMinor;
    const toProfit = movementMinor < room ? movementMinor : room;
    const toSurplus = movementMinor - toProfit;
    return {
      movementMinor,
      toSurplusMinor: toSurplus,
      toProfitMinor: toProfit,
      kind: toProfit > 0n && toSurplus === 0n ? "REVERSAL" : "REVALUATION",
      surplusAfterMinor: surplusMinor + toSurplus,
      impairedAfterMinor: impairedMinor - toProfit,
      reasoning:
        toProfit > 0n && toSurplus > 0n
          ? `${fmt(toProfit)} reverses the impairment charged to profit before, and the remaining ${fmt(toSurplus)} is a revaluation surplus (IAS 16.39, IAS 36.117).`
          : toProfit > 0n
            ? `The whole increase reverses an impairment charged to profit before, so it goes back to profit (IAS 36.117).`
            : `Nothing was charged to profit on this asset, so the whole increase is a revaluation surplus (IAS 16.39).`,
    };
  }

  // A decrease comes out of this asset's own surplus first, and only what is
  // left is charged to profit.
  const fall = -movementMinor;
  const fromSurplus = fall < surplusMinor ? fall : surplusMinor;
  const toProfit = fall - fromSurplus;
  return {
    movementMinor,
    toSurplusMinor: -fromSurplus,
    toProfitMinor: -toProfit,
    kind: fromSurplus > 0n && toProfit === 0n ? "REVALUATION" : "IMPAIRMENT",
    surplusAfterMinor: surplusMinor - fromSurplus,
    impairedAfterMinor: impairedMinor + toProfit,
    reasoning:
      fromSurplus > 0n && toProfit > 0n
        ? `${fmt(fromSurplus)} comes out of the surplus this asset already carries, and the remaining ${fmt(toProfit)} is charged to profit (IAS 16.40).`
        : fromSurplus > 0n
          ? `The whole fall comes out of the surplus this asset already carries, so nothing reaches profit (IAS 16.40).`
          : `This asset carries no revaluation surplus, so the whole fall is charged to profit (IAS 16.40).`,
  };
}

/* --------------------------------------------------------------- the event */

export interface RevalueResult {
  code: string;
  seq: number;
  kind: RevaluationKind;
  revaluedOn: string;
  carryingBeforeMinor: bigint;
  fairValueMinor: bigint;
  movementMinor: bigint;
  toSurplusMinor: bigint;
  toProfitMinor: bigint;
  surplusAfterMinor: bigint;
  impairedAfterMinor: bigint;
  ceilingMinor: bigint;
  entryId: string | null;
  reasoning: string;
  note: string;
}

/**
 * Revalue or impair an asset to an assessed amount.
 *
 * One entry point rather than three, because "revaluation", "impairment" and
 * "reversal" are not three different acts a person performs — they are what
 * the same act is called afterwards, depending on which way the value moved
 * and what had happened before. Asking somebody to choose the label first is
 * asking them to apply the rule this module exists to apply.
 */
export async function revalueAsset(opts: {
  orgId: string;
  entityId: string;
  code: string;
  on: Date | string;
  fairValueMinor: number | bigint | string;
  basis?: string;
  actorId?: string;
}): Promise<RevalueResult> {
  const currency = await bookCurrency(opts.orgId, opts.entityId);
  const fmt = fmtIn(currency);
  const asset = await assetOf(opts, opts.code);
  if (asset.status !== "active") {
    throw new LedgerError(
      `${asset.code} is ${asset.status.replace("_", " ")}, so there is nothing left to value. A disposal has already ` +
        `taken it off the books.`,
    );
  }

  const on = asDate(opts.on, "The valuation date");
  if (on < asset.acquiredOn) {
    throw new LedgerError(
      `${asset.code} was acquired on ${asset.acquiredOn.toISOString().slice(0, 10)} and cannot be valued before it existed.`,
    );
  }

  const fairValue = minor(opts.fairValueMinor, "The assessed value");
  if (fairValue < 0n) throw new LedgerError("An asset cannot be worth less than nothing. A value of nil writes it off in full.");

  const carryingBefore = carryingOf(asset);
  const movement = fairValue - carryingBefore;

  const history = (await prisma.assetRevaluation.findMany({
    where: { assetId: asset.id, orgId: opts.orgId },
    orderBy: { seq: "asc" },
    select: { seq: true, revaluedOn: true, carryingBeforeMinor: true, toProfitMinor: true, lifeRemainingMonths: true },
  })) as unknown as EventRow[];

  // The ceiling on reversing an impairment: what the asset would be carried at
  // now if it had never been impaired, less what it is carried at today.
  const ceiling = unimpairedCarrying(asset, history, on);
  const room = ceiling > carryingBefore ? ceiling - carryingBefore : 0n;

  // Life left at this moment, over which the revalued amount will be charged
  // (IAS 16.31). The basis month itself has already been charged, so the count
  // includes it.
  const elapsed = monthsBetween(asset.basisFrom ?? asset.acquiredOn, on) + (asset.basisFrom ? 0 : 1);
  const lifeRemaining = Math.max(1, asset.usefulLifeMonths - elapsed);

  const split = splitMovement({
    movementMinor: movement,
    surplusMinor: asset.surplusMinor,
    impairedMinor: asset.impairedMinor,
    reversalRoomMinor: room,
    currency,
  });

  if (movement === 0n) {
    return {
      code: asset.code, seq: 0, kind: "REVALUATION", revaluedOn: on.toISOString().slice(0, 10),
      carryingBeforeMinor: carryingBefore, fairValueMinor: fairValue, movementMinor: 0n,
      toSurplusMinor: 0n, toProfitMinor: 0n,
      surplusAfterMinor: asset.surplusMinor, impairedAfterMinor: asset.impairedMinor,
      ceilingMinor: ceiling, entryId: null, reasoning: split.reasoning,
      note: `${asset.code} is already carried at ${fmt(fairValue)}. Nothing posted.`,
    };
  }

  if (movement > 0n && room < movement - split.toSurplusMinor) {
    // Should be unreachable — the split caps profit at the room — but a rule
    // this consequential is worth asserting rather than trusting.
    throw new LedgerError("The reversal ceiling was miscomputed. Please report it.");
  }

  const last = await prisma.assetRevaluation.findFirst({
    where: { assetId: asset.id },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const seq = (last?.seq ?? 0) + 1;

  /*
   * IAS 16.35(b), the elimination method: accumulated depreciation is written
   * off against the cost and the asset is restated at its revalued amount. The
   * alternative — restating cost and depreciation proportionately — leaves a
   * register whose "cost" is a number that never happened, and every reader
   * afterwards has to be told to ignore it.
   */
  const lines: PostLine[] = [];
  if (asset.accumulatedMinor > 0n) {
    lines.push({ account: asset.accumAccount, debit: asset.accumulatedMinor, memo: `${asset.code} accumulated depreciation eliminated on revaluation` });
    lines.push({ account: asset.assetAccount, credit: asset.accumulatedMinor, memo: `${asset.code} cost restated` });
  }
  if (movement > 0n) {
    lines.push({ account: asset.assetAccount, debit: movement, memo: `${asset.code} revalued to ${fmt(fairValue)}` });
  } else {
    lines.push({ account: asset.assetAccount, credit: -movement, memo: `${asset.code} written down to ${fmt(fairValue)}` });
  }
  if (split.toSurplusMinor > 0n) {
    lines.push({ account: SURPLUS_ACCOUNT, credit: split.toSurplusMinor, memo: `${asset.code} revaluation surplus` });
  } else if (split.toSurplusMinor < 0n) {
    lines.push({ account: SURPLUS_ACCOUNT, debit: -split.toSurplusMinor, memo: `${asset.code} surplus released against the fall` });
  }
  if (split.toProfitMinor > 0n) {
    lines.push({ account: IMPAIRMENT_ACCOUNT, credit: split.toProfitMinor, memo: `${asset.code} impairment reversed` });
  } else if (split.toProfitMinor < 0n) {
    lines.push({ account: IMPAIRMENT_ACCOUNT, debit: -split.toProfitMinor, memo: `${asset.code} impairment charged` });
  }

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: on,
    source: "revaluation",
    sourceType: "ASSET_REVALUATION",
    sourceId: asset.id,
    memo: `${split.kind === "IMPAIRMENT" ? "Impairment" : split.kind === "REVERSAL" ? "Impairment reversal" : "Revaluation"} — ${asset.code} ${asset.name}`,
    // The key names the event, not the run: the same asset revalued twice on
    // one day is two events, and a retry of one of them is not the other.
    externalKey: `asset-revaluation:${asset.id}:${seq}`,
    series: "RV",
    actorId: opts.actorId,
    lines,
  });

  await prisma.$transaction([
    prisma.assetRevaluation.create({
      data: {
        orgId: opts.orgId, entityId: opts.entityId, assetId: asset.id, seq,
        revaluedOn: on, kind: split.kind,
        carryingBeforeMinor: carryingBefore, fairValueMinor: fairValue,
        movementMinor: movement,
        toSurplusMinor: split.toSurplusMinor, toProfitMinor: split.toProfitMinor,
        surplusAfterMinor: split.surplusAfterMinor,
        lifeRemainingMonths: lifeRemaining,
        basis: opts.basis?.trim() || null,
        entryId: entry.id,
      },
    }),
    prisma.fixedAsset.update({
      where: { id: asset.id },
      data: {
        // Cost is restated to the revalued amount and accumulated depreciation
        // starts again from there — which is what makes future depreciation
        // fall on the new carrying amount over the remaining life (IAS 16.31).
        costMinor: fairValue,
        accumulatedMinor: 0n,
        // The revalued amount is charged over what is left of the life, not
        // over the original life again — which would extend the asset by
        // however long it had already run.
        usefulLifeMonths: lifeRemaining,
        basisFrom: on,
        surplusMinor: split.surplusAfterMinor,
        impairedMinor: split.impairedAfterMinor,
      },
    }),
  ]);

  return {
    code: asset.code, seq, kind: split.kind, revaluedOn: on.toISOString().slice(0, 10),
    carryingBeforeMinor: carryingBefore, fairValueMinor: fairValue, movementMinor: movement,
    toSurplusMinor: split.toSurplusMinor, toProfitMinor: split.toProfitMinor,
    surplusAfterMinor: split.surplusAfterMinor, impairedAfterMinor: split.impairedAfterMinor,
    ceilingMinor: ceiling, entryId: entry.id, reasoning: split.reasoning,
    note:
      `${asset.code} moved from ${fmt(carryingBefore)} to ${fmt(fairValue)}. ${split.reasoning} ` +
      `Depreciation from here is charged on ${fmt(fairValue)} over the remaining life.`,
  };
}

/**
 * Transfer the surplus on an asset to retained earnings (IAS 16.41).
 *
 * Optional in the standard and deliberately manual here. It is a movement
 * within equity that changes no total, and doing it automatically would mean
 * the software deciding a policy question — whether the surplus is realised as
 * the asset is used or only when it is sold — on the business's behalf.
 */
export async function releaseSurplus(opts: {
  orgId: string;
  entityId: string;
  code: string;
  on: Date | string;
  amountMinor?: number | bigint | string;
  actorId?: string;
}) {
  const fmt = fmtIn(await bookCurrency(opts.orgId, opts.entityId));
  const asset = await assetOf(opts, opts.code);
  if (asset.surplusMinor <= 0n) {
    throw new LedgerError(`${asset.code} carries no revaluation surplus, so there is nothing to transfer.`);
  }
  const amount = opts.amountMinor === undefined ? asset.surplusMinor : minor(opts.amountMinor, "The amount to transfer");
  if (amount <= 0n) throw new LedgerError("A transfer of nothing is not a transfer.");
  if (amount > asset.surplusMinor) {
    throw new LedgerError(
      `${asset.code} carries a surplus of ${fmt(asset.surplusMinor)}; ${fmt(amount)} cannot be transferred out of it. ` +
        `A surplus is realised as the asset is used or when it is sold, and never more than was put there.`,
    );
  }

  const on = asDate(opts.on, "The transfer date");
  const entry = await post({
    orgId: opts.orgId, entityId: opts.entityId, entryDate: on,
    source: "revaluation", sourceType: "SURPLUS_TRANSFER", sourceId: asset.id,
    memo: `Revaluation surplus realised — ${asset.code}`,
    externalKey: `surplus-transfer:${asset.id}:${on.toISOString().slice(0, 10)}:${amount}`,
    series: "RV", actorId: opts.actorId,
    lines: [
      { account: SURPLUS_ACCOUNT, debit: amount, memo: `${asset.code} surplus realised` },
      { account: "3900", credit: amount, memo: `${asset.code} surplus to retained earnings` },
    ],
  });

  await prisma.fixedAsset.update({
    where: { id: asset.id },
    data: { surplusMinor: asset.surplusMinor - amount },
  });

  return {
    code: asset.code,
    transferredMinor: amount,
    surplusAfterMinor: asset.surplusMinor - amount,
    entryId: entry.id,
    note:
      `${fmt(amount)} moved from the revaluation surplus to retained earnings. Equity is unchanged in total — this ` +
      `only says how much of it is realised.`,
  };
}

/* -------------------------------------------------------------- the screen */

/**
 * The revaluation register, with the ledger balances it must agree with.
 *
 * The comparison is the reason to show it. A surplus in equity that no asset
 * accounts for is either a posting made by hand or an asset disposed of
 * without releasing it, and both are findings.
 */
export async function revaluationRegister(opts: { orgId: string; entityId: string }) {
  const assets = (await prisma.fixedAsset.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: [{ status: "asc" }, { code: "asc" }],
    include: { revaluations: { orderBy: { seq: "asc" } } },
  })) as unknown as (AssetRow & { revaluations: {
    seq: number; revaluedOn: Date; kind: string; carryingBeforeMinor: bigint; fairValueMinor: bigint;
    movementMinor: bigint; toSurplusMinor: bigint; toProfitMinor: bigint; surplusAfterMinor: bigint;
    basis: string | null; entryId: string | null;
  }[] })[];

  const revalued = assets.filter((a) => a.revaluations.length > 0 || a.surplusMinor > 0n || a.impairedMinor > 0n);
  const registerSurplus = assets
    .filter((a) => a.status === "active")
    .reduce((t, a) => t + a.surplusMinor, 0n);

  const ledger = await ledgerBalances({
    orgId: opts.orgId, entityId: opts.entityId, codes: [SURPLUS_ACCOUNT, IMPAIRMENT_ACCOUNT],
  });
  // Equity is a credit balance; the ledger holds credits negative.
  const ledgerSurplus = -(ledger.get(SURPLUS_ACCOUNT) ?? 0n);
  const ledgerImpairment = ledger.get(IMPAIRMENT_ACCOUNT) ?? 0n;

  return {
    assets: revalued.map((a) => ({
      code: a.code,
      name: a.name,
      status: a.status,
      carryingMinor: carryingOf(a),
      surplusMinor: a.surplusMinor,
      impairedMinor: a.impairedMinor,
      events: a.revaluations.map((r) => ({
        seq: r.seq,
        on: r.revaluedOn.toISOString().slice(0, 10),
        kind: r.kind,
        carryingBeforeMinor: r.carryingBeforeMinor,
        fairValueMinor: r.fairValueMinor,
        movementMinor: r.movementMinor,
        toSurplusMinor: r.toSurplusMinor,
        toProfitMinor: r.toProfitMinor,
        surplusAfterMinor: r.surplusAfterMinor,
        basis: r.basis,
        entryId: r.entryId,
      })),
    })),
    totals: {
      registerSurplusMinor: registerSurplus,
      impairedMinor: revalued.reduce((t, a) => t + a.impairedMinor, 0n),
    },
    reconciliation: {
      registerSurplusMinor: registerSurplus,
      ledgerSurplusMinor: ledgerSurplus,
      differenceMinor: registerSurplus - ledgerSurplus,
      /** Cumulative, so it will not equal a single year's charge. */
      ledgerImpairmentMinor: ledgerImpairment,
      agrees: registerSurplus === ledgerSurplus,
    },
  };
}

/** One asset's revaluation history, for the detail panel. */
export async function revaluationHistory(opts: { orgId: string; entityId: string; code: string }) {
  const asset = await assetOf(opts, opts.code);
  const events = await prisma.assetRevaluation.findMany({
    where: { assetId: asset.id, orgId: opts.orgId },
    orderBy: { seq: "asc" },
  });
  const today = new Date();
  return {
    code: asset.code,
    name: asset.name,
    carryingMinor: carryingOf(asset),
    surplusMinor: asset.surplusMinor,
    impairedMinor: asset.impairedMinor,
    /** What it would be carried at had it never been impaired — the reversal ceiling. */
    ceilingMinor: unimpairedCarrying(asset, events as unknown as EventRow[], today),
    events: events.map((e) => ({
      seq: e.seq,
      on: e.revaluedOn.toISOString().slice(0, 10),
      kind: e.kind,
      carryingBeforeMinor: e.carryingBeforeMinor,
      fairValueMinor: e.fairValueMinor,
      movementMinor: e.movementMinor,
      toSurplusMinor: e.toSurplusMinor,
      toProfitMinor: e.toProfitMinor,
      surplusAfterMinor: e.surplusAfterMinor,
      basis: e.basis,
      entryId: e.entryId,
    })),
  };
}
