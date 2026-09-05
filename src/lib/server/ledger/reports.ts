import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";

/**
 * Ledger reads. The trial balance is served from the period-anchored balance
 * cache, never by summing JournalLine across the whole ledger — that is the
 * query that quietly stops working somewhere past a few million lines.
 *
 * Every figure carries the identifiers needed to drill from a statement line to
 * the journal to the source document.
 */

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  nameAr: string | null;
  type: string;
  debitMinor: bigint;
  creditMinor: bigint;
  /** Signed: debit-positive. */
  balanceMinor: bigint;
}

export interface TrialBalance {
  currency: string;
  periodLabel: string;
  rows: TrialBalanceRow[];
  totalDebitMinor: bigint;
  totalCreditMinor: bigint;
  /** The whole point: this must be 0n. */
  differenceMinor: bigint;
  balanced: boolean;
}

/**
 * Trial balance as at the end of a period (cumulative from the start of the
 * fiscal year for P&L accounts, and inception-to-date for balance-sheet ones —
 * both fall out of summing the period anchors up to and including the period).
 */
export async function trialBalance(opts: {
  orgId: string;
  entityId: string;
  periodLabel: string;
  bookCode?: string;
}): Promise<TrialBalance> {
  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.bookCode ?? "PRIMARY" },
  });
  if (!book) throw new LedgerError("No ledger has been opened for this entity.");

  const period = await prisma.accountingPeriod.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, label: opts.periodLabel },
  });
  if (!period) throw new LedgerError(`No accounting period "${opts.periodLabel}".`);

  const upto = await prisma.accountingPeriod.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, endsOn: { lte: period.endsOn } },
    select: { id: true },
  });

  const balances = await prisma.accountBalance.findMany({
    where: { bookId: book.id, periodId: { in: upto.map((p) => p.id) }, currency: book.functionalCurrency },
    include: { account: true },
  });

  const byAccount = new Map<string, TrialBalanceRow>();
  for (const b of balances) {
    const r = byAccount.get(b.accountId) ?? {
      accountId: b.accountId, code: b.account.code, name: b.account.name, nameAr: b.account.nameAr,
      type: b.account.type, debitMinor: 0n, creditMinor: 0n, balanceMinor: 0n,
    };
    r.debitMinor += b.debitMinor;
    r.creditMinor += b.creditMinor;
    r.balanceMinor += b.closingMinor;
    byAccount.set(b.accountId, r);
  }

  const rows = [...byAccount.values()]
    .filter((r) => r.debitMinor !== 0n || r.creditMinor !== 0n)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  // Present each account on its natural side.
  let totalDebit = 0n, totalCredit = 0n;
  for (const r of rows) {
    if (r.balanceMinor >= 0n) totalDebit += r.balanceMinor;
    else totalCredit += -r.balanceMinor;
  }

  return {
    currency: book.functionalCurrency,
    periodLabel: period.label,
    rows,
    totalDebitMinor: totalDebit,
    totalCreditMinor: totalCredit,
    differenceMinor: totalDebit - totalCredit,
    balanced: totalDebit - totalCredit === 0n,
  };
}

/**
 * The most journal lines one general-ledger read will list, and the number it
 * lists when the caller does not say.
 *
 * The cap is there because a control account holds years of postings and
 * nobody reads them in a browser; the default is small because this screen is
 * a drill-down rather than an export. Neither number reaches the figures: the
 * balances below come from an aggregate over every line that matched, so what
 * the cap costs a reader is detail, never arithmetic.
 */
const GL_PAGE = 200;
const GL_MAX_PAGE = 1000;

export interface GeneralLedgerLine {
  entryId: string;
  reference: string;
  date: Date;
  memo: string | null;
  source: string;
  sourceType: string | null;
  sourceId: string | null;
  status: string;
  debitMinor: bigint;
  creditMinor: bigint;
  /** The account's balance after this line — brought-forward included. */
  runningMinor: bigint;
}

export interface GeneralLedger {
  account: { code: string; name: string; nameAr: string | null; type: string };
  /**
   * What the account held going into the range: everything posted before
   * `from`, and 0n when no `from` was asked for, because nothing precedes the
   * beginning of the ledger.
   */
  openingMinor: bigint;
  /**
   * The balance the first listed line opens from. It is `openingMinor` plus
   * any line inside the range that the page did not reach, so it is the
   * opening figure when the page holds everything and something larger when it
   * does not — which is why the screen labels it rather than assuming.
   */
  broughtForwardMinor: bigint;
  /**
   * What the account held at the end of the range — the opening balance plus
   * everything posted inside it, aggregated over every matching line rather
   * than totalled from the page.
   */
  closingMinor: bigint;
  /** How many lines matched, listed or not. */
  lineCount: number;
  listed: number;
  /** True when lines matched that this read did not list. */
  truncated: boolean;
  lines: GeneralLedgerLine[];
}

/**
 * General-ledger detail for one account — the drill-down target.
 *
 * Three things this owes a reader, and it used to get all three wrong.
 *
 * The page is taken from the NEWEST end. Somebody opening an account wants
 * what has just happened to it; the oldest two hundred lines of the bank
 * account are the two hundred nobody went looking for.
 *
 * The closing balance is an aggregate over every line that matched, not the
 * running total of the page. Summing the page and calling that the closing
 * balance means that on any account with more postings than the limit — the
 * bank, 1100, 2000 and 4000 all pass it inside the first year — the figure
 * presented to a user as the account's balance is the balance as at whichever
 * posting the page happened to stop on, stated as fact.
 *
 * The running balance opens at the balance brought forward rather than at
 * zero, so with a date range every figure in the column is the account's
 * balance on that day rather than the movement since the range began.
 */
export async function generalLedger(opts: {
  orgId: string;
  entityId: string;
  accountCode: string;
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<GeneralLedger> {
  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.accountCode },
  });
  if (!account) throw new LedgerError(`Account ${opts.accountCode} does not exist.`);

  // A limit arriving from a query string is whatever the caller typed, so it is
  // clamped rather than trusted: `Number("many")` is NaN, and NaN reaches
  // Prisma as `take: NaN`, which fails the read rather than the parameter.
  const asked = Number(opts.limit ?? GL_PAGE);
  const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), GL_MAX_PAGE) : GL_PAGE;

  const entryDate =
    opts.from || opts.to
      ? { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) }
      : undefined;

  // A reversed entry still happened: it stands, and its reversal stands beside
  // it, and the two net to nothing. Reading only `posted` would drop the
  // original and keep the mirror, which moves the balance by the full amount
  // in the wrong direction.
  const stands = { in: ["posted", "reversed"] };

  /* One filter, shared by the page and by the totals. The closing balance has
   * to be the balance of exactly the lines this page is a page of, and two
   * separately written where clauses drift apart the first time one of them is
   * edited — which is how a report starts quoting a figure for a set of lines
   * it is not showing. */
  const where = {
    orgId: opts.orgId,
    accountId: account.id,
    entry: { status: stands, ...(entryDate ? { entryDate } : {}) },
  };

  const [totals, before, page] = await Promise.all([
    prisma.journalLine.aggregate({ where, _sum: { txnAmountMinor: true }, _count: { _all: true } }),
    // Everything before the range, folded into one figure so the statement
    // still adds up on its own. Nothing is asked for when no range was given,
    // because the answer could only be nought.
    opts.from
      ? prisma.journalLine.aggregate({
          where: {
            orgId: opts.orgId,
            accountId: account.id,
            entry: { status: stands, entryDate: { lt: opts.from } },
          },
          _sum: { txnAmountMinor: true },
        })
      : null,
    prisma.journalLine.findMany({
      where,
      include: { entry: { select: { id: true, series: true, number: true, entryDate: true, memo: true, source: true, sourceType: true, sourceId: true, status: true } } },
      // Newest first so the page is the newest lines; `createdAt` and the line
      // number break the ties within a day, so a line cannot swap places with
      // its neighbour between two reads and land on a different page.
      orderBy: [{ entry: { entryDate: "desc" } }, { entry: { createdAt: "desc" } }, { entryId: "desc" }, { lineNo: "desc" }],
      take: limit,
    }),
  ]);

  /* The closing figure is the account's balance at the end of the range, not
   * the range's own movement: the column above it holds balances, and a footer
   * that is a different kind of number from the column it sits under is how a
   * reader ends up quoting the month's movement as what the account holds.
   *
   * It is summed in transaction amounts, the same amounts the debit and credit
   * columns show, so a foreign-currency account closes in its own currency and
   * the column ties to the figure beneath it. The trial balance reads the
   * functional-currency balance of the same account instead — the same money,
   * stated in the book's currency. */
  const openingMinor = before?._sum.txnAmountMinor ?? 0n;
  const closingMinor = openingMinor + (totals._sum.txnAmountMinor ?? 0n);

  // Read newest-first, presented oldest-first: a ledger is read down the page.
  page.reverse();

  /* Walk back from the closing balance rather than forward from nothing. The
   * last listed line then lands on the closing figure by construction, so the
   * column and the total beneath it cannot tell different stories, and the
   * first line opens at what the account already held. */
  const broughtForwardMinor = closingMinor - page.reduce((a, l) => a + l.txnAmountMinor, 0n);

  let running = broughtForwardMinor;
  return {
    account: { code: account.code, name: account.name, nameAr: account.nameAr, type: account.type },
    openingMinor,
    broughtForwardMinor,
    closingMinor,
    lineCount: totals._count._all,
    listed: page.length,
    truncated: totals._count._all > page.length,
    lines: page.map((l) => {
      running += l.txnAmountMinor;
      return {
        entryId: l.entry.id,
        reference: `${l.entry.series}-${l.entry.number}`,
        date: l.entry.entryDate,
        memo: l.memo ?? l.entry.memo,
        source: l.entry.source,
        sourceType: l.entry.sourceType,
        sourceId: l.entry.sourceId,
        status: l.entry.status,
        debitMinor: l.txnAmountMinor > 0n ? l.txnAmountMinor : 0n,
        creditMinor: l.txnAmountMinor < 0n ? -l.txnAmountMinor : 0n,
        runningMinor: running,
      };
    }),
  };
}
