import { prisma } from "@/lib/server/prisma";
import { post, LedgerError } from "./post";
import { periodRateBps } from "./leases";
import { addAccount } from "./chart";
import { balanceSheet, profitAndLoss } from "./statements";

/**
 * Loans and borrowings, measured at amortised cost under IFRS 9.
 *
 * This is the same arithmetic as the lease liability in `leases.ts` — an
 * effective-interest schedule that unwinds a liability to nil — pointed at a
 * bank facility instead of a contract for an asset. Where the two coincide they
 * agree to the fil, and the test proves it against `presentValue` from that
 * module.
 *
 * Two things make a borrowing different from a lease, and both matter:
 *
 *   1. **A lease's rate is a judgement; a loan's rate is a term of the
 *      contract.** IFRS 16.26 discounts at the incremental borrowing rate,
 *      which nobody can compute to better than a basis point, so `leases.ts`
 *      holds it as whole basis points and says so. A loan schedule has to
 *      reproduce the lender's own to the fil, and a rate rounded to a whole
 *      basis point does not: 5% a year over twelve monthly instalments is
 *      41.667 basis points a month, and charging 42 instead puts real money —
 *      not rounding — into the last instalment. So the periodic rate here is
 *      carried as an integer count of 1e-9 (see RATE_SCALE). It is still an
 *      integer; it is simply a finer one. No float goes anywhere near it.
 *
 *   2. **A flat-rate loan is not measured at its quoted rate.** "5% flat over
 *      three years" charges 5% of the ORIGINAL principal every year even though
 *      the borrower has already repaid most of it, which is why the effective
 *      rate on a UAE flat facility is close to twice the number on the offer
 *      letter. IFRS 9.5.4.1 measures a financial liability at amortised cost
 *      using the effective interest rate — Appendix A defines that as the rate
 *      that exactly discounts the contractual cash flows to the carrying
 *      amount — so the interest expense recognised here is the effective rate
 *      applied to the balance outstanding, not the flat allocation the bank
 *      prints on its repayment slip. The cash is the same; the split between
 *      interest and principal is not, and it is front-loaded.
 *
 * The quoted rate and the effective rate are both reported, always, because a
 * schedule showing only one of them cannot be checked against the offer letter
 * OR against the standard.
 *
 * What is deliberately NOT modelled, because guessing would be worse:
 *   • Arrangement fees, and any other transaction cost. IFRS 9.5.1.1 measures a
 *     liability initially at fair value MINUS the directly attributable
 *     transaction costs, which changes the effective rate. Nothing here nets a
 *     fee off the principal; a facility with fees has an effective rate higher
 *     than the one reported, and the fee has to be journalled separately.
 *   • Floating rates. The schedule is fixed at drawdown. A rate that moves is a
 *     new schedule, not a recompute, and IFRS 9.B5.4.5 revises the cash flows
 *     rather than the carrying amount.
 *   • Foreign-currency facilities. The currency is recorded, but a drawdown in
 *     anything but the book's own currency is refused: IAS 21.23(a) retranslates
 *     a monetary liability at every reporting date, and a register that did not
 *     would drift from the ledger every month.
 *   • Early settlement, refinancing and modification (IFRS 9.3.3.2).
 */

/* ------------------------------------------------------------------ accounts */

/**
 * Where the liability is recognised. 2500 "Long-term loans" already exists in
 * the seeded chart and is classified as a financing activity by `cashflow.ts`.
 */
export const BORROWINGS_ACCOUNT = "2500";

/**
 * The current portion — see `reclassifyCurrentPortion` for why this is posted
 * rather than only reported. It is 2450 and not, say, 2520 because the chart's
 * own numbering is what tells the statements which liabilities are current:
 * the summarised balance sheet in `layouts.ts` reads 2000–2499 as payables and
 * accruals and 2500–2999 as non-current liabilities. An account outside the
 * first band is a current liability nothing presents as one.
 *
 * It is not in the seeded chart in `setup.ts`; the migration adds it to books
 * already open, and `ensureCurrentPortionAccount` adds it to a book opened
 * since. Both are idempotent.
 */
export const BORROWINGS_CURRENT_ACCOUNT = "2450";

/**
 * IAS 1.82(b) presents finance costs separately from operating expenses, and
 * the Article 30 interest deduction limitation is computed on net interest
 * expenditure, which cannot be found if the interest is mixed in with bank
 * charges. 6360 exists for exactly that — the same account the lease liability
 * unwinds into.
 */
export const INTEREST_ACCOUNT = "6360";
export const CASH_ACCOUNT = "1010";

/* ------------------------------------------------------------------- rates */

/**
 * The denominator every periodic rate here is held over: a rate is an integer
 * count of 1e-9. 0.5% a month is 5_000_000 of them.
 *
 * Basis points are the unit a rate is QUOTED in and stored in — `statedRateBps`
 * and `effectiveRateBps` are both whole basis points, as the house rule
 * requires. This finer scale exists only inside the arithmetic, for the reason
 * in the header: a periodic rate rounded to a whole basis point does not
 * reproduce the lender's schedule.
 */
export const RATE_SCALE = 1_000_000_000n;

const BPS = 10_000n;

export type InterestBasis = "REDUCING" | "FLAT";
export type RepaymentFrequency = "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL";

/**
 * Months between instalments. Unlike `leases.ts`, which refuses anything but a
 * monthly schedule because its periodic run is built on calendar months,
 * nothing here runs by month — an instalment is posted by its number — so every
 * frequency a UAE facility is written on is supported.
 */
export const MONTHS_PER_PERIOD: Record<RepaymentFrequency, number> = {
  MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12,
};
export const PERIODS_PER_YEAR: Record<RepaymentFrequency, number> = {
  MONTHLY: 12, QUARTERLY: 4, SEMIANNUAL: 2, ANNUAL: 1,
};

/** Half-up on an exact fraction, sign-aware. Rounds once, at the end. */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new LedgerError("A rounding cannot divide by nothing.");
  const neg = numerator < 0n;
  const abs = neg ? -numerator : numerator;
  const out = (2n * abs + denominator) / (2n * denominator);
  return neg ? -out : out;
}

/** An annual rate in basis points as a rate per period, on the 1e-9 scale. */
export function nanoFromAnnualBps(annualBps: number, periodsPerYear: number): bigint {
  if (!Number.isInteger(annualBps) || annualBps < 0 || annualBps > 10_000) {
    throw new LedgerError(
      `An interest rate is a whole number of basis points between 0 and 10000; ${annualBps} is not. 5% a year is 500.`,
    );
  }
  if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0) {
    throw new LedgerError("Periods per year has to be a whole number greater than zero.");
  }
  // annualBps/10000 ÷ periodsPerYear, on the 1e-9 scale, rounded once.
  return roundDiv(BigInt(annualBps) * RATE_SCALE, BPS * BigInt(periodsPerYear));
}

/**
 * A periodic rate back as an annual one in whole basis points.
 *
 * Nominal — the periodic rate multiplied by the number of periods in a year,
 * NOT compounded. That is deliberate: it is the convention the facility itself
 * quotes its rate on, so the stated rate and the effective rate reported beside
 * it are like for like. Compounding the effective rate would make it look
 * higher still and would not be comparable with the number on the offer letter,
 * which is the comparison the whole disclosure exists to let a reader make.
 */
export function annualBpsFromNano(rateNano: bigint, periodsPerYear: number): number {
  return Number(roundDiv(rateNano * BigInt(periodsPerYear) * BPS, RATE_SCALE));
}

/**
 * The present value of `periods` level instalments at `rateNano` per period,
 * payments in arrears.
 *
 *     PV = Σ  instalment / (1 + r)^t     for t = 1 … periods
 *
 * The recursion, the exact rational arithmetic and the single half-up rounding
 * at the end are all lifted from `presentValue` in `leases.ts`, which carries
 * the derivation. The only change is the scale of the rate — see RATE_SCALE.
 * The test proves the two agree where they overlap.
 */
export function presentValueAt(instalmentMinor: bigint, periods: number, rateNano: bigint): bigint {
  if (!Number.isInteger(periods) || periods <= 0) {
    throw new LedgerError("A present value needs a whole number of periods, greater than zero.");
  }
  if (rateNano < 0n) throw new LedgerError("A discount rate below nothing is not a rate.");

  const grown = RATE_SCALE + rateNano;
  let num = 0n;
  let den = 1n;
  for (let k = 0; k < periods; k++) {
    num = RATE_SCALE * (instalmentMinor * den + num);
    den *= grown;
  }
  return roundDiv(num, den);
}

/**
 * The level instalment that repays `principalMinor` over `periods` at
 * `rateNano`, interest charged on the balance outstanding.
 *
 *     A = P · r · (1+r)^n / ((1+r)^n − 1)
 *
 * kept whole by multiplying through by the scale:
 *
 *     A = P · r · G / (SCALE · (G − D))    where G = (SCALE+r)^n, D = SCALE^n
 *
 * so numerator and denominator stay integers and one half-up rounding happens
 * at the end. At a zero rate it is the principal divided by the instalments,
 * which is the sanity check worth keeping.
 */
export function levelInstalment(opts: {
  principalMinor: bigint;
  periods: number;
  ratePerPeriodNano: bigint;
}): bigint {
  const { principalMinor: P, periods: n, ratePerPeriodNano: r } = opts;
  if (P <= 0n) throw new LedgerError("A loan has to be for more than nothing.");
  if (!Number.isInteger(n) || n <= 0) throw new LedgerError("A loan needs a whole number of instalments, greater than zero.");
  if (r === 0n) return roundDiv(P, BigInt(n));

  const g = RATE_SCALE + r;
  let G = 1n;
  for (let i = 0; i < n; i++) G *= g;
  const D = RATE_SCALE ** BigInt(n);
  return roundDiv(P * r * G, RATE_SCALE * (G - D));
}

/**
 * Total interest on a flat-rate facility, and the level instalment it implies.
 *
 * A flat rate is charged on the amount originally advanced for the whole term,
 * whatever has been repaid: principal × rate × years. It is the quoted rate of
 * most UAE personal and SME term loans, and it is the reason `effectiveRateOf`
 * exists.
 */
export function flatInstalment(opts: {
  principalMinor: bigint;
  statedRateBps: number;
  termMonths: number;
  periods: number;
}): { instalmentMinor: bigint; flatInterestMinor: bigint } {
  const { principalMinor: P, statedRateBps, termMonths, periods } = opts;
  if (P <= 0n) throw new LedgerError("A loan has to be for more than nothing.");
  // principal × rate × (termMonths/12), one rounding, multiplication first.
  const flatInterestMinor = roundDiv(P * BigInt(statedRateBps) * BigInt(termMonths), BPS * 12n);
  return {
    flatInterestMinor,
    instalmentMinor: roundDiv(P + flatInterestMinor, BigInt(periods)),
  };
}

/**
 * The effective interest rate: the rate that discounts the contractual
 * instalments back to the amount actually advanced (IFRS 9 Appendix A).
 *
 * Found by bisection on the exact integer present value rather than by any
 * iterative float method, so the answer is reproducible to the last 1e-9 and
 * does not depend on where a solver happened to stop. `presentValueAt` falls as
 * the rate rises, which is what makes the bisection valid.
 *
 * For a reducing-balance facility this returns the contractual rate back —
 * within the fil or two by which the rounded instalment differs from the exact
 * annuity — because for a plain loan with no fees the two ARE the same rate.
 * For a flat-rate facility it is the number the offer letter does not print.
 */
export function effectiveRateOf(opts: {
  principalMinor: bigint;
  instalmentMinor: bigint;
  periods: number;
}): bigint {
  const { principalMinor: P, instalmentMinor: A, periods: n } = opts;
  if (P <= 0n) throw new LedgerError("A loan has to be for more than nothing.");
  if (A <= 0n) throw new LedgerError("An instalment has to be more than nothing.");
  // Repaying no more than was borrowed is an interest-free loan, whatever the
  // paperwork says. Reporting a rate below nil would be an imputed benefit,
  // which is a different accounting question and not this module's to answer.
  if (A * BigInt(n) <= P) return 0n;

  let lo = 0n;
  let hi = RATE_SCALE; // 100% per period, far beyond any real facility
  if (presentValueAt(A, n, hi) > P) {
    throw new LedgerError(
      `${n} instalments of ${A} against a principal of ${P} implies an interest rate above 100% per period. ` +
        "Check the principal, the term and the instalment against each other — one of the three is wrong.",
    );
  }
  // The largest rate whose present value still reaches the principal.
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (presentValueAt(A, n, mid) >= P) lo = mid;
    else hi = mid - 1n;
  }
  // Then take whichever of the two neighbours lands closer, so the answer is
  // the nearest rate rather than merely one that brackets.
  const under = presentValueAt(A, n, lo) - P;
  const over = P - presentValueAt(A, n, lo + 1n);
  return under <= over ? lo : lo + 1n;
}

/* -------------------------------------------------------------- the schedule */

/** One instalment of the amortisation table. Amounts are minor units. */
export interface AmortisationRow {
  /** 1-based, counted from the drawdown. */
  instalmentNo: number;
  openingMinor: bigint;
  interestMinor: bigint;
  principalMinor: bigint;
  /** Interest plus principal — the cash that leaves the bank account. */
  instalmentMinor: bigint;
  closingMinor: bigint;
}

/**
 * The whole amortisation table.
 *
 * Within a period interest accrues on the opening balance and is then paid, so
 * the instalment is in arrears — which is what `presentValueAt` discounts under
 * and what every term loan actually does.
 *
 * **The closing balance of the last instalment is EXACTLY nil.** Rounding the
 * instalment to the fil leaves a few minor units unallocated over the term, and
 * they have to land somewhere. They land in the FINAL INSTALMENT: the last
 * principal repayment is the balance still outstanding, and the last instalment
 * is that plus its own interest, so it differs from the level instalment by the
 * accumulated rounding — a fil or two on a normal facility.
 *
 * That is what a lender actually does, and it is the difference from
 * `leases.ts`, which absorbs its rounding into the final INTEREST instead: a
 * contractual lease payment is a fixed amount that must not be misstated, but
 * the last instalment on a loan is a settlement figure, and the bank quotes it
 * as whatever clears the account. Leaving the remainder unallocated instead
 * would park a stray fil of borrowings on the balance sheet for ever, and
 * nothing would ever clear it.
 */
export function buildBorrowingSchedule(opts: {
  principalMinor: bigint;
  instalmentMinor: bigint;
  periods: number;
  ratePerPeriodNano: bigint;
}): AmortisationRow[] {
  const { principalMinor, instalmentMinor, periods, ratePerPeriodNano: r } = opts;
  if (!Number.isInteger(periods) || periods <= 0) {
    throw new LedgerError("A repayment schedule needs a whole number of instalments, greater than zero.");
  }
  if (principalMinor <= 0n) throw new LedgerError("A loan has to be for more than nothing.");
  if (instalmentMinor <= 0n) throw new LedgerError("An instalment has to be more than nothing.");
  if (r < 0n) throw new LedgerError("An interest rate below nothing is not a rate.");

  const rows: AmortisationRow[] = [];
  let balance = principalMinor;

  for (let t = 1; t <= periods; t++) {
    const opening = balance;
    const interest = roundDiv(opening * r, RATE_SCALE);
    const last = t === periods;

    let principal: bigint;
    let instalment: bigint;
    if (last) {
      principal = opening;
      instalment = principal + interest;
    } else {
      principal = instalmentMinor - interest;
      if (principal <= 0n) {
        throw new LedgerError(
          `Instalment ${t} of ${instalmentMinor} does not cover the ${interest} of interest that has accrued, so ` +
            "the balance would grow instead of falling and the loan would never be repaid. Check the rate, the " +
            "term and the instalment against each other.",
        );
      }
      if (principal >= opening) {
        throw new LedgerError(
          `Instalment ${t} would clear the whole balance, but the facility runs for ${periods} instalments. ` +
            "The term is longer than the repayments need — shorten the term, or reduce the instalment.",
        );
      }
      instalment = instalmentMinor;
    }

    balance = opening - principal;
    rows.push({
      instalmentNo: t,
      openingMinor: opening,
      interestMinor: interest,
      principalMinor: principal,
      instalmentMinor: instalment,
      closingMinor: balance,
    });
  }

  return rows;
}

/* ------------------------------------------------------------------- dates */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

/**
 * `months` calendar months after `from`, rolling back to the end of a shorter
 * month rather than forward into the next one. A loan drawn on the 31st repays
 * on the 30th of a thirty-day month; rolling forward would silently move an
 * instalment into a different year and, at a reporting date, a different
 * maturity band.
 */
export function addMonths(from: Date, months: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  const lastOfTarget = new Date(Date.UTC(y, m + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m + months, Math.min(d, lastOfTarget)));
}

/* ----------------------------------------------------------- the facility */

export interface NewBorrowing {
  code: string;
  lender: string;
  /** Face amount advanced, in minor units. */
  principalMinor: number | bigint | string;
  currency?: string;
  drawdownOn: string;
  /** The rate as the facility quotes it, annual, in basis points. 5% is 500. */
  statedRateBps: number;
  /** REDUCING charges interest on the balance left; FLAT on the original sum. */
  interestBasis?: InterestBasis;
  frequency?: RepaymentFrequency;
  /** Whole months from the drawdown to the last instalment. */
  termMonths: number;
  notes?: string;
}

type BorrowingRow = {
  id: string; orgId: string; entityId: string; code: string; lender: string;
  currency: string; principalMinor: bigint; drawdownOn: Date;
  statedRateBps: number; interestBasis: string; frequency: string; termMonths: number;
  instalmentMinor: bigint; effectiveRateBps: number;
  outstandingMinor: bigint; currentPortionMinor: bigint;
  paidTo: number; status: string; notes: string | null;
};

function minor(v: number | bigint | string, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v.trim())) throw new LedgerError(`${what} must be a whole number of minor units.`);
    return BigInt(v.trim());
  }
  if (!Number.isInteger(v)) throw new LedgerError(`${what} must be in whole minor units, got ${v}.`);
  return BigInt(v);
}

/** Instalments in a term. The term has to divide evenly into repayment periods. */
export function instalmentsOf(termMonths: number, frequency: RepaymentFrequency): number {
  const per = MONTHS_PER_PERIOD[frequency];
  if (!Number.isInteger(termMonths) || termMonths <= 0) {
    throw new LedgerError("A facility runs for a whole number of months, greater than zero.");
  }
  if (termMonths % per !== 0) {
    throw new LedgerError(
      `A ${frequency.toLowerCase()} facility repays every ${per} months, so its term has to be a multiple of ` +
        `${per}; ${termMonths} months is not. Round the term to ${Math.round(termMonths / per) * per} months, or ` +
        "change the repayment frequency.",
    );
  }
  return termMonths / per;
}

/**
 * Everything about a facility that follows from its terms: the instalment, the
 * rate the schedule unwinds at, and the schedule itself.
 *
 * Derived rather than stored (beyond the instalment and the effective rate,
 * which are fixed at drawdown so a later edit to the register cannot silently
 * restate a posted period). The schedule is therefore always the one the
 * postings came from, exactly as `leases.ts` rebuilds its table from the figures
 * fixed at commencement.
 */
export function termsOf(b: {
  principalMinor: bigint; statedRateBps: number; interestBasis: string;
  frequency: string; termMonths: number; instalmentMinor?: bigint; drawdownOn: Date;
}) {
  const frequency = b.frequency as RepaymentFrequency;
  if (!(frequency in PERIODS_PER_YEAR)) {
    throw new LedgerError(`A facility repays monthly, quarterly, semiannually or annually; "${b.frequency}" is none of those.`);
  }
  const basis = b.interestBasis as InterestBasis;
  if (basis !== "REDUCING" && basis !== "FLAT") {
    throw new LedgerError(`Interest is charged on the reducing balance or at a flat rate; "${b.interestBasis}" is neither.`);
  }

  const periodsPerYear = PERIODS_PER_YEAR[frequency];
  const periods = instalmentsOf(b.termMonths, frequency);
  const statedNano = nanoFromAnnualBps(b.statedRateBps, periodsPerYear);

  const flat = basis === "FLAT"
    ? flatInstalment({
        principalMinor: b.principalMinor, statedRateBps: b.statedRateBps,
        termMonths: b.termMonths, periods,
      })
    : null;

  const contractual = flat
    ? flat.instalmentMinor
    : levelInstalment({ principalMinor: b.principalMinor, periods, ratePerPeriodNano: statedNano });
  // The instalment fixed at drawdown wins, so a schedule rebuilt years later
  // reproduces the postings rather than today's arithmetic.
  const instalment = b.instalmentMinor && b.instalmentMinor > 0n ? b.instalmentMinor : contractual;

  const effectiveNano = effectiveRateOf({ principalMinor: b.principalMinor, instalmentMinor: instalment, periods });

  // A reducing-balance facility amortises at its contractual rate — that IS the
  // effective rate, and using the solved figure instead would put the
  // instalment's own rounding into every interest charge and stop the schedule
  // reconciling to the lender's. A flat facility has no contractual periodic
  // rate to amortise at: the quoted rate is charged on a balance that no longer
  // exists, so IFRS 9 uses the effective one.
  const scheduleNano = basis === "FLAT" ? effectiveNano : statedNano;

  const rows = buildBorrowingSchedule({
    principalMinor: b.principalMinor,
    instalmentMinor: instalment,
    periods,
    ratePerPeriodNano: scheduleNano,
  });

  return {
    basis,
    frequency,
    periods,
    periodsPerYear,
    monthsPerPeriod: MONTHS_PER_PERIOD[frequency],
    instalmentMinor: instalment,
    flatInterestMinor: flat?.flatInterestMinor ?? null,
    /** The quoted rate expressed per period, in basis points, as `leases.ts` reports it. */
    statedPeriodRateBps: periodRateBps(b.statedRateBps, periodsPerYear),
    statedRateBps: b.statedRateBps,
    effectiveRateBps: annualBpsFromNano(effectiveNano, periodsPerYear),
    effectiveNano,
    scheduleNano,
    rows,
    /** Instalment k falls due k periods after the drawdown, payments in arrears. */
    dueOn: (instalmentNo: number) => addMonths(b.drawdownOn, instalmentNo * MONTHS_PER_PERIOD[frequency]),
  };
}

/**
 * Record a facility. Nothing reaches the ledger until it is drawn — signing a
 * facility letter is not a transaction, and an undrawn facility is a commitment
 * rather than a liability.
 */
export async function addBorrowing(opts: { orgId: string; entityId: string; borrowing: NewBorrowing }) {
  const b = opts.borrowing;
  const code = (b.code ?? "").trim();
  if (!code) throw new LedgerError("A facility needs a code — it is what every instalment refers back to.");
  if (!(b.lender ?? "").trim()) throw new LedgerError(`${code} needs the lender it is owed to.`);

  const principal = minor(b.principalMinor, "The principal");
  if (principal <= 0n) throw new LedgerError("A loan has to be for more than nothing.");

  const drawdownOn = day(b.drawdownOn ?? "");
  if (Number.isNaN(drawdownOn.getTime())) {
    throw new LedgerError("A facility needs the date it is drawn, written like 2026-01-15.");
  }

  const frequency = b.frequency ?? "MONTHLY";
  const interestBasis = b.interestBasis ?? "REDUCING";

  // Proved before anything is stored: a facility whose terms cannot produce a
  // schedule is one nobody could ever post an instalment against.
  const terms = termsOf({
    principalMinor: principal, statedRateBps: b.statedRateBps,
    interestBasis, frequency, termMonths: b.termMonths, drawdownOn,
  });

  // A flat rate quoted high enough over a long enough term implies an effective
  // rate above 100% a year, which the database refuses to store as basis points
  // — and rightly, because nothing here should be silently recording a facility
  // at that price. Caught with a sentence rather than a constraint violation.
  if (terms.effectiveRateBps > 10_000) {
    throw new LedgerError(
      `${code} quoted at ${b.statedRateBps} basis points ${interestBasis.toLowerCase()} over ${b.termMonths} ` +
        `months has an effective rate of ${terms.effectiveRateBps} basis points — above 100% a year. Check the ` +
        "rate and the term; a flat rate is roughly doubled when it is expressed on the balance outstanding.",
    );
  }

  const clash = await prisma.borrowing.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code },
    select: { lender: true },
  });
  if (clash) throw new LedgerError(`Facility ${code} is already on the register — it is owed to ${clash.lender}.`);

  return prisma.borrowing.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId,
      code, lender: b.lender.trim(),
      currency: (b.currency ?? "AED").trim().toUpperCase(),
      principalMinor: principal,
      drawdownOn,
      statedRateBps: b.statedRateBps,
      interestBasis, frequency, termMonths: b.termMonths,
      // Fixed here rather than recomputed: the instalment is what the borrower
      // actually pays, and the effective rate is what IFRS 9 measures at.
      instalmentMinor: terms.instalmentMinor,
      effectiveRateBps: terms.effectiveRateBps,
      notes: b.notes?.trim() || null,
    },
  });
}

async function facility(scope: { orgId: string; entityId: string }, code: string): Promise<BorrowingRow> {
  const row = (await prisma.borrowing.findFirst({
    where: { orgId: scope.orgId, entityId: scope.entityId, code },
  })) as unknown as BorrowingRow | null;
  if (!row) throw new LedgerError(`There is no facility ${code} on this entity's borrowings register.`);
  return row;
}

/* ------------------------------------------------------------- the drawdown */

export interface DrawdownResult {
  code: string;
  principalMinor: string;
  instalmentMinor: string;
  statedRateBps: number;
  effectiveRateBps: number;
  entryId: string;
  reference: string;
  alreadyDrawn: boolean;
}

/**
 * Draw the facility.
 *
 *   Dr  1010 Bank            the money advanced
 *     Cr  2500 Borrowings      the liability it creates
 *
 * The whole liability is recognised in one account. The split between what
 * falls due within twelve months and what does not is a measurement made at a
 * reporting date, not at the drawdown — see `reclassifyCurrentPortion`.
 */
export async function drawDown(opts: {
  orgId: string;
  entityId: string;
  code: string;
  /** Defaults to the drawdown date on the register. */
  receivedOn?: string;
  cashAccount?: string;
  actorId?: string;
}): Promise<DrawdownResult> {
  const b = await facility(opts, opts.code);
  const terms = termsOf(b);

  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  if (!book) throw new LedgerError("No ledger has been opened for this entity. Set up the chart of accounts first.");
  if (b.currency !== book.functionalCurrency) {
    throw new LedgerError(
      `Facility ${b.code} is in ${b.currency} and these books are kept in ${book.functionalCurrency}. A borrowing ` +
        "in another currency is a monetary liability that IAS 21.23(a) retranslates at every reporting date, and " +
        "nothing here does that — the register would drift from the ledger every month. Record it in " +
        `${book.functionalCurrency}, or keep it outside this register until retranslation is built.`,
    );
  }

  const externalKey = `borrowing-drawdown:${b.id}`;
  const already = await prisma.journalEntry.findFirst({ where: { orgId: opts.orgId, externalKey } });
  if (already) {
    // The entry is idempotent on its own; returning early is what stops a retry
    // from recognising the liability on the register a second time.
    return {
      code: b.code,
      principalMinor: b.principalMinor.toString(),
      instalmentMinor: terms.instalmentMinor.toString(),
      statedRateBps: b.statedRateBps,
      effectiveRateBps: terms.effectiveRateBps,
      entryId: already.id,
      reference: `${already.series}-${already.number}`,
      alreadyDrawn: true,
    };
  }
  if (b.status !== "draft") throw new LedgerError(`Facility ${b.code} has already been drawn; it is ${b.status}.`);

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: opts.receivedOn ?? iso(b.drawdownOn),
    memo: `Drawdown of facility ${b.code} from ${b.lender}`,
    source: "borrowing",
    sourceType: "BORROWING_DRAWDOWN",
    sourceId: b.id,
    externalKey,
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "BD",
    lines: [
      { account: opts.cashAccount ?? CASH_ACCOUNT, debit: b.principalMinor, memo: `${b.code} drawdown received` },
      { account: BORROWINGS_ACCOUNT, credit: b.principalMinor, memo: `${b.code} ${b.lender}` },
    ],
  });

  // The register moves only once the journal has committed; the other order
  // would leave a facility marked drawn with no money in the books.
  await prisma.borrowing.update({
    where: { id: b.id },
    data: { status: "active", outstandingMinor: b.principalMinor },
  });

  return {
    code: b.code,
    principalMinor: b.principalMinor.toString(),
    instalmentMinor: terms.instalmentMinor.toString(),
    statedRateBps: b.statedRateBps,
    effectiveRateBps: terms.effectiveRateBps,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyDrawn: false,
  };
}

/* ------------------------------------------------------------ the instalment */

export interface InstalmentResult {
  code: string;
  instalmentNo: number;
  dueOn: string;
  interestMinor: string;
  principalMinor: string;
  instalmentMinor: string;
  outstandingMinor: string;
  entryId: string;
  reference: string;
  /** True when this call did nothing because the instalment was already posted. */
  alreadyPosted: boolean;
}

/**
 * Post one instalment.
 *
 *   Dr  2450/2500 Borrowings    the principal repaid
 *   Dr  6360 Finance costs      the interest that accrued on the balance
 *     Cr  1010 Bank               the whole instalment that left the account
 *
 * The split between the two comes from the schedule fixed at drawdown, not from
 * whatever the balance happens to be today — the effective interest schedule is
 * fixed until a modification (IFRS 9.B5.4.5), so a late payment leaves arrears
 * rather than changing the unwinding.
 *
 * Where a current portion has been reclassified, the principal discharges THAT
 * first: what is repaid in the next twelve months is precisely what was
 * reclassified as falling due in the next twelve months, and taking it out of
 * the non-current account instead would drive that account below nil between
 * reporting dates on a facility whose remaining term is short.
 *
 * Idempotent on the facility and the instalment number: one contractual payment
 * falls due per period, so a retry returns the original entry and moves nothing.
 */
export async function postInstalment(opts: {
  orgId: string;
  entityId: string;
  code: string;
  instalmentNo: number;
  /** Defaults to the contractual due date. */
  paidOn?: string;
  cashAccount?: string;
  actorId?: string;
}): Promise<InstalmentResult> {
  const b = await facility(opts, opts.code);
  const terms = termsOf(b);

  if (!Number.isInteger(opts.instalmentNo) || opts.instalmentNo < 1 || opts.instalmentNo > terms.periods) {
    throw new LedgerError(
      `Facility ${b.code} has ${terms.periods} instalments, numbered 1 to ${terms.periods}; ` +
        `${opts.instalmentNo} is not one of them.`,
    );
  }
  const row = terms.rows[opts.instalmentNo - 1];
  const dueOn = terms.dueOn(opts.instalmentNo);

  const externalKey = `borrowing-instalment:${b.id}:${opts.instalmentNo}`;
  const already = await prisma.journalEntry.findFirst({ where: { orgId: opts.orgId, externalKey } });
  if (already) {
    return {
      code: b.code,
      instalmentNo: opts.instalmentNo,
      dueOn: iso(dueOn),
      interestMinor: row.interestMinor.toString(),
      principalMinor: row.principalMinor.toString(),
      instalmentMinor: row.instalmentMinor.toString(),
      outstandingMinor: b.outstandingMinor.toString(),
      entryId: already.id,
      reference: `${already.series}-${already.number}`,
      alreadyPosted: true,
    };
  }

  if (b.status === "draft") {
    throw new LedgerError(`Facility ${b.code} has not been drawn yet, so there is nothing to repay.`);
  }
  if (b.status === "settled") throw new LedgerError(`Facility ${b.code} is settled; nothing is outstanding.`);
  // A gap means an instalment was never posted. Folding it into this one would
  // hide that, and the interest of the skipped period would never be charged.
  if (opts.instalmentNo !== b.paidTo + 1) {
    throw new LedgerError(
      `Facility ${b.code} is paid to instalment ${b.paidTo}, so instalment ${b.paidTo + 1} is the next one due. ` +
        `Post the instalments in order — a missed one means the interest for that period was never charged.`,
    );
  }

  // How much of this principal comes out of the reclassified current portion.
  const fromCurrent = row.principalMinor < b.currentPortionMinor ? row.principalMinor : b.currentPortionMinor;
  const fromNonCurrent = row.principalMinor - fromCurrent;

  const lines: { account: string; debit?: bigint; credit?: bigint; memo: string }[] = [];
  if (fromCurrent > 0n) {
    lines.push({ account: BORROWINGS_CURRENT_ACCOUNT, debit: fromCurrent, memo: `${b.code} principal repaid` });
  }
  if (fromNonCurrent > 0n) {
    lines.push({ account: BORROWINGS_ACCOUNT, debit: fromNonCurrent, memo: `${b.code} principal repaid` });
  }
  if (row.interestMinor > 0n) {
    lines.push({
      account: INTEREST_ACCOUNT, debit: row.interestMinor,
      memo: `${b.code} interest, instalment ${opts.instalmentNo} of ${terms.periods}`,
    });
  }
  lines.push({
    account: opts.cashAccount ?? CASH_ACCOUNT, credit: row.instalmentMinor,
    memo: `${b.code} instalment ${opts.instalmentNo} to ${b.lender}`,
  });

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: opts.paidOn ?? iso(dueOn),
    memo: `Facility ${b.code} instalment ${opts.instalmentNo} of ${terms.periods}`,
    source: "borrowing",
    sourceType: "BORROWING_INSTALMENT",
    sourceId: b.id,
    externalKey,
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "BR",
    lines: lines.map((l) => ({
      account: l.account,
      ...(l.debit !== undefined ? { debit: l.debit } : { credit: l.credit! }),
      memo: l.memo,
    })),
  });

  await prisma.borrowing.update({
    where: { id: b.id },
    data: {
      outstandingMinor: row.closingMinor,
      currentPortionMinor: b.currentPortionMinor - fromCurrent,
      paidTo: opts.instalmentNo,
      ...(row.closingMinor === 0n ? { status: "settled" } : {}),
    },
  });

  return {
    code: b.code,
    instalmentNo: opts.instalmentNo,
    dueOn: iso(dueOn),
    interestMinor: row.interestMinor.toString(),
    principalMinor: row.principalMinor.toString(),
    instalmentMinor: row.instalmentMinor.toString(),
    outstandingMinor: row.closingMinor.toString(),
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPosted: false,
  };
}

/* -------------------------------------------------- current and non-current */

/**
 * The principal falling due within twelve months of a reporting date.
 *
 * IAS 1.69(c)–(d): a liability is current where it is due to be settled within
 * twelve months of the reporting date, or where the entity has no unconditional
 * right to defer settlement beyond then. So it is derived from the schedule —
 * the sum of the PRINCIPAL on the instalments still unpaid that fall due on or
 * before the twelve-month date — and not from a proportion of the balance.
 *
 * Two things it deliberately does:
 *   • Interest is excluded. A future interest charge is not a liability at the
 *     reporting date; it has not accrued. Including it is the commonest error
 *     on this line and it overstates current liabilities every time.
 *   • Arrears count as current. An instalment already past due has plainly not
 *     been deferred, so it belongs in the twelve months whatever its date.
 */
export function currentPortionOf(opts: {
  rows: AmortisationRow[];
  dueOn: (instalmentNo: number) => Date;
  paidTo: number;
  asOf: Date;
}): { currentMinor: bigint; nonCurrentMinor: bigint } {
  const horizon = addMonths(opts.asOf, 12);
  let current = 0n;
  let nonCurrent = 0n;
  for (const row of opts.rows) {
    if (row.instalmentNo <= opts.paidTo) continue;
    if (opts.dueOn(row.instalmentNo) <= horizon) current += row.principalMinor;
    else nonCurrent += row.principalMinor;
  }
  return { currentMinor: current, nonCurrentMinor: nonCurrent };
}

/**
 * Create the current-portion account if this entity's chart has not got it.
 *
 * It is not in the seeded chart in `setup.ts` (which this module does not own),
 * and the migration that introduced it only reached books that were already
 * open. Without this, a book opened afterwards would fail the reclassification
 * with "Account 2450 does not exist", which is true and useless.
 */
async function ensureCurrentPortionAccount(orgId: string, entityId: string) {
  const existing = await prisma.account.findFirst({
    where: { orgId, entityId, code: BORROWINGS_CURRENT_ACCOUNT },
    select: { id: true },
  });
  if (existing) return;
  await addAccount({
    orgId, entityId,
    account: {
      code: BORROWINGS_CURRENT_ACCOUNT,
      name: "Borrowings — current portion",
      nameAr: "الجزء المتداول من القروض",
      type: "LIABILITY",
      parentCode: "20",
    },
  });
}

export interface ReclassResult {
  asOf: string;
  posted: boolean;
  movedMinor: string;
  facilities: { code: string; currentMinor: string; wasMinor: string; movementMinor: string }[];
  entryId: string | null;
  reference: string | null;
  alreadyPosted: boolean;
  note: string;
}

/**
 * Move each facility's current portion onto a current-liability account.
 *
 * **This is posted rather than only reported, and the choice is worth stating.**
 * IAS 1.69 is a presentation requirement, so in principle a note would satisfy
 * it. In this product it would not reach the reader: the statements are built
 * from account balances, and it is the chart's own numbering that tells them
 * which liabilities are current — the summarised balance sheet reads 2000–2499
 * as current and 2500–2999 as non-current. A split that is not in the ledger is
 * a split no statement can present. So it is posted:
 *
 *   Dr  2500 Borrowings                    the amount falling due within a year
 *     Cr  2450 Borrowings, current portion
 *
 * It corrects to a TARGET rather than posting an increment, exactly as revenue
 * recognition does: the entry is the difference between what each facility's
 * current portion should be at this reporting date and what has already been
 * reclassified, so running it twice on the same date posts nothing the second
 * time, and running it at successive reporting dates keeps the split right
 * without anyone having to remember to reverse last year's.
 *
 * One consequence to be aware of rather than surprised by: `cashflow.ts`
 * classifies accounts into operating, investing and financing from a fixed map,
 * and 2450 is not in it, so a period containing a reclassification will report
 * 2450 as an unclassified movement and the cash flow statement will say it does
 * not reconcile. That is the statement telling the truth about a map that has
 * not been extended — 2450 belongs in the financing bucket beside 2500 — and it
 * is reported here rather than worked around.
 */
export async function reclassifyCurrentPortion(opts: {
  orgId: string;
  entityId: string;
  /** The reporting date the twelve months are counted from. */
  asOf: string;
  actorId?: string;
}): Promise<ReclassResult> {
  const asOf = day(opts.asOf ?? "");
  if (Number.isNaN(asOf.getTime())) throw new LedgerError("A reclassification needs a reporting date, written like 2026-12-31.");

  const rows = (await prisma.borrowing.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: "active" },
    orderBy: { code: "asc" },
  })) as unknown as BorrowingRow[];

  const externalKey = `borrowing-reclass:${opts.entityId}:${iso(asOf)}`;
  const already = await prisma.journalEntry.findFirst({ where: { orgId: opts.orgId, externalKey } });
  if (already) {
    return {
      asOf: iso(asOf), posted: false, movedMinor: "0", facilities: [],
      entryId: already.id, reference: `${already.series}-${already.number}`,
      alreadyPosted: true,
      note: `The split at ${iso(asOf)} has already been posted; nothing moved.`,
    };
  }

  const moves: { row: BorrowingRow; target: bigint; movement: bigint }[] = [];
  for (const b of rows) {
    const terms = termsOf(b);
    const { currentMinor } = currentPortionOf({
      rows: terms.rows, dueOn: terms.dueOn, paidTo: b.paidTo, asOf,
    });
    moves.push({ row: b, target: currentMinor, movement: currentMinor - b.currentPortionMinor });
  }

  const moving = moves.filter((m) => m.movement !== 0n);
  const facilities = moves.map((m) => ({
    code: m.row.code,
    currentMinor: m.target.toString(),
    wasMinor: m.row.currentPortionMinor.toString(),
    movementMinor: m.movement.toString(),
  }));

  if (moving.length === 0) {
    return {
      asOf: iso(asOf), posted: false, movedMinor: "0", facilities,
      entryId: null, reference: null, alreadyPosted: false,
      note: rows.length === 0
        ? "No facility is drawn, so there is nothing to split."
        : `The current portion at ${iso(asOf)} is already what the ledger says it is; nothing to post.`,
    };
  }

  await ensureCurrentPortionAccount(opts.orgId, opts.entityId);

  const lines = moving.flatMap((m) => {
    const amount = m.movement > 0n ? m.movement : -m.movement;
    const toCurrent = m.movement > 0n;
    return [
      {
        account: toCurrent ? BORROWINGS_ACCOUNT : BORROWINGS_CURRENT_ACCOUNT,
        debit: amount,
        memo: `${m.row.code} ${toCurrent ? "out of non-current" : "back out of current"}`,
      },
      {
        account: toCurrent ? BORROWINGS_CURRENT_ACCOUNT : BORROWINGS_ACCOUNT,
        credit: amount,
        memo: `${m.row.code} ${toCurrent ? "due within twelve months" : "due after twelve months"}`,
      },
    ];
  });

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: iso(asOf),
    memo: `Borrowings falling due within twelve months of ${iso(asOf)} (IAS 1.69)`,
    source: "borrowing",
    sourceType: "BORROWING_RECLASS",
    sourceId: iso(asOf),
    externalKey,
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "BC",
    lines: lines.map((l) => ({
      account: l.account,
      ...("debit" in l ? { debit: l.debit } : { credit: (l as { credit: bigint }).credit }),
      memo: l.memo,
    })),
  });

  await prisma.$transaction(
    moving.map((m) =>
      prisma.borrowing.update({ where: { id: m.row.id }, data: { currentPortionMinor: m.target } }),
    ),
  );

  const moved = moving.reduce((a, m) => a + (m.movement > 0n ? m.movement : -m.movement), 0n);
  return {
    asOf: iso(asOf),
    posted: true,
    movedMinor: moved.toString(),
    facilities,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPosted: false,
    note:
      `Moved ${moved} of borrowings between 2500 and 2450 so the balance sheet presents what falls due within ` +
      `twelve months of ${iso(asOf)} as a current liability, per IAS 1.69.`,
  };
}

/* ---------------------------------------------------------------- the note */

export type MaturityBand = "WITHIN_1Y" | "Y1_2" | "Y2_5" | "OVER_5Y";

export const BAND_LABEL: Record<MaturityBand, string> = {
  WITHIN_1Y: "Within one year",
  Y1_2: "One to two years",
  Y2_5: "Two to five years",
  OVER_5Y: "More than five years",
};

function bandOf(dueOn: Date, asOf: Date): MaturityBand {
  if (dueOn <= addMonths(asOf, 12)) return "WITHIN_1Y";
  if (dueOn <= addMonths(asOf, 24)) return "Y1_2";
  if (dueOn <= addMonths(asOf, 60)) return "Y2_5";
  return "OVER_5Y";
}

export interface MaturityAnalysis {
  asOf: string;
  bands: {
    band: MaturityBand;
    label: string;
    principalMinor: string;
    interestMinor: string;
    /** Principal plus interest — the contractual cash, undiscounted. */
    cashFlowMinor: string;
  }[];
  totals: { principalMinor: string; interestMinor: string; cashFlowMinor: string };
  /** What the balance sheet carries: the amortised cost of the borrowings. */
  carryingAmountMinor: string;
  /** Contractual cash less carrying amount — future interest, by construction. */
  differenceMinor: string;
  facilities: {
    code: string;
    lender: string;
    carryingAmountMinor: string;
    bands: Record<MaturityBand, string>;
  }[];
  note: string;
}

/**
 * The IFRS 7.39(a) maturity analysis: the remaining CONTRACTUAL, UNDISCOUNTED
 * cash flows on the borrowings, in bands.
 *
 * IFRS 7.B11D is explicit that the amounts disclosed are the contractual
 * undiscounted cash flows, so this total does NOT agree with the carrying
 * amount and is not meant to. The difference is the interest that has not
 * accrued yet: the carrying amount is what is owed today, the analysis is what
 * will be paid over the years to come, and discounting the second at the
 * effective rate gives back the first. That difference is stated on the face of
 * the note rather than left for a reader to discover, because it is the single
 * most common query this disclosure produces.
 */
export async function maturityAnalysis(opts: {
  orgId: string; entityId: string; asOf: string;
}): Promise<MaturityAnalysis> {
  const asOf = day(opts.asOf ?? "");
  if (Number.isNaN(asOf.getTime())) throw new LedgerError("A maturity analysis needs a reporting date.");

  const rows = (await prisma.borrowing.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: { in: ["active", "settled"] } },
    orderBy: { code: "asc" },
  })) as unknown as BorrowingRow[];

  const order: MaturityBand[] = ["WITHIN_1Y", "Y1_2", "Y2_5", "OVER_5Y"];
  const principal = new Map<MaturityBand, bigint>(order.map((b) => [b, 0n]));
  const interest = new Map<MaturityBand, bigint>(order.map((b) => [b, 0n]));
  const facilities: MaturityAnalysis["facilities"] = [];
  let carrying = 0n;

  for (const b of rows) {
    if (b.outstandingMinor <= 0n) continue;
    const terms = termsOf(b);
    const own: Record<MaturityBand, string> = { WITHIN_1Y: "0", Y1_2: "0", Y2_5: "0", OVER_5Y: "0" };
    const ownTally = new Map<MaturityBand, bigint>(order.map((x) => [x, 0n]));

    for (const row of terms.rows) {
      if (row.instalmentNo <= b.paidTo) continue;
      // An instalment already past due has not been deferred, so it belongs in
      // the first band whatever its contractual date says.
      const band = bandOf(terms.dueOn(row.instalmentNo), asOf);
      principal.set(band, principal.get(band)! + row.principalMinor);
      interest.set(band, interest.get(band)! + row.interestMinor);
      ownTally.set(band, ownTally.get(band)! + row.instalmentMinor);
    }
    for (const x of order) own[x] = ownTally.get(x)!.toString();
    carrying += b.outstandingMinor;
    facilities.push({
      code: b.code, lender: b.lender,
      carryingAmountMinor: b.outstandingMinor.toString(),
      bands: own,
    });
  }

  const totalPrincipal = order.reduce((a, x) => a + principal.get(x)!, 0n);
  const totalInterest = order.reduce((a, x) => a + interest.get(x)!, 0n);
  const totalCash = totalPrincipal + totalInterest;

  return {
    asOf: iso(asOf),
    bands: order.map((x) => ({
      band: x,
      label: BAND_LABEL[x],
      principalMinor: principal.get(x)!.toString(),
      interestMinor: interest.get(x)!.toString(),
      cashFlowMinor: (principal.get(x)! + interest.get(x)!).toString(),
    })),
    totals: {
      principalMinor: totalPrincipal.toString(),
      interestMinor: totalInterest.toString(),
      cashFlowMinor: totalCash.toString(),
    },
    carryingAmountMinor: carrying.toString(),
    differenceMinor: (totalCash - carrying).toString(),
    facilities,
    note:
      "These are the contractual cash flows, undiscounted, as IFRS 7.B11D requires. They do not add up to the " +
      "carrying amount and are not meant to: the difference is the interest that has not accrued yet. The " +
      "carrying amount is what is owed today; this analysis is what will be paid between now and the last " +
      "instalment.",
  };
}

/* ------------------------------------------------------------- the covenants */

/**
 * What a covenant can be tested against.
 *
 * Every one of these is computed from figures this ledger actually holds. There
 * is no metric here that needs a number somebody types in, because a covenant
 * tested against a typed-in number tests the typing.
 *
 * OTHER exists so that a covenant which cannot be tested can still be RECORDED.
 * It is reported as untested — never as a pass — which is the whole point: a
 * covenant nobody can check is a risk, and a screen that quietly showed it green
 * would be worse than one that did not show it at all.
 */
export type CovenantMetric = "CURRENT_RATIO" | "DEBT_TO_EQUITY" | "INTEREST_COVER" | "MIN_NET_WORTH" | "OTHER";
export type CovenantDirection = "MIN" | "MAX";

export const COVENANT_METRICS: { metric: CovenantMetric; label: string; unit: "ratio" | "amount" | "none"; how: string }[] = [
  {
    metric: "CURRENT_RATIO", label: "Current ratio", unit: "ratio",
    how: "Current assets over current liabilities, both read from the chart's own numbering: assets coded 1000–1499 and liabilities coded 2000–2499. That is the same convention the summarised balance sheet uses.",
  },
  {
    metric: "DEBT_TO_EQUITY", label: "Debt to equity", unit: "ratio",
    how: "The carrying amount of the borrowings on this register over total equity, including the profit earned so far this year. It excludes lease liabilities and trade finance, which most facility letters define separately.",
  },
  {
    metric: "INTEREST_COVER", label: "Interest cover", unit: "ratio",
    how: "Profit before interest and tax over the finance costs charged in the period. Both come from the profit and loss for the period being tested.",
  },
  {
    metric: "MIN_NET_WORTH", label: "Minimum net worth", unit: "amount",
    how: "Total equity at the reporting date, including the profit earned so far this year.",
  },
  {
    metric: "OTHER", label: "Recorded, not tested", unit: "none",
    how: "Recorded so it is not forgotten. Nothing in the ledger can test it, so it is never reported as passing.",
  },
];

export interface NewCovenant {
  borrowingCode: string;
  code: string;
  metric: CovenantMetric;
  direction?: CovenantDirection;
  /** For a ratio: basis points. A current ratio of 1.25 is 12500. */
  thresholdBps?: number | null;
  /** For an amount: minor units. */
  thresholdMinor?: number | bigint | string | null;
  wording?: string;
}

export async function addCovenant(opts: { orgId: string; entityId: string; covenant: NewCovenant }) {
  const c = opts.covenant;
  const b = await facility(opts, c.borrowingCode);
  const code = (c.code ?? "").trim();
  if (!code) throw new LedgerError("A covenant needs a code, so a breach can be named when it is reported.");

  const def = COVENANT_METRICS.find((m) => m.metric === c.metric);
  if (!def) {
    throw new LedgerError(
      `"${c.metric}" is not a covenant this ledger can hold. Use one of ` +
        `${COVENANT_METRICS.map((m) => m.metric).join(", ")} — OTHER records a covenant that cannot be tested here.`,
    );
  }
  const direction = c.direction ?? (def.metric === "DEBT_TO_EQUITY" ? "MAX" : "MIN");
  if (direction !== "MIN" && direction !== "MAX") {
    throw new LedgerError("A covenant sets a floor (MIN) or a ceiling (MAX).");
  }

  const thresholdBps = c.thresholdBps == null ? null : Number(c.thresholdBps);
  const thresholdMinor = c.thresholdMinor == null ? null : minor(c.thresholdMinor, "The threshold");

  if (def.unit === "ratio" && (thresholdBps == null || !Number.isInteger(thresholdBps))) {
    throw new LedgerError(
      `${def.label} is a ratio, so its threshold is a whole number of basis points — a current ratio of 1.25 is ` +
        "12500. A ratio held as a decimal disagrees with itself at the fourth place.",
    );
  }
  if (def.unit === "amount" && thresholdMinor == null) {
    throw new LedgerError(`${def.label} is an amount, so its threshold is in whole minor units.`);
  }
  if (def.unit === "none" && !(c.wording ?? "").trim()) {
    throw new LedgerError(
      "A covenant recorded as untestable has to say what it actually requires, or the register holds a row that " +
        "means nothing to whoever reads it next.",
    );
  }

  const clash = await prisma.borrowingCovenant.findFirst({
    where: { orgId: opts.orgId, borrowingId: b.id, code },
  });
  if (clash) throw new LedgerError(`Facility ${b.code} already carries a covenant ${code}.`);

  return prisma.borrowingCovenant.create({
    data: {
      orgId: opts.orgId, borrowingId: b.id, code,
      metric: def.metric, direction,
      thresholdBps, thresholdMinor,
      wording: c.wording?.trim() || null,
    },
  });
}

export interface CovenantTest {
  borrowingCode: string;
  code: string;
  metric: CovenantMetric;
  label: string;
  direction: CovenantDirection;
  unit: "ratio" | "amount" | "none";
  thresholdBps: number | null;
  thresholdMinor: string | null;
  actualBps: number | null;
  actualMinor: string | null;
  /** pass | breach | not_tested. Never a pass for something that was not measured. */
  result: "pass" | "breach" | "not_tested";
  /** The arithmetic, or the reason there is none. */
  why: string;
  wording: string | null;
}

/** A ratio in basis points. Multiplication before division, one rounding. */
function ratioBps(numerator: bigint, denominator: bigint): number {
  return Number(roundDiv(numerator * BPS, denominator));
}

const numericCode = (code: string) => (/^\d+$/.test(code) ? Number(code) : null);

/**
 * Test every covenant on the register against the figures the books hold.
 *
 * A covenant that cannot be measured is reported as not tested, with the reason
 * — a denominator of nil, a metric nothing here computes, a period with no
 * finance cost in it. It is never reported as a pass. The point of this screen
 * is to be believed by somebody deciding whether to tell the bank, and one
 * false green makes the whole thing worthless.
 */
export async function testCovenants(opts: {
  orgId: string;
  entityId: string;
  /** The reporting date the balance-sheet metrics are measured at. */
  asOf: string;
  /** The start of the period the income metrics cover. Defaults to 1 January of `asOf`'s year. */
  from?: string;
}): Promise<{ asOf: string; from: string; tests: CovenantTest[]; breaches: number; untested: number; note: string }> {
  const asOf = day(opts.asOf ?? "");
  if (Number.isNaN(asOf.getTime())) throw new LedgerError("A covenant test needs a reporting date.");
  const from = opts.from ? day(opts.from) : new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
  if (Number.isNaN(from.getTime())) throw new LedgerError("A covenant test needs a period it can read.");
  if (from > asOf) throw new LedgerError("The period ends before it starts.");

  const facilities = (await prisma.borrowing.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { code: "asc" },
  })) as unknown as BorrowingRow[];
  const covenants = await prisma.borrowingCovenant.findMany({
    where: { orgId: opts.orgId, borrowingId: { in: facilities.map((f) => f.id) } },
    orderBy: [{ borrowingId: "asc" }, { code: "asc" }],
  });

  const tests: CovenantTest[] = [];
  if (covenants.length === 0) {
    return {
      asOf: iso(asOf), from: iso(from), tests, breaches: 0, untested: 0,
      note: "No covenant is recorded against any facility. That is not the same as there being none.",
    };
  }

  const bs = await balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: iso(asOf) });
  const pl = await profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from: iso(from), to: iso(asOf) });

  // Current by the chart's own numbering — the same convention the summarised
  // balance sheet uses, and the reason the current portion is posted to 2450.
  const inBand = (code: string, lo: number, hi: number) => {
    const n = numericCode(code);
    return n !== null && n >= lo && n <= hi;
  };
  const currentAssets = bs.assets.lines
    .filter((l) => inBand(l.code, 1000, 1499))
    .reduce((a, l) => a + BigInt(l.presentedMinor), 0n);
  const currentLiabilities = bs.liabilities.lines
    .filter((l) => inBand(l.code, 2000, 2499))
    .reduce((a, l) => a + BigInt(l.presentedMinor), 0n);
  const equity = BigInt(bs.equity.totalMinor);
  const borrowingsCarrying = facilities.reduce((a, f) => a + f.outstandingMinor, 0n);

  const financeCost = pl.expenses.lines
    .filter((l) => l.code === INTEREST_ACCOUNT)
    .reduce((a, l) => a + BigInt(l.presentedMinor), 0n);
  const taxCharge = pl.expenses.lines
    .filter((l) => inBand(l.code, 7000, 7999))
    .reduce((a, l) => a + BigInt(l.presentedMinor), 0n);
  const ebit = BigInt(pl.netProfitMinor) + financeCost + taxCharge;

  const byId = new Map(facilities.map((f) => [f.id, f]));

  for (const c of covenants) {
    const def = COVENANT_METRICS.find((m) => m.metric === c.metric)!;
    const base = {
      borrowingCode: byId.get(c.borrowingId)?.code ?? "?",
      code: c.code,
      metric: c.metric as CovenantMetric,
      label: def.label,
      direction: c.direction as CovenantDirection,
      unit: def.unit,
      thresholdBps: c.thresholdBps,
      thresholdMinor: c.thresholdMinor === null ? null : c.thresholdMinor.toString(),
      wording: c.wording,
    };

    let actualBps: number | null = null;
    let actualMinor: string | null = null;
    let why = "";
    let result: CovenantTest["result"] = "not_tested";

    if (c.metric === "OTHER") {
      why = "Nothing in this ledger measures it, so it is recorded and not tested. Check it by hand against the facility letter.";
    } else if (c.metric === "CURRENT_RATIO") {
      if (currentLiabilities <= 0n) {
        why = `There are no current liabilities at ${iso(asOf)}, so the ratio has no denominator. A ratio against nil is not infinity, it is unmeasured.`;
      } else {
        actualBps = ratioBps(currentAssets, currentLiabilities);
        why = `Current assets ${currentAssets} over current liabilities ${currentLiabilities}, both read from accounts coded 1000–1499 and 2000–2499.`;
      }
    } else if (c.metric === "DEBT_TO_EQUITY") {
      if (equity <= 0n) {
        why = `Equity at ${iso(asOf)} is ${equity}, so the ratio has no meaningful denominator. Gearing against nil or negative equity says nothing.`;
      } else {
        actualBps = ratioBps(borrowingsCarrying, equity);
        why = `Borrowings ${borrowingsCarrying} over equity ${equity}. Lease liabilities are not included — check whether the facility letter defines debt to include them.`;
      }
    } else if (c.metric === "INTEREST_COVER") {
      if (financeCost <= 0n) {
        why = `No finance cost was charged between ${iso(from)} and ${iso(asOf)}, so there is nothing to cover. That is not a pass; it usually means the instalments have not been posted.`;
      } else {
        actualBps = ratioBps(ebit, financeCost);
        why = `Profit before interest and tax ${ebit} over finance costs ${financeCost}, for ${iso(from)} to ${iso(asOf)}.`;
      }
    } else if (c.metric === "MIN_NET_WORTH") {
      actualMinor = equity.toString();
      why = `Total equity at ${iso(asOf)}, including the profit earned so far this year.`;
    }

    if (actualBps !== null && c.thresholdBps !== null) {
      result = c.direction === "MIN"
        ? (actualBps >= c.thresholdBps ? "pass" : "breach")
        : (actualBps <= c.thresholdBps ? "pass" : "breach");
    } else if (actualMinor !== null && c.thresholdMinor !== null) {
      const a = BigInt(actualMinor);
      result = c.direction === "MIN"
        ? (a >= c.thresholdMinor ? "pass" : "breach")
        : (a <= c.thresholdMinor ? "pass" : "breach");
    }

    tests.push({ ...base, actualBps, actualMinor, result, why });
  }

  const breaches = tests.filter((t) => t.result === "breach").length;
  const untested = tests.filter((t) => t.result === "not_tested").length;

  return {
    asOf: iso(asOf),
    from: iso(from),
    tests,
    breaches,
    untested,
    note: breaches > 0
      ? "A covenant is in breach. IAS 1.74 presents the WHOLE liability as current where a breach at or before the " +
        "reporting date makes the loan repayable on demand, unless the lender agreed by the reporting date to " +
        "defer for at least twelve months. Whether this breach has that effect is a term of the facility letter, " +
        "which no ledger can read, so the current portion below has not been overridden — decide it and, if it " +
        "applies, say so."
      : untested > 0
        ? "Some covenants could not be measured from the books. They are shown as untested rather than as passing."
        : "Every recorded covenant was measured and met at this date.",
  };
}

/* -------------------------------------------------------------- the register */

/**
 * The borrowings register, with the ledger balances it is supposed to agree
 * with, the split IAS 1.69 asks for, and the maturity analysis IFRS 7 asks for.
 *
 * The register and the ledger are two records on purpose, as with leases and
 * fixed assets: the facility's terms are a contract, and the ledger records
 * only their consequences. A register nobody compares to the ledger is a
 * spreadsheet with extra steps, so the comparison is made here and the
 * difference is reported rather than reconciled away.
 */
export async function borrowingRegister(opts: {
  orgId: string; entityId: string; asOf?: string;
}) {
  const asOf = opts.asOf ? day(opts.asOf) : new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  if (Number.isNaN(asOf.getTime())) throw new LedgerError("A register needs a date it can read.");

  const rows = (await prisma.borrowing.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: [{ status: "asc" }, { code: "asc" }],
  })) as unknown as BorrowingRow[];
  const covenants = await prisma.borrowingCovenant.findMany({
    where: { orgId: opts.orgId, borrowingId: { in: rows.map((r) => r.id) } },
    select: { borrowingId: true, code: true },
  });
  const covenantCount = new Map<string, number>();
  for (const c of covenants) covenantCount.set(c.borrowingId, (covenantCount.get(c.borrowingId) ?? 0) + 1);

  const facilities = rows.map((b) => {
    const terms = termsOf(b);
    const split = currentPortionOf({ rows: terms.rows, dueOn: terms.dueOn, paidTo: b.paidTo, asOf });
    const drawn = b.status !== "draft";
    return {
      code: b.code,
      lender: b.lender,
      currency: b.currency,
      status: b.status,
      drawdownOn: iso(b.drawdownOn),
      maturesOn: iso(terms.dueOn(terms.periods)),
      termMonths: b.termMonths,
      frequency: b.frequency,
      interestBasis: b.interestBasis,
      principalMinor: b.principalMinor.toString(),
      instalmentMinor: terms.instalmentMinor.toString(),
      instalments: terms.periods,
      paidTo: b.paidTo,
      statedRateBps: b.statedRateBps,
      statedPeriodRateBps: terms.statedPeriodRateBps,
      effectiveRateBps: drawn ? b.effectiveRateBps : terms.effectiveRateBps,
      /** Whole basis points by which the effective rate exceeds the quoted one. */
      ratePremiumBps: (drawn ? b.effectiveRateBps : terms.effectiveRateBps) - b.statedRateBps,
      flatInterestMinor: terms.flatInterestMinor === null ? null : terms.flatInterestMinor.toString(),
      outstandingMinor: b.outstandingMinor.toString(),
      // The split is DERIVED from the schedule at this date, whatever has been
      // posted. `reclassifiedMinor` is what the ledger has been told. The two
      // differing is not an error — it means the reclassification has not been
      // run at this date — and saying which is which is the point.
      currentMinor: split.currentMinor.toString(),
      nonCurrentMinor: split.nonCurrentMinor.toString(),
      reclassifiedMinor: b.currentPortionMinor.toString(),
      splitPosted: b.currentPortionMinor === split.currentMinor,
      totalInterestMinor: terms.rows.reduce((a, r) => a + r.interestMinor, 0n).toString(),
      covenants: covenantCount.get(b.id) ?? 0,
      notes: b.notes,
    };
  });

  // What the ledger says the same accounts hold. A reversed entry and its
  // reversal net to nothing; reading only "posted" lines would count the
  // reversal alone and report a difference that is not there.
  const accounts = await prisma.account.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      code: { in: [BORROWINGS_ACCOUNT, BORROWINGS_CURRENT_ACCOUNT] },
    },
    select: { id: true, code: true },
  });
  const lines = accounts.length
    ? await prisma.journalLine.findMany({
        where: {
          orgId: opts.orgId,
          accountId: { in: accounts.map((a) => a.id) },
          entry: { status: { in: ["posted", "reversed"] }, entryDate: { lte: asOf } },
        },
        select: { accountId: true, functionalAmountMinor: true },
      })
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a.code]));
  let ledgerNonCurrent = 0n;
  let ledgerCurrent = 0n;
  for (const l of lines) {
    // Both are credit balances, so the sign is flipped to compare against a
    // register that states what is owed as a positive number.
    if (byId.get(l.accountId) === BORROWINGS_ACCOUNT) ledgerNonCurrent += -l.functionalAmountMinor;
    if (byId.get(l.accountId) === BORROWINGS_CURRENT_ACCOUNT) ledgerCurrent += -l.functionalAmountMinor;
  }

  const registerOutstanding = rows.reduce((a, b) => a + b.outstandingMinor, 0n);
  const ledgerTotal = ledgerNonCurrent + ledgerCurrent;

  return {
    asOf: iso(asOf),
    facilities,
    totals: {
      principalMinor: rows.reduce((a, b) => a + b.principalMinor, 0n).toString(),
      outstandingMinor: registerOutstanding.toString(),
      currentMinor: facilities.reduce((a, f) => a + BigInt(f.currentMinor), 0n).toString(),
      nonCurrentMinor: facilities.reduce((a, f) => a + BigInt(f.nonCurrentMinor), 0n).toString(),
      reclassifiedMinor: rows.reduce((a, b) => a + b.currentPortionMinor, 0n).toString(),
    },
    ledger: {
      nonCurrentMinor: ledgerNonCurrent.toString(),
      currentMinor: ledgerCurrent.toString(),
      totalMinor: ledgerTotal.toString(),
      agrees: ledgerTotal === registerOutstanding,
      differenceMinor: (ledgerTotal - registerOutstanding).toString(),
    },
    maturity: await maturityAnalysis({ orgId: opts.orgId, entityId: opts.entityId, asOf: iso(asOf) }),
  };
}

/** One facility's amortisation table, with the dates each instalment falls due. */
export async function borrowingSchedule(opts: { orgId: string; entityId: string; code: string }) {
  const b = await facility(opts, opts.code);
  const terms = termsOf(b);

  return {
    code: b.code,
    lender: b.lender,
    currency: b.currency,
    status: b.status,
    drawn: b.status !== "draft",
    interestBasis: b.interestBasis,
    frequency: b.frequency,
    principalMinor: b.principalMinor.toString(),
    instalmentMinor: terms.instalmentMinor.toString(),
    instalments: terms.periods,
    paidTo: b.paidTo,
    statedRateBps: b.statedRateBps,
    statedPeriodRateBps: terms.statedPeriodRateBps,
    effectiveRateBps: b.status === "draft" ? terms.effectiveRateBps : b.effectiveRateBps,
    flatInterestMinor: terms.flatInterestMinor === null ? null : terms.flatInterestMinor.toString(),
    rows: terms.rows.map((r) => ({
      instalmentNo: r.instalmentNo,
      dueOn: iso(terms.dueOn(r.instalmentNo)),
      openingMinor: r.openingMinor.toString(),
      interestMinor: r.interestMinor.toString(),
      principalMinor: r.principalMinor.toString(),
      instalmentMinor: r.instalmentMinor.toString(),
      closingMinor: r.closingMinor.toString(),
      posted: r.instalmentNo <= b.paidTo,
    })),
    totals: {
      interestMinor: terms.rows.reduce((a, r) => a + r.interestMinor, 0n).toString(),
      principalMinor: terms.rows.reduce((a, r) => a + r.principalMinor, 0n).toString(),
      cashMinor: terms.rows.reduce((a, r) => a + r.instalmentMinor, 0n).toString(),
    },
    note: b.status === "draft"
      ? "Indicative — the facility has not been drawn, so nothing here is in the ledger yet."
      : b.interestBasis === "FLAT"
        ? `Quoted at ${b.statedRateBps} basis points flat, which on the balance actually outstanding is ` +
          `${b.effectiveRateBps}. The interest below is charged at the effective rate, because IFRS 9 measures a ` +
          "liability at amortised cost using that rate and not the quoted one. The cash is unchanged; the split " +
          "between interest and principal is, and it is heavier in the early years than the lender's own slip shows."
        : "Interest is charged on the balance outstanding at the contractual rate, which for a facility with no " +
          "arrangement fee is also its effective rate under IFRS 9.",
  };
}
