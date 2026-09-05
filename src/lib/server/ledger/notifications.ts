import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { LedgerError } from "./post";
import { attentionList, sharedReads, type SharedReads, type Severity as AttentionSeverity } from "./attention";
import { monthEnd } from "./month-end";
import { expiringStock, belowReorderLevel } from "./inventory";
import { dueSoon } from "./cheques";
import { deliveredNotInvoiced } from "./deliveries";
import { dueSubscriptions } from "./subscriptions";
import { ledgerAnalytics } from "./analytics";
import { testCovenants } from "./borrowings";
import { adjustmentDue } from "./vat-schemes";
import { dunningPlan } from "./credit-control";

/**
 * The notification centre — one place for everything the books are trying to
 * tell somebody, ranked, and with a memory of what has been dealt with.
 *
 * "Needs attention" already answers "what is the ledger waiting for". The
 * month-end checklist answers "is this month finished". The stock, cheque, VAT
 * and audit screens each answer their own. Every one of them is right, and a
 * bookkeeper who has to open eight screens to find out whether anything is on
 * fire opens none of them. This module opens all eight and puts the answers in
 * one queue.
 *
 * Four decisions carry it.
 *
 * ── 1. Nothing here computes a finding. ──────────────────────────────────────
 * Every row comes from the module that already owns the fact, called through
 * its own public function. This module maps, ranks, de-duplicates and
 * remembers; it never re-derives. The moment it worked out overdue debt a
 * second way it would start disagreeing with the receivables screen it links
 * to, and a queue that disagrees with the page that clears it is worse than no
 * queue. The one derivation here is the VAT filing deadline, and it is a fact
 * of law rather than a fact about these books — see `vatFilingDeadline`.
 *
 * ── 2. A source that cannot be read costs one row, never the page. ───────────
 * The sources run through `Promise.allSettled`, exactly as `attention.ts` runs
 * its checks. An entity whose books were never opened, a chart missing an
 * account a report needs, a table absent mid-migration: any of those throws,
 * and the honest answer is one row naming the source that went quiet while the
 * other seven are still shown. A single `Promise.all` here would turn one
 * missing account into a blank page, which is the failure mode where somebody
 * misses a filing deadline because the screen that would have told them showed
 * nothing at all. A source that could not be read is reported as a WARNING and
 * not as information: it might have been hiding a blocker, and a check that did
 * not run is not a check that passed.
 *
 * ── 3. Severity is passed through, never invented. ───────────────────────────
 * Each source already ranks its own findings and each has its own vocabulary.
 * They are translated into one, and the translation is a table (`ATTENTION_*`,
 * `MONTH_END_*`, `ANALYTICS_*`) rather than a judgement, so a row cannot become
 * louder by passing through here. A deadline is attached only where the source
 * knows one. Nothing on this list is given a due date it does not have: an
 * invented deadline is how a queue teaches people that its dates mean nothing.
 *
 * ── 4. Identity is what a finding is ABOUT, not what it says. ────────────────
 * See the long note on `keyOf`. It is the decision the acknowledgement rests
 * on, and getting it wrong is how an acknowledgement evaporates the week
 * somebody improves a sentence.
 */

/* ------------------------------------------------------------- vocabulary --- */

/**
 * One severity scale for eight sources.
 *
 *   blocker      something is wrong now, or a deadline set by law has passed.
 *                Work stops for it. It cannot be acknowledged away — only
 *                deferred, and a deferral has an end date by construction.
 *   warning      it will be wrong, or a deadline is coming, or a check that
 *                might have said either could not be run.
 *   advisory     work somebody started and has not finished. Nothing is late
 *                and nothing is wrong.
 *   information  a fact worth knowing with nothing to do about it.
 *
 * The four words are the month-end checklist's two ("blocker", "advisory")
 * extended rather than replaced, because those two are the ones this product's
 * users already read on a screen that closes a month.
 */
export type NoticeSeverity = "blocker" | "warning" | "advisory" | "information";

const RANK: Record<NoticeSeverity, number> = { blocker: 0, warning: 1, advisory: 2, information: 3 };

/**
 * Where a notice stands with the people who have seen it.
 *
 *   open          nobody has said anything about it.
 *   returned      somebody dealt with it and it has come back — the snooze ran
 *                 out, or the finding got worse than the one they saw.
 *   acknowledged  somebody has seen it and said so. It stays visible on the
 *                 dealt-with list; it is never deleted.
 *   snoozed       somebody wants it back on a stated day.
 *
 * `returned` is a kind of open, not a kind of dealt-with: the work is
 * outstanding again. It is a separate word only so the row can say why it is
 * back, which is the difference between a queue and a whack-a-mole.
 */
export type NoticeState = "open" | "returned" | "acknowledged" | "snoozed";

export interface DealtWith {
  action: "acknowledged" | "snoozed";
  actorId: string;
  actorName: string | null;
  at: string;
  reason: string | null;
  /** The severity the finding carried when it was dealt with. */
  severity: NoticeSeverity;
  /** How many things it covered then, where a count means something. */
  itemCount: number | null;
  /** What it was worth then, in minor units as a string. */
  amountMinor: string | null;
  /** The day a snooze runs out. Null for an acknowledgement. */
  snoozeUntil: string | null;
}

export interface Notice {
  /** The stable identity. See `keyOf`. */
  key: string;
  /** Which module said so, and which of its checks. */
  source: string;
  topic: string;
  /** The particular thing within the topic — a month, a quarter, an actor. */
  scope: string | null;
  severity: NoticeSeverity;
  title: string;
  /** A sentence somebody can act on without opening anything else. */
  detail: string;
  /** The screen where the work actually gets done. */
  href: string;
  /** How many things this covers, where a count means something. */
  itemCount: number | null;
  /** Minor units as a string — the wire never carries a ledger amount as a number. */
  amountMinor: string | null;
  /** The day it has to be done by, where the source knows one. Never invented. */
  dueOn: string | null;
  /** Days to `dueOn`: negative is past, nought is today. Null where there is no deadline. */
  daysToDue: number | null;
  /** True where the deadline is set by law rather than by habit or terms. */
  statutory: boolean;
  state: NoticeState;
  /** open and returned are both outstanding work. */
  outstanding: boolean;
  dealtWith: DealtWith | null;
  /** Why an acknowledgement or a snooze stopped applying. */
  returnedBecause: string | null;
  /** What can be done to this row, and why not where not. */
  mayAcknowledge: boolean;
  mayAcknowledgeBecause: string | null;
  /** The last day a snooze may run to, where anything limits it. */
  snoozeLimit: string | null;
  snoozeLimitBecause: string | null;
}

export interface SourceRun {
  key: string;
  label: string;
  ok: boolean;
  /** Rows this source contributed. Nought with `ok` is a clean source. */
  rows: number;
  /** Why it could not be read. Null when it was. */
  reason: string | null;
}

export interface DigestDeadline {
  key: string;
  title: string;
  severity: NoticeSeverity;
  dueOn: string;
  daysToDue: number;
  statutory: boolean;
}

export interface DigestSnooze {
  key: string;
  title: string;
  severity: NoticeSeverity;
  until: string;
  daysToReturn: number;
  by: string | null;
}

export interface Digest {
  /** Counts of outstanding work only. Something dealt with is not on this list. */
  counts: Record<NoticeSeverity, number>;
  outstanding: number;
  acknowledged: number;
  snoozed: number;
  /** Outstanding again because it got worse or the snooze ran out. */
  returned: number;
  /** The window `dueSoon` covers. */
  dueWithinDays: number;
  /** Deadlines inside the window, nearest first. */
  dueSoon: DigestDeadline[];
  /** Deadlines already past, oldest first. Kept apart: these are not "soon". */
  overdue: DigestDeadline[];
  /** What has been put off, and the day each comes back. */
  snoozedUntil: DigestSnooze[];
}

export interface NotificationCentre {
  entityId: string;
  asOf: string;
  currency: string;
  notices: Notice[];
  sources: SourceRun[];
  digest: Digest;
}

/* ---------------------------------------------------------------- helpers --- */

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function asDate(v: Date | string | undefined, what: string): Date {
  if (v === undefined) return new Date();
  const d = typeof v === "string" ? new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date.`);
  return d;
}

/**
 * Minor units inside a sentence: always the magnitude, never parenthesised.
 * Parentheses are how a *numeral* carries a negative; prose says the direction
 * in words. `fmtMinor` does the formatting so a three-decimal currency reads
 * correctly here and on the screen alike.
 */
function money(minor: bigint, currency: string): string {
  return `${currency} ${fmtMinor(minor < 0n ? -minor : minor, currency, { zero: "zero" })}`;
}

/** How far ahead the digest looks. A week is what "this week" means. */
const DUE_SOON_DAYS = 7;

/*
 * The tax period and its deadline both come from `tax-periods.ts`, which reads
 * the registration.
 *
 * This module does not decide WHETHER a return is outstanding — `attention.ts`
 * does, from the period locks, and that inference stays there. What used to be
 * derived here was WHEN the law wants it, from a calendar quarter and a
 * 28-day constant stated separately in three modules. That was right only for
 * a taxpayer the FTA happened to put on the calendar's own stagger. It is now
 * one call, so the row this file raises and the date it carries cannot drift
 * from each other or from the return itself.
 */

/**
 * The longest anything may be put off. A month is the outside edge of a
 * deferral: past that, somebody has made a decision about the finding rather
 * than postponed looking at it, and the honest way to record a decision is an
 * acknowledgement with a reason, which stays on the list.
 */
const MAX_SNOOZE_DAYS = 30;

/**
 * And the outside edge for a blocker, which is a week.
 *
 * A blocker is something wrong now or a deadline gone by. It cannot be
 * acknowledged at all — see `acknowledge` — and it cannot be deferred out of
 * sight either, or "cannot be acknowledged" would be a formality anybody could
 * step round by snoozing it until the next financial year.
 */
const MAX_BLOCKER_SNOOZE_DAYS = 7;

/* ----------------------------------------------------------------- gather --- */

/** A finding as a source hands it over, before identity, ranking or memory. */
interface Raw {
  source: string;
  topic: string;
  scope?: string | null;
  severity: NoticeSeverity;
  title: string;
  detail: string;
  href: string;
  itemCount?: number;
  amountMinor?: bigint;
  /** Only where the source knows one. */
  dueOn?: string | null;
  statutory?: boolean;
}

interface Ctx {
  orgId: string;
  entityId: string;
  asOf: Date;
  currency: string;
  /**
   * The reads the sources make in common, made once for the whole page.
   *
   * Three of the twelve sources below are the attention list, the month-end
   * checklist and the VAT return, and between them they used to compute the
   * same quarter's return twice and look the same tax period up three times —
   * because each of them correctly called the module that owns the fact and
   * none of them could see the others doing it. See the note on `SharedReads`
   * in `attention.ts` for what is shared and what deliberately is not.
   */
  reads: SharedReads;
}

interface Source {
  key: string;
  /** What this source looks at, for the row that says it could not be read. */
  label: string;
  run: (ctx: Ctx) => Promise<Raw[]>;
}

/**
 * THE STABLE IDENTITY OF A FINDING.
 *
 * An acknowledgement has to survive the next run, and the run after somebody
 * improves the wording. So identity is three things and deliberately not a
 * fourth:
 *
 *   source  which module said it. Two modules can legitimately report the same
 *           subject about different months; keeping the source in the key means
 *           neither can silently answer for the other.
 *   topic   which of that module's checks. These are already stable strings in
 *           the modules themselves — `bank_unmatched`, `depreciation`,
 *           `actor_outlier:<id>` — chosen there precisely so a row can be
 *           linked to and tested for.
 *   scope   which particular thing, where the finding is about one: a month, a
 *           quarter, a SKU. Payroll unposted for March and payroll unposted for
 *           April are two facts, and an acknowledgement of the first must not
 *           silence the second.
 *
 * What is NOT in the key is the message, the count and the amount.
 *
 * The message is out because keying on it means the acknowledgement evaporates
 * the moment somebody rewords a sentence — and every one of these sentences is
 * generated, so half of them change wording whenever the underlying figure
 * changes. An acknowledgement that dies when a number moves is not a memory.
 *
 * The count and the amount are out for the opposite reason: if they were in the
 * key, "47 unreconciled bank lines" would be a brand new notification with no
 * history, and the fact that somebody had already looked at this and decided it
 * was fine would be lost. They belong on the *acknowledgement* instead — the
 * ack records the finding as it stood — and `stillCovers` compares them on
 * every run. Same identity, bigger problem, acknowledgement lapses. That is the
 * whole mechanism, and it is why acknowledging three unreconciled lines cannot
 * suppress forty-seven.
 */
function keyOf(r: { source: string; topic: string; scope?: string | null }): string {
  return `${r.source}:${r.topic}${r.scope ? `@${r.scope}` : ""}`;
}

/* --- needs attention ------------------------------------------------------ */

/**
 * `attention.ts` ranks by deadline: urgent is late or impossible, soon is a
 * week away, note is unfinished work. That is the same axis this list uses, so
 * the translation is a rename and nothing more.
 */
const ATTENTION_SEVERITY: Record<AttentionSeverity, NoticeSeverity> = {
  urgent: "blocker",
  soon: "warning",
  note: "advisory",
};

const attentionSource: Source = {
  key: "attention",
  label: "Needs attention",
  async run(ctx) {
    const list = await attentionList({
      orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.asOf, reads: ctx.reads,
    });
    // Read from the registration, so the deadline attached here and the period
    // attention.ts decided about are the same period. Both used to derive a
    // calendar quarter independently, which agreed only for taxpayers the FTA
    // happened to put on the calendar's own stagger — and it is now literally
    // the same read, so they cannot even disagree by a race.
    const period = await ctx.reads.vatPeriod(ctx.asOf);
    const out: Raw[] = [];

    for (const f of list.findings) {
      // The VAT return is the one row on that list with a deadline set by
      // statute rather than by terms. `attention.ts` decides whether it is
      // outstanding; the date comes from the law.
      const vat = f.key === "vat_return" ? period : null;
      out.push({
        source: "attention",
        topic: f.key,
        scope: vat ? vat.label : null,
        severity: ATTENTION_SEVERITY[f.severity],
        title: f.title,
        detail: f.detail,
        href: f.href,
        itemCount: f.count,
        amountMinor: f.amountMinor === undefined ? undefined : BigInt(f.amountMinor),
        // The check's own deadline where it has one, and the tax period's for
        // the return — which is the one row on that list whose date this module
        // knows better than the check does, because it reads the registration.
        dueOn: vat ? vat.dueOn : f.dueOn ?? null,
        statutory: Boolean(vat) || f.statutory === true,
      });
    }

    // A check inside that list which could not run is a hole in it, and a hole
    // nobody is told about is worse than a finding.
    for (const f of list.failed) {
      out.push({
        source: "attention",
        topic: `unchecked:${f.key}`,
        severity: "warning",
        title: `${f.label} could not be checked`,
        detail:
          `The attention list ran ${f.label.toLowerCase()} against these books and it did not complete: ${f.reason} ` +
          `A check that did not run is not a check that passed, so this is on the list rather than off it.`,
        href: "/accounting/attention",
      });
    }
    return out;
  },
};

/* --- the month-end checklist ---------------------------------------------- */

/**
 * A month-end blocker is something that would make the month WRONG IF CLOSED.
 * It blocks the close and nothing else — the books are not wrong until somebody
 * shuts the door on them — so it lands here as a warning rather than a blocker,
 * and the row says which month it is holding up.
 */
const MONTH_END_SEVERITY: Record<string, NoticeSeverity> = { blocker: "warning", advisory: "advisory" };

/**
 * Five of the checklist's ten checks ask a question the attention list has
 * already asked about the same books: the trial balance, depreciation, the
 * recurring journals, the bank and the months behind this one. Carrying both
 * would put the trial balance on this queue twice, which is how a queue stops
 * being read.
 *
 * The overlap is listed rather than inferred, so a NEW check in either module
 * turns up on this screen instead of being swallowed by a clever rule that
 * nobody remembers writing.
 */
const MONTH_END_ALREADY_SAID = new Set(["trial_balance", "depreciation", "recurring", "bank", "prior_periods"]);

const monthEndSource: Source = {
  key: "month-end",
  label: "The month-end checklist",
  async run(ctx) {
    // The latest month that has actually ended and is not shut. A month still
    // running has nothing to be behind on, and one already hard-closed or
    // locked cannot be acted on.
    const period = await prisma.accountingPeriod.findFirst({
      where: {
        orgId: ctx.orgId,
        entityId: ctx.entityId,
        isAdjustment: false,
        endsOn: { lt: ctx.asOf },
        status: { in: ["open", "soft_closed"] },
      },
      orderBy: { endsOn: "desc" },
      select: { label: true },
    });
    if (!period) return [];

    const state = await monthEnd({
      orgId: ctx.orgId, entityId: ctx.entityId, period: period.label, reads: ctx.reads,
    });
    const out: Raw[] = [];

    for (const c of state.checks) {
      if (c.severity === "done") continue;
      if (MONTH_END_ALREADY_SAID.has(c.key)) continue;
      out.push({
        source: "month-end",
        topic: c.key,
        scope: state.period,
        severity: MONTH_END_SEVERITY[c.severity] ?? "advisory",
        title: `${c.label} — ${state.period}`,
        detail: c.detail,
        href: c.href,
        itemCount: c.count,
        amountMinor: c.amountMinor === undefined ? undefined : BigInt(c.amountMinor),
      });
    }

    for (const f of state.failed) {
      if (MONTH_END_ALREADY_SAID.has(f.key)) continue;
      out.push({
        source: "month-end",
        topic: `unchecked:${f.key}`,
        scope: state.period,
        severity: "warning",
        title: `${f.label} could not be checked for ${state.period}`,
        detail:
          `${f.reason} The checklist counts a check that could not run against closing rather than as a pass, ` +
          `and so does this list.`,
        href: "/accounting/month-end",
      });
    }
    return out;
  },
};

/* --- the VAT return ------------------------------------------------------- */

const vatSource: Source = {
  key: "vat",
  label: "The VAT return",
  async run(ctx) {
    // The same period the attention list reads, from the same registration, so
    // the row this source raises and the deadline that one carries cannot drift
    // apart — and neither of them is a calendar quarter unless the FTA said so.
    const { label, from, to } = await ctx.reads.vatPeriod(ctx.asOf);

    const ret = await ctx.reads.vatReturn(from, to);
    if (ret.warnings.length === 0) return [];

    // One row for the set, not one per string. The wording of each warning is
    // generated and changes with the figures inside it, so a row per string
    // would be a row whose identity died every time the number moved. The
    // count is what makes the set worse, and the count is on the ack.
    return [{
      source: "vat",
      topic: "return_warnings",
      scope: label,
      severity: "warning",
      title: `The ${label} VAT return has ${plural(ret.warnings.length, "thing", "things")} to explain first`,
      detail:
        `${ret.warnings.join(" ")} Filing a return that does not agree with the ledger behind it is the one ` +
        `mistake here that is expensive to unwind, so these are worth settling before the return goes.`,
      href: "/accounting/vat",
      itemCount: ret.warnings.length,
    }];
  },
};

/* --- stock ---------------------------------------------------------------- */

const inventorySource: Source = {
  key: "inventory",
  label: "Stock",
  async run(ctx) {
    const [expiry, reorder] = await Promise.all([
      expiringStock({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.asOf }),
      belowReorderLevel({ orgId: ctx.orgId, entityId: ctx.entityId }),
    ]);
    const out: Raw[] = [];

    if (expiry.expired.length > 0) {
      out.push({
        source: "inventory",
        topic: "expired",
        severity: "warning",
        title: "Stock has gone off and is still on the balance sheet",
        detail:
          `${plural(expiry.expired.length, "batch has", "batches have")} passed their expiry date and are still ` +
          `carried at ${money(BigInt(expiry.totals.expiredValueMinor), ctx.currency)}. Expired goods on hand are ` +
          `worth nothing, so until they are swept the balance sheet is overstated by that much. The oldest is ` +
          `${expiry.expired[0].sku}, batch ${expiry.expired[0].code}, dated ${expiry.expired[0].expiresOn}.`,
        href: "/accounting/inventory",
        itemCount: expiry.expired.length,
        amountMinor: BigInt(expiry.totals.expiredValueMinor),
      });
    }

    if (expiry.expiring.length > 0) {
      // `expiring` comes back ordered by expiry date, so the head is the next
      // one to go — and it is a real date, not a guess, so it becomes the
      // deadline for this row.
      const next = expiry.expiring[0];
      out.push({
        source: "inventory",
        topic: "expiring",
        severity: "advisory",
        title: `Stock goes off within ${expiry.withinDays} days`,
        detail:
          `${plural(expiry.expiring.length, "batch is", "batches are")} inside their last ` +
          `${expiry.withinDays} days, worth ${money(BigInt(expiry.totals.expiringValueMinor), ctx.currency)}. ` +
          `The first is ${next.sku}, batch ${next.code}, on ${next.expiresOn}. Selling it is a trading decision ` +
          `rather than an accounting one, which is why it is here and not on the month-end list.`,
        href: "/accounting/inventory",
        itemCount: expiry.expiring.length,
        amountMinor: BigInt(expiry.totals.expiringValueMinor),
        dueOn: next.expiresOn,
      });
    }

    // Covered means somebody has already ordered enough to bring it back above
    // the level. The module still reports it as below — goods on a lorry are
    // not goods on a shelf — but nobody needs telling twice, so only the
    // uncovered ones are a row here.
    const uncovered = reorder.items.filter((i) => !i.covered);
    if (uncovered.length > 0) {
      out.push({
        source: "inventory",
        topic: "reorder",
        severity: "advisory",
        title: "Stock is below its reorder level with nothing on order",
        detail:
          `${plural(uncovered.length, "item is", "items are")} at or below the level somebody set for ` +
          `${uncovered.length === 1 ? "it" : "them"} and nothing is on order to cover ` +
          `${uncovered.length === 1 ? "it" : "them"} — ` +
          `${uncovered.slice(0, 3).map((i) => `${i.sku} (${i.quantity} against ${i.reorderLevel})`).join(", ")}` +
          `${uncovered.length > 3 ? ", …" : ""}. ` +
          `${reorder.totals.covered > 0
            ? `A further ${reorder.totals.covered} ${reorder.totals.covered === 1 ? "is" : "are"} below the level ` +
              `with an order already in flight, and ${reorder.totals.covered === 1 ? "is" : "are"} not listed here.`
            : ""}`,
        href: "/accounting/inventory",
        itemCount: uncovered.length,
      });
    }

    if (reorder.unmonitored.length > 0) {
      out.push({
        source: "inventory",
        topic: "unmonitored",
        severity: "information",
        title: "Some items have no reorder level",
        detail:
          `${plural(reorder.unmonitored.length, "item carries", "items carry")} no reorder level, so nothing can ` +
          `say whether they are running low. No level and a level of nothing are different statements about an ` +
          `item, and this is the first of the two. There is nothing wrong here; it is on the list because ` +
          `silence about an item reads exactly like an item that is fine.`,
        href: "/accounting/inventory",
        itemCount: reorder.unmonitored.length,
      });
    }

    return out;
  },
};

/* --- the cheque diary ----------------------------------------------------- */

const chequeSource: Source = {
  key: "cheques",
  label: "The cheque diary",
  async run(ctx) {
    const diary = await dueSoon({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.asOf, days: 30 });
    const out: Raw[] = [];

    // An issued cheque falling due with no money behind it. In the UAE the
    // consequence of that lands on the person who signed it, which is why the
    // diary computes cover at all — and why it is the one thing on this queue
    // that outranks a filing deadline.
    if (diary.uncoveredCount > 0) {
      out.push({
        source: "cheques",
        topic: "uncovered",
        severity: "blocker",
        title: "Cheques fall due that the bank balance does not cover",
        detail:
          `${plural(diary.uncoveredCount, "issued cheque is", "issued cheques are")} due on or before ` +
          `${diary.firstShortDay ?? diary.until} that the account they are drawn on will not meet, short by ` +
          `${money(diary.shortfallMinor, ctx.currency)} at the worst point. The diary measures each cheque against ` +
          `what the ones before it left, and it deliberately ignores the cheques coming in — a business that meets ` +
          `its own cheques out of cheques it has been handed is one dishonour away from dishonouring its own.`,
        href: "/accounting/cheques",
        itemCount: diary.uncoveredCount,
        amountMinor: diary.shortfallMinor,
        dueOn: diary.firstShortDay,
      });
    }

    const covered = diary.issued.filter((c) => c.covered);
    if (covered.length > 0) {
      out.push({
        source: "cheques",
        topic: "issued_due",
        severity: "advisory",
        title: "Cheques the business has written fall due",
        detail:
          `${plural(covered.length, "cheque is", "cheques are")} due by ${diary.until}, ` +
          `${money(covered.reduce((a, c) => a + c.amountMinor, 0n), ctx.currency)} in all, and the accounts they ` +
          `are drawn on hold enough for ${covered.length === 1 ? "it" : "them"}. The first is ` +
          `${covered[0].number} to ${covered[0].counterparty} on ${covered[0].dueOn}. Keep the money where it is.`,
        href: "/accounting/cheques",
        itemCount: covered.length,
        amountMinor: covered.reduce((a, c) => a + c.amountMinor, 0n),
        dueOn: covered[0].dueOn,
      });
    }

    // A cheque received, due, and neither cleared nor bounced. Either the bank
    // has not been given it or it has not been paid, and both of those are
    // somebody's job today.
    const stale = diary.received.filter((c) => c.bucket === "overdue");
    if (stale.length > 0) {
      out.push({
        source: "cheques",
        topic: "received_stale",
        severity: "warning",
        title: "Cheques held are past their date and have not cleared",
        detail:
          `${plural(stale.length, "cheque", "cheques")} worth ` +
          `${money(stale.reduce((a, c) => a + c.amountMinor, 0n), ctx.currency)} passed their date without ` +
          `clearing — the oldest is ${stale[0].number} from ${stale[0].counterparty}, dated ${stale[0].dueOn}. ` +
          `Taking the cheque discharged the invoice, so the customer no longer shows as owing this: until the ` +
          `cheque clears or bounces, the money is neither in the bank nor on the receivables list.`,
        href: "/accounting/cheques",
        itemCount: stale.length,
        amountMinor: stale.reduce((a, c) => a + c.amountMinor, 0n),
        dueOn: stale[0].dueOn,
      });
    }

    return out;
  },
};

/* --- goods gone, nobody billed -------------------------------------------- */

const deliverySource: Source = {
  key: "deliveries",
  label: "Delivered and not invoiced",
  async run(ctx) {
    const dni = await deliveredNotInvoiced({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.asOf });
    if (dni.rows.length === 0) return [];

    return [{
      source: "deliveries",
      topic: "not_invoiced",
      severity: "advisory",
      title: "Goods have gone out and no invoice has followed",
      detail:
        `${plural(dni.totals.lines, "delivered line is", "delivered lines are")} still unbilled, worth ` +
        `${money(dni.totals.valueMinor, ctx.currency)} at the order price. The cost has already left stock, so ` +
        `the accounts currently carry the cost of these goods and none of the revenue. The oldest went out on ` +
        `${dni.rows[0].deliveredOn} to ${dni.rows[0].customerName}.`,
      href: "/accounting/deliveries",
      itemCount: dni.totals.lines,
      amountMinor: dni.totals.valueMinor,
    }];
  },
};

/* --- subscriptions waiting to be raised ----------------------------------- */

const subscriptionSource: Source = {
  key: "subscriptions",
  label: "Subscription invoices",
  async run(ctx) {
    const due = await dueSubscriptions({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.asOf });
    if (due.due.length === 0) return [];

    const behind = due.due.filter((d) => d.periodsDue > 1).length;
    // Ordered by the day each was scheduled, so the head is the one that has
    // been waiting longest. That is a real date the module holds, so it is a
    // real deadline rather than an invented one.
    const first = due.due[0];

    return [{
      source: "subscriptions",
      topic: "due",
      severity: "advisory",
      title: "Subscription invoices are due to be raised",
      detail:
        `${plural(due.due.length, "subscription is", "subscriptions are")} due to be invoiced, ` +
        `${money(due.totalMinor, ctx.currency)} in all. The earliest was scheduled for ${first.scheduledOn} ` +
        `(${first.code}, ${first.customerName}).` +
        (behind > 0
          ? ` ${plural(behind, "of them is", "of them are")} more than one period behind, and each period is ` +
            `raised as its own invoice so a customer can see what each part was for.`
          : ""),
      href: "/accounting/subscriptions",
      itemCount: due.due.length,
      amountMinor: due.totalMinor,
      dueOn: first.scheduledOn,
    }];
  },
};

/* --- the audit tests ------------------------------------------------------ */

/**
 * `analytics.ts` says of its own severity: "Nothing here is late; severity is
 * how strongly the finding asks to be explained." That is a different axis from
 * this list's, and its module asks in as many words that the two never be read
 * as one. So nothing from it is ever late here, and nothing from it can outrank
 * something that is: its highest becomes an advisory, and the rest are counted
 * rather than listed.
 */
const ANALYTICS_LISTED: NoticeSeverity = "advisory";

const analyticsSource: Source = {
  key: "analytics",
  label: "The audit tests",
  async run(ctx) {
    const a = await ledgerAnalytics({ orgId: ctx.orgId, entityId: ctx.entityId, to: ctx.asOf });
    const out: Raw[] = [];

    for (const f of a.findings.filter((x) => x.severity === "high")) {
      out.push({
        source: "analytics",
        topic: f.key,
        severity: ANALYTICS_LISTED,
        title: f.title,
        detail: `${f.detail} This is a prompt to look rather than a verdict — nothing here is late.`,
        href: "/accounting/analytics",
        itemCount: f.count,
        amountMinor: f.amountMinor === undefined ? undefined : BigInt(f.amountMinor),
      });
    }

    const rest = a.counts.medium + a.counts.low;
    if (rest > 0) {
      out.push({
        source: "analytics",
        topic: "other_findings",
        severity: "information",
        title: `The audit tests raised ${plural(rest, "other question", "other questions")}`,
        detail:
          `${a.checked} tests ran over ${plural(a.population, "entry", "entries")} and asked ` +
          `${plural(rest, "question", "questions")} ${rest === 1 ? "that is" : "that are"} worth explaining but ` +
          `not urgent. They are worked through on the analytics screen, one at a time, rather than queued here — ` +
          `a list of prompts is not a list of jobs.`,
        href: "/accounting/analytics",
        itemCount: rest,
      });
    }

    return out;
  },
};


/* --- banking covenants ----------------------------------------------------- */

/**
 * A breached covenant is the one finding on this list that can cost the
 * business its funding, and it was the one finding not on it.
 *
 * `testCovenants` is measured at a reporting date and reports three outcomes,
 * never two: pass, breach, and not_tested. The third is why this source cannot
 * simply count breaches. A covenant that could not be measured — because the
 * metric needs a figure this chart does not carry — is not a covenant that
 * passed, and a screen whose own docblock says "one false green makes the whole
 * thing worthless" must not be summarised here as silence. So an untested
 * covenant gets its own advisory row.
 *
 * Measured at today against the year to date, which is what the borrowings
 * screen defaults to. A covenant is usually tested at a quarter or year end on
 * terms this ledger does not record, so the figure here is an early warning
 * rather than the bank's own test, and the wording says so.
 */
const covenantSource: Source = {
  key: "covenants",
  label: "Banking covenants",
  async run(ctx) {
    const asOf = ctx.asOf.toISOString().slice(0, 10);
    const c = await testCovenants({ orgId: ctx.orgId, entityId: ctx.entityId, asOf });
    const out: Raw[] = [];

    const breached = c.tests.filter((t) => t.result === "breach");
    if (breached.length > 0) {
      const first = breached[0];
      out.push({
        source: "covenants",
        topic: "breach",
        // Not statutory — nothing is filed — but a blocker all the same: a
        // breach is a fact about today that a lender is entitled to act on.
        severity: "blocker",
        title:
          breached.length === 1
            ? `${first.borrowingCode} is in breach of its ${first.label.toLowerCase()} covenant`
            : `${plural(breached.length, "covenant is", "covenants are")} in breach`,
        detail:
          `${breached.map((t) => `${t.borrowingCode}/${t.code}`).join(", ")} ` +
          `${breached.length === 1 ? "fails" : "fail"} on the figures at ${c.asOf}. ${first.why} ` +
          `The facility agreement is what says what happens next, and this measures the ratio on the books ` +
          `rather than on the bank's own definition — so the number to act on is this one and the consequence ` +
          `is in the agreement.`,
        href: "/accounting/borrowings",
        itemCount: breached.length,
      });
    }

    if (c.untested > 0) {
      out.push({
        source: "covenants",
        topic: "not_tested",
        severity: "warning",
        title: `${plural(c.untested, "covenant could", "covenants could")} not be measured`,
        detail:
          `${c.untested} of ${plural(c.tests.length, "covenant", "covenants")} could not be tested against the ` +
          `books at ${c.asOf}. That is not a pass. Until each is measurable the business does not know whether ` +
          `it is in compliance, and the first it would hear otherwise is from the lender.`,
        href: "/accounting/borrowings",
        itemCount: c.untested,
      });
    }

    return out;
  },
};

/* --- capital assets scheme -------------------------------------------------- */

/**
 * The single most-missed obligation in UAE VAT, and structurally so: it falls
 * due years after a purchase everybody has forgotten, on an asset nobody is
 * looking at, and nothing in the books changes to announce it.
 *
 * `vat-schemes.ts` already ships the finding in the vocabulary `attention.ts`
 * uses — its own comment says the shape exists "so this can be dropped into
 * that list without either module learning about the other" — and then nothing
 * consumed it. This does. The severity is the module's own: it decides that a
 * year late stops being an oversight and starts being a penalty, and that
 * judgement belongs to the module that knows the law, not to this one.
 */
const capitalAssetSource: Source = {
  key: "vat-schemes",
  label: "The capital assets scheme",
  async run(ctx) {
    const r = await adjustmentDue({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.asOf });
    if (!r.finding) return [];

    // The module ranks in attention.ts's vocabulary, so it translates through
    // the same table the attention source uses. It cannot become louder here.
    return [{
      source: "vat-schemes",
      topic: r.finding.key,
      severity: ATTENTION_SEVERITY[r.finding.severity],
      title: r.finding.title,
      detail: r.finding.detail,
      href: r.finding.href,
      itemCount: r.finding.count,
      // Deliberately no amountMinor: `boundMinor` is a bound in either
      // direction, not an amount owed, and putting it in the amount column
      // would read as tax payable. It is stated in the detail as what it is.
      statutory: true,
    }];
  },
};

/* --- guarantees and letters of credit --------------------------------------- */

/**
 * Two facts, and the second is the one that costs money.
 *
 * A guarantee about to expire is a diary note: the customer or supplier who
 * asked for it will ask again, and renewing late means a gap in cover.
 *
 * A facility whose expiry has already gone by and which nobody closed is worse.
 * `contingentLiabilities` drops it from the disclosure the moment it expires —
 * correctly, since nobody can call a credit that has run out — so the exposure
 * disappears from the note and nothing else says a word. Meanwhile 1255 still
 * carries the margin the bank held against it, restricted cash the business
 * could have back for the asking. That is real money sitting behind a register
 * row nobody is looking at.
 *
 * Severity is derived here rather than passed through, because trade-finance
 * ranks nothing — it reports a disclosure, not a queue.
 */
const EXPIRING_SOON_DAYS = 30;

const tradeFinanceSource: Source = {
  key: "trade-finance",
  label: "Guarantees and letters of credit",
  async run(ctx) {
    const c = await ctx.reads.facilities(ctx.asOf);
    const out: Raw[] = [];

    const soon = c.expiringWithin90Days;
    if (soon.length > 0) {
      const first = soon[0];
      const days = Math.floor(
        (new Date(`${first.expiresOn}T00:00:00.000Z`).getTime() - ctx.asOf.getTime()) / DAY,
      );
      out.push({
        source: "trade-finance",
        topic: "expiring",
        scope: first.reference,
        severity: days <= EXPIRING_SOON_DAYS ? "warning" : "advisory",
        title: `${plural(soon.length, "facility expires", "facilities expire")} within ninety days`,
        detail:
          `${first.reference} expires on ${first.expiresOn}, in ${plural(Math.max(days, 0), "day", "days")}, ` +
          `with ${money(first.contingentMinor, ctx.currency)} still uncalled` +
          (soon.length > 1 ? `, and ${plural(soon.length - 1, "other does", "others do")} within ninety days` : "") +
          `. Whoever asked for the guarantee will ask again on renewal, and a renewal arranged late is a gap in ` +
          `cover rather than a late piece of paperwork.`,
        href: "/accounting/trade-finance",
        itemCount: soon.length,
        amountMinor: soon.reduce((a, f) => a + f.contingentMinor, 0n),
        dueOn: first.expiresOn,
      });
    }

    if (!c.restrictedCash.agrees) {
      out.push({
        source: "trade-finance",
        topic: "margin_disagrees",
        severity: "warning",
        title: "The margin on the register does not match the margin in the ledger",
        detail:
          `The register says ${money(c.restrictedCash.marginMinor, ctx.currency)} of margin is held; account 1255 ` +
          `carries ${money(c.restrictedCash.ledgerMinor, ctx.currency)}. The difference of ` +
          `${money(c.restrictedCash.differenceMinor, ctx.currency)} is either a margin released without the ` +
          `facility being closed — in which case restricted cash is overstated and there is money to ask the bank ` +
          `for — or a posting made by hand. Both are findings; neither resolves itself.`,
        href: "/accounting/trade-finance",
        amountMinor:
          c.restrictedCash.differenceMinor < 0n
            ? -c.restrictedCash.differenceMinor
            : c.restrictedCash.differenceMinor,
      });
    }

    return out;
  },
};

/* --- customers who are late ------------------------------------------------- */

/**
 * The collections ladder, as one row rather than as a customer each.
 *
 * `dunningPlan` is a list somebody works through, and it belongs on its own
 * screen. What belongs here is the fact that the list is not empty and that a
 * particular rung is now due — because the ladder's own rule is that it never
 * restarts, so a rung skipped is a rung that cannot be gone back for.
 *
 * Rows already inside the cooling-off period are excluded. A letter sent four
 * days ago is not an outstanding action, and a queue that says otherwise
 * teaches people to send the same letter twice.
 */
const dunningSource: Source = {
  key: "dunning",
  label: "Customers who are late",
  async run(ctx) {
    const plan = await dunningPlan({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.asOf });
    const actionable = plan.rows.filter((r) => !r.suppressed);
    if (actionable.length === 0) return [];

    // Sorted worst-first by the module, so the head is the oldest debt.
    const worst = actionable[0];
    const finals = actionable.filter((r) => r.stageDue === "final");
    const total = actionable.reduce((a, r) => a + BigInt(r.pastDueMinor), 0n);

    const out: Raw[] = [{
      source: "dunning",
      topic: "letters_due",
      severity: "advisory",
      title: `${plural(actionable.length, "customer is", "customers are")} due a chase`,
      detail:
        `${money(total, plan.currency)} is past due across ` +
        `${plural(actionable.length, "customer", "customers")}. The worst is ${worst.name} at ` +
        `${money(BigInt(worst.pastDueMinor), worst.currency)}, ` +
        `${plural(worst.oldestPastDueDays, "day", "days")} old, and the rung due is the ${worst.stageDue}. ` +
        `Nothing is sent from this product — a letter reaches a customer only when a person sends it.`,
      href: "/accounting/credit-control",
      itemCount: actionable.length,
      amountMinor: total,
    }];

    if (finals.length > 0) {
      out.push({
        source: "dunning",
        topic: "final_demand_due",
        severity: "warning",
        title: `${plural(finals.length, "customer has", "customers have")} reached the final demand`,
        detail:
          `${finals.map((r) => r.name).slice(0, 3).join(", ")}${finals.length > 3 ? ", …" : ""} ` +
          `${finals.length === 1 ? "is" : "are"} at the last rung of the ladder, worth ` +
          `${money(finals.reduce((a, r) => a + BigInt(r.pastDueMinor), 0n), plan.currency)}. After this the ` +
          `decision is not which letter to send but whether to stop supplying, take it further, or write it off — ` +
          `and each of those is somebody's decision to make rather than a step in a process.`,
        href: "/accounting/credit-control",
        itemCount: finals.length,
        amountMinor: finals.reduce((a, r) => a + BigInt(r.pastDueMinor), 0n),
      });
    }

    return out;
  },
};

/**
 * Declaration order is the tie-break for display, so a row does not jump about
 * between refreshes. It runs roughly from "the books are wrong" through "a
 * deadline is coming" to "somebody has not finished something".
 */
const SOURCES: Source[] = [
  attentionSource,
  monthEndSource,
  covenantSource,
  vatSource,
  capitalAssetSource,
  chequeSource,
  tradeFinanceSource,
  inventorySource,
  deliverySource,
  dunningSource,
  subscriptionSource,
  analyticsSource,
];

/* --------------------------------------------------------------- assembly --- */

interface Bare extends Raw {
  key: string;
  order: number;
}

async function survey(ctx: Ctx): Promise<{ bare: Bare[]; sources: SourceRun[] }> {
  // allSettled, not all. One source going quiet costs its own row and nothing
  // else — see the note at the top of this file.
  const settled = await Promise.allSettled(SOURCES.map((s) => s.run(ctx)));

  const bare: Bare[] = [];
  const sources: SourceRun[] = [];

  settled.forEach((r, i) => {
    const source = SOURCES[i];
    if (r.status === "rejected") {
      const e: unknown = r.reason;
      // Only a message somebody wrote for a reader is shown. A LedgerError is
      // one by definition; anything else could be a driver or a constraint
      // name, and a work queue is not the place to leak one.
      const reason =
        e instanceof LedgerError
          ? e.message
          : e instanceof Error && /does not exist|No ledger has been opened|No accounting period|is not a month/i.test(e.message)
            ? e.message
            : "It could not be read against these books.";
      sources.push({ key: source.key, label: source.label, ok: false, rows: 1, reason });
      bare.push({
        key: keyOf({ source: "notifications", topic: "unreadable", scope: source.key }),
        order: i,
        source: "notifications",
        topic: "unreadable",
        scope: source.key,
        severity: "warning",
        title: `${source.label} could not be read`,
        detail:
          `${reason} Everything else on this page still ran. This row is a warning rather than a note because a ` +
          `source that did not answer is not a source that had nothing to say — whatever it would have reported ` +
          `is missing from the counts above, and it might have been the worst thing on the list.`,
        href: "/accounting/notifications",
      });
      return;
    }
    sources.push({ key: source.key, label: source.label, ok: true, rows: r.value.length, reason: null });
    for (const raw of r.value) bare.push({ ...raw, key: keyOf(raw), order: i });
  });

  return { bare, sources };
}

/** The ack row as the database holds it. */
type AckRow = {
  key: string;
  action: string;
  actorId: string;
  actorName: string | null;
  at: Date;
  reason: string | null;
  severity: string;
  itemCount: number | null;
  amountMinor: bigint | null;
  dueOn: Date | null;
  snoozeUntil: Date | null;
};

/**
 * Does what somebody dealt with still describe what is on the books today?
 *
 * Three ways it can stop doing so, and each is a different sentence to the
 * person reading the row back:
 *
 *   the finding got LOUDER   — a worse severity than the one they saw.
 *   the finding got BIGGER   — more things, or more money, than they saw. This
 *                              is the one that matters most in practice:
 *                              acknowledging three unreconciled bank lines is a
 *                              statement about three lines, and forty-seven is
 *                              not the thing that was acknowledged.
 *   the snooze RAN OUT       — they asked for it back today, so here it is.
 *
 * It never lapses because the finding got SMALLER or the wording changed. A
 * problem shrinking is not news, and a sentence being rewritten is not a fact
 * about the books.
 */
function stillCovers(ack: AckRow, notice: { severity: NoticeSeverity; itemCount: number | null; amountMinor: string | null }, asOf: Date): string | null {
  const was = RANK[(ack.severity as NoticeSeverity) in RANK ? (ack.severity as NoticeSeverity) : "information"];
  if (RANK[notice.severity] < was) {
    return `It was ${ack.severity} when it was dealt with and it is ${notice.severity} now.`;
  }
  if (ack.itemCount !== null && notice.itemCount !== null && notice.itemCount > ack.itemCount) {
    return `It covered ${ack.itemCount} when it was dealt with and covers ${notice.itemCount} now.`;
  }
  if (ack.amountMinor !== null && notice.amountMinor !== null) {
    const now = BigInt(notice.amountMinor);
    const then = ack.amountMinor;
    const abs = (v: bigint) => (v < 0n ? -v : v);
    if (abs(now) > abs(then)) {
      return `It was worth ${abs(then)} when it was dealt with and is worth ${abs(now)} now.`;
    }
  }
  if (ack.snoozeUntil !== null && asOf >= ack.snoozeUntil) {
    return `It was snoozed until ${isoDay(ack.snoozeUntil)}, which has come.`;
  }
  return null;
}

/** What may be done to a row, and the sentence that says why not. */
function permissions(n: { severity: NoticeSeverity; dueOn: string | null; statutory: boolean }, asOf: Date) {
  const blocker = n.severity === "blocker";
  const mayAcknowledgeBecause = blocker
    ? "A blocker cannot be acknowledged away. Something wrong now, or a deadline already gone, does not stop " +
      "being either because somebody has seen it — it can be put off until a stated day, and it comes back on " +
      "that day."
    : null;

  const limits: { on: Date; because: string }[] = [];
  if (n.dueOn) {
    // Back one day from the deadline, not to it: a row that returns on the
    // morning it is due has been snoozed past the point of being useful.
    limits.push({
      on: new Date(day(n.dueOn).getTime() - DAY),
      because: n.statutory
        ? `It is due on ${n.dueOn} under UAE law, so a snooze has to end before then — this list will not put a ` +
          `statutory deadline out of sight up to the day it lands.`
        : `It is due on ${n.dueOn}, so a snooze has to end before then.`,
    });
  }
  limits.push({
    on: new Date(asOf.getTime() + (blocker ? MAX_BLOCKER_SNOOZE_DAYS : MAX_SNOOZE_DAYS) * DAY),
    because: blocker
      ? `It is a blocker, so it can be put off by at most ${MAX_BLOCKER_SNOOZE_DAYS} days. Longer than that and ` +
        `"it cannot be acknowledged" would be a formality anybody could step round.`
      : `Nothing is put off by more than ${MAX_SNOOZE_DAYS} days. Past a month somebody has made a decision ` +
        `rather than postponed one, and a decision is recorded as an acknowledgement with a reason.`,
  });

  const tightest = limits.reduce((a, b) => (b.on < a.on ? b : a));
  const reachable = tightest.on > asOf;

  return {
    mayAcknowledge: !blocker,
    mayAcknowledgeBecause,
    snoozeLimit: reachable ? isoDay(tightest.on) : null,
    snoozeLimitBecause: reachable
      ? tightest.because
      : `${tightest.because} There is no day left between today and that, so it cannot be put off at all.`,
  };
}

function assemble(ctx: Ctx, bare: Bare[], sources: SourceRun[], acks: AckRow[]): NotificationCentre {
  const byKey = new Map(acks.map((a) => [a.key, a]));

  const notices: Notice[] = bare.map((b) => {
    const itemCount = b.itemCount ?? null;
    const amountMinor = b.amountMinor === undefined ? null : b.amountMinor.toString();
    const dueOn = b.dueOn ?? null;
    const statutory = b.statutory ?? false;
    const base = { severity: b.severity, itemCount, amountMinor };

    const ack = byKey.get(b.key);
    let state: NoticeState = "open";
    let returnedBecause: string | null = null;
    let dealtWith: DealtWith | null = null;

    if (ack) {
      dealtWith = {
        action: ack.action === "snoozed" ? "snoozed" : "acknowledged",
        actorId: ack.actorId,
        actorName: ack.actorName,
        at: ack.at.toISOString(),
        reason: ack.reason,
        severity: (ack.severity as NoticeSeverity) in RANK ? (ack.severity as NoticeSeverity) : "information",
        itemCount: ack.itemCount,
        amountMinor: ack.amountMinor === null ? null : ack.amountMinor.toString(),
        snoozeUntil: ack.snoozeUntil === null ? null : isoDay(ack.snoozeUntil),
      };
      const lapsed = stillCovers(ack, base, ctx.asOf);
      state = lapsed ? "returned" : ack.action === "snoozed" ? "snoozed" : "acknowledged";
      returnedBecause = lapsed;
    }

    const outstanding = state === "open" || state === "returned";

    return {
      key: b.key,
      source: b.source,
      topic: b.topic,
      scope: b.scope ?? null,
      severity: b.severity,
      title: b.title,
      detail: b.detail,
      href: b.href,
      itemCount,
      amountMinor,
      dueOn,
      daysToDue: dueOn === null ? null : daysBetween(ctx.asOf, day(dueOn)),
      statutory,
      state,
      outstanding,
      dealtWith,
      returnedBecause,
      ...permissions({ severity: b.severity, dueOn, statutory }, ctx.asOf),
    };
  });

  /**
   * Outstanding work first, then severity, then the deadline, then declaration
   * order. The deadline only ever breaks a tie WITHIN a severity: a row with a
   * date never jumps a row that is more serious than it, because "soonest
   * first" across severities is how a stock reorder gets read before an
   * unbalanced trial balance.
   */
  const order = new Map(bare.map((b, i) => [b.key, i]));
  notices.sort((a, b) => {
    if (a.outstanding !== b.outstanding) return a.outstanding ? -1 : 1;
    if (RANK[a.severity] !== RANK[b.severity]) return RANK[a.severity] - RANK[b.severity];
    if (a.dueOn !== b.dueOn) {
      if (a.dueOn === null) return 1;
      if (b.dueOn === null) return -1;
      return a.dueOn < b.dueOn ? -1 : 1;
    }
    return (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0) || a.key.localeCompare(b.key);
  });

  const open = notices.filter((n) => n.outstanding);
  const dated = (n: Notice): n is Notice & { dueOn: string; daysToDue: number } => n.dueOn !== null;
  const asDeadline = (n: Notice & { dueOn: string; daysToDue: number }): DigestDeadline => ({
    key: n.key,
    title: n.title,
    severity: n.severity,
    dueOn: n.dueOn,
    daysToDue: n.daysToDue,
    statutory: n.statutory,
  });

  const digest: Digest = {
    counts: {
      blocker: open.filter((n) => n.severity === "blocker").length,
      warning: open.filter((n) => n.severity === "warning").length,
      advisory: open.filter((n) => n.severity === "advisory").length,
      information: open.filter((n) => n.severity === "information").length,
    },
    outstanding: open.length,
    acknowledged: notices.filter((n) => n.state === "acknowledged").length,
    snoozed: notices.filter((n) => n.state === "snoozed").length,
    returned: notices.filter((n) => n.state === "returned").length,
    dueWithinDays: DUE_SOON_DAYS,
    dueSoon: open
      .filter(dated)
      .filter((n) => n.daysToDue >= 0 && n.daysToDue <= DUE_SOON_DAYS)
      .sort((a, b) => a.daysToDue - b.daysToDue)
      .map(asDeadline),
    overdue: open
      .filter(dated)
      .filter((n) => n.daysToDue < 0)
      .sort((a, b) => a.daysToDue - b.daysToDue)
      .map(asDeadline),
    snoozedUntil: notices
      .filter((n) => n.state === "snoozed" && n.dealtWith?.snoozeUntil)
      .map((n) => ({
        key: n.key,
        title: n.title,
        severity: n.severity,
        until: n.dealtWith!.snoozeUntil!,
        daysToReturn: daysBetween(ctx.asOf, day(n.dealtWith!.snoozeUntil!)),
        by: n.dealtWith!.actorName ?? n.dealtWith!.actorId,
      }))
      .sort((a, b) => a.daysToReturn - b.daysToReturn),
  };

  return { entityId: ctx.entityId, asOf: isoDay(ctx.asOf), currency: ctx.currency, notices, sources, digest };
}

async function context(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date | string;
  reads?: SharedReads;
}): Promise<Ctx> {
  const asOf = asDate(opts.asOf, "The date the notifications are read as at");
  // The book is read for its currency alone, and its absence is not a finding:
  // an entity with no ledger open has nothing to say, and every source that
  // needs the book will say so on its own row.
  const currency = await prisma.book
    .findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
      select: { functionalCurrency: true },
    })
    .then((b) => b?.functionalCurrency ?? "AED")
    .catch(() => "AED");
  return {
    orgId: opts.orgId,
    entityId: opts.entityId,
    asOf,
    currency,
    reads: opts.reads ?? sharedReads({ orgId: opts.orgId, entityId: opts.entityId }),
  };
}

function readAcks(ctx: Ctx): Promise<AckRow[]> {
  return prisma.notificationAck.findMany({
    where: { orgId: ctx.orgId, entityId: ctx.entityId },
    select: {
      key: true, action: true, actorId: true, actorName: true, at: true, reason: true,
      severity: true, itemCount: true, amountMinor: true, dueOn: true, snoozeUntil: true,
    },
  });
}

/* ------------------------------------------------------------------ reads --- */

/**
 * Everything, ranked, with what has been dealt with remembered.
 *
 * `asOf` is accepted so a queue can be reproduced: "we were told this on the
 * 3rd" is a question people ask about a nag list, and a screen that can only
 * ever show today cannot answer it.
 */
export async function notificationCentre(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date | string;
  /**
   * The reads to make the twelve sources go through. Left out, this page makes
   * its own set and they are shared across the sources and nothing else, which
   * is what every caller in the product wants. It is a parameter so that what
   * the sources actually ask for can be observed from outside.
   */
  reads?: SharedReads;
}): Promise<NotificationCentre> {
  return (await read(await context(opts))).centre;
}

/**
 * The queue, with the survey behind it kept in hand.
 *
 * Acknowledging and snoozing both have to read the queue twice: once to find
 * the row being acted on and refuse an act that does not apply to it, and once
 * afterwards to hand back the queue with the act in it. Taken literally that is
 * the whole twelve-source fan-out run twice for one click — every ageing, every
 * register, the audit sweep, all of it — when the two reads cannot differ by
 * anything except the acknowledgement just written. Nothing else has changed in
 * between: the act writes one row of one table and touches no ledger.
 *
 * So the survey is made once and only the acks are read again over it.
 * `assemble` is a pure function of the two, which is what makes this safe to
 * say rather than merely fast.
 */
async function read(ctx: Ctx): Promise<{ centre: NotificationCentre; bare: Bare[]; sources: SourceRun[] }> {
  const [{ bare, sources }, acks] = await Promise.all([survey(ctx), readAcks(ctx)]);
  return { centre: assemble(ctx, bare, sources, acks), bare, sources };
}

/** Every act on one notification, oldest first. Why a row went quiet, and who. */
export async function notificationHistory(opts: {
  orgId: string;
  entityId: string;
  key: string;
}): Promise<{
  key: string;
  events: {
    action: string;
    actorId: string;
    actorName: string | null;
    at: string;
    reason: string | null;
    severity: string | null;
    itemCount: number | null;
    amountMinor: string | null;
    snoozeUntil: string | null;
  }[];
}> {
  const rows = await prisma.notificationEvent.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, key: opts.key },
    orderBy: { at: "asc" },
  });
  return {
    key: opts.key,
    events: rows.map((e) => ({
      action: e.action,
      actorId: e.actorId,
      actorName: e.actorName,
      at: e.at.toISOString(),
      reason: e.reason,
      severity: e.severity,
      itemCount: e.itemCount,
      amountMinor: e.amountMinor === null ? null : e.amountMinor.toString(),
      snoozeUntil: e.snoozeUntil === null ? null : isoDay(e.snoozeUntil),
    })),
  };
}

/* ----------------------------------------------------------------- writes --- */

interface Act {
  orgId: string;
  entityId: string;
  key: string;
  actorId: string;
  /** Written down beside the id so the row still reads as English after somebody leaves. */
  actorName?: string;
  reason?: string;
  asOf?: Date | string;
}

/**
 * The name to write beside the id.
 *
 * Recorded rather than joined at read time on purpose: an acknowledgement is a
 * statement somebody made on a day, and it should still say who made it after
 * the account is closed and the row is gone.
 */
async function nameOf(actorId: string, given?: string): Promise<string | null> {
  if (given) return given;
  return prisma.user
    .findUnique({ where: { id: actorId }, select: { name: true } })
    .then((u) => u?.name ?? null)
    .catch(() => null);
}

/** The notice this act is about, refused rather than guessed at if it is not there. */
function locate(centre: NotificationCentre, key: string): Notice {
  const notice = centre.notices.find((n) => n.key === key);
  if (!notice) {
    throw new LedgerError(
      `Nothing on this list is "${key}" as at ${centre.asOf}. A notification can only be acted on while it is ` +
        `there — the list is worked out fresh on every read, so a row that has gone is a thing that has been ` +
        `fixed, and there is nothing left to acknowledge.`,
    );
  }
  return notice;
}

async function record(ctx: Ctx, notice: Notice, act: Act, action: "acknowledged" | "snoozed", snoozeUntil: Date | null) {
  const actorName = await nameOf(act.actorId, act.actorName);
  const shape = {
    action,
    actorId: act.actorId,
    actorName,
    at: new Date(),
    reason: act.reason?.trim() || null,
    severity: notice.severity,
    itemCount: notice.itemCount,
    amountMinor: notice.amountMinor === null ? null : BigInt(notice.amountMinor),
    snoozeUntil,
  };

  await prisma.$transaction([
    prisma.notificationAck.upsert({
      where: { orgId_entityId_key: { orgId: ctx.orgId, entityId: ctx.entityId, key: notice.key } },
      create: {
        orgId: ctx.orgId, entityId: ctx.entityId, key: notice.key,
        dueOn: notice.dueOn === null ? null : day(notice.dueOn),
        ...shape,
      },
      update: { ...shape, dueOn: notice.dueOn === null ? null : day(notice.dueOn) },
    }),
    // The ack row holds the current position and is overwritten; the event log
    // is appended and never is. Without it, "why did this stop showing?" has no
    // answer once somebody acknowledges over a snooze.
    prisma.notificationEvent.create({
      data: { orgId: ctx.orgId, entityId: ctx.entityId, key: notice.key, ...shape },
    }),
  ]);
}

/**
 * Somebody has seen this and says so.
 *
 * It stays on the dealt-with list rather than disappearing, and it comes back
 * on its own the moment the finding gets worse than the one they saw — see
 * `stillCovers`. A blocker cannot be acknowledged at all: something wrong now,
 * or a statutory deadline already gone, does not stop being either because
 * somebody has read about it.
 */
export async function acknowledge(act: Act): Promise<NotificationCentre> {
  const ctx = await context(act);
  const { centre, bare, sources } = await read(ctx);
  const notice = locate(centre, act.key);

  if (!notice.mayAcknowledge) {
    throw new LedgerError(`${notice.title}: ${notice.mayAcknowledgeBecause}`);
  }

  await record(ctx, notice, act, "acknowledged", null);
  return assemble(ctx, bare, sources, await readAcks(ctx));
}

/**
 * Put it off until a stated day, after which it comes back on its own.
 *
 * Three things are refused, and each of them is the same principle: a
 * notification may be deferred, never disposed of.
 *
 *  - A day that has already been, or today. A snooze that has already expired
 *    is not a snooze; a snooze until today is a click that did nothing.
 *  - A day at or past the finding's own deadline. This is the important one.
 *    Something with a statutory date behind it must be back in front of
 *    somebody BEFORE the date, or the snooze is simply a way to miss it — so
 *    the request is refused, with the deadline named, rather than quietly
 *    trimmed to something the caller did not ask for. The database keeps the
 *    same rule independently, in `NotificationAck_snooze_before_due_check`,
 *    because a rule the application alone enforces is a rule an import or a
 *    future module can walk straight through.
 *  - A day past the outside edge: thirty days for anything, seven for a
 *    blocker.
 */
export async function snooze(act: Act & { until: Date | string }): Promise<NotificationCentre> {
  const ctx = await context(act);
  const until = asDate(act.until, "The day to bring it back");
  const untilDay = day(isoDay(until));
  const { centre, bare, sources } = await read(ctx);
  const notice = locate(centre, act.key);

  if (untilDay <= ctx.asOf) {
    throw new LedgerError(
      `${isoDay(untilDay)} is not in the future as at ${centre.asOf}. A snooze names the day something comes ` +
        `back, so it has to be a day that has not come yet.`,
    );
  }

  if (notice.dueOn !== null && untilDay >= day(notice.dueOn)) {
    throw new LedgerError(
      `${notice.title} is due on ${notice.dueOn}` +
        (notice.statutory ? ", a deadline set by law" : "") +
        `, and this would hold it until ${isoDay(untilDay)} — on or past the day it is due. Nothing here may be ` +
        `put out of sight up to its own deadline: choose a day before ${notice.dueOn}, or acknowledge it and say ` +
        `why it is being left.`,
    );
  }

  if (notice.snoozeLimit === null || untilDay > day(notice.snoozeLimit)) {
    throw new LedgerError(
      `${notice.title} cannot be held until ${isoDay(untilDay)}. ${notice.snoozeLimitBecause}` +
        (notice.snoozeLimit === null ? "" : ` The latest it can be held to is ${notice.snoozeLimit}.`),
    );
  }

  await record(ctx, notice, act, "snoozed", untilDay);
  return assemble(ctx, bare, sources, await readAcks(ctx));
}

/**
 * Take the acknowledgement or the snooze off and put the row back on the queue.
 *
 * The ack row goes; the event log does not, so the history still says who had
 * dealt with it and who changed their mind.
 */
export async function bringBack(act: Act): Promise<NotificationCentre> {
  const ctx = await context(act);
  const existing = await prisma.notificationAck.findUnique({
    where: { orgId_entityId_key: { orgId: ctx.orgId, entityId: ctx.entityId, key: act.key } },
  });
  if (!existing) {
    throw new LedgerError(`"${act.key}" has not been acknowledged or snoozed, so there is nothing to undo.`);
  }

  const actorName = await nameOf(act.actorId, act.actorName);
  await prisma.$transaction([
    prisma.notificationAck.delete({
      where: { orgId_entityId_key: { orgId: ctx.orgId, entityId: ctx.entityId, key: act.key } },
    }),
    prisma.notificationEvent.create({
      data: {
        orgId: ctx.orgId, entityId: ctx.entityId, key: act.key,
        action: "cleared", actorId: act.actorId, actorName, at: new Date(),
        reason: act.reason?.trim() || null,
        severity: existing.severity, itemCount: existing.itemCount, amountMinor: existing.amountMinor,
        snoozeUntil: null,
      },
    }),
  ]);

  return (await read(ctx)).centre;
}
