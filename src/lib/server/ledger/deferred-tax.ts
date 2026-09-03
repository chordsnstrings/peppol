import { prisma } from "@/lib/server/prisma";
import { LedgerError, post } from "./post";
import { CT_RATE_PERCENT, ZERO_BAND_MINOR, type MinorInput } from "./corptax";

/**
 * Deferred tax under IAS 12, measured from a dated register of temporary
 * differences.
 *
 * `corptax.ts` computes the CURRENT tax — what this period's taxable income
 * costs. This computes the DEFERRED tax — what the differences between the
 * accounts and the tax law will cost, or save, later. They are the same tax
 * seen at two moments, so the rate here is the rate there (imported, not
 * retyped), and the two modules have to be read together: an entity that
 * elects Small Business Relief has no current tax and, if it expects to keep
 * electing it, very little deferred tax either.
 *
 * The register is kept PER REPORTING DATE rather than as a running balance,
 * for the reason the migration gives: the charge for a period is the movement
 * between two positions, and a running balance that is overwritten can no
 * longer be asked what the previous position was. That question is the first
 * one an auditor puts, and "the number we have now" is not an answer to it.
 *
 * What reaches the ledger is the NET position, on the account matching its
 * side; the gross halves stay in the register as a disclosure. See the note on
 * offset below — under IAS 12.74 the offset is required, not permitted, for a
 * single UAE taxable person, so a balance sheet showing both halves would be
 * wrong.
 *
 * This measures deferred tax. It does not file anything, and it does not
 * decide whether future taxable profit is probable — that is a judgement a
 * person makes and records in `unrecognisedMinor`.
 */

/**
 * The sign convention, which is the thing this module exists to get right.
 *
 * IAS 12.5 defines a temporary difference as carrying amount less tax base.
 * IAS 12.15 then recognises a deferred tax LIABILITY for a taxable difference
 * and IAS 12.24 a deferred tax ASSET for a deductible one. The standard states
 * the test twice, once for each side of the balance sheet, with the signs
 * reversed between them:
 *
 *   an ASSET     carried ABOVE its tax base  → taxable    → a liability
 *   an ASSET     carried BELOW its tax base  → deductible → an asset
 *   a  LIABILITY carried ABOVE its tax base  → deductible → an asset
 *   a  LIABILITY carried BELOW its tax base  → taxable    → a liability
 *
 * The reversal is not an exception to be memorised; it falls out of what the
 * two amounts mean. An asset's carrying amount is a benefit that will flow in
 * and be taxed, and its tax base is what will be deductible against that
 * benefit (IAS 12.7) — so carrying above base is income that will be taxed
 * later. A liability's carrying amount is an obligation that will flow out,
 * and its tax base is that carrying amount LESS whatever will be deductible
 * when it is settled (IAS 12.8) — so carrying above base is a deduction that
 * will be taken later. Same subtraction, opposite consequence, because which
 * side of the balance sheet the item sits on decides which way the money runs.
 *
 * Rather than carry a nature flag that could contradict the figures beside it,
 * both amounts are recorded SIGNED as the balance sheet holds them: an asset
 * positive, a liability negative — the same convention `post.ts` uses for a
 * debit and a credit. The four rules then collapse into one, and the reversal
 * is carried by the sign rather than by a branch someone can get backwards:
 *
 *   carrying − taxBase > 0  → taxable    → deferred tax LIABILITY
 *   carrying − taxBase < 0  → deductible → deferred tax ASSET
 *
 * Worked, to show the liability rule really is still in there. A warranty
 * provision of AED 100 deductible only when paid has a tax base of nil
 * (IAS 12.8), which the standard's own wording makes a deductible difference
 * of 100 and therefore an asset. Signed, it is a carrying amount of −100
 * against a tax base of −0: a difference of −100, negative, an asset. The one
 * rule reproduces the two.
 *
 * A tax loss carried forward needs no special case either: nothing is carried
 * in the accounts and the tax base is the loss still available, so carrying
 * (0) less tax base (positive) is negative — an asset, recognised only so far
 * as IAS 12.34 allows.
 */

/**
 * Where this is certain, and where it is only as good as its inputs.
 *
 * Firm: the arithmetic above; measurement at the rate expected to apply when
 * the difference reverses (IAS 12.47); no discounting, ever (IAS 12.53); the
 * offset test (IAS 12.74); and the charge for a period being the movement in
 * the recognised position (IAS 12.58).
 *
 * Not firm, and the reason `rateBps` is an input rather than a constant: the
 * UAE rate is not flat. Article 3 of Federal Decree-Law 47/2022 charges nil on
 * the first AED 375,000 of taxable income and 9% above it, and Ministerial
 * Decision 73/2023 lets a small business elect to be treated as having none at
 * all. The rate at which a difference will actually reverse therefore depends
 * on how much taxable income the entity expects in the year of reversal, which
 * is a forecast this software does not hold and cannot infer. 9% is the
 * default because it is right for an entity comfortably above the band; for
 * one sitting near it, 9% overstates both the asset and the liability, and the
 * position says so rather than implying it knows better.
 *
 * Not implemented at all, and warned about where they could bite: the initial
 * recognition exemption (IAS 12.15(b), 12.24(b)); deferred tax on investments
 * in subsidiaries, branches and associates (IAS 12.39-45); tax groups, whose
 * offset test under IAS 12.74 is a different question from a single entity's;
 * Qualifying Free Zone Persons (FDL 47/2022 Article 18), whose 0% rate makes
 * most differences reverse at nothing; and the transitional rules in
 * Ministerial Decision 120/2023 for balances brought in at the start of the
 * first tax period.
 */

/** 1320 — deferred tax asset. Non-current whichever way it falls (IAS 1.56). */
export const ACC_DEFERRED_TAX_ASSET = "1320";
/** 2320 — deferred tax liability. */
export const ACC_DEFERRED_TAX_LIABILITY = "2320";
/** 7010 — the charge or credit to profit or loss (IAS 12.58). */
export const ACC_DEFERRED_TAX_EXPENSE = "7010";

/**
 * The default measurement rate, in basis points, taken from the current tax
 * module rather than restated. Deferred tax measured at a rate the current tax
 * computation does not use is two answers to one question.
 */
export const HEADLINE_RATE_BPS = Number(CT_RATE_PERCENT) * 100;

/**
 * IAS 12.74, in one place, because it is a presentation rule that decides what
 * actually reaches the ledger and it should not be paraphrased twice.
 */
export const OFFSET_BASIS =
  `IAS 12.74 requires deferred tax assets and liabilities to be offset where the entity has a legally ` +
  `enforceable right to set off current tax assets against current tax liabilities, and both relate to income ` +
  `taxes levied by the same taxation authority on the same taxable entity. A single UAE taxable person is ` +
  `assessed by the Federal Tax Authority under Federal Decree-Law 47/2022 on one return, so both conditions ` +
  `hold: the balance sheet carries one net figure and the ledger is posted net. Neither condition can be ` +
  `assumed across a tax group or across jurisdictions, and neither is modelled here.`;

export type DeferredTaxCategory = "FIXED_ASSET" | "PROVISION" | "LEASE" | "LOSS" | "REVENUE" | "OTHER";

export const DEFERRED_TAX_CATEGORIES: DeferredTaxCategory[] = [
  "FIXED_ASSET", "PROVISION", "LEASE", "LOSS", "REVENUE", "OTHER",
];

/** IAS 12.81(g) wants the note by TYPE of difference, so the type is labelled. */
export const CATEGORY_LABEL: Record<DeferredTaxCategory, string> = {
  FIXED_ASSET: "Property, plant and equipment",
  PROVISION: "Provisions and accruals",
  LEASE: "Leases",
  LOSS: "Tax losses carried forward",
  REVENUE: "Revenue taxed in a different period",
  OTHER: "Other temporary differences",
};

/** Which side of the balance sheet an item sits on — carried by its sign. */
export type BalanceSheetSide = "asset" | "liability" | "none";
/** What the difference does: taxed later, or deducted later. */
export type DifferenceKind = "taxable" | "deductible" | "none";

export interface DeferredTaxItemInput {
  code: string;
  description: string;
  category?: DeferredTaxCategory;
  /** SIGNED as the balance sheet holds it: an asset positive, a liability negative. */
  carryingMinor: MinorInput;
  /** Signed the same way. See the sign convention above. */
  taxBaseMinor: MinorInput;
  /** The rate expected when this difference reverses (IAS 12.47). Defaults to 9%. */
  rateBps?: number;
  /**
   * How much of a DEDUCTIBLE difference is not recognised because future
   * taxable profit is not probable (IAS 12.24, 12.34). In the same units as
   * the carrying amount — a difference, not a tax amount — because that is
   * what IAS 12.81(e) asks to be disclosed and because three figures on one
   * row measured in two different things is how a register gets misread.
   */
  unrecognisedMinor?: MinorInput;
  note?: string;
}

export interface MeasuredItem {
  code: string;
  description: string;
  category: DeferredTaxCategory;
  side: BalanceSheetSide;
  carryingMinor: string;
  taxBaseMinor: string;
  /** carrying − taxBase (IAS 12.5), signed. */
  differenceMinor: string;
  kind: DifferenceKind;
  rateBps: number;
  /** Of the difference, the part carrying no deferred tax asset (IAS 12.81(e)). */
  unrecognisedMinor: string;
  recognisedDifferenceMinor: string;
  /** Tax on the whole difference: positive a liability, negative an asset. */
  grossTaxMinor: string;
  unrecognisedTaxMinor: string;
  /** Tax actually recognised: positive a liability, negative an asset. */
  taxMinor: string;
  note: string | null;
}

export interface PositionSides {
  asOf: string | null;
  /** Gross deferred tax asset, positive. */
  assetMinor: string;
  /** Gross deferred tax liability, positive. */
  liabilityMinor: string;
  /** liability − asset. Positive is a net liability, negative a net asset. */
  netMinor: string;
}

export interface ProposedLine {
  account: string;
  debitMinor: string | null;
  creditMinor: string | null;
  memo: string;
}

export interface DeferredTaxPositionResult {
  entityId: string;
  asOf: string;
  currency: string;
  items: MeasuredItem[];
  /** The gross halves, which IAS 12.74 keeps off the balance sheet but not out of the note. */
  assetMinor: string;
  liabilityMinor: string;
  netMinor: string;
  offsetBasis: string;
  /** The previous dated position in the register, which the movement is measured from. */
  previous: PositionSides | null;
  movement: {
    /**
     * Where the movement is measured FROM. Normally the previous reporting
     * date, which by then has been posted; where the two could differ, this is
     * whichever base the ledger would actually be moved from.
     */
    fromAsOf: string | null;
    fromNetMinor: string;
    /** posted — the base is on the ledger. register — measured but not yet posted. nil — nothing before this. */
    basis: "posted" | "register" | "nil";
    /**
     * The movement in each GROSS half, register against register. These are a
     * disclosure figure and deliberately not measured from the posted base:
     * IAS 12.74 keeps the halves off the balance sheet, so there is no ledger
     * balance for them to be measured against.
     */
    assetMinor: string;
    liabilityMinor: string;
    netMinor: string;
    /** The charge to profit or loss (IAS 12.58). Positive is an expense. */
    chargeMinor: string;
    /** What `postDeferredTax` would put on the ledger, before it is asked to. */
    lines: ProposedLine[];
  };
  /** What has actually been posted at this reporting date, if anything. */
  posted: {
    asOf: string;
    entryId: string | null;
    netMinor: string;
    chargeMinor: string;
    /** True when the register has moved since that posting was made. */
    stale: boolean;
  } | null;
  unrecognised: { differenceMinor: string; taxMinor: string; count: number };
  warnings: string[];
}

/* ------------------------------------------------------------ the register */

export interface RecordItemsResult {
  asOf: string;
  recorded: number;
  replaced: number;
  items: MeasuredItem[];
  warnings: string[];
}

/**
 * Write the register for one reporting date, replacing whatever was there.
 *
 * Wholesale replacement, not a merge: a reporting date is MEASURED, once, as a
 * complete picture. Merging would let an item that has ceased to exist survive
 * because nobody thought to delete it, and a deferred tax position is exactly
 * the place where a stale row hides — it has no counterparty, nothing chases
 * it, and it simply sits there being wrong until someone reconciles the note
 * to the balance sheet.
 */
export async function recordItems(opts: {
  orgId: string;
  entityId: string;
  /** ISO date. The date the register is measured at, not the date it was typed. */
  asOf: string;
  items: DeferredTaxItemInput[];
}): Promise<RecordItemsResult> {
  const asOf = parseAsOf(opts.asOf);
  const warnings: string[] = [];

  if (!Array.isArray(opts.items)) {
    throw new LedgerError("A deferred tax register needs a list of items, even if the list is empty.");
  }

  // The unique index would refuse this too, but a constraint violation names a
  // column and a sentence names the mistake.
  const seen = new Set<string>();
  for (const raw of opts.items) {
    const code = (raw.code ?? "").trim();
    if (!code) throw new LedgerError("Every temporary difference needs a code, so the note can be traced back to it.");
    if (seen.has(code)) {
      throw new LedgerError(
        `Item ${code} appears twice at ${opts.asOf}. A reporting date holds one measurement of each difference; ` +
          `if there are genuinely two, give them separate codes.`,
      );
    }
    seen.add(code);
  }

  const rows = opts.items.map((raw) => {
    const code = raw.code.trim();
    const description = (raw.description ?? "").trim();
    if (!description) throw new LedgerError(`Item ${code} needs a description — a code alone discloses nothing.`);

    const category = raw.category ?? "OTHER";
    if (!DEFERRED_TAX_CATEGORIES.includes(category)) {
      throw new LedgerError(`"${category}" is not a kind of temporary difference. Use one of ${DEFERRED_TAX_CATEGORIES.join(", ")}.`);
    }

    const carrying = parseMinor(raw.carryingMinor, `${code} carrying amount`);
    const taxBase = parseMinor(raw.taxBaseMinor, `${code} tax base`);
    const rateBps = raw.rateBps ?? HEADLINE_RATE_BPS;
    if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
      throw new LedgerError(
        `${code} has a rate of ${rateBps} basis points. A tax rate outside nought to a hundred percent is a typo, ` +
          `and a deferred tax balance computed from one is wrong by orders of magnitude.`,
      );
    }

    const difference = carrying - taxBase;
    const abs = difference < 0n ? -difference : difference;
    const unrecognised = raw.unrecognisedMinor === undefined ? 0n : parseMinor(raw.unrecognisedMinor, `${code} unrecognised amount`);
    if (unrecognised < 0n) {
      throw new LedgerError(`${code} has a negative unrecognised amount. Enter how much of the difference is NOT recognised, as a positive figure.`);
    }
    if (unrecognised > abs) {
      throw new LedgerError(
        `${code} leaves ${plain(unrecognised)} unrecognised out of a temporary difference of ${plain(abs)}. ` +
          `Nothing can be written off that is not there.`,
      );
    }
    // IAS 12.15 recognises a deferred tax liability for every taxable
    // difference bar two narrow exemptions; there is no "probable" test on the
    // liability side, so an unrecognised amount against one can only be a
    // misunderstanding of which way the item points.
    if (difference > 0n && unrecognised > 0n) {
      throw new LedgerError(
        `${code} is a taxable temporary difference, which gives a deferred tax LIABILITY, and IAS 12.15 recognises ` +
          `that in full — the probability test in IAS 12.24 applies only to assets. If this is meant to be ` +
          `deductible, check the signs: a liability's carrying amount and tax base are both entered negative.`,
      );
    }

    // These do not stop the write. Getting the sign wrong is the classic error
    // here and the register is meant to be corrected, not defended.
    if (category === "PROVISION" && carrying > 0n) {
      warnings.push(
        `${code} is recorded as a provision but carries a positive amount, which this register reads as an asset. ` +
          `A provision is a liability: enter its carrying amount and tax base as negative figures, or the ` +
          `deductible difference will come out as a liability.`,
      );
    }
    if (category === "REVENUE" && carrying > 0n) {
      warnings.push(
        `${code} is recorded as revenue taxed in a different period but carries a positive amount. Revenue received ` +
          `in advance is a liability and is entered negative; only a contract asset is entered positive.`,
      );
    }
    if (category === "LOSS" && carrying !== 0n) {
      warnings.push(
        `${code} is a tax loss carried forward but carries ${plain(carrying)} in the accounts. A loss has no ` +
          `accounting carrying amount — enter nil against a tax base equal to the loss still available.`,
      );
    }
    if (difference !== 0n && rateBps === 0) {
      warnings.push(
        `${code} has a temporary difference of ${plain(abs)} measured at 0%, so it carries no deferred tax. That is ` +
          `right for a Qualifying Free Zone Person and wrong for almost anyone else.`,
      );
    }

    return {
      orgId: opts.orgId,
      entityId: opts.entityId,
      asOf,
      code,
      description,
      category,
      carryingMinor: carrying,
      taxBaseMinor: taxBase,
      rateBps,
      unrecognisedMinor: unrecognised,
      note: raw.note?.trim() || null,
    };
  });

  const existing = await prisma.deferredTaxItem.count({
    where: { orgId: opts.orgId, entityId: opts.entityId, asOf },
  });

  // Delete and create together: a register half replaced is a position nobody
  // can reconstruct, and this is the one write that can leave one behind.
  await prisma.$transaction([
    prisma.deferredTaxItem.deleteMany({ where: { orgId: opts.orgId, entityId: opts.entityId, asOf } }),
    ...(rows.length ? [prisma.deferredTaxItem.createMany({ data: rows })] : []),
  ]);

  const posted = await prisma.deferredTaxPosting.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, asOf },
  });
  if (posted?.entryId) {
    warnings.push(
      `The position at ${opts.asOf} had already been posted to the ledger. Re-measuring it does not change what is ` +
        `on 1320, 2320 and 7010 — reverse that entry and post again, or the register and the balance sheet will ` +
        `disagree from here on.`,
    );
  }

  return {
    asOf: opts.asOf,
    recorded: rows.length,
    replaced: existing,
    items: rows.map(measureItem),
    warnings,
  };
}

export interface ReportingDate {
  asOf: string;
  items: number;
  netMinor: string;
  posted: boolean;
  entryId: string | null;
}

/**
 * Every reporting date the register holds, newest first, with what was posted
 * at each. The dates are the register's structure rather than a detail of it —
 * a movement is only meaningful against the date before it — so they are read
 * as a list rather than guessed at by whoever is picking one.
 */
export async function reportingDates(opts: { orgId: string; entityId: string }): Promise<ReportingDate[]> {
  const rows = await prisma.deferredTaxItem.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    distinct: ["asOf"],
    select: { asOf: true },
    orderBy: { asOf: "desc" },
  });
  const postings = await prisma.deferredTaxPosting.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
  });
  const byDate = new Map(postings.map((p) => [iso(p.asOf), p]));

  const out: ReportingDate[] = [];
  for (const r of rows) {
    const measured = await measureAt(opts.orgId, opts.entityId, r.asOf);
    const posted = byDate.get(iso(r.asOf));
    out.push({
      asOf: iso(r.asOf),
      items: measured.items.length,
      netMinor: measured.netMinor.toString(),
      posted: Boolean(posted?.entryId),
      entryId: posted?.entryId ?? null,
    });
  }
  return out;
}

/* ---------------------------------------------- derived from the register */

export interface DerivedAssetLine {
  code: string;
  name: string;
  acquiredOn: string;
  monthsHeld: number;
  costMinor: string;
  /** Per the fixed asset register — accounting carrying amount. */
  carryingMinor: string;
  taxDepreciationMinor: string;
  /** Cost less tax depreciation, floored at nil. */
  taxBaseMinor: string;
  differenceMinor: string;
  depreciatedTo: string | null;
}

export interface DerivedFixedAssetDifference {
  asOf: string;
  /** Ready to hand to `recordItems`; nothing has been written. */
  item: DeferredTaxItemInput;
  taxRateBps: number;
  taxDepreciationRateBps: number;
  assets: DerivedAssetLine[];
  totals: { carryingMinor: string; taxBaseMinor: string; differenceMinor: string; taxMinor: string };
  warnings: string[];
}

/**
 * Build the fixed asset temporary difference from the asset register.
 *
 * In most entities this is the largest difference there is, and it is also the
 * one most likely to be keyed in wrong, because it is a sum over every asset
 * of two numbers that are individually uninteresting. So it is derived.
 *
 * WHAT THIS DOES NOT KNOW. UAE tax depreciation rules are not implemented.
 * Federal Decree-Law 47/2022 begins at accounting income (Article 20) and has
 * no separate statutory capital allowance code of the sort the UK or India
 * has, so for many entities accounting and tax depreciation are the SAME and
 * this difference is nil. It stops being nil where a realisation basis has
 * been elected (Article 20(3)), where Ministerial Decision 120/2023's
 * transitional rules restate opening balances, or where a specific decision
 * limits a deduction. None of that is modelled. `taxDepreciationRateBps` is
 * therefore an input someone must justify — a straight-line rate on cost that
 * this software applies faithfully and does not endorse.
 *
 * Nothing is written. `recordItems` replaces a reporting date wholesale, so a
 * derivation that saved itself would silently drop every other difference
 * measured at that date; the caller records the item alongside the rest.
 */
export async function deriveFromAssets(opts: {
  orgId: string;
  entityId: string;
  asOf: string;
  /** The rate the resulting difference is measured at (IAS 12.47). */
  taxRateBps?: number;
  /** Straight-line tax depreciation on cost, per year, in basis points. */
  taxDepreciationRateBps: number;
  code?: string;
}): Promise<DerivedFixedAssetDifference> {
  const asOf = parseAsOf(opts.asOf);
  const taxRateBps = opts.taxRateBps ?? HEADLINE_RATE_BPS;
  const rate = opts.taxDepreciationRateBps;
  if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) {
    throw new LedgerError(
      `A tax depreciation rate of ${rate} basis points is not a rate between 0% and 100% a year. It is an ` +
        `assumption about UAE tax law that this software does not hold, so it has to be given as a whole number ` +
        `of basis points — 2000 for 20% a year.`,
    );
  }
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10_000) {
    throw new LedgerError(`A tax rate of ${taxRateBps} basis points is not a rate between 0% and 100%.`);
  }

  const assets = await prisma.fixedAsset.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: "active", acquiredOn: { lte: asOf } },
    orderBy: { code: "asc" },
  });

  const warnings: string[] = [];
  const asOfIndex = monthIndex(asOf);
  const lines: DerivedAssetLine[] = [];
  let carryingTotal = 0n;
  let taxBaseTotal = 0n;

  for (const a of assets) {
    const carrying = a.costMinor - a.accumulatedMinor;
    const months = asOfIndex - monthIndex(a.acquiredOn) + 1;
    // The month of acquisition is charged, matching runDepreciation, so the
    // two schedules count the same months and any difference between them is a
    // difference of RATE rather than an off-by-one nobody can explain.
    const taxDep = (a.costMinor * BigInt(rate) * BigInt(months)) / (10_000n * 12n);
    const written = taxDep > a.costMinor ? a.costMinor : taxDep;
    const taxBase = a.costMinor - written;

    carryingTotal += carrying;
    taxBaseTotal += taxBase;
    lines.push({
      code: a.code,
      name: a.name,
      acquiredOn: iso(a.acquiredOn),
      monthsHeld: months,
      costMinor: a.costMinor.toString(),
      carryingMinor: carrying.toString(),
      taxDepreciationMinor: written.toString(),
      taxBaseMinor: taxBase.toString(),
      differenceMinor: (carrying - taxBase).toString(),
      depreciatedTo: a.depreciatedTo,
    });

    // The register carries ONE running accumulated figure, so its carrying
    // amount is today's, not the one that stood at an earlier reporting date.
    // Deriving a past position from it would quietly understate the asset.
    if (a.depreciatedTo && monthIndex(a.depreciatedTo) > asOfIndex) {
      warnings.push(
        `${a.code} has been depreciated to ${a.depreciatedTo}, past this reporting date. The asset register keeps ` +
          `one running accumulated figure, so the carrying amount used here is the current one, not the one that ` +
          `stood at ${opts.asOf}. Measure this date before running depreciation past it.`,
      );
    }
  }

  const difference = carryingTotal - taxBaseTotal;
  if (assets.length === 0) {
    warnings.push(`There are no active fixed assets acquired on or before ${opts.asOf}, so there is no difference to derive.`);
  }
  if (difference !== 0n) {
    warnings.push(
      `This difference exists only because tax depreciation has been assumed at ${(rate / 100).toFixed(2)}% a year on ` +
        `cost. Federal Decree-Law 47/2022 starts from accounting profit and does not impose a separate capital ` +
        `allowance regime, so for many UAE entities the two depreciations are the same and this difference is nil. ` +
        `The rate is your assumption, not a fact this software knows.`,
    );
  }

  return {
    asOf: opts.asOf,
    item: {
      code: opts.code ?? "PPE",
      description: `Property, plant and equipment — ${assets.length} asset${assets.length === 1 ? "" : "s"} at ${opts.asOf}`,
      category: "FIXED_ASSET",
      carryingMinor: carryingTotal.toString(),
      taxBaseMinor: taxBaseTotal.toString(),
      rateBps: taxRateBps,
      note: `Tax base assumes straight-line tax depreciation of ${(rate / 100).toFixed(2)}% a year on cost from the ` +
        `month of acquisition. UAE tax depreciation rules are not implemented; this rate is an input.`,
    },
    taxRateBps,
    taxDepreciationRateBps: rate,
    assets: lines,
    totals: {
      carryingMinor: carryingTotal.toString(),
      taxBaseMinor: taxBaseTotal.toString(),
      differenceMinor: difference.toString(),
      taxMinor: taxOn(difference, taxRateBps).toString(),
    },
    warnings,
  };
}

/* ------------------------------------------------------------- the position */

/**
 * The deferred tax position at a reporting date: both gross halves, the net,
 * every item behind them, and the movement since the previous dated position.
 */
export async function position(opts: {
  orgId: string;
  entityId: string;
  asOf: string;
}): Promise<DeferredTaxPositionResult> {
  const asOf = parseAsOf(opts.asOf);
  const warnings: string[] = [];

  const here = await measureAt(opts.orgId, opts.entityId, asOf);
  const previousDate = await previousRegisterDate(opts.orgId, opts.entityId, asOf);
  const previous = previousDate ? await measureAt(opts.orgId, opts.entityId, previousDate) : null;

  const postedRow = await prisma.deferredTaxPosting.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, asOf },
  });
  const previousPosting = await prisma.deferredTaxPosting.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, asOf: { lt: asOf } },
    orderBy: { asOf: "desc" },
  });

  // The movement shown is the movement that would be POSTED, so it is measured
  // from the same base `postDeferredTax` uses: what the ledger actually
  // carries. Where nothing has been posted yet, the previous dated position is
  // used instead — it is what the movement will be once that one goes on, and
  // the warning below says it cannot be posted until it does. A screen headed
  // "the movement being posted" that showed a different figure from the one
  // posted would be worse than no screen.
  const basis: "posted" | "register" | "nil" = previousPosting ? "posted" : previous ? "register" : "nil";
  const fromNet = previousPosting ? previousPosting.netMinor : previous ? previous.netMinor : 0n;
  const fromAsOf = previousPosting ? iso(previousPosting.asOf) : previousDate ? iso(previousDate) : null;
  const lines = movementLines(fromNet, here.netMinor, opts.asOf);

  const currency = await functionalCurrency(opts.orgId, opts.entityId);

  if (here.items.length === 0 && !previous) {
    warnings.push(
      `Nothing has been recorded at ${opts.asOf}, and there is no earlier reporting date to compare it with, so the ` +
        `position is nil. That is a measurement only if someone measured it.`,
    );
  }
  if (here.items.length === 0 && previous) {
    warnings.push(
      `No temporary differences are recorded at ${opts.asOf}, so the whole position at ${iso(previousDate!)} would ` +
        `be released to profit. If differences still exist, record them before posting.`,
    );
  }
  if (previousDate && !(previousPosting && iso(previousPosting.asOf) === iso(previousDate))) {
    warnings.push(
      `The position at ${iso(previousDate)} has never been posted, so the ledger does not carry it. The movement ` +
        `shown here cannot be posted until that one is — deferred tax positions go on in date order or the ` +
        `balances on 1320 and 2320 stop meaning anything.`,
    );
  }
  if (previous && previousPosting && previousPosting.netMinor !== previous.netMinor) {
    warnings.push(
      `${plain(previousPosting.netMinor)} was posted at ${iso(previousPosting.asOf)} but the register now measures ` +
        `${plain(previous.netMinor)} there. The movement below is measured from the posted figure, because that is ` +
        `what 1320 and 2320 actually carry — so posting it brings the ledger to the right position and leaves the ` +
        `earlier period's own charge overstated or understated by the difference.`,
    );
  }

  const recognised = here.assetMinor + here.liabilityMinor;
  const offRate = here.items.filter((i) => i.rateBps !== HEADLINE_RATE_BPS);
  if (offRate.length) {
    warnings.push(
      `${offRate.length} item${offRate.length === 1 ? " is" : "s are"} measured at a rate other than the ` +
        `${(HEADLINE_RATE_BPS / 100).toFixed(0)}% headline rate (${offRate.map((i) => i.code).join(", ")}). IAS 12.47 ` +
        `asks for the rate expected when the difference reverses, so that is a decision, not an error — but it ` +
        `should be one someone made deliberately.`,
    );
  }
  if (recognised > 0n) {
    warnings.push(
      `Measured at a flat rate. Article 3 of Federal Decree-Law 47/2022 charges nil on the first ` +
        `${plain(ZERO_BAND_MINOR)} of taxable income, so an entity whose profits sit near that band will reverse ` +
        `these differences at less than the headline rate, and both the asset and the liability here are an upper ` +
        `bound. Small Business Relief under Ministerial Decision 73/2023 would reduce them further still.`,
    );
  }
  const unrecognisedDifference = here.items.reduce((a, i) => a + BigInt(i.unrecognisedMinor), 0n);
  const unrecognisedTax = here.items.reduce((a, i) => a + BigInt(i.unrecognisedTaxMinor), 0n);
  if (unrecognisedDifference > 0n) {
    warnings.push(
      `${plain(unrecognisedDifference)} of deductible differences carry no deferred tax asset, keeping ` +
        `${plain(unrecognisedTax)} of tax off the balance sheet under IAS 12.24. IAS 12.56 requires that judgement ` +
        `to be reassessed at every reporting date, upwards as well as downwards.`,
    );
  }
  if (here.netMinor < 0n) {
    warnings.push(
      `The net position is a deferred tax ASSET of ${plain(-here.netMinor)}. It is recoverable only against future ` +
        `taxable profit, and nothing in this ledger forecasts that — IAS 12.24 makes it a judgement, not a ` +
        `calculation.`,
    );
  }

  return {
    entityId: opts.entityId,
    asOf: opts.asOf,
    currency,
    items: here.items,
    assetMinor: here.assetMinor.toString(),
    liabilityMinor: here.liabilityMinor.toString(),
    netMinor: here.netMinor.toString(),
    offsetBasis: OFFSET_BASIS,
    previous: previous
      ? {
          asOf: iso(previousDate!),
          assetMinor: previous.assetMinor.toString(),
          liabilityMinor: previous.liabilityMinor.toString(),
          netMinor: previous.netMinor.toString(),
        }
      : null,
    movement: {
      fromAsOf,
      fromNetMinor: fromNet.toString(),
      basis,
      assetMinor: (here.assetMinor - (previous?.assetMinor ?? 0n)).toString(),
      liabilityMinor: (here.liabilityMinor - (previous?.liabilityMinor ?? 0n)).toString(),
      netMinor: (here.netMinor - fromNet).toString(),
      chargeMinor: (here.netMinor - fromNet).toString(),
      lines,
    },
    posted: postedRow
      ? {
          asOf: iso(postedRow.asOf),
          entryId: postedRow.entryId,
          netMinor: postedRow.netMinor.toString(),
          chargeMinor: postedRow.chargeMinor.toString(),
          stale: postedRow.netMinor !== here.netMinor
            || postedRow.assetMinor !== here.assetMinor
            || postedRow.liabilityMinor !== here.liabilityMinor,
        }
      : null,
    unrecognised: {
      differenceMinor: unrecognisedDifference.toString(),
      taxMinor: unrecognisedTax.toString(),
      count: here.items.filter((i) => BigInt(i.unrecognisedMinor) > 0n).length,
    },
    warnings,
  };
}

/* --------------------------------------------------------------- posting */

export interface PostDeferredTaxResult {
  asOf: string;
  entryId: string | null;
  reference: string | null;
  periodLabel: string | null;
  assetMinor: string;
  liabilityMinor: string;
  netMinor: string;
  basisAsOf: string | null;
  basisNetMinor: string;
  /** Positive is a charge to profit or loss, negative a credit (IAS 12.58). */
  chargeMinor: string;
  lines: ProposedLine[];
  /** True when this call changed nothing because the position was already on. */
  alreadyPosted: boolean;
  warnings: string[];
}

/**
 * Move the ledger from the position it carries to the position at this date.
 *
 * The entry is the MOVEMENT, never the balance: IAS 12.58 charges the change in
 * the deferred tax position to profit or loss, and posting the balance would
 * charge the whole position again every period.
 *
 * The ledger carries the NET, on the account matching its side, because
 * IAS 12.74 requires the offset for a single UAE taxable person — see
 * OFFSET_BASIS. The gross halves are a disclosure and live in the register.
 *
 * Idempotent on a key that names the POSITION being moved to, not the run that
 * moved it: `deferredtax:<entity>:<date>:a<asset>l<liability>`. A key naming
 * the run would let the same position be posted twice by two runs, which is
 * the failure that matters here — the second entry doubles the balance sheet
 * figure and nothing chases a deferred tax balance. Re-running when nothing
 * has changed finds the position already recorded and posts nothing.
 *
 * A closed or locked period is refused by `post()`, in its own words. That
 * check is not repeated here: two guards on one rule drift apart, and the one
 * that matters is the one the database enforces.
 */
export async function postDeferredTax(opts: {
  orgId: string;
  entityId: string;
  asOf: string;
  actorId?: string;
}): Promise<PostDeferredTaxResult> {
  const asOf = parseAsOf(opts.asOf);
  const warnings: string[] = [];

  const later = await prisma.deferredTaxPosting.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, asOf: { gt: asOf } },
    orderBy: { asOf: "asc" },
  });
  if (later) {
    throw new LedgerError(
      `The position at ${iso(later.asOf)} has already been posted, and deferred tax goes on in date order — each ` +
        `movement is measured from the one before it. Reverse that entry before posting ${opts.asOf}.`,
    );
  }

  const here = await measureAt(opts.orgId, opts.entityId, asOf);
  const previousDate = await previousRegisterDate(opts.orgId, opts.entityId, asOf);
  const basisPosting = await prisma.deferredTaxPosting.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, asOf: { lt: asOf } },
    orderBy: { asOf: "desc" },
  });

  if (previousDate && !basisPosting) {
    throw new LedgerError(
      `The position at ${iso(previousDate)} has not been posted, so the ledger has nothing for this movement to be ` +
        `measured from. Post ${iso(previousDate)} first; posting ${opts.asOf} against a base the books never ` +
        `received would put the whole of both periods through profit at once.`,
    );
  }

  // The base is what the LEDGER carries, which is the posted figure — not what
  // the register would now say about that date. If someone has re-measured a
  // posted date, the movement still has to start from the balance actually
  // sitting on 1320 and 2320, or the ledger never catches up.
  const basisNet = basisPosting?.netMinor ?? 0n;
  if (basisPosting && previousDate) {
    const basisRegister = await measureAt(opts.orgId, opts.entityId, basisPosting.asOf);
    if (basisRegister.netMinor !== basisPosting.netMinor) {
      warnings.push(
        `The register at ${iso(basisPosting.asOf)} now measures ${plain(basisRegister.netMinor)} but ` +
          `${plain(basisPosting.netMinor)} was posted there. This movement is measured from the posted figure, so ` +
          `the ledger reaches the right position — but that earlier date's own entry is still wrong.`,
      );
    }
  }

  const existing = await prisma.deferredTaxPosting.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, asOf },

  });
  const lines = movementLines(basisNet, here.netMinor, opts.asOf);

  if (existing) {
    const unchanged =
      existing.netMinor === here.netMinor &&
      existing.assetMinor === here.assetMinor &&
      existing.liabilityMinor === here.liabilityMinor;
    // An existing row with no entry behind it never reached the ledger, so
    // there is nothing to double-post and refusing would leave a real movement
    // permanently unpostable. A row WITH an entry is a posted entry, and a
    // posted entry is never edited — it is reversed.
    if (existing.entryId || unchanged) {
      if (existing.entryId && !unchanged) {
        warnings.push(
          `${plain(existing.netMinor)} was already posted at ${opts.asOf} and the register now measures ` +
            `${plain(here.netMinor)}. Nothing has been posted. Reverse that entry and post again — a posted entry ` +
            `is never edited.`,
        );
      }
      const entry = existing.entryId
        ? await prisma.journalEntry.findFirst({
            where: { id: existing.entryId, orgId: opts.orgId, entityId: opts.entityId },
            include: { period: { select: { label: true } } },
          })
        : null;
      return {
        asOf: opts.asOf,
        entryId: existing.entryId,
        reference: entry ? `${entry.series}-${entry.number}` : null,
        periodLabel: entry?.period.label ?? null,
        assetMinor: existing.assetMinor.toString(),
        liabilityMinor: existing.liabilityMinor.toString(),
        netMinor: existing.netMinor.toString(),
        basisAsOf: basisPosting ? iso(basisPosting.asOf) : null,
        basisNetMinor: basisNet.toString(),
        chargeMinor: existing.chargeMinor.toString(),
        lines: [],
        alreadyPosted: true,
        warnings,
      };
    }
  }

  const charge = here.netMinor - basisNet;

  let entryId: string | null = null;
  let reference: string | null = null;
  let periodLabel: string | null = null;

  if (lines.length) {
    const entry = await post({
      orgId: opts.orgId,
      entityId: opts.entityId,
      // A deferred tax position can be struck at any reporting date — a quarter
      // as readily as a year end — so the entry goes in on its own date and the
      // period is found from it. That is also what makes a closed period refuse
      // it, in post()'s words rather than a paraphrase of them.
      entryDate: asOf,
      memo: `Deferred tax position at ${opts.asOf}`,
      source: "tax",
      sourceType: "DEFERRED_TAX",
      sourceId: opts.asOf,
      externalKey: `deferredtax:${opts.entityId}:${opts.asOf}:a${here.assetMinor}l${here.liabilityMinor}`,
      actorType: "HUMAN",
      actorId: opts.actorId,
      series: "DT",
      lines: lines.map((l) => ({
        account: l.account,
        ...(l.debitMinor !== null ? { debit: l.debitMinor } : { credit: l.creditMinor! }),
        memo: l.memo,
      })),
    });
    entryId = entry.id;
    reference = `${entry.series}-${entry.number}`;
    const period = await prisma.accountingPeriod.findFirst({
      where: { id: entry.periodId, orgId: opts.orgId, entityId: opts.entityId },
      select: { label: true },
    });
    periodLabel = period?.label ?? null;
  } else {
    warnings.push(
      `The position at ${opts.asOf} is the same as the one already on the ledger, so nothing has been posted. The ` +
        `date has still been recorded, so the next period is measured from here.`,
    );
  }

  // The register row goes in only after the journal has committed. The other
  // order would leave a date marked as posted with nothing behind it, and the
  // next period would then measure its movement from a position the books
  // never received.
  const row = await prisma.deferredTaxPosting.upsert({
    where: { orgId_entityId_asOf: { orgId: opts.orgId, entityId: opts.entityId, asOf } },
    create: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      asOf,
      netMinor: here.netMinor,
      assetMinor: here.assetMinor,
      liabilityMinor: here.liabilityMinor,
      chargeMinor: charge,
      entryId,
    },
    update: {
      netMinor: here.netMinor,
      assetMinor: here.assetMinor,
      liabilityMinor: here.liabilityMinor,
      chargeMinor: charge,
      entryId,
    },
  });

  return {
    asOf: opts.asOf,
    entryId: row.entryId,
    reference,
    periodLabel,
    assetMinor: row.assetMinor.toString(),
    liabilityMinor: row.liabilityMinor.toString(),
    netMinor: row.netMinor.toString(),
    basisAsOf: basisPosting ? iso(basisPosting.asOf) : null,
    basisNetMinor: basisNet.toString(),
    chargeMinor: row.chargeMinor.toString(),
    lines,
    alreadyPosted: false,
    warnings,
  };
}

/* ------------------------------------------------------------- the note */

export interface DeferredTaxNoteRow {
  category: DeferredTaxCategory;
  label: string;
  openingAssetMinor: string;
  openingLiabilityMinor: string;
  openingNetMinor: string;
  closingAssetMinor: string;
  closingLiabilityMinor: string;
  closingNetMinor: string;
  /** Closing net less opening net: positive is a charge to profit or loss. */
  movementMinor: string;
  unrecognisedDifferenceMinor: string;
  unrecognisedTaxMinor: string;
  items: { code: string; description: string; differenceMinor: string; taxMinor: string }[];
}

export interface DeferredTaxNoteResult {
  entityId: string;
  asOf: string;
  previousAsOf: string | null;
  currency: string;
  rows: DeferredTaxNoteRow[];
  totals: {
    openingNetMinor: string;
    closingAssetMinor: string;
    closingLiabilityMinor: string;
    closingNetMinor: string;
    movementMinor: string;
    unrecognisedDifferenceMinor: string;
    unrecognisedTaxMinor: string;
  };
  offsetBasis: string;
  narrative: string[];
}

/**
 * The IAS 12.81(g) disclosure: for each TYPE of temporary difference, the
 * deferred tax recognised at each date presented and the movement between
 * them, with IAS 12.81(e)'s unrecognised amounts beside it.
 *
 * By type, not by item, because that is what the standard asks for and because
 * a note listing every fixed asset is a note nobody reads. The items are
 * carried on each row so a reader can still get from the disclosure to the
 * measurement without leaving the page.
 */
export async function deferredTaxNote(opts: {
  orgId: string;
  entityId: string;
  asOf: string;
}): Promise<DeferredTaxNoteResult> {
  const asOf = parseAsOf(opts.asOf);
  const here = await measureAt(opts.orgId, opts.entityId, asOf);
  const previousDate = await previousRegisterDate(opts.orgId, opts.entityId, asOf);
  const previous = previousDate ? await measureAt(opts.orgId, opts.entityId, previousDate) : null;
  const currency = await functionalCurrency(opts.orgId, opts.entityId);

  const categories = DEFERRED_TAX_CATEGORIES.filter(
    (c) => here.items.some((i) => i.category === c) || (previous?.items ?? []).some((i) => i.category === c),
  );

  const rows: DeferredTaxNoteRow[] = categories.map((category) => {
    const closing = here.items.filter((i) => i.category === category);
    const opening = (previous?.items ?? []).filter((i) => i.category === category);
    const closingAsset = sumSide(closing, "asset");
    const closingLiability = sumSide(closing, "liability");
    const openingAsset = sumSide(opening, "asset");
    const openingLiability = sumSide(opening, "liability");
    const closingNet = closingLiability - closingAsset;
    const openingNet = openingLiability - openingAsset;
    return {
      category,
      label: CATEGORY_LABEL[category],
      openingAssetMinor: openingAsset.toString(),
      openingLiabilityMinor: openingLiability.toString(),
      openingNetMinor: openingNet.toString(),
      closingAssetMinor: closingAsset.toString(),
      closingLiabilityMinor: closingLiability.toString(),
      closingNetMinor: closingNet.toString(),
      movementMinor: (closingNet - openingNet).toString(),
      unrecognisedDifferenceMinor: closing.reduce((a, i) => a + BigInt(i.unrecognisedMinor), 0n).toString(),
      unrecognisedTaxMinor: closing.reduce((a, i) => a + BigInt(i.unrecognisedTaxMinor), 0n).toString(),
      items: closing.map((i) => ({
        code: i.code,
        description: i.description,
        differenceMinor: i.differenceMinor,
        taxMinor: i.taxMinor,
      })),
    };
  });

  const openingNet = previous ? previous.netMinor : 0n;
  const unrecognisedDifference = here.items.reduce((a, i) => a + BigInt(i.unrecognisedMinor), 0n);
  const unrecognisedTax = here.items.reduce((a, i) => a + BigInt(i.unrecognisedTaxMinor), 0n);

  const narrative: string[] = [
    `Deferred tax is provided on temporary differences between the carrying amounts of assets and liabilities and ` +
      `their tax bases (IAS 12.5), measured at the rates expected to apply when each difference reverses ` +
      `(IAS 12.47) and not discounted (IAS 12.53).`,
    here.netMinor === 0n
      ? `There is no net deferred tax balance at ${opts.asOf}.`
      : here.netMinor > 0n
        ? `The net deferred tax liability at ${opts.asOf} is ${plain(here.netMinor)}, being a gross liability of ` +
          `${plain(here.liabilityMinor)} less a gross asset of ${plain(here.assetMinor)}.`
        : `The net deferred tax asset at ${opts.asOf} is ${plain(-here.netMinor)}, being a gross asset of ` +
          `${plain(here.assetMinor)} less a gross liability of ${plain(here.liabilityMinor)}.`,
    here.netMinor - openingNet === 0n
      ? `Nothing has been charged to profit or loss for the period.`
      : here.netMinor - openingNet > 0n
        ? `${plain(here.netMinor - openingNet)} has been charged to profit or loss for the period (IAS 12.58).`
        : `${plain(openingNet - here.netMinor)} has been credited to profit or loss for the period (IAS 12.58).`,
    unrecognisedDifference > 0n
      ? `No deferred tax asset is recognised on ${plain(unrecognisedDifference)} of deductible temporary ` +
        `differences and unused tax losses, worth ${plain(unrecognisedTax)} of tax, because it is not probable ` +
        `that sufficient future taxable profit will be available (IAS 12.24, 12.34, 12.81(e)).`
      : `A deferred tax asset is recognised on every deductible temporary difference, as future taxable profit ` +
        `is judged probable (IAS 12.24).`,
    OFFSET_BASIS,
  ];

  return {
    entityId: opts.entityId,
    asOf: opts.asOf,
    previousAsOf: previousDate ? iso(previousDate) : null,
    currency,
    rows,
    totals: {
      openingNetMinor: openingNet.toString(),
      closingAssetMinor: here.assetMinor.toString(),
      closingLiabilityMinor: here.liabilityMinor.toString(),
      closingNetMinor: here.netMinor.toString(),
      movementMinor: (here.netMinor - openingNet).toString(),
      unrecognisedDifferenceMinor: unrecognisedDifference.toString(),
      unrecognisedTaxMinor: unrecognisedTax.toString(),
    },
    offsetBasis: OFFSET_BASIS,
    narrative,
  };
}

/* ------------------------------------------------------------------ helpers */

interface RegisterRow {
  code: string;
  description: string;
  category: string;
  carryingMinor: bigint;
  taxBaseMinor: bigint;
  rateBps: number;
  unrecognisedMinor: bigint;
  note: string | null;
}

/** The one place the sign convention above is turned into figures. */
function measureItem(r: RegisterRow): MeasuredItem {
  const difference = r.carryingMinor - r.taxBaseMinor;
  const abs = difference < 0n ? -difference : difference;
  // recordItems refuses an unrecognised amount larger than the difference, so
  // this clamp only ever catches a row written before that rule existed or by
  // something else. It clamps rather than throws because a read should not be
  // the thing that fails on a bad row.
  const unrecognised = r.unrecognisedMinor > abs ? abs : r.unrecognisedMinor;
  const recognisedAbs = abs - unrecognised;
  const recognised = difference < 0n ? -recognisedAbs : recognisedAbs;
  const grossTax = taxOn(difference, r.rateBps);
  const tax = taxOn(recognised, r.rateBps);
  const grossAbs = grossTax < 0n ? -grossTax : grossTax;
  const taxAbs = tax < 0n ? -tax : tax;

  return {
    code: r.code,
    description: r.description,
    category: r.category as DeferredTaxCategory,
    side: r.carryingMinor > 0n ? "asset" : r.carryingMinor < 0n ? "liability" : "none",
    carryingMinor: r.carryingMinor.toString(),
    taxBaseMinor: r.taxBaseMinor.toString(),
    differenceMinor: difference.toString(),
    kind: difference > 0n ? "taxable" : difference < 0n ? "deductible" : "none",
    rateBps: r.rateBps,
    unrecognisedMinor: unrecognised.toString(),
    recognisedDifferenceMinor: recognised.toString(),
    grossTaxMinor: grossTax.toString(),
    unrecognisedTaxMinor: (grossAbs - taxAbs).toString(),
    taxMinor: tax.toString(),
    note: r.note,
  };
}

async function measureAt(orgId: string, entityId: string, asOf: Date) {
  const rows = await prisma.deferredTaxItem.findMany({
    // Both scopes, every time. An entity id alone is a foreign key someone
    // could have guessed; an org id alone lets one entity read another's.
    where: { orgId, entityId, asOf },
    orderBy: [{ category: "asc" }, { code: "asc" }],
  });
  const items = rows.map(measureItem);
  const assetMinor = sumSide(items, "asset");
  const liabilityMinor = sumSide(items, "liability");
  return { items, assetMinor, liabilityMinor, netMinor: liabilityMinor - assetMinor };
}

/** Gross halves, before the IAS 12.74 offset. */
function sumSide(items: MeasuredItem[], side: "asset" | "liability"): bigint {
  return items.reduce((a, i) => {
    const t = BigInt(i.taxMinor);
    if (side === "asset") return t < 0n ? a - t : a;
    return t > 0n ? a + t : a;
  }, 0n);
}

/** The most recent reporting date in the register strictly before this one. */
async function previousRegisterDate(orgId: string, entityId: string, asOf: Date): Promise<Date | null> {
  const rows = await prisma.deferredTaxItem.findMany({
    where: { orgId, entityId, asOf: { lt: asOf } },
    distinct: ["asOf"],
    select: { asOf: true },
    orderBy: { asOf: "desc" },
    take: 1,
  });
  return rows[0]?.asOf ?? null;
}

/** The two sides the ledger would carry for a net position, after offset. */
function netSides(net: bigint) {
  return { asset: net < 0n ? -net : 0n, liability: net > 0n ? net : 0n };
}

/**
 * The journal that moves the ledger from one net position to another.
 *
 * It balances by construction: the charge is the change in the net, which is
 * exactly the change in the liability less the change in the asset, so the
 * three deltas always sum to nothing. Where the position crosses from a net
 * asset to a net liability both balance sheet accounts move at once, which is
 * why this is written as three independent deltas rather than a pair.
 */
function movementLines(fromNet: bigint, toNet: bigint, asOf: string): ProposedLine[] {
  const from = netSides(fromNet);
  const to = netSides(toNet);
  const dAsset = to.asset - from.asset;
  const dLiability = to.liability - from.liability;
  const charge = toNet - fromNet;
  const lines: ProposedLine[] = [];

  if (dAsset !== 0n) {
    lines.push({
      account: ACC_DEFERRED_TAX_ASSET,
      debitMinor: dAsset > 0n ? dAsset.toString() : null,
      creditMinor: dAsset < 0n ? (-dAsset).toString() : null,
      memo: `Deferred tax asset at ${asOf}`,
    });
  }
  if (dLiability !== 0n) {
    lines.push({
      account: ACC_DEFERRED_TAX_LIABILITY,
      debitMinor: dLiability < 0n ? (-dLiability).toString() : null,
      creditMinor: dLiability > 0n ? dLiability.toString() : null,
      memo: `Deferred tax liability at ${asOf}`,
    });
  }
  if (charge !== 0n) {
    lines.push({
      account: ACC_DEFERRED_TAX_EXPENSE,
      debitMinor: charge > 0n ? charge.toString() : null,
      creditMinor: charge < 0n ? (-charge).toString() : null,
      memo: `Deferred tax ${charge > 0n ? "charge" : "credit"} for the period to ${asOf}`,
    });
  }
  return lines;
}

/**
 * Tax on a difference, half-up on the fil, entirely in BigInt. The sign of the
 * difference is carried through: positive is a liability, negative an asset.
 */
function taxOn(differenceMinor: bigint, rateBps: number): bigint {
  const neg = differenceMinor < 0n;
  const abs = neg ? -differenceMinor : differenceMinor;
  const tax = (abs * BigInt(rateBps) + 5_000n) / 10_000n;
  return neg ? -tax : tax;
}

async function functionalCurrency(orgId: string, entityId: string): Promise<string> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  return book?.functionalCurrency ?? "AED";
}

function parseAsOf(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) {
    throw new LedgerError(`A reporting date looks like 2026-12-31; "${value}" does not.`);
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${value} is not a real date.`);
  return d;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** "2026-03-31" or a Date → an ordinal month, so months can be counted. */
function monthIndex(d: Date | string): number {
  const [y, m] = (typeof d === "string" ? d : iso(d)).split("-").map(Number);
  return y * 12 + (m - 1);
}

function parseMinor(v: MinorInput, field: string): bigint {
  if (typeof v === "number" && !Number.isInteger(v)) {
    throw new LedgerError(`${field} must be a whole number of minor units (fils), got ${v}.`);
  }
  if (typeof v === "string" && !/^-?\d+$/.test(v.trim())) {
    throw new LedgerError(`${field} must be a whole number of minor units (fils), got "${v}".`);
  }
  return BigInt(typeof v === "string" ? v.trim() : v);
}

/**
 * Minor units as a decimal, for messages a human reads. Grouped, unlike the
 * sibling module's: these sentences quote the AED 375,000 band beside a
 * measured balance, and an ungrouped 37500000 next to a grouped threshold is
 * how a reader miscounts a digit.
 */
function plain(minor: bigint): string {
  const neg = minor < 0n;
  const abs = (neg ? -minor : minor).toString().padStart(3, "0");
  const whole = abs.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}AED ${whole}.${abs.slice(-2)}`;
}
