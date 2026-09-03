import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { profitAndLoss } from "./statements";
import { trialBalance } from "./reports";

/**
 * Dimensions: the second axis of the ledger. An account says *what* was spent;
 * a dimension says *where* — which cost centre, department, project or branch.
 * The schema carries N of them per line, so this is not two hard-coded columns
 * that run out the first time someone wants a project as well as a department.
 *
 * Three things make a dimensional report trustworthy, and this module exists to
 * hold all three:
 *
 *   1. Unallocated is a column, not a footnote. Every dimensional report shows
 *      what carried no value, always, even when it is zero. Cost that nobody
 *      owns is the single most useful number on a departmental report, and the
 *      moment it is hidden — or worse, spread across the other columns pro rata
 *      — the report starts lying in the direction its reader wants to believe.
 *
 *   2. The columns add back to the real statement. The sum across every column
 *      including Unallocated must equal the undimensioned profit and loss for
 *      the same period. A dimensional report that does not add up to the real
 *      one is worse than no report at all, because people act on it.
 *
 *   3. Nothing is presented differently here than in statements.ts. Revenue is
 *      shown positive on its natural side while the underlying ledger balance
 *      stays exactly as the ledger holds it, and both are returned.
 *
 * The one thing this cannot do is read the period-anchored balance cache. That
 * cache is anchored per account and period and knows nothing about dimensions,
 * so the attribution is summed from journal lines within the same date rules
 * balances() uses. That difference is a feature of the reconciliation rather
 * than a defect: the two sides are computed by genuinely different paths, so
 * when they agree they agree for a reason. A dimension-anchored cache is the
 * obvious next step once a ledger is big enough to need it.
 */

/**
 * The column for postings that carry no value for the dimension. Reserved: a
 * dimension value may not use this code, or real allocations and the residual
 * would land in the same bucket and become indistinguishable.
 */
export const UNALLOCATED = "UNALLOCATED";

export interface DimensionColumn {
  /** A dimension value's code, or UNALLOCATED. */
  key: string;
  label: string;
  /** True for exactly one column, and it is always present. */
  isUnallocated: boolean;
}

export interface DimensionalLine {
  code: string;
  name: string;
  nameAr: string | null;
  /** Signed, debit-positive, as the ledger holds it — keyed by column. */
  balanceMinor: Record<string, string>;
  /** Presented on the account's natural side, positive — keyed by column. */
  presentedMinor: Record<string, string>;
  /** Every column added together, on the natural side. */
  totalPresentedMinor: string;
  totalBalanceMinor: string;
}

export interface DimensionalSection {
  key: string;
  label: string;
  lines: DimensionalLine[];
  /** Presented total per column. */
  totalMinor: Record<string, string>;
  /** Across every column including Unallocated — the figure that must tie. */
  grandTotalMinor: string;
}

export interface DimensionalProfitAndLoss {
  from: string;
  to: string;
  currency: string;
  dimensionCode: string;
  dimensionName: string;
  columns: DimensionColumn[];
  revenue: DimensionalSection;
  costOfSales: DimensionalSection;
  grossProfitMinor: Record<string, string>;
  totalGrossProfitMinor: string;
  expenses: DimensionalSection;
  netProfitMinor: Record<string, string>;
  totalNetProfitMinor: string;
  /** Every column added up equals the undimensioned profit and loss. */
  reconciles: boolean;
  /** Dimensional net profit less the real one. Must be "0". */
  differenceMinor: string;
  reconciliation: {
    controlNetProfitMinor: string;
    differencesMinor: { revenue: string; costOfSales: string; expenses: string; netProfit: string };
  };
}

export interface DimensionSummaryRow {
  key: string;
  label: string;
  isUnallocated: boolean;
  revenueMinor: string;
  costOfSalesMinor: string;
  expensesMinor: string;
  netProfitMinor: string;
  /** Share of the basis total in basis points. BigInt throughout, then a string. */
  shareBps: string | null;
}

export interface DimensionSummary {
  from: string;
  to: string;
  currency: string;
  dimensionCode: string;
  dimensionName: string;
  /** Which figure the shares are a share of. */
  basis: SummaryBasis;
  basisTotalMinor: string;
  rows: DimensionSummaryRow[];
  /**
   * Shares are truncated, never rounded up, so no column is ever overstated.
   * What the truncation drops is returned here rather than being quietly
   * pushed into the largest column: shares plus this always make exactly 10000.
   */
  roundingRemainderBps: string;
  reconciles: boolean;
  differenceMinor: string;
}

export type SummaryBasis = "expenses" | "revenue" | "netProfit";

export interface DimensionalTrialBalanceRow {
  code: string;
  name: string;
  nameAr: string | null;
  type: string;
  /** Signed, debit-positive, per column. */
  balanceMinor: Record<string, string>;
  /** The account's balance across every column — must equal the trial balance. */
  totalMinor: string;
  /** The same account in the undimensioned trial balance. */
  controlMinor: string;
}

export interface DimensionalTrialBalance {
  periodLabel: string;
  currency: string;
  dimensionCode: string;
  dimensionName: string;
  columns: DimensionColumn[];
  rows: DimensionalTrialBalanceRow[];
  totalDebitMinor: Record<string, string>;
  totalCreditMinor: Record<string, string>;
  /**
   * A dimension-filtered trial balance does not balance, and that is not a
   * defect: most entries put the cost on a cost centre and the cash on none, so
   * a single column holds one side of a two-sided entry. What must hold — and
   * what `reconciles` checks — is that the columns add back to each account's
   * real balance.
   */
  reconciles: boolean;
  differenceMinor: string;
}

/* ------------------------------------------------------------------- set-up */

/**
 * Codes travel as JSON object keys on every posting (PostLine.dimensions is
 * { dimensionCode: valueCode }) and post.ts resolves them through a
 * `${dimensionCode}:${valueCode}` lookup key, so a code carrying a colon could
 * resolve to a different value than the one asked for. Keep them plain.
 */
const CODE = /^[A-Z0-9][A-Z0-9_]*$/;

function normaliseCode(raw: string, what: string): string {
  const code = (raw ?? "").trim().toUpperCase();
  if (!CODE.test(code)) {
    throw new LedgerError(
      `A ${what} code must be letters, digits and underscores only — "${raw}" is not. Use something like COST_CENTRE or OPS.`,
    );
  }
  return code;
}

function requireName(raw: string | undefined, what: string): string {
  const name = (raw ?? "").trim();
  if (!name) throw new LedgerError(`A ${what} needs a name a reader will recognise on a report, such as "Cost centre".`);
  return name;
}

/**
 * Create a dimension, optionally with its values. Idempotent per (org, code)
 * like openBooks is per entity — setup is re-run, and re-running it must not
 * fail halfway through and leave a half-built chart of dimensions.
 */
export async function createDimension(opts: {
  orgId: string;
  code: string;
  name: string;
  /** Advisory only. The binding rule is Account.requiresDimension — see requireDimensionOn. */
  isRequired?: boolean;
  values?: { code: string; name: string }[];
}) {
  const code = normaliseCode(opts.code, "dimension");
  const name = requireName(opts.name, "dimension");

  const dimension = await prisma.dimension.upsert({
    where: { orgId_code: { orgId: opts.orgId, code } },
    create: { orgId: opts.orgId, code, name, isRequired: opts.isRequired ?? false },
    update: { name, ...(opts.isRequired === undefined ? {} : { isRequired: opts.isRequired }) },
  });

  for (const v of opts.values ?? []) {
    await addValue({ orgId: opts.orgId, dimensionCode: code, code: v.code, name: v.name });
  }

  return prisma.dimension.findUniqueOrThrow({
    where: { id: dimension.id },
    include: { values: { orderBy: { code: "asc" } } },
  });
}

/** Add a value to a dimension — OPS, SALES, ADMIN under COST_CENTRE. */
export async function addValue(opts: { orgId: string; dimensionCode: string; code: string; name: string }) {
  const dimensionCode = normaliseCode(opts.dimensionCode, "dimension");
  const code = normaliseCode(opts.code, "dimension value");
  const name = requireName(opts.name, "dimension value");

  if (code === UNALLOCATED) {
    throw new LedgerError(
      `"${UNALLOCATED}" names the column for postings that carry no value for a dimension, so it cannot also be a value. Choose another code.`,
    );
  }

  const dimension = await prisma.dimension.findUnique({
    where: { orgId_code: { orgId: opts.orgId, code: dimensionCode } },
  });
  if (!dimension) {
    throw new LedgerError(`There is no ${dimensionCode} dimension in this organisation. Create the dimension before adding values to it.`);
  }

  return prisma.dimensionValue.upsert({
    where: { dimensionId_code: { dimensionId: dimension.id, code } },
    create: { orgId: opts.orgId, dimensionId: dimension.id, code, name },
    update: { name },
  });
}

/** Every dimension in the org with its values — the picker on a report screen. */
export async function listDimensions(opts: { orgId: string }) {
  const dims = await prisma.dimension.findMany({
    where: { orgId: opts.orgId },
    include: { values: { orderBy: { code: "asc" } } },
    orderBy: { code: "asc" },
  });
  return dims.map((d) => ({
    code: d.code,
    name: d.name,
    isRequired: d.isRequired,
    status: d.status,
    values: d.values.map((v) => ({ code: v.code, name: v.name, status: v.status })),
  }));
}

/**
 * Make a dimension mandatory on an account. post.ts refuses any line to the
 * account that does not carry that dimension, which is the only way Unallocated
 * ever stays at zero for the costs that matter: asking people to remember is
 * not a control.
 *
 * The account stores the dimension *code*, because that is what a posting is
 * keyed by ({ COST_CENTRE: "OPS" }) — see the requiresDimension check in post().
 */
export async function requireDimensionOn(opts: {
  orgId: string;
  entityId: string;
  accountCode: string;
  dimensionCode: string;
}) {
  const dimensionCode = normaliseCode(opts.dimensionCode, "dimension");

  const dimension = await prisma.dimension.findUnique({
    where: { orgId_code: { orgId: opts.orgId, code: dimensionCode } },
    include: { values: true },
  });
  if (!dimension) {
    throw new LedgerError(`There is no ${dimensionCode} dimension in this organisation. Create it before requiring it on an account.`);
  }
  // A dimension with no values cannot be satisfied, so requiring it would make
  // the account impossible to post to — a lock-out that would look like a
  // ledger fault to whoever hit it a month later.
  if (dimension.values.length === 0) {
    throw new LedgerError(`${dimensionCode} has no values yet, so nothing could satisfy the requirement. Add its values first.`);
  }

  const account = await prisma.account.findUnique({
    where: { orgId_entityId_code: { orgId: opts.orgId, entityId: opts.entityId, code: opts.accountCode } },
  });
  if (!account) throw new LedgerError(`Account ${opts.accountCode} does not exist in this entity's chart.`);
  if (!account.isPostable) {
    throw new LedgerError(
      `${account.code} ${account.name} is a heading, so nothing is ever posted to it and the requirement would have no effect. Set it on the sub-accounts instead.`,
    );
  }

  return prisma.account.update({
    where: { id: account.id },
    data: { requiresDimension: dimension.code },
  });
}

/* ------------------------------------------------------------ attribution */

interface DimBal {
  accountId: string;
  code: string;
  name: string;
  nameAr: string | null;
  type: string;
  /** Column key → signed, debit-positive minor units. */
  byColumn: Map<string, bigint>;
}

interface Resolved {
  dimension: { id: string; code: string; name: string };
  columns: DimensionColumn[];
  /** valueId → column key. */
  columnOf: Map<string, string>;
}

async function resolveDimension(orgId: string, rawCode: string): Promise<Resolved> {
  const code = normaliseCode(rawCode, "dimension");
  const dimension = await prisma.dimension.findUnique({
    where: { orgId_code: { orgId, code } },
    include: { values: true },
  });
  if (!dimension) {
    throw new LedgerError(`There is no ${code} dimension in this organisation. Create it before reporting on it.`);
  }

  // Archived values keep their column. Archiving means "do not use this going
  // forward", not "pretend last year's spend was never allocated" — dropping
  // the column would silently move real allocations into Unallocated, which is
  // the one number on this report that has to be believable.
  const values = [...dimension.values].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  const columns: DimensionColumn[] = values.map((v) => ({ key: v.code, label: v.name, isUnallocated: false }));
  // Last, and always present, even when it is zero: a reader must never have to
  // infer from a missing column that nothing was left unallocated.
  columns.push({ key: UNALLOCATED, label: "Unallocated", isUnallocated: true });

  return {
    dimension: { id: dimension.id, code: dimension.code, name: dimension.name },
    columns,
    columnOf: new Map(values.map((v) => [v.id, v.code])),
  };
}

/**
 * Sum journal lines into (account × column).
 *
 * Reversed entries are included alongside posted ones, as generalLedger() does.
 * A posted entry is immutable and correction is by mirror entry (see reverse()
 * in post.ts), so the original and its reversal both stand and net to zero.
 * Reading only "posted" would drop the original and keep the reversal, and the
 * report would show the negative of the entry that was corrected.
 *
 * This reads lines rather than the anchor cache because the cache has no
 * dimension breakdown. It is the one ledger read here that grows with the
 * ledger; it is bounded by the reporting range, and it is never truncated,
 * because a financial report that silently stops at N rows is not a report.
 */
async function attributeLines(opts: {
  orgId: string;
  entityId: string;
  bookId: string;
  dimensionId: string;
  periodIds: string[];
  columnOf: Map<string, string>;
  from?: Date;
  to?: Date;
}): Promise<Map<string, DimBal>> {
  const byAccount = new Map<string, DimBal>();
  if (opts.periodIds.length === 0) return byAccount;

  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      entry: {
        entityId: opts.entityId,
        bookId: opts.bookId,
        status: { in: ["posted", "reversed"] },
        periodId: { in: opts.periodIds },
        ...(opts.from || opts.to
          ? { entryDate: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
          : {}),
      },
    },
    select: {
      functionalAmountMinor: true,
      account: { select: { id: true, code: true, name: true, nameAr: true, type: true } },
      // At most one row: JournalLineDimension is unique on (lineId, dimensionId).
      dimensions: { where: { dimensionId: opts.dimensionId }, select: { valueId: true } },
    },
  });

  for (const l of lines) {
    const valueId = l.dimensions[0]?.valueId;
    const column = (valueId && opts.columnOf.get(valueId)) || UNALLOCATED;
    const row = byAccount.get(l.account.id) ?? {
      accountId: l.account.id,
      code: l.account.code,
      name: l.account.name,
      nameAr: l.account.nameAr,
      type: l.account.type,
      byColumn: new Map<string, bigint>(),
    };
    row.byColumn.set(column, (row.byColumn.get(column) ?? 0n) + l.functionalAmountMinor);
    byAccount.set(l.account.id, row);
  }

  return byAccount;
}

/** The book every statement is read from. */
async function primaryBook(orgId: string, entityId: string) {
  const book = await prisma.book.findFirst({ where: { orgId, entityId, code: "PRIMARY" } });
  if (!book) throw new LedgerError("No ledger has been opened for this entity.");
  return book;
}

const at = (row: DimBal, key: string) => row.byColumn.get(key) ?? 0n;

const perColumn = (columns: DimensionColumn[], f: (key: string) => bigint): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const c of columns) out[c.key] = f(c.key).toString();
  return out;
};

const sumColumns = (columns: DimensionColumn[], f: (key: string) => bigint): bigint =>
  columns.reduce((a, c) => a + f(c.key), 0n);

/**
 * Build a section. `naturalSide` says which sign is "positive" for the reader,
 * exactly as statements.ts does it: revenue lives on the credit side, so its
 * presented figure is the negated ledger balance. The ledger's own sign is kept
 * alongside it and never overwritten.
 */
function dimSection(
  key: string,
  label: string,
  rows: DimBal[],
  naturalSide: "debit" | "credit",
  columns: DimensionColumn[],
): DimensionalSection {
  const flip = naturalSide === "credit" ? -1n : 1n;

  const lines = rows
    // A row is dropped only when every column is zero — never when one is.
    .filter((r) => columns.some((c) => at(r, c.key) !== 0n))
    .map((r) => {
      const total = sumColumns(columns, (k) => at(r, k));
      return {
        code: r.code,
        name: r.name,
        nameAr: r.nameAr,
        balanceMinor: perColumn(columns, (k) => at(r, k)),
        presentedMinor: perColumn(columns, (k) => at(r, k) * flip),
        totalBalanceMinor: total.toString(),
        totalPresentedMinor: (total * flip).toString(),
      };
    });

  const totalMinor = perColumn(columns, (k) => rows.reduce((a, r) => a + at(r, k), 0n) * flip);
  const grandTotal = sumColumns(columns, (k) => BigInt(totalMinor[k]));

  return { key, label, lines, totalMinor, grandTotalMinor: grandTotal.toString() };
}

/** Cost of sales is the 5xxx block; other expenses are 6xxx — as statements.ts. */
const isCostOfSales = (r: DimBal) => r.code.startsWith("5");

/* ------------------------------------------------------------- the reports */

/**
 * A profit and loss with one column per dimension value, plus Unallocated.
 *
 * The date rules are the ones balances() uses in statements.ts: every period
 * that overlaps the range, cut to the range by entry date, so a mid-period
 * "to" stops at the date rather than swallowing the rest of the month.
 */
export async function dimensionalProfitAndLoss(opts: {
  orgId: string;
  entityId: string;
  from: string;
  to: string;
  dimensionCode: string;
}): Promise<DimensionalProfitAndLoss> {
  const from = new Date(opts.from);
  const to = new Date(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new LedgerError("A statement needs valid dates.");
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const { dimension, columns, columnOf } = await resolveDimension(opts.orgId, opts.dimensionCode);
  const book = await primaryBook(opts.orgId, opts.entityId);

  const periods = await prisma.accountingPeriod.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, startsOn: { lte: to }, endsOn: { gte: from } },
    select: { id: true },
  });

  const byAccount = await attributeLines({
    orgId: opts.orgId,
    entityId: opts.entityId,
    bookId: book.id,
    dimensionId: dimension.id,
    periodIds: periods.map((p) => p.id),
    columnOf,
    from,
    to,
  });

  const rows = [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  const revenue = dimSection("revenue", "Revenue", rows.filter((r) => r.type === "INCOME"), "credit", columns);
  const cos = dimSection("cost_of_sales", "Cost of sales", rows.filter((r) => r.type === "EXPENSE" && isCostOfSales(r)), "debit", columns);
  const opex = dimSection("expenses", "Operating expenses", rows.filter((r) => r.type === "EXPENSE" && !isCostOfSales(r)), "debit", columns);

  const gross = perColumn(columns, (k) => BigInt(revenue.totalMinor[k]) - BigInt(cos.totalMinor[k]));
  const net = perColumn(columns, (k) => BigInt(gross[k]) - BigInt(opex.totalMinor[k]));
  const totalGross = sumColumns(columns, (k) => BigInt(gross[k]));
  const totalNet = sumColumns(columns, (k) => BigInt(net[k]));

  // The reconciliation. The control figure comes from the ordinary profit and
  // loss, which reads the period-anchored cache; this report summed journal
  // lines. Two different paths over the same facts: if they disagree, one of
  // them is wrong and nobody should be acting on either until it is known
  // which. That is why the difference is returned rather than absorbed.
  const control = await profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from: opts.from, to: opts.to });
  const differences = {
    revenue: BigInt(revenue.grandTotalMinor) - BigInt(control.revenue.totalMinor),
    costOfSales: BigInt(cos.grandTotalMinor) - BigInt(control.costOfSales.totalMinor),
    expenses: BigInt(opex.grandTotalMinor) - BigInt(control.expenses.totalMinor),
    netProfit: totalNet - BigInt(control.netProfitMinor),
  };
  const reconciles = Object.values(differences).every((d) => d === 0n);

  return {
    from: opts.from,
    to: opts.to,
    currency: book.functionalCurrency,
    dimensionCode: dimension.code,
    dimensionName: dimension.name,
    columns,
    revenue,
    costOfSales: cos,
    grossProfitMinor: gross,
    totalGrossProfitMinor: totalGross.toString(),
    expenses: opex,
    netProfitMinor: net,
    totalNetProfitMinor: totalNet.toString(),
    reconciles,
    differenceMinor: differences.netProfit.toString(),
    reconciliation: {
      controlNetProfitMinor: control.netProfitMinor,
      differencesMinor: {
        revenue: differences.revenue.toString(),
        costOfSales: differences.costOfSales.toString(),
        expenses: differences.expenses.toString(),
        netProfit: differences.netProfit.toString(),
      },
    },
  };
}

/**
 * Totals per value with each value's share of the basis, in basis points.
 *
 * Basis points and BigInt division, never a percentage as a float: a share that
 * disagrees with itself at the fourth decimal place is a share two people can
 * argue about, which is the whole problem a cost-centre report exists to end.
 * Shares are truncated toward zero, so no column is ever overstated, and what
 * the truncation drops is reported as roundingRemainderBps rather than being
 * pushed into the biggest column to make the arithmetic look tidy.
 */
export async function dimensionSummary(opts: {
  orgId: string;
  entityId: string;
  from: string;
  to: string;
  dimensionCode: string;
  /** Defaults to expenses — the cost-centre question is where the money went. */
  basis?: SummaryBasis;
}): Promise<DimensionSummary> {
  const basis: SummaryBasis = opts.basis ?? "expenses";
  // Built on the dimensional profit and loss rather than a second read of the
  // ledger, so a summary can never disagree with the report above it.
  const pl = await dimensionalProfitAndLoss(opts);

  const figure = (key: string, which: SummaryBasis): bigint => {
    if (which === "revenue") return BigInt(pl.revenue.totalMinor[key]);
    if (which === "netProfit") return BigInt(pl.netProfitMinor[key]);
    return BigInt(pl.expenses.totalMinor[key]) + BigInt(pl.costOfSales.totalMinor[key]);
  };

  const basisTotal = sumColumns(pl.columns, (k) => figure(k, basis));

  let allocated = 0n;
  const rows: DimensionSummaryRow[] = pl.columns.map((c) => {
    // A zero basis has no shares to give out; report that rather than dividing.
    const shareBps = basisTotal === 0n ? null : (figure(c.key, basis) * 10_000n) / basisTotal;
    if (shareBps !== null) allocated += shareBps;
    return {
      key: c.key,
      label: c.label,
      isUnallocated: c.isUnallocated,
      revenueMinor: pl.revenue.totalMinor[c.key],
      costOfSalesMinor: pl.costOfSales.totalMinor[c.key],
      expensesMinor: pl.expenses.totalMinor[c.key],
      netProfitMinor: pl.netProfitMinor[c.key],
      shareBps: shareBps === null ? null : shareBps.toString(),
    };
  });

  return {
    from: pl.from,
    to: pl.to,
    currency: pl.currency,
    dimensionCode: pl.dimensionCode,
    dimensionName: pl.dimensionName,
    basis,
    basisTotalMinor: basisTotal.toString(),
    rows,
    roundingRemainderBps: (basisTotal === 0n ? 0n : 10_000n - allocated).toString(),
    reconciles: pl.reconciles,
    differenceMinor: pl.differenceMinor,
  };
}

/**
 * The same idea for the balance sheet: each balance-sheet account split by
 * dimension value, cumulative to the end of a period exactly as trialBalance()
 * is. `valueCode` narrows what is shown to one cost centre — the reconciliation
 * is still computed across every column, so filtering the view never disables
 * the check.
 */
export async function dimensionalTrialBalance(opts: {
  orgId: string;
  entityId: string;
  periodLabel: string;
  dimensionCode: string;
  valueCode?: string;
}): Promise<DimensionalTrialBalance> {
  const { dimension, columns, columnOf } = await resolveDimension(opts.orgId, opts.dimensionCode);
  const book = await primaryBook(opts.orgId, opts.entityId);

  const period = await prisma.accountingPeriod.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, label: opts.periodLabel },
  });
  if (!period) throw new LedgerError(`There is no accounting period "${opts.periodLabel}" for this entity. Open the fiscal year first.`);

  // Cumulative to the end of the period, which is the rule trialBalance() uses.
  const upto = await prisma.accountingPeriod.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, endsOn: { lte: period.endsOn } },
    select: { id: true },
  });

  const byAccount = await attributeLines({
    orgId: opts.orgId,
    entityId: opts.entityId,
    bookId: book.id,
    dimensionId: dimension.id,
    periodIds: upto.map((p) => p.id),
    columnOf,
  });

  const control = await trialBalance({ orgId: opts.orgId, entityId: opts.entityId, periodLabel: opts.periodLabel });
  const controlBy = new Map(control.rows.map((r) => [r.code, r.balanceMinor]));

  const BALANCE_SHEET = new Set(["ASSET", "LIABILITY", "EQUITY"]);
  const all = [...byAccount.values()]
    .filter((r) => BALANCE_SHEET.has(r.type))
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  // Checked across every column before any filtering, so "show me OPS" cannot
  // quietly turn the control off.
  let difference = 0n;
  for (const r of all) {
    difference += sumColumns(columns, (k) => at(r, k)) - (controlBy.get(r.code) ?? 0n);
  }

  let shown = columns;
  if (opts.valueCode !== undefined) {
    const key = normaliseCode(opts.valueCode, "dimension value");
    const column = columns.find((c) => c.key === key);
    if (!column) {
      throw new LedgerError(`There is no ${dimension.code} value "${key}". Add it before filtering a report by it.`);
    }
    shown = [column];
  }

  const rows: DimensionalTrialBalanceRow[] = all
    .filter((r) => shown.some((c) => at(r, c.key) !== 0n))
    .map((r) => ({
      code: r.code,
      name: r.name,
      nameAr: r.nameAr,
      type: r.type,
      balanceMinor: perColumn(shown, (k) => at(r, k)),
      totalMinor: sumColumns(columns, (k) => at(r, k)).toString(),
      controlMinor: (controlBy.get(r.code) ?? 0n).toString(),
    }));

  const totalDebitMinor = perColumn(shown, (k) => all.reduce((a, r) => (at(r, k) > 0n ? a + at(r, k) : a), 0n));
  const totalCreditMinor = perColumn(shown, (k) => all.reduce((a, r) => (at(r, k) < 0n ? a - at(r, k) : a), 0n));

  return {
    periodLabel: period.label,
    currency: book.functionalCurrency,
    dimensionCode: dimension.code,
    dimensionName: dimension.name,
    columns: shown,
    rows,
    totalDebitMinor,
    totalCreditMinor,
    reconciles: difference === 0n,
    differenceMinor: difference.toString(),
  };
}
