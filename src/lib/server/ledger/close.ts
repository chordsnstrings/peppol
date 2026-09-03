import { prisma } from "@/lib/server/prisma";
import { post, LedgerError } from "./post";
import { profitAndLoss } from "./statements";

/**
 * The year-end close.
 *
 * Closing a year is one journal entry, not a migration. Every income and
 * expense account is brought to zero against retained earnings, so the new year
 * starts with a clean profit and loss while the balance sheet carries forward
 * untouched — which it does by itself, because balance-sheet accounts simply
 * accumulate.
 *
 * Three things this deliberately does not do:
 *
 *  - it does not copy balances into a new table. Opening balances that are a
 *    separate record are opening balances that can disagree with the ledger
 *    they came from.
 *  - it does not delete or archive anything. The closed year stays fully
 *    readable, and its statements still produce the same figures afterwards.
 *  - it does not close a year whose periods are still open. A close computed
 *    over periods that can still receive postings is a close that will be
 *    wrong by tomorrow.
 */

export interface ClosePreview {
  fiscalYear: string;
  startsOn: string;
  endsOn: string;
  currency: string;
  /** Accounts that will be zeroed, and by how much. */
  lines: { code: string; name: string; type: string; balanceMinor: string; closingMinor: string }[];
  netProfitMinor: string;
  retainedEarningsAccount: string;
  /** Why this year cannot be closed yet, if it cannot. */
  blockers: string[];
  alreadyClosed: boolean;
  closingReference: string | null;
}

const RETAINED = "3900";

async function loadYear(orgId: string, entityId: string, label: string) {
  const year = await prisma.fiscalYear.findFirst({
    where: { orgId, entityId, label },
    include: { periods: { orderBy: { seq: "asc" } } },
  });
  if (!year) throw new LedgerError(`There is no fiscal year "${label}" for this entity.`);
  return year;
}

/**
 * What closing this year would do, and what stops it.
 *
 * A close is irreversible in practice — the entry can be reversed, but a year
 * whose periods are locked cannot take one. So the preview is not a courtesy;
 * it is the only chance to look before the door shuts.
 */
export async function previewClose(opts: {
  orgId: string; entityId: string; fiscalYear: string;
}): Promise<ClosePreview> {
  const year = await loadYear(opts.orgId, opts.entityId, opts.fiscalYear);
  const from = year.startsOn.toISOString().slice(0, 10);
  const to = year.endsOn.toISOString().slice(0, 10);

  const existing = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey: `year-close:${opts.entityId}:${opts.fiscalYear}` },
    select: { series: true, number: true },
  });

  const pl = await profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from, to });

  const blockers: string[] = [];
  // The adjustment period is excluded: it exists to receive the closing entry,
  // so requiring it to be shut before closing would be a rule that contradicts
  // itself. The trading months are what must be settled.
  const stillOpen = year.periods.filter(
    (p) => !p.isAdjustment && (p.status === "open" || p.status === "soft_closed"),
  );
  if (stillOpen.length && !existing) {
    blockers.push(
      `${stillOpen.length} period${stillOpen.length === 1 ? " is" : "s are"} still open ` +
        `(${stillOpen.slice(0, 3).map((p) => p.label).join(", ")}${stillOpen.length > 3 ? ", …" : ""}). ` +
        `Hard-close them first — a year closed over periods that can still receive postings is wrong by tomorrow.`,
    );
  }
  if (year.status === "closed" && !existing) {
    blockers.push("This year is marked closed but carries no closing entry. Please report it.");
  }

  // Every income and expense account, with the amount needed to bring it to
  // zero. The ledger holds revenue negative, so closing it is a debit.
  const lines = [...pl.revenue.lines, ...pl.costOfSales.lines, ...pl.expenses.lines].map((l) => ({
    code: l.code,
    name: l.name,
    type: pl.revenue.lines.includes(l) ? "INCOME" : "EXPENSE",
    balanceMinor: l.balanceMinor,
    closingMinor: (-BigInt(l.balanceMinor)).toString(),
  }));

  return {
    fiscalYear: year.label,
    startsOn: from,
    endsOn: to,
    currency: pl.currency,
    lines,
    netProfitMinor: pl.netProfitMinor,
    retainedEarningsAccount: RETAINED,
    blockers,
    alreadyClosed: Boolean(existing),
    closingReference: existing ? `${existing.series}-${existing.number}` : null,
  };
}

export interface CloseResult {
  fiscalYear: string;
  entryId: string | null;
  reference: string | null;
  netProfitMinor: string;
  accountsClosed: number;
  periodsLocked: number;
  alreadyClosed: boolean;
}

/**
 * Close the year.
 *
 * The closing entry posts into the year's adjustment period, which is what that
 * period exists for — putting it in December would make December's own figures
 * include the closing of December.
 */
export async function closeYear(opts: {
  orgId: string;
  entityId: string;
  fiscalYear: string;
  actorId?: string;
  /** Lock the year's periods afterwards. Locked periods never reopen. */
  lockPeriods?: boolean;
}): Promise<CloseResult> {
  const preview = await previewClose(opts);

  if (preview.alreadyClosed) {
    return {
      fiscalYear: preview.fiscalYear, entryId: null, reference: preview.closingReference,
      netProfitMinor: preview.netProfitMinor, accountsClosed: 0, periodsLocked: 0, alreadyClosed: true,
    };
  }
  if (preview.blockers.length) throw new LedgerError(preview.blockers[0]);

  const closing = preview.lines.filter((l) => BigInt(l.closingMinor) !== 0n);
  if (closing.length === 0) {
    throw new LedgerError(
      `${preview.fiscalYear} has no income or expenses to close. There is nothing to carry to retained earnings.`,
    );
  }

  const year = await loadYear(opts.orgId, opts.entityId, opts.fiscalYear);
  // The adjustment period exists precisely so a year-end entry does not land
  // inside a trading month.
  const adjustment = year.periods.find((p) => p.isAdjustment);
  const target = adjustment ?? year.periods[year.periods.length - 1];
  if (!target) throw new LedgerError(`${preview.fiscalYear} has no periods to post the close into.`);

  // The adjustment period has to be open to receive the entry. Reopen it for
  // the close and leave it as it was found.
  const reopened = target.status !== "open";
  if (reopened) {
    if (target.status === "locked") {
      throw new LedgerError(`${target.label} is locked, so the closing entry cannot be posted into it.`);
    }
    await prisma.accountingPeriod.update({ where: { id: target.id }, data: { status: "open" } });
  }

  const profit = BigInt(preview.netProfitMinor);

  try {
    const entry = await post({
      orgId: opts.orgId,
      entityId: opts.entityId,
      entryDate: target.endsOn,
      // Named explicitly: the adjustment period shares its last day with
      // December, so the date alone cannot distinguish them.
      periodId: target.id,
      memo: `Closing ${preview.fiscalYear} — profit and loss to retained earnings`,
      source: "close",
      sourceType: "YEAR_END",
      sourceId: preview.fiscalYear,
      externalKey: `year-close:${opts.entityId}:${opts.fiscalYear}`,
      actorType: "HUMAN",
      actorId: opts.actorId,
      series: "CL",
      lines: [
        ...closing.map((l) => {
          const amount = BigInt(l.closingMinor);
          return {
            account: l.code,
            ...(amount > 0n ? { debit: amount } : { credit: -amount }),
            memo: `Closing ${l.name}`,
          };
        }),
        // A profit is a credit to retained earnings; a loss is a debit.
        {
          account: RETAINED,
          ...(profit > 0n ? { credit: profit } : { debit: -profit }),
          memo: `${preview.fiscalYear} result`,
        },
      ],
    });

    let periodsLocked = 0;
    if (opts.lockPeriods) {
      const res = await prisma.accountingPeriod.updateMany({
        where: { orgId: opts.orgId, entityId: opts.entityId, fiscalYearId: year.id, status: { not: "locked" } },
        data: { status: "locked", closedAt: new Date() },
      });
      periodsLocked = res.count;
    } else if (reopened) {
      await prisma.accountingPeriod.update({ where: { id: target.id }, data: { status: target.status } });
    }

    await prisma.fiscalYear.update({ where: { id: year.id }, data: { status: "closed" } });

    return {
      fiscalYear: preview.fiscalYear,
      entryId: entry.id,
      reference: `${entry.series}-${entry.number}`,
      netProfitMinor: preview.netProfitMinor,
      accountsClosed: closing.length,
      periodsLocked,
      alreadyClosed: false,
    };
  } catch (e) {
    // If the close failed, leave the adjustment period exactly as it was found
    // rather than open because of an attempt that did not work.
    if (reopened) {
      await prisma.accountingPeriod.update({ where: { id: target.id }, data: { status: target.status } }).catch(() => {});
    }
    throw e;
  }
}

/**
 * Open the next fiscal year.
 *
 * Nothing is copied forward. Balance-sheet accounts carry themselves, because
 * their balances accumulate across periods, and the profit and loss starts at
 * zero because the close brought it there. An opening-balance table would be a
 * second record of the same facts, and a second record is a record that can
 * disagree.
 */
export async function openNextYear(opts: {
  orgId: string; entityId: string; afterFiscalYear: string;
}): Promise<{ label: string; startsOn: string; periods: number; created: boolean }> {
  const prev = await loadYear(opts.orgId, opts.entityId, opts.afterFiscalYear);
  const nextStart = new Date(prev.endsOn);
  nextStart.setUTCDate(nextStart.getUTCDate() + 1);
  const label = String(nextStart.getUTCFullYear());

  const existing = await prisma.fiscalYear.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, label },
    include: { periods: true },
  });
  if (existing) {
    return { label, startsOn: existing.startsOn.toISOString().slice(0, 10), periods: existing.periods.length, created: false };
  }

  const { openFiscalYear } = await import("./setup");
  const year = await openFiscalYear({
    orgId: opts.orgId, entityId: opts.entityId, label,
    startsOn: nextStart.toISOString().slice(0, 10),
  });
  const periods = await prisma.accountingPeriod.count({ where: { fiscalYearId: year.id } });
  return { label, startsOn: nextStart.toISOString().slice(0, 10), periods, created: true };
}
