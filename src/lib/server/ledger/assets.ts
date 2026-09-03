import { prisma } from "@/lib/server/prisma";
import { post, LedgerError } from "./post";

/**
 * Fixed assets and depreciation.
 *
 * The register and the ledger are kept as separate records on purpose. An
 * asset's useful life, method and residual value are estimates a person made;
 * the ledger records only their consequences. That separation is what makes a
 * register-to-ledger comparison meaningful — if 1500 and the register disagree,
 * that is a finding, and it can only be a finding if they are two records.
 *
 * Depreciation is posted forward, one period at a time, and never recomputed.
 * A schedule that recalculates history would rewrite prior periods every time
 * an estimate changed; under IAS 16 a change in estimate is prospective, and
 * prior periods stand.
 */

export type Method = "STRAIGHT_LINE" | "REDUCING_BALANCE";

export interface NewAsset {
  code: string;
  name: string;
  nameAr?: string;
  category?: string;
  acquiredOn: string;
  costMinor: number | bigint | string;
  residualMinor?: number | bigint | string;
  method?: Method;
  usefulLifeMonths: number;
  ratePercent?: number;
  assetAccount?: string;
  accumAccount?: string;
  expenseAccount?: string;
  notes?: string;
}

/** Register an asset that is already on the balance sheet. */
export async function addAsset(opts: { orgId: string; entityId: string; asset: NewAsset }) {
  const a = opts.asset;
  const cost = BigInt(a.costMinor);
  const residual = BigInt(a.residualMinor ?? 0);
  const method = a.method ?? "STRAIGHT_LINE";

  if (cost <= 0n) throw new LedgerError("An asset has to have cost something.");
  if (residual < 0n || residual > cost) {
    throw new LedgerError("Residual value cannot be negative, nor more than the asset cost.");
  }
  if (!Number.isInteger(a.usefulLifeMonths) || a.usefulLifeMonths <= 0) {
    throw new LedgerError("Useful life has to be a whole number of months, greater than zero.");
  }
  if (method === "REDUCING_BALANCE" && !(a.ratePercent && a.ratePercent > 0)) {
    throw new LedgerError("A reducing-balance asset needs an annual rate.");
  }
  if (method === "STRAIGHT_LINE" && a.ratePercent) {
    throw new LedgerError("A straight-line asset is depreciated over its life, not at a rate.");
  }

  const clash = await prisma.fixedAsset.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: a.code },
  });
  if (clash) throw new LedgerError(`Asset ${a.code} is already on the register.`);

  return prisma.fixedAsset.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId,
      code: a.code, name: a.name, nameAr: a.nameAr ?? null,
      category: a.category ?? "EQUIPMENT",
      acquiredOn: new Date(a.acquiredOn),
      costMinor: cost, residualMinor: residual,
      method, usefulLifeMonths: a.usefulLifeMonths,
      ratePercent: method === "REDUCING_BALANCE" ? a.ratePercent! : null,
      assetAccount: a.assetAccount ?? "1500",
      accumAccount: a.accumAccount ?? "1590",
      expenseAccount: a.expenseAccount ?? "6600",
      notes: a.notes ?? null,
    },
  });
}

type AssetRow = {
  id: string; code: string; name: string; method: string;
  costMinor: bigint; residualMinor: bigint; accumulatedMinor: bigint;
  usefulLifeMonths: number; ratePercent: unknown;
  acquiredOn: Date; depreciatedTo: string | null; status: string;
  assetAccount: string; accumAccount: string; expenseAccount: string;
};

/** "2026-03" → an ordinal, so periods can be compared and counted. */
const monthIndex = (label: string) => {
  const [y, m] = label.split("-").map(Number);
  return y * 12 + (m - 1);
};
const monthLabel = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * The charge for one month.
 *
 * Straight line divides the depreciable amount over the life. Reducing balance
 * takes the annual rate against what is left, monthly.
 *
 * Both are clamped so the total can never exceed cost less residual — the last
 * month of an asset's life absorbs whatever rounding left behind, which is why
 * the schedule finishes exactly rather than approximately.
 */
export function monthlyCharge(a: {
  method: string; costMinor: bigint; residualMinor: bigint; accumulatedMinor: bigint;
  usefulLifeMonths: number; ratePercent?: number | null;
}): bigint {
  const depreciable = a.costMinor - a.residualMinor;
  const remaining = depreciable - a.accumulatedMinor;
  if (remaining <= 0n) return 0n;

  let charge: bigint;
  if (a.method === "REDUCING_BALANCE") {
    const rate = Number(a.ratePercent ?? 0);
    if (!(rate > 0)) throw new LedgerError("A reducing-balance asset needs an annual rate.");
    // Net book value against the annual rate, one twelfth at a time. Scaled
    // integers throughout — a depreciation schedule computed in floats drifts.
    const nbv = a.costMinor - a.accumulatedMinor;
    const scaled = BigInt(Math.round(rate * 1_000_000));
    charge = (nbv * scaled) / (100n * 12n * 1_000_000n);
  } else {
    // Divide the depreciable amount, and let the final month take the remainder
    // so the schedule lands exactly on the residual.
    charge = depreciable / BigInt(a.usefulLifeMonths);
  }

  if (charge > remaining) charge = remaining;
  // The final month absorbs whatever integer division left behind. Without
  // this, 100 over three months charges 33 three times and leaves a fil on the
  // books forever — and reducing balance, which shrinks asymptotically, would
  // never finish at all. The test is whether what would be left after this
  // charge is smaller than another full charge; if so, this is the last one.
  if (remaining - charge < charge) charge = remaining;
  // A charge that rounded away to nothing still has value to write off.
  if (charge <= 0n) charge = remaining;
  return charge;
}

export interface DepreciationResult {
  period: string;
  assetsDepreciated: number;
  totalChargeMinor: string;
  entryId: string | null;
  reference: string | null;
  /** Assets skipped, and why — silence here would hide a stalled schedule. */
  skipped: { code: string; reason: string }[];
}

/**
 * Run depreciation for one month.
 *
 * Idempotent on the period: an asset already depreciated to that month is
 * skipped rather than charged twice, and the whole run posts as one journal so
 * a month's depreciation is one line in the register rather than fifty.
 */
export async function runDepreciation(opts: {
  orgId: string;
  entityId: string;
  /** YYYY-MM. */
  period: string;
  postingDate?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<DepreciationResult> {
  if (!/^\d{4}-\d{2}$/.test(opts.period)) throw new LedgerError("A depreciation period looks like 2026-03.");

  const assets = (await prisma.fixedAsset.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: "active" },
    orderBy: { code: "asc" },
  })) as unknown as AssetRow[];

  const target = monthIndex(opts.period);
  const skipped: { code: string; reason: string }[] = [];
  const charges: { asset: AssetRow; charge: bigint }[] = [];

  for (const a of assets) {
    const acquired = monthIndex(monthLabel(a.acquiredOn));
    if (acquired > target) {
      skipped.push({ code: a.code, reason: `acquired in ${monthLabel(a.acquiredOn)}, after this period` });
      continue;
    }
    if (a.depreciatedTo && monthIndex(a.depreciatedTo) >= target) {
      skipped.push({ code: a.code, reason: `already depreciated to ${a.depreciatedTo}` });
      continue;
    }
    // Do not silently catch up several months in one charge. A gap means a run
    // was missed, and quietly folding it into this month hides that.
    if (a.depreciatedTo && monthIndex(a.depreciatedTo) < target - 1) {
      skipped.push({
        code: a.code,
        reason: `last depreciated to ${a.depreciatedTo} — run the months in between first`,
      });
      continue;
    }
    const charge = monthlyCharge({
      method: a.method, costMinor: a.costMinor, residualMinor: a.residualMinor,
      accumulatedMinor: a.accumulatedMinor, usefulLifeMonths: a.usefulLifeMonths,
      ratePercent: a.ratePercent as number | null,
    });
    if (charge === 0n) {
      skipped.push({ code: a.code, reason: "fully depreciated" });
      continue;
    }
    charges.push({ asset: a, charge });
  }

  if (charges.length === 0) {
    return { period: opts.period, assetsDepreciated: 0, totalChargeMinor: "0", entryId: null, reference: null, skipped };
  }

  // Post on the last day of the period unless told otherwise — depreciation is
  // a period-end measurement, not an event on a particular day.
  const [y, m] = opts.period.split("-").map(Number);
  const entryDate = opts.postingDate ?? new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  const total = charges.reduce((a, c) => a + c.charge, 0n);
  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate,
    memo: `Depreciation for ${opts.period}`,
    source: "depreciation",
    sourceType: "DEPRECIATION_RUN",
    sourceId: opts.period,
    externalKey: `depreciation:${opts.entityId}:${opts.period}`,
    actorType: opts.actorType ?? "RULE",
    actorId: opts.actorId,
    series: "DP",
    lines: [
      ...charges.map((c) => ({
        account: c.asset.expenseAccount,
        debit: c.charge,
        memo: `${c.asset.code} ${c.asset.name}`,
      })),
      ...charges.map((c) => ({
        account: c.asset.accumAccount,
        credit: c.charge,
        memo: `${c.asset.code} ${c.asset.name}`,
      })),
    ],
  });

  // Advance the register only once the journal has committed. The other order
  // would leave assets marked depreciated with nothing in the books.
  await prisma.$transaction(
    charges.map((c) =>
      prisma.fixedAsset.update({
        where: { id: c.asset.id },
        data: { accumulatedMinor: c.asset.accumulatedMinor + c.charge, depreciatedTo: opts.period },
      }),
    ),
  );

  return {
    period: opts.period,
    assetsDepreciated: charges.length,
    totalChargeMinor: total.toString(),
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    skipped,
  };
}

/**
 * Dispose of an asset.
 *
 *   Dr  Cash/receivable        proceeds
 *   Dr  Accumulated depn       everything written off to date
 *     Cr  The asset              its original cost
 *   and the difference is a gain or a loss on disposal.
 */
export async function disposeAsset(opts: {
  orgId: string;
  entityId: string;
  assetCode: string;
  disposedOn: string;
  proceedsMinor: number | bigint | string;
  /** Where the proceeds landed. */
  proceedsAccount?: string;
  actorId?: string;
}) {
  const asset = (await prisma.fixedAsset.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.assetCode },
  })) as unknown as AssetRow | null;
  if (!asset) throw new LedgerError(`Asset ${opts.assetCode} is not on the register.`);
  if (asset.status !== "active") throw new LedgerError(`Asset ${asset.code} was already disposed of.`);

  const proceeds = BigInt(opts.proceedsMinor);
  if (proceeds < 0n) throw new LedgerError("Proceeds cannot be negative. A cost of disposal is a separate expense.");

  const nbv = asset.costMinor - asset.accumulatedMinor;
  const result = proceeds - nbv; // positive: a gain

  const lines: { account: string; debit?: bigint; credit?: bigint; memo?: string }[] = [];
  if (proceeds > 0n) {
    lines.push({ account: opts.proceedsAccount ?? "1010", debit: proceeds, memo: `Proceeds — ${asset.code}` });
  }
  if (asset.accumulatedMinor > 0n) {
    lines.push({ account: asset.accumAccount, debit: asset.accumulatedMinor, memo: `Accumulated depreciation written back` });
  }
  lines.push({ account: asset.assetAccount, credit: asset.costMinor, memo: `${asset.code} ${asset.name} removed` });
  if (result > 0n) lines.push({ account: "4900", credit: result, memo: "Gain on disposal" });
  if (result < 0n) lines.push({ account: "6900", debit: -result, memo: "Loss on disposal" });

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: opts.disposedOn,
    memo: `Disposal of ${asset.code} ${asset.name}`,
    source: "disposal",
    sourceType: "ASSET_DISPOSAL",
    sourceId: asset.id,
    externalKey: `disposal:${asset.id}`,
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "DA",
    lines: lines.map((l) => ({
      account: l.account,
      ...(l.debit !== undefined ? { debit: l.debit } : { credit: l.credit! }),
      memo: l.memo,
    })),
  });

  await prisma.fixedAsset.update({
    where: { id: asset.id },
    data: { status: "disposed", disposedOn: new Date(opts.disposedOn), proceedsMinor: proceeds },
  });

  return {
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    netBookValueMinor: nbv.toString(),
    resultMinor: result.toString(),
    gain: result >= 0n,
  };
}

/**
 * The asset register, with the ledger balances it is supposed to agree with.
 *
 * Showing both together is the point: a register nobody compares to the ledger
 * is a spreadsheet with extra steps.
 */
export async function assetRegister(opts: { orgId: string; entityId: string }) {
  const assets = (await prisma.fixedAsset.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: [{ status: "asc" }, { code: "asc" }],
  })) as unknown as AssetRow[];

  const active = assets.filter((a) => a.status === "active");
  const registerCost = active.reduce((a, x) => a + x.costMinor, 0n);
  const registerAccum = active.reduce((a, x) => a + x.accumulatedMinor, 0n);

  // What the ledger says the same accounts hold.
  const codes = [...new Set(active.flatMap((a) => [a.assetAccount, a.accumAccount]))];
  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: codes.length ? codes : ["1500", "1590"] } },
    select: { id: true, code: true },
  });
  const lines = accounts.length
    ? await prisma.journalLine.findMany({
        where: { orgId: opts.orgId, accountId: { in: accounts.map((a) => a.id) }, entry: { status: "posted" } },
        select: { accountId: true, functionalAmountMinor: true },
      })
    : [];
  const byCode = new Map(accounts.map((a) => [a.id, a.code]));
  let ledgerCost = 0n;
  let ledgerAccum = 0n;
  for (const l of lines) {
    const code = byCode.get(l.accountId);
    if (active.some((a) => a.assetAccount === code)) ledgerCost += l.functionalAmountMinor;
    if (active.some((a) => a.accumAccount === code)) ledgerAccum += -l.functionalAmountMinor;
  }

  return {
    assets: assets.map((a) => ({
      code: a.code,
      name: a.name,
      category: (a as unknown as { category: string }).category,
      acquiredOn: a.acquiredOn.toISOString().slice(0, 10),
      method: a.method,
      usefulLifeMonths: a.usefulLifeMonths,
      costMinor: a.costMinor.toString(),
      residualMinor: a.residualMinor.toString(),
      accumulatedMinor: a.accumulatedMinor.toString(),
      netBookValueMinor: (a.costMinor - a.accumulatedMinor).toString(),
      depreciatedTo: a.depreciatedTo,
      status: a.status,
    })),
    totals: {
      costMinor: registerCost.toString(),
      accumulatedMinor: registerAccum.toString(),
      netBookValueMinor: (registerCost - registerAccum).toString(),
    },
    ledger: {
      costMinor: ledgerCost.toString(),
      accumulatedMinor: ledgerAccum.toString(),
      // A register that does not tie to the ledger is the finding, so it is
      // reported rather than reconciled away.
      costAgrees: ledgerCost === registerCost,
      accumulatedAgrees: ledgerAccum === registerAccum,
    },
  };
}
