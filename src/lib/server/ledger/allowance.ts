import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { post, LedgerError } from "./post";
import { receivablesAgeing } from "./ar";

/**
 * The allowance for doubtful debts — IFRS 9's simplified approach, as a
 * provision matrix.
 *
 * Account 1150 was seeded, read by five modules and credited by none. So every
 * entity carried its trade receivables gross: the ageing showed debt nobody was
 * going to pay, profit was overstated by the whole unrecognised loss, and the
 * accounting policy note printed "no allowance for doubtful debts has been
 * recognised" under IFRS 9.5.5.15 — the paragraph that makes a LIFETIME
 * expected credit loss allowance mandatory on a trade receivable. A note that
 * cites the rule while describing the breach is worse than no note.
 *
 * IFRS 9.5.5.15 removes the choice. A trade receivable with no significant
 * financing component is always measured at lifetime expected credit losses;
 * there is no twelve-month stage, no "significant increase in credit risk"
 * test, and no waiting for evidence that a particular customer has gone. The
 * standard's own worked example (IFRS 9.B5.5.35) is a provision matrix: age the
 * debt, apply a loss rate to each band, and the sum is the allowance.
 *
 *   Dr  6700  Bad debt expense                  the movement, where it rises
 *     Cr  1150  Allowance for doubtful debts
 *
 * and the other way round where it falls.
 *
 * THE POSTING IS THE MOVEMENT, NEVER THE TARGET. The allowance is a position,
 * not a transaction: what belongs in this period's profit is the change in it.
 * Posting the target each time would charge the whole allowance again every
 * time the report was run. So the target is computed from the ageing, the
 * carrying balance on 1150 is read, and what is posted is the difference —
 * which makes running it twice on one date a no-op and running it at successive
 * reporting dates self-correcting, exactly as `borrowings.reclassifyCurrentPortion`
 * corrects to a target rather than posting an increment.
 *
 * THE LOSS RATES ARE THE ENTITY'S JUDGEMENT, NOT THIS MODULE'S. IFRS 9.B5.5.35
 * says the matrix is built from the entity's own historical loss experience,
 * adjusted for forward-looking information. Nothing here can know that, so the
 * rates are an argument. `DEFAULT_MATRIX` exists so a first run is possible at
 * all, and it is documented as a starting point rather than offered as a
 * measurement — the module says so on the entry and the disclosure repeats it.
 *
 * WHERE THE MATRIX IS RECORDED. There is no metadata column on a journal entry
 * and this module does not add one: a derived figure belongs in the query and
 * the judgement that produced it belongs on the entry that used it. So the
 * memo carries the whole matrix — every band, its rate, the balance it was
 * applied to and the loss it produced, then the target, the balance already
 * carried and the movement. An auditor asking "where does this number come
 * from" gets the answer from the ledger itself rather than from a screen that
 * recomputes it against today's ageing, which by then is a different ageing.
 */

const ALLOWANCE = "1150";
const TRADE_RECEIVABLES = "1100";

/**
 * The charge goes to 6700 "Bad debt expense" and not to 6650 "Impairment
 * losses".
 *
 * Both are defensible captions — IAS 1.82(ba) presents IFRS 9 impairment
 * losses as their own line — but 6650 is already the IAS 36 account for
 * writing a fixed asset down, and `equity.ts` decides whether to state an
 * impairment policy for property, plant and equipment by asking whether 6650
 * has moved. Charging expected credit losses there would make the accounts
 * claim assets had been written down in a year no asset was touched.
 *
 * It is also not 6260 "Bad debts written off", which is where `write-offs.ts`
 * charges a debt derecognised straight to expense. Raising an allowance and
 * losing a specific debt are different events and a reader needs to see which
 * of the two the year's charge was.
 */
const BAD_DEBT_EXPENSE = "6700";

/** The source and sourceType this module's entries carry, so they can be found again. */
export const ALLOWANCE_SOURCE = "allowance";
export const ALLOWANCE_SOURCE_TYPE = "ECL_ALLOWANCE";

/* ------------------------------------------------------------- the matrix */

/** The ageing bands, exactly as `receivablesAgeing` cuts them. */
export type AgeingBandKey = "current" | "d31_60" | "d61_90" | "d91_120" | "over120";

export const BAND_ORDER: AgeingBandKey[] = ["current", "d31_60", "d61_90", "d91_120", "over120"];

export const BAND_LABEL: Record<AgeingBandKey, string> = {
  current: "Not more than 30 days old",
  d31_60: "31 to 60 days old",
  d61_90: "61 to 90 days old",
  d91_120: "91 to 120 days old",
  over120: "More than 120 days old",
};

/**
 * A loss rate per band, in basis points.
 *
 * Basis points rather than a percentage, because a rate has to multiply a
 * minor-unit BigInt and a float cannot do that without rounding somewhere
 * nobody can see. 250 bps is 2.50%, and 10,000 bps is total loss.
 */
export type LossRates = Record<AgeingBandKey, number>;

/**
 * A starting matrix, and nothing more than that.
 *
 * These rates are not a measurement of any entity's credit experience and this
 * module has no way to make one — IFRS 9.B5.5.35 builds the matrix from the
 * entity's own history of what it collected, adjusted for what it expects. They
 * are here so the first run has something to run on and so the shape of the
 * argument is obvious. They rise with age because that is the one thing that is
 * true of every sales ledger: the older a debt, the less of it arrives.
 *
 * Whoever uses them owns them. The disclosure says they are the default until
 * somebody replaces them, because an assumed rate presented as a measured one
 * is precisely the kind of quiet claim this product refuses to make.
 */
export const DEFAULT_MATRIX: LossRates = {
  current: 50,      // 0.50%
  d31_60: 200,      // 2.00%
  d61_90: 500,      // 5.00%
  d91_120: 1_500,   // 15.00%
  over120: 5_000,   // 50.00%
};

/**
 * Whether the caller actually named a rate, rather than whether they passed an
 * object. `{ current: undefined }` is a form field left blank, and reporting it
 * as the preparer's judgement would put "loss rates set by the preparer" on an
 * entry nobody set a rate on.
 */
function anyRateSupplied(rates?: Partial<LossRates> | null): boolean {
  return BAND_ORDER.some((band) => rates?.[band] !== undefined && rates?.[band] !== null);
}

/** A rate in basis points as a percentage, for a label. 250 → "2.50%". */
export function ratePercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(Math.abs(bps % 100)).padStart(2, "0");
  return `${whole}.${frac}%`;
}

/**
 * A loss rate applied to an exposure, half-up on the fil, entirely in BigInt.
 *
 * Half-up rather than truncation because truncation biases every band the same
 * way, and five bands truncated downwards understate the allowance every time.
 */
function lossOn(exposure: bigint, rateBps: number): bigint {
  if (exposure <= 0n) return 0n;
  return (exposure * BigInt(rateBps) + 5_000n) / 10_000n;
}

/**
 * Check a caller's rates before anything is computed with them.
 *
 * A rate outside 0–10,000 bps is not a judgement this module can carry out: a
 * negative one would turn the allowance into an asset and one above 100% would
 * provide for more than the customer ever owed.
 */
export function normaliseRates(rates?: Partial<LossRates> | null): LossRates {
  const out = { ...DEFAULT_MATRIX };
  for (const band of BAND_ORDER) {
    const given = rates?.[band];
    if (given === undefined || given === null) continue;
    if (!Number.isInteger(given)) {
      throw new LedgerError(
        `The loss rate for "${BAND_LABEL[band]}" must be whole basis points — 250 for 2.50% — and ${given} is not.`,
      );
    }
    if (given < 0 || given > 10_000) {
      throw new LedgerError(
        `The loss rate for "${BAND_LABEL[band]}" must be between 0 and 10,000 basis points (0% and 100%), and ` +
          `${given} is not. A negative rate would make the allowance an asset; one above 100% would provide for ` +
          `more than the customer ever owed.`,
      );
    }
    out[band] = given;
  }
  return out;
}

/* ------------------------------------------------------------------ types */

export interface MatrixRow {
  band: AgeingBandKey;
  label: string;
  /** The band as the ageing cuts it, which can be negative where credits exceed invoices. */
  grossMinor: string;
  /**
   * What the rate is applied to: the gross, floored at nil.
   *
   * A band can be negative — `receivablesAgeing` deliberately leaves an
   * unapplied credit note in the report as a debit rather than netting it away
   * silently. A credit balance is money the entity owes, not an exposure to
   * credit loss, so it cannot produce an expected credit loss and it cannot be
   * allowed to reduce another band's. Both figures are shown so the difference
   * is visible rather than absorbed.
   */
  exposureMinor: string;
  rateBps: number;
  ratePercent: string;
  lossMinor: string;
}

export interface AllowanceMovementRow {
  entryId: string;
  reference: string;
  date: string;
  /** Positive where the allowance was raised, negative where it was released. */
  movementMinor: string;
  /** The matrix that produced it, as it was recorded on the entry. */
  memo: string;
}

export interface AllowanceView {
  asOf: string;
  currency: string;
  /** True where the caller's rates were used; false where the defaults stood in. */
  ratesSupplied: boolean;
  rates: LossRates;
  matrix: MatrixRow[];
  /** The ageing's own total — trade receivables before any allowance. */
  grossReceivablesMinor: string;
  /** The bands the matrix could be applied to, credit balances excluded. */
  exposureMinor: string;
  /** What the matrix says the allowance should be at this date. */
  targetMinor: string;
  /** The credit balance carried on 1150 at this date. */
  carriedMinor: string;
  /** Target less carried: positive is a charge to make, negative a release. */
  movementMinor: string;
  /** Receivables less the allowance the ledger actually carries, not the target. */
  netReceivablesMinor: string;
  /** The entry this date already carries, where the movement has been posted. */
  postedEntryId: string | null;
  postedReference: string | null;
  /** Every allowance movement this entity has posted, newest first. */
  history: AllowanceMovementRow[];
}

export interface AllowanceResult {
  asOf: string;
  posted: boolean;
  alreadyPosted: boolean;
  movementMinor: string;
  targetMinor: string;
  carriedMinor: string;
  entryId: string | null;
  reference: string | null;
  matrix: MatrixRow[];
  /** What happened, in a sentence, for a screen to show and a log to keep. */
  note: string;
}

/* -------------------------------------------------------------- utilities */

const asDate = (d: Date | string) => (typeof d === "string" ? new Date(`${d}T00:00:00.000Z`) : d);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * One key per entity per date, so a retry posts once.
 *
 * The date is in the key rather than the rates, and that is the deliberate
 * half: measuring the allowance twice on one reporting date with two different
 * matrices is not two events, it is one decision being changed. The second call
 * returns the first entry and says so rather than posting a top-up nobody
 * asked for. Reverse the entry to measure that date again.
 */
const externalKeyFor = (entityId: string, asOf: Date) => `allowance:${entityId}:${iso(asOf)}`;

/** The functional currency of the entity's primary book — what the memo quotes. */
async function currencyOf(orgId: string, entityId: string): Promise<string> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  if (!book) throw new LedgerError("No ledger has been opened for this entity, so there is nothing to provide against.");
  return book.functionalCurrency;
}

/**
 * The credit balance carried on 1150 at a date. A contra-asset, so a credit is
 * a positive allowance — the same sign convention `write-offs.ts` reads it
 * with, deliberately, so the two modules cannot disagree about what "the
 * allowance carried" means.
 */
async function carriedAllowance(opts: { orgId: string; entityId: string; asOf: Date }): Promise<bigint> {
  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: ALLOWANCE },
    select: { id: true },
  });
  if (!account) return 0n;
  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: account.id,
      // A reversed entry's lines are postings that happened; the reversing
      // entry is what offsets them. Counting only "posted" would keep the
      // reversal and drop the original, and the allowance would come out
      // wrong by the whole of it.
      entry: { orgId: opts.orgId, status: { in: ["posted", "reversed"] }, entryDate: { lte: opts.asOf } },
    },
    select: { functionalAmountMinor: true },
  });
  return lines.reduce((a, l) => a - l.functionalAmountMinor, 0n);
}

/** The matrix, from an ageing and a set of rates. Pure: it reads nothing. */
export function provisionMatrix(buckets: Record<string, string>, rates: LossRates): MatrixRow[] {
  return BAND_ORDER.map((band) => {
    const gross = BigInt(buckets[band] ?? "0");
    const exposure = gross > 0n ? gross : 0n;
    return {
      band,
      label: BAND_LABEL[band],
      grossMinor: gross.toString(),
      exposureMinor: exposure.toString(),
      rateBps: rates[band],
      ratePercent: ratePercent(rates[band]),
      lossMinor: lossOn(exposure, rates[band]).toString(),
    };
  });
}

/**
 * The matrix written out for the entry memo.
 *
 * Long, and deliberately so. This sentence is the audit evidence: it has to say
 * what was applied to what, at rates that may have changed since, on a ledger
 * that has certainly moved on. A reference to a screen would not survive the
 * next posting.
 */
function matrixNarrative(opts: {
  asOf: Date;
  currency: string;
  matrix: MatrixRow[];
  target: bigint;
  carried: bigint;
  ratesSupplied: boolean;
}): string {
  const money = (v: bigint) => fmtMinor(v, opts.currency, { sign: "minus", zero: "zero" });
  const bands = opts.matrix
    .map((r) => `${r.label} ${r.ratePercent} of ${money(BigInt(r.exposureMinor))} = ${money(BigInt(r.lossMinor))}`)
    .join("; ");
  const movement = opts.target - opts.carried;
  return (
    `Allowance for doubtful debts at ${iso(opts.asOf)} — IFRS 9.5.5.15 simplified approach, lifetime expected ` +
    `credit losses measured on a provision matrix. ` +
    `${opts.ratesSupplied ? "Loss rates set by the preparer" : "Loss rates left at the product default, which is a starting point and not a measurement of this entity's credit experience"}: ` +
    `${bands}. Target ${money(opts.target)} against ${money(opts.carried)} already carried on ${ALLOWANCE}; ` +
    `movement ${money(movement)}.`
  );
}

/** Every allowance movement this entity has posted, newest first. */
async function allowanceHistory(opts: { orgId: string; entityId: string }): Promise<AllowanceMovementRow[]> {
  const entries = await prisma.journalEntry.findMany({
    where: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      sourceType: ALLOWANCE_SOURCE_TYPE,
      status: { in: ["posted", "reversed"] },
    },
    orderBy: [{ entryDate: "desc" }, { number: "desc" }],
    select: {
      id: true, series: true, number: true, entryDate: true, memo: true,
      lines: { select: { functionalAmountMinor: true, account: { select: { code: true } } } },
    },
  });
  return entries.map((e) => ({
    entryId: e.id,
    reference: `${e.series}-${e.number}`,
    date: iso(e.entryDate),
    // Read off the allowance account's own line rather than assumed from the
    // expense side, so a reversal reads as the release it is.
    movementMinor: e.lines
      .filter((l) => l.account.code === ALLOWANCE)
      .reduce((a, l) => a - l.functionalAmountMinor, 0n)
      .toString(),
    memo: e.memo ?? "",
  }));
}

/* ----------------------------------------------------------- the read side */

/**
 * What the matrix says at a date, against what the ledger carries.
 *
 * Nothing is written. This is the figure a preparer looks at before deciding
 * whether the rates are right, and it is also what the credit-risk disclosure
 * is built from.
 */
export async function allowanceView(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date | string;
  rates?: Partial<LossRates> | null;
}): Promise<AllowanceView> {
  const asOf = opts.asOf ? asDate(opts.asOf) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    throw new LedgerError("An allowance is measured at a date, written like 2026-12-31.");
  }
  const rates = normaliseRates(opts.rates);

  const [currency, ageing, carried, history] = await Promise.all([
    currencyOf(opts.orgId, opts.entityId),
    receivablesAgeing({ orgId: opts.orgId, entityId: opts.entityId, asOf }),
    carriedAllowance({ orgId: opts.orgId, entityId: opts.entityId, asOf }),
    allowanceHistory({ orgId: opts.orgId, entityId: opts.entityId }),
  ]);

  const matrix = provisionMatrix(ageing.buckets, rates);
  const exposure = matrix.reduce((a, r) => a + BigInt(r.exposureMinor), 0n);
  const target = matrix.reduce((a, r) => a + BigInt(r.lossMinor), 0n);

  const posted = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey: externalKeyFor(opts.entityId, asOf) },
    select: { id: true, series: true, number: true },
  });

  return {
    asOf: iso(asOf),
    currency,
    ratesSupplied: anyRateSupplied(opts.rates),
    rates,
    matrix,
    grossReceivablesMinor: ageing.totalMinor,
    exposureMinor: exposure.toString(),
    targetMinor: target.toString(),
    carriedMinor: carried.toString(),
    movementMinor: (target - carried).toString(),
    netReceivablesMinor: (BigInt(ageing.totalMinor) - carried).toString(),
    postedEntryId: posted?.id ?? null,
    postedReference: posted ? `${posted.series}-${posted.number}` : null,
    history,
  };
}

/* ---------------------------------------------------------- the write side */

/**
 * Measure the allowance at a date and post the movement.
 *
 * Returns without posting where the ledger already carries the target — an
 * allowance that has not moved is not a journal entry, and posting a nil one
 * would be refused by `post()` anyway.
 */
export async function raiseAllowance(opts: {
  orgId: string;
  entityId: string;
  /** The reporting date the ageing is cut at and the entry is dated. */
  asOf: Date | string;
  /**
   * The loss rate per band, in basis points. Omitted bands fall back to
   * `DEFAULT_MATRIX`, which is a starting point rather than a measurement —
   * the entry says which of the two produced the figure.
   */
  rates?: Partial<LossRates> | null;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<AllowanceResult> {
  const asOf = asDate(opts.asOf);
  if (Number.isNaN(asOf.getTime())) {
    throw new LedgerError("An allowance is measured at a date, written like 2026-12-31.");
  }
  const rates = normaliseRates(opts.rates);
  const ratesSupplied = anyRateSupplied(opts.rates);
  const externalKey = externalKeyFor(opts.entityId, asOf);

  // Measured before the idempotency check rather than after it, so that the
  // "already posted" answer still states the target and the balance carried.
  // Returning nought for both would be this module asserting a position it had
  // not looked at, which is exactly the kind of quiet untruth the disclosure
  // above it exists to stop.
  const [currency, ageing, carried, already] = await Promise.all([
    currencyOf(opts.orgId, opts.entityId),
    receivablesAgeing({ orgId: opts.orgId, entityId: opts.entityId, asOf }),
    carriedAllowance({ orgId: opts.orgId, entityId: opts.entityId, asOf }),
    prisma.journalEntry.findFirst({
      where: { orgId: opts.orgId, externalKey },
      select: { id: true, series: true, number: true },
    }),
  ]);

  const matrix = provisionMatrix(ageing.buckets, rates);
  const target = matrix.reduce((a, r) => a + BigInt(r.lossMinor), 0n);
  const movement = target - carried;

  if (already) {
    return {
      asOf: iso(asOf),
      posted: false,
      alreadyPosted: true,
      // What THIS call posted, which is nothing. The positions beside it are
      // the real ones, read at this date.
      movementMinor: "0",
      targetMinor: target.toString(),
      carriedMinor: carried.toString(),
      entryId: already.id,
      reference: `${already.series}-${already.number}`,
      matrix,
      note:
        `The allowance at ${iso(asOf)} was already measured and posted as ${already.series}-${already.number}. ` +
        `Reverse that entry to measure this date again — a second matrix on one reporting date is a decision ` +
        `changed, not a further charge.`,
    };
  }

  if (movement === 0n) {
    return {
      asOf: iso(asOf),
      posted: false,
      alreadyPosted: false,
      movementMinor: "0",
      targetMinor: target.toString(),
      carriedMinor: carried.toString(),
      entryId: null,
      reference: null,
      matrix,
      note:
        target === 0n
          ? `The matrix produces no allowance at ${iso(asOf)} and none is carried, so there is nothing to post.`
          : `The allowance carried at ${iso(asOf)} is already the ${fmtMinor(target, currency, { sign: "minus", zero: "zero" })} ` +
            `the matrix asks for; nothing to post.`,
    };
  }

  const amount = movement > 0n ? movement : -movement;
  const rising = movement > 0n;

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: asOf,
    memo: matrixNarrative({ asOf, currency, matrix, target, carried, ratesSupplied }),
    // Not "manual": 1150 is not a control account, but this module owns the
    // measurement and the source is what lets the disclosure tell an expected
    // credit loss apart from a debt written off against the allowance.
    source: ALLOWANCE_SOURCE,
    sourceType: ALLOWANCE_SOURCE_TYPE,
    sourceId: iso(asOf),
    externalKey,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "AL",
    lines: rising
      ? [
          { account: BAD_DEBT_EXPENSE, debit: amount, memo: `Expected credit losses to ${iso(asOf)}` },
          { account: ALLOWANCE, credit: amount, memo: `Allowance raised to the matrix target at ${iso(asOf)}` },
        ]
      : [
          { account: ALLOWANCE, debit: amount, memo: `Allowance released to the matrix target at ${iso(asOf)}` },
          { account: BAD_DEBT_EXPENSE, credit: amount, memo: `Expected credit losses released at ${iso(asOf)}` },
        ],
  });

  const money = (v: bigint) => fmtMinor(v, currency, { sign: "minus", zero: "zero" });
  return {
    asOf: iso(asOf),
    posted: true,
    alreadyPosted: false,
    movementMinor: movement.toString(),
    targetMinor: target.toString(),
    carriedMinor: carried.toString(),
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    matrix,
    note:
      `${rising ? "Raised" : "Released"} ${money(amount)} so the allowance on ${ALLOWANCE} carries the ` +
      `${money(target)} the matrix measures at ${iso(asOf)}. Trade receivables on ${TRADE_RECEIVABLES} are ` +
      `${money(BigInt(ageing.totalMinor))} gross and ${money(BigInt(ageing.totalMinor) - target)} net of it.`,
  };
}
