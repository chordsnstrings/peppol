import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { getProfile } from "@/lib/domain/tax";
import { LedgerError, post } from "./post";

/**
 * The three UAE VAT treatments a return cannot express on its own: the capital
 * assets scheme, the profit margin scheme, and designated zones.
 *
 * `vat.ts` computes the VAT 201 from the journal lines, grouped by the tax
 * treatment each line was raised under. Nothing here re-derives any of that.
 * What this module does is put the missing postings ON the ledger, tagged so
 * that the return picks them up by its own existing rules — a capital asset
 * adjustment reaches the return because it is a line on 1350 carrying the
 * INPUT_VAT treatment, not because the return was taught about capital assets.
 * That is the whole composition: one module owns the return, another owns the
 * obligation, and they meet at a journal line.
 *
 * The capital asset register is kept the way `assets.ts` keeps the fixed asset
 * register and `deferred-tax.ts` keeps its register of differences: a dated
 * record of assessments, each posting its own adjustment, never recomputed
 * backwards, and reconciled against what actually reached the ledger. A
 * register nobody compares to the books is a spreadsheet with extra steps.
 *
 * Two things in here the software cannot know, and does not pretend to:
 *
 *  - **Whether an item of expenditure is a capital asset at all.** Executive
 *    Regulation Article 57 needs a single item of expenditure, of AED 5,000,000
 *    or more excluding tax, with an estimated useful life of at least ten years
 *    for a building or five for anything else. The ledger can see the cost. It
 *    cannot see whether three invoices are one asset, nor how long anybody
 *    expects it to last. Both are taken as inputs and shown as such.
 *  - **The proportion of taxable use in an interval.** That is a measurement of
 *    how the asset was actually used over a year — floor area let exempt, hours
 *    run on exempt work — and no accounting record in this product contains it.
 *    Every adjustment therefore takes `useBps` from a human, and the register
 *    shows an interval as OUTSTANDING rather than guessing.
 *
 * This computes and posts the adjustments. It does not file anything: the
 * return is filed at the FTA, by a person, on figures they have looked at.
 */

/* ────────────────────────────────────────────────────────── the law, as constants */

/**
 * Executive Regulation Article 57(1): the scheme applies to a single item of
 * expenditure of AED 5,000,000 or more, EXCLUDING tax. Below it there is no
 * capital asset and no adjustment period, however long the thing lasts.
 */
export const CAPITAL_ASSET_THRESHOLD_MINOR = 500_000_000n;

/**
 * Executive Regulation Article 57(2)(a) and Article 58(2): ten consecutive
 * years for a building or a part of a building.
 */
export const BUILDING_INTERVALS = 10;

/** Executive Regulation Article 57(2)(b): five years for any other capital asset. */
export const OTHER_INTERVALS = 5;

/** Proportions are basis points everywhere in this product; 10,000 bps is 100%. */
const BPS_FULL = 10_000n;

/**
 * 1350 — VAT input (recoverable). The adjustment lands on the same control
 * account as every other input tax figure, because it IS input tax: a capital
 * asset adjustment changes how much of the original tax is recoverable, and the
 * FTA expects it inside the input tax boxes rather than beside them.
 */
const ACC_VAT_INPUT = "1350";

/**
 * The other side. Input tax that turns out not to be recoverable is a cost of
 * the business, and input tax that turns out to be recoverable after all is
 * that cost coming back. 6900 is the general home for it; a caller with a
 * dedicated irrecoverable-VAT account passes its code instead.
 */
const ACC_DEFAULT_EXPENSE = "6900";

/**
 * The tax treatment the adjustment line carries.
 *
 * This is load-bearing. `vat.ts` totals input tax from lines tagged INPUT_VAT
 * and, separately, reconciles that total against the movement on 1350. An
 * untagged line on 1350 would move one of those two figures and not the other,
 * and the return would report "input tax does not match account 1350 — do not
 * file" on a perfectly correct adjustment. Tagging it moves both together.
 */
const TAX_CODE_INPUT = "INPUT_VAT";

export type CapitalAssetCategory = "BUILDING" | "OTHER";

/** Ten intervals for a building, five for anything else (ER Article 57(2)). */
export function intervalsFor(category: CapitalAssetCategory): number {
  return category === "BUILDING" ? BUILDING_INTERVALS : OTHER_INTERVALS;
}

/* ─────────────────────────────────────────────────────────── registering one */

export interface NewCapitalAsset {
  code: string;
  description: string;
  category: CapitalAssetCategory;
  /** When it was bought. */
  acquiredOn: string;
  /** When it was first used — this, not the purchase, starts the period (ER 58(2)). */
  firstUsedOn: string;
  /** Cost excluding tax, in minor units. */
  costMinor: bigint | number | string;
  /** Input tax on the purchase, in full, before any apportionment. */
  inputTaxMinor: bigint | number | string;
  /** The taxable-use proportion claimed at the outset, in basis points. */
  originalUseBps: number;
}

export interface RegisteredCapitalAsset {
  code: string;
  description: string;
  category: CapitalAssetCategory;
  acquiredOn: string;
  firstUsedOn: string;
  costMinor: string;
  inputTaxMinor: string;
  originalUseBps: number;
  intervals: number;
  /** One tenth or one fifth of the input tax — what a full interval is worth. */
  perIntervalMinor: string;
  adjustmentPeriodEndsOn: string;
  /** Anything a person should read before relying on this row. */
  notes: string[];
}

/**
 * Put a capital asset on the register.
 *
 * The register is deliberately separate from the fixed asset register in
 * `assets.ts`: they answer different questions and have different populations.
 * A building held under a lease can be a capital asset for VAT without being an
 * item of property, plant and equipment, and a vehicle can be depreciated for
 * ten years while its adjustment period runs five. Deriving one from the other
 * would make each wrong wherever the two definitions part company.
 */
export async function registerCapitalAsset(opts: {
  orgId: string;
  entityId: string;
  asset: NewCapitalAsset;
}): Promise<RegisteredCapitalAsset> {
  const a = opts.asset;
  const code = a.code?.trim();
  if (!code) throw new LedgerError("A capital asset needs a code to be adjusted against years from now.");
  if (!a.description?.trim()) throw new LedgerError("Give the asset a description — the person making the adjustment in eight years has never seen it.");

  const category: CapitalAssetCategory = a.category === "BUILDING" ? "BUILDING" : "OTHER";
  const cost = parseMinor(a.costMinor, "cost");
  const inputTax = parseMinor(a.inputTaxMinor, "input tax");

  if (cost <= 0n) throw new LedgerError("A capital asset has to have cost something.");
  if (cost < CAPITAL_ASSET_THRESHOLD_MINOR) {
    // Naming the figure matters: the refusal is a rule, not an opinion, and the
    // person reading it needs to know whether they are AED 200 short or a
    // decimal place out.
    throw new LedgerError(
      `${money(cost)} is below the capital assets scheme threshold of ${money(CAPITAL_ASSET_THRESHOLD_MINOR)} ` +
        `excluding tax (Executive Regulation Article 57(1)), so there is no adjustment period to keep. ` +
        `The input tax on it is recovered once, in the period of the purchase, and that is the end of it.`,
    );
  }
  if (inputTax < 0n) throw new LedgerError("Input tax cannot be negative.");
  if (inputTax > cost) {
    throw new LedgerError(
      `Input tax of ${money(inputTax)} is more than the ${money(cost)} cost it was charged on. ` +
        `Check which figure went in which box.`,
    );
  }
  if (!Number.isInteger(a.originalUseBps) || a.originalUseBps < 0 || a.originalUseBps > 10_000) {
    throw new LedgerError("The taxable-use proportion is basis points, nought to 10,000 — 10,000 being wholly taxable use.");
  }

  const acquiredOn = parseDay(a.acquiredOn, "the acquisition date");
  const firstUsedOn = parseDay(a.firstUsedOn, "the first-use date");
  if (firstUsedOn < acquiredOn) {
    throw new LedgerError(
      `First used ${iso(firstUsedOn)} but acquired ${iso(acquiredOn)}. The adjustment period runs from first use, ` +
        `which cannot come before the purchase.`,
    );
  }

  const clash = await prisma.capitalAssetItem.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code },
  });
  if (clash) throw new LedgerError(`Capital asset ${code} is already on the register.`);

  const intervals = intervalsFor(category);
  const row = await prisma.capitalAssetItem.create({
    data: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      code,
      description: a.description.trim(),
      category,
      acquiredOn,
      firstUsedOn,
      costMinor: cost,
      inputTaxMinor: inputTax,
      originalUseBps: a.originalUseBps,
    },
  });

  return {
    code: row.code,
    description: row.description,
    category,
    acquiredOn: iso(row.acquiredOn),
    firstUsedOn: iso(row.firstUsedOn),
    costMinor: row.costMinor.toString(),
    inputTaxMinor: row.inputTaxMinor.toString(),
    originalUseBps: row.originalUseBps,
    intervals,
    perIntervalMinor: divHalfUp(row.inputTaxMinor, BigInt(intervals)).toString(),
    adjustmentPeriodEndsOn: iso(intervalEnd(row.firstUsedOn, intervals)),
    notes: [
      `The adjustment period is ${intervals} consecutive years from first use ` +
        `(${category === "BUILDING" ? "Executive Regulation Article 57(2)(a) — a building" : "Executive Regulation Article 57(2)(b)"}), ` +
        `ending ${iso(intervalEnd(row.firstUsedOn, intervals))}.`,
      `Whether this expenditure is one capital asset, and whether its useful life reaches ` +
        `${intervals} years, are judgements taken from you rather than read out of the ledger.`,
    ],
  };
}

/* ──────────────────────────────────────────────────────── what has fallen due */

export interface DueInterval {
  interval: number;
  /** The twelve months the interval covers. */
  from: string;
  to: string;
  /** The day the interval closed, after which the adjustment can be worked out. */
  dueOn: string;
  /** How long it has been outstanding, in days. */
  overdueDays: number;
}

export interface DueAsset {
  code: string;
  description: string;
  category: CapitalAssetCategory;
  firstUsedOn: string;
  intervals: number;
  inputTaxMinor: string;
  originalUseBps: number;
  perIntervalMinor: string;
  due: DueInterval[];
  /**
   * The most this asset's outstanding intervals could move the tax, in either
   * direction — one interval's share of the input tax for each of them. A
   * bound, not an estimate: the actual figure needs the taxable-use proportion,
   * which nobody has supplied yet.
   */
  boundMinor: string;
}

/**
 * A finding in the shape `attention.ts` builds its list from, so this can be
 * dropped into that list without either module learning about the other.
 */
export interface DueFinding {
  key: string;
  severity: "urgent" | "soon" | "note";
  title: string;
  detail: string;
  count: number;
  href: string;
}

export interface AdjustmentDueResult {
  entityId: string;
  asOf: string;
  currency: string;
  assets: DueAsset[];
  /** Intervals outstanding across every asset. */
  intervalCount: number;
  boundMinor: string;
  finding: DueFinding | null;
}

/** A year late is where this stops being an oversight and starts being a penalty. */
const BADLY_OVERDUE_DAYS = 365;

/**
 * Which capital assets have an interval that has closed and has never been
 * assessed.
 *
 * This is the single most-missed obligation in UAE VAT, and the reason is
 * structural rather than careless: the obligation falls due years after a
 * purchase everybody has forgotten, on an asset nobody is looking at, and
 * nothing in the books changes to announce it. So the list has to come from the
 * register on every read — computed, never stored — and it has to say plainly
 * that the amount cannot be known until somebody states the taxable use.
 */
export async function adjustmentDue(opts: {
  orgId: string;
  entityId: string;
  /** The day to ask the question on. Defaults to today. */
  asOf?: Date | string;
}): Promise<AdjustmentDueResult> {
  const asOf = opts.asOf === undefined ? today() : parseDay(opts.asOf, "the date to read the register at");

  const [assets, book] = await Promise.all([
    prisma.capitalAssetItem.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, status: "active" },
      include: { adjustments: true },
      orderBy: { code: "asc" },
    }),
    prisma.book.findFirst({ where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" } }),
  ]);

  const out: DueAsset[] = [];
  let total = 0;
  let bound = 0n;

  for (const a of assets) {
    const category = a.category === "BUILDING" ? "BUILDING" : "OTHER";
    const intervals = intervalsFor(category);
    const perInterval = divHalfUp(a.inputTaxMinor, BigInt(intervals));
    const assessed = new Set(a.adjustments.map((x) => x.interval));

    const due: DueInterval[] = [];
    // Interval 1 is the year of first use: the input tax claimed at the outset
    // IS its position, so there is nothing to compare it against. Adjustments
    // start with the second year.
    for (let n = 2; n <= intervals; n++) {
      if (assessed.has(n)) continue;
      const to = intervalEnd(a.firstUsedOn, n);
      if (to > asOf) continue;
      due.push({
        interval: n,
        from: iso(intervalStart(a.firstUsedOn, n)),
        to: iso(to),
        dueOn: iso(to),
        overdueDays: daysBetween(to, asOf),
      });
    }
    if (due.length === 0) continue;

    total += due.length;
    const assetBound = perInterval * BigInt(due.length);
    bound += assetBound;
    out.push({
      code: a.code,
      description: a.description,
      category,
      firstUsedOn: iso(a.firstUsedOn),
      intervals,
      inputTaxMinor: a.inputTaxMinor.toString(),
      originalUseBps: a.originalUseBps,
      perIntervalMinor: perInterval.toString(),
      due,
      boundMinor: assetBound.toString(),
    });
  }

  const worst = out.reduce((a, x) => Math.max(a, ...x.due.map((d) => d.overdueDays)), 0);
  const currency = book?.functionalCurrency ?? "AED";

  return {
    entityId: opts.entityId,
    asOf: iso(asOf),
    currency,
    assets: out,
    intervalCount: total,
    boundMinor: bound.toString(),
    finding:
      total === 0
        ? null
        : {
            key: "capital_asset_adjustments",
            severity: worst > BADLY_OVERDUE_DAYS ? "urgent" : "soon",
            title:
              total === 1
                ? "A capital asset interval has not been adjusted"
                : "Capital asset intervals have not been adjusted",
            detail:
              `${plural(total, "interval has", "intervals have")} closed on ` +
              `${plural(out.length, "capital asset", "capital assets")} ` +
              `(${out.slice(0, 3).map((x) => x.code).join(", ")}${out.length > 3 ? ", …" : ""}) without an ` +
              `adjustment under the capital assets scheme. The oldest closed ${plural(worst, "day", "days")} ago. ` +
              `Up to ${money(bound, currency)} of input tax turns on ${total === 1 ? "it" : "them"}, in either ` +
              `direction — the exact figure cannot be worked out here, because it needs the proportion of taxable ` +
              `use over each year and no accounting record holds that.`,
            count: total,
            href: "/accounting/vat-schemes",
          },
  };
}

/* ───────────────────────────────────────────────────── assessing one interval */

export interface ProposedLine {
  account: string;
  debitMinor: string | null;
  creditMinor: string | null;
  memo: string;
}

export interface AssessmentResult {
  code: string;
  interval: number;
  intervals: number;
  assessedOn: string;
  /** The twelve months the interval covers. */
  from: string;
  to: string;
  useBps: number;
  originalUseBps: number;
  changeBps: number;
  perIntervalMinor: string;
  /** Positive: more input tax recoverable. Negative: input tax to repay. */
  adjustmentMinor: string;
  entryId: string | null;
  reference: string | null;
  lines: ProposedLine[];
  /** True when the interval had already been assessed and nothing was posted. */
  alreadyAssessed: boolean;
  warnings: string[];
}

/**
 * One interval's adjustment, in fils.
 *
 * Executive Regulation Article 58(9): a tenth of the input tax for a building,
 * a fifth for anything else, multiplied by the change between the proportion of
 * taxable use in this interval and the proportion claimed at the outset.
 *
 * Worked through, so the arithmetic can be checked against the statute rather
 * than against this function:
 *
 *   A warehouse. Input tax AED 300,000.00 — 30,000,000 fils. A building, so ten
 *   intervals. Wholly taxable use claimed at the outset: 10,000 bps.
 *   In the third interval a floor is let to a bank, exempt, and taxable use for
 *   that year is 70%.
 *
 *     a tenth of the input tax      30,000,000 ÷ 10        =  3,000,000 fils
 *     change in taxable use          7,000 − 10,000        = −3,000 bps (−30%)
 *     adjustment                     3,000,000 × −30%      =   −900,000 fils
 *
 *   AED 9,000.00 of input tax goes back to the FTA. And the other way: had the
 *   same building been claimed at 70% and used wholly for taxable supplies, the
 *   change is +3,000 bps and AED 9,000.00 becomes recoverable.
 *
 * The multiplication is done before the division, and rounded once, at the end.
 * Rounding a tenth of the input tax first and then scaling it by the proportion
 * would multiply the rounding error by the proportion as well.
 */
export function intervalAdjustment(opts: {
  inputTaxMinor: bigint;
  intervals: number;
  originalUseBps: number;
  useBps: number;
}): bigint {
  const change = BigInt(opts.useBps - opts.originalUseBps);
  return divHalfUp(opts.inputTaxMinor * change, BigInt(opts.intervals) * BPS_FULL);
}

/**
 * Assess an interval and post its adjustment.
 *
 * Idempotent twice over: the register's own unique key on (asset, interval)
 * means an interval is assessed once, and the journal carries an `externalKey`
 * naming the asset, the interval and the use assessed, so a retried request
 * returns the original entry instead of posting a second one.
 *
 * A second assessment of the same interval at a DIFFERENT proportion is
 * refused rather than applied. A posted entry is never edited — it is reversed
 * — and quietly posting the difference would leave two adjustments on the
 * ledger for one year with nothing saying why.
 */
export async function assessInterval(opts: {
  orgId: string;
  entityId: string;
  code: string;
  interval: number;
  /** The proportion of taxable use over the interval, in basis points. */
  useBps: number;
  /** The day the adjustment is posted — it belongs to the tax period that reports it. */
  on: string;
  expenseAccount?: string;
  actorId?: string;
}): Promise<AssessmentResult> {
  const asset = await prisma.capitalAssetItem.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.code },
    include: { adjustments: true },
  });
  if (!asset) throw new LedgerError(`Capital asset ${opts.code} is not on the register for this entity.`);

  const category: CapitalAssetCategory = asset.category === "BUILDING" ? "BUILDING" : "OTHER";
  const intervals = intervalsFor(category);

  if (!Number.isInteger(opts.interval) || opts.interval < 1 || opts.interval > intervals) {
    throw new LedgerError(
      `${asset.code} has ${intervals} intervals (Executive Regulation Article 57(2)), so interval ${opts.interval} ` +
        `does not exist. Its adjustment period runs to ${iso(intervalEnd(asset.firstUsedOn, intervals))}.`,
    );
  }
  if (opts.interval === 1) {
    // The first year is not adjusted against itself: the input tax recovered at
    // the outset is what interval 1 says. A first-year difference between
    // INTENDED and actual use is a different adjustment (ER Article 58(5)),
    // made on the whole of the input tax rather than a tenth of it, and this
    // module does not compute it.
    throw new LedgerError(
      `Interval 1 is the year of first use, and the input tax claimed at the outset is its position — there is ` +
        `nothing to compare it against. Adjustments start at interval 2. A first-year difference between intended ` +
        `and actual use is a separate adjustment under Executive Regulation Article 58(5), on the whole of the ` +
        `input tax, and is not computed here.`,
    );
  }
  if (!Number.isInteger(opts.useBps) || opts.useBps < 0 || opts.useBps > 10_000) {
    throw new LedgerError("Taxable use for the interval is basis points, nought to 10,000.");
  }

  const on = parseDay(opts.on, "the date to post the adjustment on");
  const from = intervalStart(asset.firstUsedOn, opts.interval);
  const to = intervalEnd(asset.firstUsedOn, opts.interval);
  if (to > on) {
    throw new LedgerError(
      `Interval ${opts.interval} runs to ${iso(to)} and ${iso(on)} is inside it. The proportion of taxable use is ` +
        `measured over the whole year, so there is nothing to assess until the year is over.`,
    );
  }
  if (asset.status === "disposed") {
    throw new LedgerError(
      `${asset.code} was disposed of, and the disposal made the final adjustment for every remaining interval in ` +
        `one (Executive Regulation Article 58(12)). Reverse that entry if it was wrong.`,
    );
  }

  const perInterval = divHalfUp(asset.inputTaxMinor, BigInt(intervals));
  const existing = asset.adjustments.find((x) => x.interval === opts.interval);
  if (existing) {
    const entry = existing.entryId
      ? await prisma.journalEntry.findFirst({ where: { id: existing.entryId, orgId: opts.orgId } })
      : null;
    return {
      code: asset.code,
      interval: opts.interval,
      intervals,
      assessedOn: iso(existing.assessedOn),
      from: iso(from),
      to: iso(to),
      useBps: existing.useBps,
      originalUseBps: asset.originalUseBps,
      changeBps: existing.useBps - asset.originalUseBps,
      perIntervalMinor: perInterval.toString(),
      adjustmentMinor: existing.adjustmentMinor.toString(),
      entryId: existing.entryId,
      reference: entry ? `${entry.series}-${entry.number}` : null,
      lines: [],
      alreadyAssessed: true,
      warnings:
        existing.useBps === opts.useBps
          ? []
          : [
              `Interval ${opts.interval} was already assessed at ${pct(existing.useBps)} taxable use and ` +
                `${money(existing.adjustmentMinor)} was posted. Nothing has been posted for ${pct(opts.useBps)}. ` +
                `A posted entry is corrected by reversal, never by a second entry on top of it.`,
            ],
    };
  }

  const adjustment = intervalAdjustment({
    inputTaxMinor: asset.inputTaxMinor,
    intervals,
    originalUseBps: asset.originalUseBps,
    useBps: opts.useBps,
  });

  const lines = adjustmentLines(
    adjustment,
    opts.expenseAccount ?? ACC_DEFAULT_EXPENSE,
    `${asset.code} interval ${opts.interval} — taxable use ${pct(opts.useBps)} against ${pct(asset.originalUseBps)}`,
  );

  let entryId: string | null = null;
  let reference: string | null = null;
  if (lines.length) {
    const entry = await post({
      orgId: opts.orgId,
      entityId: opts.entityId,
      entryDate: on,
      memo: `Capital asset adjustment — ${asset.code} interval ${opts.interval} of ${intervals}`,
      // Not "manual": 1350 is a control account, and the database refuses a
      // manual journal against one. This IS the subledger that owns it.
      source: "vat",
      sourceType: "CAPITAL_ASSET_ADJUSTMENT",
      sourceId: asset.id,
      externalKey: `capitalasset:${asset.id}:${opts.interval}:${opts.useBps}`,
      actorType: "HUMAN",
      actorId: opts.actorId,
      series: "CA",
      lines: lines.map((l) => ({
        account: l.account,
        ...(l.debitMinor !== null ? { debit: l.debitMinor } : { credit: l.creditMinor! }),
        memo: l.memo,
        // Only the tax line carries a treatment. The adjustment changes the tax
        // on a supply that was reported years ago; it does not restate the
        // value of any supply, so tagging the expense side would put the same
        // net figure into box 9 a second time.
        ...(l.account === ACC_VAT_INPUT ? { taxCode: TAX_CODE_INPUT } : {}),
      })),
    });
    entryId = entry.id;
    reference = `${entry.series}-${entry.number}`;
  }

  // The register row goes in only once the journal has committed — the other
  // order marks an interval assessed with nothing behind it, and the interval
  // then never comes back around.
  const row = await prisma.capitalAssetAdjustment.create({
    data: {
      orgId: opts.orgId,
      assetId: asset.id,
      interval: opts.interval,
      assessedOn: on,
      useBps: opts.useBps,
      adjustmentMinor: adjustment,
      entryId,
    },
  });

  return {
    code: asset.code,
    interval: row.interval,
    intervals,
    assessedOn: iso(row.assessedOn),
    from: iso(from),
    to: iso(to),
    useBps: row.useBps,
    originalUseBps: asset.originalUseBps,
    changeBps: row.useBps - asset.originalUseBps,
    perIntervalMinor: perInterval.toString(),
    adjustmentMinor: row.adjustmentMinor.toString(),
    entryId,
    reference,
    lines,
    alreadyAssessed: false,
    warnings:
      adjustment === 0n
        ? [
            `Taxable use was ${pct(opts.useBps)}, exactly as claimed at the outset, so there is no adjustment and ` +
              `nothing has been posted. The interval is recorded as assessed, which is what stops it coming back ` +
              `around as outstanding.`,
          ]
        : [],
  };
}

/* ─────────────────────────────────────────────────────────────────── disposal */

export interface DisposalResult {
  code: string;
  disposedOn: string;
  intervals: number;
  /** The intervals the final adjustment covered, in one. */
  remainingIntervals: number[];
  deemedUseBps: number;
  perIntervalMinor: string;
  adjustmentMinor: string;
  entryId: string | null;
  reference: string | null;
  lines: ProposedLine[];
  warnings: string[];
}

/**
 * Dispose of a capital asset inside its adjustment period.
 *
 * Executive Regulation Article 58(12): where the asset is supplied during the
 * adjustment period, the remaining intervals are all adjusted at once, and the
 * asset is treated as having been used for wholly taxable purposes for that
 * remainder where the supply itself is taxable — and wholly non-taxable where
 * it is exempt.
 *
 * Whether the disposal was a taxable supply is an INPUT. The ledger sees the
 * sale, not its treatment, and the difference between the two answers is the
 * whole of the remaining input tax, so it is not somewhere to guess.
 *
 * A row is written for every remaining interval rather than one row for the
 * lot. Each interval is a distinct annual adjustment in law, the register has
 * to show that none of them is still outstanding, and one row for several years
 * would leave the rest looking unassessed forever.
 */
export async function disposeCapitalAsset(opts: {
  orgId: string;
  entityId: string;
  code: string;
  on: string;
  /** Was the disposal itself a taxable supply? Defaults to yes (ER 58(12)). */
  supplyIsTaxable?: boolean;
  expenseAccount?: string;
  actorId?: string;
}): Promise<DisposalResult> {
  const asset = await prisma.capitalAssetItem.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.code },
    include: { adjustments: true },
  });
  if (!asset) throw new LedgerError(`Capital asset ${opts.code} is not on the register for this entity.`);
  if (asset.status === "disposed") throw new LedgerError(`${asset.code} has already been disposed of.`);

  const category: CapitalAssetCategory = asset.category === "BUILDING" ? "BUILDING" : "OTHER";
  const intervals = intervalsFor(category);
  const on = parseDay(opts.on, "the disposal date");
  if (on < asset.firstUsedOn) {
    throw new LedgerError(
      `${asset.code} was first used ${iso(asset.firstUsedOn)} and cannot have been disposed of ${iso(on)}, before ` +
        `its adjustment period began.`,
    );
  }

  const deemedUseBps = opts.supplyIsTaxable === false ? 0 : 10_000;
  const assessed = new Set(asset.adjustments.map((x) => x.interval));
  const warnings: string[] = [];

  // Which interval the disposal falls in. Everything from there to the end of
  // the period is "remaining"; the ones before it had already closed on their
  // own actual use.
  let current = intervals + 1;
  for (let n = 1; n <= intervals; n++) {
    if (intervalEnd(asset.firstUsedOn, n) >= on) { current = n; break; }
  }
  const remaining: number[] = [];
  for (let n = Math.max(current, 2); n <= intervals; n++) if (!assessed.has(n)) remaining.push(n);

  // Intervals that closed before the disposal and were never assessed are a
  // separate, overdue obligation. Sweeping them into this adjustment at the
  // deemed proportion would assess years of real use at a figure the law only
  // deems for the remainder — so they are named and left alone.
  const stillOutstanding: number[] = [];
  for (let n = 2; n < Math.max(current, 2); n++) if (!assessed.has(n)) stillOutstanding.push(n);
  if (stillOutstanding.length) {
    warnings.push(
      `${plural(stillOutstanding.length, "interval", "intervals")} ${stillOutstanding.join(", ")} closed before the ` +
        `disposal and ${stillOutstanding.length === 1 ? "was" : "were"} never assessed. This entry does not cover ` +
        `${stillOutstanding.length === 1 ? "it" : "them"}: each has to be adjusted on the taxable use actually made ` +
        `in that year.`,
    );
  }

  if (current > intervals) {
    throw new LedgerError(
      `${asset.code}'s adjustment period ended ${iso(intervalEnd(asset.firstUsedOn, intervals))}, before ` +
        `${iso(on)}. A disposal after the period is outside the scheme and needs no adjustment.`,
    );
  }
  if (remaining.length === 0) {
    throw new LedgerError(
      `Every interval of ${asset.code} from ${current} onwards has already been assessed, so the disposal has ` +
        `nothing left to adjust.`,
    );
  }

  const perInterval = divHalfUp(asset.inputTaxMinor, BigInt(intervals));
  // Each interval is rounded on its own, because each is its own adjustment in
  // law; the entry posts their sum.
  const each = intervalAdjustment({
    inputTaxMinor: asset.inputTaxMinor,
    intervals,
    originalUseBps: asset.originalUseBps,
    useBps: deemedUseBps,
  });
  const total = each * BigInt(remaining.length);

  const lines = adjustmentLines(
    total,
    opts.expenseAccount ?? ACC_DEFAULT_EXPENSE,
    `${asset.code} disposed ${iso(on)} — final adjustment for ${plural(remaining.length, "interval", "intervals")} ` +
      `${remaining.join(", ")} at ${pct(deemedUseBps)} taxable use`,
  );

  let entryId: string | null = null;
  let reference: string | null = null;
  if (lines.length) {
    const entry = await post({
      orgId: opts.orgId,
      entityId: opts.entityId,
      entryDate: on,
      memo: `Capital asset final adjustment — ${asset.code} disposed ${iso(on)}`,
      source: "vat",
      sourceType: "CAPITAL_ASSET_DISPOSAL",
      sourceId: asset.id,
      externalKey: `capitalasset:dispose:${asset.id}:${iso(on)}`,
      actorType: "HUMAN",
      actorId: opts.actorId,
      series: "CA",
      lines: lines.map((l) => ({
        account: l.account,
        ...(l.debitMinor !== null ? { debit: l.debitMinor } : { credit: l.creditMinor! }),
        memo: l.memo,
        ...(l.account === ACC_VAT_INPUT ? { taxCode: TAX_CODE_INPUT } : {}),
      })),
    });
    entryId = entry.id;
    reference = `${entry.series}-${entry.number}`;
  } else {
    warnings.push(
      `Taxable use was already ${pct(asset.originalUseBps)}, so treating the remaining intervals as ` +
        `${pct(deemedUseBps)} changes nothing and no entry was posted. The intervals are recorded as closed.`,
    );
  }

  await prisma.$transaction([
    ...remaining.map((n) =>
      prisma.capitalAssetAdjustment.create({
        data: {
          orgId: opts.orgId,
          assetId: asset.id,
          interval: n,
          assessedOn: on,
          useBps: deemedUseBps,
          adjustmentMinor: each,
          entryId,
        },
      }),
    ),
    prisma.capitalAssetItem.update({ where: { id: asset.id }, data: { status: "disposed" } }),
  ]);

  return {
    code: asset.code,
    disposedOn: iso(on),
    intervals,
    remainingIntervals: remaining,
    deemedUseBps,
    perIntervalMinor: perInterval.toString(),
    adjustmentMinor: total.toString(),
    entryId,
    reference,
    lines,
    warnings,
  };
}

/* ─────────────────────────────────────────────────────────────── the register */

export type IntervalState = "original" | "assessed" | "due" | "not_yet_due";

export interface RegisterInterval {
  interval: number;
  from: string;
  to: string;
  state: IntervalState;
  useBps: number | null;
  adjustmentMinor: string | null;
  assessedOn: string | null;
  entryId: string | null;
  reference: string | null;
}

export interface RegisterAsset {
  code: string;
  description: string;
  category: CapitalAssetCategory;
  acquiredOn: string;
  firstUsedOn: string;
  adjustmentPeriodEndsOn: string;
  costMinor: string;
  inputTaxMinor: string;
  originalUseBps: number;
  status: string;
  intervals: number;
  perIntervalMinor: string;
  intervalRows: RegisterInterval[];
  assessedCount: number;
  outstandingCount: number;
  /** Net of everything adjusted so far: positive recovered, negative repaid. */
  adjustedMinor: string;
}

export interface CapitalAssetRegisterResult {
  entityId: string;
  asOf: string;
  currency: string;
  assets: RegisterAsset[];
  totals: {
    inputTaxMinor: string;
    adjustedMinor: string;
    recoveredMinor: string;
    repaidMinor: string;
    outstandingCount: number;
  };
  /** The register against what actually reached account 1350. */
  reconciliation: {
    registerMinor: string;
    ledgerMinor: string;
    agrees: boolean;
    /** Assessments recorded with no journal behind them — nil adjustments aside. */
    unpostedCount: number;
  };
}

/**
 * The register: every asset, every interval, and the ledger it has to agree
 * with.
 *
 * The reconciliation is the point, exactly as it is in `assets.ts`. The
 * register says what has been adjusted; account 1350 says what was posted. If
 * the two differ, that is a finding — an adjustment recorded but never posted,
 * or an entry reversed without the register being told — and it is reported
 * rather than reconciled away.
 */
export async function capitalAssetRegister(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date | string;
}): Promise<CapitalAssetRegisterResult> {
  const asOf = opts.asOf === undefined ? today() : parseDay(opts.asOf, "the date to read the register at");

  const [assets, book, vatAccount] = await Promise.all([
    prisma.capitalAssetItem.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId },
      include: { adjustments: { orderBy: { interval: "asc" } } },
      orderBy: [{ status: "asc" }, { code: "asc" }],
    }),
    prisma.book.findFirst({ where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" } }),
    prisma.account.findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, code: ACC_VAT_INPUT },
      select: { id: true },
    }),
  ]);

  const entryIds = [...new Set(assets.flatMap((a) => a.adjustments.map((x) => x.entryId).filter(Boolean)))] as string[];
  const entries = entryIds.length
    ? await prisma.journalEntry.findMany({
        where: { id: { in: entryIds }, orgId: opts.orgId, entityId: opts.entityId },
        select: { id: true, series: true, number: true },
      })
    : [];
  const refById = new Map(entries.map((e) => [e.id, `${e.series}-${e.number}`]));

  // What the books carry for those entries, read off the control account. A
  // reversed entry's own lines are real postings and its reversal offsets them,
  // so both statuses are counted — reading only "posted" would keep the
  // reversal and drop what it reversed.
  const ledgerLines =
    entryIds.length && vatAccount
      ? await prisma.journalLine.findMany({
          where: {
            orgId: opts.orgId,
            accountId: vatAccount.id,
            entry: { id: { in: entryIds }, status: { in: ["posted", "reversed"] } },
          },
          select: { functionalAmountMinor: true },
        })
      : [];
  const ledgerMinor = ledgerLines.reduce((a, l) => a + l.functionalAmountMinor, 0n);

  let registerPosted = 0n;
  let adjustedTotal = 0n;
  let recovered = 0n;
  let repaid = 0n;
  let inputTaxTotal = 0n;
  let outstandingTotal = 0;
  let unposted = 0;

  const rows: RegisterAsset[] = assets.map((a) => {
    const category: CapitalAssetCategory = a.category === "BUILDING" ? "BUILDING" : "OTHER";
    const intervals = intervalsFor(category);
    const perInterval = divHalfUp(a.inputTaxMinor, BigInt(intervals));
    const byInterval = new Map(a.adjustments.map((x) => [x.interval, x]));

    let adjusted = 0n;
    let assessedCount = 0;
    let outstanding = 0;

    const intervalRows: RegisterInterval[] = [];
    for (let n = 1; n <= intervals; n++) {
      const from = intervalStart(a.firstUsedOn, n);
      const to = intervalEnd(a.firstUsedOn, n);
      const row = byInterval.get(n);
      let state: IntervalState;
      if (n === 1 && !row) state = "original";
      else if (row) state = "assessed";
      else if (to <= asOf && a.status === "active") state = "due";
      else state = "not_yet_due";

      if (row) {
        assessedCount++;
        adjusted += row.adjustmentMinor;
        if (row.adjustmentMinor > 0n) recovered += row.adjustmentMinor;
        if (row.adjustmentMinor < 0n) repaid += -row.adjustmentMinor;
        if (row.entryId) registerPosted += row.adjustmentMinor;
        else if (row.adjustmentMinor !== 0n) unposted++;
      }
      if (state === "due") outstanding++;

      intervalRows.push({
        interval: n,
        from: iso(from),
        to: iso(to),
        state,
        useBps: row ? row.useBps : n === 1 ? a.originalUseBps : null,
        adjustmentMinor: row ? row.adjustmentMinor.toString() : null,
        assessedOn: row ? iso(row.assessedOn) : null,
        entryId: row?.entryId ?? null,
        reference: row?.entryId ? refById.get(row.entryId) ?? null : null,
      });
    }

    adjustedTotal += adjusted;
    inputTaxTotal += a.inputTaxMinor;
    outstandingTotal += outstanding;

    return {
      code: a.code,
      description: a.description,
      category,
      acquiredOn: iso(a.acquiredOn),
      firstUsedOn: iso(a.firstUsedOn),
      adjustmentPeriodEndsOn: iso(intervalEnd(a.firstUsedOn, intervals)),
      costMinor: a.costMinor.toString(),
      inputTaxMinor: a.inputTaxMinor.toString(),
      originalUseBps: a.originalUseBps,
      status: a.status,
      intervals,
      perIntervalMinor: perInterval.toString(),
      intervalRows,
      assessedCount,
      outstandingCount: outstanding,
      adjustedMinor: adjusted.toString(),
    };
  });

  return {
    entityId: opts.entityId,
    asOf: iso(asOf),
    currency: book?.functionalCurrency ?? "AED",
    assets: rows,
    totals: {
      inputTaxMinor: inputTaxTotal.toString(),
      adjustedMinor: adjustedTotal.toString(),
      recoveredMinor: recovered.toString(),
      repaidMinor: repaid.toString(),
      outstandingCount: outstandingTotal,
    },
    reconciliation: {
      registerMinor: registerPosted.toString(),
      ledgerMinor: ledgerMinor.toString(),
      agrees: registerPosted === ledgerMinor,
      unpostedCount: unposted,
    },
  };
}

/* ──────────────────────────────────────────────────────── profit margin scheme */

export interface MarginSchemeResult {
  purchaseMinor: string;
  saleMinor: string;
  /** Sale less purchase. Never negative: see `refusal`. */
  marginMinor: string;
  /** The tax within the margin. Nil where there is no margin. */
  taxMinor: string;
  /** The margin without its tax — the value of the supply. */
  netMarginMinor: string;
  ratePercent: number;
  /** Set where the scheme cannot produce a figure, saying why. */
  refusal: string | null;
  notes: string[];
}

/**
 * VAT on the margin, for qualifying second-hand goods.
 *
 * Article 29 of Federal Decree-Law 8/2017 lets a taxable person account for tax
 * on the profit margin rather than on the whole selling price. Article 43 of
 * the Executive Regulation defines that margin as the difference between the
 * purchase price and the selling price, and treats the tax as INCLUDED in it —
 * which is why the tax here is 5/105 of the margin and not 5% of it. Taking 5%
 * of the margin overstates the tax by a twentieth, every time.
 *
 * The rate is not restated here. It comes from the one rate table in this
 * product, `src/lib/domain/tax.ts`, through the MARGIN_SCHEME profile.
 *
 * Two things the software cannot decide, and does not:
 *
 *  - Whether the goods qualify. Article 29 needs second-hand goods, antiques or
 *    collectors' items on which VAT was borne before, bought from someone who
 *    did not charge tax on them. That is a fact about the purchase, not about
 *    the numbers.
 *  - Whether input tax was recovered on the purchase. It must not have been —
 *    under the scheme the input tax on the purchase is not recoverable, and
 *    recovering it and then taxing only the margin takes the relief twice.
 *
 * Pure: no ledger, no entity, no side effects. It is arithmetic on two figures.
 */
export function marginSchemeSupply(opts: {
  purchaseMinor: bigint | number | string;
  saleMinor: bigint | number | string;
}): MarginSchemeResult {
  const purchase = parseMinor(opts.purchaseMinor, "the purchase price");
  const sale = parseMinor(opts.saleMinor, "the selling price");

  const profile = getProfile("MARGIN_SCHEME");
  const rate = BigInt(profile.ratePercent);

  const notes = [
    // The invoice must not show a tax amount. Executive Regulation Article
    // 43(3): a tax invoice for a margin-scheme supply states that the scheme
    // has been applied and does NOT state the tax. The reason is the buyer's
    // side of it — a tax figure on the face of the invoice is a figure the
    // buyer can recover, and the supplier accounted for tax on the margin
    // alone. Showing it would let the buyer reclaim tax on a value nobody ever
    // paid tax on, and the difference leaves the FTA permanently short.
    "The tax invoice must state that the profit margin scheme has been applied and must NOT show a tax amount " +
      "(Executive Regulation Article 43). A buyer cannot recover tax the supplier never accounted for on the full value.",
    "Input tax on the purchase of these goods cannot be recovered (Article 29 of Federal Decree-Law 8/2017). " +
      "Recovering it and then taxing only the margin takes the same relief twice.",
    "Whether the goods qualify — second-hand, antiques or collectors' items on which tax has already been borne — " +
      "is a fact about the purchase that this cannot see, and is taken from you.",
  ];

  if (purchase < 0n || sale < 0n) {
    return {
      purchaseMinor: purchase.toString(),
      saleMinor: sale.toString(),
      marginMinor: "0",
      taxMinor: "0",
      netMarginMinor: "0",
      ratePercent: profile.ratePercent,
      refusal: "A price cannot be negative. A refund or an allowance is a credit note, not a negative sale.",
      notes,
    };
  }

  if (sale < purchase) {
    // There is no negative margin. Selling at a loss produces no tax — it does
    // not produce a credit. A scheme that netted losses against margins would
    // let a dealer recover tax on goods that never bore any.
    return {
      purchaseMinor: purchase.toString(),
      saleMinor: sale.toString(),
      marginMinor: "0",
      taxMinor: "0",
      netMarginMinor: "0",
      ratePercent: profile.ratePercent,
      refusal:
        `Sold for ${money(sale)} against ${money(purchase)} paid, so there is no margin and no tax is due on this ` +
        `supply. The loss is not a credit: the profit margin scheme taxes a margin where there is one and charges ` +
        `nothing where there is not. Do not net it against the margin on another item.`,
      notes,
    };
  }

  const margin = sale - purchase;
  // The tax is inside the margin (ER Article 43), so it is 5/105 of it.
  const tax = divHalfUp(margin * rate, 100n + rate);

  return {
    purchaseMinor: purchase.toString(),
    saleMinor: sale.toString(),
    marginMinor: margin.toString(),
    taxMinor: tax.toString(),
    netMarginMinor: (margin - tax).toString(),
    ratePercent: profile.ratePercent,
    refusal: null,
    notes,
  };
}

/* ────────────────────────────────────────────────────────────── designated zones */

export type SupplyKind = "GOODS" | "SERVICES";
export type ZoneMovement = "WITHIN_ZONE" | "BETWEEN_ZONES" | "INTO_ZONE" | "OUT_OF_ZONE";

export interface DesignatedZoneSupply {
  kind: SupplyKind;
  movement: ZoneMovement;
}

export interface DesignatedZoneTreatment {
  kind: SupplyKind;
  movement: ZoneMovement;
  /** How the supply is treated. */
  treatment: "OUT_OF_SCOPE" | "STANDARD_RATED" | "IMPORT";
  /** The profile in this product's rate table that carries the treatment. */
  taxProfileCode: "DESIGNATED_ZONE" | "STANDARD_5";
  /** Where the rule comes from. */
  citation: string;
  reason: string;
  /** What has to be true for the treatment to hold, which nobody here can check. */
  conditions: string[];
}

/**
 * How a supply touching a designated zone is treated.
 *
 * Article 51 of Federal Decree-Law 8/2017 lets the Executive Regulation treat a
 * designated zone as outside the State. Article 51 of the Regulation then does
 * so — for GOODS. Its clause on services does the opposite: the place of supply
 * of services in a designated zone is inside the State.
 *
 * That asymmetry is the whole of it, and it is where the money is lost. A
 * company in a designated zone selling goods to its neighbour is outside the
 * scope; the same company invoicing the same neighbour for consultancy is
 * standard rated at 5%, and finds out three years later.
 *
 * The second trap is direction. Goods moving from the mainland INTO a zone are
 * not an export. The supplier is in the State, the supply is in the State, and
 * it is standard rated like any other domestic sale.
 *
 * What this cannot know: whether the zone is a Designated Zone at all — that is
 * a list set by Cabinet Decision and amended from time to time, and a free zone
 * is not automatically on it — and whether the goods are consumed inside the
 * zone, which brings them back into the State whatever the paperwork says.
 * Both are stated as conditions rather than assumed away.
 */
export function designatedZoneTreatment(opts: { supply: DesignatedZoneSupply }): DesignatedZoneTreatment {
  const { kind, movement } = opts.supply;

  const zoneIsListed =
    "The zone must be a Designated Zone on the Cabinet Decision list — a fenced area with customs controls — " +
    "not merely a free zone.";

  if (kind === "SERVICES") {
    return {
      kind,
      movement,
      treatment: "STANDARD_RATED",
      taxProfileCode: "STANDARD_5",
      citation: "Federal Decree-Law 8/2017 Article 51; Executive Regulation Article 51(7)",
      reason:
        "A designated zone is treated as outside the State for goods only. The place of supply of services in a " +
        "designated zone is inside the State, so services are taxed as they would be on the mainland — 5% unless " +
        "some other relief applies to the service itself.",
      conditions: [
        zoneIsListed,
        "Zero-rating an export of services is a separate test (Article 31 of the Regulation) and is not this one.",
      ],
    };
  }

  if (movement === "INTO_ZONE") {
    return {
      kind,
      movement,
      treatment: "STANDARD_RATED",
      taxProfileCode: "STANDARD_5",
      citation: "Federal Decree-Law 8/2017 Article 51; Executive Regulation Article 51",
      reason:
        "Moving goods from the mainland into a designated zone is not an export. The supplier and the supply are " +
        "both in the State, so it is a domestic supply and standard rated.",
      conditions: [zoneIsListed],
    };
  }

  if (movement === "OUT_OF_ZONE") {
    return {
      kind,
      movement,
      treatment: "IMPORT",
      taxProfileCode: "STANDARD_5",
      citation: "Federal Decree-Law 8/2017 Article 51; Executive Regulation Article 51",
      reason:
        "Goods leaving a designated zone for the mainland are an import into the State. Tax is due on the import, " +
        "accounted for by the importer on the mainland — not charged by the seller in the zone.",
      conditions: [
        zoneIsListed,
        "Whether the import is accounted for under the reverse charge or paid at the border depends on the " +
          "importer's registration and customs arrangements.",
      ],
    };
  }

  return {
    kind,
    movement,
    treatment: "OUT_OF_SCOPE",
    taxProfileCode: "DESIGNATED_ZONE",
    citation: "Federal Decree-Law 8/2017 Article 51; Executive Regulation Article 51(3)-(4)",
    reason:
      movement === "BETWEEN_ZONES"
        ? "Goods moved from one designated zone to another are outside the scope, provided they are not released " +
          "into the State on the way and the customs suspension rules are followed."
        : "A supply of goods inside a designated zone is treated as made outside the State, so it is outside the " +
          "scope of UAE VAT.",
    conditions: [
      zoneIsListed,
      "The goods must not be consumed within the zone: goods consumed there are treated as supplied in the State " +
        "and are taxed accordingly.",
      ...(movement === "BETWEEN_ZONES"
        ? ["The FTA may require a financial guarantee for the movement between zones."]
        : []),
    ],
  };
}

/** Every combination, for a reference table on screen. */
export function designatedZoneMatrix(): DesignatedZoneTreatment[] {
  const kinds: SupplyKind[] = ["GOODS", "SERVICES"];
  const movements: ZoneMovement[] = ["WITHIN_ZONE", "BETWEEN_ZONES", "INTO_ZONE", "OUT_OF_ZONE"];
  return kinds.flatMap((kind) => movements.map((movement) => designatedZoneTreatment({ supply: { kind, movement } })));
}

/* ────────────────────────────────────────────────────────────────────── helpers */

/**
 * The two journal lines an adjustment makes.
 *
 * Positive is more input tax recoverable: the tax comes back onto 1350 and the
 * cost that was carried in the expense account comes off. Negative is tax to
 * repay: it leaves 1350 and becomes a cost. Nil posts nothing at all — an entry
 * for nought carries no information, and `post()` refuses one.
 */
function adjustmentLines(adjustment: bigint, expenseAccount: string, memo: string): ProposedLine[] {
  if (adjustment === 0n) return [];
  const abs = adjustment < 0n ? -adjustment : adjustment;
  return adjustment > 0n
    ? [
        { account: ACC_VAT_INPUT, debitMinor: abs.toString(), creditMinor: null, memo },
        { account: expenseAccount, debitMinor: null, creditMinor: abs.toString(), memo },
      ]
    : [
        { account: expenseAccount, debitMinor: abs.toString(), creditMinor: null, memo },
        { account: ACC_VAT_INPUT, debitMinor: null, creditMinor: abs.toString(), memo },
      ];
}

/**
 * Divide, rounding halves away from zero — which is what "to the nearest fils"
 * means to a tax authority, and keeps a repayment and a recovery of the same
 * size rounding to the same figure.
 */
function divHalfUp(value: bigint, divisor: bigint): bigint {
  if (divisor === 0n) throw new LedgerError("An adjustment cannot be divided over no intervals at all.");
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const out = (abs * 2n + divisor) / (divisor * 2n);
  return neg ? -out : out;
}

function parseMinor(v: bigint | number | string, field: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new LedgerError(`${field} has to be whole minor units, not ${v}.`);
    return BigInt(v);
  }
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) throw new LedgerError(`${field} has to be whole minor units, not "${v}".`);
  return BigInt(s);
}

function parseDay(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? new Date(`${v.slice(0, 10)}T00:00:00Z`) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date this can read.`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const today = () => parseDay(new Date(), "today");

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The same day, n years on, minus `lessDays` days.
 *
 * The day is clamped to the end of the target month rather than left to roll
 * over: an asset first used on 29 February would otherwise have every one of
 * its intervals start on 1 March, and the last of them would close a day into
 * the following year.
 */
function addYears(d: Date, years: number, lessDays = 0): Date {
  const y = d.getUTCFullYear() + years;
  const m = d.getUTCMonth();
  const lastOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastOfMonth);
  return new Date(Date.UTC(y, m, day - lessDays));
}

/** Interval n starts n-1 years after first use (ER Article 58(2)). */
function intervalStart(firstUsedOn: Date, interval: number): Date {
  return addYears(firstUsedOn, interval - 1);
}

/** …and closes the day before the next one starts. */
function intervalEnd(firstUsedOn: Date, interval: number): Date {
  return addYears(firstUsedOn, interval, 1);
}

const DAY = 86_400_000;
const daysBetween = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY));

const money = (minor: bigint, currency = "AED") => `${currency} ${fmtMinor(minor, currency, { zero: "zero" })}`;

/** Basis points as a percentage a person would say out loud. */
function pct(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0")}%`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
