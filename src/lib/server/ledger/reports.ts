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

/** General-ledger detail for one account — the drill-down target. */
export async function generalLedger(opts: {
  orgId: string;
  entityId: string;
  accountCode: string;
  from?: Date;
  to?: Date;
  limit?: number;
}) {
  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.accountCode },
  });
  if (!account) throw new LedgerError(`Account ${opts.accountCode} does not exist.`);

  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: account.id,
      entry: {
        orgId: opts.orgId,
        status: { in: ["posted", "reversed"] },
        ...(opts.from || opts.to ? { entryDate: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {}),
      },
    },
    include: { entry: { select: { id: true, series: true, number: true, entryDate: true, memo: true, source: true, sourceType: true, sourceId: true, status: true } } },
    orderBy: [{ entry: { entryDate: "asc" } }, { lineNo: "asc" }],
    take: opts.limit ?? 500,
  });

  let running = 0n;
  return {
    account: { code: account.code, name: account.name, nameAr: account.nameAr, type: account.type },
    lines: lines.map((l) => {
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
