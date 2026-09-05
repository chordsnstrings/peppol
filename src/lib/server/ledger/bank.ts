import { createHash } from "node:crypto";
import { prisma } from "@/lib/server/prisma";
import { post, LedgerError } from "./post";

/**
 * Bank reconciliation.
 *
 * The bank's statement and our ledger are two independent records of the same
 * events. Reconciliation is the act of comparing them, and it is the control
 * that catches the errors nothing else does — a payment recorded twice, a
 * charge nobody booked, a receipt that never actually arrived.
 *
 * That is why bank lines are stored apart from journal lines rather than
 * imported into the ledger. The moment the two become one table, there is
 * nothing left to compare.
 *
 * Nothing here posts to the ledger by itself. Matching says "these two records
 * describe the same event"; creating a missing entry from a bank line is an
 * explicit separate act, because the bank telling us about a charge is not the
 * same as us having decided what it was for.
 */

export interface ImportLine {
  postedOn: string;
  description: string;
  reference?: string;
  /** Signed minor units, debit-positive — money in is positive. */
  amountMinor: number | bigint | string;
  balanceMinor?: number | bigint | string;
}

/**
 * A stable identity for a bank line.
 *
 * Banks rarely supply a usable unique id, and statement files overlap: pull
 * March and then Q1 and the same fortnight arrives twice. The fingerprint is a
 * hash of what the bank does give, so a re-import is idempotent — while two
 * genuinely identical transactions on the same day (two 50.00 card payments to
 * the same merchant) stay distinguishable through the running balance, which
 * differs between them.
 */
export function fingerprintOf(l: {
  postedOn: string;
  description: string;
  reference?: string;
  amountMinor: bigint;
  balanceMinor?: bigint | null;
}): string {
  return createHash("sha256")
    .update(
      [
        l.postedOn.slice(0, 10),
        l.description.trim().toLowerCase().replace(/\s+/g, " "),
        l.reference?.trim() ?? "",
        l.amountMinor.toString(),
        l.balanceMinor?.toString() ?? "",
      ].join(" "),
    )
    .digest("hex")
    .slice(0, 32);
}

export async function importStatement(opts: {
  orgId: string;
  entityId: string;
  /** Ledger account code for the bank account, e.g. "1010". */
  accountCode: string;
  lines: ImportLine[];
  /** Names this import so it can be reviewed or undone as a unit. */
  batch?: string;
}): Promise<{ batch: string; imported: number; duplicates: number; total: number }> {
  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.accountCode },
  });
  if (!account) throw new LedgerError(`Account ${opts.accountCode} does not exist in this entity's chart.`);
  if (account.subtype !== "BANK" && account.subtype !== "CASH") {
    throw new LedgerError(`Account ${account.code} ${account.name} is not a bank account.`);
  }

  const batch = opts.batch ?? `import-${Date.now()}`;
  const currency = account.currency ?? "AED";

  const rows = opts.lines.map((l) => {
    const amountMinor = BigInt(l.amountMinor);
    if (amountMinor === 0n) {
      throw new LedgerError(`A bank line dated ${l.postedOn} has a zero amount and cannot be reconciled.`);
    }
    const balanceMinor = l.balanceMinor === undefined ? null : BigInt(l.balanceMinor);
    return {
      orgId: opts.orgId,
      entityId: opts.entityId,
      accountId: account.id,
      postedOn: new Date(l.postedOn),
      description: l.description.trim(),
      reference: l.reference?.trim() || null,
      amountMinor,
      currency,
      balanceMinor,
      fingerprint: fingerprintOf({ ...l, amountMinor, balanceMinor }),
      importBatch: batch,
    };
  });

  // skipDuplicates leans on the unique index, so re-importing an overlapping
  // file is safe rather than merely unlikely to hurt.
  const res = await prisma.bankStatementLine.createMany({ data: rows, skipDuplicates: true });
  return { batch, imported: res.count, duplicates: rows.length - res.count, total: rows.length };
}

export interface Suggestion {
  bankLineId: string;
  journalLineId: string;
  entryReference: string;
  entryMemo: string | null;
  entryDate: string;
  amountMinor: string;
  dayGap: number;
  /** 0-100. An identical amount is a precondition, so this scores date and reference. */
  confidence: number;
  why: string[];
}

/**
 * Propose matches. It proposes; it never decides.
 *
 * An automatic matcher that commits its own guesses turns a control into a
 * rubber stamp — the whole value of a reconciliation is that a person looked.
 * So this returns suggestions with the reason for each, and only exact,
 * unambiguous amount matches are considered at all.
 */
export async function suggestMatches(opts: {
  orgId: string;
  entityId: string;
  accountCode: string;
  /** How far apart a bank line and a posting may be and still be one event. */
  windowDays?: number;
}): Promise<Suggestion[]> {
  const windowDays = opts.windowDays ?? 5;
  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.accountCode },
  });
  if (!account) throw new LedgerError(`Account ${opts.accountCode} does not exist.`);

  const bankLines = await prisma.bankStatementLine.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, accountId: account.id, status: "unmatched" },
    orderBy: { postedOn: "asc" },
  });
  if (bankLines.length === 0) return [];

  const already = await prisma.bankStatementLine.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, accountId: account.id, matchedLineId: { not: null } },
    select: { matchedLineId: true },
  });
  /*
   * The postings a bank line has already claimed.
   *
   * They used to be excluded in the query, as `id: { notIn: taken }`, which is
   * one bind parameter per id — and PostgreSQL refuses a statement past 65,535
   * of them. An account with four years of matched history would not slow
   * down, it would fail outright, and it would fail on the account with the
   * most to reconcile. The set is carried here and the rows sifted below,
   * which excludes exactly the same postings.
   */
  const taken = new Set(already.map((a) => a.matchedLineId as string));

  /*
   * Only the postings near enough in time to be one of these events.
   *
   * A candidate more than `windowDays * 3` from the statement line is thrown
   * away below whatever it scores, so reading it was never going to change an
   * answer — and reading every posting an account has carried for five years to
   * throw almost all of them away is what the exclusion above used to hide.
   * The band is the same rule, asked of the database instead.
   */
  const reach = windowDays * 3 * 86_400_000;
  const earliest = new Date(bankLines[0].postedOn.getTime() - reach);
  const latest = new Date(bankLines[bankLines.length - 1].postedOn.getTime() + reach);

  const journalLines = (
    await prisma.journalLine.findMany({
      where: {
        orgId: opts.orgId,
        accountId: account.id,
        entry: { status: "posted", entryDate: { gte: earliest, lte: latest } },
      },
      include: { entry: { select: { series: true, number: true, entryDate: true, memo: true } } },
    })
  ).filter((j) => !taken.has(j.id));

  const suggestions: Suggestion[] = [];
  const claimed = new Set<string>();

  for (const b of bankLines) {
    const sameAmount = journalLines.filter((j) => j.txnAmountMinor === b.amountMinor && !claimed.has(j.id));
    if (sameAmount.length === 0) continue;

    const scored = sameAmount
      .map((j) => {
        const dayGap = Math.round(Math.abs(j.entry.entryDate.getTime() - b.postedOn.getTime()) / 86_400_000);
        const why: string[] = ["the amount is identical"];
        let confidence = 40;
        if (dayGap === 0) {
          confidence += 40;
          why.push("same date");
        } else if (dayGap <= windowDays) {
          confidence += 30 - dayGap * 4;
          why.push(`${dayGap} day${dayGap === 1 ? "" : "s"} apart`);
        } else {
          confidence -= 20;
          why.push(`${dayGap} days apart`);
        }

        const ref = `${j.entry.series}-${j.entry.number}`;
        const hay = `${b.description} ${b.reference ?? ""}`.toLowerCase();
        const bareNumber = String(j.entry.number).replace(/^0+/, "");
        if (b.reference && bareNumber && hay.includes(bareNumber)) {
          confidence += 20;
          why.push("the bank reference contains our entry number");
        }
        const memoWord = (j.entry.memo ?? "").toLowerCase().split(/\s+/).filter((w) => w.length > 4)[0];
        if (memoWord && hay.includes(memoWord)) {
          confidence += 10;
          why.push(`both mention "${memoWord}"`);
        }

        return { j, dayGap, confidence: Math.max(0, Math.min(100, confidence)), why, ref };
      })
      .filter((s) => s.dayGap <= windowDays * 3)
      .sort((a, z) => z.confidence - a.confidence);

    if (scored.length === 0) continue;
    const best = scored[0];

    // Two equally good candidates is not a match, it is a question. Saying so
    // is more useful than picking one and being right half the time.
    if (scored.length > 1 && scored[1].confidence === best.confidence) {
      best.confidence = Math.min(best.confidence, 45);
      best.why.push(`${scored.length} postings fit equally well — choose one`);
    }

    claimed.add(best.j.id);
    suggestions.push({
      bankLineId: b.id,
      journalLineId: best.j.id,
      entryReference: best.ref,
      entryMemo: best.j.entry.memo,
      entryDate: best.j.entry.entryDate.toISOString().slice(0, 10),
      amountMinor: b.amountMinor.toString(),
      dayGap: best.dayGap,
      confidence: best.confidence,
      why: best.why,
    });
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}

/** Record that a bank line and a posting are the same event. */
export async function confirmMatch(opts: {
  orgId: string;
  bankLineId: string;
  journalLineId: string;
  userId?: string;
}) {
  const [bank, journal] = await Promise.all([
    prisma.bankStatementLine.findFirst({ where: { id: opts.bankLineId, orgId: opts.orgId } }),
    prisma.journalLine.findFirst({ where: { id: opts.journalLineId, orgId: opts.orgId } }),
  ]);
  if (!bank) throw new LedgerError("That bank line does not exist.");
  if (!journal) throw new LedgerError("That journal line does not exist.");
  if (bank.accountId !== journal.accountId) {
    throw new LedgerError("A bank line can only be matched to a posting on the same account.");
  }
  if (bank.amountMinor !== journal.txnAmountMinor) {
    throw new LedgerError(
      `These are different amounts (${bank.amountMinor} against ${journal.txnAmountMinor}). ` +
        `If the difference is real — a charge, or a short payment — post it before matching.`,
    );
  }
  if (bank.status === "matched") throw new LedgerError("That bank line is already matched.");

  // One posting can only be the counterpart of one bank line. A unique index
  // guarantees it; this check exists so the refusal arrives as a sentence
  // rather than as a constraint violation.
  const claimed = await prisma.bankStatementLine.findFirst({
    where: { orgId: opts.orgId, matchedLineId: journal.id },
    select: { description: true, postedOn: true },
  });
  if (claimed) {
    throw new LedgerError(
      `That posting is already matched to the bank line "${claimed.description}" of ` +
        `${claimed.postedOn.toISOString().slice(0, 10)}. If the bank really debited it twice, ` +
        `the second one needs its own entry rather than a second match.`,
    );
  }

  return prisma.bankStatementLine.update({
    where: { id: bank.id },
    data: { status: "matched", matchedLineId: journal.id, matchedAt: new Date(), matchedBy: opts.userId ?? null },
  });
}

/** The idempotency key `postFromBankLine` books a statement line under. */
const bankLineKey = (bankLineId: string) => `bank-line:${bankLineId}`;

/** Undo a match. A reconciliation nobody can unpick is one nobody will trust. */
export async function unmatch(opts: { orgId: string; bankLineId: string }) {
  const bank = await prisma.bankStatementLine.findFirst({ where: { id: opts.bankLineId, orgId: opts.orgId } });
  if (!bank) throw new LedgerError("That bank line does not exist.");
  return prisma.bankStatementLine.update({
    where: { id: bank.id },
    data: { status: "unmatched", matchedLineId: null, matchedAt: null, matchedBy: null },
  });
}

/**
 * Book something the bank knows about and we did not — a charge, interest, a
 * direct debit. This posts and then matches, because a bank line that produced
 * an entry and then failed to match it is worse than one nobody touched.
 */
export async function postFromBankLine(opts: {
  orgId: string;
  entityId: string;
  bankLineId: string;
  /** The other side: 6350 bank charges, 4900 other income, and so on. */
  contraAccount: string;
  memo?: string;
  userId?: string;
}) {
  const bank = await prisma.bankStatementLine.findFirst({
    where: { id: opts.bankLineId, orgId: opts.orgId },
    include: { account: true },
  });
  if (!bank) throw new LedgerError("That bank line does not exist.");
  if (bank.status === "matched") throw new LedgerError("That bank line is already matched to a posting.");

  /*
   * A statement line is booked once, and only once.
   *
   * post() is idempotent on externalKey, so without this a second attempt
   * would hand back the FIRST entry and quietly match to it again — including
   * after that entry has been reversed. Somebody who booked a charge to the
   * wrong contra account, unmatched it and reversed it would press Post again,
   * see it succeed, and get the same wrong posting back with no sign anything
   * had gone amiss. The correction has to be a journal of its own.
   */
  const already = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey: bankLineKey(bank.id) },
    select: { series: true, number: true, status: true },
  });
  if (already) {
    const ref = `${already.series}-${already.number}`;
    throw new LedgerError(
      already.status === "reversed"
        ? `This bank line was already booked as ${ref}, and ${ref} has been reversed. Booking it again would ` +
          `return that same reversed entry rather than a new one — post the correction as a journal and match ` +
          `this line to it instead.`
        : `This bank line was already booked as ${ref}; it is that entry it needs to be matched to, not booked ` +
          `a second time.`,
    );
  }

  const amount = bank.amountMinor;
  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: bank.postedOn,
    memo: opts.memo ?? bank.description,
    source: "bank",
    sourceType: "STATEMENT_LINE",
    sourceId: bank.id,
    externalKey: bankLineKey(bank.id),
    actorType: "HUMAN",
    actorId: opts.userId,
    series: "BK",
    lines: [
      { account: bank.account.code, ...(amount > 0n ? { debit: amount } : { credit: -amount }) },
      { account: opts.contraAccount, ...(amount > 0n ? { credit: amount } : { debit: -amount }) },
    ],
  });

  const bankSide = await prisma.journalLine.findFirst({
    where: { entryId: entry.id, accountId: bank.accountId },
  });
  if (!bankSide) throw new LedgerError("The posting did not reach the bank account.");

  await prisma.bankStatementLine.update({
    where: { id: bank.id },
    data: { status: "matched", matchedLineId: bankSide.id, matchedAt: new Date(), matchedBy: opts.userId ?? null },
  });

  return { entryId: entry.id, reference: `${entry.series}-${entry.number}` };
}

/**
 * The figures a reconciliation comes to, without any of the rows behind them.
 *
 * This exists because the figures and the itemisation have different sizes. A
 * caller that only wants to know whether an account is clean — the month-end
 * checklist, the attention list, anything that asks the same question of every
 * bank account in a loop — was paying for every statement line and every
 * posting the account has ever carried, to read three totals off the end of
 * them. Five years at two thousand transactions a month is a hundred and
 * twenty thousand rows, per account, per call.
 *
 * Every figure here is exact and covers the whole life of the account up to
 * `asOf`. Nothing in it is sampled, capped or windowed: it is computed by the
 * database rather than by counting rows in memory, which is why it can afford
 * to be complete.
 */
export interface ReconciliationSummary {
  accountCode: string;
  accountName: string;
  asOf: string;
  currency: string;
  /** What our books say the account holds. */
  ledgerBalanceMinor: string;
  /** What the bank's last reported running balance says. */
  statementBalanceMinor: string | null;
  /** Posted but not yet on the statement — cheques written, transfers in flight. */
  outstandingInLedgerMinor: string;
  /** On the statement but not posted — charges and receipts we have not booked. */
  unrecordedInBankMinor: string;
  /** ledger − outstanding + unrecorded, which must equal the statement. */
  reconciledBalanceMinor: string;
  reconciled: boolean;
  differenceMinor: string;
  /** Every unexplained statement line up to `asOf`, not only the ones listed. */
  unmatchedBankCount: number;
  /** Every posting the bank has not seen up to `asOf`, not only the ones listed. */
  unmatchedLedgerCount: number;
  matchedCount: number;
  /**
   * The oldest statement line still unexplained, or null where there are none.
   *
   * It is here so that a caller measuring how long something has been sitting
   * unexplained does not have to pull the list down to find its first row.
   */
  oldestUnmatchedBankOn: string | null;
}

export interface Reconciliation extends ReconciliationSummary {
  unmatchedBank: { id: string; postedOn: string; description: string; amountMinor: string }[];
  unmatchedLedger: { id: string; reference: string; entryDate: string; memo: string | null; amountMinor: string }[];
  /**
   * The pairs somebody has already agreed on.
   *
   * A matched line used to disappear from this statement altogether, which made
   * a wrong match the one mistake on the page that could not be corrected: the
   * arithmetic still tied, because matching forces equal amounts, so the damage
   * was the itemisation — the outstanding-cheque working paper naming the wrong
   * cheque, with nothing on screen to unpick.
   */
  matched: MatchedPair[];
  /** The earliest date itemised. Null where the lists were not bounded below. */
  itemsSince: string | null;
  /** How many rows of each list were asked for. */
  itemLimit: number;
  /**
   * What the three lists leave out, in a sentence.
   *
   * The figures above are complete and the lists are not, and a page showing
   * both would otherwise invite the reader to add up the rows and wonder why
   * they do not reach the total.
   */
  itemsNote: string;
}

export interface MatchedPair {
  bankLineId: string;
  postedOn: string;
  description: string;
  amountMinor: string;
  matchedAt: string | null;
  /** Null only if the posting behind the match has since gone; unmatch it. */
  journalLineId: string | null;
  reference: string | null;
  entryDate: string | null;
  memo: string | null;
  /** posted | reversed — the entry's own status, not the match's. */
  entryStatus: string | null;
  /**
   * The entry that reversed the matched posting, where one has.
   *
   * Reversing does not touch the match, so the statement line stays pointing at
   * an entry that has been undone while the reversal's own bank line sits in
   * the outstanding list — an item that will never clear, because the bank
   * never saw either half. Naming the reversal here is what lets somebody see
   * that and unmatch.
   */
  reversedBy: string | null;
}

/**
 * How many ids go into one `in (…)`.
 *
 * PostgreSQL's wire protocol carries a hard limit of 65,535 bind parameters,
 * and past it a query does not slow down — it fails, on exactly the account
 * with the most history behind it. The ledger export chunks at the same 5,000.
 */
const ID_CHUNK = 5_000;

/** Rows of each list a reconciliation itemises before it says how many more there are. */
const DEFAULT_ITEM_LIMIT = 200;

/**
 * How many postings the search for unmatched ones will read before it stops.
 *
 * A match is recorded on the bank line, not on the journal line, so "postings
 * the bank has not seen" cannot be a `where` clause: the rows have to be read
 * and sifted. Reading them oldest first means the ones worth looking at — the
 * cheque written in March that still has not cleared — are the ones found
 * first, and the ceiling is what stops a five-year-old account reading a
 * hundred thousand rows to show two hundred. The count beside the list is
 * exact whether or not the search reached the end.
 */
const LEDGER_SCAN_CEILING = 20_000;

/**
 * The account, the figures, and the ids of the postings already claimed.
 *
 * Both entry points below need all three, and computing them once is what lets
 * `reconciliationSummary` be genuinely cheaper than `reconcile` rather than the
 * same work with the rows thrown away at the end.
 */
async function reconciliationFigures(opts: {
  orgId: string;
  entityId: string;
  accountCode: string;
  asOf?: Date;
}) {
  const asOf = opts.asOf ?? new Date();
  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.accountCode },
  });
  if (!account) throw new LedgerError(`Account ${opts.accountCode} does not exist.`);

  const ledgerWhere = {
    orgId: opts.orgId,
    accountId: account.id,
    // Both halves of a reversed pair, or the ledger balance here would be
    // out by the reversal while the bank statement is not.
    entry: { status: { in: ["posted", "reversed"] }, entryDate: { lte: asOf } },
  };
  /*
   * `entityId` is named even though `accountId` already implies it — the
   * account was looked up within this entity, so no line on it can belong to
   * another. It is here because the only index on a statement line leads with
   * the entity, and a filter that skips it can use nothing past the org.
   */
  const bankWhere = {
    orgId: opts.orgId,
    entityId: opts.entityId,
    accountId: account.id,
    postedOn: { lte: asOf },
  };

  const [ledger, unrecorded, withBalance, oldestUnmatched, claims] = await Promise.all([
    prisma.journalLine.aggregate({ where: ledgerWhere, _sum: { txnAmountMinor: true }, _count: { _all: true } }),
    prisma.bankStatementLine.aggregate({
      where: { ...bankWhere, status: "unmatched" },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
    // The bank's own last reported running balance, when the file supplied one.
    prisma.bankStatementLine.findFirst({
      where: { ...bankWhere, balanceMinor: { not: null } },
      orderBy: [{ postedOn: "desc" }, { createdAt: "desc" }],
      select: { balanceMinor: true },
    }),
    prisma.bankStatementLine.findFirst({
      where: { ...bankWhere, status: "unmatched" },
      orderBy: [{ postedOn: "asc" }, { createdAt: "asc" }],
      select: { postedOn: true },
    }),
    prisma.bankStatementLine.findMany({
      where: { ...bankWhere, matchedLineId: { not: null } },
      select: { matchedLineId: true },
    }),
  ]);

  /*
   * What the matched postings come to.
   *
   * There is no relation from a journal line back to the statement line that
   * claims it — the match lives on the bank line — so this cannot be a join:
   * the ids have to be carried across in an `in`, and one of those is a bind
   * parameter each. Hence the chunking; a busy account passes 65,535 matched
   * lines inside four years, and the whole page would fail rather than slow.
   *
   * Only postings inside the balance can come out of it, so the same date and
   * status filter is applied to the chunk. A bank line dated inside the period
   * can be matched to a posting dated after it, and that pair leaves the
   * posting outside `asOf` and the outstanding figure rightly untouched.
   */
  const matchedIds = claims.map((c) => c.matchedLineId as string);
  let matchedSumMinor = 0n;
  let matchedInLedger = 0;
  for (let i = 0; i < matchedIds.length; i += ID_CHUNK) {
    const chunk = await prisma.journalLine.aggregate({
      where: { ...ledgerWhere, id: { in: matchedIds.slice(i, i + ID_CHUNK) } },
      _sum: { txnAmountMinor: true },
      _count: { _all: true },
    });
    matchedSumMinor += chunk._sum.txnAmountMinor ?? 0n;
    matchedInLedger += chunk._count._all;
  }

  const ledgerBalance = ledger._sum.txnAmountMinor ?? 0n;
  const outstanding = ledgerBalance - matchedSumMinor;
  const unrecordedMinor = unrecorded._sum.amountMinor ?? 0n;
  const statementBalance = withBalance?.balanceMinor ?? null;
  const reconciled = ledgerBalance - outstanding + unrecordedMinor;

  const summary: ReconciliationSummary = {
    accountCode: account.code,
    accountName: account.name,
    asOf: asOf.toISOString().slice(0, 10),
    currency: account.currency ?? "AED",
    ledgerBalanceMinor: ledgerBalance.toString(),
    statementBalanceMinor: statementBalance?.toString() ?? null,
    outstandingInLedgerMinor: outstanding.toString(),
    unrecordedInBankMinor: unrecordedMinor.toString(),
    reconciledBalanceMinor: reconciled.toString(),
    reconciled: statementBalance !== null && reconciled === statementBalance,
    differenceMinor: statementBalance === null ? "0" : (reconciled - statementBalance).toString(),
    unmatchedBankCount: unrecorded._count._all,
    unmatchedLedgerCount: ledger._count._all - matchedInLedger,
    matchedCount: matchedIds.length,
    oldestUnmatchedBankOn: oldestUnmatched?.postedOn.toISOString().slice(0, 10) ?? null,
  };

  return { account, asOf, summary, claimed: new Set(matchedIds) };
}

/**
 * Whether an account reconciles, and by how much, without a single row of
 * itemisation.
 *
 * Use this wherever the answer is a number rather than a working paper — a
 * checklist asking every bank account the same question, a notification
 * deciding whether there is anything to say. `reconcile` below adds the items
 * to it, and the items are what cost.
 */
export async function reconciliationSummary(opts: {
  orgId: string;
  entityId: string;
  accountCode: string;
  asOf?: Date;
}): Promise<ReconciliationSummary> {
  return (await reconciliationFigures(opts)).summary;
}

/**
 * The reconciliation statement: our balance, the bank's, and every item that
 * explains the gap. A reconciliation that only says "out by 412.50" has not
 * done its job — the items are the answer.
 *
 * The figures are the whole life of the account; the three lists are the
 * oldest `limit` of each, because an account that has been running for years
 * holds more matched pairs than anybody will ever read and the oldest item is
 * always the one worth looking at. `itemsNote` says what was left off, so that
 * nobody adds up the rows on the page and wonders why they do not reach the
 * total above them.
 */
export async function reconcile(opts: {
  orgId: string;
  entityId: string;
  accountCode: string;
  asOf?: Date;
  /** Itemise nothing earlier than this. The figures are unaffected by it. */
  since?: Date;
  /** Rows of each list. Defaults to 200. */
  limit?: number;
}): Promise<Reconciliation> {
  const { account, asOf, summary, claimed } = await reconciliationFigures(opts);
  const limit = opts.limit ?? DEFAULT_ITEM_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new LedgerError(`A reconciliation lists a whole number of rows, so ${opts.limit} is not one.`);
  }
  const since = opts.since ?? null;
  const bankWindow = since ? { gte: since, lte: asOf } : { lte: asOf };
  const bankWhere = { orgId: opts.orgId, entityId: opts.entityId, accountId: account.id, postedOn: bankWindow };

  const [unmatchedBank, matchedBank, scanned] = await Promise.all([
    prisma.bankStatementLine.findMany({
      where: { ...bankWhere, status: "unmatched" },
      orderBy: [{ postedOn: "asc" }, { createdAt: "asc" }],
      take: limit,
    }),
    /*
     * The matched pairs, read separately from the balances above.
     *
     * A match is not bounded by `asOf` the way the balance is: a bank line
     * dated inside the period can perfectly well be matched to a posting dated
     * after it, and dropping that pair would show the line as matched to
     * nothing.
     */
    prisma.bankStatementLine.findMany({
      where: { ...bankWhere, matchedLineId: { not: null } },
      orderBy: [{ postedOn: "asc" }, { createdAt: "asc" }],
      take: limit,
    }),
    prisma.journalLine.findMany({
      where: {
        orgId: opts.orgId,
        accountId: account.id,
        entry: {
          status: { in: ["posted", "reversed"] },
          entryDate: since ? { gte: since, lte: asOf } : { lte: asOf },
        },
      },
      include: { entry: { select: { series: true, number: true, entryDate: true, memo: true } } },
      orderBy: { entry: { entryDate: "asc" } },
      take: LEDGER_SCAN_CEILING,
    }),
  ]);

  const unmatchedLedger = scanned.filter((l) => !claimed.has(l.id)).slice(0, limit);
  const scanCut = scanned.length === LEDGER_SCAN_CEILING;

  const matchedLineIds = matchedBank.map((b) => b.matchedLineId as string);
  const matchedLines: Awaited<ReturnType<typeof readMatchedLines>> = [];
  for (let i = 0; i < matchedLineIds.length; i += ID_CHUNK) {
    matchedLines.push(...(await readMatchedLines(opts.orgId, matchedLineIds.slice(i, i + ID_CHUNK))));
  }
  const lineById = new Map(matchedLines.map((l) => [l.id, l]));

  const reversedEntryIds = matchedLines.filter((l) => l.entry.status === "reversed").map((l) => l.entry.id);
  const reversals = reversedEntryIds.length
    ? await prisma.journalEntry.findMany({
        where: { orgId: opts.orgId, reversalOfId: { in: reversedEntryIds } },
        select: { series: true, number: true, reversalOfId: true },
      })
    : [];
  const reversalOf = new Map(reversals.map((r) => [r.reversalOfId as string, `${r.series}-${r.number}`]));

  const matched: MatchedPair[] = matchedBank.map((b) => {
    const line = lineById.get(b.matchedLineId as string);
    return {
      bankLineId: b.id,
      postedOn: b.postedOn.toISOString().slice(0, 10),
      description: b.description,
      amountMinor: b.amountMinor.toString(),
      matchedAt: b.matchedAt?.toISOString().slice(0, 10) ?? null,
      journalLineId: line?.id ?? null,
      reference: line ? `${line.entry.series}-${line.entry.number}` : null,
      entryDate: line?.entry.entryDate.toISOString().slice(0, 10) ?? null,
      memo: line ? line.memo ?? line.entry.memo : null,
      entryStatus: line?.entry.status ?? null,
      reversedBy: line ? reversalOf.get(line.entry.id) ?? null : null,
    };
  });

  const whole =
    !scanCut &&
    since === null &&
    unmatchedBank.length === summary.unmatchedBankCount &&
    unmatchedLedger.length === summary.unmatchedLedgerCount &&
    matched.length === summary.matchedCount;

  return {
    ...summary,
    unmatchedBank: unmatchedBank.map((b) => ({
      id: b.id,
      postedOn: b.postedOn.toISOString().slice(0, 10),
      description: b.description,
      amountMinor: b.amountMinor.toString(),
    })),
    unmatchedLedger: unmatchedLedger.map((l) => ({
      id: l.id,
      reference: `${l.entry.series}-${l.entry.number}`,
      entryDate: l.entry.entryDate.toISOString().slice(0, 10),
      memo: l.memo ?? l.entry.memo,
      amountMinor: l.txnAmountMinor.toString(),
    })),
    matched,
    itemsSince: since ? since.toISOString().slice(0, 10) : null,
    itemLimit: limit,
    itemsNote: whole
      ? `Every item behind this reconciliation is listed: ${count(summary.unmatchedBankCount, "unexplained statement line")}, ` +
        `${count(summary.unmatchedLedgerCount, "posting the bank has not seen", "postings the bank has not seen")} and ` +
        `${count(summary.matchedCount, "matched pair")}.`
      : `The figures are the whole account to ${summary.asOf}; the lists are the oldest ${limit} of each. ` +
        `Showing ${unmatchedBank.length} of ${summary.unmatchedBankCount} unexplained statement lines, ` +
        `${unmatchedLedger.length} of ${summary.unmatchedLedgerCount} postings the bank has not seen, and ` +
        `${matched.length} of ${summary.matchedCount} matched pairs.` +
        (since ? ` Nothing before ${since.toISOString().slice(0, 10)} is itemised.` : "") +
        (scanCut
          ? ` The search for unmatched postings stopped after ${LEDGER_SCAN_CEILING.toLocaleString("en")} of them, ` +
            `so an older one may be missing from the list — it is still inside the figures.`
          : ""),
  };
}

/** The postings behind a page of matched bank lines, with what reversed them. */
function readMatchedLines(orgId: string, ids: string[]) {
  return prisma.journalLine.findMany({
    where: { orgId, id: { in: ids } },
    include: { entry: { select: { id: true, series: true, number: true, entryDate: true, memo: true, status: true } } },
  });
}

/** "3 matched pairs", "1 matched pair" — the plural a sentence needs. */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
