import { prisma } from "@/lib/server/prisma";
import { getRecord } from "@/lib/server/store";
import type { Entity } from "@/lib/domain/types";
import { LedgerError } from "./post";
import { groupList } from "./consolidation";
import { counterpartyStatement } from "./counterparties";
import { profitAndLoss } from "./statements";

/**
 * Intercompany matching and elimination.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * When two members of a consolidation group trade with each other, the group's
 * combined accounts count the trade twice: one member's receivable is the
 * other's payable, and one member's sale is the other's purchase. IFRS 10.B86(c)
 * requires intragroup assets, liabilities, equity, income, expenses and cash
 * flows to be eliminated IN FULL — not in proportion to ownership, because the
 * group controls all of both sides of a transaction it made with itself.
 *
 * ── The hard part, stated before any figure is produced ─────────────────────
 * The ledger does not know that two postings are the same transaction. A
 * journal line records what an entry did to the books; it records no
 * counterparty, and there is no intercompany flag anywhere in the schema. So
 * this module cannot *know* which postings pair up. It can only find evidence
 * and say how much of it there is — which is why every match carries a
 * confidence and the evidence behind it, and why nothing here decides anything
 * on its own.
 *
 * Four kinds of evidence, in the order they are trusted:
 *
 *  1. THE SAME DOCUMENT. Where one document reaches both sets of books — the
 *     group posts one intragroup invoice into the seller's and the buyer's
 *     ledger from one record — both entries carry it as `sourceId`, and the
 *     open-item key `settlesId ?? sourceId` is then literally equal on the two
 *     sides. Nothing is guessed: the books themselves say it is one document.
 *     This is `certain`, and it is the only tier that is not an inference.
 *
 *  2. COUNTERPARTY ATTRIBUTION. The sales ledger knows whose invoice it is,
 *     because counterparties.ts reads the document store for it. That path is
 *     called here rather than reimplemented — `counterpartyStatement` returns
 *     the documents it attributes to a party, and a party whose code, TRN or
 *     legal name is a member entity's *is* that member. A second attribution
 *     path would drift from the customer statement the day either changed, and
 *     then neither could be believed.
 *
 *     Note what this does NOT cover: the payables side. counterparties.ts owns
 *     one attribution path and it reads the receivables control account, so a
 *     bill in the buyer's books carries no attributed counterparty here. That
 *     is a stated limitation, not an oversight — the buyer's side is matched by
 *     document, amount and date, and the seller's attribution is what tells us
 *     the pair is intragroup at all.
 *
 *  3. AMOUNT. Two equal amounts across two members. On its own this is weak:
 *     businesses invoice round numbers, and a group of any size has equal
 *     amounts flying about that have nothing to do with each other.
 *
 *  4. DATE PROXIMITY. An invoice and the bill it becomes are normally recorded
 *     within days of each other. Beyond a month apart, two equal amounts are a
 *     coincidence, and the match is not offered at all.
 *
 * ── An unmatched balance is a finding, never a silent nil ───────────────────
 * A receivable in A with no payable in B is either a posting B has not made or
 * a genuine third-party balance, and the two have opposite consequences for the
 * group. Both are reported, by entity and by side, with what each would mean.
 * Dropping them would leave a match report that looks complete and is not — the
 * failure mode where a group signs off accounts carrying a double count nobody
 * was told about.
 *
 * ── THE ELIMINATION IS NOT POSTED. THIS IS THE DESIGN DECISION. ─────────────
 * `eliminationSchedule` returns a journal. It does not post it, and there is no
 * option to. An elimination belongs to the GROUP, not to a legal entity: it
 * exists only in the consolidation working papers, and it is reversed and
 * rebuilt at every reporting date. Posting it into one member's ledger would
 * falsify that member's own statutory accounts — the receivable really is owed
 * to A, and A's audited balance sheet, its VAT return, its corporate tax
 * computation and the statement it sends the customer must all continue to say
 * so. A group adjustment written into a statutory ledger is a misstatement of
 * that entity's accounts made in the service of a different set of accounts,
 * and it is not recoverable later: nobody can tell afterwards which balances
 * were the entity's and which the group's.
 *
 * That is also why consolidation.ts is a pure report and why nothing in this
 * file writes to the ledger. The schedule is a proposal for a working paper.
 * A human reads it, decides it is right, and the consolidation applies it as a
 * column of its own beside the members' figures.
 *
 * ── Where the software is guessing, and says so ─────────────────────────────
 *  - Which postings pair up (above). Confidence and evidence on every match.
 *  - Which member a dividend went to. Nothing in the ledger links a
 *    shareholding to an entity — consolidation.ts says the same — so a
 *    distribution by one member and dividend income in another are matched on
 *    amount and date, never on a register of shares, and are never `certain`.
 *  - Which stock came from where. `unrealisedProfit` takes the quantities as an
 *    input for exactly that reason, and refuses to invent them.
 *
 * Money is BigInt minor units throughout and every share is basis points held
 * in BigInt. No float touches any of it.
 */

/* --------------------------------------------------------------- vocabulary */

/** The two control accounts a group's members owe each other across. Mirrors consolidation.ts. */
const AR_CODE = "1100";
const AP_CODE = "2000";
/** Where a purchase lands when it is capitalised rather than expensed — see the note in tradeResult. */
const INVENTORY_CODE = "1200";
/** Retained earnings and the shareholder current account: where a distribution is debited. */
const RETAINED_EARNINGS = "3900";
const SHAREHOLDER_CURRENT = "3100";
/** Dividends received land in other income; the chart has no account of their own. */
const DIVIDEND_INCOME = "4900";
/** The debit side of an unrealised-profit elimination. */
const COST_OF_GOODS_SOLD = "5000";

/**
 * An invoice and the bill it becomes are recorded within days of each other in
 * any group that is functioning. Past this, agreement on the amount alone is
 * not enough to call a match likely.
 */
const NEAR_DAYS = 3;

/**
 * Beyond a month apart, two equal amounts across two members are a coincidence.
 * Offering the pair anyway would fill the report with noise, and a report full
 * of noise is one people stop reading — which costs more than the matches it
 * would have found.
 */
const WINDOW_DAYS = 31;

const WHOLLY_OWNED_BPS = 10_000n;
const DAY = 86_400_000;

export const CONFIDENCE = ["certain", "high", "probable", "possible"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/** Best first, so a report can be sorted without restating the ladder. */
const RANK: Record<Confidence, number> = { certain: 0, high: 1, probable: 2, possible: 3 };

export type Side = "receivable" | "payable";

export type EvidenceKind = "document" | "counterparty" | "amount" | "date";

/** One fact behind a match, in words a reviewer can check against the books. */
export interface MatchEvidence {
  kind: EvidenceKind;
  detail: string;
}

/** One side of a candidate pair: a document on a member's control account. */
export interface PostingRef {
  entityId: string;
  side: Side;
  /** `settlesId ?? sourceId ?? entryId` — the same open-item key ar.ts and ap.ts age by. */
  documentKey: string;
  /** The journal reference of the entry that raised it, e.g. SI-1. */
  reference: string;
  /** The date it was raised, never the date it was settled. */
  date: string;
  memo: string;
  accountCode: string;
  /** What was raised on the control account, as a positive magnitude. */
  grossMinor: string;
  /** What is still open on it at the report date, as a positive magnitude. */
  outstandingMinor: string;
  /** Revenue (receivable side) or cost (payable side) in the same entry. */
  tradeMinor: string;
  /** The account codes that revenue or cost sits on. */
  tradeCodes: string[];
  /** Purchases the buyer capitalised into stock rather than expensing. */
  capitalisedMinor: string;
  /** The party the sales ledger attributes the document to. Null on payables — see the file note. */
  counterpartyCode: string | null;
  counterpartyName: string | null;
  /** The member entity that party stands for, where it stands for one. */
  counterpartyEntityId: string | null;
  /** How the counterparty was tied to a member: by code, TRN or legal name. */
  attributionBasis: string | null;
}

export interface IntercompanyMatch {
  receivable: PostingRef;
  payable: PostingRef;
  confidence: Confidence;
  /** Whole days between the two documents. Zero is the same day. */
  dateGapDays: number;
  /** Receivable gross less payable gross. Non-zero only on a shared-document match. */
  amountDifferenceMinor: string;
  evidence: MatchEvidence[];
  /** Why this pair was offered, in one sentence. */
  basis: string;
}

export interface UnmatchedPosting extends PostingRef {
  /** What this balance might be, and what each possibility would mean. */
  finding: string;
  /** True where the sales ledger says the other side is a member. Then only a missing posting explains it. */
  attributedToMember: boolean;
}

export interface MatchTotals {
  matchedCount: number;
  /** Matched intragroup gross, counted once — not once per side. */
  matchedMinor: string;
  unmatchedReceivableMinor: string;
  unmatchedPayableMinor: string;
  /** Of the unmatched receivables, the part the sales ledger says a member owes. */
  unmatchedAttributedMinor: string;
  /**
   * What the group's combined receivables and payables carry that no pair
   * explains: unmatched receivables less unmatched payables.
   */
  carriedDifferenceMinor: string;
}

export interface MemberRef {
  entityId: string;
  ownershipBps: number;
  isParent: boolean;
  /** The member's legal name from its entity record, where it has one. */
  legalName: string | null;
  trn: string | null;
}

export interface MatchResult {
  groupCode: string;
  groupName: string;
  currency: string;
  from: string;
  to: string;
  members: MemberRef[];
  /** Best evidence first, then closest in date — the same order on every run. */
  matches: IntercompanyMatch[];
  unmatched: UnmatchedPosting[];
  totals: MatchTotals;
  warnings: string[];
}

/* --------------------------------------------------------------- the report */

export interface EntitySideSummary {
  entityId: string;
  side: Side;
  matchedCount: number;
  matchedMinor: string;
  unmatchedCount: number;
  unmatchedMinor: string;
  /** Everything raised on that side in the period, matched or not. */
  totalMinor: string;
}

export interface ConfidenceSummary {
  confidence: Confidence;
  count: number;
  amountMinor: string;
  /** What this tier means, so the count is read correctly. */
  meaning: string;
}

export interface MatchReport extends MatchResult {
  byEntity: EntitySideSummary[];
  byConfidence: ConfidenceSummary[];
  /** The members' own control-account balances at the report date, for scale. */
  control: { entityId: string; receivableMinor: string; payableMinor: string }[];
  /** The sentence the group accountant reads first. */
  summary: string;
}

/* ---------------------------------------------------------- the elimination */

/** One line of a group working paper. It adjusts a member's figures; it is never posted there. */
export interface EliminationLine {
  /** Whose figures the line adjusts. Null where the line is the group's own. */
  entityId: string | null;
  accountCode: string;
  accountName: string;
  debitMinor: string;
  creditMinor: string;
  memo: string;
}

export type EliminationKind = "trade_balance" | "trade_result" | "dividend" | "unrealised_profit";

export interface EliminationEntry {
  /** Stable across runs, so an entry can be linked to and tested for. */
  key: string;
  kind: EliminationKind;
  /** The paragraph the rule comes from. */
  authority: string;
  narrative: string;
  confidence: Confidence;
  lines: EliminationLine[];
  totalMinor: string;
}

export interface EliminationSchedule {
  groupCode: string;
  groupName: string;
  currency: string;
  from: string;
  asOf: string;
  members: MemberRef[];
  entries: EliminationEntry[];
  totalDebitMinor: string;
  totalCreditMinor: string;
  /** Debits equal credits. A schedule that does not balance is not a journal. */
  balanced: boolean;
  /**
   * Always false. Present as a field rather than only as prose because a caller
   * that wants to check it should be able to, and because the day somebody adds
   * a posting path this constant is the test that breaks.
   */
  posted: false;
  /** Why it is not posted, in the words the screen shows. */
  postingNote: string;
  warnings: string[];
}

/* ------------------------------------------------------- unrealised profit */

/** Stock bought within the group and still held at the reporting date. Supplied, not derived. */
export interface StockOnHand {
  /** The member that sold the goods — the one whose margin is sitting in them. */
  sellerEntityId: string;
  /** The member still holding them at the reporting date. */
  holderEntityId: string;
  /** What the stock is, as the count sheet names it. */
  item?: string;
  /** Units still held. Whole units — a stock count produces integers. */
  quantity: number | string | bigint;
  /** What the holder was charged per unit: the intragroup transfer price, in minor units. */
  unitTransferPriceMinor: number | string | bigint;
  /**
   * What the unit cost the seller, in minor units. Omit it and the seller's own
   * gross margin for the period stands in — which is an average, and says so.
   */
  unitCostMinor?: number | string | bigint | null;
}

export interface UnrealisedStockRow {
  sellerEntityId: string;
  holderEntityId: string;
  item: string;
  quantity: string;
  unitTransferPriceMinor: string;
  unitCostMinor: string;
  /** Quantity times transfer price: what the holder's books carry it at. */
  carryingAmountMinor: string;
  /** Quantity times cost: what it cost the group to have it. */
  costToGroupMinor: string;
  /** The difference — profit the group has recorded on a sale to itself. */
  unrealisedProfitMinor: string;
  /** Margin on the transfer price, in basis points. */
  marginBps: string | null;
  /** Whether the cost was given or derived. */
  basis: "stated_cost" | "seller_gross_margin";
  basisNote: string;
}

export interface UnrealisedProfitResult {
  groupCode: string;
  groupName: string;
  currency: string;
  from: string;
  asOf: string;
  rows: UnrealisedStockRow[];
  totalCarryingMinor: string;
  totalCostMinor: string;
  /** The elimination: the margin, never the cost. */
  totalUnrealisedProfitMinor: string;
  elimination: EliminationEntry | null;
  /** Said plainly, on the screen and here: the ledger cannot know this. */
  inputNote: string;
  warnings: string[];
}

/* ------------------------------------------------------------------ numbers */

const abs = (v: bigint) => (v < 0n ? -v : v);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);
const fold = (s: string) => s.trim().toLowerCase();

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(raw: string, what: string): Date {
  const text = (raw ?? "").trim();
  if (!DATE_ONLY.test(text)) {
    throw new LedgerError(`The ${what} must be a date in the form YYYY-MM-DD — "${raw}" is not.`);
  }
  const d = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new LedgerError(`The ${what} is not a valid date.`);
  return d;
}

/**
 * Basis points, truncated toward zero so a margin is never overstated. A zero
 * denominator has no answer and gets null — "no margin" and "nothing to take a
 * margin of" are different facts.
 */
const bps = (numerator: bigint, denominator: bigint): bigint | null =>
  denominator === 0n ? null : (numerator * WHOLLY_OWNED_BPS) / denominator;

function wholeUnits(raw: number | string | bigint, what: string): bigint {
  if (typeof raw === "bigint") return raw;
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new LedgerError(`${what} must be a whole number of minor units or units — "${raw}" is not.`);
  }
  return BigInt(text);
}

/* ------------------------------------------------------------------- group */

interface ResolvedGroup {
  code: string;
  name: string;
  currency: string;
  members: MemberRef[];
}

/**
 * Find the group, or refuse by name.
 *
 * The refusal lists the groups the organisation does have, for the same reason
 * segments.ts lists its dimensions: "there is no GROUP2" sends somebody to
 * create one, and "there is no GROUP2, but there are these two" tells them they
 * meant MAIN. Everything below is scoped to this group's members and to this
 * organisation — an entity that is not a member of the named group is not part
 * of any figure here, however much it trades with one that is.
 */
async function resolveGroup(orgId: string, rawCode: string): Promise<ResolvedGroup> {
  const code = (rawCode ?? "").trim();
  const group = code
    ? await prisma.consolidationGroup.findFirst({ where: { orgId, code }, include: { members: true } })
    : null;

  if (!group) {
    const available = await groupList({ orgId });
    if (available.length === 0) {
      throw new LedgerError(
        `No consolidation groups have been set up in this organisation, so there is no set of entities to match ` +
          `intercompany balances across. Create a group, add the entities that trade with each other as members, ` +
          `and run this again.`,
      );
    }
    throw new LedgerError(
      `There is no consolidation group with code ${code || `"${rawCode}"`} in this organisation. Intercompany ` +
        `matching runs over the members of one group, and this organisation has ` +
        `${available.map((g) => `${g.code} (${g.name}, ${g.memberCount} member${g.memberCount === 1 ? "" : "s"})`).join(", ")}.`,
    );
  }

  if (group.members.length < 2) {
    throw new LedgerError(
      `${group.code} has ${group.members.length === 0 ? "no members" : `one member, ${group.members[0].entityId}`}. ` +
        `Intercompany matching needs at least two entities in the group — a member cannot trade with itself, and ` +
        `a balance with an entity outside the group is not intragroup and is not eliminated.`,
    );
  }

  // Parent first, then by entity id: the same order consolidation.ts presents
  // its columns in, so the two screens read as one group rather than two.
  const ordered = [...group.members].sort(
    (a, b) => Number(b.isParent) - Number(a.isParent) || a.entityId.localeCompare(b.entityId),
  );

  const members: MemberRef[] = [];
  for (const m of ordered) {
    // The entity record is where a member's legal name and TRN live — the same
    // record the FTA audit file reads its taxable person from. It is the only
    // thing that lets a counterparty in one member's ledger be recognised as
    // another member.
    const entity = await getRecord<Entity>(orgId, "entities", m.entityId);
    members.push({
      entityId: m.entityId,
      ownershipBps: m.ownershipBps,
      isParent: m.isParent,
      legalName: entity?.legalNameEn?.trim() || null,
      trn: entity?.trn?.trim() || null,
    });
  }

  return { code: group.code, name: group.name, currency: group.currency, members };
}

/* ------------------------------------------------------ reading the ledger */

interface RawDoc {
  entityId: string;
  side: Side;
  key: string;
  reference: string;
  memo: string;
  date: Date;
  grossMinor: bigint;
  outstandingMinor: bigint;
  openingEntryId: string;
  tradeMinor: bigint;
  tradeCodes: string[];
  capitalisedMinor: bigint;
  counterpartyCode: string | null;
  counterpartyName: string | null;
  counterpartyEntityId: string | null;
  attributionBasis: string | null;
}

/**
 * Every document on one member's receivables or payables control account, netted
 * into open items exactly as ar.ts and ap.ts net them.
 *
 * The key is deliberately the same expression those two use — line-level
 * settlement first, then the entry's, then the source — rather than a second one
 * that happens to agree today. A match report keyed differently would drift from
 * the ageing the first time either changed, and the whole point of this screen
 * is that both members' bookkeepers can find the document it names.
 *
 * Documents are read to `to` rather than from `from`, so that what is still
 * outstanding is the real figure, and then filtered on when they were raised.
 * Reading only the window would show an invoice as fully open because the
 * receipt that settled it fell a day outside it.
 */
async function readSide(opts: {
  orgId: string;
  entityId: string;
  side: Side;
  from: Date;
  to: Date;
  warnings: string[];
}): Promise<RawDoc[]> {
  const code = opts.side === "receivable" ? AR_CODE : AP_CODE;
  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code },
  });
  if (!account) {
    opts.warnings.push(
      `${opts.entityId} has no ${code} control account, so none of its ${opts.side}s could be read. Its side of ` +
        `any intragroup trade is missing from this report entirely — open its chart of accounts before relying ` +
        `on the figures.`,
    );
    return [];
  }

  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      accountId: account.id,
      entry: { orgId: opts.orgId, status: { in: ["posted", "reversed"] }, entryDate: { lte: opts.to } },
    },
    include: {
      entry: {
        select: {
          id: true, entryDate: true, series: true, number: true,
          memo: true, source: true, sourceId: true, settlesId: true,
        },
      },
    },
  });

  // A total order, so two documents raised on one day always come out in the
  // same sequence and the greedy pairing below is reproducible.
  const seq = (n: string) => {
    const v = Number(n);
    return Number.isFinite(v) ? v : 0;
  };
  const sorted = [...lines].sort(
    (a, b) =>
      a.entry.entryDate.getTime() - b.entry.entryDate.getTime() ||
      a.entry.series.localeCompare(b.entry.series) ||
      seq(a.entry.number) - seq(b.entry.number) ||
      a.lineNo - b.lineNo,
  );

  /** Which side of the account raises the balance: receivables are debits, payables credits. */
  const raisingSign = opts.side === "receivable" ? 1n : -1n;
  const opensItem = opts.side === "receivable" ? "invoice" : "bill";

  interface Acc {
    key: string;
    date: Date;
    reference: string;
    memo: string;
    gross: bigint;
    net: bigint;
    openingEntryId: string;
    opened: boolean;
  }
  const docs = new Map<string, Acc>();

  for (const l of sorted) {
    const key = l.settlesId ?? l.entry.settlesId ?? l.entry.sourceId ?? l.id;
    const reference = `${l.entry.series}-${l.entry.number}`;
    const raising = l.functionalAmountMinor * raisingSign > 0n;
    const prev = docs.get(key);
    if (prev) {
      prev.net += l.functionalAmountMinor;
      if (raising) prev.gross += abs(l.functionalAmountMinor);
      // The document's identity and date come from the entry that opened it,
      // never from the receipt or payment that closed part of it.
      if (l.entry.source === opensItem && !prev.opened) {
        prev.date = l.entry.entryDate;
        prev.reference = reference;
        prev.memo = l.entry.memo ?? prev.memo;
        prev.openingEntryId = l.entry.id;
        prev.opened = true;
      }
    } else {
      docs.set(key, {
        key,
        date: l.entry.entryDate,
        reference,
        memo: l.entry.memo ?? "",
        gross: raising ? abs(l.functionalAmountMinor) : 0n,
        net: l.functionalAmountMinor,
        openingEntryId: l.entry.id,
        opened: l.entry.source === opensItem,
      });
    }
  }

  const inWindow = [...docs.values()].filter(
    (d) => d.gross > 0n && d.date.getTime() >= opts.from.getTime() && d.date.getTime() <= opts.to.getTime(),
  );
  if (inWindow.length === 0) return [];

  // The other half of each opening entry: what the sale was, or what the
  // purchase was. Taken from the same entry rather than from a second read of
  // the profit and loss, so the elimination of the balance and the elimination
  // of the result can never describe different transactions.
  const contra = await prisma.journalLine.findMany({
    where: { orgId: opts.orgId, entryId: { in: inWindow.map((d) => d.openingEntryId) } },
    include: { account: { select: { code: true, type: true, subtype: true } } },
  });
  const tradeByEntry = new Map<string, { amount: bigint; codes: Set<string>; capitalised: bigint }>();
  for (const l of contra) {
    let row = tradeByEntry.get(l.entryId);
    if (!row) {
      row = { amount: 0n, codes: new Set<string>(), capitalised: 0n };
      tradeByEntry.set(l.entryId, row);
    }
    const isTrade =
      opts.side === "receivable" ? l.account.type === "INCOME" : l.account.type === "EXPENSE";
    if (isTrade) {
      row.amount += abs(l.functionalAmountMinor);
      row.codes.add(l.account.code);
    }
    // A purchase debited to stock is not yet a cost, so it cannot be eliminated
    // against the seller's revenue. It is the unrealised-profit case, which
    // `unrealisedProfit` owns; recording it here is what lets that be said.
    if (opts.side === "payable" && (l.account.code === INVENTORY_CODE || l.account.subtype === "INVENTORY")) {
      row.capitalised += abs(l.functionalAmountMinor);
    }
  }

  return inWindow.map((d) => {
    const trade = tradeByEntry.get(d.openingEntryId);
    return {
      entityId: opts.entityId,
      side: opts.side,
      key: d.key,
      reference: d.reference,
      memo: d.memo,
      date: d.date,
      grossMinor: d.gross,
      outstandingMinor: abs(d.net),
      openingEntryId: d.openingEntryId,
      tradeMinor: trade?.amount ?? 0n,
      tradeCodes: trade ? [...trade.codes].sort() : [],
      capitalisedMinor: trade?.capitalised ?? 0n,
      counterpartyCode: null,
      counterpartyName: null,
      counterpartyEntityId: null,
      attributionBasis: null,
    };
  });
}

/* ------------------------------------------------------------- attribution */

/**
 * Does this counterparty stand for another member of the group?
 *
 * The ladder is counterparties.ts's own — an explicit link first, then the TRN
 * (which identifies one taxable person), then the name — applied to entity
 * records instead of to documents. It is the only bridge there is: nothing in
 * the schema joins a Counterparty row to an entity, so a group that wants its
 * intercompany trade recognised has to code the counterparty as the entity, or
 * give it the entity's TRN, or give it the entity's legal name.
 */
function standsFor(
  party: { code: string; name: string; trn: string | null },
  siblings: MemberRef[],
  ambiguousTrns: Set<string>,
): { entityId: string; basis: string } | null {
  const code = fold(party.code);
  const byCode = siblings.find((m) => fold(m.entityId) === code);
  if (byCode) return { entityId: byCode.entityId, basis: `its code is the entity id ${byCode.entityId}` };

  const trn = (party.trn ?? "").trim();
  if (trn && !ambiguousTrns.has(trn)) {
    const byTrn = siblings.find((m) => m.trn === trn);
    if (byTrn) return { entityId: byTrn.entityId, basis: `its TRN ${trn} is ${byTrn.entityId}'s` };
  }

  const name = fold(party.name);
  const byName = siblings.find((m) => m.legalName && fold(m.legalName) === name);
  if (byName) return { entityId: byName.entityId, basis: `its name is ${byName.legalName}'s legal name` };

  return null;
}

/**
 * Attach the sales ledger's own attribution to a member's receivable documents.
 *
 * `counterpartyStatement` is called rather than the document store being read
 * again here. It is the function that owns "whose invoice is this", it proves
 * its own answer against the receivables ageing, and calling it means the party
 * this report names is the party the customer statement names.
 */
async function attributeReceivables(opts: {
  orgId: string;
  member: MemberRef;
  siblings: MemberRef[];
  docs: RawDoc[];
  to: Date;
  warnings: string[];
}): Promise<void> {
  if (opts.docs.length === 0 || opts.siblings.length === 0) return;

  const seen = new Map<string, number>();
  for (const m of opts.siblings) if (m.trn) seen.set(m.trn, (seen.get(m.trn) ?? 0) + 1);
  const ambiguousTrns = new Set([...seen.entries()].filter(([, n]) => n > 1).map(([t]) => t));
  for (const trn of ambiguousTrns) {
    opts.warnings.push(
      `More than one member of the group carries TRN ${trn}. A tax group shares a registration, so the TRN cannot ` +
        `say which member a counterparty is, and it has been ignored for those members. Code the counterparty as ` +
        `the entity id instead.`,
    );
  }

  const parties = await prisma.counterparty.findMany({
    where: { orgId: opts.orgId, entityId: opts.member.entityId },
    orderBy: { code: "asc" },
  });

  const byKey = new Map<string, { code: string; name: string; entityId: string; basis: string }>();
  for (const p of parties) {
    const stands = standsFor(p, opts.siblings, ambiguousTrns);
    if (!stands) continue;
    const statement = await counterpartyStatement({
      orgId: opts.orgId,
      entityId: opts.member.entityId,
      code: p.code,
      to: opts.to,
    });
    for (const line of statement.lines) {
      byKey.set(line.documentId, { code: p.code, name: p.name, entityId: stands.entityId, basis: stands.basis });
    }
    if (!statement.agrees) {
      opts.warnings.push(
        `${opts.member.entityId}'s statement for ${p.name} does not tie to the receivables ageing. ` +
          `${statement.note} Until that is fixed, the attribution below is reading a ledger that disagrees with itself.`,
      );
    }
  }

  for (const doc of opts.docs) {
    const hit = byKey.get(doc.key);
    if (!hit) continue;
    doc.counterpartyCode = hit.code;
    doc.counterpartyName = hit.name;
    doc.counterpartyEntityId = hit.entityId;
    doc.attributionBasis = hit.basis;
  }
}

/* ------------------------------------------------------------- the matching */

interface Candidate {
  r: RawDoc;
  p: RawDoc;
  confidence: Confidence;
  gap: number;
  evidence: MatchEvidence[];
}

/**
 * Weigh one receivable against one payable.
 *
 * Returns null where there is not enough to offer the pair at all. Everything
 * it does return carries the evidence that produced it, because the reviewer's
 * question is never "how confident are you" — it is "why".
 */
function assess(r: RawDoc, p: RawDoc): { confidence: Confidence; gap: number; evidence: MatchEvidence[] } | null {
  const gap = Math.abs(daysBetween(r.date, p.date));
  const sameDocument = r.key === p.key;
  const attributed = r.counterpartyEntityId === p.entityId;
  const sameAmount = r.grossMinor === p.grossMinor;

  // The sales ledger says who owes this. If it says somebody other than the
  // member holding this payable, that is not evidence against the pair — it is
  // evidence the pair is wrong, and it ends the question.
  if (!sameDocument && r.counterpartyEntityId && r.counterpartyEntityId !== p.entityId) return null;

  const evidence: MatchEvidence[] = [];
  if (sameDocument) {
    evidence.push({
      kind: "document",
      detail: `Both entries name document ${r.key}, so one document reached both sets of books.`,
    });
  }
  if (attributed) {
    evidence.push({
      kind: "counterparty",
      detail:
        `${r.entityId}'s sales ledger attributes ${r.reference} to ${r.counterpartyName ?? r.counterpartyCode}, ` +
        `and ${r.attributionBasis}.`,
    });
  }
  evidence.push({
    kind: "amount",
    detail: sameAmount
      ? `Both sides were raised at ${r.grossMinor} minor units.`
      : `${r.entityId} raised ${r.grossMinor} and ${p.entityId} raised ${p.grossMinor} — a difference of ` +
        `${abs(r.grossMinor - p.grossMinor)}.`,
  });
  evidence.push({
    kind: "date",
    detail:
      gap === 0
        ? `Both raised on ${iso(r.date)}.`
        : `${iso(r.date)} and ${iso(p.date)} — ${gap} day${gap === 1 ? "" : "s"} apart.`,
  });

  // Tier 1: nothing is inferred. The books themselves say it is one document,
  // so the pair stands even where the amounts differ — and the difference is
  // then the finding, not a reason to look away.
  if (sameDocument) return { confidence: "certain", gap, evidence };

  if (!sameAmount) return null;
  if (gap > WINDOW_DAYS) return null;

  if (attributed) return { confidence: gap <= NEAR_DAYS ? "high" : "probable", gap, evidence };
  return { confidence: gap <= NEAR_DAYS ? "probable" : "possible", gap, evidence };
}

const BASIS: Record<Confidence, string> = {
  certain:
    "One document in both members' books. This is not an inference — the entries name the same document, and the " +
    "only thing left to check is that the two sides were raised for the same amount.",
  high:
    "The seller's sales ledger names the buying member as the customer, the amounts agree and the two documents " +
    "were raised within days of each other. Short of one shared document, this is as strong as the evidence gets.",
  probable:
    "The amounts agree and the timing fits, but the ledger does not name a counterparty on both sides. Confirm " +
    "the pair against the documents before eliminating it.",
  possible:
    "Two equal amounts across two members, raised further apart than an invoice and its bill usually are. Offered " +
    "so it is not missed, and it should be checked before it is believed — equal amounts happen by chance.",
};

const MEANING: Record<Confidence, string> = {
  certain: "One document, both sets of books. Nothing guessed.",
  high: "Attributed to the member by the sales ledger, same amount, days apart.",
  probable: "Same amount, close in date, but nothing names the counterparty.",
  possible: "Same amount only, and further apart than usual. Check it.",
};

/* ------------------------------------------------------------- findMatches */

export async function findMatches(opts: {
  orgId: string;
  groupCode: string;
  from: string;
  to: string;
}): Promise<MatchResult> {
  const group = await resolveGroup(opts.orgId, opts.groupCode);
  const from = parseDate(opts.from, "start of the period");
  const to = parseDate(opts.to, "end of the period");
  if (to.getTime() < from.getTime()) {
    throw new LedgerError(`The period ends before it starts: ${iso(from)} to ${iso(to)}.`);
  }

  const warnings: string[] = [];

  const receivables: RawDoc[] = [];
  const payables: RawDoc[] = [];
  for (const member of group.members) {
    const ar = await readSide({ orgId: opts.orgId, entityId: member.entityId, side: "receivable", from, to, warnings });
    const ap = await readSide({ orgId: opts.orgId, entityId: member.entityId, side: "payable", from, to, warnings });
    await attributeReceivables({
      orgId: opts.orgId,
      member,
      siblings: group.members.filter((m) => m.entityId !== member.entityId),
      docs: ar,
      to,
      warnings,
    });
    receivables.push(...ar);
    payables.push(...ap);
  }

  /* --- candidates, best evidence first ---------------------------------- */

  const candidates: Candidate[] = [];
  for (const r of receivables) {
    for (const p of payables) {
      if (p.entityId === r.entityId) continue;
      const verdict = assess(r, p);
      if (verdict) candidates.push({ r, p, ...verdict });
    }
  }

  // Deterministic: strongest evidence, then closest in date, then largest, then
  // by the keys themselves. The same books must always produce the same pairs —
  // a reviewer who rejected a match yesterday has to see the same one today.
  candidates.sort(
    (a, b) =>
      RANK[a.confidence] - RANK[b.confidence] ||
      a.gap - b.gap ||
      (b.r.grossMinor > a.r.grossMinor ? 1 : b.r.grossMinor < a.r.grossMinor ? -1 : 0) ||
      a.r.entityId.localeCompare(b.r.entityId) ||
      a.r.key.localeCompare(b.r.key) ||
      a.p.entityId.localeCompare(b.p.entityId) ||
      a.p.key.localeCompare(b.p.key),
  );

  const usedR = new Set<string>();
  const usedP = new Set<string>();
  const id = (d: RawDoc) => `${d.entityId}::${d.key}`;
  const matches: IntercompanyMatch[] = [];

  for (const c of candidates) {
    if (usedR.has(id(c.r)) || usedP.has(id(c.p))) continue;
    usedR.add(id(c.r));
    usedP.add(id(c.p));
    matches.push({
      receivable: toRef(c.r),
      payable: toRef(c.p),
      confidence: c.confidence,
      dateGapDays: c.gap,
      amountDifferenceMinor: (c.r.grossMinor - c.p.grossMinor).toString(),
      evidence: c.evidence,
      basis: BASIS[c.confidence],
    });
    if (c.r.grossMinor !== c.p.grossMinor) {
      warnings.push(
        `${c.r.entityId} raised ${c.r.grossMinor} on ${c.r.reference} and ${c.p.entityId} raised ${c.p.grossMinor} ` +
          `on ${c.p.reference} against the same document. The group carries the difference of ` +
          `${abs(c.r.grossMinor - c.p.grossMinor)} until one of the two is corrected — an elimination can only ` +
          `remove the amount both sides agree on.`,
      );
    }
  }

  /* --- what is left over, and what it means ----------------------------- */

  const unmatched: UnmatchedPosting[] = [];
  for (const r of receivables) {
    if (usedR.has(id(r))) continue;
    const member = r.counterpartyEntityId;
    unmatched.push({
      ...toRef(r),
      attributedToMember: member !== null,
      finding: member
        ? `${r.entityId} carries ${r.grossMinor} on ${AR_CODE} that its sales ledger attributes to ${member}, a ` +
          `member of ${group.code}, and nothing in ${member}'s payables matches it. Either ${member} has not ` +
          `posted the bill, or it posted a different amount. The group's receivables are overstated by this until ` +
          `it is resolved.`
        : `${r.entityId} carries ${r.grossMinor} on ${AR_CODE} that no member's payables match, and no ` +
          `counterparty is attributed to it. It is either a genuine third-party customer — in which case there is ` +
          `nothing to eliminate — or an intragroup invoice the other member has not booked. A journal line ` +
          `records no counterparty, so this one cannot be settled from the ledger alone.`,
    });
  }
  for (const p of payables) {
    if (usedP.has(id(p))) continue;
    unmatched.push({
      ...toRef(p),
      attributedToMember: false,
      finding:
        `${p.entityId} carries ${p.grossMinor} on ${AP_CODE} that no member's receivables match. If the supplier ` +
        `is outside ${group.code} there is nothing to eliminate; if it is another member, that member has not ` +
        `raised the invoice and the group's payables are overstated by this.`,
    });
  }
  unmatched.sort(
    (a, b) =>
      a.entityId.localeCompare(b.entityId) ||
      a.side.localeCompare(b.side) ||
      a.date.localeCompare(b.date) ||
      a.documentKey.localeCompare(b.documentKey),
  );

  const matchedMinor = matches.reduce(
    // The amount both sides agree on. Counting the receivable and the payable
    // separately would double the very figure this module exists to un-double.
    (a, m) => a + minBig(BigInt(m.receivable.grossMinor), BigInt(m.payable.grossMinor)),
    0n,
  );
  const unmatchedR = unmatched
    .filter((u) => u.side === "receivable")
    .reduce((a, u) => a + BigInt(u.grossMinor), 0n);
  const unmatchedP = unmatched
    .filter((u) => u.side === "payable")
    .reduce((a, u) => a + BigInt(u.grossMinor), 0n);
  const unmatchedAttributed = unmatched
    .filter((u) => u.attributedToMember)
    .reduce((a, u) => a + BigInt(u.grossMinor), 0n);

  if (unmatchedAttributed > 0n) {
    warnings.push(
      `${unmatchedAttributed} of ${group.code}'s receivables is owed by a member of the group according to the ` +
        `sales ledger, and no member's payables carry it. That is a missing posting, not a matching problem — ` +
        `the two sides of one trade have to exist before either can be eliminated.`,
    );
  }

  return {
    groupCode: group.code,
    groupName: group.name,
    currency: group.currency,
    from: iso(from),
    to: iso(to),
    members: group.members,
    matches,
    unmatched,
    totals: {
      matchedCount: matches.length,
      matchedMinor: matchedMinor.toString(),
      unmatchedReceivableMinor: unmatchedR.toString(),
      unmatchedPayableMinor: unmatchedP.toString(),
      unmatchedAttributedMinor: unmatchedAttributed.toString(),
      carriedDifferenceMinor: (unmatchedR - unmatchedP).toString(),
    },
    warnings,
  };
}

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);

function toRef(d: RawDoc): PostingRef {
  return {
    entityId: d.entityId,
    side: d.side,
    documentKey: d.key,
    reference: d.reference,
    date: iso(d.date),
    memo: d.memo,
    accountCode: d.side === "receivable" ? AR_CODE : AP_CODE,
    grossMinor: d.grossMinor.toString(),
    outstandingMinor: d.outstandingMinor.toString(),
    tradeMinor: d.tradeMinor.toString(),
    tradeCodes: d.tradeCodes,
    capitalisedMinor: d.capitalisedMinor.toString(),
    counterpartyCode: d.counterpartyCode,
    counterpartyName: d.counterpartyName,
    counterpartyEntityId: d.counterpartyEntityId,
    attributionBasis: d.attributionBasis,
  };
}

/* ------------------------------------------------------------- matchReport */

export async function matchReport(opts: {
  orgId: string;
  groupCode: string;
  from: string;
  to: string;
}): Promise<MatchReport> {
  const result = await findMatches(opts);

  /* --- by entity and by side -------------------------------------------- */

  const key = (entityId: string, side: Side) => `${entityId}::${side}`;
  const rows = new Map<string, EntitySideSummary>();
  for (const m of result.members) {
    for (const side of ["receivable", "payable"] as Side[]) {
      rows.set(key(m.entityId, side), {
        entityId: m.entityId,
        side,
        matchedCount: 0,
        matchedMinor: "0",
        unmatchedCount: 0,
        unmatchedMinor: "0",
        totalMinor: "0",
      });
    }
  }
  const bump = (ref: PostingRef, matched: boolean) => {
    const row = rows.get(key(ref.entityId, ref.side));
    if (!row) return;
    const amount = BigInt(ref.grossMinor);
    if (matched) {
      row.matchedCount += 1;
      row.matchedMinor = (BigInt(row.matchedMinor) + amount).toString();
    } else {
      row.unmatchedCount += 1;
      row.unmatchedMinor = (BigInt(row.unmatchedMinor) + amount).toString();
    }
    row.totalMinor = (BigInt(row.totalMinor) + amount).toString();
  };
  for (const m of result.matches) {
    bump(m.receivable, true);
    bump(m.payable, true);
  }
  for (const u of result.unmatched) bump(u, false);

  /* --- by confidence ----------------------------------------------------- */

  const byConfidence: ConfidenceSummary[] = CONFIDENCE.map((c) => {
    const of = result.matches.filter((m) => m.confidence === c);
    return {
      confidence: c,
      count: of.length,
      amountMinor: of
        .reduce((a, m) => a + minBig(BigInt(m.receivable.grossMinor), BigInt(m.payable.grossMinor)), 0n)
        .toString(),
      meaning: MEANING[c],
    };
  });

  /* --- the control accounts, for scale ---------------------------------- */

  const asOf = parseDate(result.to, "end of the period");
  const control: MatchReport["control"] = [];
  for (const m of result.members) {
    const [ar, ap] = await Promise.all([
      controlBalance(opts.orgId, m.entityId, AR_CODE, asOf),
      controlBalance(opts.orgId, m.entityId, AP_CODE, asOf),
    ]);
    control.push({ entityId: m.entityId, receivableMinor: ar.toString(), payableMinor: ap.toString() });
  }

  const weak = result.matches.filter((m) => m.confidence === "probable" || m.confidence === "possible").length;
  const summary =
    result.matches.length === 0
      ? `No intragroup pair was found between ${result.from} and ${result.to}. That is not the same as there ` +
        `being none: ${result.unmatched.length} balance${result.unmatched.length === 1 ? "" : "s"} could not be ` +
        `paired, and any of them may be intragroup.`
      : `${result.matches.length} pair${result.matches.length === 1 ? "" : "s"} totalling ` +
        `${result.totals.matchedMinor} minor units, of which ${weak} rest${weak === 1 ? "s" : ""} on amount and ` +
        `date alone. ${result.totals.unmatchedReceivableMinor} of receivables and ` +
        `${result.totals.unmatchedPayableMinor} of payables could not be paired at all.`;

  return { ...result, byEntity: [...rows.values()], byConfidence, control, summary };
}

/** A member's own balance on one control account, presented positive. */
async function controlBalance(orgId: string, entityId: string, code: string, asOf: Date): Promise<bigint> {
  const account = await prisma.account.findFirst({ where: { orgId, entityId, code } });
  if (!account) return 0n;
  const agg = await prisma.journalLine.aggregate({
    where: {
      orgId,
      accountId: account.id,
      entry: { orgId, status: { in: ["posted", "reversed"] }, entryDate: { lte: asOf } },
    },
    _sum: { functionalAmountMinor: true },
  });
  return abs(agg._sum.functionalAmountMinor ?? 0n);
}

/* ------------------------------------------------------ eliminationSchedule */

/**
 * The journal the consolidation needs, as a working paper.
 *
 * NOT POSTED, AND THERE IS NO OPTION TO POST IT. See the note at the top of
 * this file: an elimination belongs to the group, and writing it into a
 * member's ledger would falsify that member's own statutory accounts.
 */
export async function eliminationSchedule(opts: {
  orgId: string;
  groupCode: string;
  asOf: string;
  /**
   * Where the period starts, for the income and expense half. Defaults to the
   * start of the fiscal year `asOf` falls in — a balance is at a date but a
   * revenue is over a period, and the two halves must describe the same one.
   */
  from?: string;
  /** Stock still held at `asOf` that was bought within the group. See `unrealisedProfit`. */
  stock?: StockOnHand[];
}): Promise<EliminationSchedule> {
  const group = await resolveGroup(opts.orgId, opts.groupCode);
  const asOf = parseDate(opts.asOf, "reporting date");
  const from = opts.from
    ? parseDate(opts.from, "start of the period")
    : await fiscalYearStart(opts.orgId, group.members, asOf);
  if (asOf.getTime() < from.getTime()) {
    throw new LedgerError(`The period ends before it starts: ${iso(from)} to ${iso(asOf)}.`);
  }

  const matched = await findMatches({
    orgId: opts.orgId,
    groupCode: group.code,
    from: iso(from),
    to: iso(asOf),
  });
  const warnings = [...matched.warnings];
  const chart = await accountNames(opts.orgId, group.members);
  const entries: EliminationEntry[] = [];

  /* --- receivables against payables ------------------------------------- */

  for (const m of matched.matches) {
    // Only what is still open at the reporting date. An invoice raised and paid
    // within the year leaves no balance to eliminate — its cash moved between
    // two members' bank accounts and nothing is double counted on the sheet.
    const open = minBig(BigInt(m.receivable.outstandingMinor), BigInt(m.payable.outstandingMinor));
    if (open <= 0n) continue;
    if (m.receivable.outstandingMinor !== m.payable.outstandingMinor) {
      warnings.push(
        `${m.receivable.entityId} still shows ${m.receivable.outstandingMinor} open on ${m.receivable.reference} ` +
          `while ${m.payable.entityId} shows ${m.payable.outstandingMinor} on ${m.payable.reference}. Only the ` +
          `${open} both agree on is eliminated — the rest is a difference between the two members, and the group ` +
          `carries it until they agree.`,
      );
    }
    entries.push({
      key: `trade_balance:${m.receivable.entityId}:${m.receivable.documentKey}`,
      kind: "trade_balance",
      authority: "IFRS 10.B86(c) — intragroup assets and liabilities are eliminated in full.",
      narrative:
        `${m.receivable.entityId} shows ${open} owed to it by ${m.payable.entityId}, and ${m.payable.entityId} ` +
        `shows the same amount owed. The group owes itself nothing, so both sides come off in full.`,
      confidence: m.confidence,
      lines: [
        {
          entityId: m.payable.entityId,
          accountCode: AP_CODE,
          accountName: chart.get(`${m.payable.entityId}::${AP_CODE}`) ?? "Trade payables",
          debitMinor: open.toString(),
          creditMinor: "0",
          memo: `Owed to ${m.receivable.entityId} — ${m.payable.reference}`,
        },
        {
          entityId: m.receivable.entityId,
          accountCode: AR_CODE,
          accountName: chart.get(`${m.receivable.entityId}::${AR_CODE}`) ?? "Trade receivables",
          debitMinor: "0",
          creditMinor: open.toString(),
          memo: `Owed by ${m.payable.entityId} — ${m.receivable.reference}`,
        },
      ],
      totalMinor: open.toString(),
    });
  }

  /* --- revenue against cost of sales ------------------------------------ */

  for (const m of matched.matches) {
    const revenue = BigInt(m.receivable.tradeMinor);
    const cost = BigInt(m.payable.tradeMinor);
    const capitalised = BigInt(m.payable.capitalisedMinor);

    if (capitalised > 0n) {
      // The buyer put the purchase on the balance sheet, so there is no expense
      // to eliminate the seller's revenue against, and the seller's margin is
      // still sitting in group stock. That is the unrealised-profit case, and
      // this module cannot see how much of it is still on hand.
      warnings.push(
        `${m.payable.entityId} capitalised ${capitalised} of ${m.receivable.entityId}'s invoice ` +
          `${m.receivable.reference} into stock rather than expensing it. The revenue cannot be eliminated ` +
          `against a cost that has not been incurred yet — pass the quantities still on hand to unrealisedProfit ` +
          `and eliminate the margin instead.`,
      );
    }
    const amount = minBig(revenue, cost);
    if (amount <= 0n) continue;
    if (revenue !== cost) {
      warnings.push(
        `${m.receivable.entityId} recorded ${revenue} of revenue on ${m.receivable.reference} and ` +
          `${m.payable.entityId} recorded ${cost} of cost on ${m.payable.reference}. Only ${amount} is eliminated; ` +
          `the difference is usually tax or freight coded one side and not the other, and it is worth finding.`,
      );
    }

    const revenueCode = m.receivable.tradeCodes[0] ?? "4000";
    const costCode = m.payable.tradeCodes[0] ?? COST_OF_GOODS_SOLD;
    entries.push({
      key: `trade_result:${m.receivable.entityId}:${m.receivable.documentKey}`,
      kind: "trade_result",
      authority: "IFRS 10.B86(c) — intragroup income and expenses are eliminated in full.",
      narrative:
        `${m.receivable.entityId} sold ${amount} to ${m.payable.entityId}, which is not a sale by the group. ` +
        `Revenue and the matching cost both come off; group profit is unchanged, because the two were equal and ` +
        `opposite in it to begin with.`,
      confidence: m.confidence,
      lines: [
        {
          entityId: m.receivable.entityId,
          accountCode: revenueCode,
          accountName: chart.get(`${m.receivable.entityId}::${revenueCode}`) ?? "Revenue",
          debitMinor: amount.toString(),
          creditMinor: "0",
          memo: `Sale to ${m.payable.entityId} — ${m.receivable.reference}`,
        },
        {
          entityId: m.payable.entityId,
          accountCode: costCode,
          accountName: chart.get(`${m.payable.entityId}::${costCode}`) ?? "Cost of sales",
          debitMinor: "0",
          creditMinor: amount.toString(),
          memo: `Purchase from ${m.receivable.entityId} — ${m.payable.reference}`,
        },
      ],
      totalMinor: amount.toString(),
    });
  }

  /* --- dividends inside the group --------------------------------------- */

  entries.push(...(await dividendEliminations({ orgId: opts.orgId, group, from, to: asOf, names: chart, warnings })));

  /* --- profit still sitting in stock ------------------------------------ */

  if (opts.stock && opts.stock.length > 0) {
    const unrealised = await unrealisedProfit({
      orgId: opts.orgId,
      groupCode: group.code,
      asOf: opts.asOf,
      from: iso(from),
      stock: opts.stock,
    });
    warnings.push(...unrealised.warnings);
    if (unrealised.elimination) entries.push(unrealised.elimination);
  }

  const totalDebit = entries.reduce(
    (a, e) => a + e.lines.reduce((b, l) => b + BigInt(l.debitMinor), 0n),
    0n,
  );
  const totalCredit = entries.reduce(
    (a, e) => a + e.lines.reduce((b, l) => b + BigInt(l.creditMinor), 0n),
    0n,
  );

  return {
    groupCode: group.code,
    groupName: group.name,
    currency: group.currency,
    from: iso(from),
    asOf: iso(asOf),
    members: group.members,
    entries,
    totalDebitMinor: totalDebit.toString(),
    totalCreditMinor: totalCredit.toString(),
    balanced: totalDebit === totalCredit,
    posted: false,
    postingNote:
      `This schedule has not been posted to any entity's ledger, and it cannot be. An elimination belongs to the ` +
      `group, not to a legal entity: it exists in the consolidation working papers and is rebuilt at every ` +
      `reporting date. ${group.members.map((m) => m.entityId).join(" and ")} each keep their own statutory ` +
      `accounts, and the receivable really is owed to the member that shows it — its audited balance sheet, its ` +
      `VAT return, its tax computation and the statement it sends the customer all have to go on saying so. ` +
      `Take these figures into the consolidation as a column of their own.`,
    warnings,
  };
}

/**
 * A dividend paid by one member to another.
 *
 * Nothing in the ledger links a shareholding to an entity — consolidation.ts
 * makes the same point about the parent's investment — so this can never be
 * `certain`. What it can do is notice that one member debited retained earnings
 * or the shareholder current account in an entry that moved cash, and that
 * another member credited other income in an entry that moved cash, for the
 * same amount at about the same time.
 *
 * Only the part the group actually received is eliminated. A 75%-owned
 * subsidiary paying 100 pays 75 to its parent and 25 to shareholders outside
 * the group; the 25 left the group and stays where it is (IFRS 10.B94 shows the
 * same split for profit).
 */
async function dividendEliminations(opts: {
  orgId: string;
  group: ResolvedGroup;
  from: Date;
  to: Date;
  names: Map<string, string>;
  warnings: string[];
}): Promise<EliminationEntry[]> {
  interface Movement {
    entityId: string;
    entryId: string;
    reference: string;
    date: Date;
    amountMinor: bigint;
    accountCode: string;
  }
  const distributions: Movement[] = [];
  const incomes: Movement[] = [];

  for (const member of opts.group.members) {
    const lines = await prisma.journalLine.findMany({
      where: {
        orgId: opts.orgId,
        account: {
          entityId: member.entityId,
          code: { in: [RETAINED_EARNINGS, SHAREHOLDER_CURRENT, DIVIDEND_INCOME] },
        },
        entry: {
          orgId: opts.orgId,
          entityId: member.entityId,
          status: { in: ["posted", "reversed"] },
          entryDate: { gte: opts.from, lte: opts.to },
        },
      },
      include: {
        account: { select: { code: true } },
        entry: {
          select: {
            id: true, entryDate: true, series: true, number: true,
            lines: { select: { functionalAmountMinor: true, account: { select: { subtype: true } } } },
          },
        },
      },
    });

    for (const l of lines) {
      // "Settled in cash" is what tells a dividend from a reclassification
      // within equity — the same test equity.ts uses to classify a debit to
      // retained earnings as a distribution rather than a prior-period
      // adjustment. Reusing the test keeps the two screens agreeing about what
      // a distribution is.
      const touchesCash = l.entry.lines.some((x) => x.account.subtype === "BANK" || x.account.subtype === "CASH");
      if (!touchesCash) continue;
      const movement: Movement = {
        entityId: member.entityId,
        entryId: l.entry.id,
        reference: `${l.entry.series}-${l.entry.number}`,
        date: l.entry.entryDate,
        amountMinor: abs(l.functionalAmountMinor),
        accountCode: l.account.code,
      };
      if (l.account.code === DIVIDEND_INCOME && l.functionalAmountMinor < 0n) incomes.push(movement);
      if (l.account.code !== DIVIDEND_INCOME && l.functionalAmountMinor > 0n) distributions.push(movement);
    }
  }

  const out: EliminationEntry[] = [];
  const usedDistribution = new Set<string>();

  const ordered = [...incomes].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || a.entityId.localeCompare(b.entityId),
  );
  for (const income of ordered) {
    const payer = distributions
      .filter((d) => d.entityId !== income.entityId && !usedDistribution.has(d.entryId + d.accountCode))
      // The recipient can only have received part of a distribution: the rest
      // went to shareholders outside the group.
      .filter((d) => d.amountMinor >= income.amountMinor)
      .filter((d) => Math.abs(daysBetween(d.date, income.date)) <= WINDOW_DAYS)
      .sort(
        (a, b) =>
          Math.abs(daysBetween(a.date, income.date)) - Math.abs(daysBetween(b.date, income.date)) ||
          a.entityId.localeCompare(b.entityId),
      )[0];

    if (!payer) {
      opts.warnings.push(
        `${income.entityId} recorded ${income.amountMinor} of income on ${DIVIDEND_INCOME} in ${income.reference} ` +
          `and no member of ${opts.group.code} made a distribution to match it. If it is a dividend from outside ` +
          `the group it stays in group income; if it is from a member, that member has not recorded the payment.`,
      );
      continue;
    }

    usedDistribution.add(payer.entryId + payer.accountCode);
    const gap = Math.abs(daysBetween(payer.date, income.date));
    const share = bps(income.amountMinor, payer.amountMinor);
    out.push({
      key: `dividend:${payer.entityId}:${payer.entryId}:${income.entityId}`,
      kind: "dividend",
      authority: "IFRS 10.B86(c) — intragroup income, including dividends, is eliminated in full.",
      narrative:
        `${payer.entityId} distributed ${payer.amountMinor} and ${income.entityId} recognised ` +
        `${income.amountMinor} of it as income${share !== null && share < WHOLLY_OWNED_BPS ? `, being ${share} basis points of it` : ""}. ` +
        `A dividend inside the group is not group income — it moves cash between two members and nothing else. ` +
        `Only the ${income.amountMinor} the group received is eliminated; anything paid to shareholders outside ` +
        `the group has genuinely left it. Nothing in the ledger records who holds the shares, so this pairing is ` +
        `made on amount and date and should be confirmed against the resolution.`,
      confidence: gap <= NEAR_DAYS ? "probable" : "possible",
      lines: [
        {
          entityId: income.entityId,
          accountCode: DIVIDEND_INCOME,
          accountName: accountName(opts.names, income.entityId, DIVIDEND_INCOME) ?? "Other income",
          debitMinor: income.amountMinor.toString(),
          creditMinor: "0",
          memo: `Dividend from ${payer.entityId} — ${income.reference}`,
        },
        {
          entityId: payer.entityId,
          accountCode: payer.accountCode,
          accountName: accountName(opts.names, payer.entityId, payer.accountCode) ?? "Retained earnings",
          debitMinor: "0",
          creditMinor: income.amountMinor.toString(),
          memo: `Dividend to ${income.entityId} — ${payer.reference}`,
        },
      ],
      totalMinor: income.amountMinor.toString(),
    });
  }

  return out;
}

/** A member's own name for an account code, where the chart has been renamed. */
const accountName = (map: Map<string, string>, entityId: string, code: string) => map.get(`${entityId}::${code}`);

/* ---------------------------------------------------------- unrealisedProfit */

/**
 * Profit on goods sold within the group that are still in stock at the year end.
 *
 * THE QUANTITIES ARE AN INPUT, AND THAT IS NOT A SHORTCUT. The ledger records
 * that A sold goods to B and that B holds stock; it does not record that the
 * stock B holds is the stock A sold it. Inventory is fungible, B buys the same
 * goods from third parties, and the costing method decides which units are
 * treated as sold. Only a stock count that identifies where the goods came from
 * can answer it, so that is what this function asks for. Inventing the split —
 * pro rata on purchases, say — would produce a figure that looks authoritative,
 * cannot be checked, and is wrong by an unknowable amount.
 *
 * What is eliminated is the MARGIN, never the cost. IFRS 10.B86(c) requires
 * profits arising from intragroup transactions that are recognised in assets to
 * be eliminated in full: the group has not made a profit until the goods leave
 * it, and until then group stock must be carried at what it cost the group.
 * The cost is a real cost and stays exactly where it is.
 */
export async function unrealisedProfit(opts: {
  orgId: string;
  groupCode: string;
  asOf: string;
  /** The period the seller's margin is measured over. Defaults to its fiscal year. */
  from?: string;
  stock: StockOnHand[];
}): Promise<UnrealisedProfitResult> {
  const group = await resolveGroup(opts.orgId, opts.groupCode);
  const asOf = parseDate(opts.asOf, "reporting date");
  const from = opts.from
    ? parseDate(opts.from, "start of the period")
    : await fiscalYearStart(opts.orgId, group.members, asOf);

  const warnings: string[] = [];
  const rows: UnrealisedStockRow[] = [];
  const memberIds = new Set(group.members.map((m) => m.entityId));
  /** One profit-and-loss read per selling member, at most. */
  const marginCache = new Map<string, bigint | null>();

  for (const [i, s] of opts.stock.entries()) {
    const what = `Stock line ${i + 1}`;
    if (!memberIds.has(s.sellerEntityId)) {
      throw new LedgerError(
        `${what} names ${s.sellerEntityId} as the seller, and it is not a member of ${group.code} ` +
          `(${[...memberIds].join(", ")}). Profit on a sale from outside the group is realised profit — the goods ` +
          `were bought from somebody else — and there is nothing to eliminate.`,
      );
    }
    if (!memberIds.has(s.holderEntityId)) {
      throw new LedgerError(
        `${what} names ${s.holderEntityId} as the holder, and it is not a member of ${group.code} ` +
          `(${[...memberIds].join(", ")}). Stock held outside the group has left it, and the profit on it is real.`,
      );
    }
    if (s.sellerEntityId === s.holderEntityId) {
      throw new LedgerError(
        `${what} has ${s.sellerEntityId} selling to itself. An entity cannot make a profit on a transfer within ` +
          `its own books, so there is nothing here to eliminate.`,
      );
    }

    const quantity = wholeUnits(s.quantity, `${what}'s quantity`);
    const unitPrice = wholeUnits(s.unitTransferPriceMinor, `${what}'s transfer price`);
    if (quantity < 0n || unitPrice < 0n) {
      throw new LedgerError(`${what} carries a negative quantity or price. Neither is a stock count.`);
    }

    const carrying = quantity * unitPrice;
    let unitCost: bigint;
    let basis: UnrealisedStockRow["basis"];
    let basisNote: string;

    if (s.unitCostMinor !== undefined && s.unitCostMinor !== null) {
      unitCost = wholeUnits(s.unitCostMinor, `${what}'s unit cost`);
      if (unitCost < 0n) throw new LedgerError(`${what} carries a negative unit cost.`);
      if (unitCost > unitPrice) {
        warnings.push(
          `${what} was transferred at ${unitPrice} and cost ${unitCost}, so ${s.sellerEntityId} sold it at a loss. ` +
            `Nothing is eliminated — there is no unrealised profit in it — but a sale between members at below ` +
            `cost is worth a second look, and it may be an impairment rather than a transfer price.`,
        );
        unitCost = unitPrice;
      }
      basis = "stated_cost";
      basisNote =
        `The cost was given as ${unitCost} a unit, so the profit in this stock is exact rather than an average.`;
    } else {
      // No cost given. The seller's own gross margin for the period is the best
      // the ledger can offer, and it is an average across everything it sold —
      // which is a different thing from the margin on these goods, and is said
      // so rather than presented as a measurement.
      let marginBps = marginCache.get(s.sellerEntityId);
      if (marginBps === undefined) {
        const pl = await profitAndLoss({
          orgId: opts.orgId,
          entityId: s.sellerEntityId,
          from: iso(from),
          to: iso(asOf),
        });
        marginBps = bps(BigInt(pl.grossProfitMinor), BigInt(pl.revenue.totalMinor));
        marginCache.set(s.sellerEntityId, marginBps);
      }
      if (marginBps === null || marginBps <= 0n) {
        warnings.push(
          `${what} carries no unit cost and ${s.sellerEntityId} has no gross margin between ${iso(from)} and ` +
            `${iso(asOf)} to stand in for one, so nothing has been eliminated against it. Supply the cost of the ` +
            `goods — an elimination guessed at nil is still a guess.`,
        );
        marginBps = 0n;
      } else {
        warnings.push(
          `${what} carries no unit cost, so ${s.sellerEntityId}'s own gross margin of ${marginBps} basis points ` +
            `for the period has been applied. That is an average over everything it sold, not a measurement of ` +
            `these goods, and the elimination is only as good as that assumption.`,
        );
      }
      const profitPerUnit = (unitPrice * marginBps) / WHOLLY_OWNED_BPS;
      unitCost = unitPrice - profitPerUnit;
      basis = "seller_gross_margin";
      basisNote =
        `No cost was given, so ${s.sellerEntityId}'s gross margin of ${marginBps} basis points for the period ` +
        `was applied to the transfer price. An average, not a measurement.`;
    }

    const cost = quantity * unitCost;
    const profit = carrying - cost;
    rows.push({
      sellerEntityId: s.sellerEntityId,
      holderEntityId: s.holderEntityId,
      item: (s.item ?? "").trim() || "Unnamed stock line",
      quantity: quantity.toString(),
      unitTransferPriceMinor: unitPrice.toString(),
      unitCostMinor: unitCost.toString(),
      carryingAmountMinor: carrying.toString(),
      costToGroupMinor: cost.toString(),
      unrealisedProfitMinor: profit.toString(),
      marginBps: bps(profit, carrying)?.toString() ?? null,
      basis,
      basisNote,
    });
  }

  const totalCarrying = rows.reduce((a, r) => a + BigInt(r.carryingAmountMinor), 0n);
  const totalCost = rows.reduce((a, r) => a + BigInt(r.costToGroupMinor), 0n);
  const totalProfit = totalCarrying - totalCost;

  const nameMap = await accountNames(opts.orgId, group.members);
  // One entry rather than one per line: the working paper carries a single
  // adjustment, and its detail is the table above it.
  const sellers = [...new Set(rows.filter((r) => BigInt(r.unrealisedProfitMinor) > 0n).map((r) => r.sellerEntityId))];
  const holders = [...new Set(rows.filter((r) => BigInt(r.unrealisedProfitMinor) > 0n).map((r) => r.holderEntityId))];

  const elimination: EliminationEntry | null =
    totalProfit <= 0n
      ? null
      : {
          key: `unrealised_profit:${group.code}:${iso(asOf)}`,
          kind: "unrealised_profit",
          authority:
            "IFRS 10.B86(c) — profits from intragroup transactions recognised in assets, such as inventories, " +
            "are eliminated in full.",
          narrative:
            `${totalCarrying} of stock bought within the group is still held at ${iso(asOf)}. It cost the group ` +
            `${totalCost}; the ${totalProfit} on top is profit one member recorded on a sale to another and the ` +
            `group has not earned, because the goods have not left it. The margin comes off and the cost stays. ` +
            `The quantities were supplied, not derived — the ledger cannot know which stock came from where.`,
          confidence: rows.every((r) => r.basis === "stated_cost") ? "high" : "probable",
          lines: [
            {
              entityId: sellers.length === 1 ? sellers[0] : null,
              accountCode: COST_OF_GOODS_SOLD,
              accountName: nameMap.get(`${sellers[0]}::${COST_OF_GOODS_SOLD}`) ?? "Cost of goods sold",
              debitMinor: totalProfit.toString(),
              creditMinor: "0",
              memo: `Margin on stock still held within the group at ${iso(asOf)}`,
            },
            {
              entityId: holders.length === 1 ? holders[0] : null,
              accountCode: INVENTORY_CODE,
              accountName: nameMap.get(`${holders[0]}::${INVENTORY_CODE}`) ?? "Inventory",
              debitMinor: "0",
              creditMinor: totalProfit.toString(),
              memo: `Stock written back to what it cost the group at ${iso(asOf)}`,
            },
          ],
          totalMinor: totalProfit.toString(),
        };

  return {
    groupCode: group.code,
    groupName: group.name,
    currency: group.currency,
    from: iso(from),
    asOf: iso(asOf),
    rows,
    totalCarryingMinor: totalCarrying.toString(),
    totalCostMinor: totalCost.toString(),
    totalUnrealisedProfitMinor: totalProfit.toString(),
    elimination,
    inputNote:
      `The quantities above were supplied by whoever ran this, not read out of the ledger. The books record that ` +
      `one member sold goods to another and that the other holds stock; nothing in them says the stock on hand is ` +
      `the stock that was bought within the group, because inventory is fungible and the same goods are bought ` +
      `from outside it. Only a stock count can answer that, and this figure is exactly as reliable as the count ` +
      `behind it.`,
    warnings,
  };
}

/* ------------------------------------------------------------------ helpers */

/** Account names for every member, so a schedule line can be read without a lookup. */
async function accountNames(orgId: string, members: MemberRef[]): Promise<Map<string, string>> {
  const accounts = await prisma.account.findMany({
    where: { orgId, entityId: { in: members.map((m) => m.entityId) } },
    select: { entityId: true, code: true, name: true },
  });
  return new Map(accounts.map((a) => [`${a.entityId}::${a.code}`, a.name]));
}

/**
 * Where the period starts when the caller gave only a date.
 *
 * The members' own fiscal year, so the income and expense half of the schedule
 * covers the year the balance sheet half is drawn at the end of. A calendar
 * year is the fallback and nothing more — a group whose year ends in June would
 * otherwise silently get six months of intragroup revenue.
 */
async function fiscalYearStart(orgId: string, members: MemberRef[], asOf: Date): Promise<Date> {
  const fy = await prisma.fiscalYear.findFirst({
    where: {
      orgId,
      entityId: { in: members.map((m) => m.entityId) },
      startsOn: { lte: asOf },
      endsOn: { gte: asOf },
    },
    orderBy: { startsOn: "desc" },
  });
  return fy ? fy.startsOn : new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
}
