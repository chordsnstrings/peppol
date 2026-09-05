import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { post, LedgerError } from "./post";

/**
 * Provisions and contingencies under IAS 37.
 *
 * The whole standard turns on one test, applied at one moment. IAS 37.14
 * recognises a provision only where ALL THREE of these hold:
 *
 *   1. there is a present obligation arising from a past event;
 *   2. an outflow of resources is PROBABLE — more likely than not (IAS 37.23);
 *   3. the amount can be estimated reliably.
 *
 * Where any one of them fails, the item is a contingent liability, and a
 * contingent liability is DISCLOSED AND NEVER RECOGNISED (IAS 37.27). A
 * contingent asset is not recognised either (IAS 37.31) and is disclosed only
 * where the inflow is probable (IAS 37.34); once realisation is virtually
 * certain it has stopped being contingent and is an asset (IAS 37.33).
 *
 * Getting that wrong is how a business either books a liability it does not
 * have or hides one it does, so this module refuses to post a journal for
 * anything that is not a provision, and says so in the result rather than
 * failing silently. `recordProvision` returns the three tests explicitly, as
 * assertions the person recording it is making — the software cannot know
 * whether an outflow is probable, and pretending otherwise would be the worst
 * thing it could do here.
 *
 * What happens afterwards:
 *
 *   • Where the time value of money is material the provision is measured at
 *     the present value of the expenditure expected to settle it (IAS 37.45),
 *     and the unwinding of that discount is a FINANCE COST (IAS 37.60) —
 *     Dr 6360, Cr 2150. It is not an increase in the estimate and must not be
 *     shown as one; the note separates them for exactly that reason.
 *   • Provisions are reviewed at each reporting date and adjusted to the
 *     current best estimate (IAS 37.59). The adjustment is posted in the
 *     period the estimate changed, both ways. A provision reversed to nil is
 *     released, not deleted — the row and its movements stay, because the
 *     history of a provision is the disclosure (IAS 37.84).
 *   • Only expenditure for which a provision was originally recognised may be
 *     charged against it (IAS 37.61). Charging something else against it is
 *     how two years' costs disappear into one year's provision, so `utilise`
 *     refuses more than the carrying amount and says why.
 *   • A contingent liability that becomes probable is recognised from the date
 *     the change in probability occurs (IAS 37.30). That is `promote` — a
 *     first-class operation rather than an edit, because it is the transition
 *     the standard cares most about and it deserves its own journal, its own
 *     date and its own line in the movement table.
 *
 * The register and the ledger are two records on purpose. The estimate, the
 * probability and the timing are judgements; 2150 records only their
 * consequences. `provisionRegister()` puts the two side by side, because a
 * register nobody compares to the ledger is a spreadsheet with extra steps.
 *
 * What is deliberately NOT modelled, and would be wrong to assume:
 *   • Reimbursements (IAS 37.53–58). Where a third party will reimburse part
 *     of the expenditure, the reimbursement is a separate asset recognised
 *     only when virtually certain, and it is not netted here. Nothing in this
 *     module records one; it has to go in by separate journal.
 *   • Restructuring provisions have extra conditions (IAS 37.72–83) — a
 *     detailed formal plan and a valid expectation raised in those affected.
 *     RESTRUCTURING is a category here, not a test; the conditions remain the
 *     preparer's assertion.
 *   • Onerous contracts (IAS 37.66–69) are measured at the lower of the cost
 *     of fulfilling and the penalty for exiting. That comparison is not made
 *     here; the estimate supplied is taken as already being the lower.
 *   • The risk-and-uncertainty adjustment (IAS 37.42) and the requirement for
 *     a PRE-TAX rate that reflects the risks specific to the liability
 *     (IAS 37.47) are judgements taken as given in the estimate and the rate
 *     supplied. The module discounts; it does not choose a rate.
 */

/* ------------------------------------------------------------------ accounts */

/** IAS 1.54(l): provisions are presented separately on the balance sheet. */
export const PROVISION_ACCOUNT = "2150";
/**
 * The unwinding of a discount is a borrowing cost (IAS 37.60), so it belongs
 * with the other finance costs and not in the expense line the provision was
 * charged to. IAS 1.82(b) presents it separately, and the Article 30 interest
 * limitation is computed on net interest expenditure, which cannot be found if
 * it is buried in operating costs.
 */
export const FINANCE_COST_ACCOUNT = "6360";
export const DEFAULT_EXPENSE_ACCOUNT = "6900";
export const CASH_ACCOUNT = "1010";

/** 100% expressed in basis points. Every rate in this module is an integer of these. */
const ONE_HUNDRED_PERCENT_BPS = 10_000n;

export type ProvisionKind = "PROVISION" | "CONTINGENT_LIABILITY" | "CONTINGENT_ASSET";
export type ProvisionCategory =
  | "LEGAL" | "WARRANTY" | "RESTRUCTURING" | "ONEROUS" | "DECOMMISSIONING" | "OTHER";
export type MovementKind = "RECOGNISE" | "REMEASURE" | "UNWIND" | "UTILISE" | "RELEASE";

const KINDS: ProvisionKind[] = ["PROVISION", "CONTINGENT_LIABILITY", "CONTINGENT_ASSET"];
const CATEGORIES: ProvisionCategory[] = [
  "LEGAL", "WARRANTY", "RESTRUCTURING", "ONEROUS", "DECOMMISSIONING", "OTHER",
];

export const CATEGORY_LABEL: Record<ProvisionCategory, string> = {
  LEGAL: "Legal claims",
  WARRANTY: "Warranties",
  RESTRUCTURING: "Restructuring",
  ONEROUS: "Onerous contracts",
  DECOMMISSIONING: "Decommissioning and restoration",
  OTHER: "Other provisions",
};

/* ------------------------------------------------------------ pure functions */

/**
 * The present value of a single amount payable `periods` periods from now,
 * discounted at `ratePerPeriodBps` a period:
 *
 *     PV = amount / (1 + r)^periods
 *
 * Exact rational arithmetic in BigInt, rounded once at the end. There is no
 * `Math.pow` and no float anywhere near it: a discount factor held as a float
 * drifts, and the drift lands in a liability that then never unwinds to the
 * amount actually paid. `num` and `den` grow large; BigInt does not care, and
 * the alternative is rounding once per period instead of once in total.
 *
 * At a zero rate, or over no periods at all, this returns the amount itself —
 * which is the sanity check worth keeping: an undiscounted provision is its
 * own best estimate.
 */
export function presentValue(opts: {
  amountMinor: number | bigint | string;
  ratePerPeriodBps: number;
  periods: number;
}): bigint {
  const amount = BigInt(opts.amountMinor);
  if (amount < 0n) throw new LedgerError("A provision cannot be discounted from a negative amount.");
  if (!Number.isInteger(opts.periods) || opts.periods < 0) {
    throw new LedgerError("A present value needs a whole number of periods, not fewer than zero.");
  }
  if (!Number.isInteger(opts.ratePerPeriodBps) || opts.ratePerPeriodBps < 0 || opts.ratePerPeriodBps > 10_000) {
    throw new LedgerError(
      `A discount rate is a whole number of basis points between 0 and 10000; ${opts.ratePerPeriodBps} is not. ` +
        "12% is 1200.",
    );
  }
  if (opts.ratePerPeriodBps === 0 || opts.periods === 0) return amount;

  const grown = ONE_HUNDRED_PERCENT_BPS + BigInt(opts.ratePerPeriodBps);
  let num = amount;
  let den = 1n;
  for (let k = 0; k < opts.periods; k++) {
    num *= ONE_HUNDRED_PERCENT_BPS;
    den *= grown;
  }
  // Half-up, done on the exact fraction rather than on a rounded intermediate.
  return (2n * num + den) / (2n * den);
}

/**
 * The annual rate as a rate per month, rounded to the nearest basis point.
 *
 * It is an approximation and it is a visible one: 12% a year is exactly 100bp
 * a month, but 5% a year is 41.67bp and becomes 42bp — an effective 5.04%.
 * The rate actually used is reported by the register so the discounting can be
 * re-performed. A rate carried to more places than a basis point is a float,
 * and a float has no business in a discount factor.
 *
 * What matters far more than the rounding is that the SAME rate discounts the
 * estimate and unwinds the discount. It does, because both go through here.
 */
export function monthlyRateBps(annualBps: number): number {
  if (!Number.isInteger(annualBps) || annualBps < 0 || annualBps > 10_000) {
    throw new LedgerError(`A discount rate is 0 to 10000 basis points a year; ${annualBps} is not. 12% is 1200.`);
  }
  // Integer half-up: (2a + 12) / 24.
  return Number((2n * BigInt(annualBps) + 12n) / 24n);
}

const monthIndexOf = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
const monthLabelOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const monthIndexOfLabel = (label: string) => {
  const [y, m] = label.split("-").map(Number);
  return y * 12 + (m - 1);
};
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Whole calendar months from one date to another, floored at zero.
 *
 * Counted between the MONTHS the two dates fall in, not between the days. A
 * day-count convention would imply a precision that a best estimate of an
 * uncertain outflow does not have, and it would stop the monthly unwinding
 * from landing exactly on the discounted figure — which is the property that
 * lets a remeasurement to an unchanged estimate post nothing.
 */
export function monthsUntil(from: Date, to: Date): number {
  return Math.max(0, monthIndexOf(to) - monthIndexOf(from));
}

export interface Discounted {
  /** What the balance sheet would carry: the discounted estimate. */
  valueMinor: bigint;
  /** The estimate less the discounted value — the discount still to unwind. */
  discountMinor: bigint;
  months: number;
  monthlyRateBps: number;
}

/**
 * The estimate measured at present value where a rate is given (IAS 37.45),
 * and left alone where it is not.
 *
 * IAS 37.45 discounts only "where the effect of the time value of money is
 * material". Materiality is a judgement, so the module does not make it: a
 * rate of nil means the preparer has judged the effect immaterial, which is
 * the normal case for a warranty settled within the year.
 */
export function discountedEstimate(opts: {
  estimateMinor: bigint;
  annualRateBps: number;
  from: Date;
  expectedOn: Date | null;
}): Discounted {
  const rate = opts.annualRateBps;
  if (rate === 0) {
    return { valueMinor: opts.estimateMinor, discountMinor: 0n, months: 0, monthlyRateBps: 0 };
  }
  if (!opts.expectedOn) {
    // The database enforces this too; the message is here so the answer is
    // "say when you expect to settle" rather than a constraint name.
    throw new LedgerError(
      "Discounting needs a date to discount to. Give the date the outflow is expected, or drop the rate to nil " +
        "if the time value of money is not material (IAS 37.45).",
    );
  }
  const monthly = monthlyRateBps(rate);
  const months = monthsUntil(opts.from, opts.expectedOn);
  const value = presentValue({ amountMinor: opts.estimateMinor, ratePerPeriodBps: monthly, periods: months });
  return { valueMinor: value, discountMinor: opts.estimateMinor - value, months, monthlyRateBps: monthly };
}

/* ----------------------------------------------------- the recognition test */

export interface RecognitionTest {
  kind: ProvisionKind;
  /** Whether anything goes on the balance sheet at all. */
  recognised: boolean;
  /** The IAS 37.14 conditions, as assertions rather than as calculations. */
  tests: { test: string; pass: boolean | null; why: string }[];
  basis: string;
}

/**
 * The three tests, stated every time something is recorded.
 *
 * `pass` is a tri-state on purpose. `null` means the software does not know
 * and is not pretending to: probability and the existence of a present
 * obligation are judgements made by the person recording the item, and the
 * only one of the three that a program can actually check is whether an
 * amount was supplied. Recording something as a PROVISION IS the assertion
 * that the other two hold; recording it as a contingency is the assertion
 * that at least one of them does not.
 */
export function recognitionTest(kind: ProvisionKind, estimateMinor: bigint): RecognitionTest {
  const reliable = estimateMinor > 0n;
  if (kind === "PROVISION") {
    return {
      kind,
      recognised: true,
      tests: [
        {
          test: "A present obligation from a past event",
          pass: true,
          why: "Asserted by recording this as a provision (IAS 37.14(a)).",
        },
        {
          test: "An outflow of resources is probable",
          pass: true,
          why: "Asserted: more likely than not to occur (IAS 37.14(b), 37.23).",
        },
        {
          test: "The amount can be estimated reliably",
          pass: reliable,
          why: reliable
            ? "A best estimate of the expenditure required to settle has been given (IAS 37.14(c), 37.36)."
            : "No amount has been given, so the estimate is not reliable (IAS 37.14(c)).",
        },
      ],
      basis:
        "Recognised as a provision: a present obligation from a past event, a probable outflow, and a reliable " +
        "estimate (IAS 37.14). Dr the expense, Cr provisions.",
    };
  }
  if (kind === "CONTINGENT_LIABILITY") {
    return {
      kind,
      recognised: false,
      tests: [
        {
          test: "A present obligation from a past event",
          pass: null,
          why: "Possible but not confirmed, or present but not reliably measurable (IAS 37.10, 37.13).",
        },
        {
          test: "An outflow of resources is probable",
          pass: false,
          why: "Not probable, so one of the IAS 37.14 conditions fails.",
        },
        {
          test: "The amount can be estimated reliably",
          pass: reliable,
          why: reliable
            ? "An amount is disclosed as an estimate of the financial effect (IAS 37.86(a))."
            : "No estimate can be made; that fact is itself disclosed (IAS 37.86, 37.91).",
        },
      ],
      basis:
        "A contingent liability: disclosed, never recognised (IAS 37.27). Nothing is posted. It is disclosed " +
        "unless the possibility of an outflow is remote (IAS 37.86) — recording it here asserts it is not remote.",
    };
  }
  return {
    kind,
    recognised: false,
    tests: [
      {
        test: "A present obligation from a past event",
        pass: null,
        why: "A contingent asset is a possible asset, not an obligation (IAS 37.10).",
      },
      {
        test: "An inflow of economic benefits is probable",
        pass: true,
        why: "Asserted — that is the only condition on which a contingent asset is disclosed (IAS 37.34).",
      },
      {
        test: "The amount can be estimated reliably",
        pass: reliable,
        why: reliable
          ? "An estimate of the financial effect is disclosed (IAS 37.89)."
          : "No estimate can be made; that fact is itself disclosed (IAS 37.91).",
      },
    ],
    basis:
      "A contingent asset: never recognised, because that could recognise income that may never be realised " +
      "(IAS 37.31, 37.33). Disclosed only while the inflow is probable (IAS 37.34); once realisation is " +
      "virtually certain it is no longer contingent and is recognised as an asset.",
  };
}

/* ------------------------------------------------------------------ helpers */

type ProvisionRow = Prisma.ProvisionGetPayload<Record<string, never>>;

function parseDate(value: string | Date, what: string): Date {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} needs a date written like 2026-01-31.`);
  return d;
}

/**
 * Minor units as a plain figure for a message — not a financial statement.
 *
 * Bound to the book's currency at the point of use. It used to split the digits
 * two from the right whatever the book was kept in, which is right for a dirham
 * and wrong by a factor of ten for a Kuwaiti or Bahraini dinar or an Omani
 * rial; `fmtMinor` knows each currency's exponent.
 */
const plainIn = (currency: string) => (minor: bigint) =>
  fmtMinor(minor, currency, { sign: "minus", zero: "zero" });

/** The currency this entity keeps its books in. */
async function bookCurrency(orgId: string, entityId: string): Promise<string> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  return book?.functionalCurrency ?? "AED";
}

/**
 * Every read starts here. A provision is addressed by its code within an org
 * AND an entity — never by an id alone, so a guessed id reads nothing and an
 * id belonging to a sister entity reads nothing either.
 */
async function loadProvision(orgId: string, entityId: string, code: string): Promise<ProvisionRow> {
  const row = await prisma.provision.findFirst({ where: { orgId, entityId, code } });
  if (!row) throw new LedgerError(`Provision ${code} is not on the register for this entity.`);
  return row;
}

/**
 * The next movement number for a provision.
 *
 * It is also the idempotency key of everything except the unwinding: a retry
 * that failed after posting recomputes the SAME seq, because no movement was
 * written, so `post()` returns the original entry instead of a second one. A
 * genuinely new movement gets a new seq and therefore a new key — which a key
 * made of the date and the amount could not promise, and a second identical
 * charge posted twice is the failure that matters here.
 */
async function nextSeq(orgId: string, provisionId: string): Promise<number> {
  const last = await prisma.provisionMovement.findFirst({
    where: { orgId, provisionId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  return (last?.seq ?? 0) + 1;
}

/**
 * Move the register, once the journal has committed.
 *
 * The two writes go together: a carrying amount without its movement would
 * make the IAS 37.84 reconciliation wrong, and a movement without the carrying
 * amount would make the balance wrong. The provision is addressed by id here
 * only because `loadProvision` already resolved it inside the caller's org and
 * entity.
 */
async function commitMovement(
  provision: { id: string; orgId: string },
  update: Prisma.ProvisionUncheckedUpdateInput,
  movement: {
    seq: number;
    kind: MovementKind;
    movedOn: Date;
    amountMinor: bigint;
    note?: string | null;
    entryId?: string | null;
  },
) {
  await prisma.$transaction([
    prisma.provision.update({ where: { id: provision.id }, data: update }),
    prisma.provisionMovement.create({
      data: {
        orgId: provision.orgId,
        provisionId: provision.id,
        seq: movement.seq,
        kind: movement.kind,
        movedOn: movement.movedOn,
        amountMinor: movement.amountMinor,
        note: movement.note ?? null,
        entryId: movement.entryId ?? null,
      },
    }),
  ]);
}

/** The entry key of a provision within an entity is its code, which is unique there. */
const keyFor = (entityId: string, code: string, what: string, suffix: string | number) =>
  `provision-${what}:${entityId}:${code}:${suffix}`;

function assertOpen(p: ProvisionRow, verb: string) {
  if (p.status !== "open") {
    throw new LedgerError(
      `Provision ${p.code} is ${p.status}, so it cannot be ${verb}. A settled or released provision is history — ` +
        "record a new one if the obligation has come back.",
    );
  }
}

function assertRecognised(p: ProvisionRow, verb: string) {
  if (p.kind !== "PROVISION") {
    throw new LedgerError(
      `${p.code} is a ${p.kind === "CONTINGENT_ASSET" ? "contingent asset" : "contingent liability"}, which is ` +
        `disclosed and never recognised (IAS 37.${p.kind === "CONTINGENT_ASSET" ? "31" : "27"}). There is nothing ` +
        `on the balance sheet to ${verb}.` +
        (p.kind === "CONTINGENT_LIABILITY"
          ? " Recognise it first if the outflow has become probable — that is a promotion, and it has its own date."
          : ""),
    );
  }
}

/* ------------------------------------------------------------------ recording */

export interface RecordProvisionResult {
  code: string;
  name: string;
  kind: ProvisionKind;
  category: ProvisionCategory;
  /** False for a contingency — which is the point of the whole module. */
  recognised: boolean;
  recognitionTest: RecognitionTest;
  estimateMinor: string;
  carryingMinor: string;
  discountMinor: string;
  months: number;
  monthlyRateBps: number;
  entryId: string | null;
  reference: string | null;
  message: string;
}

/**
 * Record a provision or a contingency.
 *
 * A provision posts, at the discounted estimate where a rate is given:
 *
 *   Dr  6900 (or whichever expense it belongs to)
 *     Cr  2150 Provisions
 *
 * A contingency posts NOTHING, and the result says so. That refusal is the
 * module's only real job: IAS 37.27 and 37.31 do not permit the entry, and a
 * program that quietly made one anyway would be putting a liability on the
 * balance sheet that the standard says is not there.
 */
export async function recordProvision(opts: {
  orgId: string;
  entityId: string;
  code: string;
  name: string;
  category?: ProvisionCategory;
  kind?: ProvisionKind;
  recognisedOn: string | Date;
  estimateMinor: number | bigint | string;
  discountRateBps?: number;
  expectedOn?: string | Date | null;
  accountCode?: string;
  expenseAccount?: string;
  note?: string;
  actorId?: string;
}): Promise<RecordProvisionResult> {
  const plain = plainIn(await bookCurrency(opts.orgId, opts.entityId));
  const code = opts.code.trim();
  const name = opts.name.trim();
  if (!code) throw new LedgerError("A provision needs a code.");
  if (!name) throw new LedgerError("A provision needs a name — the note asks for the nature of the obligation (IAS 37.85(a)).");

  const kind = opts.kind ?? "PROVISION";
  const category = opts.category ?? "OTHER";
  if (!KINDS.includes(kind)) throw new LedgerError(`${kind} is not one of ${KINDS.join(", ")}.`);
  if (!CATEGORIES.includes(category)) throw new LedgerError(`${category} is not one of ${CATEGORIES.join(", ")}.`);

  const estimate = BigInt(opts.estimateMinor);
  if (estimate < 0n) {
    throw new LedgerError("An estimate of the outflow cannot be negative. A provision is what is owed, not what is owned.");
  }
  const rate = opts.discountRateBps ?? 0;
  if (!Number.isInteger(rate) || rate < 0 || rate > 10_000) {
    throw new LedgerError(`A discount rate is a whole number of basis points between 0 and 10000; ${rate} is not. 12% is 1200.`);
  }

  const recognisedOn = parseDate(opts.recognisedOn, "The date the provision is recognised");
  const expectedOn = opts.expectedOn ? parseDate(opts.expectedOn, "The date the outflow is expected") : null;
  // The database refuses a rate with nothing to discount to; catching it here
  // means a contingency recorded with a rate for a later promotion gets the
  // same actionable message a provision would.
  if (rate > 0 && !expectedOn) {
    throw new LedgerError(
      "Discounting needs a date to discount to. Give the date the outflow is expected, or drop the rate to nil " +
        "if the time value of money is not material (IAS 37.45).",
    );
  }
  if (expectedOn && expectedOn < recognisedOn) {
    throw new LedgerError(
      `An outflow expected on ${iso(expectedOn)} cannot be settled before the obligation arose on ${iso(recognisedOn)}.`,
    );
  }
  // IAS 37.14(c) and 37.26: where no reliable estimate can be made, the item
  // is a contingent liability. So a provision of nothing is not a provision —
  // and it could not be posted anyway, because a journal line of nil carries
  // no information.
  if (kind === "PROVISION" && estimate === 0n) {
    throw new LedgerError(
      `Provision ${code} has no amount. Where the amount cannot be estimated reliably the item is a contingent ` +
        "liability, disclosed and not recognised (IAS 37.26) — record it as CONTINGENT_LIABILITY instead.",
    );
  }

  const clash = await prisma.provision.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code },
    select: { id: true },
  });
  if (clash) throw new LedgerError(`Provision ${code} is already on the register.`);

  const accountCode = opts.accountCode ?? PROVISION_ACCOUNT;
  const expenseAccount = opts.expenseAccount ?? DEFAULT_EXPENSE_ACCOUNT;
  const test = recognitionTest(kind, estimate);

  // A contingency is measured for the disclosure but never discounted onto a
  // balance sheet it is not on, so the discount is computed only where the
  // item is being recognised.
  const measured: Discounted =
    kind === "PROVISION"
      ? discountedEstimate({ estimateMinor: estimate, annualRateBps: rate, from: recognisedOn, expectedOn })
      : { valueMinor: 0n, discountMinor: 0n, months: 0, monthlyRateBps: rate === 0 ? 0 : monthlyRateBps(rate) };

  let entryId: string | null = null;
  let reference: string | null = null;

  if (kind === "PROVISION") {
    // Posted BEFORE the register row exists: nothing should be on the register
    // that is not in the ledger, and a closed period has to stop the whole
    // thing rather than leave a provision recorded with no journal behind it.
    const entry = await post({
      orgId: opts.orgId,
      entityId: opts.entityId,
      entryDate: recognisedOn,
      memo: `Provision ${code} ${name} recognised (IAS 37.14)`,
      source: "provision",
      sourceType: "PROVISION_RECOGNISE",
      sourceId: code,
      externalKey: keyFor(opts.entityId, code, "recognise", 1),
      actorType: "HUMAN",
      actorId: opts.actorId,
      series: "PV",
      lines: [
        { account: expenseAccount, debit: measured.valueMinor, memo: `${code} provision charged` },
        { account: accountCode, credit: measured.valueMinor, memo: `${code} provision recognised` },
      ],
    });
    entryId = entry.id;
    reference = `${entry.series}-${entry.number}`;
  }

  const created = await prisma.provision.create({
    data: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      code,
      name,
      category,
      kind,
      recognisedOn,
      estimateMinor: estimate,
      discountRateBps: rate,
      expectedOn,
      carryingMinor: measured.valueMinor,
      accountCode,
      expenseAccount,
      note: opts.note?.trim() || null,
    },
  });

  if (kind === "PROVISION") {
    await prisma.provisionMovement.create({
      data: {
        orgId: opts.orgId,
        provisionId: created.id,
        seq: 1,
        kind: "RECOGNISE",
        movedOn: recognisedOn,
        amountMinor: measured.valueMinor,
        note: measured.discountMinor > 0n
          ? `Discounted over ${measured.months} months at ${measured.monthlyRateBps}bp a month (IAS 37.45)`
          : null,
        entryId,
      },
    });
  }

  const message =
    kind === "PROVISION"
      ? `Provision ${code} recognised at ${plain(measured.valueMinor)} — Dr ${expenseAccount}, Cr ${accountCode} ` +
        `(${reference}).` +
        (measured.discountMinor > 0n
          ? ` The estimate of ${plain(estimate)} is discounted over ${measured.months} months, and the ` +
            `${plain(measured.discountMinor)} of discount unwinds as a finance cost (IAS 37.60).`
          : "")
      : kind === "CONTINGENT_LIABILITY"
        ? `${code} is recorded as a contingent liability: disclosed, not recognised, and nothing has been posted ` +
          `(IAS 37.27). It appears in the note at ${plain(estimate)}, not on the balance sheet. Promote it if the ` +
          "outflow becomes probable."
        : `${code} is recorded as a contingent asset: never recognised, and nothing has been posted (IAS 37.31). ` +
          "It is disclosed only while the inflow is probable (IAS 37.34).";

  return {
    code,
    name,
    kind,
    category,
    recognised: kind === "PROVISION",
    recognitionTest: test,
    estimateMinor: estimate.toString(),
    carryingMinor: measured.valueMinor.toString(),
    discountMinor: measured.discountMinor.toString(),
    months: measured.months,
    monthlyRateBps: measured.monthlyRateBps,
    entryId,
    reference,
    message,
  };
}

/* --------------------------------------------------------------- remeasuring */

export interface RemeasureResult {
  code: string;
  on: string;
  estimateMinor: string;
  carryingMinor: string;
  /** Signed: what this did to the carrying amount. */
  movedMinor: string;
  released: boolean;
  status: string;
  entryId: string | null;
  reference: string | null;
  message: string;
}

/**
 * IAS 37.59: provisions are reviewed at each reporting date and adjusted to
 * reflect the current best estimate. The adjustment is posted in the period
 * the estimate changed — a change in an accounting estimate is recognised
 * prospectively (IAS 8.36), so the original entry is never restated.
 *
 *   estimate up    Dr expense, Cr 2150
 *   estimate down  Dr 2150, Cr the same expense it was charged to
 *
 * The credit goes back to the account the provision was charged to, not to a
 * general income line: an over-provision is a cost that did not happen, and
 * showing it as income overstates both the original expense and the later
 * profit.
 *
 * Where a rate applies, the new estimate is discounted from THIS date, so the
 * remaining term is shorter and the present value higher. That is the same
 * arithmetic the monthly unwinding performs, which is why remeasuring to an
 * unchanged estimate on a provision whose unwinding is up to date posts
 * nothing at all: (E/gⁿ)·g^k = E/g^(n−k). Any few fils that do appear are the
 * rounding in the monthly unwinding, and they belong in the estimate line
 * rather than in a finance cost.
 *
 * A remeasurement to nil is a RELEASE, not a deletion. The row and its
 * movements stay, because the movement in each class is the disclosure
 * (IAS 37.84) and a deleted provision cannot be disclosed.
 */
export async function remeasure(opts: {
  orgId: string;
  entityId: string;
  code: string;
  on: string | Date;
  estimateMinor: number | bigint | string;
  note?: string;
  actorId?: string;
}): Promise<RemeasureResult> {
  const plain = plainIn(await bookCurrency(opts.orgId, opts.entityId));
  const p = await loadProvision(opts.orgId, opts.entityId, opts.code);
  assertOpen(p, "remeasured");

  const on = parseDate(opts.on, "The date of the remeasurement");
  const estimate = BigInt(opts.estimateMinor);
  if (estimate < 0n) throw new LedgerError("A best estimate of an outflow cannot be negative.");
  if (on < p.recognisedOn) {
    throw new LedgerError(
      `${iso(on)} is before ${p.code} was recognised on ${iso(p.recognisedOn)}. A change in estimate is recognised ` +
        "in the period it happens, not by restating an earlier one (IAS 8.36).",
    );
  }

  // A contingency has no carrying amount to adjust, so a remeasurement is a
  // change to what is DISCLOSED and nothing else. IAS 37.30 requires
  // contingent liabilities to be assessed continually, so this is a real
  // operation — it just has no journal and no movement, because the movement
  // table records what happened to the carrying amount and nothing happened.
  if (p.kind !== "PROVISION") {
    await prisma.provision.update({ where: { id: p.id }, data: { estimateMinor: estimate } });
    return {
      code: p.code,
      on: iso(on),
      estimateMinor: estimate.toString(),
      carryingMinor: "0",
      movedMinor: "0",
      released: false,
      status: p.status,
      entryId: null,
      reference: null,
      message:
        `${p.code} is a contingency, so the estimate disclosed is now ${plain(estimate)} and nothing has been ` +
        "posted. Contingent liabilities are assessed continually (IAS 37.30); if the outflow has become probable, " +
        "promote it instead.",
    };
  }

  const measured = discountedEstimate({
    estimateMinor: estimate,
    annualRateBps: p.discountRateBps,
    from: on,
    expectedOn: p.expectedOn,
  });
  const delta = measured.valueMinor - p.carryingMinor;

  if (delta === 0n) {
    // No movement is recorded, because there was none: a row of nil movements
    // makes the IAS 37.84 reconciliation unreadable, which is why the database
    // refuses one.
    return {
      code: p.code,
      on: iso(on),
      estimateMinor: estimate.toString(),
      carryingMinor: p.carryingMinor.toString(),
      movedMinor: "0",
      released: false,
      status: p.status,
      entryId: null,
      reference: null,
      message:
        `${p.code} is already carried at ${plain(p.carryingMinor)}, so the best estimate has not changed and ` +
        "nothing has been posted (IAS 37.59)." +
        (p.discountRateBps > 0
          ? " The unwinding has already carried it to the present value of the estimate at this date."
          : ""),
    };
  }

  const seq = await nextSeq(opts.orgId, p.id);
  const up = delta > 0n;
  const size = up ? delta : -delta;
  const releasedInFull = measured.valueMinor === 0n;

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: on,
    memo: releasedInFull
      ? `Provision ${p.code} released — remeasured to nil (IAS 37.59)`
      : `Provision ${p.code} remeasured to ${plain(estimate)} (IAS 37.59)`,
    source: "provision",
    sourceType: releasedInFull ? "PROVISION_RELEASE" : "PROVISION_REMEASURE",
    sourceId: p.code,
    externalKey: keyFor(opts.entityId, p.code, "remeasure", seq),
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "PM",
    lines: up
      ? [
          { account: p.expenseAccount, debit: size, memo: `${p.code} increase in estimate` },
          { account: p.accountCode, credit: size, memo: `${p.code} provision increased` },
        ]
      : [
          { account: p.accountCode, debit: size, memo: `${p.code} provision reduced` },
          { account: p.expenseAccount, credit: size, memo: `${p.code} unused amount reversed` },
        ],
  });

  await commitMovement(
    p,
    {
      estimateMinor: estimate,
      carryingMinor: measured.valueMinor,
      ...(releasedInFull ? { status: "released" } : {}),
    },
    {
      seq,
      // Reversing a provision in full is a release however it was asked for.
      // Calling it a remeasurement would hide it in IAS 37.84(b) additions
      // instead of showing it as an unused amount reversed under 37.84(d).
      kind: releasedInFull ? "RELEASE" : "REMEASURE",
      movedOn: on,
      amountMinor: delta,
      note: opts.note?.trim() || null,
      entryId: entry.id,
    },
  );

  return {
    code: p.code,
    on: iso(on),
    estimateMinor: estimate.toString(),
    carryingMinor: measured.valueMinor.toString(),
    movedMinor: delta.toString(),
    released: releasedInFull,
    status: releasedInFull ? "released" : p.status,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    message: releasedInFull
      ? `${p.code} has been remeasured to nil, which is a release of ${plain(size)} and not a deletion — ` +
        `Dr ${p.accountCode}, Cr ${p.expenseAccount} (${entry.series}-${entry.number}). The provision and its ` +
        "movements stay on the register, because the movement is the disclosure (IAS 37.84)."
      : up
        ? `${p.code} increased by ${plain(size)} to ${plain(measured.valueMinor)} — Dr ${p.expenseAccount}, ` +
          `Cr ${p.accountCode} (${entry.series}-${entry.number}).`
        : `${p.code} reduced by ${plain(size)} to ${plain(measured.valueMinor)} — Dr ${p.accountCode}, ` +
          `Cr ${p.expenseAccount} (${entry.series}-${entry.number}). An unused amount reversed, in the period the ` +
          "estimate changed (IAS 37.59).",
  };
}

/* ---------------------------------------------------------------- unwinding */

export interface UnwindResult {
  code: string;
  period: string;
  unwoundMinor: string;
  carryingMinor: string;
  entryId: string | null;
  reference: string | null;
  /** True when this call did nothing because the period was already unwound. */
  alreadyUnwound: boolean;
  message: string;
}

/**
 * One period of the discount unwinding (IAS 37.60):
 *
 *   Dr  6360 Finance cost
 *     Cr  2150 Provisions
 *
 * It is a borrowing cost, not an increase in the estimate, and the two must
 * not be mixed: the note shows them on separate lines because a reader needs
 * to see how much of the movement was the passage of time and how much was a
 * change of mind.
 *
 * The unwinding stops when the provision reaches its undiscounted best
 * estimate. It has to: the provision is being carried up to what will actually
 * be paid at the expected date, and past that point every further period would
 * be charging finance cost on an obligation that has already grown to its
 * full size.
 *
 * Idempotent per period. The carrying amount is not, which is why an already
 * unwound period returns the original entry rather than posting into it again.
 */
export async function unwindDiscount(opts: {
  orgId: string;
  entityId: string;
  code: string;
  /** YYYY-MM. */
  period: string;
  postingDate?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<UnwindResult> {
  const plain = plainIn(await bookCurrency(opts.orgId, opts.entityId));
  if (!/^\d{4}-\d{2}$/.test(opts.period)) throw new LedgerError("A provision period looks like 2026-03.");

  const p = await loadProvision(opts.orgId, opts.entityId, opts.code);
  assertRecognised(p, "unwind");
  assertOpen(p, "unwound");

  if (p.discountRateBps === 0) {
    throw new LedgerError(
      `Provision ${p.code} is not discounted, so there is no discount to unwind. Discounting applies only where ` +
        "the effect of the time value of money is material (IAS 37.45).",
    );
  }

  const target = monthIndexOfLabel(opts.period);
  const recognised = monthIndexOf(p.recognisedOn);
  if (target <= recognised) {
    // The month of recognition is the month the estimate was discounted TO, so
    // there is no time to charge for in it. Unwinding it would double-count
    // the first period.
    throw new LedgerError(
      `${p.code} was recognised in ${monthLabelOf(p.recognisedOn)}, so there is nothing to unwind in ${opts.period}. ` +
        "The discount unwinds over the months after recognition.",
    );
  }

  const externalKey = keyFor(opts.entityId, p.code, "unwind", opts.period);
  const already = await prisma.journalEntry.findFirst({ where: { orgId: opts.orgId, externalKey } });
  if (already) {
    return {
      code: p.code,
      period: opts.period,
      unwoundMinor: "0",
      carryingMinor: p.carryingMinor.toString(),
      entryId: already.id,
      reference: `${already.series}-${already.number}`,
      alreadyUnwound: true,
      message: `${p.code} was already unwound for ${opts.period} (${already.series}-${already.number}); nothing posted.`,
    };
  }

  const headroom = p.estimateMinor - p.carryingMinor;
  const monthly = monthlyRateBps(p.discountRateBps);
  let interest =
    (p.carryingMinor * BigInt(monthly) + ONE_HUNDRED_PERCENT_BPS / 2n) / ONE_HUNDRED_PERCENT_BPS;
  if (interest > headroom) interest = headroom;

  if (interest <= 0n) {
    return {
      code: p.code,
      period: opts.period,
      unwoundMinor: "0",
      carryingMinor: p.carryingMinor.toString(),
      entryId: null,
      reference: null,
      alreadyUnwound: false,
      message:
        `${p.code} already stands at its undiscounted best estimate of ${plain(p.estimateMinor)}, so the discount ` +
        "is fully unwound and nothing has been posted (IAS 37.60).",
    };
  }

  const [y, m] = opts.period.split("-").map(Number);
  // The last day of the period unless told otherwise: the unwinding is a
  // period-end measurement, not an event on a day.
  const entryDate = opts.postingDate ?? new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const seq = await nextSeq(opts.orgId, p.id);

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate,
    memo: `Provision ${p.code} — unwinding of discount for ${opts.period} (IAS 37.60)`,
    source: "provision",
    sourceType: "PROVISION_UNWIND",
    sourceId: p.code,
    externalKey,
    actorType: opts.actorType ?? "RULE",
    actorId: opts.actorId,
    series: "PU",
    lines: [
      { account: FINANCE_COST_ACCOUNT, debit: interest, memo: `${p.code} unwinding of discount` },
      { account: p.accountCode, credit: interest, memo: `${p.code} discount unwound into the provision` },
    ],
  });

  const carrying = p.carryingMinor + interest;
  await commitMovement(p, { carryingMinor: carrying }, {
    seq,
    kind: "UNWIND",
    movedOn: new Date(entryDate),
    amountMinor: interest,
    note: `${monthly}bp for ${opts.period}`,
    entryId: entry.id,
  });

  return {
    code: p.code,
    period: opts.period,
    unwoundMinor: interest.toString(),
    carryingMinor: carrying.toString(),
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyUnwound: false,
    message:
      `${plain(interest)} of discount unwound on ${p.code} for ${opts.period} — Dr ${FINANCE_COST_ACCOUNT}, ` +
      `Cr ${p.accountCode} (${entry.series}-${entry.number}). It is a finance cost, not a bigger estimate.`,
  };
}

/* ---------------------------------------------------------------- utilising */

export interface UtiliseResult {
  code: string;
  on: string;
  amountMinor: string;
  carryingMinor: string;
  status: string;
  entryId: string;
  reference: string;
  message: string;
}

/**
 * The obligation is settled:
 *
 *   Dr  2150 Provisions
 *     Cr  1010 Bank
 *
 * IAS 37.61 is the rule this enforces: only expenditure for which the
 * provision was ORIGINALLY recognised may be set against it. Charging
 * anything else against a provision hides that later cost inside an earlier
 * year's charge — which is why the excess is refused here rather than netted
 * off, and why the message says where the excess belongs instead.
 */
export async function utilise(opts: {
  orgId: string;
  entityId: string;
  code: string;
  on: string | Date;
  amountMinor: number | bigint | string;
  cashAccount?: string;
  /** Distinguishes two genuine settlements of the same amount on the same day. */
  reference?: string;
  note?: string;
  actorId?: string;
}): Promise<UtiliseResult> {
  const plain = plainIn(await bookCurrency(opts.orgId, opts.entityId));
  const p = await loadProvision(opts.orgId, opts.entityId, opts.code);
  assertRecognised(p, "charge expenditure against");
  assertOpen(p, "charged against");

  const on = parseDate(opts.on, "The date the provision was used");
  const amount = BigInt(opts.amountMinor);
  if (amount <= 0n) throw new LedgerError("An amount charged against a provision has to be more than nothing.");

  if (amount > p.carryingMinor) {
    throw new LedgerError(
      `Only ${plain(p.carryingMinor)} is carried on provision ${p.code}, so ${plain(amount)} cannot be charged ` +
        `against it. Only expenditure for which the provision was originally recognised may be set against it ` +
        `(IAS 37.61) — the extra ${plain(amount - p.carryingMinor)} was never provided for, so it is a cost of ` +
        "this period and belongs in the expense account. If the obligation itself turned out larger, remeasure " +
        "the provision to the current best estimate first (IAS 37.59) and then charge it.",
    );
  }

  const seq = await nextSeq(opts.orgId, p.id);
  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: on,
    memo: `Provision ${p.code} used — expenditure it was recognised for (IAS 37.61)`,
    source: "provision",
    sourceType: "PROVISION_UTILISE",
    sourceId: p.code,
    externalKey: keyFor(opts.entityId, p.code, `utilise${opts.reference ? `:${opts.reference}` : ""}`, seq),
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "PS",
    lines: [
      { account: p.accountCode, debit: amount, memo: `${p.code} provision used` },
      { account: opts.cashAccount ?? CASH_ACCOUNT, credit: amount, memo: `${p.code} settled` },
    ],
  });

  const carrying = p.carryingMinor - amount;
  // Settled only when nothing is left. A provision with a balance is still an
  // obligation, however much of it has been paid.
  const status = carrying === 0n ? "settled" : p.status;
  await commitMovement(p, { carryingMinor: carrying, status }, {
    seq,
    kind: "UTILISE",
    movedOn: on,
    amountMinor: -amount,
    note: opts.note?.trim() || null,
    entryId: entry.id,
  });

  return {
    code: p.code,
    on: iso(on),
    amountMinor: amount.toString(),
    carryingMinor: carrying.toString(),
    status,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    message:
      `${plain(amount)} charged against ${p.code} — Dr ${p.accountCode}, Cr ${opts.cashAccount ?? CASH_ACCOUNT} ` +
      `(${entry.series}-${entry.number}). ` +
      (carrying === 0n
        ? "The provision is fully used and is now settled."
        : `${plain(carrying)} of the provision remains.`),
  };
}

/* ----------------------------------------------------------------- releasing */

export interface ReleaseResult {
  code: string;
  on: string;
  releasedMinor: string;
  status: string;
  entryId: string;
  reference: string;
  message: string;
}

/**
 * The outflow is no longer probable, so the provision is reversed (IAS 37.59):
 *
 *   Dr  2150 Provisions
 *     Cr  the expense it was charged to
 *
 * In the period the estimate changed — never by restating the original charge.
 * A provision that was right when it was made and wrong later is a change in
 * estimate, not an error (IAS 8.32–36), and restating it would rewrite a year
 * that has already been reported.
 *
 * The reason is required and kept on the movement. A release with no reason is
 * indistinguishable from a mistake, and it is the one movement most likely to
 * be asked about.
 */
export async function release(opts: {
  orgId: string;
  entityId: string;
  code: string;
  on: string | Date;
  reason: string;
  actorId?: string;
}): Promise<ReleaseResult> {
  const plain = plainIn(await bookCurrency(opts.orgId, opts.entityId));
  const p = await loadProvision(opts.orgId, opts.entityId, opts.code);
  assertRecognised(p, "release");
  assertOpen(p, "released");

  const on = parseDate(opts.on, "The date of the release");
  const reason = opts.reason?.trim();
  if (!reason) {
    throw new LedgerError(
      "Say why the provision is being released. A provision is reversed only where the outflow is no longer " +
        "probable (IAS 37.59), and the reason is what a reader will ask for.",
    );
  }
  if (p.carryingMinor <= 0n) {
    throw new LedgerError(`Provision ${p.code} carries nothing, so there is nothing to release.`);
  }

  const amount = p.carryingMinor;
  const seq = await nextSeq(opts.orgId, p.id);
  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: on,
    memo: `Provision ${p.code} released — ${reason} (IAS 37.59)`,
    source: "provision",
    sourceType: "PROVISION_RELEASE",
    sourceId: p.code,
    externalKey: keyFor(opts.entityId, p.code, "release", seq),
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "PM",
    lines: [
      { account: p.accountCode, debit: amount, memo: `${p.code} provision released` },
      { account: p.expenseAccount, credit: amount, memo: `${p.code} unused amount reversed` },
    ],
  });

  await commitMovement(p, { carryingMinor: 0n, status: "released" }, {
    seq,
    kind: "RELEASE",
    movedOn: on,
    amountMinor: -amount,
    note: reason,
    entryId: entry.id,
  });

  return {
    code: p.code,
    on: iso(on),
    releasedMinor: amount.toString(),
    status: "released",
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    message:
      `${plain(amount)} released from ${p.code} — Dr ${p.accountCode}, Cr ${p.expenseAccount} ` +
      `(${entry.series}-${entry.number}). The credit reverses the original charge in ${iso(on).slice(0, 7)}, the ` +
      "period the estimate changed, rather than restating the period it was made in.",
  };
}

/* ---------------------------------------------------------------- promoting */

export interface PromoteResult {
  code: string;
  on: string;
  estimateMinor: string;
  carryingMinor: string;
  discountMinor: string;
  months: number;
  entryId: string;
  reference: string;
  message: string;
}

/**
 * A contingent liability has become probable, so it is recognised (IAS 37.30):
 *
 *   Dr  the expense it belongs to
 *     Cr  2150 Provisions
 *
 * From the date the change in probability occurred, and not before. That date
 * is the whole point — it decides which year carries the charge — so it is an
 * argument rather than something inferred from when somebody got round to
 * updating the register.
 *
 * This is a separate operation and not an edit to `kind`, because the
 * transition is an accounting event with a journal, a date and a line in the
 * movement table. An edit would leave a provision on the balance sheet with
 * nothing to say when it got there.
 */
export async function promote(opts: {
  orgId: string;
  entityId: string;
  code: string;
  on: string | Date;
  actorId?: string;
}): Promise<PromoteResult> {
  const plain = plainIn(await bookCurrency(opts.orgId, opts.entityId));
  const p = await loadProvision(opts.orgId, opts.entityId, opts.code);

  if (p.kind === "PROVISION") {
    throw new LedgerError(`${p.code} is already recognised as a provision; there is nothing to promote.`);
  }
  if (p.kind === "CONTINGENT_ASSET") {
    throw new LedgerError(
      `${p.code} is a contingent asset. A contingent asset is never recognised (IAS 37.31) — recognising one would ` +
        "book income that may never be realised. Once realisation is virtually certain it is no longer a " +
        "contingent asset at all (IAS 37.33) and it is recognised as the asset it has become, not as a provision.",
    );
  }
  if (p.estimateMinor <= 0n) {
    throw new LedgerError(
      `${p.code} has no amount, so it cannot be recognised: a provision needs an amount that can be estimated ` +
        "reliably (IAS 37.14(c)). Remeasure the disclosed estimate first, then promote it.",
    );
  }

  const on = parseDate(opts.on, "The date the outflow became probable");
  if (on < p.recognisedOn) {
    throw new LedgerError(
      `${iso(on)} is before ${p.code} was first disclosed on ${iso(p.recognisedOn)}. A contingent liability is ` +
        "recognised from the period the change in probability occurs (IAS 37.30), which cannot be earlier than " +
        "the obligation itself.",
    );
  }

  const measured = discountedEstimate({
    estimateMinor: p.estimateMinor,
    annualRateBps: p.discountRateBps,
    from: on,
    expectedOn: p.expectedOn,
  });

  const seq = await nextSeq(opts.orgId, p.id);
  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: on,
    memo: `Provision ${p.code} recognised — the outflow has become probable (IAS 37.30)`,
    source: "provision",
    sourceType: "PROVISION_PROMOTE",
    sourceId: p.code,
    externalKey: keyFor(opts.entityId, p.code, "promote", seq),
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "PV",
    lines: [
      { account: p.expenseAccount, debit: measured.valueMinor, memo: `${p.code} provision charged on promotion` },
      { account: p.accountCode, credit: measured.valueMinor, memo: `${p.code} contingent liability recognised` },
    ],
  });

  // The date it was first disclosed is kept in the note, because the register
  // now shows the recognition date and the two are different facts: one is
  // when the obligation was known about, the other when it became probable.
  const transition =
    `Disclosed as a contingent liability from ${iso(p.recognisedOn)}; recognised from ${iso(on)}, when the ` +
    "outflow became probable (IAS 37.30).";

  await commitMovement(
    p,
    {
      kind: "PROVISION",
      recognisedOn: on,
      carryingMinor: measured.valueMinor,
      note: [p.note, transition].filter(Boolean).join(" "),
    },
    {
      seq,
      kind: "RECOGNISE",
      movedOn: on,
      amountMinor: measured.valueMinor,
      note: transition,
      entryId: entry.id,
    },
  );

  return {
    code: p.code,
    on: iso(on),
    estimateMinor: p.estimateMinor.toString(),
    carryingMinor: measured.valueMinor.toString(),
    discountMinor: measured.discountMinor.toString(),
    months: measured.months,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    message:
      `${p.code} has been promoted from a contingent liability to a provision at ${plain(measured.valueMinor)} — ` +
      `Dr ${p.expenseAccount}, Cr ${p.accountCode} (${entry.series}-${entry.number}). It is recognised from ` +
      `${iso(on)}, the date the outflow became probable (IAS 37.30), and no earlier period is restated.`,
  };
}

/* -------------------------------------------------------------- the register */

export interface RegisterMovement {
  seq: number;
  kind: MovementKind;
  movedOn: string;
  amountMinor: string;
  note: string | null;
  entryId: string | null;
}

export interface RegisterProvision {
  code: string;
  name: string;
  category: ProvisionCategory;
  categoryLabel: string;
  kind: ProvisionKind;
  recognisedOn: string;
  expectedOn: string | null;
  estimateMinor: string;
  /** The estimate less the carrying amount: the discount still to unwind. */
  discountMinor: string;
  carryingMinor: string;
  discountRateBps: number;
  monthlyRateBps: number;
  accountCode: string;
  expenseAccount: string;
  status: string;
  note: string | null;
  recognised: boolean;
  basis: string;
  movements: RegisterMovement[];
}

export interface ProvisionRegisterResult {
  /** Recognised. These are on the balance sheet. */
  provisions: RegisterProvision[];
  /** Disclosed and never recognised. These are not. */
  contingencies: RegisterProvision[];
  totals: {
    carryingMinor: string;
    estimateMinor: string;
    discountMinor: string;
    contingentLiabilityMinor: string;
    contingentAssetMinor: string;
  };
  ledger: {
    accounts: string[];
    balanceMinor: string;
    /** Ledger less register. Nil is the only acceptable answer. */
    differenceMinor: string;
    agrees: boolean;
  };
}

/**
 * The provision register, with the ledger balance it is supposed to agree with.
 *
 * The contingencies are returned in their own list and never mixed with the
 * provisions. They are different things: one is a liability the balance sheet
 * carries, the other is a disclosure it does not, and a single list of both
 * reads as if the totals belong together. They do not, and adding them up is
 * exactly the mistake IAS 37.27 exists to prevent.
 */
export async function provisionRegister(opts: {
  orgId: string;
  entityId: string;
}): Promise<ProvisionRegisterResult> {
  const rows = await prisma.provision.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: [{ kind: "asc" }, { code: "asc" }],
  });
  const movements = rows.length
    ? await prisma.provisionMovement.findMany({
        where: { orgId: opts.orgId, provisionId: { in: rows.map((r) => r.id) } },
        orderBy: { seq: "asc" },
      })
    : [];
  const byProvision = new Map<string, RegisterMovement[]>();
  for (const m of movements) {
    const list = byProvision.get(m.provisionId) ?? [];
    list.push({
      seq: m.seq,
      kind: m.kind as MovementKind,
      movedOn: iso(m.movedOn),
      amountMinor: m.amountMinor.toString(),
      note: m.note,
      entryId: m.entryId,
    });
    byProvision.set(m.provisionId, list);
  }

  const shape = (p: ProvisionRow): RegisterProvision => ({
    code: p.code,
    name: p.name,
    category: p.category as ProvisionCategory,
    categoryLabel: CATEGORY_LABEL[p.category as ProvisionCategory] ?? p.category,
    kind: p.kind as ProvisionKind,
    recognisedOn: iso(p.recognisedOn),
    expectedOn: p.expectedOn ? iso(p.expectedOn) : null,
    estimateMinor: p.estimateMinor.toString(),
    discountMinor: (p.kind === "PROVISION" ? p.estimateMinor - p.carryingMinor : 0n).toString(),
    carryingMinor: p.carryingMinor.toString(),
    discountRateBps: p.discountRateBps,
    monthlyRateBps: p.discountRateBps === 0 ? 0 : monthlyRateBps(p.discountRateBps),
    accountCode: p.accountCode,
    expenseAccount: p.expenseAccount,
    status: p.status,
    note: p.note,
    recognised: p.kind === "PROVISION",
    basis: recognitionTest(p.kind as ProvisionKind, p.estimateMinor).basis,
    movements: byProvision.get(p.id) ?? [],
  });

  const provisions = rows.filter((r) => r.kind === "PROVISION").map(shape);
  const contingencies = rows.filter((r) => r.kind !== "PROVISION").map(shape);

  const registerCarrying = rows
    .filter((r) => r.kind === "PROVISION")
    .reduce((a, r) => a + r.carryingMinor, 0n);

  // Whatever accounts the provisions were actually charged to, not only the
  // default: a register that reconciles against an account nothing was posted
  // to would tie perfectly and mean nothing.
  const codes = [...new Set([PROVISION_ACCOUNT, ...rows.filter((r) => r.kind === "PROVISION").map((r) => r.accountCode)])];
  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: codes } },
    select: { id: true },
  });
  const lines = accounts.length
    ? await prisma.journalLine.findMany({
        where: {
          orgId: opts.orgId,
          accountId: { in: accounts.map((a) => a.id) },
          // A reversed entry and its reversal net to nothing; reading only
          // "posted" lines counts the reversal alone and moves the balance by
          // the full amount, which shows up here as a false difference.
          entry: { status: { in: ["posted", "reversed"] } },
        },
        select: { functionalAmountMinor: true },
      })
    : [];
  // 2150 is a credit balance, so the sign is flipped to compare against a
  // register that states what is owed as a positive number.
  const ledgerBalance = lines.reduce((a, l) => a - l.functionalAmountMinor, 0n);

  return {
    provisions,
    contingencies,
    totals: {
      carryingMinor: registerCarrying.toString(),
      estimateMinor: rows.filter((r) => r.kind === "PROVISION").reduce((a, r) => a + r.estimateMinor, 0n).toString(),
      discountMinor: rows
        .filter((r) => r.kind === "PROVISION")
        .reduce((a, r) => a + (r.estimateMinor - r.carryingMinor), 0n)
        .toString(),
      contingentLiabilityMinor: rows
        .filter((r) => r.kind === "CONTINGENT_LIABILITY")
        .reduce((a, r) => a + r.estimateMinor, 0n)
        .toString(),
      contingentAssetMinor: rows
        .filter((r) => r.kind === "CONTINGENT_ASSET")
        .reduce((a, r) => a + r.estimateMinor, 0n)
        .toString(),
    },
    ledger: {
      accounts: codes,
      balanceMinor: ledgerBalance.toString(),
      // A register that does not tie to the ledger is the finding, so it is
      // reported rather than reconciled away.
      differenceMinor: (ledgerBalance - registerCarrying).toString(),
      agrees: ledgerBalance === registerCarrying,
    },
  };
}

/* ------------------------------------------------------------------ the note */

export interface ProvisionNoteRow {
  category: ProvisionCategory;
  label: string;
  openingMinor: string;
  /** IAS 37.84(b): additional provisions made, including increases to existing ones. */
  additionsMinor: string;
  /** IAS 37.84(c): amounts used. Negative — it is a deduction. */
  usedMinor: string;
  /** IAS 37.84(d): unused amounts reversed. Negative. */
  releasedMinor: string;
  /** IAS 37.84(e): the increase from the passage of time. */
  unwoundMinor: string;
  closingMinor: string;
  /**
   * The provisions making up the closing balance, each at what it carried on
   * the reporting date. `status` is the register's status NOW — a provision
   * settled after the date still reads "settled" here, because that is the
   * one thing a reader of a stale note wants to know.
   */
  provisions: { code: string; name: string; carryingMinor: string; expectedOn: string | null; status: string }[];
}

export interface ProvisionNoteResult {
  entityId: string;
  asOf: string;
  from: string;
  periodLabel: string;
  rows: ProvisionNoteRow[];
  totals: {
    openingMinor: string;
    additionsMinor: string;
    usedMinor: string;
    releasedMinor: string;
    unwoundMinor: string;
    closingMinor: string;
  };
  /** The register's carrying amount, which the movements have to add up to. */
  carryingPerRegisterMinor: string;
  agreesWithRegister: boolean;
  /** Movements after the reporting date, which are why a difference can be honest. */
  movementsAfterAsOf: number;
  contingentLiabilities: {
    code: string; name: string; category: ProvisionCategory; label: string;
    estimateMinor: string; recognisedOn: string; expectedOn: string | null; note: string | null;
  }[];
  contingentAssets: {
    code: string; name: string; category: ProvisionCategory; label: string;
    estimateMinor: string; recognisedOn: string; expectedOn: string | null; note: string | null;
  }[];
  narrative: string[];
}

/**
 * The IAS 37.84–85 disclosure.
 *
 * For each CLASS of provision — not each provision — the carrying amount at
 * the beginning and end of the period, additions, amounts used, unused amounts
 * reversed, and the increase from the passage of time. By class because that
 * is what the standard asks for, and because a note listing every warranty
 * claim is a note nobody reads; the provisions in each class are carried on
 * the row so a reader can still get from the disclosure to the item without
 * leaving the page.
 *
 * The five movement columns are signed AGAINST THE CARRYING AMOUNT, so
 * opening + additions + used + released + unwound = closing, exactly. Amounts
 * used and reversed are therefore negative and print in parentheses, which is
 * how the deduction reads on paper anyway.
 *
 * Contingencies are listed under the same asOf but never added into those
 * totals — IAS 37.86 discloses them, IAS 37.27 keeps them off the balance
 * sheet, and a total that mixed the two would be neither.
 */
export async function provisionNote(opts: {
  orgId: string;
  entityId: string;
  asOf: string | Date;
}): Promise<ProvisionNoteResult> {
  const asOf = parseDate(opts.asOf, "The reporting date");

  // The period is the fiscal year the reporting date falls in, so "the
  // beginning of the period" means what the ledger means by it. Where no year
  // is open at that date — a note run over an entity whose books have not been
  // opened — it falls back to the calendar year, and says so in the label.
  const year = await prisma.fiscalYear.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, startsOn: { lte: asOf }, endsOn: { gte: asOf } },
    select: { label: true, startsOn: true },
  });
  const from = year?.startsOn ?? new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
  const periodLabel = year?.label ?? String(asOf.getUTCFullYear());

  const rows = await prisma.provision.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { code: "asc" },
  });
  const movements = rows.length
    ? await prisma.provisionMovement.findMany({
        where: { orgId: opts.orgId, provisionId: { in: rows.map((r) => r.id) } },
        orderBy: [{ provisionId: "asc" }, { seq: "asc" }],
      })
    : [];

  const categoryOf = new Map(rows.map((r) => [r.id, r.category as ProvisionCategory]));
  // A class appears only where something has actually moved in it by the
  // reporting date. A provision recognised next month is not part of this
  // period's note, and a row of zeroes would invite someone to reconcile a
  // class that does not exist yet.
  const moved = movements.filter((m) => m.movedOn <= asOf);
  const classes = CATEGORIES.filter((c) => moved.some((m) => categoryOf.get(m.provisionId) === c));

  /** What a provision carried at the reporting date, from its movements. */
  const carryingAt = (provisionId: string) =>
    moved.filter((m) => m.provisionId === provisionId).reduce((a, m) => a + m.amountMinor, 0n);

  const noteRows: ProvisionNoteRow[] = classes.map((category) => {
    const mine = movements.filter((m) => categoryOf.get(m.provisionId) === category);
    const before = mine.filter((m) => m.movedOn < from);
    const during = mine.filter((m) => m.movedOn >= from && m.movedOn <= asOf);

    const opening = before.reduce((a, m) => a + m.amountMinor, 0n);
    const sum = (pick: (m: (typeof during)[number]) => boolean) =>
      during.filter(pick).reduce((a, m) => a + m.amountMinor, 0n);

    // A downward remeasurement IS an unused amount reversed (IAS 37.84(d));
    // filing it under additions because the movement kind says REMEASURE would
    // net two opposite things against each other and lose both.
    const additions = sum((m) => (m.kind === "RECOGNISE" || m.kind === "REMEASURE") && m.amountMinor > 0n);
    const used = sum((m) => m.kind === "UTILISE");
    const released = sum((m) => m.kind === "RELEASE" || (m.kind === "REMEASURE" && m.amountMinor < 0n));
    const unwound = sum((m) => m.kind === "UNWIND");

    return {
      category,
      label: CATEGORY_LABEL[category],
      openingMinor: opening.toString(),
      additionsMinor: additions.toString(),
      usedMinor: used.toString(),
      releasedMinor: released.toString(),
      unwoundMinor: unwound.toString(),
      closingMinor: (opening + additions + used + released + unwound).toString(),
      // Each provision as it stood at the reporting date, not as it stands
      // now: these have to add up to the closing balance beside them, and a
      // note read six months later would otherwise show today's figures under
      // last year's heading.
      provisions: rows
        .filter((r) => r.category === category && r.kind === "PROVISION" && moved.some((m) => m.provisionId === r.id))
        .map((r) => ({
          code: r.code,
          name: r.name,
          carryingMinor: carryingAt(r.id).toString(),
          expectedOn: r.expectedOn ? iso(r.expectedOn) : null,
          status: r.status,
        })),
    };
  });

  const total = (pick: (r: ProvisionNoteRow) => string) =>
    noteRows.reduce((a, r) => a + BigInt(pick(r)), 0n);
  const closing = total((r) => r.closingMinor);
  const carrying = rows.filter((r) => r.kind === "PROVISION").reduce((a, r) => a + r.carryingMinor, 0n);
  const after = movements.filter((m) => m.movedOn > asOf).length;

  const disclosed = (kind: ProvisionKind) =>
    rows
      .filter((r) => r.kind === kind && r.recognisedOn <= asOf)
      .map((r) => ({
        code: r.code,
        name: r.name,
        category: r.category as ProvisionCategory,
        label: CATEGORY_LABEL[r.category as ProvisionCategory] ?? r.category,
        estimateMinor: r.estimateMinor.toString(),
        recognisedOn: iso(r.recognisedOn),
        expectedOn: r.expectedOn ? iso(r.expectedOn) : null,
        note: r.note,
      }));

  const contingentLiabilities = disclosed("CONTINGENT_LIABILITY");
  const contingentAssets = disclosed("CONTINGENT_ASSET");

  const narrative: string[] = [
    "A provision is recognised where there is a present obligation from a past event, an outflow of resources is " +
      "probable, and the amount can be estimated reliably (IAS 37.14). It is measured at the best estimate of the " +
      "expenditure required to settle the obligation at the reporting date (IAS 37.36).",
    "Where the effect of the time value of money is material the provision is measured at present value " +
      "(IAS 37.45) and the increase from the passage of time is recognised as a finance cost (IAS 37.60). It is " +
      "shown in its own column above and not as an addition, because it is not a change in the estimate.",
    "Provisions are reviewed at each reporting date and adjusted to the current best estimate (IAS 37.59); the " +
      "adjustment is recognised in the period the estimate changes. Only expenditure for which a provision was " +
      "originally recognised is set against it (IAS 37.61).",
    contingentLiabilities.length
      ? `${contingentLiabilities.length} contingent ${contingentLiabilities.length === 1 ? "liability is" : "liabilities are"} ` +
        "disclosed and not recognised, because an outflow is not probable or the amount cannot be measured " +
        "reliably (IAS 37.27, 37.86). Nothing in respect of them is included in the movements above."
      : "There are no contingent liabilities to disclose at this date (IAS 37.86).",
    contingentAssets.length
      ? `${contingentAssets.length} contingent ${contingentAssets.length === 1 ? "asset is" : "assets are"} ` +
        "disclosed because an inflow is probable. No contingent asset is recognised (IAS 37.31, 37.34)."
      : "There are no contingent assets to disclose at this date (IAS 37.34).",
    // Said plainly, because the reader has to know where the figures stop
    // being the standard and start being this software's approximation of it.
    "Prepared from the register: reimbursements (IAS 37.53) are not modelled and are not netted off; the discount " +
      "is applied over whole calendar months at the annual rate divided by twelve and rounded to the nearest basis " +
      "point; and whether an outflow is probable, whether a rate is pre-tax and specific to the liability " +
      "(IAS 37.47), and whether the risks and uncertainties have been reflected (IAS 37.42) are judgements taken " +
      "as given.",
  ];

  return {
    entityId: opts.entityId,
    asOf: iso(asOf),
    from: iso(from),
    periodLabel,
    rows: noteRows,
    totals: {
      openingMinor: total((r) => r.openingMinor).toString(),
      additionsMinor: total((r) => r.additionsMinor).toString(),
      usedMinor: total((r) => r.usedMinor).toString(),
      releasedMinor: total((r) => r.releasedMinor).toString(),
      unwoundMinor: total((r) => r.unwoundMinor).toString(),
      closingMinor: closing.toString(),
    },
    carryingPerRegisterMinor: carrying.toString(),
    agreesWithRegister: closing === carrying,
    movementsAfterAsOf: after,
    contingentLiabilities,
    contingentAssets,
    narrative,
  };
}
