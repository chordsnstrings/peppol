import { createHash } from "node:crypto";
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

/**
 * Where each category of asset posts, absent an explicit override.
 *
 * INTANGIBLE is the one that matters. A capitalised software licence or an ERP
 * implementation went onto this register as category IT, and the register's
 * defaults then put it on 1500 with the plant and machinery, amortised it
 * through 6600 "Depreciation", and presented it under a note headed "Property,
 * plant and equipment". The arithmetic was right — straight-line over a finite
 * life IS amortisation — and the caption, the account and the disclosure were
 * all wrong, which is a year-end problem rather than a monthly one and
 * therefore the kind nobody notices until an auditor does.
 *
 * The chart has carried 1560, 1570 and 6610 all along. What was missing was
 * anything routing to them: a person had to know to type three account codes,
 * and the screen offered no category that would make them think to.
 *
 * IAS 38.54 is why this is a category and not a checkbox: an intangible is
 * recognised only when it meets the definition and the recognition criteria,
 * and that is a judgement somebody makes about the item — not something the
 * ledger can infer from an amount.
 */
export const CATEGORY_ACCOUNTS: Record<string, { asset: string; accum: string; expense: string }> = {
  INTANGIBLE: { asset: "1560", accum: "1570", expense: "6610" },
};

/** What everything else posts to: property, plant and equipment. */
const DEFAULT_ACCOUNTS = { asset: "1500", accum: "1590", expense: "6600" };

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

  const category = a.category ?? "EQUIPMENT";
  const accounts = CATEGORY_ACCOUNTS[category] ?? DEFAULT_ACCOUNTS;

  // An intangible with no end to its life is not amortised at all (IAS 38.107)
  // and is tested for impairment instead. This register has no such path —
  // `usefulLifeMonths` is a required positive integer — so it is refused by
  // name rather than quietly given a life somebody did not choose.
  if (category === "INTANGIBLE" && method === "REDUCING_BALANCE") {
    throw new LedgerError(
      `${a.code} is an intangible asset, and IAS 38.98 allows a reducing-balance pattern only where the pattern ` +
        `of consumption can actually be shown to be that — which is why straight-line is what almost every ` +
        `intangible uses. Register it straight-line over its useful life.`,
    );
  }

  return prisma.fixedAsset.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId,
      code: a.code, name: a.name, nameAr: a.nameAr ?? null,
      category,
      acquiredOn: new Date(a.acquiredOn),
      costMinor: cost, residualMinor: residual,
      method, usefulLifeMonths: a.usefulLifeMonths,
      ratePercent: method === "REDUCING_BALANCE" ? a.ratePercent! : null,
      // Routed by category, and still overridable one account at a time — a
      // business with its own chart may put motor vehicles somewhere of its
      // own, and an override on one account must not drag the other two with
      // it.
      assetAccount: a.assetAccount ?? accounts.asset,
      accumAccount: a.accumAccount ?? accounts.accum,
      expenseAccount: a.expenseAccount ?? accounts.expense,
      notes: a.notes ?? null,
    },
  });
}

type AssetRow = {
  id: string; code: string; name: string; method: string;
  costMinor: bigint; residualMinor: bigint; accumulatedMinor: bigint;
  usefulLifeMonths: number; ratePercent: unknown;
  acquiredOn: Date; depreciatedTo: string | null; status: string; disposedOn: Date | null;
  proceedsMinor: bigint | null;
  basisFrom: Date | null;
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

/**
 * What an asset would have accumulated by a date, from its own schedule.
 *
 * The register keeps one running figure, which answers "what is it worth now"
 * and nothing else. A note or a statement drawn for a past year needs the
 * register as it stood then, and the running figure would put today's
 * accumulated depreciation beside that year's ledger — a difference that looks
 * like a defect and is only the wrong question.
 *
 * Recomputed month by month rather than divided, because the schedule is a step
 * function: reducing balance depends on what has already gone, and both methods
 * let the last month absorb the rounding. Dividing would be right in the middle
 * of an asset's life and wrong at both ends.
 */
export function accumulatedAt(
  a: {
    method: string; costMinor: bigint; residualMinor: bigint;
    usefulLifeMonths: number; ratePercent?: number | null; acquiredOn: Date;
    /**
     * Where the current cost basis starts, once a revaluation has restated it.
     * Counting from the acquisition after a revaluation would charge the new
     * amount over the original life again and extend the asset's life by
     * however long it had already run.
     */
    basisFrom?: Date | null;
  },
  asOf: Date,
): bigint {
  const from = a.basisFrom ?? a.acquiredOn;
  if (asOf < from) return 0n;

  const months =
    (asOf.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (asOf.getUTCMonth() - from.getUTCMonth());
  if (months < 0) return 0n;

  let accumulated = 0n;
  const depreciable = a.costMinor - a.residualMinor;
  // The month of acquisition is charged, which is what runDepreciation does.
  //
  // A revalued asset starts from the month AFTER its basis date instead: the
  // revaluation happens at a point when that month has already been charged on
  // the old cost, and charging it again on the new one would take a month out
  // of the asset's life every time it was valued.
  const first = a.basisFrom ? 1 : 0;
  for (let i = first; i <= months && accumulated < depreciable; i++) {
    accumulated += monthlyCharge({ ...a, accumulatedMinor: accumulated });
  }
  return accumulated > depreciable ? depreciable : accumulated;
}

/**
 * A stable fingerprint of what a run is about to charge, so the idempotency key
 * describes the charge rather than only the month it falls in.
 */
function chargeDigest(charges: { asset: { id: string }; charge: bigint }[]): string {
  const body = charges
    .map((c) => `${c.asset.id}:${c.charge}`)
    .sort()
    .join("|");
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
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
    // Keyed on WHAT is being charged, not merely the month.
    //
    // With a month-only key, an asset acquired into a month already
    // depreciated would find the earlier entry, post() would return it having
    // written nothing, and the register below would still be advanced — a
    // charge with no journal behind it, leaving the register permanently ahead
    // of account 1590 with nothing to show why. Keying on the set of assets
    // and amounts means a genuinely different charge gets its own entry, while
    // an identical re-run still returns the original.
    externalKey: `depreciation:${opts.entityId}:${opts.period}:${chargeDigest(charges)}`,
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
export async function assetRegister(opts: {
  orgId: string;
  entityId: string;
  /**
   * The date to draw the register at. Left out, it is the register as it
   * stands — which is the right answer for the screen and the wrong one for a
   * note about a year that has already closed.
   */
  asOf?: Date | string;
}) {
  const asOf = opts.asOf === undefined
    ? null
    : typeof opts.asOf === "string" ? new Date(opts.asOf) : opts.asOf;
  if (asOf && Number.isNaN(asOf.getTime())) throw new LedgerError("A register needs a date it can read.");

  const all = (await prisma.fixedAsset.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: [{ status: "asc" }, { code: "asc" }],
  })) as unknown as AssetRow[];

  // At a past date the population is different: an asset bought since is not
  // in it, and one disposed of since still is.
  const assets = !asOf
    ? all
    : all
        .filter((a) => a.acquiredOn <= asOf)
        .map((a) => {
          const disposedLater = a.disposedOn ? a.disposedOn > asOf : false;
          return {
            ...a,
            status: disposedLater ? "active" : a.status,
            // A disposal that had not happened yet has no date and no proceeds
            // at this date either. Carrying them onto a row shown as active
            // would date a sale into a year that had not seen it.
            disposedOn: disposedLater ? null : a.disposedOn,
            proceedsMinor: disposedLater ? null : a.proceedsMinor,
            accumulatedMinor: accumulatedAt({ ...a, ratePercent: a.ratePercent === null ? null : Number(a.ratePercent) }, asOf),
          } as AssetRow;
        });

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
        where: { orgId: opts.orgId, accountId: { in: accounts.map((a) => a.id) },
          // A reversed entry and its reversal net to nothing; reading only
          // "posted" lines counts the reversal alone and moves the balance by
          // the full amount, which shows up here as a false difference.
          entry: { status: { in: ["posted", "reversed"] }, ...(asOf ? { entryDate: { lte: asOf } } : {}) } },
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
      // The account the cost sits on. A reader of the register can tell
      // property, plant and equipment from an intangible without inferring it
      // from the category — and the IAS 38 note needs the accounts, because an
      // asset can be routed to 1560 by an explicit override without its
      // category saying so.
      assetAccount: a.assetAccount,
      accumAccount: a.accumAccount,
      acquiredOn: a.acquiredOn.toISOString().slice(0, 10),
      method: a.method,
      usefulLifeMonths: a.usefulLifeMonths,
      costMinor: a.costMinor.toString(),
      residualMinor: a.residualMinor.toString(),
      accumulatedMinor: a.accumulatedMinor.toString(),
      netBookValueMinor: (a.costMinor - a.accumulatedMinor).toString(),
      depreciatedTo: a.depreciatedTo,
      status: a.status,
      // What happened to a disposed one. Without these the register says only
      // that the asset is gone: a reader cannot tell whether it went last month
      // or three years ago, nor what it fetched, and the entry that would tell
      // them has already taken the cost and the depreciation off this row.
      // Both are null for an asset still on the books.
      disposedOn: a.disposedOn ? a.disposedOn.toISOString().slice(0, 10) : null,
      proceedsMinor: a.proceedsMinor === null ? null : a.proceedsMinor.toString(),
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
