import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { UNALLOCATED, dimensionalProfitAndLoss, listDimensions } from "./dimensions";
import { balanceSheet, profitAndLoss } from "./statements";

/**
 * Segment reporting — IFRS 8, Operating Segments.
 *
 * ── What this module is, and what it is built on ────────────────────────────
 * A segment is not a new thing the ledger has to learn. It is a dimension the
 * product already records on journal lines: a cost centre, a branch, a project.
 * So there is no schema here and no second attribution path — every profit and
 * loss figure below comes from one call to dimensionalProfitAndLoss(), which
 * sums JournalLineDimension rows and already proves its columns add back to the
 * entity's own statement. A segment note derived a second way would eventually
 * disagree with the cost-centre report over the same postings, and then neither
 * could be believed.
 *
 * ── The management approach, and the judgement we cannot make ───────────────
 * IFRS 8.5 defines an operating segment by who looks at it: a component whose
 * operating results are regularly reviewed by the chief operating decision
 * maker to allocate resources and assess performance. Nothing in a ledger knows
 * that. What the caller names — the dimension — stands in for that judgement,
 * and the judgement stays with the people making it. Likewise IFRS 8.12's
 * aggregation criteria: two segments with similar economic characteristics may
 * be aggregated, and only a human can say they are similar. This module does
 * not aggregate on similarity; the only aggregation it performs is IFRS 8.16's
 * "all other segments", which is arithmetic, not judgement.
 *
 * IFRS 8.25 asks that the amounts reported be the measures reported to the
 * chief operating decision maker. What is reported here is the entity's own
 * measure — revenue less cost of sales less operating expenses, on exactly the
 * definitions statements.ts uses — because that is the only measure the ledger
 * holds. If the board reads a different one, this report is a starting point
 * for the note, not the note.
 *
 * ── The column that makes the rest of it honest ─────────────────────────────
 * "Not allocated" is a column, always, even at nil. Every ledger has postings
 * nobody coded to a segment, and a segment report that hides them is a report
 * whose columns do not add to the business. It is never folded into the largest
 * segment and never spread pro rata: an honest "we do not know where this
 * belongs" is worth more than a set of plausible per-segment margins that are
 * all slightly wrong. Its key is dimensions.ts's UNALLOCATED, deliberately and
 * exactly — the same residual bucket, relabelled for this screen — so a segment
 * figure and a cost-centre figure can never disagree about what was left
 * uncoded.
 *
 * Note what it is *not*: it is not an operating segment. It has no manager and
 * no discrete financial information (IFRS 8.5), so it is excluded from the
 * combined totals the 10% thresholds are measured against and can never be
 * "reportable". It is the reconciling item IFRS 8.28 requires, and it is
 * presented as one.
 *
 * ── The reconciliation IFRS 8.28 requires ───────────────────────────────────
 * Segment revenue, segment result, segment assets and segment liabilities must
 * each reconcile to the entity's corresponding amount. Every figure below is
 * checked against profitAndLoss() and balanceSheet() for the same dates, the
 * difference is returned rather than absorbed, and a non-zero difference is a
 * defect the screen has to say out loud. A dimensional report that does not add
 * up to the real one is worse than no report at all, because people act on it.
 *
 * ── Deliberately out of scope, and worth naming ─────────────────────────────
 *  - Entity-wide disclosures (IFRS 8.31-34): revenue by product and service, by
 *    geography, non-current assets by country, and the major-customer note at
 *    IFRS 8.34. None of them can be derived from a journal line, which records
 *    no country and no counterparty on the line itself.
 *  - Intersegment revenue and the elimination of it (IFRS 8.23(b), 8.28(a)).
 *    A posting carries one segment, not two, so nothing in the ledger says that
 *    one segment sold to another. Segment revenue here is therefore revenue as
 *    posted, with no intersegment column and no elimination row.
 *  - Segment liabilities are reported only because the ledger can attribute
 *    them; IFRS 8.23 requires them only when they are regularly provided to the
 *    chief operating decision maker.
 *
 * Money is BigInt minor units throughout and every share is basis points held
 * in BigInt. No float touches any of it.
 */

/* --------------------------------------------------------------- vocabulary */

/** The column for postings carrying no value for the dimension. */
export const NOT_ALLOCATED = UNALLOCATED;
const NOT_ALLOCATED_LABEL = "Not allocated";

/**
 * The IFRS 8.16 aggregate: segments below every threshold, combined.
 *
 * The hyphen is load-bearing. A dimension value code is letters, digits and
 * underscores (see normaliseCode in dimensions.ts), so no real segment can ever
 * be coded this and collide with the aggregate — the clash is impossible by
 * construction rather than guarded against at runtime and forgotten.
 */
export const OTHER_SEGMENTS = "OTHER-SEGMENTS";
const OTHER_SEGMENTS_LABEL = "Other segments";

/** IFRS 8.19: beyond ten reportable segments, consider whether a practical limit is reached. */
const PRACTICAL_LIMIT = 10;

export interface SegmentColumn {
  /** A dimension value's code, OTHER_SEGMENTS, or NOT_ALLOCATED. */
  key: string;
  label: string;
  /** True for exactly one column, and it is always present. */
  isUnallocated: boolean;
  /** True for the IFRS 8.16 aggregate, which is absent when nothing was aggregated. */
  isOther: boolean;
  /** False on the aggregate and on Not allocated, which are not segments. */
  reportable: boolean;
}

/** Why one segment is reportable, or why it is not. Every input is shown. */
export interface SegmentTest {
  /** IFRS 8.13(a): revenue against combined segment revenue. */
  revenueShareBps: string | null;
  revenuePasses: boolean;
  /**
   * IFRS 8.13(b): the absolute result against the greater, in absolute amount,
   * of combined profit of the segments in profit and combined loss of those in
   * loss.
   */
  resultShareBps: string | null;
  resultPasses: boolean;
  /** IFRS 8.13(c): assets against combined segment assets. */
  assetsShareBps: string | null;
  assetsPasses: boolean;
  /** Any one of the three is enough — IFRS 8.13. */
  quantitativeThresholdMet: boolean;
  /** Promoted to make the 75% coverage in IFRS 8.15, having failed IFRS 8.13. */
  promotedForCoverage: boolean;
  reportable: boolean;
  /** The reason in a sentence, so the answer can be checked rather than believed. */
  basis: string;
}

export interface SegmentRow {
  key: string;
  label: string;
  isUnallocated: boolean;
  /** Presented on the natural side, positive, exactly as statements.ts presents them. */
  revenueMinor: string;
  costOfSalesMinor: string;
  grossProfitMinor: string;
  expensesMinor: string;
  /** Revenue less cost of sales less operating expenses. Negative is a loss. */
  resultMinor: string;
  /** As at the end of the period — see the note on segmentBalanceSheet. */
  assetsMinor: string;
  liabilitiesMinor: string;
  test: SegmentTest;
}

export type MeasureKey = "revenue" | "cost_of_sales" | "gross_profit" | "expenses" | "result";

/** One line of the matrix: a measure, across the presented columns. */
export interface SegmentMeasureRow {
  key: MeasureKey;
  label: string;
  /** True where the row is drawn from the rows above it rather than from the ledger. */
  isSubtotal: boolean;
  byColumn: Record<string, string>;
  /** Every column added together, including Not allocated — the figure that must tie. */
  totalMinor: string;
}

export interface SegmentThresholds {
  /** Operating segments only. Not allocated is not one, so it is not in here. */
  combinedRevenueMinor: string;
  combinedProfitMinor: string;
  combinedLossMinor: string;
  /** The greater of the two above, in absolute amount — the IFRS 8.13(b) denominator. */
  resultBasisMinor: string;
  combinedAssetsMinor: string;
  /** IFRS 8.15: reportable revenue against the entity's revenue, Not allocated included. */
  reportableRevenueMinor: string;
  entityRevenueMinor: string;
  revenueCoverageBps: string | null;
  seventyFivePercentMet: boolean;
  /** False when there is no revenue to cover, which makes the test meaningless rather than failed. */
  seventyFivePercentApplicable: boolean;
  /** Keys promoted under IFRS 8.15, largest revenue first — in the order they were promoted. */
  promoted: string[];
}

export interface SegmentReport {
  from: string;
  to: string;
  currency: string;
  dimensionCode: string;
  dimensionName: string;
  /** As presented: reportable segments, then Other segments, then Not allocated. */
  columns: SegmentColumn[];
  measures: SegmentMeasureRow[];
  /** Every dimension value and Not allocated, before any aggregation. */
  segments: SegmentRow[];
  thresholds: SegmentThresholds;
  /** IFRS 8.28. Zero differences, or this report is not fit to be read. */
  reconciles: boolean;
  differenceMinor: string;
  reconciliation: {
    controlRevenueMinor: string;
    controlCostOfSalesMinor: string;
    controlExpensesMinor: string;
    controlNetProfitMinor: string;
    differencesMinor: { revenue: string; costOfSales: string; expenses: string; result: string };
  };
  warnings: string[];
}

export interface SegmentBalanceLine {
  code: string;
  name: string;
  nameAr: string | null;
  /** Presented on the account's natural side, positive — keyed by column. */
  presentedMinor: Record<string, string>;
  /** Signed, debit-positive, as the ledger holds it — keyed by column. */
  balanceMinor: Record<string, string>;
  totalPresentedMinor: string;
}

export interface SegmentBalanceSection {
  key: string;
  label: string;
  lines: SegmentBalanceLine[];
  totalMinor: Record<string, string>;
  /** Across every column including Not allocated — the figure that must tie. */
  grandTotalMinor: string;
  /** The same section on the entity's own balance sheet. */
  controlMinor: string;
  differenceMinor: string;
}

export interface SegmentBalanceSheet {
  asOf: string;
  currency: string;
  dimensionCode: string;
  dimensionName: string;
  columns: SegmentColumn[];
  assets: SegmentBalanceSection;
  liabilities: SegmentBalanceSection;
  /** IFRS 8.28(c) and (d): both sections tie to the entity's balance sheet. */
  reconciles: boolean;
  differenceMinor: string;
  /** Share of total assets carrying no segment, in basis points. The trust number. */
  unallocatedAssetShareBps: string | null;
  warnings: string[];
}

export interface SegmentTrendPeriod {
  /** YYYY-MM, the label the entity's own accounting periods use. */
  label: string;
  from: string;
  to: string;
  revenueMinor: Record<string, string>;
  resultMinor: Record<string, string>;
  /** Checked month by month: a single month that does not tie invalidates the trend. */
  reconciles: boolean;
  differenceMinor: string;
}

export interface SegmentTrendSeries {
  key: string;
  label: string;
  isUnallocated: boolean;
  firstRevenueMinor: string;
  lastRevenueMinor: string;
  revenueChangeMinor: string;
  /** Change over the first month's revenue, in basis points. Null when it started at nil. */
  revenueChangeBps: string | null;
  firstResultMinor: string;
  lastResultMinor: string;
  resultChangeMinor: string;
  /** Stated, never left to the sign of a change the reader has to spot. */
  shrinking: boolean;
}

export interface SegmentTrend {
  dimensionCode: string;
  dimensionName: string;
  currency: string;
  from: string;
  to: string;
  /** Every value plus Not allocated — see the note in segmentTrend on why nothing is aggregated here. */
  columns: SegmentColumn[];
  periods: SegmentTrendPeriod[];
  series: SegmentTrendSeries[];
  reconciles: boolean;
  /** Named, so a broken month can be looked at rather than hunted for. */
  unreconciledPeriods: string[];
}

/* ------------------------------------------------------------------ numbers */

const abs = (v: bigint) => (v < 0n ? -v : v);

/**
 * "10 per cent or more" (IFRS 8.13), tested on the amounts themselves.
 *
 * Not on the basis-point figure the screen prints: that is truncated toward
 * zero, so a segment sitting on 999.94 bps would print 999 and fail a threshold
 * it actually meets. The comparison a standard states in percentages has to be
 * exact arithmetic, or the answer depends on the rounding of a display value.
 *
 * Both sides are taken in absolute amount. IFRS 8.13(b) says so for the result;
 * for revenue and assets it is a reading, and the reading is that a segment
 * carrying a large *negative* revenue — a year of returns and credit notes — is
 * material for the same reason a large positive one is. Treating it as under
 * the threshold would hide the segment that most needs explaining.
 */
const meetsTenPercent = (figure: bigint, combined: bigint): boolean =>
  abs(combined) > 0n && abs(figure) * 10n >= abs(combined);

/**
 * Basis points, truncated toward zero so a share is never overstated. A zero
 * denominator has no answer and gets null: "this segment has no revenue" and
 * "there is no revenue to have a share of" are different facts.
 */
const bps = (numerator: bigint, denominator: bigint): bigint | null =>
  denominator === 0n ? null : (numerator * 10_000n) / denominator;

const str = (v: bigint | null) => (v === null ? null : v.toString());

/** A figure out of one of the dimensional report's per-column records. */
const fig = (rec: Record<string, string>, key: string): bigint => BigInt(rec[key] ?? "0");

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthLabel = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(raw: string, what: string): Date {
  const text = (raw ?? "").trim();
  if (!DATE_ONLY.test(text)) {
    throw new LedgerError(`The ${what} must be a date in the form YYYY-MM-DD — "${raw}" is not.`);
  }
  const d = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new LedgerError(`The ${what} is not a valid date.`);
  return d;
}

/* ------------------------------------------------------------- the dimension */

interface Resolved {
  dimension: { id: string; code: string; name: string };
  /** Values in code order, then Not allocated. Reportability is decided later. */
  columns: SegmentColumn[];
  /** valueId → column key. */
  columnOf: Map<string, string>;
}

/**
 * Find the dimension to report segments on, or refuse by name.
 *
 * The refusal lists the dimensions the organisation does have. "There is no
 * BRANCH dimension" sends somebody to create one; "there is no BRANCH
 * dimension, but there are these three" tells them they meant COST_CENTRE, and
 * that is the difference between a dead end and an answer.
 *
 * Archived values keep their column, exactly as dimensions.ts keeps them:
 * archiving means "do not use this going forward", not "pretend last year's
 * revenue was never coded", and dropping the column would silently move real
 * segment revenue into Not allocated — the one figure here that has to be
 * believable.
 */
async function resolveSegments(orgId: string, rawCode: string): Promise<Resolved> {
  const code = (rawCode ?? "").trim().toUpperCase();
  const dimension = code
    ? await prisma.dimension.findUnique({ where: { orgId_code: { orgId, code } }, include: { values: true } })
    : null;

  if (!dimension) {
    const available = await listDimensions({ orgId });
    if (available.length === 0) {
      throw new LedgerError(
        `No dimensions have been defined in this organisation, so there is nothing to report segments on — ` +
          `every posting would fall into "${NOT_ALLOCATED_LABEL}". Create a dimension such as SEGMENT, BRANCH or ` +
          `COST_CENTRE and tag postings with it first.`,
      );
    }
    throw new LedgerError(
      `There is no ${code || `"${rawCode}"`} dimension in this organisation. Segments are reported on a dimension ` +
        `the ledger already records, and this organisation has ${available.map((d) => `${d.code} (${d.name})`).join(", ")}.`,
    );
  }

  const values = [...dimension.values].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  const columns: SegmentColumn[] = values.map((v) => ({
    key: v.code,
    label: v.name,
    isUnallocated: false,
    isOther: false,
    reportable: false,
  }));
  columns.push({
    key: NOT_ALLOCATED,
    label: NOT_ALLOCATED_LABEL,
    isUnallocated: true,
    isOther: false,
    reportable: false,
  });

  return {
    dimension: { id: dimension.id, code: dimension.code, name: dimension.name },
    columns,
    columnOf: new Map(values.map((v) => [v.id, v.code])),
  };
}

/** The book every statement is read from, as statements.ts and dimensions.ts do. */
async function primaryBook(orgId: string, entityId: string) {
  const book = await prisma.book.findFirst({ where: { orgId, entityId, code: "PRIMARY" } });
  if (!book) throw new LedgerError("No ledger has been opened for this entity.");
  return book;
}

/* --------------------------------------------------- balance-sheet attribution */

interface BalanceRow {
  code: string;
  name: string;
  nameAr: string | null;
  type: string;
  byColumn: Map<string, bigint>;
}

/**
 * Balance-sheet accounts split by segment, cumulative to a date.
 *
 * This sums journal lines rather than reading the period-anchored balance
 * cache, for the reason dimensions.ts gives: the cache is anchored per account
 * and period and knows nothing about dimensions. The date rules are the ones
 * balances() uses in statements.ts — every period that has started by the date,
 * cut to the date by entry date — so the two paths cover the same postings and
 * the reconciliation below means something when it passes.
 *
 * Reversed entries are included alongside posted ones. A posted entry is
 * immutable and correction is by mirror entry, so the original and its reversal
 * both stand and net to zero; reading only "posted" would drop the original,
 * keep the reversal, and report the negative of the entry that was corrected.
 */
async function attributeBalances(opts: {
  orgId: string;
  entityId: string;
  bookId: string;
  dimensionId: string;
  columnOf: Map<string, string>;
  asOf: Date;
}): Promise<BalanceRow[]> {
  const periods = await prisma.accountingPeriod.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, startsOn: { lte: opts.asOf } },
    select: { id: true },
  });
  if (periods.length === 0) return [];

  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      entry: {
        entityId: opts.entityId,
        bookId: opts.bookId,
        status: { in: ["posted", "reversed"] },
        periodId: { in: periods.map((p) => p.id) },
        entryDate: { lte: opts.asOf },
      },
    },
    select: {
      functionalAmountMinor: true,
      account: { select: { id: true, code: true, name: true, nameAr: true, type: true } },
      // At most one row: JournalLineDimension is unique on (lineId, dimensionId).
      dimensions: { where: { dimensionId: opts.dimensionId }, select: { valueId: true } },
    },
  });

  const byAccount = new Map<string, BalanceRow>();
  for (const l of lines) {
    if (l.account.type !== "ASSET" && l.account.type !== "LIABILITY") continue;
    const valueId = l.dimensions[0]?.valueId;
    const column = (valueId && opts.columnOf.get(valueId)) || NOT_ALLOCATED;
    const row = byAccount.get(l.account.id) ?? {
      code: l.account.code,
      name: l.account.name,
      nameAr: l.account.nameAr,
      type: l.account.type,
      byColumn: new Map<string, bigint>(),
    };
    row.byColumn.set(column, (row.byColumn.get(column) ?? 0n) + l.functionalAmountMinor);
    byAccount.set(l.account.id, row);
  }

  return [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

const at = (row: BalanceRow, key: string) => row.byColumn.get(key) ?? 0n;

const perColumn = (columns: SegmentColumn[], f: (key: string) => bigint): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const c of columns) out[c.key] = f(c.key).toString();
  return out;
};

const sumColumns = (columns: SegmentColumn[], f: (key: string) => bigint): bigint =>
  columns.reduce((a, c) => a + f(c.key), 0n);

/**
 * Build a section on its natural side, exactly as section() does in
 * statements.ts: assets are debit-natural and presented as the ledger holds
 * them, liabilities are credit-natural and presented negated. Getting this
 * backwards is how a statement ends up showing a liability as a negative asset.
 */
function balanceSection(
  key: string,
  label: string,
  rows: BalanceRow[],
  naturalSide: "debit" | "credit",
  columns: SegmentColumn[],
  controlMinor: string,
): SegmentBalanceSection {
  const flip = naturalSide === "credit" ? -1n : 1n;

  const lines = rows
    // A line is dropped only when every column is zero — never when one is.
    .filter((r) => columns.some((c) => at(r, c.key) !== 0n))
    .map((r) => ({
      code: r.code,
      name: r.name,
      nameAr: r.nameAr,
      presentedMinor: perColumn(columns, (k) => at(r, k) * flip),
      balanceMinor: perColumn(columns, (k) => at(r, k)),
      totalPresentedMinor: (sumColumns(columns, (k) => at(r, k)) * flip).toString(),
    }));

  const totalMinor = perColumn(columns, (k) => rows.reduce((a, r) => a + at(r, k), 0n) * flip);
  const grandTotal = sumColumns(columns, (k) => BigInt(totalMinor[k]));

  return {
    key,
    label,
    lines,
    totalMinor,
    grandTotalMinor: grandTotal.toString(),
    controlMinor,
    differenceMinor: (grandTotal - BigInt(controlMinor)).toString(),
  };
}

/* -------------------------------------------------------------- the reports */

/**
 * The segment note: revenue, cost of sales, gross profit, operating expenses
 * and result per segment, with Not allocated beside them and the IFRS 8.28
 * reconciliation under them.
 *
 * Segment assets come from the same date the period ends on, because IFRS
 * 8.13(c) tests a segment's assets against the combined assets of all operating
 * segments and there is no way to apply that threshold without them. Read the
 * note on segmentBalanceSheet before relying on the figure: in most ledgers it
 * is mostly unallocated, and a threshold test fed by a mostly-unallocated
 * denominator will rarely be what decides reportability.
 */
export async function segmentReport(opts: {
  orgId: string;
  entityId: string;
  from: string;
  to: string;
  dimensionCode: string;
}): Promise<SegmentReport> {
  const from = parseDate(opts.from, "from date");
  const to = parseDate(opts.to, "to date");
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const { dimension, columnOf } = await resolveSegments(opts.orgId, opts.dimensionCode);
  const book = await primaryBook(opts.orgId, opts.entityId);

  // One dimensional read, and it is the existing one — the same call the
  // cost-centre screen makes, asked for this axis. Segment reporting has no
  // private path to the general ledger.
  const pl = await dimensionalProfitAndLoss({
    orgId: opts.orgId,
    entityId: opts.entityId,
    from: opts.from,
    to: opts.to,
    dimensionCode: dimension.code,
  });

  const balances = await attributeBalances({
    orgId: opts.orgId,
    entityId: opts.entityId,
    bookId: book.id,
    dimensionId: dimension.id,
    columnOf,
    asOf: to,
  });
  const assetRows = balances.filter((r) => r.type === "ASSET");
  const liabilityRows = balances.filter((r) => r.type === "LIABILITY");
  const assetsOf = (key: string) => assetRows.reduce((a, r) => a + at(r, key), 0n);
  const liabilitiesOf = (key: string) => liabilityRows.reduce((a, r) => a - at(r, key), 0n);

  const warnings: string[] = [];

  /* --- every value, before any aggregation ------------------------------ */

  const base = pl.columns.map((c) => ({
    key: c.key,
    label: c.isUnallocated ? NOT_ALLOCATED_LABEL : c.label,
    isUnallocated: c.isUnallocated,
    revenue: fig(pl.revenue.totalMinor, c.key),
    costOfSales: fig(pl.costOfSales.totalMinor, c.key),
    grossProfit: fig(pl.grossProfitMinor, c.key),
    expenses: fig(pl.expenses.totalMinor, c.key),
    result: fig(pl.netProfitMinor, c.key),
    assets: assetsOf(c.key),
    liabilities: liabilitiesOf(c.key),
  }));

  const operating = base.filter((s) => !s.isUnallocated);

  // The entity's own totals, Not allocated included. IFRS 8.15 and the
  // reconciliation are measured against these; the IFRS 8.13 thresholds are
  // not — see below.
  const entityRevenue = base.reduce((a, s) => a + s.revenue, 0n);
  const entityAssets = base.reduce((a, s) => a + s.assets, 0n);

  /* --- IFRS 8.13, the quantitative thresholds --------------------------- */

  const combinedRevenue = operating.reduce((a, s) => a + s.revenue, 0n);
  const combinedAssets = operating.reduce((a, s) => a + s.assets, 0n);
  // IFRS 8.13(b) measures against the greater, in absolute amount, of the
  // combined profit of every segment that did not report a loss and the
  // combined loss of every segment that did. Netting the two would let a
  // profitable segment and a loss-making one of the same size cancel out and
  // make the denominator nil, at which point nothing is ever reportable on
  // result — which is precisely the case the standard is written for.
  const combinedProfit = operating.reduce((a, s) => (s.result > 0n ? a + s.result : a), 0n);
  const combinedLoss = operating.reduce((a, s) => (s.result < 0n ? a - s.result : a), 0n);
  const resultBasis = combinedProfit > combinedLoss ? combinedProfit : combinedLoss;

  const tests = new Map<string, SegmentTest>();
  for (const s of base) {
    if (s.isUnallocated) {
      // Not an operating segment (IFRS 8.5): no manager, no discrete financial
      // information, nobody reviewing its results. It is the reconciling item,
      // and it is neither tested nor aggregated away.
      // Its shares are taken of the entity's totals rather than of the combined
      // segment totals: a share of a denominator this column is excluded from
      // would be a number nobody could add up.
      tests.set(s.key, {
        revenueShareBps: str(bps(s.revenue, entityRevenue)),
        revenuePasses: false,
        resultShareBps: str(bps(s.result, resultBasis)),
        resultPasses: false,
        assetsShareBps: str(bps(s.assets, entityAssets)),
        assetsPasses: false,
        quantitativeThresholdMet: false,
        promotedForCoverage: false,
        reportable: false,
        basis:
          `Postings carrying no ${dimension.code} value. Not an operating segment under IFRS 8.5, so it is not ` +
          `tested against the thresholds and never aggregated into another column — it is the reconciling item ` +
          `IFRS 8.28 requires. Its shares are of the entity's totals, not of the combined segment totals.`,
      });
      continue;
    }

    const revenuePasses = meetsTenPercent(s.revenue, combinedRevenue);
    const resultPasses = meetsTenPercent(s.result, resultBasis);
    const assetsPasses = meetsTenPercent(s.assets, combinedAssets);
    const met = revenuePasses || resultPasses || assetsPasses;
    const reasons = [
      revenuePasses ? "revenue" : null,
      resultPasses ? "result" : null,
      assetsPasses ? "assets" : null,
    ].filter(Boolean);

    tests.set(s.key, {
      revenueShareBps: str(bps(s.revenue, combinedRevenue)),
      revenuePasses,
      resultShareBps: str(bps(s.result, resultBasis)),
      resultPasses,
      assetsShareBps: str(bps(s.assets, combinedAssets)),
      assetsPasses,
      quantitativeThresholdMet: met,
      promotedForCoverage: false,
      reportable: met,
      basis: met
        ? `Reportable under IFRS 8.13: its ${reasons.join(", ")} ${reasons.length === 1 ? "is" : "are"} 10% or more of the combined segment total.`
        : `Below all three IFRS 8.13 thresholds on revenue, result and assets, so it is combined into "${OTHER_SEGMENTS_LABEL}" under IFRS 8.16.`,
    });
  }

  /* --- IFRS 8.15, the 75% coverage rule --------------------------------- */

  // Measured against the entity's revenue, Not allocated included, because that
  // is what IFRS 8.15 says: the reportable segments must account for at least
  // 75 per cent of *the entity's* revenue. Revenue nobody coded to a segment
  // therefore makes the threshold harder to reach, which is the correct
  // consequence and not a rounding problem to be engineered away.
  const promoted: string[] = [];
  const covered = () => base.filter((s) => tests.get(s.key)!.reportable).reduce((a, s) => a + s.revenue, 0n);
  const seventyFivePercentApplicable = entityRevenue > 0n;

  if (seventyFivePercentApplicable) {
    // Exact arithmetic, for the reason meetsTenPercent gives: a percentage in
    // a standard is a comparison of amounts, not of rounded display values.
    const enough = () => covered() * 100n >= entityRevenue * 75n;
    // Largest revenue first, ties broken by code so the same books always
    // promote the same segment — a note that changes its shape between two runs
    // over identical data is a note nobody can review.
    const candidates = operating
      .filter((s) => !tests.get(s.key)!.reportable)
      .sort((a, b) => (b.revenue === a.revenue ? a.key.localeCompare(b.key) : b.revenue > a.revenue ? 1 : -1));

    for (const s of candidates) {
      if (enough()) break;
      const test = tests.get(s.key)!;
      test.reportable = true;
      test.promotedForCoverage = true;
      test.basis =
        `Below every IFRS 8.13 threshold, but reported separately under IFRS 8.15: without it the reportable ` +
        `segments would cover less than 75% of the entity's revenue.`;
      promoted.push(s.key);
    }

    if (!enough()) {
      warnings.push(
        `Even with every ${dimension.code} value reported separately, the segments cover only ` +
          `${((Number(bps(covered(), entityRevenue) ?? 0n) / 100)).toFixed(2)}% of revenue, short of the 75% IFRS 8.15 ` +
          `asks for. The shortfall is revenue carrying no ${dimension.code} value, and no amount of promoting ` +
          `segments can close it — the postings have to be coded.`,
      );
    }
  }

  const reportableRevenue = covered();
  const reportableKeys = base.filter((s) => tests.get(s.key)!.reportable).map((s) => s.key);
  if (reportableKeys.length > PRACTICAL_LIMIT) {
    warnings.push(
      `${reportableKeys.length} segments are reportable. IFRS 8.19 suggests that beyond ten, the information may ` +
        `become too detailed to be useful and a practical limit should be considered — aggregating similar ` +
        `segments under IFRS 8.12 is a judgement only you can make.`,
    );
  }

  /* --- presentation: reportable, then Other, then Not allocated --------- */

  const aggregated = operating.filter((s) => !tests.get(s.key)!.reportable);
  const columns: SegmentColumn[] = operating
    .filter((s) => tests.get(s.key)!.reportable)
    .map((s) => ({ key: s.key, label: s.label, isUnallocated: false, isOther: false, reportable: true }));

  if (aggregated.length > 0) {
    columns.push({
      key: OTHER_SEGMENTS,
      label: OTHER_SEGMENTS_LABEL,
      isUnallocated: false,
      isOther: true,
      reportable: false,
    });
  }
  const unallocatedRow = base.find((s) => s.isUnallocated)!;
  columns.push({
    key: NOT_ALLOCATED,
    label: NOT_ALLOCATED_LABEL,
    isUnallocated: true,
    isOther: false,
    reportable: false,
  });

  const pick = (key: string, of: (s: (typeof base)[number]) => bigint): bigint => {
    if (key === OTHER_SEGMENTS) return aggregated.reduce((a, s) => a + of(s), 0n);
    const row = base.find((s) => s.key === key);
    return row ? of(row) : 0n;
  };

  const measure = (key: MeasureKey, label: string, isSubtotal: boolean, of: (s: (typeof base)[number]) => bigint): SegmentMeasureRow => {
    const byColumn = perColumn(columns, (k) => pick(k, of));
    return { key, label, isSubtotal, byColumn, totalMinor: sumColumns(columns, (k) => BigInt(byColumn[k])).toString() };
  };

  const measures: SegmentMeasureRow[] = [
    measure("revenue", "Revenue", false, (s) => s.revenue),
    measure("cost_of_sales", "Cost of sales", false, (s) => s.costOfSales),
    measure("gross_profit", "Gross profit", true, (s) => s.grossProfit),
    measure("expenses", "Operating expenses", false, (s) => s.expenses),
    measure("result", "Segment result", true, (s) => s.result),
  ];

  /* --- IFRS 8.28, the reconciliation ------------------------------------ */

  // The control is the entity's own statement, asked for directly rather than
  // inherited from the dimensional read: profitAndLoss() answers from the
  // period-anchored balance cache, and these columns were summed from journal
  // lines. Two genuinely different paths over the same facts, so when they
  // agree they agree for a reason.
  //
  // And it is checked over the columns this report actually prints, not over
  // the ones it read: if the IFRS 8.16 aggregation above dropped a segment or
  // counted one twice, this is exactly what catches it.
  const control = await profitAndLoss({
    orgId: opts.orgId, entityId: opts.entityId, from: opts.from, to: opts.to,
  });
  const controlRevenue = BigInt(control.revenue.totalMinor);
  const controlCostOfSales = BigInt(control.costOfSales.totalMinor);
  const controlExpenses = BigInt(control.expenses.totalMinor);
  const controlResult = BigInt(control.netProfitMinor);

  const byMeasure = new Map(measures.map((m) => [m.key, BigInt(m.totalMinor)]));
  const differences = {
    revenue: byMeasure.get("revenue")! - controlRevenue,
    costOfSales: byMeasure.get("cost_of_sales")! - controlCostOfSales,
    expenses: byMeasure.get("expenses")! - controlExpenses,
    result: byMeasure.get("result")! - controlResult,
  };

  const reconciles = Object.values(differences).every((d) => d === 0n);
  if (!reconciles) {
    warnings.push(
      `These segment columns do not add back to the entity's profit and loss for the same period — the result is ` +
        `out by ${differences.result} minor units. That is a defect in this report, not a rounding difference. ` +
        `Do not file a segment note from it until the difference is explained.`,
    );
  }

  // The residual, sized against the entity. Worth saying only when it is big
  // enough to change how the note reads — warning every month about a few fils
  // teaches people to ignore the warnings.
  if (meetsTenPercent(unallocatedRow.revenue, entityRevenue) && unallocatedRow.revenue !== 0n) {
    warnings.push(
      `${((Number(bps(unallocatedRow.revenue, entityRevenue) ?? 0n)) / 100).toFixed(2)}% of revenue carries no ` +
        `${dimension.code} value. It is shown as "${NOT_ALLOCATED_LABEL}" rather than spread across the segments, ` +
        `but at that size the segment note describes rather less of the business than it appears to.`,
    );
  }
  if (operating.length === 0) {
    warnings.push(
      `${dimension.code} has no values, so there are no segments to report and every posting is ` +
        `"${NOT_ALLOCATED_LABEL}". Add the values before reading anything into this.`,
    );
  }

  const segments: SegmentRow[] = base.map((s) => ({
    key: s.key,
    label: s.label,
    isUnallocated: s.isUnallocated,
    revenueMinor: s.revenue.toString(),
    costOfSalesMinor: s.costOfSales.toString(),
    grossProfitMinor: s.grossProfit.toString(),
    expensesMinor: s.expenses.toString(),
    resultMinor: s.result.toString(),
    assetsMinor: s.assets.toString(),
    liabilitiesMinor: s.liabilities.toString(),
    test: tests.get(s.key)!,
  }));

  return {
    from: opts.from,
    to: opts.to,
    currency: pl.currency,
    dimensionCode: dimension.code,
    dimensionName: dimension.name,
    columns,
    measures,
    segments,
    thresholds: {
      combinedRevenueMinor: combinedRevenue.toString(),
      combinedProfitMinor: combinedProfit.toString(),
      combinedLossMinor: combinedLoss.toString(),
      resultBasisMinor: resultBasis.toString(),
      combinedAssetsMinor: combinedAssets.toString(),
      reportableRevenueMinor: reportableRevenue.toString(),
      entityRevenueMinor: entityRevenue.toString(),
      revenueCoverageBps: str(bps(reportableRevenue, entityRevenue)),
      seventyFivePercentMet: seventyFivePercentApplicable ? reportableRevenue * 100n >= entityRevenue * 75n : false,
      seventyFivePercentApplicable,
      promoted,
    },
    reconciles,
    differenceMinor: differences.result.toString(),
    reconciliation: {
      controlRevenueMinor: controlRevenue.toString(),
      controlCostOfSalesMinor: controlCostOfSales.toString(),
      controlExpensesMinor: controlExpenses.toString(),
      controlNetProfitMinor: controlResult.toString(),
      differencesMinor: {
        revenue: differences.revenue.toString(),
        costOfSales: differences.costOfSales.toString(),
        expenses: differences.expenses.toString(),
        result: differences.result.toString(),
      },
    },
    warnings,
  };
}

/**
 * Segment assets and segment liabilities (IFRS 8.23(c), 8.28(c) and (d)).
 *
 * READ THIS BEFORE READING THE NUMBERS. In practice most balance-sheet
 * postings carry no dimension, so for most businesses this report is mostly
 * "Not allocated" and says so honestly rather than pretending otherwise. The
 * reason is structural, not a bug: a segment is coded onto the line that
 * carries the cost or the revenue, and the other side of the entry — the bank
 * account, the receivable, the payable, the accrual — is a shared balance
 * nobody tags. An entry that debits marketing spend against the bank puts a
 * segment on the expense and nothing on the cash, so the expense reports by
 * segment and the cash does not.
 *
 * What would have to change for this to be a real segment balance sheet:
 *
 *  1. Both sides of an entry tagged. post.ts records dimensions per line, so
 *     this is possible today — it needs the receivable, the payable and the
 *     inventory line coded as well as the profit-and-loss line. That is a
 *     posting discipline, and requireDimensionOn() is what enforces it: set the
 *     dimension as mandatory on 1100, 2000, 1200 and the accounts that matter,
 *     and Not allocated stops growing on the day it is switched on.
 *  2. Shared assets — the office, the group's cash, the ERP — allocated on a
 *     stated basis. IFRS 8.23 only requires segment assets to be disclosed when
 *     they are regularly provided to the chief operating decision maker, and
 *     IFRS 8.27(d) requires the basis of any such allocation to be described.
 *     Allocating them silently here would be inventing the disclosure, so
 *     nothing is allocated: what the ledger cannot attribute stays unattributed.
 *
 * Until one of those happens, treat the assets threshold in IFRS 8.13(c) as
 * weak evidence in this product, and let revenue and result do the work.
 */
export async function segmentBalanceSheet(opts: {
  orgId: string;
  entityId: string;
  asOf: string;
  dimensionCode: string;
}): Promise<SegmentBalanceSheet> {
  const asOf = parseDate(opts.asOf, "as-at date");

  const { dimension, columns, columnOf } = await resolveSegments(opts.orgId, opts.dimensionCode);
  const book = await primaryBook(opts.orgId, opts.entityId);

  const rows = await attributeBalances({
    orgId: opts.orgId,
    entityId: opts.entityId,
    bookId: book.id,
    dimensionId: dimension.id,
    columnOf,
    asOf,
  });

  // The control, from the entity's own balance sheet — the cache-backed path,
  // not these lines.
  const control = await balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: opts.asOf });

  const assets = balanceSection(
    "assets", "Assets", rows.filter((r) => r.type === "ASSET"), "debit", columns, control.assets.totalMinor,
  );
  const liabilities = balanceSection(
    "liabilities", "Liabilities", rows.filter((r) => r.type === "LIABILITY"), "credit", columns, control.liabilities.totalMinor,
  );

  const differences = BigInt(assets.differenceMinor) + BigInt(liabilities.differenceMinor);
  const warnings: string[] = [];
  if (differences !== 0n) {
    warnings.push(
      `Segment assets and liabilities do not add back to the balance sheet at ${opts.asOf} — assets are out by ` +
        `${assets.differenceMinor} and liabilities by ${liabilities.differenceMinor} minor units. That is a defect ` +
        `in this report. Do not reconcile it by adjusting a column.`,
    );
  }

  const totalAssets = BigInt(assets.grandTotalMinor);
  const unallocatedAssets = BigInt(assets.totalMinor[NOT_ALLOCATED] ?? "0");
  if (totalAssets !== 0n && unallocatedAssets * 2n >= totalAssets) {
    warnings.push(
      `More than half the assets carry no ${dimension.code} value. That is the ordinary state of a ledger — the ` +
        `segment goes on the cost, not on the cash that paid it — and it means the IFRS 8.13(c) assets threshold ` +
        `has little to say here. Requiring ${dimension.code} on the balance-sheet accounts is what changes it.`,
    );
  }

  return {
    asOf: opts.asOf,
    currency: control.currency,
    dimensionCode: dimension.code,
    dimensionName: dimension.name,
    columns,
    assets,
    liabilities,
    reconciles: differences === 0n,
    differenceMinor: differences.toString(),
    unallocatedAssetShareBps: str(bps(unallocatedAssets, totalAssets)),
    warnings,
  };
}

/**
 * The same figures month by month.
 *
 * A segment that is quietly shrinking does not show up in a single period's
 * note, which is why one exists: three months of a segment losing a fifth of
 * its revenue reads as a trend, and the same fact inside one annual column
 * reads as nothing at all.
 *
 * Every value gets a column here, and nothing is aggregated into "Other
 * segments". Reportability is decided per period, so a segment that fell below
 * the thresholds in March and met them in April would move between columns
 * mid-table — and a segment that vanished into "Other" for the very months it
 * was shrinking is exactly the thing this report is meant to make visible.
 *
 * `periods` counts months back from `to` inclusive, so 12 ending 2026-12-31 is
 * the calendar year. Months are calendar months, matching the labels
 * openFiscalYear() gives the entity's accounting periods.
 */
export async function segmentTrend(opts: {
  orgId: string;
  entityId: string;
  dimensionCode: string;
  /** How many months, ending at `to`. */
  periods: number;
  /** The last month to show. Defaults to today. */
  to?: string;
}): Promise<SegmentTrend> {
  if (!Number.isInteger(opts.periods) || opts.periods < 1 || opts.periods > 60) {
    throw new LedgerError(
      `A trend runs over 1 to 60 months — ${opts.periods} is not a number of months anyone reads. ` +
        `Twelve is a year; sixty is five years, and past that the early columns are a different business.`,
    );
  }

  const anchor = opts.to ? parseDate(opts.to, "to date") : new Date();
  const { dimension, columns } = await resolveSegments(opts.orgId, opts.dimensionCode);

  const months: { label: string; from: Date; to: Date }[] = [];
  for (let i = opts.periods - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    months.push({ label: monthLabel(start), from: start, to: end });
  }

  // One dimensional read per month rather than one read carved up afterwards:
  // each month then carries its own reconciliation against the entity's profit
  // and loss for that month, so a single bad month is visible instead of being
  // averaged into a year that happens to tie.
  const reports = [];
  for (const m of months) {
    reports.push({
      month: m,
      pl: await dimensionalProfitAndLoss({
        orgId: opts.orgId,
        entityId: opts.entityId,
        from: iso(m.from),
        to: iso(m.to),
        dimensionCode: dimension.code,
      }),
    });
  }

  const periods: SegmentTrendPeriod[] = reports.map((r) => ({
    label: r.month.label,
    from: iso(r.month.from),
    to: iso(r.month.to),
    revenueMinor: perColumn(columns, (k) => fig(r.pl.revenue.totalMinor, k)),
    resultMinor: perColumn(columns, (k) => fig(r.pl.netProfitMinor, k)),
    reconciles: r.pl.reconciles,
    differenceMinor: r.pl.differenceMinor,
  }));

  const first = periods[0];
  const last = periods[periods.length - 1];

  const series: SegmentTrendSeries[] = columns.map((c) => {
    const firstRevenue = BigInt(first.revenueMinor[c.key]);
    const lastRevenue = BigInt(last.revenueMinor[c.key]);
    const firstResult = BigInt(first.resultMinor[c.key]);
    const lastResult = BigInt(last.resultMinor[c.key]);
    return {
      key: c.key,
      label: c.label,
      isUnallocated: c.isUnallocated,
      firstRevenueMinor: firstRevenue.toString(),
      lastRevenueMinor: lastRevenue.toString(),
      revenueChangeMinor: (lastRevenue - firstRevenue).toString(),
      // No revenue in the first month is not a 100% rise, or a fall, or
      // anything else — it is a percentage that does not exist, and saying so
      // beats printing a figure that will be quoted.
      revenueChangeBps: str(bps(lastRevenue - firstRevenue, firstRevenue)),
      firstResultMinor: firstResult.toString(),
      lastResultMinor: lastResult.toString(),
      resultChangeMinor: (lastResult - firstResult).toString(),
      shrinking: lastRevenue < firstRevenue,
    };
  });

  const unreconciled = periods.filter((p) => !p.reconciles).map((p) => p.label);

  return {
    dimensionCode: dimension.code,
    dimensionName: dimension.name,
    currency: reports[0].pl.currency,
    from: iso(months[0].from),
    to: iso(months[months.length - 1].to),
    columns,
    periods,
    series,
    reconciles: unreconciled.length === 0,
    unreconciledPeriods: unreconciled,
  };
}
