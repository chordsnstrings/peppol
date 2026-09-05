import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { LedgerError } from "./post";
import { receivablesAgeing } from "./ar";
import { payablesAgeing } from "./ap";
import { reconciliationSummary } from "./bank";
import {
  vatReturn,
  registrationThreshold,
  MANDATORY_REGISTRATION_THRESHOLD_MINOR,
  VOLUNTARY_REGISTRATION_THRESHOLD_MINOR,
  REGISTRATION_APPLICATION_DAYS,
  REGISTRATION_LOOKBACK_YEARS,
} from "./vat";
import { lastCompletedPeriod } from "./tax-periods";
import { templateStatus } from "./recurring";
import { assetRegister } from "./assets";
import { claimSummary } from "./expenses";
import { grniReport } from "./procurement";
import { trialBalance } from "./reports";
// Neither of these is read by a check on this list. They are here because the
// shared reads below are what stops the month-end checklist and the
// notification centre from reading them twice on one page, and the object that
// holds them has to live in the module the other two both import.
import { contractRegister } from "./revenue";
import { contingentLiabilities } from "./trade-finance";

/**
 * What is waiting for somebody, read out of the books rather than out of a
 * list of chores.
 *
 * Three decisions carry this module.
 *
 * The first is that nothing here is stored. A "needs attention" table that is
 * written when something goes wrong and cleared when somebody remembers is a
 * table that lies within a week: the invoice gets paid and the nag stays, the
 * period gets closed and the nag stays, and after the third stale row nobody
 * reads the screen again. Every finding below is recomputed from the ledger on
 * every request, so a finding disappears the moment the thing that caused it is
 * fixed — which is the only property that makes a nag list worth opening.
 *
 * The second is that each check calls the module that already owns the fact.
 * The overdue figure comes from the ageing report the collections screen shows,
 * the unreconciled lines from the reconciliation statement, the missed accruals
 * from the recurring-journal status. If this module derived any of them a
 * second way it would eventually disagree with the screen it links to, and a
 * dashboard that disagrees with the page it sends you to is worse than no
 * dashboard.
 *
 * The third is that the checks fail independently. They are run through
 * `Promise.allSettled` and one rejection degrades one row: an entity whose
 * books were never opened has no receivables control account, a chart edited by
 * hand can be missing an account a report needs, and a table can be absent
 * mid-migration. Any of those throws — and the honest response is to say which
 * check could not run while still showing the eight that did. A single
 * `Promise.all` here would turn one missing account into a blank page, which is
 * the failure mode where somebody misses a VAT deadline because the screen that
 * would have told them showed nothing at all.
 *
 * Two facts this module needs are not in the ledger, and both are derived
 * rather than invented:
 *
 *  - A document's own due date is used where it has one. Where it has none the
 *    term falls back to `TERM_DAYS` from the document date — the same 30 days
 *    `invoice-build.ts` puts on every invoice it raises. The distinction is not
 *    cosmetic: a customer genuinely on sixty days, chased from the thirty-first,
 *    learns that this list is wrong, and a list somebody has learned to ignore
 *    is worse than no list.
 *  - Nothing records that a VAT return was filed, by design: filing happens at
 *    the FTA, not here. What the books do carry is the period lock, which the
 *    periods screen describes as the thing "that lets a filed return stay
 *    true". So a quarter whose months are hard-closed or locked is treated as
 *    filed, and one still open or soft-closed is treated as outstanding. That
 *    is an inference, and it is stated on the screen as one.
 */

export type Severity = "urgent" | "soon" | "note";

export interface Finding {
  /** Stable across runs, so a row can be linked to and tested for. */
  key: string;
  severity: Severity;
  title: string;
  /** A sentence a bookkeeper can act on without opening anything else. */
  detail: string;
  /** How many things this finding covers, where a count means something. */
  count?: number;
  /** Minor units, as a string — the wire never carries a ledger amount as a number. */
  amountMinor?: string;
  /** The screen where the work actually gets done. */
  href: string;
  /**
   * The day it has to be done by, where the check knows one. Never invented: a
   * deadline this list made up is how a queue teaches people that its dates
   * mean nothing.
   */
  dueOn?: string;
  /** True where that deadline is set by law rather than by terms or by habit. */
  statutory?: boolean;
}

/** A check that could not run, named rather than silently dropped. */
export interface FailedCheck {
  key: string;
  label: string;
  reason: string;
}

export interface AttentionList {
  entityId: string;
  asOf: string;
  currency: string;
  /** Urgent first, then soon, then note; stable order within a severity. */
  findings: Finding[];
  failed: FailedCheck[];
  counts: { urgent: number; soon: number; note: number };
  /** How many checks were attempted, so "nothing found" can be trusted. */
  checked: number;
}

/**
 * The payment terms the ledger cannot see.
 *
 * `invoice-build.ts` dates every invoice thirty days out unless the caller says
 * otherwise, so thirty days is the term this product applies. It is a constant
 * rather than a per-document field because the journal entry deliberately does
 * not carry the document — see the note at the top of `ar.ts`.
 */
const TERM_DAYS = 30;

/**
 * When a document falls due, relative to the date the list is being read at:
 * negative is overdue, nought is today, positive is the days remaining.
 *
 * The document's own due date wins; TERM_DAYS is only the fallback for one
 * raised before terms reached the ledger.
 */
function dueIn(o: { date: string; dueDate: string | null }, asOf: Date): number {
  const due = o.dueDate
    ? new Date(`${o.dueDate}T00:00:00Z`)
    : new Date(new Date(`${o.date}T00:00:00Z`).getTime() + TERM_DAYS * 86_400_000);
  return Math.floor((due.getTime() - asOf.getTime()) / 86_400_000);
}

/** "Due soon" is the week ahead. Longer and everything is always on the list. */
const DUE_SOON_DAYS = 7;

/** The FTA gives 28 days after the end of a tax period to file and pay. */
const VAT_FILING_DAYS = 28;

/** Past this many days beyond terms, a debt stops being late and starts being a problem. */
const BADLY_OVERDUE_DAYS = 60;

const DAY = 86_400_000;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const monthLabel = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY);

function asDate(v: Date | string | undefined): Date {
  if (v === undefined) return new Date();
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError("The attention list needs a valid date to be read as at.");
  return d;
}

/**
 * Minor units inside a sentence.
 *
 * Always the magnitude, never parenthesised: parentheses are how a *numeral*
 * carries a negative, and prose says the direction in words instead. The
 * formatting comes from `fmtMinor` so a three-decimal currency reads correctly
 * here and on the screen alike.
 */
function money(minor: bigint, currency: string): string {
  return `${currency} ${fmtMinor(minor < 0n ? -minor : minor, currency, { zero: "zero" })}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------- the shared reads --- */

/**
 * The reads this list, the month-end checklist and the notification centre make
 * in common, made once.
 *
 * The notification centre fans out to twelve sources; two of them are this
 * module and the checklist, and every source calls the module that already owns
 * its fact. That rule is right, and it was costing one page load the same tax
 * period looked up three times, the same quarter's VAT return computed twice,
 * and the revenue register read twice inside the checklist alone. Each of those
 * reads was made from inside a different check of a different module, so
 * nothing could see the duplication — which is exactly why the answer is not a
 * cache inside each of them. The duplication was always ACROSS them.
 *
 * So the checks still call the module that owns the fact, and the call goes
 * through this object: one of them for the life of one request, holding the
 * promise of each read against the arguments it was made with. A second caller
 * asking the same question waits on the first read instead of starting another.
 *
 * A caller asking with different arguments gets its own read, and that is a
 * decision rather than a shortcoming. The receivables ageing at today and the
 * receivables ageing at a month end are two different facts; answering one with
 * the other would make the checklist agree with the dashboard by being wrong.
 * So the ageings, the reconciliations and the guarantee register are still read
 * once per date they are asked about — what has gone is asking the same date
 * twice.
 *
 * Nothing is remembered beyond the request. There is no invalidation to get
 * wrong because the object is gone before anything can change under it, which
 * is what lets this list keep its promise that every row is a live fact about
 * the books.
 *
 * A read that rejects is shared exactly as one that resolves. Every caller runs
 * its checks under `allSettled`, so a failing read costs the rows that needed
 * it and nothing else — the behaviour each module already had when it made the
 * failing call itself.
 */
export interface SharedReads {
  trialBalance(periodLabel: string): Promise<Awaited<ReturnType<typeof trialBalance>>>;
  receivables(asOf: Date): Promise<Awaited<ReturnType<typeof receivablesAgeing>>>;
  payables(asOf: Date): Promise<Awaited<ReturnType<typeof payablesAgeing>>>;
  /**
   * The reconciliation figures for one bank account, and none of its items.
   *
   * Both callers of this ask how many statement lines are unexplained and how
   * old the oldest is, which the figures answer exactly; the itemised statement
   * lists the oldest two hundred of each kind, so counting its rows caps the
   * answer at the page size and reports the cap as a total.
   */
  reconciliation(accountCode: string, asOf: Date): Promise<Awaited<ReturnType<typeof reconciliationSummary>>>;
  /** The last tax period that has ended, on the registration's own stagger. */
  vatPeriod(asOf: Date): Promise<Awaited<ReturnType<typeof lastCompletedPeriod>>>;
  vatReturn(from: string, to: string): Promise<Awaited<ReturnType<typeof vatReturn>>>;
  /** The recurring templates, judged against a month label. */
  templates(month: string): Promise<Awaited<ReturnType<typeof templateStatus>>>;
  /** The fixed asset register; without a date, as it stands. */
  assets(asOf?: Date): Promise<Awaited<ReturnType<typeof assetRegister>>>;
  contracts(): Promise<Awaited<ReturnType<typeof contractRegister>>>;
  /** Guarantees and letters of credit, and the margin held against them. */
  facilities(asOf: Date): Promise<Awaited<ReturnType<typeof contingentLiabilities>>>;
}

export function sharedReads(scope: { orgId: string; entityId: string }): SharedReads {
  const inFlight = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const running = inFlight.get(key);
    if (running) return running as Promise<T>;
    const started = read();
    inFlight.set(key, started);
    return started;
  };
  // The day is the whole of what distinguishes two reads of the same report, so
  // it is the whole of the key. "-" is a date nobody asked for, which is a
  // different question from any date somebody did.
  const at = (d?: Date) => (d ? isoDay(d) : "-");

  return {
    trialBalance: (periodLabel) => once(`trial-balance:${periodLabel}`, () => trialBalance({ ...scope, periodLabel })),
    receivables: (asOf) => once(`receivables:${at(asOf)}`, () => receivablesAgeing({ ...scope, asOf })),
    payables: (asOf) => once(`payables:${at(asOf)}`, () => payablesAgeing({ ...scope, asOf })),
    reconciliation: (accountCode, asOf) =>
      once(`bank:${accountCode}:${at(asOf)}`, () => reconciliationSummary({ ...scope, accountCode, asOf })),
    vatPeriod: (asOf) => once(`vat-period:${at(asOf)}`, () => lastCompletedPeriod({ ...scope, regime: "VAT", asOf })),
    vatReturn: (from, to) => once(`vat-return:${from}:${to}`, () => vatReturn({ ...scope, from, to })),
    templates: (month) => once(`recurring:${month}`, () => templateStatus({ ...scope, asOf: month })),
    assets: (asOf) => once(`assets:${at(asOf)}`, () => assetRegister({ ...scope, ...(asOf ? { asOf } : {}) })),
    contracts: () => once("contracts", () => contractRegister(scope)),
    facilities: (asOf) => once(`facilities:${at(asOf)}`, () => contingentLiabilities({ ...scope, asOf })),
  };
}

interface Ctx {
  orgId: string;
  entityId: string;
  asOf: Date;
  currency: string;
  /** Every report a check reads goes through this. See `SharedReads` above. */
  reads: SharedReads;
}

interface Check {
  key: string;
  /** What this check looks at, for the row that says it could not run. */
  label: string;
  run: (ctx: Ctx) => Promise<Finding | null>;
}

/* ------------------------------------------------------------- the checks --- */

/**
 * The trial balance not balancing is impossible: `post()` refuses an unbalanced
 * entry and the balances are anchored per period. So if it ever appears, the
 * cause is outside the posting path — a hand-edited row, a partially applied
 * migration, a restore from the wrong backup — and every other figure in the
 * product is suspect until it is explained. Nothing else on this list outranks
 * it.
 */
const trialBalanceCheck: Check = {
  key: "trial_balance",
  label: "The trial balance",
  async run({ orgId, entityId, asOf, currency, reads }) {
    const period =
      (await prisma.accountingPeriod.findFirst({
        where: { orgId, entityId, isAdjustment: false, startsOn: { lte: asOf }, endsOn: { gte: asOf } },
      })) ??
      (await prisma.accountingPeriod.findFirst({
        where: { orgId, entityId, isAdjustment: false, startsOn: { lte: asOf } },
        orderBy: { startsOn: "desc" },
      }));
    if (!period) return null;

    const tb = await reads.trialBalance(period.label);
    if (tb.balanced) return null;

    return {
      key: "trial_balance",
      severity: "urgent",
      title: "The trial balance does not balance",
      detail:
        `As at ${period.label} the debits and the credits differ by ${money(tb.differenceMinor, currency)}. ` +
        `Posting cannot produce this — an unbalanced entry is refused — so the difference came from outside the ` +
        `posting path. Every statement, return and ratio in the product is built on these totals, so treat ` +
        `everything else as unreliable until this is explained.`,
      amountMinor: tb.differenceMinor.toString(),
      href: "/accounting/trial-balance",
    };
  },
};

const overdueReceivables: Check = {
  key: "ar_overdue",
  label: "Overdue receivables",
  async run({ asOf, currency, reads }) {
    const ageing = await reads.receivables(asOf);
    // Positive only: a credit note sits in the same ageing as a negative open
    // item, and netting it into "what customers owe" would understate the
    // chase list rather than the balance.
    const overdue = ageing.open.filter((o) => dueIn(o, asOf) < 0 && BigInt(o.outstandingMinor) > 0n);
    if (overdue.length === 0) return null;

    // `open` is already sorted oldest first, so the worst offender is the head.
    const worst = overdue[0];
    const total = overdue.reduce((a, o) => a + BigInt(o.outstandingMinor), 0n);
    const pastDue = -dueIn(worst, asOf);

    return {
      key: "ar_overdue",
      severity: pastDue > BADLY_OVERDUE_DAYS ? "urgent" : "soon",
      title: "Customers are past their payment terms",
      detail:
        `${plural(overdue.length, "invoice is", "invoices are")} past their payment terms, ` +
        `${money(total, currency)} in total. The worst is ${worst.memo || worst.sourceId}: ` +
        `${money(BigInt(worst.outstandingMinor), currency)}, raised ${worst.date}, ` +
        `${plural(pastDue, "day", "days")} past due.`,
      count: overdue.length,
      amountMinor: total.toString(),
      href: "/accounting/receivables",
    };
  },
};

const payablesDueSoon: Check = {
  key: "ap_due_soon",
  label: "Payables falling due",
  async run({ asOf, currency, reads }) {
    const ageing = await reads.payables(asOf);
    const window = ageing.open.filter((o) => {
      const days = dueIn(o, asOf);
      return BigInt(o.outstandingMinor) > 0n && days >= 0 && days <= DUE_SOON_DAYS;
    });
    if (window.length === 0) return null;

    const total = window.reduce((a, o) => a + BigInt(o.outstandingMinor), 0n);
    // The list is ordered by age; what matters here is which falls due first.
    const soonest = [...window].sort((a, b) => dueIn(a, asOf) - dueIn(b, asOf))[0];

    return {
      key: "ap_due_soon",
      severity: "soon",
      title: "Supplier bills fall due this week",
      detail:
        `${plural(window.length, "bill", "bills")} worth ${money(total, currency)} ` +
        `${window.length === 1 ? "falls" : "fall"} due within the next ` +
        `${DUE_SOON_DAYS} days. The nearest is ${soonest.memo || soonest.sourceId}, raised ${soonest.date}` +
        `${soonest.dueDate ? ` and due ${soonest.dueDate}` : ""}. ` +
        `Pay ${window.length === 1 ? "it" : "them"} or agree new terms before ` +
        `${window.length === 1 ? "it ages" : "they age"}.`,
      count: window.length,
      amountMinor: total.toString(),
      href: "/accounting/payables",
    };
  },
};

const unreconciledBank: Check = {
  key: "bank_unmatched",
  label: "Unreconciled bank lines",
  async run({ orgId, entityId, asOf, currency, reads }) {
    // Only the accounts that actually carry an unmatched line are reconciled.
    // A reconciliation reads every journal line on its account, so running one
    // per bank account on a dashboard would cost the whole cash ledger to
    // discover that there is nothing to say.
    const accountIds = await prisma.bankStatementLine.findMany({
      where: { orgId, entityId, status: "unmatched", postedOn: { lte: asOf } },
      select: { accountId: true },
      distinct: ["accountId"],
    });
    if (accountIds.length === 0) return null;

    const accounts = await prisma.account.findMany({
      where: { id: { in: accountIds.map((a) => a.accountId) } },
      select: { code: true },
      orderBy: { code: "asc" },
    });

    // The figures, not the statement. Counting the rows of a reconciliation
    // counted the two hundred it itemises rather than the lines there are, so
    // an account with four hundred unexplained lines said two hundred — a page
    // size presented to a bookkeeper as a total.
    const statements = await Promise.all(accounts.map((a) => reads.reconciliation(a.code, asOf)));

    const unmatched = statements.reduce((a, s) => a + s.unmatchedBankCount, 0);
    if (unmatched === 0) return null;

    const net = statements.reduce((a, s) => a + BigInt(s.unrecordedInBankMinor), 0n);
    // The date and its age travel together, because the age is only meaningful
    // for the account the date came from. A count above nil always has a date
    // behind it — both come out of the same filter — but it is still read as
    // one that may be absent, since a sentence about "the oldest" of nothing
    // would be worse than no sentence.
    const oldest = statements.reduce<{ on: string; age: number } | null>((a, s) => {
      const on = s.oldestUnmatchedBankOn;
      if (on === null || (a !== null && a.on <= on)) return a;
      return { on, age: daysBetween(new Date(on), asOf) };
    }, null);

    return {
      key: "bank_unmatched",
      severity: oldest !== null && oldest.age > TERM_DAYS ? "soon" : "note",
      title: "Bank lines have no entry behind them",
      detail:
        `${plural(unmatched, "statement line", "statement lines")} on ` +
        `${plural(accounts.length, "account", "accounts")} ${unmatched === 1 ? "has" : "have"} not been ` +
        `matched to anything in the ledger, ` +
        `a net ${money(net, currency)}.` +
        (oldest === null
          ? ""
          : ` The oldest has been sitting since ${oldest.on}, ${plural(oldest.age, "day", "days")} ago.`) +
        ` Until they are matched or posted, the cash balance is a guess.`,
      count: unmatched,
      amountMinor: net.toString(),
      href: "/accounting/bank",
    };
  },
};

const vatReturnOutstanding: Check = {
  key: "vat_return",
  label: "The VAT return",
  async run({ orgId, entityId, asOf, currency, reads }) {
    // The FTA's own period, not the calendar's. This used to be
    // `Math.floor(month / 3)` here and in two other modules, which told a
    // taxpayer on the February stagger what was payable for the wrong three
    // months against a due date a month late — from the check whose entire
    // purpose is stopping somebody missing a VAT deadline.
    const period = await reads.vatPeriod(asOf);
    const quarter = {
      from: new Date(`${period.from}T00:00:00.000Z`),
      to: new Date(`${period.to}T00:00:00.000Z`),
      label: period.label,
    };
    const ret = await reads.vatReturn(period.from, period.to);

    // A quarter with no VAT either way has nothing to file from these books. A
    // registered person may still owe a nil return, but nagging an entity that
    // did not trade would make this list noise, and noise is how a nag list
    // stops being read.
    const activity = BigInt(ret.totalOutputVatMinor) !== 0n || BigInt(ret.totalInputVatMinor) !== 0n;
    if (!activity) return null;

    const periods = await prisma.accountingPeriod.findFirst({
      where: {
        orgId,
        entityId,
        isAdjustment: false,
        startsOn: { lte: quarter.to },
        endsOn: { gte: quarter.from },
        status: { in: ["open", "soft_closed"] },
      },
      select: { label: true },
    });
    // No period at all over the quarter is not evidence of filing — it is an
    // absence — so only a quarter whose months are all shut counts as filed.
    const covered = await prisma.accountingPeriod.count({
      where: { orgId, entityId, isAdjustment: false, startsOn: { lte: quarter.to }, endsOn: { gte: quarter.from } },
    });
    if (covered > 0 && periods === null) return null;

    // The registration's own due date, which is the period end plus 28 days
    // under Article 64 — computed by tax-periods rather than added here.
    const deadline = new Date(`${period.dueOn}T00:00:00.000Z`);
    const late = asOf > deadline;
    const net = BigInt(ret.netVatMinor);

    return {
      key: "vat_return",
      severity: late ? "urgent" : "soon",
      title: late ? `The ${quarter.label} VAT return is late` : `The ${quarter.label} VAT return is due`,
      detail:
        `${quarter.label} ended ${isoDay(quarter.to)} and the return was due by ${isoDay(deadline)}` +
        (late ? `, ${plural(daysBetween(deadline, asOf), "day", "days")} ago. ` : `. `) +
        (ret.payable
          ? `${money(net, currency)} is payable to the FTA. `
          : `${money(net, currency)} is reclaimable from the FTA. `) +
        `Nothing in these books records a filing — the months over the period are still open, and a filed ` +
        `return is one whose periods have been closed behind it.` +
        (period.assumed
          ? ` No VAT registration is recorded for this entity, so calendar quarters have been assumed. If the FTA ` +
            `assigned a different stagger — February, May, August and November, say — or monthly returns, this ` +
            `period and this deadline are both wrong. Recording the registration fixes it everywhere at once.`
          : ""),
      amountMinor: ret.netVatMinor,
      href: "/accounting/vat",
      dueOn: period.dueOn,
      statutory: true,
    };
  },
};

/**
 * Turnover crossing the line at which registering for VAT stops being a choice.
 *
 * This is the one obligation on the list that arrives before any of the
 * machinery for it exists. There is no return to be late for and no period to
 * be open, because the business is not registered — so every other VAT check
 * here is silent by construction, and the first thing that happens is a
 * liability for tax on supplies already made at prices that did not include it.
 * The corporate tax module has watched a threshold since it was written; this
 * one, which arrives years earlier for a growing business, was not watched at
 * all.
 *
 * The measure is the law's and not the accounts': a rolling twelve months,
 * which is why it cannot be read off a return or a financial year, and every
 * such window rather than only the one ending today — a business that crossed
 * during a good year and has been quiet since was required to register then and
 * applies to deregister now, which is a different thing from never having had
 * to. `vat.ts` owns all of it, including what counts towards the figure and
 * what does not.
 */
const registrationThresholdNear: Check = {
  key: "vat_registration",
  label: "The VAT registration threshold",
  async run({ orgId, entityId, asOf, currency }) {
    const t = await registrationThreshold({ orgId, entityId, asOf });
    if (t.standing !== "over_mandatory" && t.standing !== "approaching_mandatory") return null;

    // The ledger is only read for an entity with no registration in force, and
    // both of those standings are ones it was read for, so the figures are
    // there to be quoted.
    const total = BigInt(t.totalMinor ?? "0");
    const mandatory = `AED ${fmtMinor(MANDATORY_REGISTRATION_THRESHOLD_MINOR, "AED")}`;
    const voluntary = `AED ${fmtMinor(VOLUNTARY_REGISTRATION_THRESHOLD_MINOR, "AED")}`;

    // What the figure is made of, so nobody has to guess whether an exempt
    // supply or an import is inside it.
    const composition =
      `Over ${t.from} to ${t.to} that is ${money(BigInt(t.suppliesMinor ?? "0"), currency)} of taxable supplies ` +
      `made` +
      (BigInt(t.concernedMinor ?? "0") === 0n
        ? ""
        : ` and ${money(BigInt(t.concernedMinor ?? "0"), currency)} of goods and services imported and ` +
          `self-accounted, which Article 19 counts towards the same threshold`) +
      `. Exempt and out-of-scope supplies are not taxable supplies and are not in it; neither is a sale of ` +
      `capital assets, which Article 20 excludes and which these books cannot tell from trading revenue.`;
    const currencyNote = t.currencyDiffers
      ? ` These books are kept in ${currency} and the threshold is a dirham figure, so the two are not directly ` +
        `comparable — work the twelve months out in dirhams before acting on this.`
      : "";

    if (t.standing === "approaching_mandatory") {
      return {
        key: "vat_registration",
        severity: "soon",
        title: "Turnover is close to the VAT registration threshold",
        detail:
          `Taxable supplies over the last twelve months come to ${money(total, currency)}, within a tenth of the ` +
          `${mandatory} mandatory registration threshold, and no twelve months in the last ` +
          `${REGISTRATION_LOOKBACK_YEARS} years has been over it. Nothing is required yet. The test is ` +
          `the previous twelve months measured on the day it is asked — not a financial year and not a tax ` +
          `period — so a month like the last one crosses it, and the application then has to reach the FTA ` +
          `within ${REGISTRATION_APPLICATION_DAYS} days of the day it does. Registering is already available: ` +
          `the voluntary threshold is ${voluntary}. ${composition}${currencyNote}`,
        amountMinor: total.toString(),
        href: "/accounting/vat",
      };
    }

    const late = t.applyBy !== null && isoDay(asOf) > t.applyBy;
    const stillOver = total > MANDATORY_REGISTRATION_THRESHOLD_MINOR;
    return {
      key: "vat_registration",
      severity: "urgent",
      title: late ? "VAT registration was required and has not been applied for" : "VAT registration is now required",
      detail:
        `The twelve months to ${t.crossedOn} came to ${money(BigInt(t.crossedTotalMinor ?? "0"), currency)}, over ` +
        `the ${mandatory} mandatory registration threshold. Article 13 of Federal Decree-Law 8/2017 requires ` +
        `registration once the previous twelve months exceed it, and the application has to reach the FTA within ` +
        `${REGISTRATION_APPLICATION_DAYS} days — by ${t.applyBy}` +
        (late ? `, ${plural(daysBetween(new Date(`${t.applyBy}T00:00:00Z`), asOf), "day", "days")} ago. ` : `. `) +
        (stillOver
          ? ""
          : `The last twelve months come to ${money(total, currency)}, which is under the threshold — that does ` +
            `not undo it. Every twelve-month window is tested, and a business that has fallen back applies to ` +
            `deregister under Article 21 rather than never having had to register. `) +
        `Registering late does not move the liability: tax is due on supplies made from the day registration ` +
        `should have taken effect, and it cannot be added to invoices already sent. ${composition} The threshold ` +
        `is also crossed by supplies expected in the next 30 days, which is a fact about the order book rather ` +
        `than about the ledger and is not in this figure.${currencyNote}`,
      amountMinor: (stillOver ? total : BigInt(t.crossedTotalMinor ?? "0")).toString(),
      href: "/accounting/vat",
      ...(t.applyBy === null ? {} : { dueOn: t.applyBy, statutory: true }),
    };
  },
};

const periodsStillOpen: Check = {
  key: "periods_open",
  label: "Accounting periods",
  async run({ orgId, entityId, asOf }) {
    const open = await prisma.accountingPeriod.findMany({
      where: { orgId, entityId, isAdjustment: false, status: "open", endsOn: { lt: asOf } },
      orderBy: { endsOn: "asc" },
      select: { label: true, endsOn: true },
    });
    if (open.length === 0) return null;

    const oldest = open[0];
    const age = daysBetween(oldest.endsOn, asOf);

    return {
      key: "periods_open",
      severity: age > BADLY_OVERDUE_DAYS ? "urgent" : "soon",
      title: "Months that have ended are still open",
      detail:
        `${plural(open.length, "period is", "periods are")} still open past ${open.length === 1 ? "its" : "their"} ` +
        `month end (${open.slice(0, 3).map((p) => p.label).join(", ")}${open.length > 3 ? ", …" : ""}). ` +
        `${oldest.label} ended ${plural(age, "day", "days")} ago. An open period can still receive a posting, ` +
        `so every statement drawn over it can still change after it was read.`,
      count: open.length,
      href: "/accounting/periods",
    };
  },
};

const recurringBehind: Check = {
  key: "recurring_behind",
  label: "Recurring journals",
  async run({ asOf, currency, reads }) {
    const status = await reads.templates(monthLabel(asOf));
    const behind = status.templates.filter((t) => t.behind);
    if (behind.length === 0) return null;

    const total = behind.reduce((a, t) => a + (t.amountMinor ? BigInt(t.amountMinor) : 0n), 0n);
    const worst = behind.reduce((a, t) => (t.periodsDue > a.periodsDue ? t : a), behind[0]);

    return {
      key: "recurring_behind",
      severity: "soon",
      title: "Standing journals have not been posted",
      detail:
        `${plural(behind.length, "template is", "templates are")} past the month ` +
        `${behind.length === 1 ? "it was" : "they were"} next due. ${worst.code} ${worst.name} is due for ` +
        `${plural(worst.periodsDue, "period", "periods")} from ${worst.nextDuePeriod ?? "its start"}. ` +
        `A missed accrual is invisible in the ledger by construction: what is wrong is an entry that is not there.`,
      count: behind.length,
      ...(total === 0n ? {} : { amountMinor: total.toString() }),
      href: "/accounting/recurring",
    };
  },
};

const claimsAwaitingApproval: Check = {
  key: "claims_unapproved",
  label: "Expense claims",
  async run({ orgId, entityId, currency }) {
    // The claim summary has no as-at filter, so this row is always "now" while
    // the rest of the page can be read back in time. Re-deriving the totals
    // here with a date on them would give a second answer to "what is
    // unapproved", and two answers is worse than one that says which day it is
    // about.
    //
    // The summary rather than the list: `claimList` loads every claim the
    // business has ever filed, with every line on every one of them, to hand
    // back the same two figures computed off the open claims alone. This row
    // reads two figures and shows no claims.
    const { awaitingApprovalCount, awaitingApprovalMinor } = await claimSummary({ orgId, entityId });
    if (awaitingApprovalCount === 0) return null;

    return {
      key: "claims_unapproved",
      severity: "note",
      title: "Expense claims are waiting to be approved",
      detail:
        `${plural(awaitingApprovalCount, "claim", "claims")} worth ` +
        `${money(awaitingApprovalMinor, currency)} ${awaitingApprovalCount === 1 ? "has" : "have"} been submitted ` +
        `and nobody has looked at ${awaitingApprovalCount === 1 ? "it" : "them"}. Until a claim is approved it is ` +
        `neither a cost in the accounts nor money the employee can expect.`,
      count: awaitingApprovalCount,
      amountMinor: awaitingApprovalMinor.toString(),
      href: "/accounting/expenses",
    };
  },
};

const receivedNotInvoiced: Check = {
  key: "grni_open",
  label: "Goods received not invoiced",
  async run({ orgId, entityId, asOf, currency }) {
    const grni = await grniReport({ orgId, entityId, asOf });
    if (grni.orders.length === 0) return null;

    const total = BigInt(grni.totals.outstandingMinor);
    const oldest = grni.orders.reduce(
      (a, o) => (o.daysOld !== null && (a === null || o.daysOld > a) ? o.daysOld : a),
      null as number | null,
    );

    return {
      key: "grni_open",
      severity: oldest !== null && oldest > BADLY_OVERDUE_DAYS ? "soon" : "note",
      title: "Deliveries have arrived and no invoice has",
      detail:
        `${plural(grni.orders.length, "order carries", "orders carry")} ${money(total, currency)} of goods ` +
        `received and not yet billed` +
        (oldest === null ? "." : `, the oldest ${plural(oldest, "day", "days")} ago.`) +
        ` An unbilled delivery and a delivery that never happened leave the same trace in the accounts, ` +
        `which is why this balance is worth explaining rather than carrying.`,
      count: grni.orders.length,
      amountMinor: total.toString(),
      href: "/accounting/procurement",
    };
  },
};

const assetsNotDepreciated: Check = {
  key: "depreciation_due",
  label: "Fixed asset depreciation",
  async run({ asOf, reads }) {
    // The last month that has fully ended, not the last month a period was
    // closed for. Depreciation is what you run *before* closing a month, so
    // waiting for the close to decide whether depreciation is due would be
    // circular — the month stays open because the charge is missing.
    const lastMonthEnd = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 0));
    const month = monthLabel(lastMonthEnd);

    const register = await reads.assets();
    const behind = register.assets.filter(
      (a) =>
        a.status === "active" &&
        a.acquiredOn <= isoDay(lastMonthEnd) &&
        // Month labels sort lexicographically, which is the whole reason they
        // are written YYYY-MM.
        (a.depreciatedTo === null || a.depreciatedTo < month),
    );
    if (behind.length === 0) return null;

    return {
      key: "depreciation_due",
      severity: "soon",
      title: `Depreciation has not been run for ${month}`,
      detail:
        `${plural(behind.length, "active asset", "active assets")} ${behind.length === 1 ? "was" : "were"} held ` +
        `through ${month} and ${behind.length === 1 ? "carries" : "carry"} no charge for it — ` +
        `${behind.slice(0, 3).map((a) => `${a.code} ${a.name}`).join(", ")}${behind.length > 3 ? ", …" : ""}. ` +
        `Profit for the month is overstated by the charge that is missing.`,
      count: behind.length,
      href: "/accounting/assets",
    };
  },
};

/**
 * Declaration order is display order within a severity. It runs roughly from
 * "the books are wrong" through "a deadline is coming" to "somebody has not
 * finished something", so a row does not move between refreshes.
 */
const CHECKS: Check[] = [
  trialBalanceCheck,
  vatReturnOutstanding,
  registrationThresholdNear,
  overdueReceivables,
  payablesDueSoon,
  periodsStillOpen,
  recurringBehind,
  assetsNotDepreciated,
  unreconciledBank,
  receivedNotInvoiced,
  claimsAwaitingApproval,
];

const RANK: Record<Severity, number> = { urgent: 0, soon: 1, note: 2 };

/**
 * Quotes about to expire belong on this list and are not on it: there was no
 * sales-order module to read them from when these checks were written, and a
 * check that imports a module which is not there does not fail on its own row —
 * it fails at import time and takes the other nine with it. When one exists,
 * the check is a `Check` in the array above and nothing else changes.
 */

export async function attentionList(opts: {
  orgId: string;
  entityId: string;
  /** Defaults to now. Passing it makes the whole list reproducible. */
  asOf?: Date | string;
  /**
   * The reads this list shares with whatever else is on the page. Left out, it
   * makes its own and nothing is shared — which is right for the attention
   * screen, where this list is the only thing being read. The notification
   * centre passes its own, because there this list is one source of twelve and
   * two of the others ask the same reports the same questions.
   */
  reads?: SharedReads;
}): Promise<AttentionList> {
  const asOf = asDate(opts.asOf);

  // The book is read for its currency alone, and its absence is not a finding:
  // an entity with no ledger open has nothing to nag about, and every check
  // that needs the book will say so in its own row.
  const currency = await prisma.book
    .findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
      select: { functionalCurrency: true },
    })
    .then((b) => b?.functionalCurrency ?? "AED")
    .catch(() => "AED");

  const ctx: Ctx = {
    orgId: opts.orgId,
    entityId: opts.entityId,
    asOf,
    currency,
    reads: opts.reads ?? sharedReads({ orgId: opts.orgId, entityId: opts.entityId }),
  };

  // allSettled, not all: see the note at the top of this file. One check
  // throwing must cost its own row and nothing else.
  const results = await Promise.allSettled(CHECKS.map((c) => c.run(ctx)));

  const findings: { finding: Finding; order: number }[] = [];
  const failed: FailedCheck[] = [];

  results.forEach((r, i) => {
    const check = CHECKS[i];
    if (r.status === "rejected") {
      const e: unknown = r.reason;
      // Only a message somebody wrote for a reader is shown. A LedgerError is
      // one by definition; the two reports that refuse with a plain Error say
      // something equally useful, so they are matched by their words. Anything
      // else could be a driver or a constraint name, and a nag list is not the
      // place to leak one.
      failed.push({
        key: check.key,
        label: check.label,
        reason:
          e instanceof LedgerError
            ? e.message
            : e instanceof Error && /does not exist|No ledger has been opened|No accounting period/i.test(e.message)
              ? e.message
              : "This check could not be run against these books.",
      });
      return;
    }
    if (r.value) findings.push({ finding: r.value, order: i });
  });

  findings.sort((a, b) => RANK[a.finding.severity] - RANK[b.finding.severity] || a.order - b.order);
  const ordered = findings.map((f) => f.finding);

  return {
    entityId: opts.entityId,
    asOf: isoDay(asOf),
    currency,
    findings: ordered,
    failed,
    counts: {
      urgent: ordered.filter((f) => f.severity === "urgent").length,
      soon: ordered.filter((f) => f.severity === "soon").length,
      note: ordered.filter((f) => f.severity === "note").length,
    },
    checked: CHECKS.length,
  };
}
