import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";

/**
 * The two statements every set of books exists to produce.
 *
 * Both are built from the period-anchored balance cache, so they answer as
 * quickly on the ten-millionth journal line as on the first, and both are
 * built from the same read so they can never tell different stories about the
 * same month.
 *
 * The part worth attention is current-year earnings. Income and expense
 * accounts accumulate within a fiscal year and are closed to equity at the end
 * of it; the balance sheet has to include the profit earned *so far this year*
 * or it will not balance. That figure is not a posted balance — it is computed
 * from the profit and loss for the same period, which is why the two statements
 * are produced together rather than independently.
 *
 * The balance sheet also splits assets and liabilities into current and
 * non-current, which IAS 1.60 requires of anyone not presenting in order of
 * liquidity. The split is a partition of the sections it sits beside rather
 * than a second set of figures, and where it comes from — the chart's own
 * hierarchy first, the account number only as a fallback — is set out at
 * `classifyChart`, because reading the number alone is what put deferred tax
 * in the wrong half of the current ratio.
 */

export interface StatementLine {
  code: string;
  name: string;
  nameAr: string | null;
  /** Signed, debit-positive, as the ledger holds it. */
  balanceMinor: string;
  /** Presented on the account's natural side, always positive. */
  presentedMinor: string;
  /** Current or non-current — see `classifyChart`. Null on income and expenses. */
  classification: BalanceSheetClass | null;
}

export interface StatementSection {
  key: string;
  label: string;
  lines: StatementLine[];
  totalMinor: string;
}

export interface ProfitAndLoss {
  from: string;
  to: string;
  currency: string;
  revenue: StatementSection;
  costOfSales: StatementSection;
  grossProfitMinor: string;
  expenses: StatementSection;
  netProfitMinor: string;
  /** Gross profit over revenue, in basis points — no floats in a ledger. */
  grossMarginBps: number | null;
  /**
   * IAS 1.7: income and expense not recognised in profit or loss.
   *
   * There was no such section, so there was no total comprehensive income
   * figure anywhere in the product — and this ledger produces a genuine OCI
   * item, the revaluation surplus under IAS 16.39-.40, which is credited
   * straight to equity and never touches the profit and loss. Without this the
   * statement of changes in equity had a movement no primary statement
   * explained, and IAS 1.81A's requirement for a total was simply not met.
   */
  otherComprehensiveIncome: StatementSection & {
    /** Items that will not be reclassified to profit or loss (IAS 1.82A(a)). */
    neverReclassifiedMinor: string;
  };
  totalComprehensiveIncomeMinor: string;
}

export interface BalanceSheet {
  asOf: string;
  currency: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  /**
   * The same assets and liabilities again, split the way IAS 1.60 requires.
   *
   * These four are a partition of `assets` and `liabilities`, not additions to
   * them: current plus non-current plus whatever could not be classified is the
   * whole section, every time. The undivided sections stay because a reader
   * comparing to a trial balance wants them, and because every other module
   * that consumes a balance sheet was written against them.
   */
  currentAssets: StatementSection;
  nonCurrentAssets: StatementSection;
  currentLiabilities: StatementSection;
  nonCurrentLiabilities: StatementSection;
  /**
   * Assets and liabilities the chart could place in neither. Empty on the
   * seeded chart; a hand-added account with no parent and a code outside the
   * usual bands lands here rather than being guessed into one side, because a
   * current ratio that quietly swallowed a long-term loan is worse than one
   * that says which account it could not place.
   */
  unclassifiedAssets: StatementSection;
  unclassifiedLiabilities: StatementSection;
  /** Current assets less current liabilities — IAS 1.55, the working capital line. */
  netCurrentAssetsMinor: string;
  /** Retained earnings plus the profit earned so far this year. */
  currentYearEarningsMinor: string;
  totalAssetsMinor: string;
  totalLiabilitiesAndEquityMinor: string;
  /** The whole point. */
  balanced: boolean;
  differenceMinor: string;
}

export type Bal = {
  code: string; name: string; nameAr: string | null; type: string; subtype: string | null;
  classification: BalanceSheetClass | null;
  balance: bigint;
};

/* ------------------------------------------------ current and non-current */

export type BalanceSheetClass =
  | "CURRENT_ASSET"
  | "NON_CURRENT_ASSET"
  | "CURRENT_LIABILITY"
  | "NON_CURRENT_LIABILITY";

/** What a chart account has to carry for its classification to be worked out. */
export interface ClassifiableAccount {
  id: string;
  code: string;
  type: string;
  subtype: string | null;
  parentId: string | null;
}

/**
 * The seeded chart's own section headings. An account hung under one of these
 * has been classified by whoever put it there, which is the answer this asks
 * for first.
 */
const SECTION_PARENT: Record<string, BalanceSheetClass> = {
  "10": "CURRENT_ASSET",
  "15": "NON_CURRENT_ASSET",
  "20": "CURRENT_LIABILITY",
  "25": "NON_CURRENT_LIABILITY",
};

/**
 * Subtypes a standard classifies outright, whatever the chart says.
 *
 * IAS 1.56: "When an entity presents current and non-current assets, and
 * current and non-current liabilities, as separate classifications in its
 * statement of financial position, it shall not classify deferred tax assets
 * (liabilities) as current assets (liabilities)." It is not a judgement about
 * when the difference reverses and it is not negotiable by filing the account
 * somewhere else, so it is settled before the hierarchy is even read.
 */
const SUBTYPE_CLASS: Record<string, BalanceSheetClass> = {
  DEFERRED_TAX_ASSET: "NON_CURRENT_ASSET",
  DEFERRED_TAX_LIABILITY: "NON_CURRENT_LIABILITY",
};

/** The last resort: the numbering convention the seeded chart follows. */
const BANDS: { re: RegExp; cls: BalanceSheetClass }[] = [
  { re: /^1[0-4]/, cls: "CURRENT_ASSET" },
  { re: /^1[5-9]/, cls: "NON_CURRENT_ASSET" },
  { re: /^2[0-4]/, cls: "CURRENT_LIABILITY" },
  { re: /^2[5-9]/, cls: "NON_CURRENT_LIABILITY" },
];

const CLASS_TYPE: Record<BalanceSheetClass, "ASSET" | "LIABILITY"> = {
  CURRENT_ASSET: "ASSET",
  NON_CURRENT_ASSET: "ASSET",
  CURRENT_LIABILITY: "LIABILITY",
  NON_CURRENT_LIABILITY: "LIABILITY",
};

/**
 * Which side of the current/non-current line every account falls, and why.
 *
 * IAS 1.60 requires assets and liabilities to be presented split between
 * current and non-current unless a liquidity presentation is more relevant, and
 * IAS 1.66 and 1.69 define which is which. No journal line carries the answer,
 * so it has to come from the chart — and the chart states it twice, in two
 * places that can disagree.
 *
 * THE HIERARCHY IS THE AUTHORITY. The seeded chart hangs current assets under
 * 10, non-current assets under 15, current liabilities under 20 and non-current
 * liabilities under 25. Where an account has one of those as an ancestor, that
 * IS its classification: a person decided it, on the account, deliberately.
 *
 * THE CODE BAND IS A FALLBACK, for an account added by hand with no parent at
 * all. The convention is real and the numbering is widely followed here, so
 * dropping it would classify nothing in a hand-built chart — but it is a guess
 * about what a number means, and it is wrong for exactly the accounts where it
 * matters. 1320 deferred tax asset is parented to 15 and numbered inside the
 * 1000-1499 band; reading the band alone called it current, which IAS 1.56
 * forbids outright, and it then fed the current ratio, the quick ratio and
 * working capital. 2320 did the same on the other side.
 *
 * A section parent whose side contradicts the account's own type is ignored
 * rather than obeyed — a liability filed under "current assets" is a mistake in
 * the chart, and inheriting from it would turn one mistake into a wrong
 * statement. The walk keeps going up, and the band decides if nothing else does.
 *
 * Anything that is neither an asset nor a liability is null: equity, income and
 * expenses are not classified this way and never appear on either side.
 */
export function classifyChart(accounts: ClassifiableAccount[]): Map<string, BalanceSheetClass | null> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const out = new Map<string, BalanceSheetClass | null>();
  for (const account of accounts) out.set(account.code, classifyOne(account, byId));
  return out;
}

function classifyOne(
  account: ClassifiableAccount,
  byId: Map<string, ClassifiableAccount>,
): BalanceSheetClass | null {
  if (account.type !== "ASSET" && account.type !== "LIABILITY") return null;

  const bySubtype = SUBTYPE_CLASS[account.subtype ?? ""];
  if (bySubtype && CLASS_TYPE[bySubtype] === account.type) return bySubtype;

  // A chart is a tree, but it is a tree held in rows that nothing stops from
  // pointing in a circle. Walking it with a guard costs one Set and cannot hang.
  const seen = new Set<string>();
  let node: ClassifiableAccount | undefined = account;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    const section = SECTION_PARENT[node.code];
    if (section && CLASS_TYPE[section] === account.type) return section;
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }

  for (const band of BANDS) {
    if (band.re.test(account.code) && CLASS_TYPE[band.cls] === account.type) return band.cls;
  }
  return null;
}

/**
 * Balances for a date range.
 *
 * Periods that have fully elapsed come from the anchor cache, which is what
 * keeps this fast as the ledger grows. A period that straddles either end of
 * the range cannot: its anchor covers the whole period, including postings
 * outside the range. Those are summed from the journal lines themselves, which
 * is at most one or two periods' worth of rows.
 *
 * Reading only fully-elapsed periods would be simpler and wrong in the way that
 * matters most — a balance sheet "as at today" would omit the whole current
 * month, which is the month anyone actually asks about.
 */
export async function balances(opts: {
  orgId: string; entityId: string; to: Date; from?: Date;
}): Promise<{ rows: Bal[]; currency: string }> {
  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
  });
  if (!book) throw new LedgerError("No ledger has been opened for this entity.");

  const inRange = await prisma.accountingPeriod.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      startsOn: { lte: opts.to },
      ...(opts.from ? { endsOn: { gte: opts.from } } : {}),
    },
    select: { id: true, startsOn: true, endsOn: true },
  });

  // A period is wholly inside the range only if both its ends are.
  const whole = inRange.filter(
    (p) => p.endsOn <= opts.to && (!opts.from || p.startsOn >= opts.from),
  );
  const partial = inRange.filter((p) => !whole.some((w) => w.id === p.id));

  // The whole chart, for the classification alone. It cannot be taken from the
  // accounts that carry balances: the section headings an account inherits its
  // classification from (10, 15, 20, 25) are not postable and never hold one,
  // so the parent chain would end at an id nothing in the result explains. It
  // is one small read of one entity's chart against a query over its journal.
  const chart = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    select: { id: true, code: true, type: true, subtype: true, parentId: true },
  });
  const classOf = classifyChart(chart);

  const byAccount = new Map<string, Bal>();
  const add = (
    acc: { id: string; code: string; name: string; nameAr: string | null; type: string; subtype: string | null },
    amount: bigint,
  ) => {
    const prev = byAccount.get(acc.id);
    if (prev) prev.balance += amount;
    else byAccount.set(acc.id, {
      code: acc.code, name: acc.name, nameAr: acc.nameAr,
      type: acc.type, subtype: acc.subtype,
      classification: classOf.get(acc.code) ?? null,
      balance: amount,
    });
  };

  if (whole.length) {
    const cached = await prisma.accountBalance.findMany({
      where: { bookId: book.id, periodId: { in: whole.map((p) => p.id) }, currency: book.functionalCurrency },
      include: { account: true },
    });
    for (const b of cached) add(b.account, b.closingMinor);
  }

  if (partial.length) {
    const lines = await prisma.journalLine.findMany({
      where: {
        orgId: opts.orgId,
        entry: {
          entityId: opts.entityId, bookId: book.id,
          // A reversed entry's lines are real postings that happened; the
          // separate reversing entry is what offsets them. Counting only
          // "posted" drops the original while keeping the reversal, so a
          // statement cut mid-period comes out wrong by the reversal — and in
          // the wrong direction, since only the offsetting half survives. The
          // balance cache counts both, so this has to as well or the two paths
          // disagree about the same month.
          status: { in: ["posted", "reversed"] },
          periodId: { in: partial.map((p) => p.id) },
          entryDate: { lte: opts.to, ...(opts.from ? { gte: opts.from } : {}) },
        },
      },
      include: { account: true },
    });
    for (const l of lines) add(l.account, l.functionalAmountMinor);
  }

  return {
    rows: [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    currency: book.functionalCurrency,
  };
}

/**
 * Build a section. `naturalSide` says which sign is "positive" for the reader:
 * revenue and liabilities live on the credit side, so their presented figure is
 * the negated ledger balance. Getting this wrong is how a statement ends up
 * showing income as a negative number.
 */
function section(key: string, label: string, rows: Bal[], naturalSide: "debit" | "credit"): StatementSection {
  const flip = naturalSide === "credit" ? -1n : 1n;
  const lines = rows
    .filter((r) => r.balance !== 0n)
    .map((r) => ({
      code: r.code, name: r.name, nameAr: r.nameAr,
      balanceMinor: r.balance.toString(),
      presentedMinor: (r.balance * flip).toString(),
      classification: r.classification,
    }));
  const total = rows.reduce((a, r) => a + r.balance, 0n) * flip;
  return { key, label, lines, totalMinor: total.toString() };
}

/**
 * What went to equity in the period without passing through profit or loss.
 *
 * Two things make this more than a movement on an equity account.
 *
 * FIRST, not every movement on the revaluation surplus is other comprehensive
 * income. `releaseSurplus` moves realised surplus from 3300 to 3900 as an
 * asset is used or sold, and IAS 16.41 is explicit that the transfer is not
 * made through profit or loss — it is not made through OCI either. Counting it
 * would report income twice: once when the asset was revalued and again when
 * the surplus was released, for the same uplift. So it is excluded by the
 * source the transfer posts under rather than by its sign, which would be a
 * guess.
 *
 * SECOND, the section is presented on the same footing as revenue: a credit is
 * income, so a revaluation increase reads positive and a decrease negative,
 * matching how every other income figure on this statement reads.
 *
 * Every item this ledger can produce is one that will NEVER be reclassified to
 * profit or loss — IAS 1.82A(a) — because a revaluation surplus goes to
 * retained earnings on realisation and not back through the income statement.
 * The split is stated rather than assumed, so an entity that later acquires a
 * cash-flow hedge or a foreign operation has somewhere for it to go.
 */
async function otherComprehensiveIncome(opts: {
  orgId: string;
  entityId: string;
  from: Date;
  to: Date;
  rows: Bal[];
}): Promise<ProfitAndLoss["otherComprehensiveIncome"]> {
  const ociRows = opts.rows.filter((r) => r.type === "EQUITY" && OCI_SUBTYPES.has(r.subtype ?? ""));

  if (ociRows.length === 0 || ociRows.every((r) => r.balance === 0n)) {
    const empty = section("other_comprehensive_income", "Other comprehensive income", ociRows, "credit");
    return { ...empty, neverReclassifiedMinor: empty.totalMinor };
  }

  // The part of the movement that is a transfer within equity rather than
  // income. Read from the journal rather than inferred, because a release and a
  // downward revaluation are the same sign on the same account.
  const transfers = await prisma.journalLine.groupBy({
    by: ["accountId"],
    where: {
      orgId: opts.orgId,
      account: { code: { in: ociRows.map((r) => r.code) }, entityId: opts.entityId },
      entry: {
        entityId: opts.entityId,
        status: { in: ["posted", "reversed"] },
        entryDate: { gte: opts.from, lte: opts.to },
        sourceType: { in: [...WITHIN_EQUITY_SOURCE_TYPES] },
      },
    },
    _sum: { functionalAmountMinor: true },
  });

  const accounts = transfers.length
    ? await prisma.account.findMany({
        where: { id: { in: transfers.map((t) => t.accountId) } },
        select: { id: true, code: true },
      })
    : [];
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]));
  const transferBy = new Map<string, bigint>();
  for (const t of transfers) {
    const code = codeOf.get(t.accountId);
    if (code) transferBy.set(code, (transferBy.get(code) ?? 0n) + (t._sum.functionalAmountMinor ?? 0n));
  }

  const adjusted = ociRows.map((r) => ({ ...r, balance: r.balance - (transferBy.get(r.code) ?? 0n) }));
  const built = section("other_comprehensive_income", "Other comprehensive income", adjusted, "credit");
  return { ...built, neverReclassifiedMinor: built.totalMinor };
}

/** Equity accounts whose movement is other comprehensive income, by subtype. */
const OCI_SUBTYPES = new Set(["REVALUATION_SURPLUS"]);

/**
 * Sources that move an OCI reserve WITHIN equity rather than through it.
 *
 * `releaseSurplus` is the one this ledger has: realised surplus moving from
 * 3300 to 3900 as an asset is depreciated or sold.
 */
const WITHIN_EQUITY_SOURCE_TYPES = ["SURPLUS_TRANSFER"] as const;

/** A ratio in basis points, rounded to the nearest and away from zero. */
function roundedBps(numerator: bigint, denominator: bigint): bigint {
  const n = numerator * 10_000n;
  const d = denominator < 0n ? -denominator : denominator;
  const signed = denominator < 0n ? -n : n;
  const half = d / 2n;
  return signed >= 0n ? (signed + half) / d : -((-signed + half) / d);
}

/** Cost of sales is the 5xxx block; other expenses are 6xxx. */
const isCostOfSales = (r: Bal) => r.code.startsWith("5");

/**
 * Take the year-end close back out of a profit and loss.
 *
 * Closing a year debits every income account and credits every expense account
 * to nothing, and moves the result to retained earnings. That is a
 * reclassification into equity, not trading — but it is a posting like any
 * other, dated on the last day of the year, so any range covering the year
 * picks it up and every income and expense account reads nil.
 *
 * The consequence is not cosmetic. A corporate tax computation run after the
 * year was closed read accounting profit of nothing, and therefore tax of
 * nothing, with no indication that anything was wrong. A profit and loss is a
 * statement about trading; the close belongs in the statement of changes in
 * equity, where it is what moved retained earnings.
 *
 * The balance sheet is deliberately left alone: there the close is exactly
 * right, and taking it out would count the year's result twice.
 */
export async function removeYearEndClose(opts: {
  orgId: string; entityId: string; from: Date; to: Date; rows: Bal[];
}) {
  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      account: { entityId: opts.entityId, type: { in: ["INCOME", "EXPENSE"] } },
      entry: {
        entityId: opts.entityId,
        source: "close",
        status: { in: ["posted", "reversed"] },
        entryDate: { gte: opts.from, lte: opts.to },
      },
    },
    select: { functionalAmountMinor: true, account: { select: { code: true } } },
  });
  if (!lines.length) return;

  const byCode = new Map<string, bigint>();
  for (const l of lines) {
    byCode.set(l.account.code, (byCode.get(l.account.code) ?? 0n) + l.functionalAmountMinor);
  }
  for (const r of opts.rows) {
    const adj = byCode.get(r.code);
    if (adj) r.balance -= adj;
  }
}

export async function profitAndLoss(opts: {
  orgId: string; entityId: string; from: string; to: string;
}): Promise<ProfitAndLoss> {
  const from = new Date(opts.from), to = new Date(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new LedgerError("A statement needs valid dates.");
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const { rows, currency } = await balances({ orgId: opts.orgId, entityId: opts.entityId, from, to });
  await removeYearEndClose({ orgId: opts.orgId, entityId: opts.entityId, from, to, rows });

  const revenue = section("revenue", "Revenue", rows.filter((r) => r.type === "INCOME"), "credit");
  const cos = section("cost_of_sales", "Cost of sales", rows.filter((r) => r.type === "EXPENSE" && isCostOfSales(r)), "debit");
  const opex = section("expenses", "Operating expenses", rows.filter((r) => r.type === "EXPENSE" && !isCostOfSales(r)), "debit");

  const rev = BigInt(revenue.totalMinor);
  const gross = rev - BigInt(cos.totalMinor);
  const net = gross - BigInt(opex.totalMinor);

  const oci = await otherComprehensiveIncome({
    orgId: opts.orgId, entityId: opts.entityId, from, to, rows,
  });

  return {
    from: opts.from, to: opts.to, currency,
    revenue, costOfSales: cos, grossProfitMinor: gross.toString(),
    expenses: opex, netProfitMinor: net.toString(),
    otherComprehensiveIncome: oci,
    totalComprehensiveIncomeMinor: (net + BigInt(oci.totalMinor)).toString(),
    // Basis points rather than a float, because a margin held as a double
    // disagrees with itself at the fourth decimal place. Rounded to the
    // nearest, away from zero: integer division truncates towards zero, which
    // would round a negative margin up and a positive one down and make the
    // two directions read differently for the same distance from the mark.
    grossMarginBps: rev === 0n ? null : Number(roundedBps(gross, rev)),
  };
}

export async function balanceSheet(opts: {
  orgId: string; entityId: string; asOf: string;
}): Promise<BalanceSheet> {
  const asOf = new Date(opts.asOf);
  if (Number.isNaN(asOf.getTime())) throw new LedgerError("A balance sheet needs a valid date.");

  const { rows, currency } = await balances({ orgId: opts.orgId, entityId: opts.entityId, to: asOf });

  const assetRows = rows.filter((r) => r.type === "ASSET");
  const liabilityRows = rows.filter((r) => r.type === "LIABILITY");
  const assets = section("assets", "Assets", assetRows, "debit");
  const liabilities = section("liabilities", "Liabilities", liabilityRows, "credit");
  const postedEquity = rows.filter((r) => r.type === "EQUITY");

  // IAS 1.60, from the chart's own hierarchy rather than from the account
  // numbers — see `classifyChart` for why those two are not the same answer.
  // Each pair is a partition of the section above it, so the subtotals add back
  // to it exactly and a reader can check that they do.
  const of = (source: Bal[], cls: BalanceSheetClass | null) =>
    source.filter((r) => r.classification === cls);
  const currentAssets = section("current_assets", "Current assets", of(assetRows, "CURRENT_ASSET"), "debit");
  const nonCurrentAssets = section("non_current_assets", "Non-current assets", of(assetRows, "NON_CURRENT_ASSET"), "debit");
  const unclassifiedAssets = section("unclassified_assets", "Assets not classified", of(assetRows, null), "debit");
  const currentLiabilities = section("current_liabilities", "Current liabilities", of(liabilityRows, "CURRENT_LIABILITY"), "credit");
  const nonCurrentLiabilities = section("non_current_liabilities", "Non-current liabilities", of(liabilityRows, "NON_CURRENT_LIABILITY"), "credit");
  const unclassifiedLiabilities = section("unclassified_liabilities", "Liabilities not classified", of(liabilityRows, null), "credit");

  // Profit earned but not yet closed to equity is not a posted balance
  // anywhere, so the sheet is out by exactly that amount without it — the
  // classic first defect in a new set of books, and one that reads as a ledger
  // fault rather than a missing line.
  //
  // It is the sum of every income and expense balance as at this date, which is
  // exact by construction: closing a year brings those accounts to zero and
  // moves the result to retained earnings, so whatever is left in them is
  // precisely what has not been closed. Deriving it from a fiscal year instead
  // meant a date beyond the last one opened silently produced zero here while
  // assets and equity read the whole elapsed ledger — the sheet then reported
  // itself unbalanced and the screen told the reader to report a defect that
  // was not in their data.
  const currentYear = rows
    .filter((r) => r.type === "INCOME" || r.type === "EXPENSE")
    .reduce((a, r) => a - r.balance, 0n);

  const equity = section("equity", "Equity", postedEquity, "credit");
  if (currentYear !== 0n) {
    equity.lines.push({
      code: "3950", name: "Current year earnings", nameAr: "أرباح السنة الحالية",
      // Held on the credit side like the rest of equity.
      balanceMinor: (-currentYear).toString(),
      presentedMinor: currentYear.toString(),
      // Equity is neither current nor non-current, and this line is equity.
      classification: null,
    });
    equity.totalMinor = (BigInt(equity.totalMinor) + currentYear).toString();
  }

  const totalAssets = BigInt(assets.totalMinor);
  const totalLiabEq = BigInt(liabilities.totalMinor) + BigInt(equity.totalMinor);

  return {
    asOf: opts.asOf, currency, assets, liabilities, equity,
    currentAssets, nonCurrentAssets, unclassifiedAssets,
    currentLiabilities, nonCurrentLiabilities, unclassifiedLiabilities,
    netCurrentAssetsMinor: (
      BigInt(currentAssets.totalMinor) - BigInt(currentLiabilities.totalMinor)
    ).toString(),
    currentYearEarningsMinor: currentYear.toString(),
    totalAssetsMinor: totalAssets.toString(),
    totalLiabilitiesAndEquityMinor: totalLiabEq.toString(),
    balanced: totalAssets === totalLiabEq,
    differenceMinor: (totalAssets - totalLiabEq).toString(),
  };
}
