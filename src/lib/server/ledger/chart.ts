import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";

/**
 * Editing the chart of accounts.
 *
 * The chart is the one piece of setup every business changes, and the one most
 * dangerous to let them change freely — an account that has been posted to is
 * referenced by history that must stay true.
 *
 * So the rules here are about what may still change once an account has been
 * used, and they follow from what each field means:
 *
 *  - a **name** is a label. Renaming "Rent" to "Rent and service charge" does
 *    not change what any past entry did, so it is always allowed.
 *  - a **type** is not a label. Moving an account from EXPENSE to ASSET
 *    silently rewrites every statement it has ever appeared in, so once
 *    anything is posted the type is frozen.
 *  - a **code** is an identifier that people quote in emails and spreadsheets.
 *    It can change, but only deliberately, and never onto a code in use.
 *  - **deletion** is refused outright once posted. Archiving is the answer:
 *    the account stops accepting new postings and keeps its history.
 */

const TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;
type AccountType = (typeof TYPES)[number];

export interface NewAccount {
  code: string;
  name: string;
  nameAr?: string;
  type: string;
  subtype?: string;
  parentCode?: string;
  isPostable?: boolean;
  currency?: string;
  requiresDimension?: string;
}

/** How many posted lines an account carries — the thing every rule turns on. */
async function usage(accountId: string) {
  const [lines, balances] = await Promise.all([
    prisma.journalLine.count({ where: { accountId } }),
    prisma.accountBalance.count({ where: { accountId } }),
  ]);
  return { lines, balances, used: lines > 0 || balances > 0 };
}

async function load(orgId: string, entityId: string, code: string) {
  const account = await prisma.account.findFirst({ where: { orgId, entityId, code } });
  if (!account) throw new LedgerError(`Account ${code} is not in this entity's chart.`);
  return account;
}

export async function addAccount(opts: { orgId: string; entityId: string; account: NewAccount }) {
  const a = opts.account;
  const code = a.code?.trim();
  if (!code) throw new LedgerError("An account needs a code.");
  if (!/^[A-Za-z0-9._-]+$/.test(code)) {
    throw new LedgerError(
      `"${code}" is not a usable account code. Use letters, digits, dots, dashes or underscores — a code with ` +
        `spaces or punctuation in it breaks every export that quotes it.`,
    );
  }
  if (!a.name?.trim()) throw new LedgerError("An account needs a name.");
  if (!TYPES.includes(a.type as AccountType)) {
    throw new LedgerError(`An account is one of ${TYPES.join(", ")}. "${a.type}" is not.`);
  }

  const clash = await prisma.account.findFirst({ where: { orgId: opts.orgId, entityId: opts.entityId, code } });
  if (clash) throw new LedgerError(`Account ${code} already exists — it is "${clash.name}".`);

  let parentId: string | null = null;
  if (a.parentCode) {
    const parent = await load(opts.orgId, opts.entityId, a.parentCode);
    if (parent.isPostable) {
      throw new LedgerError(
        `${parent.code} ${parent.name} accepts postings, so it cannot also be a heading. ` +
          `An account is either something you post to or something that rolls up its children, not both.`,
      );
    }
    if (parent.type !== a.type) {
      throw new LedgerError(
        `${code} is an ${a.type.toLowerCase()} but ${parent.code} ${parent.name} is a ` +
          `${parent.type.toLowerCase()}. A heading and its children have to be the same kind of account, ` +
          `or the totals it rolls up mean nothing.`,
      );
    }
    parentId = parent.id;
  }

  return prisma.account.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId,
      code, name: a.name.trim(), nameAr: a.nameAr?.trim() || null,
      type: a.type, subtype: a.subtype?.trim() || null,
      parentId,
      isPostable: a.isPostable !== false,
      currency: a.currency?.trim() || null,
      requiresDimension: a.requiresDimension?.trim() || null,
    },
  });
}

export interface AccountChange {
  name?: string;
  nameAr?: string | null;
  type?: string;
  subtype?: string | null;
  parentCode?: string | null;
  isPostable?: boolean;
  currency?: string | null;
  requiresDimension?: string | null;
}

/**
 * Change an account.
 *
 * Every refusal here names how many postings the account carries, because
 * "you cannot do that" without the reason is how people conclude a system is
 * arbitrary and start working around it.
 */
export async function updateAccount(opts: {
  orgId: string; entityId: string; code: string; change: AccountChange;
}) {
  const account = await load(opts.orgId, opts.entityId, opts.code);
  const u = await usage(account.id);
  const c = opts.change;
  const data: Record<string, unknown> = {};

  if (c.name !== undefined) {
    if (!c.name.trim()) throw new LedgerError("An account cannot have an empty name.");
    // A name is a label. Renaming changes nothing about what past entries did.
    data.name = c.name.trim();
  }
  if (c.nameAr !== undefined) data.nameAr = c.nameAr?.trim() || null;
  if (c.subtype !== undefined) data.subtype = c.subtype?.trim() || null;

  if (c.type !== undefined && c.type !== account.type) {
    if (!TYPES.includes(c.type as AccountType)) {
      throw new LedgerError(`An account is one of ${TYPES.join(", ")}. "${c.type}" is not.`);
    }
    if (u.used) {
      throw new LedgerError(
        `${account.code} ${account.name} carries ${u.lines} posted line${u.lines === 1 ? "" : "s"}, so its type ` +
          `cannot change. Moving it from ${account.type.toLowerCase()} to ${c.type.toLowerCase()} would rewrite ` +
          `every statement it has ever appeared in. Archive it and open a new account instead.`,
      );
    }
    data.type = c.type;
  }

  if (c.isPostable !== undefined && c.isPostable !== account.isPostable) {
    if (!c.isPostable && u.used) {
      throw new LedgerError(
        `${account.code} ${account.name} already carries ${u.lines} posted line${u.lines === 1 ? "" : "s"}, ` +
          `so it cannot become a heading. Headings roll up their children and hold no balance of their own.`,
      );
    }
    if (!c.isPostable) {
      const children = await prisma.account.count({ where: { parentId: account.id } });
      if (children === 0) {
        throw new LedgerError(
          `${account.code} ${account.name} has no children, so making it a heading would leave an account ` +
            `nothing can be posted to and nothing rolls up into.`,
        );
      }
    }
    data.isPostable = c.isPostable;
  }

  if (c.currency !== undefined) {
    // Restricting the currency of an account that already holds another one
    // would make its own history illegal.
    if (c.currency && u.lines > 0) {
      const other = await prisma.journalLine.findFirst({
        where: { accountId: account.id, txnCurrency: { not: c.currency } },
        select: { txnCurrency: true },
      });
      if (other) {
        throw new LedgerError(
          `${account.code} ${account.name} already holds postings in ${other.txnCurrency}, so it cannot be ` +
            `restricted to ${c.currency}. The restriction would make its own history invalid.`,
        );
      }
    }
    data.currency = c.currency?.trim() || null;
  }

  if (c.requiresDimension !== undefined) data.requiresDimension = c.requiresDimension?.trim() || null;

  if (c.parentCode !== undefined) {
    if (c.parentCode === null || c.parentCode === "") {
      data.parentId = null;
    } else {
      const parent = await load(opts.orgId, opts.entityId, c.parentCode);
      if (parent.id === account.id) throw new LedgerError("An account cannot be its own heading.");
      if (parent.type !== (data.type ?? account.type)) {
        throw new LedgerError(
          `${parent.code} ${parent.name} is a ${parent.type.toLowerCase()} and cannot be the heading for an ` +
            `${(data.type ?? account.type).toString().toLowerCase()}.`,
        );
      }
      // A cycle would make every rollup infinite.
      let cursor: string | null = parent.parentId;
      const seen = new Set<string>([parent.id]);
      while (cursor) {
        if (cursor === account.id) {
          throw new LedgerError(
            `That would put ${account.code} underneath itself. A chart is a tree, and a loop in it makes every ` +
              `total that walks through it meaningless.`,
          );
        }
        if (seen.has(cursor)) break;
        seen.add(cursor);
        const next: { parentId: string | null } | null = await prisma.account.findUnique({
          where: { id: cursor }, select: { parentId: true },
        });
        cursor = next?.parentId ?? null;
      }
      data.parentId = parent.id;
    }
  }

  if (Object.keys(data).length === 0) throw new LedgerError("There is nothing to change.");
  return prisma.account.update({ where: { id: account.id }, data });
}

/**
 * Renumber an account.
 *
 * Kept separate from `updateAccount` because it is a different kind of act: the
 * code is what people quote to each other, and changing it invalidates every
 * spreadsheet and email that refers to the old one. Making it its own call
 * means it cannot happen as a side effect of editing a name.
 */
export async function renumberAccount(opts: {
  orgId: string; entityId: string; from: string; to: string;
}) {
  const account = await load(opts.orgId, opts.entityId, opts.from);
  const to = opts.to.trim();
  if (!to) throw new LedgerError("A new code is required.");
  if (to === opts.from) throw new LedgerError(`${opts.from} is already its code.`);
  if (!/^[A-Za-z0-9._-]+$/.test(to)) {
    throw new LedgerError(`"${to}" is not a usable account code.`);
  }

  const clash = await prisma.account.findFirst({ where: { orgId: opts.orgId, entityId: opts.entityId, code: to } });
  if (clash) {
    throw new LedgerError(
      `${to} is already "${clash.name}". Two accounts cannot share a code — every report that groups by code ` +
        `would silently merge them.`,
    );
  }

  const u = await usage(account.id);
  const updated = await prisma.account.update({ where: { id: account.id }, data: { code: to } });
  return {
    account: updated,
    // History follows the account by id, so nothing is orphaned — but anyone
    // holding the old code in a spreadsheet needs to know.
    postedLines: u.lines,
    note:
      u.lines > 0
        ? `${u.lines} posted line${u.lines === 1 ? "" : "s"} moved with it. Anything outside this system that ` +
          `refers to ${opts.from} will need updating.`
        : "Nothing has been posted to it, so nothing else refers to it.",
  };
}

/**
 * Archive an account: it stops accepting postings and keeps its history.
 *
 * This is the answer to "delete", and the distinction is the point. Deleting an
 * account that has been posted to would orphan the history that explains a
 * balance; archiving keeps every past statement true while making sure nothing
 * new lands there.
 */
export async function archiveAccount(opts: { orgId: string; entityId: string; code: string }) {
  const account = await load(opts.orgId, opts.entityId, opts.code);
  if (account.status === "archived") throw new LedgerError(`${account.code} is already archived.`);

  const children = await prisma.account.count({ where: { parentId: account.id, status: "active" } });
  if (children > 0) {
    throw new LedgerError(
      `${account.code} ${account.name} still has ${children} active account${children === 1 ? "" : "s"} under it. ` +
        `Archive or move them first, or their totals would roll up into something archived.`,
    );
  }

  // An account still holding a balance is a real position. Archiving it would
  // hide something the business still owns or owes.
  const balance = await prisma.journalLine.aggregate({
    where: { accountId: account.id, entry: { status: { in: ["posted", "reversed"] } } },
    _sum: { functionalAmountMinor: true },
  });
  const held = balance._sum.functionalAmountMinor ?? 0n;
  if (held !== 0n) {
    throw new LedgerError(
      `${account.code} ${account.name} still holds a balance. Clear it to nil first — archiving an account with ` +
        `a balance in it hides something the business still owns or owes.`,
    );
  }

  return prisma.account.update({ where: { id: account.id }, data: { status: "archived" } });
}

export async function restoreAccount(opts: { orgId: string; entityId: string; code: string }) {
  const account = await load(opts.orgId, opts.entityId, opts.code);
  if (account.status === "active") throw new LedgerError(`${account.code} is already active.`);
  return prisma.account.update({ where: { id: account.id }, data: { status: "active" } });
}

/**
 * Delete an account.
 *
 * Only ever allowed for one that has never been used, which in practice means
 * one added by mistake minutes ago. Anything else is archived.
 */
export async function deleteAccount(opts: { orgId: string; entityId: string; code: string }) {
  const account = await load(opts.orgId, opts.entityId, opts.code);
  const u = await usage(account.id);
  if (u.used) {
    throw new LedgerError(
      `${account.code} ${account.name} carries ${u.lines} posted line${u.lines === 1 ? "" : "s"} and cannot be ` +
        `deleted — the history that explains those balances would be orphaned. Archive it instead: it stops ` +
        `accepting postings and keeps everything it already holds.`,
    );
  }
  const children = await prisma.account.count({ where: { parentId: account.id } });
  if (children > 0) {
    throw new LedgerError(`${account.code} ${account.name} has ${children} account${children === 1 ? "" : "s"} under it.`);
  }
  await prisma.account.delete({ where: { id: account.id } });
  return { deleted: account.code };
}

/**
 * The chart with what each account carries, so an editor can show consequences
 * before someone tries something the rules will refuse.
 */
export async function chartWithUsage(opts: { orgId: string; entityId: string }) {
  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { code: "asc" },
  });
  const counts = await prisma.journalLine.groupBy({
    by: ["accountId"],
    where: { orgId: opts.orgId, accountId: { in: accounts.map((a) => a.id) } },
    _count: { _all: true },
    _sum: { functionalAmountMinor: true },
  });
  const byId = new Map(counts.map((c) => [c.accountId, c]));
  const childCounts = new Map<string, number>();
  for (const a of accounts) {
    if (a.parentId) childCounts.set(a.parentId, (childCounts.get(a.parentId) ?? 0) + 1);
  }

  return accounts.map((a) => {
    const c = byId.get(a.id);
    const lines = c?._count._all ?? 0;
    const balance = c?._sum.functionalAmountMinor ?? 0n;
    return {
      code: a.code, name: a.name, nameAr: a.nameAr, type: a.type, subtype: a.subtype,
      parentCode: accounts.find((p) => p.id === a.parentId)?.code ?? null,
      isPostable: a.isPostable, isControl: a.isControl,
      currency: a.currency, requiresDimension: a.requiresDimension, status: a.status,
      postedLines: lines,
      balanceMinor: balance.toString(),
      children: childCounts.get(a.id) ?? 0,
      // What the rules would allow, computed once here so the editor can grey
      // the right things and explain why rather than failing on submit.
      canChangeType: lines === 0,
      canDelete: lines === 0 && (childCounts.get(a.id) ?? 0) === 0,
      canArchive: a.status === "active" && balance === 0n && (childCounts.get(a.id) ?? 0) === 0,
    };
  });
}
