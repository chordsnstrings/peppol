import { createHash } from "node:crypto";
import { prisma } from "@/lib/server/prisma";
import { post, LedgerError } from "./post";
import { addAccount } from "./chart";

/**
 * Leases under IFRS 16.
 *
 * IFRS 16 removed the operating/finance distinction for lessees. Almost every
 * lease goes on the balance sheet: at the commencement date the lessee
 * recognises a lease liability at the present value of the lease payments not
 * yet paid, discounted at the incremental borrowing rate (IFRS 16.26), and a
 * right-of-use asset measured at that liability (IFRS 16.23–24).
 *
 * Thereafter two entirely separate things happen every period, and conflating
 * them is the classic error:
 *
 *   1. Interest unwinds on the liability — Dr finance cost, Cr 2600
 *      (IFRS 16.36(b), effective interest method). The liability grows by the
 *      interest and falls by the payment, so the interest charge SHRINKS over
 *      the life of the lease.
 *   2. The right-of-use asset depreciates straight-line over the lease term —
 *      Dr 6600, Cr the ROU asset (IFRS 16.31–32). It has nothing to do with
 *      the interest and does not shrink.
 *
 * A payment is Dr 2600, Cr 1010 (IFRS 16.36(a)). It reduces the liability; it
 * is NOT an expense. Booking the payment to rent expense is exactly what
 * IFRS 16 stopped.
 *
 * The consequence, and the reason the numbers never look like the old rent
 * charge: total lease expense (interest + depreciation) is FRONT-LOADED. In no
 * single year does it equal the straight-line rent it replaced — more in the
 * early years, less in the late ones — and only over the whole term do the two
 * sum to the same figure.
 *
 * IAS 1.69 then asks for the part of the liability falling due within twelve
 * months of the reporting date to be presented as a current liability, which
 * 2600 alone cannot say — it sits under non-current liabilities in the chart and
 * a five-year lease is mostly not current. `reclassifyCurrentPortion` posts
 * that split onto 2460, for the same reason `borrowings.ts` posts its own:
 * these statements read the chart, so a split that is only noted is a split no
 * statement can present.
 *
 * As with fixed assets, the register and the ledger are two records on purpose.
 * The lease's term, payment and borrowing rate are a contract and a judgement;
 * the ledger records only their consequences. `leaseRegister()` puts the two
 * side by side, because a register nobody compares to the ledger is a
 * spreadsheet with extra steps.
 *
 * What is deliberately NOT modelled here, and would be wrong to assume:
 *   • Initial direct costs, prepaid lease payments, lease incentives and
 *     restoration provisions (IFRS 16.24(b)–(d)). The ROU asset is set equal to
 *     the liability and nothing else. Where any of those exist, the ROU asset
 *     is understated and has to be adjusted by a separate journal.
 *   • Remeasurement on a rent review, an index change or a reassessed option
 *     (IFRS 16.39–43). The schedule is fixed at commencement — which is what
 *     the schema says too — so a remeasurement is a new event, not a recompute.
 *   • Non-monthly payment frequencies (see `addLease`).
 */

/* ------------------------------------------------------------------ accounts */

/**
 * Interest on a lease liability is a finance cost, and IAS 1.82(b) requires it
 * to be presented separately from operating expenses. It also has to be
 * separable for tax: the Article 30 interest deduction limitation is computed
 * on net interest expenditure, which cannot be found if the interest is mixed
 * in with bank charges.
 *
 * 6360 exists for exactly that, so nothing here needs reclassifying later.
 */
export const FINANCE_COST_ACCOUNT = "6360";
/** IFRS 16.47(a): the right-of-use asset is presented separately. */
export const ROU_ASSET_ACCOUNT = "1700";
export const LEASE_LIABILITY_ACCOUNT = "2600";
/**
 * The part of the lease liability falling due within twelve months.
 *
 * 2600 sits under "Non-current liabilities" in the chart, which is right for
 * what is left of a five-year lease and wrong for the next twelve payments of
 * it. IAS 1.69(a) makes the amount due to be settled within twelve months of
 * the reporting date a current liability, and a lease liability is not exempt
 * from that merely because IFRS 16.47(b) also wants it shown on a line of its
 * own. So there is a current sibling, and `reclassifyCurrentPortion` posts into
 * it — see there for why it is posted rather than noted.
 *
 * It is 2460 and not, say, 2620 for the same reason borrowings' is 2450: the
 * statements read the chart's hierarchy first and the code band second, and the
 * two have to agree.
 */
export const LEASE_LIABILITY_CURRENT_ACCOUNT = "2460";
export const ROU_DEPRECIATION_ACCOUNT = "6600";
/** Where an exempt lease's payments go instead — IFRS 16.6. */
export const RENT_ACCOUNT = "6100";
export const CASH_ACCOUNT = "1010";

/** 100% expressed in basis points. Every rate in this module is an integer of these. */
const ONE_HUNDRED_PERCENT_BPS = 10_000n;

/* ------------------------------------------------------------ pure functions */

/**
 * The present value of `periods` level payments, discounted at
 * `ratePerPeriodBps` per period, payments in arrears.
 *
 *     PV = Σ  payment / (1 + r)^t     for t = 1 … periods
 *
 * Done as exact rational arithmetic in BigInt and rounded once, at the end.
 * There is no `Math.pow` and no float anywhere near it: a discount factor held
 * as a float drifts, and the drift lands in a liability that then never
 * amortises to nil. The recursion below is the same sum rearranged so that the
 * numerator and denominator stay whole numbers —
 *
 *     num(k) = 10000 · (payment · grown^(k-1) + num(k-1)),  den(k) = grown^k
 *
 * where `grown` is (1 + r) in basis points. `num` and `den` grow large; BigInt
 * does not care, and the alternative is rounding once per period instead of
 * once in total.
 *
 * At a zero rate this returns exactly payment × periods, which is the sanity
 * check worth keeping: an undiscounted lease is just the sum of its payments.
 */
export function presentValue(opts: {
  paymentMinor: number | bigint | string;
  periods: number;
  ratePerPeriodBps: number;
}): bigint {
  const payment = BigInt(opts.paymentMinor);
  if (payment <= 0n) throw new LedgerError("A lease payment has to be more than nothing.");
  if (!Number.isInteger(opts.periods) || opts.periods <= 0) {
    throw new LedgerError("A present value needs a whole number of periods, greater than zero.");
  }
  if (!Number.isInteger(opts.ratePerPeriodBps) || opts.ratePerPeriodBps < 0 || opts.ratePerPeriodBps > 10_000) {
    throw new LedgerError(
      `A discount rate is a whole number of basis points between 0 and 10000; ${opts.ratePerPeriodBps} is not. ` +
        "6% is 600.",
    );
  }

  const grown = ONE_HUNDRED_PERCENT_BPS + BigInt(opts.ratePerPeriodBps);
  let num = 0n;
  let den = 1n; // grown^0
  for (let k = 0; k < opts.periods; k++) {
    num = ONE_HUNDRED_PERCENT_BPS * (payment * den + num);
    den *= grown;
  }
  // Half-up, done on the exact fraction rather than on a rounded intermediate.
  return (2n * num + den) / (2n * den);
}

/**
 * The annual incremental borrowing rate as a rate per period.
 *
 * Rounded to the nearest basis point, because a rate carried to more places
 * than that is a float, and a float has no business in a discount factor. It is
 * an approximation and it is a visible one: 6% a year is exactly 50bp a month,
 * but 5% a year is 41.67bp and becomes 42bp — an effective 5.04%. The rate
 * actually used is reported by the schedule and the register so the discounting
 * can be re-performed.
 *
 * What matters far more than the rounding is that the SAME rate discounts the
 * payments and unwinds the liability. It does, because everything here goes
 * through this function.
 */
export function periodRateBps(annualBps: number, periodsPerYear: number): number {
  if (!Number.isInteger(annualBps) || annualBps < 0 || annualBps > 10_000) {
    throw new LedgerError(`An annual borrowing rate is 0 to 10000 basis points; ${annualBps} is not. 6% is 600.`);
  }
  if (!Number.isInteger(periodsPerYear) || periodsPerYear <= 0) {
    throw new LedgerError("Periods per year has to be a whole number greater than zero.");
  }
  // Integer half-up: (2a + n) / 2n.
  return Number((2n * BigInt(annualBps) + BigInt(periodsPerYear)) / (2n * BigInt(periodsPerYear)));
}

/** One period of the amortisation table. Amounts are minor units. */
export interface ScheduleRow {
  /** 1-based, counted from the commencement date. */
  periodNo: number;
  openingLiabilityMinor: bigint;
  interestMinor: bigint;
  paymentMinor: bigint;
  closingLiabilityMinor: bigint;
  rouDepreciationMinor: bigint;
  closingRouMinor: bigint;
}

/** Interest for one period, half-up, on the opening liability. */
function interestOn(openingMinor: bigint, ratePerPeriodBps: number): bigint {
  const bps = BigInt(ratePerPeriodBps);
  if (bps === 0n) return 0n;
  return (openingMinor * bps + ONE_HUNDRED_PERCENT_BPS / 2n) / ONE_HUNDRED_PERCENT_BPS;
}

/**
 * The whole amortisation table, from the liability and ROU asset recognised at
 * commencement.
 *
 * Within a period the order is: interest accrues, then the payment is made.
 * That is what "payments in arrears" means and it is the assumption
 * `presentValue` discounts under; reversing it would overstate the liability by
 * one period's interest.
 *
 * The closing liability of the last period is EXACTLY zero. The discounting
 * left a few minor units of rounding somewhere and it has to land in one place;
 * it lands in the final period's interest, exactly as the last month of an
 * asset's life absorbs the rounding in `monthlyCharge`. The alternative —
 * adjusting the final payment — would misstate a contractual amount, and
 * leaving the remainder unallocated would park a fil of lease liability on the
 * balance sheet for ever. IFRS 16.36 leaves nothing owed at the end of the
 * term, so the schedule has to say so too.
 *
 * The ROU asset is depreciated straight-line over the same term (IFRS 16.32),
 * independently of the interest, and its last period absorbs its own rounding.
 */
export function buildSchedule(opts: {
  liabilityMinor: bigint;
  rouMinor: bigint;
  paymentMinor: bigint;
  ratePerPeriodBps: number;
  periods: number;
}): ScheduleRow[] {
  if (!Number.isInteger(opts.periods) || opts.periods <= 0) {
    throw new LedgerError("A lease schedule needs a whole number of periods, greater than zero.");
  }
  if (opts.liabilityMinor < 0n || opts.rouMinor < 0n) {
    throw new LedgerError("A lease schedule cannot start from a negative liability or right-of-use asset.");
  }

  const rows: ScheduleRow[] = [];
  let liability = opts.liabilityMinor;
  let accumDep = 0n;

  for (let t = 1; t <= opts.periods; t++) {
    const last = t === opts.periods;
    const opening = liability;

    let interest = interestOn(opening, opts.ratePerPeriodBps);
    if (last) {
      // The balancing figure. It is the ordinary interest plus or minus the
      // accumulated rounding, which is a handful of minor units.
      const plug = opts.paymentMinor - opening;
      if (plug < 0n) {
        throw new LedgerError(
          `The final payment does not clear the liability: ${opening} is still outstanding against a payment of ` +
            `${opts.paymentMinor}. The opening liability has to be the present value of the payments at the rate ` +
            "being unwound — check the rate, the term and the payment against each other.",
        );
      }
      interest = plug;
    }
    const closing = opening + interest - opts.paymentMinor;

    // Straight line over the term, with the last period taking the remainder so
    // the asset finishes at exactly nil rather than approximately nil.
    const remainingRou = opts.rouMinor - accumDep;
    let depreciation = opts.rouMinor / BigInt(opts.periods);
    if (depreciation > remainingRou) depreciation = remainingRou;
    if (remainingRou - depreciation < depreciation) depreciation = remainingRou;
    if (depreciation <= 0n) depreciation = remainingRou;
    accumDep += depreciation;

    rows.push({
      periodNo: t,
      openingLiabilityMinor: opening,
      interestMinor: interest,
      paymentMinor: opts.paymentMinor,
      closingLiabilityMinor: closing,
      rouDepreciationMinor: depreciation,
      closingRouMinor: opts.rouMinor - accumDep,
    });
    liability = closing;
  }

  return rows;
}

/**
 * The part of a lease liability falling due within twelve months of a
 * reporting date, and the part falling due after it.
 *
 * IAS 1.69(c)–(d): a liability is current where it is due to be settled within
 * twelve months of the reporting date, or where the entity has no unconditional
 * right to defer settlement beyond then. On a lease that is the PRINCIPAL the
 * next twelve payments repay — which is the liability today less the liability
 * in twelve months' time, both read off the amortisation table.
 *
 * Taking the difference rather than adding up twelve payments is what keeps the
 * interest out, and the interest is the whole trap. A payment is principal and
 * interest together; future interest has not accrued at the reporting date and
 * is not a liability yet (IFRS 16.36(b) unwinds it as time passes), so counting
 * twelve payments overstates current liabilities by a year of finance cost
 * every time. On a five-year lease at 6% that is the difference between a
 * current portion of about 90k and one of 100k.
 *
 * `elapsed` is how many periods of the schedule have closed by the reporting
 * date: 0 on the commencement date itself, 12 a year later. Past the end of the
 * term everything is nil, because the schedule closes at exactly nothing.
 */
export function currentPortionOf(opts: {
  rows: ScheduleRow[];
  elapsed: number;
}): { currentMinor: bigint; nonCurrentMinor: bigint } {
  const rows = opts.rows;
  if (rows.length === 0) return { currentMinor: 0n, nonCurrentMinor: 0n };
  if (!Number.isInteger(opts.elapsed) || opts.elapsed < 0) {
    throw new LedgerError("A current-portion split needs a whole number of periods elapsed, not fewer than none.");
  }

  const at = (period: number) =>
    period <= 0
      ? rows[0].openingLiabilityMinor
      : rows[Math.min(period, rows.length) - 1].closingLiabilityMinor;

  const outstanding = at(opts.elapsed);
  const afterTwelve = at(opts.elapsed + 12);
  return { currentMinor: outstanding - afterTwelve, nonCurrentMinor: afterTwelve };
}

/* -------------------------------------------------------------- the register */

export type LeaseFrequency = "MONTHLY" | "QUARTERLY" | "ANNUAL";
export type Exemption = "SHORT_TERM" | "LOW_VALUE";

export interface NewLease {
  code: string;
  name: string;
  lessor?: string;
  /** The commencement date — when the asset becomes available for use. */
  startsOn: string;
  endsOn: string;
  paymentMinor: number | bigint | string;
  frequency?: LeaseFrequency;
  /** Incremental borrowing rate, annual, in basis points. 6% is 600. */
  discountRateBps: number;
}

type LeaseRow = {
  id: string; code: string; name: string; lessor: string | null;
  startsOn: Date; endsOn: Date; paymentMinor: bigint; frequency: string;
  discountRateBps: number;
  initialLiabilityMinor: bigint; initialRouMinor: bigint;
  liabilityMinor: bigint; accumRouDepMinor: bigint;
  chargedTo: string | null; status: string;
};

/** "2026-03" → an ordinal, so periods can be compared and counted. */
const monthIndex = (label: string) => {
  const [y, m] = label.split("-").map(Number);
  return y * 12 + (m - 1);
};
const monthLabel = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** Months from commencement to expiry, both ends inclusive. Jan to Dec is 12. */
export function termMonths(startsOn: Date, endsOn: Date): number {
  return monthIndex(monthLabel(endsOn)) - monthIndex(monthLabel(startsOn)) + 1;
}

/**
 * Whether a lease is off balance sheet, and why.
 *
 * The schema carries no exemption column, so the exemption is recorded as what
 * it actually IS: a lease that has commenced with nothing recognised. That is
 * not a workaround — it is the only definition that cannot drift from the
 * ledger, because a capitalised lease always recognises a positive liability
 * (a payment is positive and a term is at least one period, so its present
 * value cannot be nil). A flag could disagree with the balance sheet; this
 * cannot.
 *
 * The reason is derived from the term, which is the test IFRS 16 itself
 * applies: 12 months or less is the short-term exemption (IFRS 16.5(a) and the
 * Appendix A definition), and anything longer can only have been taken under
 * the low-value exemption (IFRS 16.5(b), IFRS 16.B3–B8). Where both are
 * available the short-term reason is reported, because it is the one a reader
 * can re-perform from the contract — low value is a judgement about the
 * underlying asset that no register can check.
 */
export function exemptionOf(lease: { status: string; initialLiabilityMinor: bigint; startsOn: Date; endsOn: Date }):
  | { exempt: false; reason: null }
  | { exempt: true; reason: Exemption } {
  if (lease.status === "draft" || lease.initialLiabilityMinor !== 0n) return { exempt: false, reason: null };
  return { exempt: true, reason: termMonths(lease.startsOn, lease.endsOn) <= 12 ? "SHORT_TERM" : "LOW_VALUE" };
}

const exemptionWording: Record<Exemption, string> = {
  SHORT_TERM: "short-term lease of 12 months or less (IFRS 16.5(a))",
  LOW_VALUE: "lease of a low-value underlying asset (IFRS 16.5(b))",
};

/**
 * Record a lease contract. Nothing reaches the ledger until it is activated —
 * the contract and its recognition are two acts, and only the second is a
 * posting.
 */
export async function addLease(opts: { orgId: string; entityId: string; lease: NewLease }) {
  const l = opts.lease;
  const payment = BigInt(l.paymentMinor);
  const frequency = l.frequency ?? "MONTHLY";

  const starts = new Date(l.startsOn);
  const ends = new Date(l.endsOn);
  if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime())) {
    throw new LedgerError("A lease needs a start and an end date, each written like 2026-01-01.");
  }
  if (ends <= starts) {
    throw new LedgerError(
      `A lease has to end after it starts; ${l.endsOn} is not after ${l.startsOn}.`,
    );
  }
  if (payment <= 0n) throw new LedgerError("A lease payment has to be more than nothing.");
  if (!Number.isInteger(l.discountRateBps) || l.discountRateBps < 0 || l.discountRateBps > 10_000) {
    throw new LedgerError(
      `The incremental borrowing rate is a whole number of basis points between 0 and 10000; ` +
        `${l.discountRateBps} is not. 6% a year is 600.`,
    );
  }
  // Both the amortisation table and the periodic run are built on calendar
  // months. A quarterly lease would need the run to know which months complete
  // a payment period, and a schedule whose rows are quarters cannot be
  // reconciled against a monthly run — so it is refused rather than
  // approximated into monthly payments behind the user's back.
  if (frequency !== "MONTHLY") {
    throw new LedgerError(
      `${frequency.toLowerCase()} payments are not supported yet — the schedule and the monthly run are both built ` +
        "on calendar months. Record the lease with its monthly equivalent payment, or wait for the run to be " +
        "generalised.",
    );
  }

  const clash = await prisma.lease.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: l.code },
  });
  if (clash) throw new LedgerError(`Lease ${l.code} is already on the register.`);

  return prisma.lease.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId,
      code: l.code, name: l.name, lessor: l.lessor ?? null,
      startsOn: starts, endsOn: ends,
      paymentMinor: payment, frequency,
      discountRateBps: l.discountRateBps,
    },
  });
}

export interface ActivationResult {
  leaseCode: string;
  periods: number;
  /** The rate actually used to discount and to unwind. */
  periodRateBps: number;
  exempt: boolean;
  exemptionReason: Exemption | null;
  initialLiabilityMinor: string;
  initialRouMinor: string;
  entryId: string | null;
  reference: string | null;
}

/**
 * Commence a lease.
 *
 * The commencement date is the date the recognition exemption is elected
 * (IFRS 16.5), so the election belongs here rather than on the contract.
 *
 * Capitalised:
 *
 *   Dr  1700 Right-of-use asset    the present value of the payments
 *     Cr  2600 Lease liability       the same figure
 *
 * The ROU asset equals the liability exactly. IFRS 16.24 would add initial
 * direct costs, prepayments and restoration costs; those are IGNORED here and
 * have to go in by separate journal if they exist.
 *
 * Exempt: nothing is recognised at all. The cost reaches the ledger one month
 * at a time through `runLeasePeriod`, as rent.
 */
export async function activateLease(opts: {
  orgId: string;
  entityId: string;
  leaseCode: string;
  /** Elect a recognition exemption instead of capitalising (IFRS 16.5–8). */
  exempt?: Exemption;
  actorId?: string;
}): Promise<ActivationResult> {
  const lease = (await prisma.lease.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.leaseCode },
  })) as unknown as LeaseRow | null;
  if (!lease) throw new LedgerError(`Lease ${opts.leaseCode} is not on the register.`);
  if (lease.status !== "draft") {
    throw new LedgerError(`Lease ${lease.code} has already commenced; it is ${lease.status}.`);
  }

  const periods = termMonths(lease.startsOn, lease.endsOn);
  const rate = periodRateBps(lease.discountRateBps, 12);

  if (opts.exempt) {
    // The short-term exemption is defined by the lease term, so a claim that
    // does not match the contract is refused rather than recorded.
    if (opts.exempt === "SHORT_TERM" && periods > 12) {
      throw new LedgerError(
        `Lease ${lease.code} runs for ${periods} months, so it is not a short-term lease — IFRS 16 defines that as ` +
          "12 months or less. Capitalise it, or take the low-value exemption if the underlying asset qualifies.",
      );
    }
    await prisma.lease.update({
      where: { id: lease.id },
      // Nothing on the balance sheet: no liability, no right-of-use asset.
      // `exemptionOf` reads exactly this state back.
      data: { status: "active", initialLiabilityMinor: 0n, initialRouMinor: 0n, liabilityMinor: 0n },
    });
    return {
      leaseCode: lease.code,
      periods,
      periodRateBps: rate,
      exempt: true,
      exemptionReason: opts.exempt,
      initialLiabilityMinor: "0",
      initialRouMinor: "0",
      entryId: null,
      reference: null,
    };
  }

  const liability = presentValue({ paymentMinor: lease.paymentMinor, periods, ratePerPeriodBps: rate });
  // Proved before anything is posted: a liability that does not amortise to nil
  // would leave a balance on 2600 for ever, and it is cheaper to find out now.
  buildSchedule({
    liabilityMinor: liability, rouMinor: liability,
    paymentMinor: lease.paymentMinor, ratePerPeriodBps: rate, periods,
  });

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: lease.startsOn.toISOString().slice(0, 10),
    memo: `Lease ${lease.code} ${lease.name} recognised on commencement`,
    source: "lease",
    sourceType: "LEASE_INCEPTION",
    sourceId: lease.id,
    externalKey: `lease-inception:${lease.id}`,
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "LI",
    lines: [
      { account: ROU_ASSET_ACCOUNT, debit: liability, memo: `${lease.code} right-of-use asset` },
      { account: LEASE_LIABILITY_ACCOUNT, credit: liability, memo: `${lease.code} lease liability` },
    ],
  });

  // The register moves only once the journal has committed; the other order
  // would leave a lease marked active with nothing in the books.
  await prisma.lease.update({
    where: { id: lease.id },
    data: {
      status: "active",
      initialLiabilityMinor: liability,
      initialRouMinor: liability,
      liabilityMinor: liability,
    },
  });

  return {
    leaseCode: lease.code,
    periods,
    periodRateBps: rate,
    exempt: false,
    exemptionReason: null,
    initialLiabilityMinor: liability.toString(),
    initialRouMinor: liability.toString(),
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
  };
}

export interface LeaseScheduleResult {
  leaseCode: string;
  name: string;
  status: string;
  /** False while the lease is still a draft — the figures are then indicative. */
  activated: boolean;
  exempt: boolean;
  exemptionReason: Exemption | null;
  periods: number;
  annualRateBps: number;
  periodRateBps: number;
  initialLiabilityMinor: string;
  initialRouMinor: string;
  rows: {
    periodNo: number;
    period: string;
    openingLiabilityMinor: string;
    interestMinor: string;
    paymentMinor: string;
    closingLiabilityMinor: string;
    rouDepreciationMinor: string;
    closingRouMinor: string;
  }[];
  totals: { interestMinor: string; paymentsMinor: string; depreciationMinor: string };
  note: string | null;
}

/**
 * The full amortisation table for one lease, month by month.
 *
 * For a draft lease this projects what commencement would recognise, so the
 * figures can be looked at before they are posted. For an active lease it is
 * the schedule the periodic run charges from — the same function, so the two
 * cannot disagree.
 */
export async function leaseSchedule(opts: {
  orgId: string;
  entityId: string;
  leaseCode: string;
}): Promise<LeaseScheduleResult> {
  const lease = (await prisma.lease.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.leaseCode },
  })) as unknown as LeaseRow | null;
  if (!lease) throw new LedgerError(`Lease ${opts.leaseCode} is not on the register.`);

  const periods = termMonths(lease.startsOn, lease.endsOn);
  const rate = periodRateBps(lease.discountRateBps, 12);
  const exemption = exemptionOf(lease);
  const startIndex = monthIndex(monthLabel(lease.startsOn));

  const base = {
    leaseCode: lease.code,
    name: lease.name,
    status: lease.status,
    activated: lease.status !== "draft",
    exempt: exemption.exempt,
    exemptionReason: exemption.reason,
    periods,
    annualRateBps: lease.discountRateBps,
    periodRateBps: rate,
  };

  if (exemption.exempt) {
    // An exempt lease has no liability to amortise, so it has no amortisation
    // table. Saying so is more useful than a table of zeroes that invites
    // someone to reconcile it against a balance sheet it was never on.
    return {
      ...base,
      initialLiabilityMinor: "0",
      initialRouMinor: "0",
      rows: [],
      totals: { interestMinor: "0", paymentsMinor: (lease.paymentMinor * BigInt(periods)).toString(), depreciationMinor: "0" },
      note:
        `Exempt — ${exemptionWording[exemption.reason]}. The payments are charged straight-line to rent, so there ` +
        "is no liability to unwind and no right-of-use asset to depreciate.",
    };
  }

  const liability = base.activated
    ? lease.initialLiabilityMinor
    : presentValue({ paymentMinor: lease.paymentMinor, periods, ratePerPeriodBps: rate });
  const rou = base.activated ? lease.initialRouMinor : liability;

  const rows = buildSchedule({
    liabilityMinor: liability, rouMinor: rou,
    paymentMinor: lease.paymentMinor, ratePerPeriodBps: rate, periods,
  });

  const totalInterest = rows.reduce((a, r) => a + r.interestMinor, 0n);
  const totalPayments = rows.reduce((a, r) => a + r.paymentMinor, 0n);
  const totalDepreciation = rows.reduce((a, r) => a + r.rouDepreciationMinor, 0n);

  return {
    ...base,
    initialLiabilityMinor: liability.toString(),
    initialRouMinor: rou.toString(),
    rows: rows.map((r) => {
      const idx = startIndex + r.periodNo - 1;
      return {
        periodNo: r.periodNo,
        period: `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`,
        openingLiabilityMinor: r.openingLiabilityMinor.toString(),
        interestMinor: r.interestMinor.toString(),
        paymentMinor: r.paymentMinor.toString(),
        closingLiabilityMinor: r.closingLiabilityMinor.toString(),
        rouDepreciationMinor: r.rouDepreciationMinor.toString(),
        closingRouMinor: r.closingRouMinor.toString(),
      };
    }),
    totals: {
      interestMinor: totalInterest.toString(),
      paymentsMinor: totalPayments.toString(),
      depreciationMinor: totalDepreciation.toString(),
    },
    note: base.activated
      ? null
      : "Indicative — the lease has not commenced, so nothing here is in the ledger yet.",
  };
}

export interface LeaseRunResult {
  period: string;
  leasesCharged: number;
  interestMinor: string;
  depreciationMinor: string;
  /** Straight-line rent on the exempt leases — IFRS 16.6. */
  rentMinor: string;
  entryId: string | null;
  reference: string | null;
  /** Leases skipped, and why — silence here would hide a stalled schedule. */
  skipped: { code: string; reason: string }[];
}

/**
 * Charge one month on every lease that has commenced.
 *
 * Two charges on a capitalised lease, and they are separate on purpose:
 *
 *   Dr  6360 finance cost         interest for the month
 *     Cr  2600 lease liability      it unwinds INTO the liability, not out of it
 *   Dr  6600 depreciation         a twelfth of a year of the term
 *     Cr  1700 right-of-use asset
 *
 * and on an exempt lease, one:
 *
 *   Dr  6100 rent
 *     Cr  1010 bank
 *
 * The interest comes from the schedule built at commencement, not from
 * whatever the liability happens to be today. That matters: the effective
 * interest schedule is fixed until a remeasurement event (IFRS 16.36, 39–43),
 * so a missed payment leaves arrears — it does not change the unwinding. It
 * also makes the run independent of whether the month's payment has been
 * recorded yet, which a charge computed off the live balance would not be.
 *
 * Idempotent per lease per period, and a missed month is REFUSED rather than
 * folded into this one — a gap means a run was never made, and quietly
 * catching it up hides that.
 */
export async function runLeasePeriod(opts: {
  orgId: string;
  entityId: string;
  /** YYYY-MM. */
  period: string;
  postingDate?: string;
  cashAccount?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<LeaseRunResult> {
  if (!/^\d{4}-\d{2}$/.test(opts.period)) throw new LedgerError("A lease period looks like 2026-03.");

  const leases = (await prisma.lease.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: { in: ["active", "draft"] } },
    orderBy: { code: "asc" },
  })) as unknown as LeaseRow[];

  const target = monthIndex(opts.period);
  const skipped: { code: string; reason: string }[] = [];
  const charges: {
    lease: LeaseRow;
    interest: bigint;
    depreciation: bigint;
    rent: bigint;
    exemptionReason: Exemption | null;
    finalPeriod: boolean;
  }[] = [];

  for (const lease of leases) {
    // A draft lease is on the register and not in the ledger. Saying nothing
    // about it would let a commenced lease sit unrecognised for months.
    if (lease.status === "draft") {
      skipped.push({ code: lease.code, reason: "still a draft — it has not commenced, so nothing has been recognised" });
      continue;
    }

    const start = monthIndex(monthLabel(lease.startsOn));
    const periods = termMonths(lease.startsOn, lease.endsOn);
    const periodNo = target - start + 1;

    if (periodNo < 1) {
      skipped.push({ code: lease.code, reason: `commences in ${monthLabel(lease.startsOn)}, after this period` });
      continue;
    }
    if (periodNo > periods) {
      skipped.push({ code: lease.code, reason: `the term ended in ${monthLabel(lease.endsOn)}` });
      continue;
    }
    if (lease.chargedTo && monthIndex(lease.chargedTo) >= target) {
      skipped.push({ code: lease.code, reason: `already charged to ${lease.chargedTo}` });
      continue;
    }
    // Do not silently catch up several months in one charge — see the same
    // guard in runDepreciation. The first charge of all has to be the lease's
    // own first month, or the schedule starts in the wrong place.
    if (lease.chargedTo && monthIndex(lease.chargedTo) < target - 1) {
      skipped.push({
        code: lease.code,
        reason: `last charged to ${lease.chargedTo} — run the months in between first`,
      });
      continue;
    }
    if (!lease.chargedTo && periodNo > 1) {
      skipped.push({
        code: lease.code,
        reason: `commenced in ${monthLabel(lease.startsOn)} and has never been charged — run that month first`,
      });
      continue;
    }

    const exemption = exemptionOf(lease);
    if (exemption.exempt) {
      // IFRS 16.6: the payments are recognised as an expense on a straight-line
      // basis over the term. With the level monthly payments this module
      // models, that is the payment itself; an uneven payment profile would
      // need an accrual, which is not modelled — see the header.
      charges.push({
        lease, interest: 0n, depreciation: 0n, rent: lease.paymentMinor,
        exemptionReason: exemption.reason, finalPeriod: periodNo === periods,
      });
      continue;
    }

    const rate = periodRateBps(lease.discountRateBps, 12);
    const row = buildSchedule({
      liabilityMinor: lease.initialLiabilityMinor,
      rouMinor: lease.initialRouMinor,
      paymentMinor: lease.paymentMinor,
      ratePerPeriodBps: rate,
      periods,
    })[periodNo - 1];

    if (row.interestMinor === 0n && row.rouDepreciationMinor === 0n) {
      skipped.push({ code: lease.code, reason: "nothing left to charge for this period" });
      continue;
    }
    charges.push({
      lease, interest: row.interestMinor, depreciation: row.rouDepreciationMinor, rent: 0n,
      exemptionReason: null, finalPeriod: periodNo === periods,
    });
  }

  const totals = charges.reduce(
    (a, c) => ({ interest: a.interest + c.interest, depreciation: a.depreciation + c.depreciation, rent: a.rent + c.rent }),
    { interest: 0n, depreciation: 0n, rent: 0n },
  );

  if (charges.length === 0) {
    return {
      period: opts.period, leasesCharged: 0,
      interestMinor: "0", depreciationMinor: "0", rentMinor: "0",
      entryId: null, reference: null, skipped,
    };
  }

  // Post on the last day of the period unless told otherwise — the unwinding
  // and the depreciation are period-end measurements, not events on a day.
  const [y, m] = opts.period.split("-").map(Number);
  const entryDate = opts.postingDate ?? new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const cash = opts.cashAccount ?? CASH_ACCOUNT;

  const lines: { account: string; debit?: bigint; credit?: bigint; memo: string }[] = [];
  for (const c of charges) {
    if (c.interest > 0n) {
      lines.push({ account: FINANCE_COST_ACCOUNT, debit: c.interest, memo: `${c.lease.code} interest on lease liability` });
      lines.push({ account: LEASE_LIABILITY_ACCOUNT, credit: c.interest, memo: `${c.lease.code} interest unwound` });
    }
    if (c.depreciation > 0n) {
      lines.push({ account: ROU_DEPRECIATION_ACCOUNT, debit: c.depreciation, memo: `${c.lease.code} right-of-use depreciation` });
      lines.push({ account: ROU_ASSET_ACCOUNT, credit: c.depreciation, memo: `${c.lease.code} right-of-use depreciation` });
    }
    if (c.rent > 0n) {
      // The exemption is written into the ledger itself, not only the register,
      // so an entry can be read years later without the register beside it.
      const why = exemptionWording[c.exemptionReason ?? "LOW_VALUE"];
      lines.push({ account: RENT_ACCOUNT, debit: c.rent, memo: `${c.lease.code} rent — exempt, ${why}` });
      lines.push({ account: cash, credit: c.rent, memo: `${c.lease.code} lease payment` });
    }
  }

  // The idempotency key names WHICH leases this entry covers, not merely the
  // month. Keying on the month alone looks right and is not: a lease that
  // commences after the month has already been run would find the earlier
  // entry by key, post nothing at all, and still have its register advanced —
  // a charge on the register with no journal behind it, which is precisely the
  // difference `leaseRegister` exists to catch. A digest of the leases charged
  // still returns the original entry for a true retry, because a retry charges
  // the same set; `chargedTo` is what stops a lease appearing in two of them.
  const runKey = createHash("sha256")
    .update(charges.map((c) => c.lease.id).sort().join("|"))
    .digest("hex")
    .slice(0, 16);

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate,
    memo: `Lease charges for ${opts.period}`,
    source: "lease",
    sourceType: "LEASE_RUN",
    sourceId: opts.period,
    externalKey: `lease-run:${opts.entityId}:${opts.period}:${runKey}`,
    actorType: opts.actorType ?? "RULE",
    actorId: opts.actorId,
    series: "LS",
    lines: lines.map((l) => ({
      account: l.account,
      ...(l.debit !== undefined ? { debit: l.debit } : { credit: l.credit! }),
      memo: l.memo,
    })),
  });

  await prisma.$transaction(
    charges.map((c) =>
      prisma.lease.update({
        where: { id: c.lease.id },
        data: {
          liabilityMinor: c.lease.liabilityMinor + c.interest,
          accumRouDepMinor: c.lease.accumRouDepMinor + c.depreciation,
          chargedTo: opts.period,
          // An exempt lease is finished the month its term ends: it has no
          // liability left to settle, so nothing else can close it.
          ...(c.finalPeriod && c.exemptionReason ? { status: "ended" } : {}),
        },
      }),
    ),
  );

  return {
    period: opts.period,
    leasesCharged: charges.length,
    interestMinor: totals.interest.toString(),
    depreciationMinor: totals.depreciation.toString(),
    rentMinor: totals.rent.toString(),
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    skipped,
  };
}

export interface LeasePaymentResult {
  leaseCode: string;
  period: string;
  amountMinor: string;
  liabilityMinor: string;
  entryId: string;
  reference: string;
  /** True when this call did nothing because the payment was already recorded. */
  alreadyRecorded: boolean;
}

/**
 * Record a lease payment.
 *
 *   Dr  2600 Lease liability
 *     Cr  1010 Bank
 *
 * It discharges the liability. It is NOT an expense — the expense was the
 * interest and the depreciation, charged by `runLeasePeriod`. Posting this to
 * rent is exactly the mistake IFRS 16 was written to stop, and it would double
 * count against the depreciation already charged.
 *
 * Interest accrues over the period and the payment is made at the end of it
 * (payments in arrears, which is what `presentValue` discounts), so the month's
 * run comes before its payment. Idempotent on the lease and the period: one
 * contractual payment falls due per period, so a retry returns the original.
 */
export async function payLease(opts: {
  orgId: string;
  entityId: string;
  leaseCode: string;
  /** YYYY-MM — which contractual payment this is. */
  period: string;
  paidOn?: string;
  /** Defaults to the contractual payment. */
  amountMinor?: number | bigint | string;
  cashAccount?: string;
  actorId?: string;
}): Promise<LeasePaymentResult> {
  if (!/^\d{4}-\d{2}$/.test(opts.period)) throw new LedgerError("A lease period looks like 2026-03.");

  const lease = (await prisma.lease.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.leaseCode },
  })) as unknown as LeaseRow | null;
  if (!lease) throw new LedgerError(`Lease ${opts.leaseCode} is not on the register.`);
  if (lease.status === "draft") {
    throw new LedgerError(`Lease ${lease.code} has not commenced yet, so there is no liability to pay down.`);
  }
  const exemption = exemptionOf(lease);
  if (exemption.exempt) {
    throw new LedgerError(
      `Lease ${lease.code} is exempt — ${exemptionWording[exemption.reason]} — so it has no liability to discharge. ` +
        "Its payments are charged to rent by the monthly run; record the month instead.",
    );
  }

  const amount = opts.amountMinor === undefined ? lease.paymentMinor : BigInt(opts.amountMinor);
  if (amount <= 0n) throw new LedgerError("A lease payment has to be more than nothing.");

  const externalKey = `lease-payment:${lease.id}:${opts.period}`;
  const already = await prisma.journalEntry.findFirst({ where: { orgId: opts.orgId, externalKey } });
  if (already) {
    // The entry is idempotent on its own, but the liability is not — returning
    // early is what stops a retry from paying the lease down twice.
    return {
      leaseCode: lease.code,
      period: opts.period,
      amountMinor: amount.toString(),
      liabilityMinor: lease.liabilityMinor.toString(),
      entryId: already.id,
      reference: `${already.series}-${already.number}`,
      alreadyRecorded: true,
    };
  }

  if (amount > lease.liabilityMinor) {
    throw new LedgerError(
      `Only ${lease.liabilityMinor} is outstanding on lease ${lease.code}, so a payment of ${amount} would take the ` +
        "liability below nil. Interest accrues before the payment falls due — charge the month with the lease run " +
        "first, or record the excess as the separate cost it is.",
    );
  }

  const [y, m] = opts.period.split("-").map(Number);
  const paidOn = opts.paidOn ?? new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: paidOn,
    memo: `Lease payment ${lease.code} for ${opts.period}`,
    source: "lease",
    sourceType: "LEASE_PAYMENT",
    sourceId: lease.id,
    externalKey,
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "LP",
    lines: [
      { account: LEASE_LIABILITY_ACCOUNT, debit: amount, memo: `${lease.code} lease liability settled` },
      { account: opts.cashAccount ?? CASH_ACCOUNT, credit: amount, memo: `${lease.code} lease payment` },
    ],
  });

  const remaining = lease.liabilityMinor - amount;
  const lastPeriod = monthLabel(lease.endsOn);
  await prisma.lease.update({
    where: { id: lease.id },
    data: {
      liabilityMinor: remaining,
      // Finished only when the term has been charged in full AND nothing is
      // owed. Either alone would close a lease that still has something to do.
      ...(remaining === 0n && lease.chargedTo === lastPeriod ? { status: "ended" } : {}),
    },
  });

  return {
    leaseCode: lease.code,
    period: opts.period,
    amountMinor: amount.toString(),
    liabilityMinor: remaining.toString(),
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyRecorded: false,
  };
}

/**
 * The lease register, with the ledger balances it is supposed to agree with.
 *
 * The exemptions are listed separately and named on every row, because an
 * exemption nobody can see is an exemption nobody can audit: a lease that is
 * off the balance sheet leaves no trace in 2600 or 1700, so the register is the
 * only place a reader can find out that it exists at all. IFRS 16.60 requires
 * the short-term and low-value expense to be disclosed for exactly that reason.
 */
/**
 * A lease's liability and right-of-use asset as they stood at a date.
 *
 * The register keeps running figures, which answer "where is this lease now"
 * and nothing else. A note or a statement for a year that has already closed
 * needs the position as at that year end, and the running figures would put
 * today's liability beside that year's ledger — a difference that looks like a
 * defect and is only the wrong question.
 *
 * Taken from the amortisation schedule rather than divided, because unwinding a
 * liability is not linear: interest is charged on what is left, so the split
 * between interest and principal moves every period.
 */
/**
 * How many periods of a lease's schedule have closed by `asOf`, capped at the
 * term. The month the lease commences in counts as the first: the schedule
 * charges interest and takes a payment within it.
 */
function periodsElapsed(lease: { startsOn: Date; endsOn: Date }, asOf: Date): number {
  return Math.min(
    termMonths(lease.startsOn, lease.endsOn),
    (asOf.getUTCFullYear() - lease.startsOn.getUTCFullYear()) * 12 +
      (asOf.getUTCMonth() - lease.startsOn.getUTCMonth()) + 1,
  );
}

export function positionAt(lease: LeaseRow, asOf: Date): { liabilityMinor: bigint; rouCarryingMinor: bigint } {
  if (asOf < lease.startsOn) return { liabilityMinor: 0n, rouCarryingMinor: 0n };

  const periods = termMonths(lease.startsOn, lease.endsOn);
  const elapsed = periodsElapsed(lease, asOf);
  if (elapsed <= 0) {
    return { liabilityMinor: lease.initialLiabilityMinor, rouCarryingMinor: lease.initialRouMinor };
  }

  const schedule = buildSchedule({
    liabilityMinor: lease.initialLiabilityMinor,
    rouMinor: lease.initialRouMinor,
    paymentMinor: lease.paymentMinor,
    ratePerPeriodBps: periodRateBps(lease.discountRateBps, 12),
    periods,
  });
  const row = schedule[elapsed - 1];
  return { liabilityMinor: row.closingLiabilityMinor, rouCarryingMinor: row.closingRouMinor };
}

/* -------------------------------------------------- current and non-current */

/** One lease's split at a date, taken from its own amortisation table. */
function splitAt(lease: LeaseRow, asOf: Date): { currentMinor: bigint; nonCurrentMinor: bigint } {
  // A draft has not been recognised and an exempt lease never will be, so
  // neither has a liability to split. A lease that has not commenced by the
  // reporting date is not on that date's balance sheet at all.
  if (lease.status === "draft" || exemptionOf(lease).exempt || asOf < lease.startsOn) {
    return { currentMinor: 0n, nonCurrentMinor: 0n };
  }
  const periods = termMonths(lease.startsOn, lease.endsOn);
  const rows = buildSchedule({
    liabilityMinor: lease.initialLiabilityMinor,
    rouMinor: lease.initialRouMinor,
    paymentMinor: lease.paymentMinor,
    ratePerPeriodBps: periodRateBps(lease.discountRateBps, 12),
    periods,
  });
  return currentPortionOf({ rows, elapsed: periodsElapsed(lease, asOf) });
}

/**
 * Create the current-portion account if this entity's chart has not got it.
 *
 * 2460 is in the seeded chart in `setup.ts`, but a book opened before it was
 * added there does not have it, and the reclassification would fail with
 * "Account 2460 does not exist" — true, and useless to the person reading it.
 */
async function ensureCurrentPortionAccount(orgId: string, entityId: string) {
  const existing = await prisma.account.findFirst({
    where: { orgId, entityId, code: LEASE_LIABILITY_CURRENT_ACCOUNT },
    select: { id: true },
  });
  if (existing) return;
  await addAccount({
    orgId, entityId,
    account: {
      code: LEASE_LIABILITY_CURRENT_ACCOUNT,
      name: "Lease liabilities — current portion",
      nameAr: "الجزء المتداول من التزامات عقود الإيجار",
      type: "LIABILITY",
      parentCode: "20",
    },
  });
}

/** What 2600 and 2460 hold at a date, stated as amounts owed rather than as credits. */
async function ledgerSplit(orgId: string, entityId: string, asOf: Date | null) {
  const accounts = await prisma.account.findMany({
    where: {
      orgId, entityId,
      code: { in: [LEASE_LIABILITY_ACCOUNT, LEASE_LIABILITY_CURRENT_ACCOUNT] },
    },
    select: { id: true, code: true },
  });
  const lines = accounts.length
    ? await prisma.journalLine.findMany({
        where: {
          orgId,
          accountId: { in: accounts.map((a) => a.id) },
          // A reversed entry and its reversal net to nothing; reading only
          // "posted" lines counts the reversal alone and moves the balance by
          // the full amount, which shows up here as a false difference.
          entry: { status: { in: ["posted", "reversed"] }, ...(asOf ? { entryDate: { lte: asOf } } : {}) },
        },
        select: { accountId: true, functionalAmountMinor: true },
      })
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a.code]));
  let nonCurrent = 0n;
  let current = 0n;
  for (const l of lines) {
    // Both are credit balances, so the sign is flipped to compare against a
    // register that states what is owed as a positive number.
    if (byId.get(l.accountId) === LEASE_LIABILITY_ACCOUNT) nonCurrent += -l.functionalAmountMinor;
    if (byId.get(l.accountId) === LEASE_LIABILITY_CURRENT_ACCOUNT) current += -l.functionalAmountMinor;
  }
  return { currentMinor: current, nonCurrentMinor: nonCurrent };
}

export interface LeaseReclassResult {
  asOf: string;
  posted: boolean;
  /** How much moved between 2600 and 2460, unsigned. */
  movedMinor: string;
  /** What the split should be at this date, across every capitalised lease. */
  currentMinor: string;
  nonCurrentMinor: string;
  /** What 2460 held before this ran. */
  wasMinor: string;
  leases: { code: string; currentMinor: string; nonCurrentMinor: string }[];
  entryId: string | null;
  reference: string | null;
  alreadyPosted: boolean;
  note: string;
}

/**
 * Move the twelve-month portion of every lease liability onto a current one.
 *
 * **Posted rather than only reported, for the reason `borrowings.ts` gives at
 * `reclassifyCurrentPortion` and it is worth repeating here.** IAS 1.69 is a
 * presentation requirement, so a note would satisfy the standard. It would not
 * reach the reader of this product: the statements are built from account
 * balances, and what makes a liability current is where the account sits in the
 * chart. A split that is not in the ledger is a split no statement can present.
 * So it is posted:
 *
 *   Dr  2600 Lease liabilities                  what falls due within a year
 *     Cr  2460 Lease liabilities, current portion
 *
 * It corrects to a TARGET rather than posting an increment, exactly as
 * borrowings does: the entry is the difference between what the split should be
 * at this reporting date and what is already on 2460, so running it twice on
 * one date posts nothing the second time, and running it at successive year
 * ends keeps the split right without anyone reversing last year's.
 *
 * WHAT HAS ALREADY BEEN RECLASSIFIED IS READ FROM THE LEDGER, not from the
 * register. Borrowings keeps a `currentPortionMinor` on each facility; the
 * lease register has no such column and this module may not add one. The ledger
 * is the better record anyway — it is where the reclassification actually
 * happened — but it only knows the total, so the entry is one pair of lines for
 * the whole book rather than a line per lease. The per-lease composition is
 * returned instead, and `leaseRegister` shows it beside what the ledger holds.
 *
 * The same consequence borrowings has: `cashflow.ts` classifies movements from
 * a fixed map that does not name 2460, so a period containing a reclassification
 * will report it as unclassified. That is the statement being honest about a map
 * that has not been extended — 2460 belongs in financing beside 2600 — and it is
 * said here rather than worked around.
 */
export async function reclassifyCurrentPortion(opts: {
  orgId: string;
  entityId: string;
  /** The reporting date the twelve months are counted from. */
  asOf: string;
  actorId?: string;
}): Promise<LeaseReclassResult> {
  const asOf = new Date(opts.asOf ?? "");
  if (Number.isNaN(asOf.getTime())) {
    throw new LedgerError("A lease reclassification needs a reporting date, written like 2026-12-31.");
  }
  const iso = asOf.toISOString().slice(0, 10);

  const leases = (await prisma.lease.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { code: "asc" },
  })) as unknown as LeaseRow[];

  const splits = leases.map((l) => ({ lease: l, ...splitAt(l, asOf) }));
  const target = splits.reduce((a, s) => a + s.currentMinor, 0n);
  const nonCurrentTarget = splits.reduce((a, s) => a + s.nonCurrentMinor, 0n);
  const composition = splits
    .filter((s) => s.currentMinor !== 0n || s.nonCurrentMinor !== 0n)
    .map((s) => ({
      code: s.lease.code,
      currentMinor: s.currentMinor.toString(),
      nonCurrentMinor: s.nonCurrentMinor.toString(),
    }));

  const externalKey = `lease-reclass:${opts.entityId}:${iso}`;
  const already = await prisma.journalEntry.findFirst({ where: { orgId: opts.orgId, externalKey } });
  if (already) {
    return {
      asOf: iso, posted: false, movedMinor: "0",
      currentMinor: target.toString(), nonCurrentMinor: nonCurrentTarget.toString(),
      wasMinor: target.toString(), leases: composition,
      entryId: already.id, reference: `${already.series}-${already.number}`,
      alreadyPosted: true,
      note: `The split at ${iso} has already been posted; nothing moved.`,
    };
  }

  const ledger = await ledgerSplit(opts.orgId, opts.entityId, asOf);
  const movement = target - ledger.currentMinor;

  if (movement === 0n) {
    return {
      asOf: iso, posted: false, movedMinor: "0",
      currentMinor: target.toString(), nonCurrentMinor: nonCurrentTarget.toString(),
      wasMinor: ledger.currentMinor.toString(), leases: composition,
      entryId: null, reference: null, alreadyPosted: false,
      note: composition.length === 0
        ? "No lease is capitalised, so there is nothing to split."
        : `The current portion at ${iso} is already what the ledger says it is; nothing to post.`,
    };
  }

  // Moving more onto 2460 than the two accounts hold between them would leave
  // 2600 with a debit balance — a negative liability on the face of the sheet.
  // It means the register and the ledger disagree, which `leaseRegister` exists
  // to surface, and posting through it would bury the disagreement inside a
  // presentation entry.
  const held = ledger.currentMinor + ledger.nonCurrentMinor;
  if (movement > 0n && target > held) {
    throw new LedgerError(
      `The schedules say ${target} of lease liability falls due within twelve months of ${iso}, but 2600 and 2460 ` +
        `hold ${held} between them. Splitting that would leave 2600 with a debit balance. The register and the ` +
        `ledger have gone out of step — charge the months that have not been run, or find the journal that moved ` +
        `2600 by hand, and reclassify afterwards.`,
    );
  }

  await ensureCurrentPortionAccount(opts.orgId, opts.entityId);

  const amount = movement > 0n ? movement : -movement;
  const toCurrent = movement > 0n;
  const codes = composition.map((c) => c.code).join(", ");

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: iso,
    memo: `Lease liabilities falling due within twelve months of ${iso} (IAS 1.69)`,
    source: "lease",
    sourceType: "LEASE_RECLASS",
    sourceId: iso,
    externalKey,
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "LC",
    lines: [
      {
        account: toCurrent ? LEASE_LIABILITY_ACCOUNT : LEASE_LIABILITY_CURRENT_ACCOUNT,
        debit: amount,
        memo: toCurrent ? `Out of non-current — ${codes}` : `Back out of current — ${codes}`,
      },
      {
        account: toCurrent ? LEASE_LIABILITY_CURRENT_ACCOUNT : LEASE_LIABILITY_ACCOUNT,
        credit: amount,
        memo: toCurrent ? `Due within twelve months — ${codes}` : `Due after twelve months — ${codes}`,
      },
    ],
  });

  return {
    asOf: iso,
    posted: true,
    movedMinor: amount.toString(),
    currentMinor: target.toString(),
    nonCurrentMinor: nonCurrentTarget.toString(),
    wasMinor: ledger.currentMinor.toString(),
    leases: composition,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPosted: false,
    note:
      `Moved ${amount} between 2600 and 2460 so the balance sheet presents the ${target} of lease liability ` +
      `falling due within twelve months of ${iso} as a current liability, per IAS 1.69.`,
  };
}

export async function leaseRegister(opts: {
  orgId: string;
  entityId: string;
  /**
   * The date to draw the register at. Left out, it is the register as it
   * stands — right for the screen, wrong for a note about a closed year.
   */
  asOf?: Date | string;
}) {
  const asOf = opts.asOf === undefined
    ? null
    : typeof opts.asOf === "string" ? new Date(opts.asOf) : opts.asOf;
  if (asOf && Number.isNaN(asOf.getTime())) throw new LedgerError("A register needs a date it can read.");

  const all = (await prisma.lease.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: [{ status: "asc" }, { code: "asc" }],
  })) as unknown as LeaseRow[];

  // At a past date a lease commenced since is not in the register at all.
  const leases = asOf ? all.filter((l) => l.startsOn <= asOf) : all;

  // The twelve months IAS 1.69 counts have to run from a date. Left to stand,
  // the register is drawn at today, so that is where they run from.
  const splitDate = asOf ?? new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

  const rows = leases.map((l) => {
    const exemption = exemptionOf(l);
    const split = splitAt(l, splitDate);
    if (!asOf) {
      return { lease: l, exemption, rouCarrying: l.initialRouMinor - l.accumRouDepMinor, split };
    }
    const at = positionAt(l, asOf);
    return {
      lease: { ...l, liabilityMinor: at.liabilityMinor } as LeaseRow,
      exemption,
      rouCarrying: at.rouCarryingMinor,
      split,
    };
  });

  // Only what is on the balance sheet is compared: a draft has not been
  // recognised and an exempt lease never will be, so including either would
  // guarantee a difference that means nothing.
  const onBalanceSheet = rows.filter((r) => r.lease.status !== "draft" && !r.exemption.exempt);
  const registerLiability = onBalanceSheet.reduce((a, r) => a + r.lease.liabilityMinor, 0n);
  const registerRou = onBalanceSheet.reduce((a, r) => a + r.rouCarrying, 0n);

  // What the ledger says the same accounts hold. 2460 is read alongside 2600:
  // once the current portion has been reclassified, part of the liability is
  // there, and comparing the register against 2600 alone would report the
  // reclassification itself as a difference.
  const accounts = await prisma.account.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      code: { in: [LEASE_LIABILITY_ACCOUNT, LEASE_LIABILITY_CURRENT_ACCOUNT, ROU_ASSET_ACCOUNT] },
    },
    select: { id: true, code: true },
  });
  const lines = accounts.length
    ? await prisma.journalLine.findMany({
        where: { orgId: opts.orgId, accountId: { in: accounts.map((a) => a.id) },
          // A reversed entry and its reversal net to nothing; reading only
          // "posted" lines counts the reversal alone and moves the balance by
          // the full amount, which shows up here as a false difference.
          entry: { status: { in: ["posted", "reversed"] }, ...(asOf ? { entryDate: { lte: asOf } } : {}) } },
        select: { accountId: true, functionalAmountMinor: true },
      })
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a.code]));
  let ledgerNonCurrent = 0n;
  let ledgerCurrent = 0n;
  let ledgerRou = 0n;
  for (const l of lines) {
    const code = byId.get(l.accountId);
    // 2600 and 2460 are credit balances, so their signs are flipped to compare
    // against a register that states what is owed as a positive number.
    if (code === LEASE_LIABILITY_ACCOUNT) ledgerNonCurrent += -l.functionalAmountMinor;
    if (code === LEASE_LIABILITY_CURRENT_ACCOUNT) ledgerCurrent += -l.functionalAmountMinor;
    if (code === ROU_ASSET_ACCOUNT) ledgerRou += l.functionalAmountMinor;
  }
  const ledgerLiability = ledgerNonCurrent + ledgerCurrent;
  const registerCurrent = onBalanceSheet.reduce((a, r) => a + r.split.currentMinor, 0n);
  const registerNonCurrent = onBalanceSheet.reduce((a, r) => a + r.split.nonCurrentMinor, 0n);

  return {
    /** The date the twelve-month split below is counted from. */
    asOf: splitDate.toISOString().slice(0, 10),
    leases: rows.map(({ lease: l, exemption, rouCarrying, split }) => ({
      code: l.code,
      name: l.name,
      lessor: l.lessor,
      startsOn: l.startsOn.toISOString().slice(0, 10),
      endsOn: l.endsOn.toISOString().slice(0, 10),
      termMonths: termMonths(l.startsOn, l.endsOn),
      frequency: l.frequency,
      paymentMinor: l.paymentMinor.toString(),
      annualRateBps: l.discountRateBps,
      periodRateBps: periodRateBps(l.discountRateBps, 12),
      initialLiabilityMinor: l.initialLiabilityMinor.toString(),
      liabilityMinor: l.liabilityMinor.toString(),
      initialRouMinor: l.initialRouMinor.toString(),
      accumRouDepMinor: l.accumRouDepMinor.toString(),
      rouCarryingMinor: rouCarrying.toString(),
      // DERIVED from this lease's own schedule at the register date, whatever
      // has been posted. What the ledger has actually been told is only known
      // in total, on 2460 — see `reclassifyCurrentPortion`.
      currentMinor: split.currentMinor.toString(),
      nonCurrentMinor: split.nonCurrentMinor.toString(),
      chargedTo: l.chargedTo,
      status: l.status,
      exempt: exemption.exempt,
      exemptionReason: exemption.reason,
      exemptionNote: exemption.exempt ? exemptionWording[exemption.reason] : null,
    })),
    totals: {
      liabilityMinor: registerLiability.toString(),
      rouCarryingMinor: registerRou.toString(),
      initialRouMinor: onBalanceSheet.reduce((a, r) => a + r.lease.initialRouMinor, 0n).toString(),
      accumRouDepMinor: onBalanceSheet.reduce((a, r) => a + r.lease.accumRouDepMinor, 0n).toString(),
      currentMinor: registerCurrent.toString(),
      nonCurrentMinor: registerNonCurrent.toString(),
    },
    ledger: {
      liabilityMinor: ledgerLiability.toString(),
      currentMinor: ledgerCurrent.toString(),
      nonCurrentMinor: ledgerNonCurrent.toString(),
      rouMinor: ledgerRou.toString(),
      // A register that does not tie to the ledger is the finding, so it is
      // reported rather than reconciled away.
      liabilityAgrees: ledgerLiability === registerLiability,
      rouAgrees: ledgerRou === registerRou,
      // The two columns split the same total differently until the split has
      // been posted at this date. That is not a fault in either — it is the
      // reclassification not having been run — and it is the one thing the
      // balance sheet's current/non-current presentation depends on.
      splitPosted: ledgerCurrent === registerCurrent,
    },
    /** Off balance sheet, and why. The only place these leases are visible. */
    exemptions: rows
      .filter((r) => r.exemption.exempt)
      .map((r) => ({
        code: r.lease.code,
        name: r.lease.name,
        reason: r.exemption.reason as Exemption,
        note: exemptionWording[r.exemption.reason as Exemption],
        annualRentMinor: (r.lease.paymentMinor * 12n).toString(),
      })),
  };
}
