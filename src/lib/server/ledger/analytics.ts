import { prisma } from "@/lib/server/prisma";
import { fmtMinor, exponentOf } from "@/lib/ledger/format";
import { LedgerError } from "./post";

/**
 * Ledger analytics — the tests an auditor runs over a whole ledger looking for
 * what should not be there.
 *
 * This module adds nothing to the schema and posts nothing. Every test below
 * reads the ledger as it stands and returns the entries behind what it says,
 * so a reader can go and look rather than take the number on trust.
 *
 * Four decisions carry it.
 *
 * **A test that finds nothing must say so.** An analytics screen that shows
 * only red flags teaches its readers that flags are normal and silence is
 * meaningless — and a test that silently returns nothing is indistinguishable
 * from a test that never ran, a test whose account was missing, or a test whose
 * threshold happened to exclude everything. So every test contributes exactly
 * one row to `runs` whatever it finds: what it read, how many entries, over
 * what dates, and either what it found or why it could not look. `findings` is
 * a projection of that, never the whole story.
 *
 * **Nothing here is evidence.** These are prompts to look. A round number is a
 * round number; a Saturday is a Saturday; Benford's law is a statement about
 * large unconstrained populations and not about any entry in one. The detail
 * on every finding is written to be read by somebody who will then go and ask
 * a person, and none of it is written as an accusation.
 *
 * **Frequency is measured against this entity's own history, never a rule
 * table.** "Unusual" means unusual here. A haulier posting fuel every day and
 * a law firm posting it twice a year are both normal, and the only ledger that
 * can say which is which is the one being read.
 *
 * **Integers throughout.** Ledger amounts are BigInt minor units and never
 * become floats — including inside the statistics. Benford's expected
 * distribution is a table of basis points that sums to exactly 10,000, every
 * observed ratio is computed by integer division, and the deviation measure is
 * a whole number of basis points. A double would be accurate enough for the
 * arithmetic and wrong for the product: this is the one file where a reader is
 * most likely to ask "where did that number come from", and "an integer count
 * over an integer total" is an answer.
 *
 * The tests run through `Promise.allSettled`, as the attention list does, so
 * one throwing costs its own row rather than the page.
 */

/* ----------------------------------------------------------------- types --- */

/**
 * Not the attention list's words. There, severity is about a deadline —
 * something is late or it is about to be. Nothing here is late; severity is how
 * strongly the finding asks to be explained, which is a different axis and
 * deserves different words so the two screens are never read as one list.
 */
export type Severity = "high" | "medium" | "low";

/** An entry named by a finding, in the form a reader can go and look it up by. */
export interface FindingEntry {
  id: string;
  /** Series and number, e.g. GJ-00042. */
  reference: string;
  /** The date the entry is dated — not the date it was keyed. */
  date: string;
  memo: string | null;
  /** Minor units as a string; the wire never carries a ledger amount as a number. */
  amountMinor: string;
}

export interface Finding {
  /** Stable across runs, so a row can be linked to and tested for. */
  key: string;
  severity: Severity;
  title: string;
  /** What was seen and what it does and does not mean, for somebody who will act on it. */
  detail: string;
  count: number;
  amountMinor?: string;
  /** The entries behind the finding, largest first, capped — see `MAX_LISTED`. */
  entries: FindingEntry[];
}

/**
 * What one test did. `clean` and `skipped` are the rows that make the screen
 * honest: the first says a test ran and found nothing, the second says it could
 * not run at all, and without both an empty screen means nothing.
 */
export type Outcome = "found" | "clean" | "skipped" | "failed";

export interface TestRun {
  key: string;
  label: string;
  outcome: Outcome;
  /** How many entries this test actually read. */
  population: number;
  /** What those entries span; null when it read none. */
  from: string | null;
  to: string | null;
  /** One sentence: what it found, or why it could not look. */
  note: string;
}

export interface BenfordDigit {
  digit: number;
  /** Basis points of ten thousand. The nine expected values sum to exactly 10,000. */
  expectedBp: number;
  observed: number;
  observedBp: number;
  /** Observed less expected; negative means the digit is under-represented. */
  differenceBp: number;
}

export interface Benford {
  population: number;
  /** Below this many entries no verdict is offered at all. */
  minimum: number;
  digits: BenfordDigit[];
  /** Mean absolute deviation across the nine digits, in basis points. Null below `minimum`. */
  madBp: number | null;
  verdict: "conforms" | "marginal" | "deviates" | null;
  note: string;
}

export interface LedgerAnalytics {
  entityId: string;
  currency: string;
  /** The window that was asked for; `from` null means "everything the ledger holds". */
  from: string | null;
  to: string;
  /** Entries actually read, and what they span. */
  population: number;
  populationFrom: string | null;
  populationTo: string | null;
  /** True when the ledger holds more entries than `MAX_ENTRIES` and the oldest were not read. */
  truncated: boolean;
  findings: Finding[];
  /** One row per test, whatever it found. */
  runs: TestRun[];
  counts: { high: number; medium: number; low: number };
  /** Returned whether or not it produced a finding — the table is the point. */
  benford: Benford;
  /** How many tests were attempted, so "nothing found" can be trusted. */
  checked: number;
}

/* ------------------------------------------------------------- constants --- */

/**
 * The most entries one read will pull. Past this the oldest are not read and
 * `truncated` says so — a screen that quietly analyses the recent half of a
 * ledger while claiming to analyse the ledger is worse than one that refuses.
 */
const MAX_ENTRIES = 10_000;

/** Entries listed under one finding. The count is always the true count. */
const MAX_LISTED = 40;

/** Duplicate groups reported, largest exposure first. */
const MAX_DUPLICATE_GROUPS = 25;

/** Rare pairings reported, largest first. */
const MAX_RARE_PAIRINGS = 10;

/**
 * Benford's expected first-digit distribution, log10(1 + 1/d), as basis points.
 * Held as a constant table rather than computed so the arithmetic below never
 * needs a logarithm and never needs a float. The nine values sum to 10,000.
 */
const BENFORD_BP = [3010, 1761, 1249, 969, 792, 669, 580, 512, 458];

/**
 * Benford says nothing about a small population. Below a few hundred entries
 * the expected count for digit 9 is in single figures, and a run of three or
 * four in a row moves the whole measure. See `benfordOf` for what is refused.
 */
const BENFORD_MIN = 300;

/** Nigrini's first-digit bands, in basis points of mean absolute deviation. */
const BENFORD_MARGINAL_BP = 120;
const BENFORD_DEVIATES_BP = 150;

/** Two payments this many days apart or fewer are close enough to be one mistake. */
const DUPLICATE_NEAR_DAYS = 7;

/** A "round" amount is a whole multiple of this many major units. */
const ROUND_UNIT_MAJOR = 1_000n;

/** Below this, roundness is a coincidence rather than a choice. */
const ROUND_MIN_MAJOR = 10_000n;

/** Round costs above this share of the eligible population stop being a coincidence. */
const ROUND_SHARE_BP = 2_500;

/**
 * The office keeps Gulf Standard Time, UTC+4 the whole year — the UAE observes
 * no daylight saving, so this is a fixed offset and not an approximation of one.
 */
const UTC_OFFSET_HOURS = 4;
const WORK_START_LOCAL = 7;
const WORK_END_LOCAL = 19;

/** Days after a month has ended before keying an entry into it counts as late. */
const LATE_DAYS = 10;

/** Past this the lag stops being housekeeping and starts being an adjustment. */
const LATE_ADJUSTMENT_DAYS = 30;

/** A manual journal this large with nothing written on it is worth a question. */
const UNEXPLAINED_MIN_MAJOR = 5_000n;

/** …and this large with nothing written on it is worth an answer. */
const UNEXPLAINED_LOUD_MULTIPLE = 10n;

/** Entries needed before this ledger's own pairing frequencies mean anything. */
const PAIRING_MIN_HISTORY = 40;

/** A pairing seen this many times or fewer is rare in this ledger. */
const PAIRING_RARE_MAX = 2;

/** Entries an actor needs before "their usual size" is a thing that exists. */
const ACTOR_MIN_ENTRIES = 8;

/** Multiples of an actor's own median that count as out of their pattern. */
const ACTOR_OUTLIER_MULTIPLE = 10n;

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/* --------------------------------------------------------------- helpers --- */

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function asDate(v: Date | string | undefined, what: string): Date | undefined {
  if (v === undefined) return undefined;
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} needs a valid date.`);
  return d;
}

/**
 * Minor units inside a sentence: always the magnitude, never parenthesised.
 * Parentheses are how a *numeral* carries a negative; prose says the direction
 * in words. Same rule the attention list follows.
 */
function money(minor: bigint, currency: string): string {
  return `${currency} ${fmtMinor(minor < 0n ? -minor : minor, currency, { zero: "zero" })}`;
}

/**
 * `part` as basis points of `whole`, rounded half-up, without ever producing a
 * float. `(p * 20000 + w) / (2w)` is `(p * 10000 + w/2) / w` kept in integers so
 * the halving of an odd `w` cannot be lost.
 */
function bp(part: number | bigint, whole: number | bigint): number {
  const p = BigInt(part);
  const w = BigInt(whole);
  if (w === 0n) return 0;
  return Number((p * 20_000n + w) / (w * 2n));
}

/**
 * Basis points as a percentage, written out of the integer rather than by
 * dividing it. `fmtMinor` places a decimal point the same way, and for the same
 * reason: the value on screen is then the value that was computed, not a
 * rounding of a float that was made out of it.
 */
function pct(basisPoints: number): string {
  const s = String(Math.abs(basisPoints)).padStart(3, "0");
  return `${basisPoints < 0 ? "−" : ""}${s.slice(0, -2)}.${s.slice(-2)}%`;
}

/**
 * The leading significant digit, taken off the decimal string of the minor
 * units. Scale does not change a leading digit — 1,200 fils and 12.00 dirhams
 * both lead with a 1 — so this is exact and needs no division at all.
 */
function leadingDigit(minor: bigint): number {
  const s = (minor < 0n ? -minor : minor).toString();
  return s.charCodeAt(0) - 48;
}

/** Minor units of one major unit in this currency, e.g. 100 fils, 1000 in Bahrain. */
function majorUnit(currency: string): bigint {
  return 10n ** BigInt(exponentOf(currency));
}

/* ------------------------------------------------------------- the ledger --- */

interface AccountInfo {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  isControl: boolean;
}

interface LoadedLine {
  accountId: string;
  /** Signed functional minor units: debit positive, credit negative. */
  amountMinor: bigint;
}

interface LoadedEntry {
  id: string;
  reference: string;
  entryDate: Date;
  /** When the row reached the database. Nobody chooses this; see `offHours`. */
  createdAt: Date;
  memo: string | null;
  source: string;
  sourceType: string | null;
  sourceId: string | null;
  settlesId: string | null;
  actorId: string | null;
  actorType: string;
  status: string;
  reversalOfId: string | null;
  reversed: boolean;
  periodLabel: string | null;
  periodEndsOn: Date | null;
  periodIsAdjustment: boolean;
  /** Total debits in the functional currency — the size of the entry, in one number. */
  amountMinor: bigint;
  lines: LoadedLine[];
}

interface Ctx {
  orgId: string;
  entityId: string;
  currency: string;
  /** Oldest first, so date clustering and pairing history read forwards. */
  entries: LoadedEntry[];
  accounts: Map<string, AccountInfo>;
  benford: Benford;
}

interface TestResult {
  findings: Finding[];
  /** Entries this test actually read, which is rarely the whole population. */
  population: number;
  from: string | null;
  to: string | null;
  /** Set when the test declined to look at all, and why. */
  skipped?: string;
  /** Overrides the sentence the runner would otherwise write. */
  note?: string;
}

interface Test {
  key: string;
  /** What this test looks at, for the row that says it could not run. */
  label: string;
  run: (ctx: Ctx) => Promise<TestResult>;
}

/* --------------------------------------------------------------- reading --- */

const refOf = (e: { series: string; number: string }) => `${e.series}-${e.number}`;

function entryRef(e: LoadedEntry): FindingEntry {
  return {
    id: e.id,
    reference: e.reference,
    date: isoDay(e.entryDate),
    memo: e.memo,
    amountMinor: e.amountMinor.toString(),
  };
}

/** The largest few, and the true count kept separately. */
function listed(entries: LoadedEntry[]): FindingEntry[] {
  return [...entries]
    .sort((a, b) => (b.amountMinor > a.amountMinor ? 1 : b.amountMinor < a.amountMinor ? -1 : 0))
    .slice(0, MAX_LISTED)
    .map(entryRef);
}

function span(entries: LoadedEntry[]): { from: string | null; to: string | null } {
  if (entries.length === 0) return { from: null, to: null };
  let lo = entries[0].entryDate;
  let hi = entries[0].entryDate;
  for (const e of entries) {
    if (e.entryDate < lo) lo = e.entryDate;
    if (e.entryDate > hi) hi = e.entryDate;
  }
  return { from: isoDay(lo), to: isoDay(hi) };
}

const total = (entries: LoadedEntry[]) => entries.reduce((a, e) => a + e.amountMinor, 0n);

/** "Showing the largest 40 of 112." — said only when the list is short of the count. */
function trailer(count: number): string {
  return count > MAX_LISTED ? ` The ${MAX_LISTED} largest are listed; there are ${count} in all.` : "";
}

/* ------------------------------------------------------------- Benford's --- */

/**
 * Benford's law over the leading digit of posted amounts.
 *
 * What it does: describes the first digits of a large population of numbers
 * that span several orders of magnitude and are not constrained by anything —
 * naturally occurring amounts, in other words. Roughly 30% of them start with
 * a 1 and about 4.6% with a 9. A population of invented figures usually does
 * not do that, because people inventing numbers spread the first digit far more
 * evenly than nature does.
 *
 * What it does NOT do, and this matters more than the above:
 *
 *  - It says nothing whatever about any individual entry. There is no such
 *    thing as a "Benford outlier" entry, and an entry starting with a 7 is not
 *    evidence of anything at all.
 *  - Deviation is not evidence of fraud. It is evidence that the population is
 *    constrained, and constraints are everywhere in a ledger: a payroll where
 *    everyone is on one of four salaries, a business whose products have four
 *    price points, a VAT account whose every line is 5% of another line, a
 *    lease schedule of twelve identical charges. Each of those deviates loudly
 *    and each of them is completely honest.
 *  - Conformity is not evidence of anything either. A ledger with material
 *    fraud in a handful of entries conforms perfectly, because a handful of
 *    entries cannot move a distribution.
 *
 * So this returns a table and a distance, and the only verdict it will ever
 * offer is "worth looking at the shape of this population". Below
 * `BENFORD_MIN` entries it offers not even that: the expected count for the
 * higher digits falls into single figures, where three entries in a row can
 * double a proportion, and a screen that printed "deviates" off forty entries
 * would be manufacturing suspicion out of arithmetic noise. Refusing a verdict
 * is the honest output there, not a quieter one.
 */
function benfordOf(amounts: bigint[]): Benford {
  const observed = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const a of amounts) {
    const d = leadingDigit(a);
    if (d >= 1 && d <= 9) observed[d - 1]++;
  }
  const population = observed.reduce((a, b) => a + b, 0);

  const digits: BenfordDigit[] = BENFORD_BP.map((expectedBp, i) => {
    const observedBp = bp(observed[i], population);
    return { digit: i + 1, expectedBp, observed: observed[i], observedBp, differenceBp: observedBp - expectedBp };
  });

  if (population < BENFORD_MIN) {
    return {
      population,
      minimum: BENFORD_MIN,
      digits,
      madBp: null,
      verdict: null,
      note:
        `${population} ${population === 1 ? "entry is" : "entries are"} not enough for Benford's law to say ` +
        `anything. It describes large populations spanning several orders of magnitude; below about ` +
        `${BENFORD_MIN} entries the expected count for the higher digits is in single figures and any shape in ` +
        `them is noise. The observed counts are shown because they are a fact about these books — no verdict ` +
        `is offered on them, and one taken from a population this size would be manufactured.`,
    };
  }

  // Mean absolute deviation over the nine digits, kept in basis points and
  // rounded half-up by integer arithmetic: (sum*2 + 9) / 18 is (sum/9) rounded.
  const totalAbs = digits.reduce((a, d) => a + Math.abs(d.differenceBp), 0);
  const madBp = Math.floor((totalAbs * 2 + 9) / 18);
  const verdict = madBp > BENFORD_DEVIATES_BP ? "deviates" : madBp > BENFORD_MARGINAL_BP ? "marginal" : "conforms";

  const note =
    verdict === "conforms"
      ? `Over ${population} entries the observed first digits sit ${madBp} basis points from Benford on average, ` +
        `which is close conformity. That is a fact about the shape of the population and not a clean bill of ` +
        `health: a fraud of a dozen entries cannot move a distribution of this size.`
      : verdict === "marginal"
        ? `Over ${population} entries the observed first digits sit ${madBp} basis points from Benford on average — ` +
          `acceptable-to-marginal. Nothing follows from it on its own.`
        : `Over ${population} entries the observed first digits sit ${madBp} basis points from Benford on average, ` +
          `which is outside the range a naturally occurring population usually falls in. The commonest innocent ` +
          `cause by far is a constrained population: fixed prices, fixed salaries, a tax account whose every line ` +
          `is a percentage of another. Look at the shape before looking at anybody.`;

  return { population, minimum: BENFORD_MIN, digits, madBp, verdict, note };
}

/* ----------------------------------------------------------- the tests --- */

const benfordTest: Test = {
  key: "benford",
  label: "Benford's law on leading digits",
  async run(ctx) {
    const amounts = ctx.entries.filter((e) => e.amountMinor > 0n);
    const { from, to } = span(amounts);
    const b = ctx.benford;

    if (b.verdict === null) {
      return { findings: [], population: b.population, from, to, skipped: b.note };
    }
    if (b.verdict !== "deviates") {
      return { findings: [], population: b.population, from, to, note: b.note };
    }

    // The entries "behind" a distribution are not the cause of it — no entry
    // causes a distribution. What is shown is the entries carrying the single
    // most over-represented digit, because that is where a reader who wants to
    // understand the shape should start looking, and it is labelled as that.
    const worst = b.digits.reduce((a, d) => (d.differenceBp > a.differenceBp ? d : a), b.digits[0]);
    const behind = amounts.filter((e) => leadingDigit(e.amountMinor) === worst.digit);

    return {
      findings: [
        {
          key: "benford",
          // Low, always. Benford is a prompt to look at a population; it is
          // never on its own a reason to look at a person or an entry.
          severity: "low",
          title: "The leading digits do not follow Benford's law",
          detail:
            `${b.note} Digit ${worst.digit} is the most over-represented: ${worst.observed} of ${b.population} ` +
            `entries start with it, ${pct(worst.observedBp)} against an expected ` +
            `${pct(worst.expectedBp)}. The entries listed are the ones carrying that digit — they ` +
            `are where to start reading the population, not entries that are themselves suspect.` +
            trailer(behind.length),
          count: behind.length,
          amountMinor: total(behind).toString(),
          entries: listed(behind),
        },
      ],
      population: b.population,
      from,
      to,
    };
  },
};

/**
 * Duplicate payments. The most valuable test in this file by a distance: it is
 * the one whose findings are recoverable money rather than a question.
 *
 * A duplicate is money that left the bank more than once for what looks like
 * one obligation. "Looks like" is doing the work, and it is defined here as:
 * the same amount to the fil, close enough in date to be one mistake, and
 * something in common that identifies the obligation. That last part is what
 * separates this from a coincidence generator — the ledger is full of pairs of
 * equal amounts, and equality alone is not a finding.
 *
 * The identity is taken in order of strength:
 *
 *  1. `settlesId` — two separate entries discharging the same document. This is
 *     a double payment by definition, and it is what the AP module's open-item
 *     ageing nets by, so it is the ledger's own idea of "this document".
 *  2. `sourceType`/`sourceId` — two payments raised from the same document.
 *  3. The memo, normalised. The ledger does not record a counterparty on an
 *     entry — a journal line records what a document did to the books, not the
 *     document — so where there is no document link, the description a person
 *     typed is what stands in for the party, and it matches only when the
 *     words match.
 *
 * Two exclusions matter more than any threshold. A reversal and the entry it
 * reverses are the same amount days apart and are the opposite of a duplicate:
 * one cancels the other, and flagging them would put the correctly-handled
 * mistakes at the top of the list. And a standing charge — rent, a subscription
 * — repeats the same amount and the same words every month, which is why the
 * window is a week and not a month: monthly repetition is what a standing
 * charge looks like, and it is not what a double payment looks like.
 */
const duplicatePayments: Test = {
  key: "duplicate_payments",
  label: "Duplicate payments",
  async run(ctx) {
    type Identity = { kind: "settles" | "document" | "memo"; value: string; label: string };
    interface Candidate {
      entry: LoadedEntry;
      cashMinor: bigint;
      identities: Identity[];
    }

    const isCash = (id: string) => {
      const a = ctx.accounts.get(id);
      return a?.subtype === "BANK" || a?.subtype === "CASH";
    };

    const candidates: Candidate[] = [];
    for (const e of ctx.entries) {
      // A reversal and a reversed entry are a correction, not a duplicate.
      if (e.reversalOfId !== null || e.reversed) continue;
      const out = e.lines.reduce((a, l) => (isCash(l.accountId) && l.amountMinor < 0n ? a - l.amountMinor : a), 0n);
      if (out <= 0n) continue;

      const identities: Identity[] = [];
      if (e.settlesId) identities.push({ kind: "settles", value: e.settlesId, label: `the same document, ${e.settlesId}` });
      if (e.sourceType && e.sourceId) {
        identities.push({
          kind: "document",
          value: `${e.sourceType}:${e.sourceId}`,
          label: `the same ${e.sourceType.toLowerCase().replace(/_/g, " ")}, ${e.sourceId}`,
        });
      }
      const words = memoKey(e.memo);
      if (words) identities.push({ kind: "memo", value: words, label: `the same description, "${e.memo}"` });
      if (identities.length === 0) continue;

      candidates.push({ entry: e, cashMinor: out, identities });
    }

    const { from, to } = span(candidates.map((c) => c.entry));

    // Group on (amount, identity). One entry can appear under two identities;
    // the stronger one wins, which is why the kinds are walked in order below.
    const groups = new Map<string, { identity: Identity; members: Candidate[] }>();
    for (const c of candidates) {
      for (const identity of c.identities) {
        const key = `${identity.kind}|${c.cashMinor}|${identity.value}`;
        const g = groups.get(key) ?? { identity, members: [] };
        g.members.push(c);
        groups.set(key, g);
      }
    }

    interface Cluster {
      identity: Identity;
      cashMinor: bigint;
      members: Candidate[];
    }
    const clusters: Cluster[] = [];
    const claimed = new Set<string>();
    const strength: Record<Identity["kind"], number> = { settles: 0, document: 1, memo: 2 };

    for (const g of [...groups.values()].sort((a, b) => strength[a.identity.kind] - strength[b.identity.kind])) {
      if (g.members.length < 2) continue;
      const ordered = [...g.members].sort((a, b) => a.entry.entryDate.getTime() - b.entry.entryDate.getTime());

      let run: Candidate[] = [];
      const flush = () => {
        if (run.length >= 2) {
          // The same set of entries reached through two identities is one
          // finding, not two; the stronger identity got here first.
          const signature = run.map((r) => r.entry.id).sort().join(",");
          if (!claimed.has(signature)) {
            claimed.add(signature);
            clusters.push({ identity: g.identity, cashMinor: run[0].cashMinor, members: run });
          }
        }
        run = [];
      };
      for (const c of ordered) {
        if (run.length > 0 && daysBetween(run[run.length - 1].entry.entryDate, c.entry.entryDate) > DUPLICATE_NEAR_DAYS) {
          flush();
        }
        run.push(c);
      }
      flush();
    }

    // Exposure — what would come back if the extras are duplicates — is the
    // right thing to rank by. The payment amount is the same on every one of
    // them, so ranking by that would put a pair of small payments above a
    // sixfold repeat of the same figure.
    const exposure = (c: Cluster) => c.cashMinor * BigInt(c.members.length - 1);
    clusters.sort((a, b) => {
      const d = exposure(b) - exposure(a);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });

    const findings: Finding[] = clusters.slice(0, MAX_DUPLICATE_GROUPS).map((c): Finding => {
      const entries = c.members.map((m) => m.entry);
      const first = entries[0];
      const last = entries[entries.length - 1];
      const apart = daysBetween(first.entryDate, last.entryDate);
      const n = entries.length;
      return {
        key: `duplicate_payment:${first.reference}`,
        // A document paid twice is a fact about the ledger. A description
        // repeated is a fact about what somebody typed, and typing the same
        // words twice about two genuinely separate costs is ordinary.
        severity: c.identity.kind === "memo" ? "medium" : "high",
        title: `${money(c.cashMinor, ctx.currency)} left the ${n === 2 ? "bank twice" : `bank ${n} times`}`,
        detail:
          `${money(c.cashMinor, ctx.currency)} was paid ${n} times between ${isoDay(first.entryDate)} and ` +
          `${isoDay(last.entryDate)}${apart === 0 ? " — on the same day" : `, ${plural(apart, "day", "days")} apart`}, ` +
          `each against ${c.identity.label}. If those are one obligation settled ${n} times, ` +
          `${money(exposure(c), ctx.currency)} is recoverable from the supplier. If they are genuinely separate, ` +
          `nothing in the ledger distinguishes them, and the reason belongs in the memo on the entries so the next ` +
          `person reading them does not ask again.`,
        count: n,
        amountMinor: exposure(c).toString(),
        entries: entries.map(entryRef),
      };
    });

    return {
      findings,
      population: candidates.length,
      from,
      to,
      note:
        findings.length === 0
          ? `Ran over ${plural(candidates.length, "payment", "payments")} — entries that moved money out of a bank ` +
            `or cash account and carry something to identify what they were for — and found no two of equal amount ` +
            `within ${DUPLICATE_NEAR_DAYS} days of each other against the same document or description.`
          : `${plural(clusters.length, "group", "groups")} of equal payments within ${DUPLICATE_NEAR_DAYS} days of ` +
            `each other, out of ${plural(candidates.length, "payment", "payments")} read` +
            (clusters.length > MAX_DUPLICATE_GROUPS ? `; the ${MAX_DUPLICATE_GROUPS} largest are shown.` : "."),
    };
  },
};

/** Words a person typed, reduced to what two entries can be compared on. */
function memoKey(memo: string | null): string | null {
  if (!memo) return null;
  // Punctuation and case go; digits stay. "INV-0041" and "INV-0042" are two
  // different obligations and must not be merged into one.
  const s = memo.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return s.length >= 4 ? s : null;
}

/**
 * Round numbers on expense accounts.
 *
 * A cost of exactly 25,000.00 was either negotiated at exactly 25,000.00 or it
 * was not measured at all. Both happen constantly and honestly — a retainer, a
 * rent, a fixed-fee engagement — which is why this is a prompt and not a
 * finding. What it is genuinely good at is the second case: an estimate that
 * was never trued up, an accrual nobody revisited, a figure somebody chose.
 *
 * The threshold is what keeps it useful. Every small round number in a ledger
 * is a coincidence, and without a floor this test returns most of the petty
 * cash book.
 */
const roundNumbers: Test = {
  key: "round_numbers",
  label: "Round numbers on expense accounts",
  async run(ctx) {
    const unit = majorUnit(ctx.currency);
    const modulus = ROUND_UNIT_MAJOR * unit;
    const floor = ROUND_MIN_MAJOR * unit;

    const isExpense = (id: string) => ctx.accounts.get(id)?.type === "EXPENSE";

    // Eligible: an entry whose expense side is big enough for roundness to be a
    // choice. The share below is only honest against this, not against the
    // whole ledger — most entries could never have qualified.
    const eligible: LoadedEntry[] = [];
    const round: LoadedEntry[] = [];
    let roundMinor = 0n;

    for (const e of ctx.entries) {
      let big = false;
      let hit = 0n;
      for (const l of e.lines) {
        if (!isExpense(l.accountId) || l.amountMinor < floor) continue;
        big = true;
        if (l.amountMinor % modulus === 0n) hit += l.amountMinor;
      }
      if (!big) continue;
      eligible.push(e);
      if (hit > 0n) {
        round.push(e);
        roundMinor += hit;
      }
    }

    const { from, to } = span(eligible);
    if (round.length === 0) {
      return {
        findings: [],
        population: eligible.length,
        from,
        to,
        note:
          `Ran over ${plural(eligible.length, "entry", "entries")} carrying an expense of ` +
          `${money(floor, ctx.currency)} or more and found none whose cost was a whole multiple of ` +
          `${money(modulus, ctx.currency)}.`,
      };
    }

    const shareBp = bp(round.length, eligible.length);
    return {
      findings: [
        {
          key: "round_numbers",
          // Roundness is unremarkable one at a time. A ledger where most large
          // costs are round is a ledger whose large costs were mostly decided
          // rather than measured, and that is a different observation.
          severity: shareBp >= ROUND_SHARE_BP ? "medium" : "low",
          title: `${plural(round.length, "cost is", "costs are")} a round ${money(modulus, ctx.currency)}`,
          detail:
            `${round.length} of ${eligible.length} expense entries above ${money(floor, ctx.currency)} ` +
            `(${pct(shareBp)}) are whole multiples of ${money(modulus, ctx.currency)}, ` +
            `${money(roundMinor, ctx.currency)} in all. A negotiated fee is round on purpose and an estimate is ` +
            `round because nobody measured it, and the ledger cannot tell those apart — the invoice behind each ` +
            `one can.` +
            (shareBp >= ROUND_SHARE_BP
              ? ` More than ${pct(ROUND_SHARE_BP)} of the large costs here are round, which is high enough to be ` +
                `worth asking how these figures are arrived at.`
              : "") +
            trailer(round.length),
          count: round.length,
          amountMinor: roundMinor.toString(),
          entries: listed(round),
        },
      ],
      population: eligible.length,
      from,
      to,
    };
  },
};

/**
 * Weekends and out-of-hours.
 *
 * These are deliberately two findings from one test, because they are two
 * different questions and conflating them is the usual mistake.
 *
 * `entryDate` is the date the entry *claims*. A person chose it, it can be any
 * date an open period covers, and it can be chosen long after the fact. A
 * Saturday there is a question about the business: did something really happen
 * on a Saturday, or was a date typed to land in a period?
 *
 * `createdAt` is when the row actually reached the database. Nobody chooses it,
 * nothing can backdate it, and it is the only clock in the ledger that cannot
 * be argued with. Three in the morning there is a question about the person:
 * who was working then, and why did this go in at that hour rather than the
 * next morning?
 *
 * Neither is a finding on its own. A Gulf business trades on Saturdays; a
 * finance team closing a month works late; an integration posts on the hour it
 * is scheduled for, which may well be 02:00. What makes either worth a look is
 * an entry that is odd in some other way *and* went in at an odd time.
 */
const offHours: Test = {
  key: "off_hours",
  label: "Weekend and out-of-hours postings",
  async run(ctx) {
    // The UAE weekend has been Saturday and Sunday since January 2022. Entry
    // dates are stored as plain dates at UTC midnight, so the day of the week
    // is a property of the date somebody chose and not of any clock.
    const weekend = ctx.entries.filter((e) => {
      const d = e.entryDate.getUTCDay();
      return d === 0 || d === 6;
    });

    const localHour = (d: Date) => (d.getUTCHours() + UTC_OFFSET_HOURS) % 24;
    const late = ctx.entries.filter((e) => {
      const h = localHour(e.createdAt);
      return h < WORK_START_LOCAL || h >= WORK_END_LOCAL;
    });

    const findings: Finding[] = [];
    if (weekend.length > 0) {
      findings.push({
        key: "weekend_dated",
        severity: "low",
        title: `${plural(weekend.length, "entry is", "entries are")} dated at a weekend`,
        detail:
          `${weekend.length} of ${ctx.entries.length} entries are dated on a Saturday or a Sunday, ` +
          `${money(total(weekend), ctx.currency)} in all. This is the date the entry claims, which a person chose ` +
          `and could have chosen at any time — it is not when the entry was keyed. Many businesses here trade at ` +
          `the weekend and the answer is usually "yes, we did"; what is worth a second look is a weekend date on ` +
          `an entry that is unusual for some other reason too.` +
          trailer(weekend.length),
        count: weekend.length,
        amountMinor: total(weekend).toString(),
        entries: listed(weekend),
      });
    }
    if (late.length > 0) {
      findings.push({
        key: "out_of_hours",
        severity: "low",
        title: `${plural(late.length, "entry", "entries")} reached the ledger outside working hours`,
        detail:
          `${late.length} of ${ctx.entries.length} entries were written to the database before ` +
          `${WORK_START_LOCAL}:00 or after ${WORK_END_LOCAL}:00 Gulf Standard Time, ` +
          `${money(total(late), ctx.currency)} in all. Unlike the entry date, this clock cannot be chosen or ` +
          `backdated — it is when the row arrived. A month-end close runs late and a scheduled integration posts ` +
          `whenever it is scheduled, so check who or what posted these before reading anything into the hour.` +
          trailer(late.length),
        count: late.length,
        amountMinor: total(late).toString(),
        entries: listed(late),
      });
    }

    const { from, to } = span(ctx.entries);
    return {
      findings,
      population: ctx.entries.length,
      from,
      to,
      note:
        findings.length > 0
          ? undefined
          : `Ran over ${plural(ctx.entries.length, "entry", "entries")}: none is dated at a weekend and every one ` +
            `reached the ledger between ${WORK_START_LOCAL}:00 and ${WORK_END_LOCAL}:00 Gulf Standard Time.`,
    };
  },
};

/**
 * Entries keyed into a month long after that month ended.
 *
 * The lag is measured from the end of the period the entry landed in to the
 * moment the row reached the database, because those are the two facts nobody
 * can choose after the event. A long lag is not wrong — accruals, a supplier
 * invoice that arrived in March for February, an auditor's adjustment — but it
 * is the shape a late adjustment has, and a set of books where the lag is
 * routinely long is a set of books whose monthly numbers were never final when
 * they were read.
 *
 * Year-end adjustment periods are excluded. They overlap the last trading month
 * on purpose and are posted to months after the year has ended by design, so
 * counting them would fill this list with the one case where the answer is
 * always "yes, that is what it is for".
 */
const latePostings: Test = {
  key: "late_posting",
  label: "Entries keyed after their month ended",
  async run(ctx) {
    const dated = ctx.entries.filter((e) => e.periodEndsOn !== null && !e.periodIsAdjustment);
    const { from, to } = span(dated);

    const lagOf = (e: LoadedEntry) => daysBetween(e.periodEndsOn as Date, e.createdAt);
    const late = dated.filter((e) => lagOf(e) > LATE_DAYS);

    if (late.length === 0) {
      return {
        findings: [],
        population: dated.length,
        from,
        to,
        note:
          `Ran over ${plural(dated.length, "entry", "entries")} in ordinary months and found none keyed more than ` +
          `${LATE_DAYS} days after the month it was posted into had ended.`,
      };
    }

    const worst = late.reduce((a, e) => (lagOf(e) > lagOf(a) ? e : a), late[0]);
    const worstLag = lagOf(worst);

    return {
      findings: [
        {
          key: "late_posting",
          severity: worstLag > LATE_ADJUSTMENT_DAYS ? "medium" : "low",
          title: `${plural(late.length, "entry was", "entries were")} keyed after the month had ended`,
          detail:
            `${late.length} of ${dated.length} entries reached the ledger more than ${LATE_DAYS} days after the ` +
            `end of the month they were posted into, ${money(total(late), ctx.currency)} in all. The longest is ` +
            `${worst.reference}, posted into ${worst.periodLabel ?? "its period"} and written ` +
            `${plural(worstLag, "day", "days")} after that month ended. Late is not wrong — an accrual and a ` +
            `supplier invoice that arrived in the next month both look like this — but every one of these changed ` +
            `a month's numbers after somebody may already have read them.` +
            trailer(late.length),
          count: late.length,
          amountMinor: total(late).toString(),
          entries: listed(late),
        },
      ],
      population: dated.length,
      from,
      to,
    };
  },
};

/**
 * Large manual journals with nothing written on them.
 *
 * An unexplained large manual journal is the first thing an auditor asks about,
 * and the memo is the only place in the ledger where the answer could have been
 * left. Everything posted from a subledger carries its document, so this is
 * about the entries somebody typed: the ones with no invoice behind them, no
 * rule that raised them, and now no sentence saying why.
 */
const unexplainedJournals: Test = {
  key: "unexplained_journal",
  label: "Large manual journals with no memo",
  async run(ctx) {
    const unit = majorUnit(ctx.currency);
    const floor = UNEXPLAINED_MIN_MAJOR * unit;
    const loud = floor * UNEXPLAINED_LOUD_MULTIPLE;

    const manual = ctx.entries.filter((e) => e.source === "manual");
    const { from, to } = span(manual);
    const bare = manual.filter((e) => (e.memo ?? "").trim() === "" && e.amountMinor >= floor);

    if (bare.length === 0) {
      return {
        findings: [],
        population: manual.length,
        from,
        to,
        note:
          `Ran over ${plural(manual.length, "manual journal", "manual journals")} and found none above ` +
          `${money(floor, ctx.currency)} without a memo — every large one says what it is for.`,
      };
    }

    const biggest = bare.reduce((a, e) => (e.amountMinor > a.amountMinor ? e : a), bare[0]);
    return {
      findings: [
        {
          key: "unexplained_journal",
          severity: biggest.amountMinor >= loud ? "high" : "medium",
          title: `${plural(bare.length, "manual journal", "manual journals")} above ${money(floor, ctx.currency)} say nothing`,
          detail:
            `${bare.length} of ${manual.length} manual journals are ${money(floor, ctx.currency)} or more and ` +
            `carry no memo at all, ${money(total(bare), ctx.currency)} in all. The largest is ` +
            `${biggest.reference}, ${money(biggest.amountMinor, ctx.currency)} dated ${isoDay(biggest.entryDate)}. ` +
            `Nothing else in the ledger can supply the reason: there is no document behind a manual journal and no ` +
            `rule that raised it, so the memo was the only place the explanation could have gone. A posted entry ` +
            `is never edited, so the answer belongs in an attachment or in the note on the correcting entry.` +
            trailer(bare.length),
          count: bare.length,
          amountMinor: total(bare).toString(),
          entries: listed(bare),
        },
      ],
      population: manual.length,
      from,
      to,
    };
  },
};

/**
 * Account pairings this ledger rarely makes.
 *
 * Every entry is characterised by one pairing: the account carrying its largest
 * debit against the account carrying its largest credit. That is a summary and
 * not the entry — a five-line entry has more in it than one pairing — but it is
 * the pairing that says what the entry was *for*, and taking every combination
 * of every line instead would drown the count in VAT and rounding lines.
 *
 * "Rare" is counted against this entity's own history and nothing else. There
 * is no table here of pairings that are suspicious in general, because there is
 * no such table: debiting drawings and crediting the company bank is a fraud in
 * one business and a partner's monthly distribution in the next. What can be
 * said is that this ledger has made this pairing twice in its life, and the
 * reader can decide whether that is interesting.
 *
 * Below `PAIRING_MIN_HISTORY` entries the test refuses. In a young ledger every
 * pairing is rare, so "rare" would mean "recently opened" and the screen would
 * be a list of ordinary first-time transactions.
 */
const rarePairings: Test = {
  key: "rare_pairings",
  label: "Unusual account pairings",
  async run(ctx) {
    const { from, to } = span(ctx.entries);
    if (ctx.entries.length < PAIRING_MIN_HISTORY) {
      return {
        findings: [],
        population: ctx.entries.length,
        from,
        to,
        skipped:
          `${plural(ctx.entries.length, "entry is", "entries are")} not enough of this entity's own history for ` +
          `"rare" to mean anything — below ${PAIRING_MIN_HISTORY} entries almost every pairing is rare, and the ` +
          `test would report a young ledger rather than an unusual one. Nothing is claimed either way.`,
      };
    }

    const pairingOf = (e: LoadedEntry): string | null => {
      let debit: LoadedLine | null = null;
      let credit: LoadedLine | null = null;
      for (const l of e.lines) {
        if (l.amountMinor > 0n && (debit === null || l.amountMinor > debit.amountMinor)) debit = l;
        if (l.amountMinor < 0n && (credit === null || l.amountMinor < credit.amountMinor)) credit = l;
      }
      if (!debit || !credit) return null;
      const d = ctx.accounts.get(debit.accountId);
      const c = ctx.accounts.get(credit.accountId);
      if (!d || !c) return null;
      return `${d.code}>${c.code}`;
    };

    const byPairing = new Map<string, LoadedEntry[]>();
    for (const e of ctx.entries) {
      const p = pairingOf(e);
      if (!p) continue;
      const list = byPairing.get(p) ?? [];
      list.push(e);
      byPairing.set(p, list);
    }

    const rare = [...byPairing.entries()]
      .filter(([, list]) => list.length <= PAIRING_RARE_MAX)
      .sort((a, b) => {
        const d = total(b[1]) - total(a[1]);
        return d > 0n ? 1 : d < 0n ? -1 : a[0].localeCompare(b[0]);
      });

    const counted = [...byPairing.values()].reduce((a, l) => a + l.length, 0);
    const findings: Finding[] = rare.slice(0, MAX_RARE_PAIRINGS).map(([pairing, list]): Finding => {
      const [debitCode, creditCode] = pairing.split(">");
      const debit = [...ctx.accounts.values()].find((a) => a.code === debitCode);
      const credit = [...ctx.accounts.values()].find((a) => a.code === creditCode);
      const allManual = list.every((e) => e.source === "manual");
      return {
        key: `rare_pairing:${pairing}`,
        // A rare pairing arriving from a subledger is the subledger doing
        // something it rarely does, which is usually a rare kind of trade. A
        // rare pairing typed by hand is a person doing something they rarely
        // do, and that is the one worth reading.
        severity: allManual ? "medium" : "low",
        title: `${debitCode} against ${creditCode}: ${plural(list.length, "entry", "entries")} in this ledger`,
        detail:
          `Debiting ${debitCode} ${debit?.name ?? ""} against crediting ${creditCode} ${credit?.name ?? ""} has ` +
          `happened ${plural(list.length, "time", "times")} in the ${counted} entries read, ` +
          `${money(total(list), ctx.currency)} in all` +
          (allManual ? `, and every one was typed by hand rather than raised from a document. ` : `. `) +
          `Rarity is measured against this entity's own history and nothing else — there is no list here of ` +
          `pairings that are wrong in general, because a pairing that is a fraud in one business is a routine ` +
          `posting in the next. What this says is only that these books hardly ever do this.`,
        count: list.length,
        amountMinor: total(list).toString(),
        entries: listed(list),
      };
    });

    return {
      findings,
      population: counted,
      from,
      to,
      note:
        findings.length === 0
          ? `Ran over ${plural(counted, "entry", "entries")} and found no debit-credit pairing used ` +
            `${PAIRING_RARE_MAX} times or fewer: every combination in these books is one they make regularly.`
          : `${plural(rare.length, "pairing occurs", "pairings occur")} ${PAIRING_RARE_MAX} times or fewer in the ` +
            `${counted} entries read` +
            (rare.length > MAX_RARE_PAIRINGS ? `; the ${MAX_RARE_PAIRINGS} largest are shown.` : "."),
    };
  },
};

/**
 * Gaps and reuse in the document numbering.
 *
 * The ledger numbers gaplessly by construction. `gl_next_number` allocates
 * inside the posting transaction and holds the sequence row's lock to commit,
 * so a rolled-back posting returns its number rather than burning it — which is
 * exactly what an ordinary Postgres SEQUENCE would not do. That is the claim,
 * and this test exists to prove it rather than to assume it.
 *
 * The proof is the sequence's own counter. `DocumentSequence.nextNo - 1` is how
 * many numbers have ever been handed out for a series; the entries are how many
 * came back. If a number was allocated and no entry carries it, something was
 * removed from the ledger outside the posting path — a hand-run DELETE, a
 * partial restore — because nothing inside the posting path can produce that.
 * Comparing the entries against themselves could never find this: a set of
 * numbers with a hole in it looks exactly like a set of numbers that stopped
 * one short.
 *
 * This is the one test that reads the whole ledger rather than the window. A
 * gap is a fact about the numbering, and the numbering has no dates.
 */
const numbering: Test = {
  key: "numbering",
  label: "Document numbering",
  async run(ctx) {
    const [rows, sequences] = await Promise.all([
      prisma.journalEntry.findMany({
        where: { orgId: ctx.orgId, entityId: ctx.entityId },
        // Numbers only. The amounts and memos behind a reused number are
        // fetched afterwards, for the handful of entries that turn out to have
        // one — the alternative is dragging every line in the ledger through
        // this query to describe a finding that is almost never there.
        select: { id: true, series: true, number: true, entryDate: true },
        orderBy: [{ series: "asc" }, { number: "asc" }],
      }),
      prisma.documentSequence.findMany({
        where: { orgId: ctx.orgId, entityId: ctx.entityId },
        select: { scope: true, prefix: true, nextNo: true, padding: true },
      }),
    ]);
    const sequenceFor = new Map(sequences.map((s) => [s.scope, s]));

    const from = rows.length === 0 ? null : isoDay(rows.reduce((a, r) => (r.entryDate < a ? r.entryDate : a), rows[0].entryDate));
    const to = rows.length === 0 ? null : isoDay(rows.reduce((a, r) => (r.entryDate > a ? r.entryDate : a), rows[0].entryDate));

    if (rows.length === 0) {
      return { findings: [], population: 0, from, to, skipped: "Nothing has been posted, so there is no numbering to check." };
    }

    const findings: Finding[] = [];
    const bySeries = new Map<string, Map<number, string[]>>();
    const unparsed: string[] = [];

    for (const r of rows) {
      const seq = sequenceFor.get(r.series);
      const digits = seq && seq.prefix && r.number.startsWith(seq.prefix) ? r.number.slice(seq.prefix.length) : r.number;
      if (!/^\d+$/.test(digits)) {
        unparsed.push(`${r.series}-${r.number}`);
        continue;
      }
      const n = Number(digits);
      const held = bySeries.get(r.series) ?? new Map<number, string[]>();
      held.set(n, [...(held.get(n) ?? []), r.id]);
      bySeries.set(r.series, held);
    }

    const missingBySeries: string[] = [];
    const reusedIds: string[] = [];
    const reusedLabels: string[] = [];
    let sequenceless = 0;

    for (const [series, held] of bySeries) {
      const seq = sequenceFor.get(series);
      const pad = (n: number) => `${series}-${seq?.prefix ?? ""}${String(n).padStart(seq?.padding ?? 5, "0")}`;

      for (const [n, ids] of held) if (ids.length > 1) {
        reusedIds.push(...ids);
        reusedLabels.push(pad(n));
      }

      if (!seq) {
        // No counter to check against. Saying so is the honest answer; deriving
        // the expected range from the entries themselves would make the test
        // agree with whatever the entries happen to be.
        sequenceless++;
        continue;
      }
      const allocated = seq.nextNo - 1;
      let missing = 0;
      const shown: string[] = [];
      for (let n = 1; n <= allocated; n++) {
        if (held.has(n)) continue;
        missing++;
        if (shown.length < 12) shown.push(pad(n));
      }
      if (missing > 0) {
        missingBySeries.push(
          `${series}: ${plural(missing, "number", "numbers")} allocated and never seen again ` +
            `(${shown.join(", ")}${missing > shown.length ? ", …" : ""}), out of ${allocated} allocated`,
        );
      }
    }

    if (missingBySeries.length > 0) {
      findings.push({
        key: "numbering_gap",
        severity: "high",
        title: "Numbers were allocated and no entry carries them",
        detail:
          `${missingBySeries.join("; ")}. The sequence hands numbers out inside the posting transaction and holds ` +
          `its row lock to commit, so a posting that fails returns its number instead of burning it — a gap ` +
          `cannot be produced by posting, or by a rollback, or by a concurrent write. The only way to make one is ` +
          `to remove an entry from the ledger outside the posting path, and nothing in this product does that: ` +
          `corrections are reversals, which add an entry rather than removing one. Find out what was deleted and ` +
          `by what, because every report drawn over this period is missing whatever it said. The entries behind ` +
          `this finding are the ones that are not there, which is why none are listed.`,
        count: missingBySeries.length,
        entries: [],
      });
    }

    if (reusedIds.length > 0) {
      const detail = await prisma.journalEntry.findMany({
        where: { orgId: ctx.orgId, entityId: ctx.entityId, id: { in: reusedIds } },
        select: { id: true, series: true, number: true, entryDate: true, memo: true, lines: { select: { functionalAmountMinor: true } } },
      });
      findings.push({
        key: "numbering_reuse",
        severity: "high",
        title: "The same number is on more than one entry",
        detail:
          `${reusedLabels.join(", ")} ${reusedLabels.length === 1 ? "is" : "are"} carried by more than one entry. ` +
          `The sequence never returns a number twice, so these were not both numbered by it. A reference that ` +
          `names two entries makes every cross-reference in the books ambiguous — a reversal, an attachment, an ` +
          `audit note — and until it is resolved nobody can say which entry a document refers to.`,
        count: reusedLabels.length,
        amountMinor: detail
          .reduce((a, r) => a + r.lines.reduce((s, l) => s + (l.functionalAmountMinor > 0n ? l.functionalAmountMinor : 0n), 0n), 0n)
          .toString(),
        entries: detail.map((r) => ({
          id: r.id,
          reference: refOf(r),
          date: isoDay(r.entryDate),
          memo: r.memo,
          amountMinor: r.lines
            .reduce((s, l) => s + (l.functionalAmountMinor > 0n ? l.functionalAmountMinor : 0n), 0n)
            .toString(),
        })),
      });
    }

    const caveats: string[] = [];
    if (sequenceless > 0) {
      caveats.push(
        `${plural(sequenceless, "series has", "series have")} no sequence counter to check against, so ` +
          `${sequenceless === 1 ? "it was" : "they were"} checked for reuse only`,
      );
    }
    if (unparsed.length > 0) {
      caveats.push(`${plural(unparsed.length, "number", "numbers")} are not numeric and were not checked (${unparsed.slice(0, 5).join(", ")})`);
    }

    return {
      findings,
      population: rows.length,
      from,
      to,
      note:
        findings.length > 0
          ? undefined
          : `Every number the sequence has ever handed out is on exactly one entry: ` +
            `${plural(rows.length, "entry", "entries")} across ` +
            `${plural(bySeries.size, "series", "series")}, no gaps and no reuse. This is what the gapless ` +
            `guarantee is supposed to produce, and it has now been checked against the sequence's own counter ` +
            `rather than assumed` +
            (caveats.length > 0 ? ` — ${caveats.join("; ")}.` : "."),
    };
  },
};

/**
 * People posting outside their own pattern.
 *
 * Measured per actor against that actor's own median entry, never against the
 * ledger's. A director who posts four entries a year, all of them large, is not
 * an outlier; a clerk who posts fifty small entries a month and then posts one
 * a hundred times bigger is worth a question, and only their own history can
 * tell the two apart.
 *
 * The median rather than the mean, because the mean of a set with one outlier
 * in it has already been moved by the outlier — that is the whole difficulty
 * with this kind of test, and a mean would quietly raise the bar it is
 * measuring against every time it found something.
 */
const actorOutliers: Test = {
  key: "actor_outliers",
  label: "Postings outside an actor's usual size",
  async run(ctx) {
    const attributed = ctx.entries.filter((e) => e.actorId !== null && e.amountMinor > 0n);
    const { from, to } = span(attributed);

    const byActor = new Map<string, LoadedEntry[]>();
    for (const e of attributed) {
      const list = byActor.get(e.actorId as string) ?? [];
      list.push(e);
      byActor.set(e.actorId as string, list);
    }

    const eligible = [...byActor.entries()].filter(([, list]) => list.length >= ACTOR_MIN_ENTRIES);
    if (eligible.length === 0) {
      return {
        findings: [],
        population: attributed.length,
        from,
        to,
        skipped:
          `No actor has posted the ${ACTOR_MIN_ENTRIES} entries needed before "their usual size" is a thing that ` +
          `exists. ${attributed.length === 0 ? "No entry read carries an actor at all." : `${plural(byActor.size, "actor has", "actors have")} posted here, none of them enough.`} ` +
          `A threshold taken off three entries would flag the largest of the three every time.`,
      };
    }

    const findings: Finding[] = [];
    for (const [actorId, list] of eligible.sort((a, b) => a[0].localeCompare(b[0]))) {
      const median = medianOf(list.map((e) => e.amountMinor));
      if (median <= 0n) continue;
      const bar = median * ACTOR_OUTLIER_MULTIPLE;
      const over = list.filter((e) => e.amountMinor >= bar);
      if (over.length === 0) continue;

      findings.push({
        key: `actor_outlier:${actorId}`,
        severity: "medium",
        title: `${actorId} posted ${plural(over.length, "entry", "entries")} far above their usual size`,
        detail:
          `${actorId} has posted ${plural(list.length, "entry", "entries")} in the entries read, with a median of ` +
          `${money(median, ctx.currency)}. ${plural(over.length, "of them is", "of them are")} at least ` +
          `${ACTOR_OUTLIER_MULTIPLE} times that — ${money(bar, ctx.currency)} or more, ` +
          `${money(total(over), ctx.currency)} in all. The comparison is against this actor's own history and no ` +
          `one else's, so nothing here says the entry is large in absolute terms; it says this is not the kind of ` +
          `entry this actor usually posts, which is a question about authority and review rather than about the ` +
          `amount.` +
          trailer(over.length),
        count: over.length,
        amountMinor: total(over).toString(),
        entries: listed(over),
      });
    }

    return {
      findings,
      population: attributed.length,
      from,
      to,
      note:
        findings.length === 0
          ? `Ran over ${plural(attributed.length, "attributed entry", "attributed entries")} from ` +
            `${plural(eligible.length, "actor", "actors")} with enough history to compare against, and found none ` +
            `posting ${ACTOR_OUTLIER_MULTIPLE} times their own median.`
          : undefined,
    };
  },
};

/** Integer median. An even-sized set takes the midpoint of the two middle values, truncated. */
function medianOf(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
}

/**
 * Manual journals against a control account.
 *
 * `post()` refuses these: a control account is owned by its subledger, and a
 * manual journal against trade receivables makes the ageing and the balance
 * disagree with no way to tell which is right. So the expected result of this
 * test is none, every time, and finding none is the point rather than an
 * absence of information.
 *
 * It is here for the case the refusal did not cover. A row inserted by hand, a
 * restore from a backup taken before the guard existed, a migration that moved
 * lines between accounts — none of those go through `post()`, and each of them
 * would leave exactly this trace. A guard nobody checks is a claim; this is the
 * check that turns it into evidence.
 */
const manualToControl: Test = {
  key: "manual_to_control",
  label: "Manual journals against control accounts",
  async run(ctx) {
    const manual = ctx.entries.filter((e) => e.source === "manual");
    const { from, to } = span(manual);

    const offenders = manual.filter((e) => e.lines.some((l) => ctx.accounts.get(l.accountId)?.isControl === true));

    if (offenders.length === 0) {
      return {
        findings: [],
        population: manual.length,
        from,
        to,
        note:
          `Ran over ${plural(manual.length, "manual journal", "manual journals")} and found none touching a control ` +
          `account, which is the expected result: posting refuses them outright. The check is here so that ` +
          `"the software will not let that happen" is something that has been tested rather than something that ` +
          `has been said.`,
      };
    }

    const codes = [
      ...new Set(
        offenders.flatMap((e) =>
          e.lines.map((l) => ctx.accounts.get(l.accountId)).filter((a) => a?.isControl).map((a) => `${a!.code} ${a!.name}`),
        ),
      ),
    ];

    return {
      findings: [
        {
          key: "manual_to_control",
          severity: "high",
          title: "A manual journal has touched a control account",
          detail:
            `${plural(offenders.length, "manual journal touches", "manual journals touch")} ${codes.join(", ")}, ` +
            `${money(total(offenders), ctx.currency)} in all. Posting refuses this — a control account is ` +
            `maintained by its subledger and a manual journal against it makes the ageing and the balance ` +
            `disagree with nothing to say which is right — so these did not arrive through the posting path. ` +
            `Find out what wrote them before correcting anything: the same route is presumably still open.` +
            trailer(offenders.length),
          count: offenders.length,
          amountMinor: total(offenders).toString(),
          entries: listed(offenders),
        },
      ],
      population: manual.length,
      from,
      to,
    };
  },
};

/**
 * Declaration order is display order within a severity, so a row does not move
 * between refreshes. It runs from the tests whose findings are money through
 * the tests whose findings are questions to the tests that are prompts.
 */
const TESTS: Test[] = [
  duplicatePayments,
  numbering,
  manualToControl,
  unexplainedJournals,
  latePostings,
  actorOutliers,
  rarePairings,
  roundNumbers,
  offHours,
  benfordTest,
];

/* ---------------------------------------------------------------- runner --- */

export async function ledgerAnalytics(opts: {
  orgId: string;
  entityId: string;
  /** Omit for everything the ledger holds, subject to `MAX_ENTRIES`. */
  from?: Date | string;
  /** Defaults to today. Passing both makes the whole read reproducible. */
  to?: Date | string;
}): Promise<LedgerAnalytics> {
  const from = asDate(opts.from, "The window this ledger is read over");
  const to = asDate(opts.to, "The window this ledger is read over") ?? new Date();
  if (from && from > to) {
    throw new LedgerError(`${isoDay(from)} is after ${isoDay(to)}. Check which way round the dates went in.`);
  }

  // The book is read for its currency alone, and its absence is not a finding:
  // an entity with no ledger open has nothing to analyse, and every test will
  // say so on its own row.
  const currency = await prisma.book
    .findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
      select: { functionalCurrency: true },
    })
    .then((b) => b?.functionalCurrency ?? "AED")
    .catch(() => "AED");

  const [rows, accountRows] = await Promise.all([
    prisma.journalEntry.findMany({
      where: {
        orgId: opts.orgId,
        entityId: opts.entityId,
        // Drafts are not the posted ledger. A reversed entry is: it was posted,
        // it is still there, and the tests that care filter it themselves.
        status: { in: ["posted", "reversed"] },
        entryDate: { ...(from ? { gte: from } : {}), lte: to },
      },
      // Newest first so a truncated read keeps the recent ledger, which is
      // where a defect introduced by a change would show up.
      orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
      take: MAX_ENTRIES + 1,
      select: {
        id: true, series: true, number: true, entryDate: true, createdAt: true, memo: true,
        source: true, sourceType: true, sourceId: true, settlesId: true,
        actorId: true, actorType: true, status: true, reversalOfId: true,
        period: { select: { label: true, endsOn: true, isAdjustment: true } },
        reversals: { select: { id: true }, take: 1 },
        lines: { select: { accountId: true, functionalAmountMinor: true } },
      },
    }),
    prisma.account.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId },
      select: { id: true, code: true, name: true, type: true, subtype: true, isControl: true },
    }),
  ]);

  const truncated = rows.length > MAX_ENTRIES;
  const entries: LoadedEntry[] = rows
    .slice(0, MAX_ENTRIES)
    .map((r) => ({
      id: r.id,
      reference: refOf(r),
      entryDate: r.entryDate,
      createdAt: r.createdAt,
      memo: r.memo,
      source: r.source,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      settlesId: r.settlesId,
      actorId: r.actorId,
      actorType: r.actorType,
      status: r.status,
      reversalOfId: r.reversalOfId,
      reversed: r.reversals.length > 0,
      periodLabel: r.period?.label ?? null,
      periodEndsOn: r.period?.endsOn ?? null,
      periodIsAdjustment: r.period?.isAdjustment ?? false,
      amountMinor: r.lines.reduce((a, l) => a + (l.functionalAmountMinor > 0n ? l.functionalAmountMinor : 0n), 0n),
      lines: r.lines.map((l) => ({ accountId: l.accountId, amountMinor: l.functionalAmountMinor })),
    }))
    // Oldest first: date clustering and pairing history both read forwards.
    .reverse();

  const accounts = new Map<string, AccountInfo>(accountRows.map((a) => [a.id, a] as [string, AccountInfo]));
  const benford = benfordOf(entries.filter((e) => e.amountMinor > 0n).map((e) => e.amountMinor));
  const ctx: Ctx = { orgId: opts.orgId, entityId: opts.entityId, currency, entries, accounts, benford };
  const window = span(entries);

  // allSettled, not all: one test throwing must cost its own row and nothing
  // else, exactly as on the attention list. A screen that goes blank because a
  // chart was edited by hand is the failure mode this whole module exists to
  // avoid.
  const results = await Promise.allSettled(TESTS.map((t) => t.run(ctx)));

  const findings: { finding: Finding; order: number }[] = [];
  const runs: TestRun[] = [];

  results.forEach((r, i) => {
    const test = TESTS[i];
    if (r.status === "rejected") {
      const e: unknown = r.reason;
      // Only a message somebody wrote for a reader is shown; anything else
      // could be a driver or a constraint name, and an audit screen is not the
      // place to leak one.
      runs.push({
        key: test.key,
        label: test.label,
        outcome: "failed",
        population: 0,
        from: null,
        to: null,
        note:
          e instanceof LedgerError
            ? e.message
            : e instanceof Error && /does not exist|No ledger has been opened|No accounting period/i.test(e.message)
              ? e.message
              : "This test could not be run against these books.",
      });
      return;
    }

    const value = r.value;
    for (const f of value.findings) findings.push({ finding: f, order: i });
    runs.push({
      key: test.key,
      label: test.label,
      outcome: value.skipped ? "skipped" : value.findings.length > 0 ? "found" : "clean",
      population: value.population,
      from: value.from,
      to: value.to,
      note:
        value.skipped ??
        value.note ??
        (value.findings.length > 0
          ? `${plural(value.findings.length, "finding", "findings")} over ` +
            `${plural(value.population, "entry", "entries")}` +
            (value.from ? ` dated ${value.from} to ${value.to}.` : ".")
          : `Ran over ${plural(value.population, "entry", "entries")}` +
            (value.from ? ` dated ${value.from} to ${value.to}` : "") +
            ` and found nothing.`),
    });
  });

  // Severity first, then the money at stake, then declaration order so the
  // list is stable when two findings are worth the same.
  findings.sort((a, b) => {
    const bySeverity = RANK[a.finding.severity] - RANK[b.finding.severity];
    if (bySeverity !== 0) return bySeverity;
    const av = BigInt(a.finding.amountMinor ?? "0");
    const bv = BigInt(b.finding.amountMinor ?? "0");
    if (av !== bv) return bv > av ? 1 : -1;
    return a.order - b.order || a.finding.key.localeCompare(b.finding.key);
  });
  const ordered = findings.map((f) => f.finding);

  return {
    entityId: opts.entityId,
    currency,
    from: from ? isoDay(from) : null,
    to: isoDay(to),
    population: entries.length,
    populationFrom: window.from,
    populationTo: window.to,
    truncated,
    findings: ordered,
    runs,
    counts: {
      high: ordered.filter((f) => f.severity === "high").length,
      medium: ordered.filter((f) => f.severity === "medium").length,
      low: ordered.filter((f) => f.severity === "low").length,
    },
    benford,
    checked: TESTS.length,
  };
}
