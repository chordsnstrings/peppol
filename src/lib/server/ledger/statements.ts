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
 */

export interface StatementLine {
  code: string;
  name: string;
  nameAr: string | null;
  /** Signed, debit-positive, as the ledger holds it. */
  balanceMinor: string;
  /** Presented on the account's natural side, always positive. */
  presentedMinor: string;
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
}

export interface BalanceSheet {
  asOf: string;
  currency: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  /** Retained earnings plus the profit earned so far this year. */
  currentYearEarningsMinor: string;
  totalAssetsMinor: string;
  totalLiabilitiesAndEquityMinor: string;
  /** The whole point. */
  balanced: boolean;
  differenceMinor: string;
}

type Bal = { code: string; name: string; nameAr: string | null; type: string; subtype: string | null; balance: bigint };

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
async function balances(opts: {
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

  const byAccount = new Map<string, Bal>();
  const add = (
    acc: { id: string; code: string; name: string; nameAr: string | null; type: string; subtype: string | null },
    amount: bigint,
  ) => {
    const prev = byAccount.get(acc.id);
    if (prev) prev.balance += amount;
    else byAccount.set(acc.id, {
      code: acc.code, name: acc.name, nameAr: acc.nameAr,
      type: acc.type, subtype: acc.subtype, balance: amount,
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
    }));
  const total = rows.reduce((a, r) => a + r.balance, 0n) * flip;
  return { key, label, lines, totalMinor: total.toString() };
}

/** Cost of sales is the 5xxx block; other expenses are 6xxx. */
const isCostOfSales = (r: Bal) => r.code.startsWith("5");

export async function profitAndLoss(opts: {
  orgId: string; entityId: string; from: string; to: string;
}): Promise<ProfitAndLoss> {
  const from = new Date(opts.from), to = new Date(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new LedgerError("A statement needs valid dates.");
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const { rows, currency } = await balances({ orgId: opts.orgId, entityId: opts.entityId, from, to });

  const revenue = section("revenue", "Revenue", rows.filter((r) => r.type === "INCOME"), "credit");
  const cos = section("cost_of_sales", "Cost of sales", rows.filter((r) => r.type === "EXPENSE" && isCostOfSales(r)), "debit");
  const opex = section("expenses", "Operating expenses", rows.filter((r) => r.type === "EXPENSE" && !isCostOfSales(r)), "debit");

  const rev = BigInt(revenue.totalMinor);
  const gross = rev - BigInt(cos.totalMinor);
  const net = gross - BigInt(opex.totalMinor);

  return {
    from: opts.from, to: opts.to, currency,
    revenue, costOfSales: cos, grossProfitMinor: gross.toString(),
    expenses: opex, netProfitMinor: net.toString(),
    // Basis points keep this exact; a margin as a float is a margin that
    // disagrees with itself at the fourth decimal place.
    grossMarginBps: rev === 0n ? null : Number((gross * 10_000n) / rev),
  };
}

export async function balanceSheet(opts: {
  orgId: string; entityId: string; asOf: string;
}): Promise<BalanceSheet> {
  const asOf = new Date(opts.asOf);
  if (Number.isNaN(asOf.getTime())) throw new LedgerError("A balance sheet needs a valid date.");

  const { rows, currency } = await balances({ orgId: opts.orgId, entityId: opts.entityId, to: asOf });

  const assets = section("assets", "Assets", rows.filter((r) => r.type === "ASSET"), "debit");
  const liabilities = section("liabilities", "Liabilities", rows.filter((r) => r.type === "LIABILITY"), "credit");
  const postedEquity = rows.filter((r) => r.type === "EQUITY");

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
    });
    equity.totalMinor = (BigInt(equity.totalMinor) + currentYear).toString();
  }

  const totalAssets = BigInt(assets.totalMinor);
  const totalLiabEq = BigInt(liabilities.totalMinor) + BigInt(equity.totalMinor);

  return {
    asOf: opts.asOf, currency, assets, liabilities, equity,
    currentYearEarningsMinor: currentYear.toString(),
    totalAssetsMinor: totalAssets.toString(),
    totalLiabilitiesAndEquityMinor: totalLiabEq.toString(),
    balanced: totalAssets === totalLiabEq,
    differenceMinor: (totalAssets - totalLiabEq).toString(),
  };
}
