import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
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

/**
 * The closing amounts for an account that requires a dimension, split by the
 * value each part of its balance was posted against.
 *
 * An account with `requiresDimension` refuses a posting that does not name a
 * value, and the closing entry is a posting like any other — so a single line
 * for the whole balance is refused and the year cannot be closed at all. The
 * split is not a workaround for that: it is what closing such an account
 * actually means. The balance is spread across cost centres, and bringing it
 * to zero means bringing each cost centre to zero.
 *
 * Postings made before the requirement was added carry no value. They cannot
 * be closed with one and cannot be closed without one, so the close stops and
 * says which account and how much — the alternative is a year that silently
 * will not close and nobody able to say why.
 */
async function splitByDimension(opts: {
  orgId: string;
  entityId: string;
  from: Date;
  to: Date;
  accountCode: string;
  dimensionCode: string;
  closingMinor: bigint;
  /** The book's currency, so the figures in the refusals below have its decimals. */
  currency: string;
}): Promise<{ valueCode: string; closingMinor: bigint }[]> {
  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      account: { entityId: opts.entityId, code: opts.accountCode },
      entry: {
        entityId: opts.entityId,
        source: { not: "close" },
        status: { in: ["posted", "reversed"] },
        entryDate: { gte: opts.from, lte: opts.to },
      },
    },
    select: {
      functionalAmountMinor: true,
      dimensions: { select: { value: { select: { code: true, dimension: { select: { code: true } } } } } },
    },
  });

  const byValue = new Map<string, bigint>();
  let undimensioned = 0n;
  for (const l of lines) {
    const v = l.dimensions.find((d) => d.value.dimension.code === opts.dimensionCode)?.value.code;
    if (!v) { undimensioned += l.functionalAmountMinor; continue; }
    byValue.set(v, (byValue.get(v) ?? 0n) + l.functionalAmountMinor);
  }

  if (undimensioned !== 0n) {
    throw new LedgerError(
      `${opts.accountCode} requires a ${opts.dimensionCode} on every posting, but ${fmt(undimensioned, opts.currency)} of its ` +
        `balance was posted without one — from before the requirement was added, most likely. Those postings cannot ` +
        `be closed with a value and cannot be closed without one. Reverse and repost them with a ${opts.dimensionCode}, ` +
        `or take the requirement off the account.`,
    );
  }

  const split = [...byValue.entries()]
    .filter(([, amount]) => amount !== 0n)
    .map(([valueCode, amount]) => ({ valueCode, closingMinor: -amount }))
    .sort((a, b) => a.valueCode.localeCompare(b.valueCode));

  const total = split.reduce((a, x) => a + x.closingMinor, 0n);
  if (total !== opts.closingMinor) {
    throw new LedgerError(
      `The ${opts.dimensionCode} split of ${opts.accountCode} comes to ${fmt(total, opts.currency)} against a balance of ` +
        `${fmt(opts.closingMinor, opts.currency)}. Closing on that would move the difference into retained earnings without a ` +
        `cost centre behind it. Please report it.`,
    );
  }
  return split;
}

/**
 * Minor units as a figure, for a message about a difference.
 *
 * Through `fmtMinor`, which knows how many decimals a currency has. Splitting
 * the digits two from the right is right for a dirham and wrong by a factor of
 * ten for a Kuwaiti or Bahraini dinar or an Omani rial.
 */
const fmt = (minor: bigint, currency: string) => fmtMinor(minor, currency, { zero: "zero" });

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

  // Accounts that demand a cost centre on every posting demand one here too.
  const requiring = new Map(
    (await prisma.account.findMany({
      where: {
        orgId: opts.orgId, entityId: opts.entityId,
        code: { in: closing.map((l) => l.code) },
        requiresDimension: { not: null },
      },
      select: { code: true, requiresDimension: true },
    })).map((a) => [a.code, a.requiresDimension as string]),
  );

  const closingLines: {
    account: string; debit?: bigint; credit?: bigint; memo: string; dimensions?: Record<string, string>;
  }[] = [];
  for (const l of closing) {
    const dimensionCode = requiring.get(l.code);
    if (!dimensionCode) {
      const amount = BigInt(l.closingMinor);
      closingLines.push({
        account: l.code,
        ...(amount > 0n ? { debit: amount } : { credit: -amount }),
        memo: `Closing ${l.name}`,
      });
      continue;
    }
    const split = await splitByDimension({
      orgId: opts.orgId, entityId: opts.entityId,
      from: year.startsOn, to: year.endsOn,
      accountCode: l.code, dimensionCode, closingMinor: BigInt(l.closingMinor),
      currency: preview.currency,
    });
    for (const part of split) {
      closingLines.push({
        account: l.code,
        ...(part.closingMinor > 0n ? { debit: part.closingMinor } : { credit: -part.closingMinor }),
        memo: `Closing ${l.name} — ${part.valueCode}`,
        dimensions: { [dimensionCode]: part.valueCode },
      });
    }
  }

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
        ...closingLines,
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
