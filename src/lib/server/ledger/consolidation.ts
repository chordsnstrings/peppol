import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { profitAndLoss, balanceSheet, type StatementLine } from "./statements";
// `intercompany.ts` imports `groupList` from this module, so the two refer to
// each other. Both references are to hoisted function declarations called at
// run time rather than to anything read while a module is evaluating, which is
// what makes the cycle harmless — do not move either into module scope.
import { eliminationSchedule, type EliminationKind } from "./intercompany";

/**
 * Group accounts: one set of statements for several legal entities.
 *
 * The whole module is a report. Nothing here posts, and nothing here can move a
 * balance in any member's ledger. A consolidation is a view taken over books
 * that stay exactly as their entities keep them — the moment consolidation
 * could write back, the group and the statutory accounts would start to drift
 * and no one could say which was right.
 *
 * Four decisions carry it.
 *
 *  - Members are consolidated line by line on account code, so every member's
 *    1010 lands in one row. Each row keeps its per-member figures alongside the
 *    total, because "cash 16,300,000" is a number nobody can check and "parent
 *    11,500,000 plus subsidiary 4,800,000" is a number anybody can.
 *
 *  - A controlled subsidiary is consolidated in FULL, whatever the ownership
 *    percentage, and the minority's share is presented separately as the
 *    non-controlling interest. IFRS 10 consolidates on control, not on
 *    proportion: the parent controls all of the subsidiary's assets and all of
 *    its revenue, so all of them appear, and the claim other shareholders have
 *    on the net assets and the profit is shown as a line of its own (IFRS 10.22,
 *    B94). Consolidating 75% of a 75%-owned subsidiary — proportional
 *    consolidation — would report a group that controls less than it does, and
 *    would put a number on the face of the accounts that reconciles to nothing
 *    in either set of books. We do not do it.
 *
 *  - Intercompany balances are PROPOSED for elimination, never eliminated
 *    silently. A journal line records no counterparty, so nothing in the ledger
 *    says that the parent's receivable is owed by the subsidiary rather than by
 *    a customer. What we can do is notice that one member's trade receivables
 *    exactly equal another member's trade payables and say so. An automatic
 *    elimination on that evidence would, when the guess is wrong, remove a real
 *    third-party receivable and a real third-party payable and leave a balance
 *    sheet that still balances — a hidden error is worse than a visible one.
 *    So `eliminations` is returned as a list of candidates and `applyEliminations`
 *    is a flag a human sets after reading them.
 *
 *  - The statement checks itself. Consolidated assets must equal consolidated
 *    liabilities plus equity attributable to the parent plus the
 *    non-controlling interest, and the difference is reported rather than
 *    plugged. A consolidation that quietly balances itself is a consolidation
 *    that will one day quietly hide a member whose own books do not.
 *
 * Deliberately out of scope, and worth stating because their absence changes
 * what these figures mean:
 *
 *  - The parent's investment in the subsidiary is not eliminated against the
 *    subsidiary's equity (IFRS 10.B86(b)), and no goodwill arises, because
 *    nothing in the ledger links a shareholding to a member entity. Group
 *    equity is therefore the members' equity added together and then split
 *    between the parent's owners and the non-controlling interest.
 *  - Intercompany revenue and the matching expense are not eliminated. They
 *    net to nil in group profit but do gross up revenue and expenses.
 *  - No currency translation. A member reporting in another currency is
 *    included at face value and warned about, which is at least honest; a made-
 *    up rate would not be.
 *
 * The first two of those used to be stated HERE and nowhere else, which is to
 * say to the people who read this file and to nobody who reads the accounts.
 * The screen showed `warnings`, and every warning was conditional — a partly
 * owned parent, a currency that did not match, a member whose own sheet did not
 * balance — so an AED parent with an AED subsidiary, which is most of the UAE,
 * saw a clean consolidation with no caveat on it at all. They are now in
 * `caveats`, which is never empty, and in `basisNote`, which every caller gets.
 * Where `intercompany.ts` can measure what has been left in, the caveat says
 * the number rather than the fact: "revenue and cost are each overstated by
 * 4,800,000" is a statement a reader can act on, and "intragroup trade is not
 * eliminated" is one they cannot.
 *
 * Amounts are BigInt minor units and ownership is basis points held in BigInt.
 * No float touches any of it.
 */

/* --------------------------------------------------------------- vocabulary */

/** Trade receivables and trade payables — the two control accounts a group's members owe each other across. */
const AR_CODE = "1100";
const AP_CODE = "2000";
const WHOLLY_OWNED_BPS = 10_000n;

export interface GroupMember {
  entityId: string;
  /** Percentage owned, in basis points. 10000 is wholly owned. */
  ownershipBps: number;
  isParent: boolean;
}

export interface GroupSummary {
  code: string;
  name: string;
  currency: string;
  memberCount: number;
  /** Null when nobody has been marked as the parent — such a group cannot be consolidated. */
  parentEntityId: string | null;
}

export interface GroupMemberDetail extends GroupMember {
  /** The member's own functional currency, or null when it has no ledger yet. */
  currency: string | null;
  hasLedger: boolean;
}

export interface GroupDetail {
  code: string;
  name: string;
  currency: string;
  members: GroupMemberDetail[];
}

/** One account code, as every member reported it and as the group reports it. */
export interface ConsolidatedLine {
  code: string;
  name: string;
  nameAr: string | null;
  /** entityId → the member's own figure, on the account's natural side. */
  byEntity: Record<string, string>;
  /** The members added together, before eliminations. */
  combinedMinor: string;
  /** Taken off by applied eliminations. Zero unless `applyEliminations` was set. */
  eliminationMinor: string;
  /** Combined less eliminations — the group's figure. */
  totalMinor: string;
}

export interface ConsolidatedSection {
  key: string;
  label: string;
  lines: ConsolidatedLine[];
  byEntity: Record<string, string>;
  combinedMinor: string;
  eliminationMinor: string;
  totalMinor: string;
}

/**
 * A pair of balances that look like the two sides of one intragroup debt.
 * A candidate, not a conclusion — see the note at the top of this file.
 */
export interface Elimination {
  /** Stable across runs, so one candidate can be accepted without the others. */
  key: string;
  /** The member carrying the receivable (account 1100). */
  receivableEntityId: string;
  /** The member carrying the payable (account 2000). */
  payableEntityId: string;
  receivableCode: string;
  payableCode: string;
  amountMinor: string;
  /** Why this pair was proposed, in words a reviewer can check. */
  reason: string;
  /** Whether it was taken off these figures, which only happens on request. */
  applied: boolean;
}

/**
 * Something these figures are not, said whether or not it happens to bite.
 *
 * A caveat is not a warning. A warning fires when something is wrong with this
 * group's data; a caveat is true of every group this module reports, because it
 * describes what the module does not do. Conditional presentation is what made
 * the two most important ones invisible to the commonest group there is.
 */
export interface ConsolidationCaveat {
  key: string;
  /** The heading, short enough to read at a glance. */
  title: string;
  /** What is in the figures and what it does to them, in full sentences. */
  detail: string;
  /**
   * How much is left in, where it can be measured from the ledger. Null where
   * it cannot — and `detail` then says why, rather than implying it is nil.
   */
  amountMinor: string | null;
  /** The paragraph the rule comes from. */
  authority: string;
}

/** The minority's claim on one member, held apart from the parent's owners. */
export interface NonControllingInterest {
  entityId: string;
  ownershipBps: number;
  /** 10000 less the ownership. The share these figures are of. */
  minorityBps: number;
  /** The member's net assets, all of them, before the split. */
  memberNetAssetsMinor: string;
  /** The member's profit for the period, all of it, before the split. */
  memberProfitMinor: string;
  /** The minority's share of the net assets. */
  netAssetsMinor: string;
  /** The minority's share of the profit. */
  profitMinor: string;
}

export interface MemberColumn {
  entityId: string;
  ownershipBps: number;
  isParent: boolean;
  currency: string;
  netProfitMinor: string;
  totalAssetsMinor: string;
  netAssetsMinor: string;
  /** The member's own balance sheet balanced. A member that does not, breaks the group. */
  ownBalanceSheetBalanced: boolean;
}

export interface ConsolidatedStatements {
  groupCode: string;
  groupName: string;
  currency: string;
  from: string;
  to: string;
  members: MemberColumn[];

  revenue: ConsolidatedSection;
  costOfSales: ConsolidatedSection;
  grossProfitMinor: string;
  expenses: ConsolidatedSection;
  /** The whole group's profit, including the part the minority owns. */
  netProfitMinor: string;
  profitAttributableToParentMinor: string;
  profitAttributableToNciMinor: string;

  assets: ConsolidatedSection;
  liabilities: ConsolidatedSection;
  /** The members' equity added together — the parent's owners and the minority together. */
  equity: ConsolidatedSection;
  equityAttributableToParentMinor: string;
  nonControllingInterestMinor: string;
  nci: NonControllingInterest[];

  totalAssetsMinor: string;
  /** Liabilities plus parent equity plus the non-controlling interest. */
  totalLiabilitiesEquityAndNciMinor: string;
  /** The whole point. Never plugged. */
  balanced: boolean;
  differenceMinor: string;

  eliminations: Elimination[];
  eliminationsApplied: boolean;
  /**
   * What these figures are, in one sentence, always. Never empty and never
   * conditional — a reader who is handed only the numbers has been misled.
   */
  basisNote: string;
  /** Never empty. What the module does not do, and what it costs the reader. */
  caveats: ConsolidationCaveat[];
  warnings: string[];
}

/* ------------------------------------------------------------ group keeping */

export async function createGroup(opts: {
  orgId: string;
  code: string;
  name: string;
  currency?: string;
}): Promise<GroupSummary> {
  const code = opts.code.trim();
  if (!code) throw new LedgerError("A consolidation group needs a code, so it can be asked for by name.");
  if (!opts.name.trim()) throw new LedgerError("A consolidation group needs a name.");

  const existing = await prisma.consolidationGroup.findFirst({ where: { orgId: opts.orgId, code } });
  if (existing) {
    throw new LedgerError(
      `A consolidation group with code ${code} already exists ("${existing.name}"). ` +
        `Use a different code, or add members to the one that is already there.`,
    );
  }

  const group = await prisma.consolidationGroup.create({
    data: { orgId: opts.orgId, code, name: opts.name.trim(), currency: opts.currency ?? "AED" },
  });
  return { code: group.code, name: group.name, currency: group.currency, memberCount: 0, parentEntityId: null };
}

export async function addMember(opts: {
  orgId: string;
  groupCode: string;
  entityId: string;
  ownershipBps?: number;
  isParent?: boolean;
}): Promise<GroupDetail> {
  const group = await mustFindGroup(opts.orgId, opts.groupCode);
  const ownershipBps = opts.ownershipBps ?? 10_000;
  const isParent = opts.isParent === true;

  // The database enforces this too. Checking here means the message names the
  // number the caller supplied and says what the range is, rather than
  // surfacing a constraint name.
  if (!Number.isInteger(ownershipBps) || ownershipBps <= 0 || ownershipBps > 10_000) {
    throw new LedgerError(
      `Ownership is held in basis points between 1 and 10000, where 10000 is wholly owned; ` +
        `${ownershipBps} is not a share anyone can hold. 75% is 7500.`,
    );
  }

  const already = group.members.find((m) => m.entityId === opts.entityId);
  if (already) {
    throw new LedgerError(
      `${opts.entityId} is already a member of ${group.code}. Remove it first if you need to change its ownership.`,
    );
  }

  // A member with no ledger contributes nothing and would fail mid-report with
  // a message that does not say which entity was at fault.
  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
  });
  if (!book) {
    throw new LedgerError(
      `No ledger has been opened for ${opts.entityId}, so it has nothing to consolidate. ` +
        `Open its books and chart of accounts first, then add it to ${group.code}.`,
    );
  }

  if (isParent) {
    const other = group.members.find((m) => m.isParent);
    if (other) {
      throw new LedgerError(
        `${group.code} already has a parent, ${other.entityId}. A group has exactly one — ` +
          `consolidation is about who controls whom, and two parents leaves that unanswered. ` +
          `Remove ${other.entityId} first if ${opts.entityId} is the parent instead.`,
      );
    }
  }

  await prisma.consolidationMember.create({
    data: { orgId: opts.orgId, groupId: group.id, entityId: opts.entityId, ownershipBps, isParent },
  });
  return groupDetail({ orgId: opts.orgId, groupCode: group.code });
}

export async function removeMember(opts: {
  orgId: string;
  groupCode: string;
  entityId: string;
}): Promise<GroupDetail> {
  const group = await mustFindGroup(opts.orgId, opts.groupCode);
  const member = group.members.find((m) => m.entityId === opts.entityId);
  if (!member) {
    throw new LedgerError(`${opts.entityId} is not a member of ${group.code}, so there is nothing to remove.`);
  }
  // Removing the parent while subsidiaries remain leaves a group that cannot be
  // consolidated at all, and the failure would surface later, somewhere else.
  if (member.isParent && group.members.length > 1) {
    const others = group.members.filter((m) => m.entityId !== opts.entityId).map((m) => m.entityId);
    throw new LedgerError(
      `${opts.entityId} is the parent of ${group.code} and ${others.length} other member` +
        `${others.length === 1 ? "" : "s"} (${others.join(", ")}) would be left without one. ` +
        `Remove them first, or make one of them the parent.`,
    );
  }

  await prisma.consolidationMember.delete({ where: { id: member.id } });
  return groupDetail({ orgId: opts.orgId, groupCode: group.code });
}

export async function groupList(opts: { orgId: string }): Promise<GroupSummary[]> {
  const groups = await prisma.consolidationGroup.findMany({
    where: { orgId: opts.orgId },
    include: { members: true },
    orderBy: { code: "asc" },
  });
  return groups.map((g) => ({
    code: g.code,
    name: g.name,
    currency: g.currency,
    memberCount: g.members.length,
    parentEntityId: g.members.find((m) => m.isParent)?.entityId ?? null,
  }));
}

export async function groupDetail(opts: { orgId: string; groupCode: string }): Promise<GroupDetail> {
  const group = await mustFindGroup(opts.orgId, opts.groupCode);
  const books = await prisma.book.findMany({
    where: { orgId: opts.orgId, entityId: { in: group.members.map((m) => m.entityId) }, code: "PRIMARY" },
    select: { entityId: true, functionalCurrency: true },
  });
  const currencyOf = new Map(books.map((b) => [b.entityId, b.functionalCurrency]));

  return {
    code: group.code,
    name: group.name,
    currency: group.currency,
    // Parent first: it is the entity the reader orients everything else around.
    members: [...group.members]
      .sort((a, b) => Number(b.isParent) - Number(a.isParent) || a.entityId.localeCompare(b.entityId))
      .map((m) => ({
        entityId: m.entityId,
        ownershipBps: m.ownershipBps,
        isParent: m.isParent,
        currency: currencyOf.get(m.entityId) ?? null,
        hasLedger: currencyOf.has(m.entityId),
      })),
  };
}

/* ----------------------------------------------------------- consolidation */

export async function consolidatedStatements(opts: {
  orgId: string;
  groupCode: string;
  from: string;
  to: string;
  /**
   * Take proposed intercompany eliminations off these figures. Off by default,
   * deliberately: a caller has to have read the candidates and decided they are
   * right. See the note at the top of this file.
   *
   * `true` applies every candidate, which is only honest when every one of them
   * has been looked at. A list of keys applies exactly those — because a
   * reviewer who believes one candidate should not thereby be made to accept
   * the rest, and an all-or-nothing switch is how a real third-party balance
   * gets eliminated by somebody who was agreeing to something else.
   */
  applyEliminations?: boolean | string[];
}): Promise<ConsolidatedStatements> {
  const group = await mustFindGroup(opts.orgId, opts.groupCode);
  if (group.members.length === 0) {
    throw new LedgerError(`${group.code} has no members yet, so there is nothing to consolidate. Add its parent entity first.`);
  }

  const parents = group.members.filter((m) => m.isParent);
  if (parents.length === 0) {
    throw new LedgerError(
      `${group.code} has no parent, so there is no entity whose control the consolidation is built on. ` +
        `Mark one of its members (${group.members.map((m) => m.entityId).join(", ")}) as the parent.`,
    );
  }
  if (parents.length > 1) {
    throw new LedgerError(
      `${group.code} has ${parents.length} parents (${parents.map((m) => m.entityId).join(", ")}). ` +
        `A group has exactly one — remove all but the entity that controls the others.`,
    );
  }

  const members = [...group.members].sort(
    (a, b) => Number(b.isParent) - Number(a.isParent) || a.entityId.localeCompare(b.entityId),
  );
  const order = members.map((m) => m.entityId);

  // Every member's statements come from statements.ts, so the group's figures
  // are the same figures as each entity's own accounts — including the rule
  // about periods the range only half covers, which is worked out once there
  // rather than restated here where the two could drift apart.
  const reports = await Promise.all(
    members.map(async (m) => ({
      member: m,
      pl: await profitAndLoss({ orgId: opts.orgId, entityId: m.entityId, from: opts.from, to: opts.to }),
      bs: await balanceSheet({ orgId: opts.orgId, entityId: m.entityId, asOf: opts.to }),
    })),
  );

  const warnings: string[] = [];

  /* --- intercompany candidates ------------------------------------------ */

  const eliminations = proposeEliminations(
    reports.map((r) => ({
      entityId: r.member.entityId,
      receivableMinor: presented(r.bs.assets.lines, AR_CODE),
      payableMinor: presented(r.bs.liabilities.lines, AP_CODE),
    })),
    warnings,
  );
  const chosen = Array.isArray(opts.applyEliminations) ? new Set(opts.applyEliminations) : null;
  if (chosen) {
    const unknown = [...chosen].filter((k) => !eliminations.some((e) => e.key === k));
    if (unknown.length) {
      throw new LedgerError(
        `${unknown.join(", ")} ${unknown.length === 1 ? "is not a candidate" : "are not candidates"} on this ` +
          `consolidation. The candidates change with the figures, so accept them from the run you are looking at.`,
      );
    }
  }
  for (const e of eliminations) {
    e.applied = chosen ? chosen.has(e.key) : opts.applyEliminations === true;
  }

  const eliminatedByCode = new Map<string, bigint>();
  for (const e of eliminations) {
    if (!e.applied) continue;
    const amount = BigInt(e.amountMinor);
    eliminatedByCode.set(AR_CODE, (eliminatedByCode.get(AR_CODE) ?? 0n) + amount);
    eliminatedByCode.set(AP_CODE, (eliminatedByCode.get(AP_CODE) ?? 0n) + amount);
  }
  const applyEliminations = eliminations.some((e) => e.applied);

  /* --- line by line, on account code ------------------------------------ */

  const build = (key: string, label: string, pick: (r: (typeof reports)[number]) => StatementLine[]) =>
    combine(key, label, order, reports.map((r) => ({ entityId: r.member.entityId, lines: pick(r) })), eliminatedByCode);

  const revenue = build("revenue", "Revenue", (r) => r.pl.revenue.lines);
  const costOfSales = build("cost_of_sales", "Cost of sales", (r) => r.pl.costOfSales.lines);
  const expenses = build("expenses", "Operating expenses", (r) => r.pl.expenses.lines);
  const assets = build("assets", "Assets", (r) => r.bs.assets.lines);
  const liabilities = build("liabilities", "Liabilities", (r) => r.bs.liabilities.lines);
  const equity = build("equity", "Equity", (r) => r.bs.equity.lines);

  const grossProfit = BigInt(revenue.totalMinor) - BigInt(costOfSales.totalMinor);
  const netProfit = grossProfit - BigInt(expenses.totalMinor);

  /* --- non-controlling interest ----------------------------------------- */

  const nci: NonControllingInterest[] = [];
  let nciNetAssets = 0n;
  let nciProfit = 0n;

  for (const r of reports) {
    const minorityBps = WHOLLY_OWNED_BPS - BigInt(r.member.ownershipBps);
    if (minorityBps === 0n) continue;

    // Net assets, not equity, because that is what the minority has a claim on
    // and it does not depend on the equity section being complete. The member
    // is consolidated in full above; this is only the split of what it is worth.
    const memberNetAssets = BigInt(r.bs.totalAssetsMinor) - BigInt(r.bs.liabilities.totalMinor);
    const memberProfit = BigInt(r.pl.netProfitMinor);
    const shareOfNetAssets = (memberNetAssets * minorityBps) / WHOLLY_OWNED_BPS;
    const shareOfProfit = (memberProfit * minorityBps) / WHOLLY_OWNED_BPS;

    nciNetAssets += shareOfNetAssets;
    nciProfit += shareOfProfit;
    nci.push({
      entityId: r.member.entityId,
      ownershipBps: r.member.ownershipBps,
      minorityBps: Number(minorityBps),
      memberNetAssetsMinor: memberNetAssets.toString(),
      memberProfitMinor: memberProfit.toString(),
      netAssetsMinor: shareOfNetAssets.toString(),
      profitMinor: shareOfProfit.toString(),
    });

    if (r.member.isParent) {
      warnings.push(
        `${r.member.entityId} is the parent of ${group.code} but is only ${(r.member.ownershipBps / 100).toFixed(2)}% owned. ` +
          `Its minority share is presented as a non-controlling interest, which is right only if the group really does ` +
          `consolidate the parent's own outside shareholders.`,
      );
    }
  }

  // Splitting the equity that was added together, rather than adding anything
  // to it: the group is worth what its members are worth, and this only says
  // who the claim belongs to. That is why the sheet still balances afterwards.
  const equityAttributableToParent = BigInt(equity.totalMinor) - nciNetAssets;

  const totalAssets = BigInt(assets.totalMinor);
  const totalLiabEqNci = BigInt(liabilities.totalMinor) + equityAttributableToParent + nciNetAssets;

  /* --- what this is not -------------------------------------------------- */

  const caveats = buildCaveats({
    members,
    measured: await measureUneliminated({
      orgId: opts.orgId, groupCode: group.code,
      memberCount: members.length, from: opts.from, to: opts.to,
    }),
    eliminationsApplied: applyEliminations,
  });

  const basisNote =
    `These are COMBINED figures, not consolidated ones. Every member's ledger has been added to every other ` +
    `member's, line by line on account code, and the non-controlling interest has been split out — but the ` +
    `parent's investment in each subsidiary has not been eliminated against that subsidiary's equity, and trade ` +
    `between members has not been eliminated either. So group assets and equity are overstated by the investment, ` +
    `and revenue, cost, receivables and payables are grossed up by whatever the members sold each other. Group ` +
    `profit and the sheet's balancing are not affected by the trade, because both sides of it are in here. ` +
    `Read this as a management view of the group; a set of IFRS 10 consolidated accounts needs the two ` +
    `eliminations below, and they are outside what this ledger can do on its own.`;

  /* --- warnings ---------------------------------------------------------- */

  for (const r of reports) {
    if (r.bs.currency !== group.currency) {
      warnings.push(
        `${r.member.entityId} reports in ${r.bs.currency} and ${group.code} reports in ${group.currency}. ` +
          `No rate was applied — its figures are included at face value, so the group's totals add ` +
          `${r.bs.currency} to ${group.currency}. Translate its ledger, or read this consolidation as indicative only.`,
      );
    }
    const nothing =
      r.pl.revenue.lines.length === 0 &&
      r.pl.costOfSales.lines.length === 0 &&
      r.pl.expenses.lines.length === 0 &&
      r.bs.assets.lines.length === 0 &&
      r.bs.liabilities.lines.length === 0 &&
      r.bs.equity.lines.length === 0;
    if (nothing) {
      warnings.push(
        `${r.member.entityId} has no postings between ${opts.from} and ${opts.to} and contributes nothing to ` +
          `${group.code}. Either its ledger is not being posted to, or it should not be a member.`,
      );
    }
    if (!r.bs.balanced) {
      warnings.push(
        `${r.member.entityId}'s own balance sheet is out by ${r.bs.differenceMinor} at ${opts.to}, and the group ` +
          `carries that difference. Fix the member's ledger — the group figure cannot be corrected here.`,
      );
    }
  }

  return {
    groupCode: group.code,
    groupName: group.name,
    currency: group.currency,
    from: opts.from,
    to: opts.to,
    members: reports.map((r) => ({
      entityId: r.member.entityId,
      ownershipBps: r.member.ownershipBps,
      isParent: r.member.isParent,
      currency: r.bs.currency,
      netProfitMinor: r.pl.netProfitMinor,
      totalAssetsMinor: r.bs.totalAssetsMinor,
      netAssetsMinor: (BigInt(r.bs.totalAssetsMinor) - BigInt(r.bs.liabilities.totalMinor)).toString(),
      ownBalanceSheetBalanced: r.bs.balanced,
    })),

    revenue,
    costOfSales,
    grossProfitMinor: grossProfit.toString(),
    expenses,
    netProfitMinor: netProfit.toString(),
    profitAttributableToParentMinor: (netProfit - nciProfit).toString(),
    profitAttributableToNciMinor: nciProfit.toString(),

    assets,
    liabilities,
    equity,
    equityAttributableToParentMinor: equityAttributableToParent.toString(),
    nonControllingInterestMinor: nciNetAssets.toString(),
    nci,

    totalAssetsMinor: totalAssets.toString(),
    totalLiabilitiesEquityAndNciMinor: totalLiabEqNci.toString(),
    balanced: totalAssets === totalLiabEqNci,
    differenceMinor: (totalAssets - totalLiabEqNci).toString(),

    eliminations,
    eliminationsApplied: applyEliminations,
    basisNote,
    caveats,
    warnings,
  };
}

/* ------------------------------------------------------------- the caveats */

/**
 * How much of what this module does not eliminate can actually be measured.
 *
 * `intercompany.ts` already does the hard half of this: it matches one member's
 * sales document against another member's purchase document and builds the
 * elimination journal a group accountant would write. That schedule was never
 * fed back here, so the consolidation went on saying "intragroup trade is not
 * eliminated" while the number sat one module away. This asks for it.
 *
 * Two figures come back, both of them things still IN the totals above:
 *   • trade_result — the intragroup sales the seller booked as revenue and the
 *     buyer booked as cost. Group profit is right (they are equal and opposite)
 *     and revenue and cost are each overstated by it.
 *   • trade_balance — what one member still owes another at the reporting date.
 *     Group assets and liabilities are each overstated by it, unless the
 *     candidate eliminations on this page have been applied.
 *
 * A failure to measure is reported, not swallowed. The matcher refuses a group
 * with fewer than two members — a member cannot trade with itself — and that is
 * a reason, not an error, so it produces a caveat that says the amount is
 * unquantified rather than one that implies it is nil.
 */
async function measureUneliminated(opts: {
  orgId: string;
  groupCode: string;
  memberCount: number;
  from: string;
  to: string;
}): Promise<{ tradeResultMinor: bigint | null; tradeBalanceMinor: bigint | null; why: string | null }> {
  if (opts.memberCount < 2) {
    return {
      tradeResultMinor: null,
      tradeBalanceMinor: null,
      why: "There is only one member in this group, so nothing here can be intragroup.",
    };
  }

  try {
    const schedule = await eliminationSchedule({
      orgId: opts.orgId, groupCode: opts.groupCode, from: opts.from, asOf: opts.to,
    });
    const totalOf = (kind: EliminationKind) =>
      schedule.entries.filter((e) => e.kind === kind).reduce((a, e) => a + BigInt(e.totalMinor), 0n);
    return {
      tradeResultMinor: totalOf("trade_result"),
      tradeBalanceMinor: totalOf("trade_balance"),
      why: null,
    };
  } catch (e) {
    // A LedgerError here is the matcher declining to run and saying why, which
    // belongs in the caveat. Anything else is a fault and is not this module's
    // to hide behind a caveat that reads as a measurement.
    if (!(e instanceof LedgerError)) throw e;
    return { tradeResultMinor: null, tradeBalanceMinor: null, why: e.message };
  }
}

/**
 * The caveats, built for every group whatever its shape.
 *
 * Both of these are unconditional by construction: there is no `if` in front of
 * either, and there must never be. What varies is only whether the amount could
 * be measured.
 */
function buildCaveats(opts: {
  members: GroupMember[];
  measured: { tradeResultMinor: bigint | null; tradeBalanceMinor: bigint | null; why: string | null };
  eliminationsApplied: boolean;
}): ConsolidationCaveat[] {
  const subsidiaries = opts.members.filter((m) => !m.isParent);
  const { tradeResultMinor, tradeBalanceMinor, why } = opts.measured;

  const investment: ConsolidationCaveat = {
    key: "investment_not_eliminated",
    title: "The investment in each subsidiary is still in these figures",
    detail:
      `IFRS 10.B86(b) eliminates the parent's carrying amount of its investment in each subsidiary against its ` +
      `share of that subsidiary's equity, and recognises any goodwill. That has not been done here and cannot be: ` +
      `nothing in the ledger links a shareholding to a member entity, so this module cannot tell the parent's ` +
      `investment in ${subsidiaries.length === 1 ? subsidiaries[0].entityId : "a subsidiary"} from any other asset ` +
      `it holds. The consequence is double counting — the investment appears as an asset of the parent AND the ` +
      `subsidiary's net assets appear line by line — and group equity is the members' equity added together, with ` +
      `no goodwill and no consolidation reserve. Real acquisition accounting is a separate exercise; take these ` +
      `figures into it rather than out of it.`,
    amountMinor: null,
    authority: "IFRS 10.B86(b), IFRS 3",
  };

  const measuredTrade = tradeResultMinor !== null && tradeBalanceMinor !== null;
  const trade: ConsolidationCaveat = {
    key: "intragroup_trade_not_eliminated",
    title: "Trade between members is still in these figures",
    detail: measuredTrade
      ? `IFRS 10.B86(c) eliminates intragroup income, expenses, assets and liabilities in full. That has not been ` +
        `done to the totals above. The intercompany matcher can see ` +
        `${tradeResultMinor} of sales between members over this period: revenue and cost of sales are each ` +
        `overstated by that, though group profit is not, because the two are equal and opposite. It can also see ` +
        `${tradeBalanceMinor} still owed between members at the reporting date, which overstates group receivables ` +
        `and group payables by the same amount each` +
        (opts.eliminationsApplied
          ? `, before the eliminations applied to this run. The two figures are not the same measurement — the ` +
            `applied eliminations pair whole control-account balances, and this one pairs documents — so read the ` +
            `intercompany screen for the pairs behind it.`
          : `; the candidates listed on this page are the control-account version of the same thing and none has ` +
            `been applied. Read the intercompany screen for the document-level pairs behind these numbers.`)
      : `IFRS 10.B86(c) eliminates intragroup income, expenses, assets and liabilities in full. That has not been ` +
        `done to the totals above, and how much is left in could not be measured. ${why ?? ""} ` +
        `Revenue, cost, receivables and payables are therefore each grossed up by whatever the members traded ` +
        `with each other; group profit is unaffected, because the two sides are equal and opposite.`.trim(),
    amountMinor: measuredTrade ? tradeResultMinor.toString() : null,
    authority: "IFRS 10.B86(c)",
  };

  return [investment, trade];
}

/* ------------------------------------------------------------------ helpers */

async function mustFindGroup(orgId: string, groupCode: string) {
  const group = await prisma.consolidationGroup.findFirst({
    where: { orgId, code: groupCode },
    include: { members: true },
  });
  if (!group) {
    throw new LedgerError(`There is no consolidation group with code ${groupCode} in this organisation.`);
  }
  return group;
}

/** A presented (natural-side, positive) figure for one account code, or zero. */
function presented(lines: StatementLine[], code: string): bigint {
  const line = lines.find((l) => l.code === code);
  return line ? BigInt(line.presentedMinor) : 0n;
}

/**
 * Add the members together on account code.
 *
 * Every line arrives already presented on its account's natural side by
 * statements.ts, and a section has one natural side throughout, so the members
 * can be added directly. A member with nothing on a code contributes an explicit
 * zero rather than a gap, because a blank column reads as "not applicable" when
 * what it means is "nil".
 */
function combine(
  key: string,
  label: string,
  order: string[],
  perMember: { entityId: string; lines: StatementLine[] }[],
  eliminatedByCode: Map<string, bigint>,
): ConsolidatedSection {
  const rows = new Map<string, { name: string; nameAr: string | null; byEntity: Map<string, bigint> }>();

  for (const m of perMember) {
    for (const l of m.lines) {
      let row = rows.get(l.code);
      if (!row) {
        row = { name: l.name, nameAr: l.nameAr, byEntity: new Map() };
        rows.set(l.code, row);
      }
      row.byEntity.set(m.entityId, (row.byEntity.get(m.entityId) ?? 0n) + BigInt(l.presentedMinor));
    }
  }

  const sectionByEntity = new Map<string, bigint>(order.map((e) => [e, 0n]));
  let combined = 0n;
  let eliminated = 0n;

  const lines: ConsolidatedLine[] = [...rows.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([code, row]) => {
      const byEntity: Record<string, string> = {};
      let rowTotal = 0n;
      for (const entityId of order) {
        const v = row.byEntity.get(entityId) ?? 0n;
        byEntity[entityId] = v.toString();
        rowTotal += v;
        sectionByEntity.set(entityId, (sectionByEntity.get(entityId) ?? 0n) + v);
      }
      const elim = eliminatedByCode.get(code) ?? 0n;
      combined += rowTotal;
      eliminated += elim;
      return {
        code,
        name: row.name,
        nameAr: row.nameAr,
        byEntity,
        combinedMinor: rowTotal.toString(),
        eliminationMinor: elim.toString(),
        totalMinor: (rowTotal - elim).toString(),
      };
    });

  return {
    key,
    label,
    lines,
    byEntity: Object.fromEntries(order.map((e) => [e, (sectionByEntity.get(e) ?? 0n).toString()])),
    combinedMinor: combined.toString(),
    eliminationMinor: eliminated.toString(),
    totalMinor: (combined - eliminated).toString(),
  };
}

/**
 * Look for balances that are equal and opposite across two members: one
 * member's trade receivables exactly matching another's trade payables.
 *
 * This is evidence, not proof. A control-account balance is the whole of an
 * entity's receivables — group and third party together — so an exact match
 * between two members is a strong hint and nothing more. The pairing is greedy
 * and deterministic (members in the order the caller gave, receivable side
 * first) so the same books always propose the same candidates; a reviewer who
 * rejected a candidate yesterday sees the same one today.
 *
 * Anything left over is warned about rather than forced into a pair. If one
 * member still has receivables and another still has payables, some of that may
 * be intragroup and the group's receivables and payables are then both
 * overstated — but the ledger records no counterparty, so only a human can say.
 */
function proposeEliminations(
  balances: { entityId: string; receivableMinor: bigint; payableMinor: bigint }[],
  warnings: string[],
): Elimination[] {
  const out: Elimination[] = [];
  const receivableLeft = new Map(balances.map((b) => [b.entityId, b.receivableMinor]));
  const payableLeft = new Map(balances.map((b) => [b.entityId, b.payableMinor]));

  for (const a of balances) {
    const ar = receivableLeft.get(a.entityId) ?? 0n;
    if (ar <= 0n) continue;

    // Every member whose payables equal this receivable. Taking the first and
    // stopping would both starve a genuine pair behind a coincidental one and
    // hide the ambiguity — and where two members owe the same amount, which of
    // them is the intragroup one is exactly what the ledger cannot say.
    const candidates = balances.filter(
      (b) => b.entityId !== a.entityId && (payableLeft.get(b.entityId) ?? 0n) === ar,
    );
    if (candidates.length > 1) {
      warnings.push(
        `${a.entityId} carries ${ar} on ${AR_CODE}, and ${candidates.map((c) => c.entityId).join(" and ")} each ` +
          `carry the same amount on ${AP_CODE}. Equal amounts are not evidence of which one it is owed by, so no ` +
          `elimination is proposed. The intercompany screen matches at document level and can tell them apart.`,
      );
      continue;
    }
    const b = candidates[0];
    if (!b) continue;

    out.push({
      key: `${a.entityId}:${b.entityId}:${ar}`,
      receivableEntityId: a.entityId,
      payableEntityId: b.entityId,
      receivableCode: AR_CODE,
      payableCode: AP_CODE,
      amountMinor: ar.toString(),
      reason:
        `${a.entityId} carries ${ar} on ${AR_CODE} and ${b.entityId} carries the same amount on ${AP_CODE}. ` +
        `Equal and opposite across two members of the group, which is what an unsettled intragroup invoice ` +
        `looks like — but this compares whole control-account balances, so it is a coincidence away from being ` +
        `wrong, and eliminating it then removes a real third-party balance. The intercompany screen matches ` +
        `document by document and carries the evidence; confirm there before applying this.`,
      applied: false,
    });
    receivableLeft.set(a.entityId, 0n);
    payableLeft.set(b.entityId, 0n);
  }

  const strandedAr = balances.filter((b) => (receivableLeft.get(b.entityId) ?? 0n) > 0n);
  const strandedAp = balances.filter((b) => (payableLeft.get(b.entityId) ?? 0n) > 0n);
  // Only worth saying when both sides exist somewhere in the group. A member
  // with third-party customers and no member owing anybody anything has nothing
  // intragroup to eliminate, and warning about it every month teaches people to
  // ignore the warnings.
  if (strandedAr.length && strandedAp.length) {
    for (const b of strandedAr) {
      const others = strandedAp.filter((p) => p.entityId !== b.entityId);
      if (!others.length) continue;
      warnings.push(
        `${b.entityId} has ${receivableLeft.get(b.entityId)} on ${AR_CODE} that no member's ${AP_CODE} balance ` +
          `matches, while ${others.map((o) => `${o.entityId} owes ${payableLeft.get(o.entityId)}`).join(" and ")}. ` +
          `If any of that is intragroup, the group's receivables and payables are both overstated by it. ` +
          `A journal line records no counterparty, so this cannot be settled from the ledger alone.`,
      );
    }
  }

  return out;
}
