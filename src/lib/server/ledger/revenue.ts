import { prisma } from "@/lib/server/prisma";
import { post, LedgerError, type PostLine } from "./post";
import { ledgerBalances } from "./balances";

/**
 * Revenue recognition under IFRS 15.
 *
 * The standard's five steps are: identify the contract, identify the
 * performance obligations, determine the transaction price, allocate that
 * price across the obligations, and recognise revenue as each obligation is
 * satisfied. Steps 1 and 2 are judgements a person makes; this module records
 * them. Steps 4 and 5 are arithmetic, and that is what it computes.
 *
 * What makes the module tractable is a single idea: **the books are corrected
 * to a target, not nudged by an increment.** At any date a contract has
 *
 *     position = earned − billed
 *
 * and IFRS 15.105 says a positive position is a contract asset and a negative
 * one a contract liability. Every recognition run reads what the ledger
 * already holds for the contract, computes what it should hold, and posts the
 * difference. Running twice therefore posts nothing the second time, running
 * after a modification posts the cumulative catch-up IFRS 15.21 asks for, and
 * running after a reversal repairs itself — none of which needs a special
 * case, because none of them is one.
 *
 * The module deliberately does not touch receivables or tax. An invoice
 * against a contract is still an invoice: it posts Dr 1100 / Cr revenue / Cr
 * VAT through the AR subledger, where the customer's balance and the FTA's
 * return are computed. All this module does is move revenue between the
 * period it was billed in and the period it was earned in:
 *
 *     Dr  4100  Revenue                  billed ahead of being earned
 *       Cr  2310  Contract liabilities
 *
 *     Dr  1310  Contract assets          earned ahead of being billed
 *       Cr  4100  Revenue
 *
 * Over the life of a contract the two sides cancel exactly, which is the
 * invariant the tests hold it to.
 */

/** IFRS 15.105 — the two presentation accounts, seeded into every chart. */
export const CONTRACT_ASSET_ACCOUNT = "1310";
export const CONTRACT_LIABILITY_ACCOUNT = "2310";

export type Timing = "POINT_IN_TIME" | "OVER_TIME";

export interface NewObligation {
  description: string;
  /** IFRS 15.76 — the price the good or service would sell for on its own. */
  standalonePriceMinor: number | bigint | string;
  timing?: Timing;
}

export interface NewContract {
  code: string;
  customerName: string;
  signedOn: Date | string;
  priceMinor: number | bigint | string;
  currency?: string;
  revenueAccount?: string;
  obligations: NewObligation[];
}

type Scope = { orgId: string; entityId: string };

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
 * IFRS 15.76: allocate the transaction price in proportion to standalone
 * selling prices.
 *
 * Proportions of an integer do not divide evenly, and the residue has to go
 * somewhere: if it is dropped, the allocation no longer sums to the price and
 * the contract quietly under-recognises for its whole life. It is given to the
 * obligations with the largest fractional remainders — the largest-remainder
 * method — and ties go to the earlier obligation so that the same inputs
 * always produce the same answer, which is what makes the figures auditable.
 */
export function allocate(standalone: bigint[], total: bigint): bigint[] {
  if (!standalone.length) throw new LedgerError("A contract needs at least one performance obligation.");
  const sum = standalone.reduce((a, b) => a + b, 0n);
  if (sum <= 0n) throw new LedgerError("Standalone selling prices must add up to something above nil.");

  const base = standalone.map((s) => (total * s) / sum);
  const remainder = standalone.map((s) => (total * s) % sum);
  let left = total - base.reduce((a, b) => a + b, 0n);

  const order = remainder
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));

  const out = [...base];
  for (const { i } of order) {
    if (left <= 0n) break;
    out[i] += 1n;
    left -= 1n;
  }
  return out;
}

/**
 * What an obligation has earned. A point-in-time obligation earns all of its
 * allocation on the day it is satisfied and nothing before; an over-time one
 * earns in proportion to progress (IFRS 15.39), measured in basis points so
 * that a half-finished obligation is 5000 rather than a float.
 */
function earned(o: { timing: string; allocatedMinor: bigint; progressBps: number; satisfiedOn: Date | null }): bigint {
  if (o.timing === "POINT_IN_TIME") return o.satisfiedOn ? o.allocatedMinor : 0n;
  return (o.allocatedMinor * BigInt(o.progressBps)) / 10000n;
}

async function contractOf(scope: Scope, code: string) {
  const c = await prisma.revenueContract.findFirst({
    where: { orgId: scope.orgId, entityId: scope.entityId, code },
    include: { obligations: { orderBy: { seq: "asc" } } },
  });
  if (!c) throw new LedgerError(`There is no contract ${code} on this entity.`);
  return c;
}

/* ------------------------------------------------------------- recording it */

export async function createContract(opts: Scope & { contract: NewContract }) {
  const c = opts.contract;
  const price = minor(c.priceMinor, "The transaction price");
  if (price <= 0n) throw new LedgerError("A contract with no transaction price has nothing to allocate.");
  if (!c.obligations?.length) {
    throw new LedgerError("A contract needs at least one performance obligation — what did we promise to deliver?");
  }

  const standalone = c.obligations.map((o, i) => {
    const v = minor(o.standalonePriceMinor, `Obligation ${i + 1}'s standalone selling price`);
    if (v <= 0n) {
      throw new LedgerError(
        `Obligation ${i + 1} has a standalone selling price of nil. IFRS 15 allocates in proportion to those prices, and nil has no proportion — estimate one (15.79 allows an expected-cost-plus-margin or residual estimate).`,
      );
    }
    return v;
  });

  const dup = await prisma.revenueContract.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: c.code },
    select: { customerName: true },
  });
  if (dup) throw new LedgerError(`Contract ${c.code} already exists — it is with ${dup.customerName}.`);

  const shares = allocate(standalone, price);

  return prisma.revenueContract.create({
    data: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      code: c.code,
      customerName: c.customerName,
      signedOn: asDate(c.signedOn, "The signing date"),
      priceMinor: price,
      currency: c.currency ?? "AED",
      revenueAccount: c.revenueAccount ?? "4100",
      obligations: {
        create: c.obligations.map((o, i) => ({
          orgId: opts.orgId,
          seq: i + 1,
          description: o.description,
          standalonePriceMinor: standalone[i],
          allocatedMinor: shares[i],
          timing: o.timing ?? "POINT_IN_TIME",
        })),
      },
    },
    include: { obligations: { orderBy: { seq: "asc" } } },
  });
}

/**
 * A contract modification that is not a separate contract (IFRS 15.21): the
 * price is reallocated over the remaining obligations and revenue already
 * recognised is caught up in the current period rather than restated.
 *
 * Recognised amounts are recomputed rather than carried, because they are a
 * function of the allocation: an obligation that is half done has earned half
 * of whatever it is now allocated, not half of what it used to be. Leaving
 * them stale would also breach the database's rule that recognised can never
 * exceed allocated, which is the same error seen from the other side.
 */
export async function modifyContract(
  opts: Scope & { code: string; priceMinor?: number | bigint | string; standalone?: Record<number, number | bigint | string> },
) {
  const c = await contractOf(opts, opts.code);
  if (c.status !== "active") throw new LedgerError(`Contract ${c.code} is ${c.status}, so there is nothing to modify.`);

  const price = opts.priceMinor === undefined ? c.priceMinor : minor(opts.priceMinor, "The transaction price");
  if (price <= 0n) throw new LedgerError("A modification cannot take the transaction price to nil — cancel the contract instead.");

  const standalone = c.obligations.map((o) => {
    const override = opts.standalone?.[o.seq];
    return override === undefined ? o.standalonePriceMinor : minor(override, `Obligation ${o.seq}'s standalone selling price`);
  });
  if (standalone.some((s) => s <= 0n)) throw new LedgerError("A standalone selling price has to be above nil.");

  const shares = allocate(standalone, price);

  await prisma.$transaction([
    prisma.revenueContract.update({ where: { id: c.id }, data: { priceMinor: price } }),
    ...c.obligations.map((o, i) =>
      prisma.performanceObligation.update({
        where: { id: o.id },
        data: {
          standalonePriceMinor: standalone[i],
          allocatedMinor: shares[i],
          recognisedMinor: earned({ ...o, allocatedMinor: shares[i] }),
        },
      }),
    ),
  ]);

  return contractOf(opts, opts.code);
}

/**
 * What invoices have charged against the contract, net of tax.
 *
 * This is recorded rather than posted: the invoice itself already reached the
 * ledger through the AR subledger, and posting it again here would recognise
 * the sale twice. All the contract needs to know is how much of its price has
 * been sent to the customer, so that the difference against what has been
 * earned can be presented.
 */
export async function recordBilling(
  opts: Scope & { code: string; amountMinor: number | bigint | string; invoiceRef?: string },
) {
  const c = await contractOf(opts, opts.code);
  if (c.status === "cancelled") throw new LedgerError(`Contract ${c.code} was cancelled; it cannot be billed.`);

  const amount = minor(opts.amountMinor, "The amount billed");
  if (amount === 0n) throw new LedgerError("There is nothing to record — the amount billed is nil.");

  const billed = c.billedMinor + amount;
  if (billed < 0n) {
    throw new LedgerError(
      `That credit takes the amount billed on ${c.code} below nil. ${fmt(c.billedMinor)} has been billed in total.`,
    );
  }
  if (billed > c.priceMinor) {
    throw new LedgerError(
      `Billing ${fmt(amount)} would take the total billed on ${c.code} to ${fmt(billed)}, above its transaction price of ${fmt(c.priceMinor)}. If the price has changed, modify the contract first — otherwise the excess is not this contract's revenue.`,
    );
  }

  return prisma.revenueContract.update({ where: { id: c.id }, data: { billedMinor: billed } });
}

/** A point-in-time obligation is satisfied on the day control transfers. */
export async function satisfyObligation(opts: Scope & { code: string; seq: number; on: Date | string }) {
  const c = await contractOf(opts, opts.code);
  if (c.status !== "active") throw new LedgerError(`Contract ${c.code} is ${c.status}.`);

  const o = c.obligations.find((x) => x.seq === opts.seq);
  if (!o) throw new LedgerError(`Contract ${c.code} has no obligation ${opts.seq}.`);
  if (o.timing !== "POINT_IN_TIME") {
    throw new LedgerError(
      `Obligation ${o.seq} is satisfied over time, so it has a degree of progress rather than a day it was done. Set its progress instead.`,
    );
  }
  if (o.satisfiedOn) throw new LedgerError(`Obligation ${o.seq} was already satisfied on ${iso(o.satisfiedOn)}.`);

  await prisma.performanceObligation.update({
    where: { id: o.id },
    data: { satisfiedOn: asDate(opts.on, "The date it was satisfied"), recognisedMinor: o.allocatedMinor, progressBps: 10000 },
  });
  return contractOf(opts, opts.code);
}

/**
 * Progress on an over-time obligation, in basis points.
 *
 * Progress is allowed to fall. A measure of progress is an estimate, and IFRS
 * 15.87 requires it to be updated as circumstances change; refusing a downward
 * revision would only push the correction into a journal nobody can trace back
 * to the contract. The recognition run posts the reduction as a negative
 * catch-up, which is what a change in estimate should look like.
 */
export async function setProgress(opts: Scope & { code: string; seq: number; progressBps: number }) {
  const c = await contractOf(opts, opts.code);
  if (c.status !== "active") throw new LedgerError(`Contract ${c.code} is ${c.status}.`);

  const o = c.obligations.find((x) => x.seq === opts.seq);
  if (!o) throw new LedgerError(`Contract ${c.code} has no obligation ${opts.seq}.`);
  if (o.timing !== "OVER_TIME") {
    throw new LedgerError(
      `Obligation ${o.seq} is satisfied at a point in time — it is either delivered or it is not. Mark it satisfied instead of part done.`,
    );
  }
  if (!Number.isInteger(opts.progressBps) || opts.progressBps < 0 || opts.progressBps > 10000) {
    throw new LedgerError("Progress is in basis points, from 0 to 10000 — 2500 is a quarter complete.");
  }

  await prisma.performanceObligation.update({
    where: { id: o.id },
    data: {
      progressBps: opts.progressBps,
      recognisedMinor: (o.allocatedMinor * BigInt(opts.progressBps)) / 10000n,
      satisfiedOn: opts.progressBps === 10000 ? new Date() : null,
    },
  });
  return contractOf(opts, opts.code);
}

/**
 * Stop recognising. Revenue already earned stays earned — the work was done —
 * so cancelling freezes the contract where it stands rather than unwinding it.
 * Anything owed back to the customer is a credit note, which is a document,
 * not a change to what this contract measured.
 */
export async function cancelContract(opts: Scope & { code: string; reason?: string }) {
  const c = await contractOf(opts, opts.code);
  if (c.status === "cancelled") throw new LedgerError(`Contract ${c.code} is already cancelled.`);
  return prisma.revenueContract.update({ where: { id: c.id }, data: { status: "cancelled" } });
}

/* -------------------------------------------------------------- the numbers */

export interface ContractPosition {
  code: string;
  customerName: string;
  status: string;
  currency: string;
  priceMinor: bigint;
  billedMinor: bigint;
  earnedMinor: bigint;
  /** earned − billed: positive is a contract asset, negative a contract liability. */
  positionMinor: bigint;
  contractAssetMinor: bigint;
  contractLiabilityMinor: bigint;
  /** Price still unallocated to any satisfied obligation — the backlog. */
  unearnedMinor: bigint;
  obligations: {
    seq: number;
    description: string;
    timing: string;
    standalonePriceMinor: bigint;
    allocatedMinor: bigint;
    recognisedMinor: bigint;
    progressBps: number;
    satisfiedOn: Date | null;
  }[];
}

type ContractRow = Awaited<ReturnType<typeof contractOf>>;

export function positionOf(c: ContractRow): ContractPosition {
  const earnedTotal = c.obligations.reduce((a, o) => a + earned(o), 0n);
  const position = earnedTotal - c.billedMinor;
  return {
    code: c.code,
    customerName: c.customerName,
    status: c.status,
    currency: c.currency,
    priceMinor: c.priceMinor,
    billedMinor: c.billedMinor,
    earnedMinor: earnedTotal,
    positionMinor: position,
    contractAssetMinor: position > 0n ? position : 0n,
    contractLiabilityMinor: position < 0n ? -position : 0n,
    unearnedMinor: c.priceMinor - earnedTotal,
    obligations: c.obligations.map((o) => ({
      seq: o.seq,
      description: o.description,
      timing: o.timing,
      standalonePriceMinor: o.standalonePriceMinor,
      allocatedMinor: o.allocatedMinor,
      recognisedMinor: o.recognisedMinor,
      progressBps: o.progressBps,
      satisfiedOn: o.satisfiedOn,
    })),
  };
}

/**
 * What this module has already put on the ledger for one contract.
 *
 * Read back rather than remembered. A stored figure would drift the moment
 * anyone reversed one of these entries by hand, and the whole point of
 * correcting to a target is that the target is compared against the truth.
 */
async function postedFor(scope: Scope, contractId: string) {
  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: scope.orgId,
      account: { entityId: scope.entityId, code: { in: [CONTRACT_ASSET_ACCOUNT, CONTRACT_LIABILITY_ACCOUNT] } },
      // Both halves of a reversed pair, so that a reversal nets to nothing
      // instead of counting once and moving the figure the wrong way.
      entry: { status: { in: ["posted", "reversed"] }, sourceType: "revenue_contract", sourceId: contractId },
    },
    select: { functionalAmountMinor: true, account: { select: { code: true } } },
  });

  let asset = 0n;
  let liability = 0n;
  for (const l of lines) {
    if (l.account.code === CONTRACT_ASSET_ACCOUNT) asset += l.functionalAmountMinor;
    // Credits are negative in the ledger, and a liability is a credit balance.
    else liability -= l.functionalAmountMinor;
  }
  return { asset, liability };
}

/** The same figures for many contracts at once, for the register. */
async function postedByContract(scope: Scope, contractIds: string[]) {
  const out = new Map<string, { asset: bigint; liability: bigint }>();
  if (!contractIds.length) return out;

  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: scope.orgId,
      account: { entityId: scope.entityId, code: { in: [CONTRACT_ASSET_ACCOUNT, CONTRACT_LIABILITY_ACCOUNT] } },
      entry: { status: { in: ["posted", "reversed"] }, sourceType: "revenue_contract", sourceId: { in: contractIds } },
    },
    select: { functionalAmountMinor: true, account: { select: { code: true } }, entry: { select: { sourceId: true } } },
  });

  for (const id of contractIds) out.set(id, { asset: 0n, liability: 0n });
  for (const l of lines) {
    const cur = out.get(l.entry.sourceId ?? "");
    if (!cur) continue;
    if (l.account.code === CONTRACT_ASSET_ACCOUNT) cur.asset += l.functionalAmountMinor;
    else cur.liability -= l.functionalAmountMinor;
  }
  return out;
}

/* ---------------------------------------------------------------- the entry */

export interface RecognitionResult {
  code: string;
  posted: boolean;
  entryId?: string;
  /** Revenue moved by this run; positive means revenue was credited. */
  revenueMinor: bigint;
  contractAssetMinor: bigint;
  contractLiabilityMinor: bigint;
  note: string;
}

/**
 * Bring one contract's ledger position to where the contract says it should
 * be, and post only the difference.
 */
export async function runRecognition(
  opts: Scope & { code: string; on: Date | string },
): Promise<RecognitionResult> {
  const c = await contractOf(opts, opts.code);
  const pos = positionOf(c);
  const already = await postedFor(opts, c.id);

  const dAsset = pos.contractAssetMinor - already.asset;
  const dLiability = pos.contractLiabilityMinor - already.liability;
  // Revenue is the balancing figure: whatever the two presentation accounts
  // move by, the other side of it is revenue.
  const dRevenue = dAsset - dLiability;

  if (dAsset === 0n && dLiability === 0n) {
    return {
      code: c.code,
      posted: false,
      revenueMinor: 0n,
      contractAssetMinor: pos.contractAssetMinor,
      contractLiabilityMinor: pos.contractLiabilityMinor,
      note: `${c.code} is already presented correctly: ${describe(pos)}.`,
    };
  }

  const lines: PostLine[] = [];
  if (dAsset > 0n) lines.push({ account: CONTRACT_ASSET_ACCOUNT, debit: dAsset, memo: `${c.code} earned ahead of billing` });
  else if (dAsset < 0n) lines.push({ account: CONTRACT_ASSET_ACCOUNT, credit: -dAsset, memo: `${c.code} contract asset billed out` });

  if (dLiability > 0n) lines.push({ account: CONTRACT_LIABILITY_ACCOUNT, credit: dLiability, memo: `${c.code} billed ahead of delivery` });
  else if (dLiability < 0n) lines.push({ account: CONTRACT_LIABILITY_ACCOUNT, debit: -dLiability, memo: `${c.code} deferred revenue earned` });

  if (dRevenue > 0n) lines.push({ account: c.revenueAccount, credit: dRevenue, memo: `${c.code} revenue recognised` });
  else if (dRevenue < 0n) lines.push({ account: c.revenueAccount, debit: -dRevenue, memo: `${c.code} revenue deferred` });

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: asDate(opts.on, "The recognition date"),
    source: "revenue",
    sourceType: "revenue_contract",
    sourceId: c.id,
    memo: `Revenue recognition — ${c.code}, ${c.customerName}`,
    // The key names the state being moved to rather than the run that moved
    // it, so a retry that has already been applied is recognised as such and a
    // genuinely different target is never mistaken for a duplicate.
    externalKey: `revenue:${c.id}:${iso(asDate(opts.on, "date"))}:${pos.contractAssetMinor}:${pos.contractLiabilityMinor}`,
    lines,
  });

  // A contract that has delivered everything and billed everything is done.
  if (c.status === "active" && pos.earnedMinor === c.priceMinor && c.billedMinor === c.priceMinor) {
    await prisma.revenueContract.update({ where: { id: c.id }, data: { status: "complete" } });
  }

  return {
    code: c.code,
    posted: true,
    entryId: entry.id,
    revenueMinor: dRevenue,
    contractAssetMinor: pos.contractAssetMinor,
    contractLiabilityMinor: pos.contractLiabilityMinor,
    note: `${describe(pos)}.`,
  };
}

/**
 * Every contract, in one pass, for a period close.
 *
 * Complete and cancelled contracts are included even though they normally have
 * nothing left to move. The run corrects to a target, so passing over them is
 * what puts a contract back where it belongs after someone reverses one of
 * these entries by hand — and skipping them would leave exactly that kind of
 * damage in place with no screen ever showing it.
 */
export async function runRecognitionAll(opts: Scope & { on: Date | string }) {
  const contracts = await prisma.revenueContract.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    select: { code: true },
    orderBy: { code: "asc" },
  });

  const results: RecognitionResult[] = [];
  for (const c of contracts) results.push(await runRecognition({ ...opts, code: c.code }));
  return {
    results,
    postedCount: results.filter((r) => r.posted).length,
    revenueMinor: results.reduce((a, r) => a + r.revenueMinor, 0n),
  };
}

/* --------------------------------------------------------------- the screen */

/**
 * The register, with the ledger balances it should agree with.
 *
 * The comparison is the reason this screen exists. Contract assets and
 * liabilities are the two figures an auditor asks to see supported, and a
 * register that cannot be tied to the ledger supports nothing.
 */
export async function contractRegister(opts: Scope) {
  const rows = await prisma.revenueContract.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    include: { obligations: { orderBy: { seq: "asc" } } },
    orderBy: [{ status: "asc" }, { code: "asc" }],
  });

  const positions = rows.map(positionOf);
  const registerAsset = positions.reduce((a, p) => a + p.contractAssetMinor, 0n);
  const registerLiability = positions.reduce((a, p) => a + p.contractLiabilityMinor, 0n);

  const ledger = await ledgerBalances({
    orgId: opts.orgId,
    entityId: opts.entityId,
    codes: [CONTRACT_ASSET_ACCOUNT, CONTRACT_LIABILITY_ACCOUNT],
  });
  const ledgerAsset = ledger.get(CONTRACT_ASSET_ACCOUNT) ?? 0n;
  const ledgerLiability = -(ledger.get(CONTRACT_LIABILITY_ACCOUNT) ?? 0n);

  // A difference has two very different causes, and a screen that cannot tell
  // them apart is useless. Work delivered since the last recognition run is an
  // ordinary difference with an obvious remedy; a difference left over once
  // that is accounted for is a defect, and should be read as one.
  const posted = await postedByContract(opts, rows.map((r) => r.id));
  const pendingAsset = positions.reduce(
    (a, p, i) => a + (p.contractAssetMinor - (posted.get(rows[i].id)?.asset ?? 0n)), 0n,
  );
  const pendingLiability = positions.reduce(
    (a, p, i) => a + (p.contractLiabilityMinor - (posted.get(rows[i].id)?.liability ?? 0n)), 0n,
  );

  return {
    contracts: positions,
    totals: {
      priceMinor: positions.reduce((a, p) => a + p.priceMinor, 0n),
      billedMinor: positions.reduce((a, p) => a + p.billedMinor, 0n),
      earnedMinor: positions.reduce((a, p) => a + p.earnedMinor, 0n),
      unearnedMinor: positions.reduce((a, p) => a + p.unearnedMinor, 0n),
    },
    reconciliation: {
      registerAssetMinor: registerAsset,
      ledgerAssetMinor: ledgerAsset,
      assetDifferenceMinor: registerAsset - ledgerAsset,
      registerLiabilityMinor: registerLiability,
      ledgerLiabilityMinor: ledgerLiability,
      liabilityDifferenceMinor: registerLiability - ledgerLiability,
      /** Of the difference, what a recognition run would post right now. */
      pendingAssetMinor: pendingAsset,
      pendingLiabilityMinor: pendingLiability,
      agrees: registerAsset === ledgerAsset && registerLiability === ledgerLiability,
      /** True when every difference is explained by a run not yet made. */
      explained:
        registerAsset - ledgerAsset === pendingAsset &&
        registerLiability - ledgerLiability === pendingLiability,
    },
  };
}

/** One contract in full, for the detail panel. */
export async function contractDetail(opts: Scope & { code: string }) {
  const c = await contractOf(opts, opts.code);
  const posted = await postedFor(opts, c.id);
  const pos = positionOf(c);
  return {
    ...pos,
    revenueAccount: c.revenueAccount,
    signedOn: c.signedOn,
    postedAssetMinor: posted.asset,
    postedLiabilityMinor: posted.liability,
    /** What a recognition run would move right now. Nil means nothing to do. */
    pendingMinor: pos.contractAssetMinor - posted.asset - (pos.contractLiabilityMinor - posted.liability),
  };
}

/* ---------------------------------------------------------------- niceties */

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmt(v: bigint): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(3, "0");
  const body = `${s.slice(0, -2)}.${s.slice(-2)}`;
  return neg ? `(${body})` : body;
}

function describe(p: ContractPosition): string {
  if (p.contractAssetMinor > 0n) return `${fmt(p.contractAssetMinor)} earned but not yet billed`;
  if (p.contractLiabilityMinor > 0n) return `${fmt(p.contractLiabilityMinor)} billed but not yet earned`;
  return "billing and delivery are level";
}
