import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { balanceSheet, balances, profitAndLoss, type StatementSection } from "./statements";
import { asPercent, asTimes, financialKpis, type Kpi } from "./kpi";
import { renderLayout, type Coverage, type LayoutInput, type RowKind } from "./layouts";
import { cashCodes } from "./cash";

/**
 * Comparatives: the same statement against something.
 *
 * A set of accounts nobody can compare with anything is a set of accounts
 * nobody can read. IAS 1.38 requires comparative information for the preceding
 * period for exactly this reason, and in practice the first thing anybody does
 * with a profit and loss is hold it against last year. Every figure here is
 * produced by `profitAndLoss` and `balanceSheet` for two spans rather than by a
 * second pass over the journal, so a comparative can never disagree with the
 * statement it is comparing.
 *
 * Four decisions carry this module.
 *
 *  - **The year-end close stays out of a profit and loss and stays in a balance
 *    sheet.** That is `removeYearEndClose`'s rule, and it matters more here than
 *    anywhere: a comparative column is almost always a year that has been
 *    closed. Closing debits every income account and credits every expense
 *    account to nothing, so a prior-year column built without that removal reads
 *    nil across the board — a business that traded two million looks like a
 *    business that traded nothing, and the movement column then reports the
 *    whole of this year as growth. Calling the statement functions rather than
 *    querying balances is what buys this.
 *
 *  - **A period with no comparative is a real state, not a column of zeros.** A
 *    business in its first year has nothing to compare with. Filling that column
 *    with nil says "a year of no trading", which is a different and false claim.
 *    So the comparative comes back absent, with a sentence saying why, and every
 *    prior figure is null rather than "0".
 *
 *  - **A movement in basis points needs a base.** Where the prior figure is nil
 *    the percentage is undefined — not infinite, not 100%. Where it is negative
 *    it is worse than undefined: it is misleading. A loss of a hundred becoming
 *    a loss of sixty is a movement of plus forty on a base of minus one hundred,
 *    which computes to minus forty per cent and reads as a deterioration when it
 *    is an improvement. Taking the base's magnitude instead — which is what the
 *    budget module does — is defensible there because a budget declares which
 *    direction is favourable for each section, so the sign can be read. A
 *    comparative declares nothing of the kind. So the rule here is: a percentage
 *    only against a strictly positive base, and otherwise null with the reason
 *    named. The movement in money is always given; it is never in doubt.
 *
 *  - **A ratio nobody can take apart is a ratio nobody will trust.** Every ratio
 *    carries its own numerator and denominator, labelled, so the answer can be
 *    checked rather than believed. The ratios the metrics module already
 *    computes are taken from it whole — this module never restates a formula
 *    that exists in `kpi.ts`, because two implementations of a margin will
 *    eventually give two margins.
 *
 * Money is BigInt minor units and crosses the wire as strings; rates are
 * integers in basis points. No floats anywhere on the path.
 */

/* ----------------------------------------------------------------- dates -- */

const DAY_MS = 86_400_000;
const ISO = (d: Date) => d.toISOString().slice(0, 10);

function asDate(value: string, what: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a valid date.`);
  return d;
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
const daysInclusive = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;

/**
 * The same day of the month `months` earlier, clamped to the end of the target
 * month. Without the clamp, 31 March a month back is 31 February, which the
 * Date constructor silently rolls forward to 3 March — a comparative that
 * overlaps the period it is being compared with, and nothing on screen to say
 * so. February is why this exists.
 */
function shiftMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const lastOfTarget = new Date(Date.UTC(y, m + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m + months, Math.min(d.getUTCDate(), lastOfTarget)));
}

/* ----------------------------------------------------------------- rates -- */

/**
 * A rate in basis points, rounded to the nearest and away from zero.
 *
 * Integer division truncates towards zero, which rounds a negative movement up
 * and a positive one down, so the same distance from the mark reads differently
 * in the two directions. A movement column is read by comparing those two
 * directions against each other, so that asymmetry is exactly the one this
 * module cannot have. Callers guarantee a non-zero denominator.
 */
function roundedBps(numerator: bigint, denominator: bigint): number {
  const n = numerator * 10_000n;
  const d = denominator < 0n ? -denominator : denominator;
  const signed = denominator < 0n ? -n : n;
  const half = d / 2n;
  return Number(signed >= 0n ? (signed + half) / d : -((-signed + half) / d));
}

/**
 * Exact integer division, floored towards negative infinity.
 *
 * `BigInt` division truncates towards zero, which would put a negative line's
 * remainder on the wrong side of the allocation below and let a column fail to
 * add up by one basis point in the one place a reader checks the arithmetic.
 */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b === 0n || a >= 0n === b >= 0n ? q : q - 1n;
}

/**
 * Proportions that add up to their own total — largest remainder.
 *
 * Rounding each line independently leaves a common-size column that does not
 * sum to the total printed under it. The reader who notices is the reader who
 * was checking, and what they conclude is that the report is wrong. So the
 * fractions are floored, and the shortfall against the target is handed out one
 * basis point at a time to the lines with the largest remainders — the standard
 * apportionment, and the only one that is both exact and stable.
 */
function allocate(parts: bigint[], base: bigint, target: number): number[] {
  if (parts.length === 0) return [];
  const scaled = parts.map((p) => p * 10_000n);
  const floors = scaled.map((s) => floorDiv(s, base));
  const remainders = scaled.map((s, i) => s - floors[i] * base);
  const order = parts
    .map((_, i) => i)
    .sort((a, b) => (remainders[a] === remainders[b] ? a - b : remainders[a] > remainders[b] ? -1 : 1));

  const out = floors.slice();
  let short = BigInt(target) - floors.reduce((a, b) => a + b, 0n);
  for (let i = 0; short > 0n && i < order.length; i++, short -= 1n) out[order[i]] += 1n;
  for (let i = order.length - 1; short < 0n && i >= 0; i--, short += 1n) out[order[i]] -= 1n;
  return out.map(Number);
}

/* ------------------------------------------------------------- movements -- */

/** Why a percentage is missing. Never guessed at, always one of these. */
export type MovementReason = "no_comparative" | "nil_base" | "negative_base";

export interface Movement {
  currentMinor: string;
  /** Null — never "0" — when there is no comparative period at all. */
  priorMinor: string | null;
  movementMinor: string | null;
  /** Null when the base is nil or negative; see the module note. */
  movementBps: number | null;
  reason: MovementReason | null;
}

function movement(current: bigint, prior: bigint | null): Movement {
  if (prior === null) {
    return {
      currentMinor: current.toString(),
      priorMinor: null,
      movementMinor: null,
      movementBps: null,
      reason: "no_comparative",
    };
  }
  const delta = current - prior;
  const undefinedBecause: MovementReason | null =
    prior === 0n ? "nil_base" : prior < 0n ? "negative_base" : null;
  return {
    currentMinor: current.toString(),
    priorMinor: prior.toString(),
    movementMinor: delta.toString(),
    movementBps: undefinedBecause === null ? roundedBps(delta, prior) : null,
    reason: undefinedBecause,
  };
}

/* ------------------------------------------------------------ comparison -- */

/** The immediately preceding span of the same length, the same dates a year earlier, or dates the caller names. */
export type PeriodComparison = "prior_period" | "prior_year" | { from: string; to: string };
/** As at a date: one month back, one year back, or a date the caller names. */
export type PointComparison = "prior_period" | "prior_year" | { asOf: string };
export type ComparisonKind = "prior_period" | "prior_year" | "explicit";

function priorSpan(from: Date, to: Date, against: PeriodComparison): { from: Date; to: Date; kind: ComparisonKind } {
  if (typeof against === "object") {
    const f = asDate(against.from, "The comparative period's start");
    const t = asDate(against.to, "The comparative period's end");
    if (t < f) throw new LedgerError("The comparative period ends before it starts.");
    return { from: f, to: t, kind: "explicit" };
  }
  if (against === "prior_year") {
    return { from: shiftMonths(from, -12), to: shiftMonths(to, -12), kind: "prior_year" };
  }
  // The immediately preceding span of the same length, counted in days rather
  // than months, so a comparative for an eleven-day period is eleven days and
  // not "last month".
  const end = addDays(from, -1);
  return { from: addDays(end, -(daysInclusive(from, to) - 1)), to: end, kind: "prior_period" };
}

/**
 * A balance sheet is a moment, so "the preceding span of the same length" means
 * nothing for one. The prior period is the same day one month back and the
 * prior year the same day twelve months back, both clamped to the month end —
 * which is what a monthly reporting cadence actually compares against.
 */
function priorPoint(asOf: Date, against: PointComparison): { asOf: Date; kind: ComparisonKind } {
  if (typeof against === "object") {
    return { asOf: asDate(against.asOf, "The comparative date"), kind: "explicit" };
  }
  return { asOf: shiftMonths(asOf, against === "prior_year" ? -12 : -1), kind: against };
}

/**
 * Whether there is anything at all to compare with.
 *
 * The test is the ledger's first posting. A business whose books open in
 * January 2026 has no 2025, and showing 2025 as a column of nil states that it
 * traded nothing that year — a claim about a year that did not happen. A
 * business that did exist and genuinely traded nothing is a different case, and
 * that one correctly shows nil: the books were open, the trading was not.
 */
async function comparativeAvailability(
  orgId: string,
  entityId: string,
  priorEnd: Date,
): Promise<{ available: boolean; reason: string | null }> {
  const first = await prisma.journalEntry.findFirst({
    where: { orgId, entityId, status: { in: ["posted", "reversed"] } },
    orderBy: { entryDate: "asc" },
    select: { entryDate: true },
  });
  if (!first) {
    return {
      available: false,
      reason: "These books hold no postings at all, so there is no earlier period to compare against.",
    };
  }
  if (first.entryDate > priorEnd) {
    return {
      available: false,
      reason:
        `The first posting in these books is dated ${ISO(first.entryDate)}, after ${ISO(priorEnd)}. ` +
        `The business did not exist over the comparative period, so there is nothing to compare with — ` +
        `a column of nil here would read as a year of no trading.`,
    };
  }
  return { available: true, reason: null };
}

/* ----------------------------------------------------- comparative shape -- */

export interface ComparativeLine extends Movement {
  code: string;
  name: string;
  nameAr: string | null;
}

export interface ComparativeSection extends Movement {
  key: string;
  label: string;
  lines: ComparativeLine[];
}

export interface ComparativeFigure extends Movement {
  key: string;
  label: string;
}

export interface MarginComparison {
  currentBps: number | null;
  priorBps: number | null;
  /**
   * The change in a margin is a difference in basis points, not a percentage
   * change of a percentage. Six per cent becoming nine is three points, and
   * calling it "fifty per cent" would be true of the ratio and useless about
   * the business.
   */
  movementBpsPoints: number | null;
}

export interface ComparativeProfitAndLoss {
  entityId: string;
  currency: string;
  against: ComparisonKind;
  current: { from: string; to: string };
  prior: { from: string; to: string } | null;
  comparativeAbsent: boolean;
  absenceReason: string | null;
  revenue: ComparativeSection;
  costOfSales: ComparativeSection;
  expenses: ComparativeSection;
  grossProfit: ComparativeFigure;
  netProfit: ComparativeFigure;
  grossMargin: MarginComparison;
}

export interface ComparativeBalanceSheet {
  entityId: string;
  currency: string;
  against: ComparisonKind;
  current: { asOf: string };
  prior: { asOf: string } | null;
  comparativeAbsent: boolean;
  absenceReason: string | null;
  assets: ComparativeSection;
  liabilities: ComparativeSection;
  equity: ComparativeSection;
  totalAssets: ComparativeFigure;
  totalLiabilitiesAndEquity: ComparativeFigure;
  currentYearEarnings: ComparativeFigure;
  /** Both columns are checked. A comparative that does not balance is still worth showing, with the fact stated. */
  balanced: { current: boolean; prior: boolean | null };
}

/** The chart's own ordering: "4100" sorts after "999", not before it. */
const cmpCode = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function pairSection(current: StatementSection, prior: StatementSection | null): ComparativeSection {
  const cur = new Map(current.lines.map((l) => [l.code, l]));
  const pri = new Map((prior?.lines ?? []).map((l) => [l.code, l]));
  const codes = [...new Set([...cur.keys(), ...pri.keys()])].sort(cmpCode);

  const lines = codes.map((code): ComparativeLine => {
    const c = cur.get(code);
    const p = pri.get(code);
    const named = c ?? p!;
    return {
      code,
      name: named.name,
      nameAr: named.nameAr,
      // An account missing from one column had a nil balance in that period:
      // the books were open, the account did not move. That is a real zero and
      // is quite different from the null an absent comparative carries.
      ...movement(
        BigInt(c?.presentedMinor ?? "0"),
        prior === null ? null : BigInt(p?.presentedMinor ?? "0"),
      ),
    };
  });

  return {
    key: current.key,
    label: current.label,
    lines,
    ...movement(BigInt(current.totalMinor), prior === null ? null : BigInt(prior.totalMinor)),
  };
}

const figure = (key: string, label: string, current: bigint, prior: bigint | null): ComparativeFigure => ({
  key,
  label,
  ...movement(current, prior),
});

export async function comparativeProfitAndLoss(opts: {
  orgId: string;
  entityId: string;
  from: string;
  to: string;
  against?: PeriodComparison;
}): Promise<ComparativeProfitAndLoss> {
  const from = asDate(opts.from, "The period start");
  const to = asDate(opts.to, "The period end");
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const prior = priorSpan(from, to, opts.against ?? "prior_year");
  const availability = await comparativeAvailability(opts.orgId, opts.entityId, prior.to);

  // Both columns come from `profitAndLoss`, which is what knows to take the
  // year-end close back out. A comparative column is almost always a closed
  // year, so this is the difference between last year's trading and a column
  // of nil.
  const [current, priorPl] = await Promise.all([
    profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from: opts.from, to: opts.to }),
    availability.available
      ? profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from: ISO(prior.from), to: ISO(prior.to) })
      : Promise.resolve(null),
  ]);

  const priorGross = priorPl === null ? null : BigInt(priorPl.grossProfitMinor);
  const priorNet = priorPl === null ? null : BigInt(priorPl.netProfitMinor);
  const priorMarginBps = priorPl?.grossMarginBps ?? null;

  return {
    entityId: opts.entityId,
    currency: current.currency,
    against: prior.kind,
    current: { from: opts.from, to: opts.to },
    prior: priorPl === null ? null : { from: ISO(prior.from), to: ISO(prior.to) },
    comparativeAbsent: priorPl === null,
    absenceReason: availability.reason,
    revenue: pairSection(current.revenue, priorPl?.revenue ?? null),
    costOfSales: pairSection(current.costOfSales, priorPl?.costOfSales ?? null),
    expenses: pairSection(current.expenses, priorPl?.expenses ?? null),
    grossProfit: figure("gross_profit", "Gross profit", BigInt(current.grossProfitMinor), priorGross),
    netProfit: figure("net_profit", "Net profit", BigInt(current.netProfitMinor), priorNet),
    grossMargin: {
      currentBps: current.grossMarginBps,
      priorBps: priorMarginBps,
      movementBpsPoints:
        current.grossMarginBps === null || priorMarginBps === null
          ? null
          : current.grossMarginBps - priorMarginBps,
    },
  };
}

export async function comparativeBalanceSheet(opts: {
  orgId: string;
  entityId: string;
  asOf: string;
  against?: PointComparison;
}): Promise<ComparativeBalanceSheet> {
  const asOf = asDate(opts.asOf, "The date this balance sheet is drawn to");
  const prior = priorPoint(asOf, opts.against ?? "prior_year");
  const availability = await comparativeAvailability(opts.orgId, opts.entityId, prior.asOf);

  const [current, priorBs] = await Promise.all([
    balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: opts.asOf }),
    availability.available
      ? balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: ISO(prior.asOf) })
      : Promise.resolve(null),
  ]);

  const priorTotal = (pick: (b: NonNullable<typeof priorBs>) => string) =>
    priorBs === null ? null : BigInt(pick(priorBs));

  return {
    entityId: opts.entityId,
    currency: current.currency,
    against: prior.kind,
    current: { asOf: opts.asOf },
    prior: priorBs === null ? null : { asOf: ISO(prior.asOf) },
    comparativeAbsent: priorBs === null,
    absenceReason: availability.reason,
    assets: pairSection(current.assets, priorBs?.assets ?? null),
    liabilities: pairSection(current.liabilities, priorBs?.liabilities ?? null),
    equity: pairSection(current.equity, priorBs?.equity ?? null),
    totalAssets: figure(
      "total_assets",
      "Total assets",
      BigInt(current.totalAssetsMinor),
      priorTotal((b) => b.totalAssetsMinor),
    ),
    totalLiabilitiesAndEquity: figure(
      "total_liabilities_and_equity",
      "Liabilities and equity",
      BigInt(current.totalLiabilitiesAndEquityMinor),
      priorTotal((b) => b.totalLiabilitiesAndEquityMinor),
    ),
    currentYearEarnings: figure(
      "current_year_earnings",
      "Current year earnings",
      BigInt(current.currentYearEarningsMinor),
      priorTotal((b) => b.currentYearEarningsMinor),
    ),
    balanced: { current: current.balanced, prior: priorBs === null ? null : priorBs.balanced },
  };
}

/* ----------------------------------------------------------- common size -- */

export interface CommonSizeLine {
  code: string;
  name: string;
  nameAr: string | null;
  amountMinor: string;
  bps: number | null;
}

export interface CommonSizeSection {
  key: string;
  label: string;
  lines: CommonSizeLine[];
  totalMinor: string;
  totalBps: number | null;
}

export interface CommonSizeStatement {
  baseKey: string;
  baseLabel: string;
  baseMinor: string;
  /** False when the base is nil or negative — there is nothing to take a proportion of. */
  computable: boolean;
  note: string | null;
  sections: CommonSizeSection[];
  /** Derived lines that are not a section: gross profit, net profit, the sheet's own total. */
  memos: { key: string; label: string; amountMinor: string; bps: number | null }[];
}

export interface CommonSize {
  entityId: string;
  from: string;
  to: string;
  currency: string;
  profitAndLoss: CommonSizeStatement;
  balanceSheet: CommonSizeStatement;
}

/**
 * Sections sized against a base.
 *
 * A `group` is a set of sections that together equal the base — the asset
 * sections against total assets, the liability and equity sections against the
 * same. Those are allocated together so the group comes to ten thousand basis
 * points exactly. A group of one is just that section rounded, which is what
 * cost of sales against revenue should be: it has no reason to come to any
 * particular figure.
 */
function sizeSections(base: bigint, groups: StatementSection[][]): CommonSizeSection[] {
  const out: CommonSizeSection[] = [];
  for (const group of groups) {
    const totals = group.map((s) => BigInt(s.totalMinor));
    const target = roundedBps(totals.reduce((a, b) => a + b, 0n), base);
    const sectionBps = allocate(totals, base, target);
    group.forEach((s, i) => {
      const parts = s.lines.map((l) => BigInt(l.presentedMinor));
      const lineBps = allocate(parts, base, sectionBps[i]);
      out.push({
        key: s.key,
        label: s.label,
        lines: s.lines.map((l, j) => ({
          code: l.code,
          name: l.name,
          nameAr: l.nameAr,
          amountMinor: l.presentedMinor,
          bps: lineBps[j],
        })),
        totalMinor: s.totalMinor,
        totalBps: sectionBps[i],
      });
    });
  }
  return out;
}

/** The same sections with every proportion withheld, for a base there is no proportion of. */
function unsizedSections(groups: StatementSection[][]): CommonSizeSection[] {
  return groups.flat().map((s) => ({
    key: s.key,
    label: s.label,
    lines: s.lines.map((l) => ({
      code: l.code,
      name: l.name,
      nameAr: l.nameAr,
      amountMinor: l.presentedMinor,
      bps: null,
    })),
    totalMinor: s.totalMinor,
    totalBps: null,
  }));
}

/**
 * Every line as a proportion of its statement's base, in basis points.
 *
 * This is what makes two businesses of different sizes comparable, and what
 * makes one business comparable with itself after it has doubled: rent at four
 * per cent of revenue means something in both years, where rent at 300,000
 * means something only against a revenue figure the reader has to hold in their
 * head.
 *
 * The base is revenue for the profit and loss and total assets for the balance
 * sheet, and a base that is nil or negative yields no proportions at all. There
 * is no proportion of nothing, and a proportion of a negative base has the sign
 * trap the module note describes.
 */
export async function commonSize(opts: {
  orgId: string;
  entityId: string;
  from: string;
  to: string;
}): Promise<CommonSize> {
  const from = asDate(opts.from, "The period start");
  const to = asDate(opts.to, "The period end");
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const [pl, bs] = await Promise.all([
    profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from: opts.from, to: opts.to }),
    balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: opts.to }),
  ]);

  const revenue = BigInt(pl.revenue.totalMinor);
  const totalAssets = BigInt(bs.totalAssetsMinor);

  const plGroups = [[pl.revenue], [pl.costOfSales], [pl.expenses]];
  const bsGroups = [[bs.assets], [bs.liabilities, bs.equity]];

  const memo = (key: string, label: string, amount: bigint, base: bigint) => ({
    key,
    label,
    amountMinor: amount.toString(),
    bps: base > 0n ? roundedBps(amount, base) : null,
  });

  return {
    entityId: opts.entityId,
    from: opts.from,
    to: opts.to,
    currency: pl.currency,
    profitAndLoss: {
      baseKey: "revenue",
      baseLabel: "Revenue",
      baseMinor: revenue.toString(),
      computable: revenue > 0n,
      note:
        revenue > 0n
          ? null
          : revenue === 0n
            ? "There was no revenue in this period, so there is nothing to express these figures as a proportion of. That is not a set of proportions of nil."
            : "Revenue for this period is negative, most likely because returns and allowances exceeded sales. A proportion of a negative base reverses its own sign, so none is given.",
      sections: revenue > 0n ? sizeSections(revenue, plGroups) : unsizedSections(plGroups),
      memos: [
        memo("gross_profit", "Gross profit", BigInt(pl.grossProfitMinor), revenue),
        memo("net_profit", "Net profit", BigInt(pl.netProfitMinor), revenue),
      ],
    },
    balanceSheet: {
      baseKey: "total_assets",
      baseLabel: "Total assets",
      baseMinor: totalAssets.toString(),
      computable: totalAssets > 0n,
      note:
        totalAssets > 0n
          ? null
          : totalAssets === 0n
            ? "This entity holds no assets at this date, so there is nothing to express the sheet as a proportion of."
            : "Total assets at this date are negative, so a proportion of them would reverse its own sign. None is given.",
      sections: totalAssets > 0n ? sizeSections(totalAssets, bsGroups) : unsizedSections(bsGroups),
      memos: [
        memo("current_year_earnings", "Current year earnings", BigInt(bs.currentYearEarningsMinor), totalAssets),
        memo(
          "total_liabilities_and_equity",
          "Liabilities and equity",
          BigInt(bs.totalLiabilitiesAndEquityMinor),
          totalAssets,
        ),
      ],
    },
  };
}

/* ---------------------------------------------------------------- ratios -- */

export type RatioUnit = "PERCENT" | "TIMES" | "DAYS";

export interface RatioTerm {
  label: string;
  /** Minor units for MONEY, ten-thousandths of a day for DAYS. Null only when the term is itself undefined. */
  value: string | null;
  unit: "MONEY" | "DAYS";
}

export interface Ratio {
  key: string;
  label: string;
  unit: RatioUnit;
  /** ×10,000: basis points for PERCENT and TIMES, ten-thousandths of a day for DAYS. Null when undefined. */
  valueBps: number | null;
  /** How the two terms combine. Everything is a quotient except the cash conversion cycle, which is a difference. */
  op: "divide" | "less";
  numerator: RatioTerm;
  denominator: RatioTerm;
  /** Applied after the division — the day count in a turnover ratio, 1 in everything else. */
  factor: number;
  basis: string;
  computable: boolean;
  /** Why there is no answer. Null when there is one. */
  undefinedReason: string | null;
  interpretation: string;
}

export interface Ratios {
  entityId: string;
  asOf: string;
  /** The span the flow figures are measured over — a ratio of a stock to a flow needs both. */
  from: string;
  days: number;
  currency: string;
  ratios: Ratio[];
  warnings: string[];
}

/** Interest and finance costs, and the two tax lines that sit below the operating result. */
const FINANCE_COST = "6360";
const TAX_CODES = ["7000", "7010"];

const lineAmount = (section: StatementSection, codes: string[]): bigint =>
  section.lines.filter((l) => codes.includes(l.code)).reduce((a, l) => a + BigInt(l.presentedMinor), 0n);

/**
 * A ratio in basis points, rounded half away from zero.
 *
 * This used to truncate, to stay comparable with the metrics module, which
 * truncated too. Both now round, so the set is internally consistent and also
 * agrees with the statements: on the same figures a gross margin of 66.665%
 * is 6667 everywhere in the product rather than 6667 on one screen and 6666
 * on another.
 */
const bpsOf = (numerator: bigint, denominator: bigint): number | null =>
  denominator === 0n ? null : roundedBps(numerator, denominator);

function inputOf(kpi: Kpi, label: string): bigint {
  const hit = kpi.inputs.find((i) => i.label === label);
  if (!hit) {
    throw new LedgerError(
      `The ${kpi.label} figure no longer carries an input named "${label}", so its numerator and denominator ` +
        `cannot be shown. Please report it — a ratio nobody can take apart should not be displayed at all.`,
    );
  }
  return BigInt(hit.amountMinor);
}

/**
 * A ratio the metrics module already computes, restated only in shape.
 *
 * The value, the words and the basis all come from `kpi.ts`; what is added here
 * is the numerator and the denominator as separate named terms, pulled out of
 * that module's own inputs. Two implementations of a margin eventually give two
 * margins, so there is exactly one.
 */
function fromKpi(
  kpi: Kpi,
  spec: { key: string; label?: string; numerator: string; denominator: string; factor?: number },
): Ratio {
  const numerator = inputOf(kpi, spec.numerator);
  const denominator = inputOf(kpi, spec.denominator);
  return {
    key: spec.key,
    label: spec.label ?? kpi.label,
    unit: kpi.unit === "MONEY" ? "TIMES" : kpi.unit,
    valueBps: kpi.valueBps === null ? null : Number(kpi.valueBps),
    op: "divide",
    numerator: { label: spec.numerator, value: numerator.toString(), unit: "MONEY" },
    denominator: { label: spec.denominator, value: denominator.toString(), unit: "MONEY" },
    factor: spec.factor ?? 1,
    basis: kpi.basis,
    computable: kpi.computable,
    undefinedReason: kpi.computable
      ? null
      : `${spec.denominator} is nil, so this ratio is undefined rather than zero.`,
    interpretation: kpi.interpretation,
  };
}

/**
 * The ratios an accountant actually uses, each showing what it was computed
 * from.
 *
 * A balance sheet ratio is a moment and a profit-and-loss ratio is a period, and
 * the turnover ratios are a stock over a flow, so this needs both. `from`
 * defaults to the twelve months ending at `asOf`: a day count taken over an
 * arbitrary window is a day count nobody can read, and twelve months is the
 * span that makes "receivable days" mean days.
 */
export async function ratios(opts: {
  orgId: string;
  entityId: string;
  asOf: string;
  /** Overrides the trailing twelve months the flow figures are measured over. */
  from?: string;
}): Promise<Ratios> {
  const asOf = asDate(opts.asOf, "The date these ratios are drawn to");
  const from = opts.from ?? ISO(addDays(shiftMonths(asOf, -12), 1));
  if (asDate(from, "The period start") > asOf) throw new LedgerError("The period ends before it starts.");

  const [kpi, bs, pl] = await Promise.all([
    financialKpis({ orgId: opts.orgId, entityId: opts.entityId, from, to: opts.asOf }),
    balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: opts.asOf }),
    profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from, to: opts.asOf }),
  ]);

  const byKey = new Map(kpi.kpis.map((k) => [k.key, k]));
  const required = (key: string): Kpi => {
    const k = byKey.get(key);
    if (!k) {
      throw new LedgerError(
        `The metrics module no longer produces "${key}", which this report is built on. Please report it.`,
      );
    }
    return k;
  };

  const currentRatio = required("current_ratio");
  const currentLiabilities = inputOf(currentRatio, "Current liabilities");
  const totalAssets = BigInt(bs.totalAssetsMinor);

  // Interest cover and return on capital employed are both taken on profit
  // before interest and tax. That is the point of each: how the operation does
  // before the cost of the money funding it and before the state's share,
  // neither of which the operation itself controls. Net profit is after both,
  // so both are added back.
  const interest = lineAmount(pl.expenses, [FINANCE_COST]);
  const tax = lineAmount(pl.expenses, TAX_CODES);
  const ebit = BigInt(pl.netProfitMinor) + interest + tax;

  // Capital employed is everything the business has less what falls due within
  // the year: the money actually tied up in it for the long run. Current
  // liabilities come from the metrics module's own classification rather than a
  // second reading of the chart, so this ratio inherits its warnings about
  // accounts it could not classify instead of quietly disagreeing with it.
  const capitalEmployed = totalAssets - currentLiabilities;

  const interestCoverBps = bpsOf(ebit, interest);
  const interestCover: Ratio = {
    key: "interest_cover",
    label: "Interest cover",
    unit: "TIMES",
    valueBps: interestCoverBps,
    op: "divide",
    numerator: { label: "Profit before interest and tax", value: ebit.toString(), unit: "MONEY" },
    denominator: { label: "Interest and finance costs", value: interest.toString(), unit: "MONEY" },
    factor: 1,
    basis: "Profit before interest and tax ÷ interest and finance costs",
    computable: interestCoverBps !== null,
    undefinedReason:
      interestCoverBps === null ? "No interest was charged in this period, so there is nothing to cover." : null,
    interpretation:
      interestCoverBps === null
        ? "Interest cover cannot be calculated because no interest or finance cost was charged in this period. A business with no borrowing cost has nothing to cover — that is a strong position, not a cover of zero."
        : ebit < 0n
          ? `The operation lost money before interest was even charged, so the interest is not covered at all. The figure to act on is the loss, not the multiple.`
          : `Operating profit covers the period's interest ${asTimes(BigInt(interestCoverBps))} times over. Lenders read this before they read the margin: below about 2.00 a modest fall in trading stops the interest being payable out of trading.`,
  };

  const roceBps = bpsOf(ebit, capitalEmployed);
  const roce: Ratio = {
    key: "return_on_capital_employed",
    label: "Return on capital employed",
    unit: "PERCENT",
    valueBps: roceBps,
    op: "divide",
    numerator: { label: "Profit before interest and tax", value: ebit.toString(), unit: "MONEY" },
    denominator: { label: "Capital employed", value: capitalEmployed.toString(), unit: "MONEY" },
    factor: 1,
    basis: "Profit before interest and tax ÷ (total assets − current liabilities)",
    computable: roceBps !== null,
    undefinedReason:
      roceBps === null
        ? "Total assets equal current liabilities at this date, so there is no capital employed to earn a return on."
        : null,
    interpretation:
      roceBps === null
        ? "Return on capital employed cannot be calculated because capital employed is nil at this date: everything the business holds falls due within the year. A return needs something to be a return on."
        : capitalEmployed < 0n
          ? "Capital employed is negative at this date — what falls due within the year exceeds everything the business holds — so this percentage cannot be read as a return. The deficit is the figure that matters."
          : `The business earned ${asPercent(BigInt(roceBps))} on the capital tied up in it, before interest and tax. This is the figure to hold against what the same money would earn if it were lent out instead.`,
  };

  const receivableDays = required("days_sales_outstanding");
  const payableDays = required("days_payable_outstanding");
  const inventoryDays = required("days_inventory");

  // The cash conversion cycle is the one figure here that is a difference
  // rather than a quotient: days of stock plus days of credit given, less days
  // of credit taken. It is null the moment any of the three is, because a cycle
  // computed from two of its three legs is not a shorter cycle — it is a
  // different measurement wearing the same name.
  const tiedUp =
    receivableDays.valueBps === null || inventoryDays.valueBps === null
      ? null
      : receivableDays.valueBps + inventoryDays.valueBps;
  const cycle = tiedUp === null || payableDays.valueBps === null ? null : tiedUp - payableDays.valueBps;

  const cashConversion: Ratio = {
    key: "cash_conversion_cycle",
    label: "Cash conversion cycle",
    unit: "DAYS",
    valueBps: cycle === null ? null : Number(cycle),
    op: "less",
    numerator: {
      label: "Receivable days plus inventory days",
      value: tiedUp === null ? null : tiedUp.toString(),
      unit: "DAYS",
    },
    denominator: {
      label: "Payable days",
      value: payableDays.valueBps === null ? null : payableDays.valueBps.toString(),
      unit: "DAYS",
    },
    factor: 1,
    basis: "Receivable days + inventory days − payable days",
    computable: cycle !== null,
    undefinedReason:
      cycle === null
        ? "One of the three day counts it is built from is itself undefined, so the cycle cannot be stated."
        : null,
    interpretation:
      cycle === null
        ? "The cash conversion cycle cannot be calculated because one of the three day counts behind it has no denominator — no revenue, or nothing charged to cost of sales. A cycle computed from two of its three legs would be a different measurement under the same name."
        : cycle < 0n
          ? `The business is paid before it pays: the cycle is ${asTimes(-cycle)} days the other way. Suppliers are funding the trading, which is the strongest working-capital position there is and the one most easily lost by paying early.`
          : `Cash is tied up for about ${asTimes(cycle)} days between paying for stock and being paid for it. Every day taken off this is a day of borrowing the business does not need.`,
  };

  return {
    entityId: opts.entityId,
    asOf: opts.asOf,
    from,
    days: kpi.days,
    currency: kpi.currency,
    ratios: [
      fromKpi(currentRatio, { key: "current", label: "Current ratio", numerator: "Current assets", denominator: "Current liabilities" }),
      fromKpi(required("quick_ratio"), { key: "quick", label: "Quick ratio", numerator: "Quick assets", denominator: "Current liabilities" }),
      fromKpi(required("debt_to_equity"), { key: "gearing", label: "Gearing", numerator: "Total liabilities", denominator: "Total equity" }),
      interestCover,
      fromKpi(required("gross_margin"), { key: "gross_margin", numerator: "Gross profit", denominator: "Revenue" }),
      fromKpi(required("net_margin"), { key: "net_margin", numerator: "Net profit", denominator: "Revenue" }),
      roce,
      fromKpi(receivableDays, { key: "receivable_days", label: "Receivable days", numerator: "Receivables outstanding", denominator: "Revenue", factor: kpi.days }),
      fromKpi(payableDays, { key: "payable_days", label: "Payable days", numerator: "Payables outstanding", denominator: "Cost of sales", factor: kpi.days }),
      fromKpi(inventoryDays, { key: "inventory_days", label: "Inventory days", numerator: "Average inventory", denominator: "Cost of sales", factor: kpi.days }),
      cashConversion,
    ],
    warnings: kpi.warnings,
  };
}

/* ----------------------------------------------------------------- trend -- */

export interface TrendMonth {
  /** "2027-03". */
  month: string;
  from: string;
  to: string;
  /** True on a month cut short by the report's own end date, so a half month is not read as a collapse. */
  partial: boolean;
  revenueMinor: string;
  grossProfitMinor: string;
  netProfitMinor: string;
  /** Cash and bank as at the month end — the figure a trend of profit alone will not show you. */
  cashMinor: string;
  revenueMovementMinor: string | null;
  revenueMovementBps: number | null;
  revenueMovementReason: MovementReason | null;
}

export interface Trend {
  entityId: string;
  currency: string;
  from: string;
  to: string;
  months: TrendMonth[];
}

/**
 * Revenue, gross profit, net profit and cash, month by month.
 *
 * Two statements a year say whether the business made money; a monthly series
 * says whether it is still making it. A business that is quietly shrinking
 * looks healthy in every annual figure it produces right up until the year it
 * does not, and this is the shape that shows it earlier.
 *
 * Cash is in the series deliberately. Profit and cash come apart exactly when it
 * matters most — a growing business funding its own growth out of working
 * capital is profitable and running out of money at the same time — so a trend
 * of profit alone is the one that reassures people on their way into trouble.
 */
export async function trend(opts: {
  orgId: string;
  entityId: string;
  months?: number;
  /** The last month is the one containing this date. Defaults to today. */
  to?: string;
}): Promise<Trend> {
  const to = opts.to ? asDate(opts.to, "The date this trend runs to") : new Date();
  const count = opts.months ?? 12;
  if (!Number.isInteger(count) || count < 1 || count > 60) {
    throw new LedgerError("A trend covers between 1 and 60 months. Ask for fewer, or read the statements instead.");
  }

  const y = to.getUTCFullYear();
  const m = to.getUTCMonth();
  const spans = Array.from({ length: count }, (_, i) => {
    const offset = i - (count - 1);
    const start = new Date(Date.UTC(y, m + offset, 1));
    const monthEnd = new Date(Date.UTC(y, m + offset + 1, 0));
    const end = monthEnd > to ? to : monthEnd;
    return { start, end, partial: end < monthEnd };
  });

  // Read once for the whole series rather than once per month: the chart does
  // not change between January and December of the same run.
  const cashList = new Set(await cashCodes({ orgId: opts.orgId, entityId: opts.entityId }));

  const rows = await Promise.all(
    spans.map(async (span) => {
      const [pl, cash] = await Promise.all([
        profitAndLoss({
          orgId: opts.orgId,
          entityId: opts.entityId,
          from: ISO(span.start),
          to: ISO(span.end),
        }),
        // Cash is a balance at a moment, not a movement over the month, so it
        // comes from `balances` at the month end rather than from the period's
        // own postings. What counts as cash is derived from the chart by the
        // one helper every module uses, so the trend line and the cash flow
        // statement cannot disagree about it.
        balances({ orgId: opts.orgId, entityId: opts.entityId, to: span.end }),
      ]);
      const cashMinor = cash.rows
        .filter((r) => cashList.has(r.code))
        .reduce((a, r) => a + r.balance, 0n);
      return { span, pl, cashMinor };
    }),
  );

  const months = rows.map((row, i): TrendMonth => {
    const revenue = BigInt(row.pl.revenue.totalMinor);
    const previous = i === 0 ? null : BigInt(rows[i - 1].pl.revenue.totalMinor);
    const move = movement(revenue, previous);
    return {
      month: ISO(row.span.start).slice(0, 7),
      from: ISO(row.span.start),
      to: ISO(row.span.end),
      partial: row.span.partial,
      revenueMinor: revenue.toString(),
      grossProfitMinor: row.pl.grossProfitMinor,
      netProfitMinor: row.pl.netProfitMinor,
      cashMinor: row.cashMinor.toString(),
      revenueMovementMinor: move.movementMinor,
      revenueMovementBps: move.movementBps,
      revenueMovementReason: move.reason,
    };
  });

  return {
    entityId: opts.entityId,
    currency: rows[0]?.pl.currency ?? "AED",
    from: months[0]?.from ?? ISO(to),
    to: months[months.length - 1]?.to ?? ISO(to),
    months,
  };
}

/* ---------------------------------------------------------------- layout -- */

export interface ComparativeLayoutRow {
  key: string | null;
  label: string;
  kind: RowKind;
  bold: boolean;
  codes: string[];
  /** Null on a heading or a spacer, which render no figure. */
  figures: Movement | null;
}

export interface ComparativeLayoutReport {
  code: string;
  name: string;
  basis: "BALANCE" | "PROFIT";
  currency: string;
  against: ComparisonKind;
  current: { from: string | null; to: string };
  prior: { from: string | null; to: string } | null;
  comparativeAbsent: boolean;
  absenceReason: string | null;
  rows: ComparativeLayoutRow[];
  /** The current column's coverage. An uncovered account misstates both columns the same way. */
  coverage: Coverage;
  warnings: string[];
}

/**
 * A saved layout, drawn twice.
 *
 * A business that has defined its own management pack wants last year in it too,
 * and the alternative to this is a second renderer that reads the same layout
 * and eventually disagrees with the first about what a row means. So the layout
 * renderer is called twice and the two row lists are paired by position — they
 * come from the same definition, so position is exact, and a key is optional in
 * the row language.
 */
export async function comparativeLayout(opts: {
  orgId: string;
  entityId: string;
  code?: string;
  layout?: LayoutInput;
  /** Required for a PROFIT layout, meaningless for a BALANCE one. */
  from?: string;
  to: string;
  against?: PeriodComparison;
}): Promise<ComparativeLayoutReport> {
  const to = asDate(opts.to, "The date this report is drawn to");
  const against = opts.against ?? "prior_year";

  let priorFrom: Date | null = null;
  let priorTo: Date;
  let kind: ComparisonKind;
  if (opts.from) {
    const from = asDate(opts.from, "The date this report runs from");
    if (to < from) throw new LedgerError("The period ends before it starts.");
    const span = priorSpan(from, to, against);
    priorFrom = span.from;
    priorTo = span.to;
    kind = span.kind;
  } else {
    // A balance layout reads to a moment, so an explicit comparative period is
    // taken at its end rather than refused: the caller asked for a span and a
    // sheet can only answer at one end of it.
    const point = priorPoint(to, typeof against === "object" ? { asOf: against.to } : against);
    priorTo = point.asOf;
    kind = point.kind;
  }

  const availability = await comparativeAvailability(opts.orgId, opts.entityId, priorTo);

  const [current, prior] = await Promise.all([
    renderLayout({ orgId: opts.orgId, entityId: opts.entityId, code: opts.code, layout: opts.layout, from: opts.from, to: opts.to }),
    availability.available
      ? renderLayout({
          orgId: opts.orgId,
          entityId: opts.entityId,
          code: opts.code,
          layout: opts.layout,
          ...(priorFrom ? { from: ISO(priorFrom) } : {}),
          to: ISO(priorTo),
        })
      : Promise.resolve(null),
  ]);

  if (prior && prior.rows.length !== current.rows.length) {
    throw new LedgerError(
      "The two columns of this report were drawn from different row lists, so they cannot be set side by side. Please report it.",
    );
  }

  const rows = current.rows.map((row, i): ComparativeLayoutRow => {
    const other = prior?.rows[i] ?? null;
    return {
      key: row.key,
      label: row.label,
      kind: row.kind,
      bold: row.bold,
      codes: row.codes,
      figures:
        row.valueMinor === null
          ? null
          : movement(BigInt(row.valueMinor), prior === null ? null : BigInt(other?.valueMinor ?? "0")),
    };
  });

  return {
    code: current.code,
    name: current.name,
    basis: current.basis,
    currency: current.currency,
    against: kind,
    current: { from: current.from, to: current.to },
    prior: prior === null ? null : { from: prior.from, to: prior.to },
    comparativeAbsent: prior === null,
    absenceReason: availability.reason,
    rows,
    coverage: current.coverage,
    warnings: [
      ...current.warnings,
      ...(prior?.warnings ?? []).map((w) => `Comparative column: ${w}`),
    ],
  };
}
