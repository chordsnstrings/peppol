import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { post, LedgerError, type PostLine } from "./post";

/**
 * Annual leave, and the liability for the leave people have earned and not
 * taken.
 *
 * Three records again, kept apart for the same reason payroll keeps them apart.
 * The ENTITLEMENT is a function — of the joining date, the contract, and the
 * unpaid leave taken along the way — and it is never stored, because a stored
 * entitlement stops agreeing with the joining date the moment either of them
 * moves. The LEAVE RECORDS are what actually happened: days taken, days paid
 * out. The LEDGER holds only the consequence, on 2260, in one figure for the
 * whole workforce.
 *
 * The law is Federal Decree-Law 33/2021 on the Regulation of Labour Relations:
 *
 *   • Article 29(1)(a) — thirty days of annual leave for each year of service
 *     once a year is complete. A contract may give more; `leaveDaysPerYear`
 *     carries what this contract gives and the database refuses less than the
 *     statutory thirty.
 *   • Article 29(1)(b) — two working days for each month of service between
 *     six months and a year. Below six months there is nothing at all.
 *   • Article 29(3) — leave not taken by the end of the employment is paid out
 *     pro rata for the part year, at the wage in force at that time. That is
 *     why the provision is valued at each employee's CURRENT wage and not at
 *     the wage they were on when the days were earned.
 *   • Article 31 — sick leave is a separate entitlement and does not come out
 *     of annual leave. It is recorded here and deliberately not deducted.
 *
 * And the rule most leave systems get wrong: unpaid leave earns no annual
 * leave. A month of unpaid leave is a month that adds nothing to the balance,
 * so it comes out of service before any entitlement is computed at all.
 *
 * `leaveEntitlement` is pure, for the same reason `gratuityEntitlement` is:
 * the rule can then be argued with in a unit test against hand-computed
 * figures, rather than only observed through a database.
 *
 * All day figures are TENTHS of a day — half a day is 5 — and all arithmetic on
 * them is integer arithmetic. Money is BigInt minor units. Nothing here is ever
 * a float.
 */

/* ------------------------------------------------------------ the accounts */

/** IAS 19.11 accrues the cost of accumulating paid absences as they are earned. */
const LEAVE_PROVISION = "2260";
/**
 * The chart has no leave expense account: between 6000 Salaries and wages and
 * 6050 End-of-service benefits there is nothing, and 2260 was added to the
 * chart without an expense partner. Leave pay IS wages — the employee is paid
 * their salary while absent — so the charge belongs with the salary cost it
 * would have been had they worked the days. Inventing a 6060 here would put an
 * account in one entity's chart and not another's, and the reconciliations that
 * read 6000..6099 as "people" would still find it.
 */
const LEAVE_EXPENSE = "6000";
const BANK = "1010";

/* ------------------------------------------------------------ date helpers */

const DAY_MS = 86_400_000;

/** Floor any date to UTC midnight, so day counts are exact integers. */
function asDay(d: Date | string, what: string): Date {
  const v = typeof d === "string" ? new Date(`${d.slice(0, 10)}T00:00:00.000Z`) : d;
  if (Number.isNaN(v.getTime())) {
    throw new LedgerError(`${what} is not a date this module can read — write it as 2026-03-31.`);
  }
  return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
}

const dayCount = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Day 0 of the next month is the last day of this one. */
const monthEnd = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0));
};

function assertPeriod(period: string, what = "A leave provision period"): string {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new LedgerError(`${what} looks like 2026-03.`);
  const m = Number(period.slice(5));
  if (m < 1 || m > 12) throw new LedgerError(`There is no month ${period.slice(5)} — a period looks like 2026-03.`);
  return period;
}

/**
 * Minor units as a decimal string, in the currency the wage is paid in. Money
 * never becomes a float, and the decimals are the currency's own: this used to
 * split the digits two from the right, which is right for a dirham and wrong by
 * a factor of ten for a Kuwaiti or Bahraini dinar or an Omani rial.
 */
const decimalIn = (currency: string) => (minor: bigint) =>
  fmtMinor(minor, currency, { sign: "minus", zero: "zero" });

/** The currency this entity keeps its books in, which is the one salaries are in. */
async function bookCurrency(orgId: string, entityId: string): Promise<string> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  return book?.functionalCurrency ?? "AED";
}

/** Tenths of a day as a decimal string, by the same surgery. */
function dayText(tenth: number): string {
  const neg = tenth < 0;
  const abs = neg ? -tenth : tenth;
  return `${neg ? "-" : ""}${Math.trunc(abs / 10)}.${abs % 10}`;
}

/* --------------------------------------------------------- the leave rule */

const DAYS_IN_YEAR = 365n;
const TENTHS = 10n;
const MONTHS_IN_YEAR = 12n;
/**
 * Article 51 values a day of gratuity at the monthly wage over thirty rather
 * than over the calendar month, and leave pay is valued the same way. Using the
 * length of whichever month the leave happens to fall in would pay a day in
 * February more than a day in March for the same work.
 */
const DAYS_PER_PAY_MONTH = 30n;
/** Article 29(1)(b): the second band opens at six months of service. */
const BAND_OPENS_AT_MONTHS = 6n;
/** And closes when the year completes and Article 29(1)(a) takes over. */
const BAND_CLOSES_AT_MONTHS = 12n;
/** Article 29(1)(b): two working days for each month inside that band. */
const DAYS_PER_MONTH_IN_BAND = 2n;
/** Article 29(1)(a). The floor a contract may rise above and never fall below. */
export const STATUTORY_LEAVE_DAYS = 30;
/** The database allows no more; a year of leave a year is where meaning stops. */
const MAX_LEAVE_DAYS = 365;

export interface LeaveBasis {
  joinedOn: Date | string;
  /** Set once the employee has left; service stops accruing on this date. */
  leftOn?: Date | string | null;
  /** What the contract gives for a full year. Defaults to the statutory thirty. */
  leaveDaysPerYear?: number;
  /**
   * Unpaid leave already taken by `asOf`, in tenths of a day. It is passed in
   * rather than looked up so the rule stays a function of its arguments.
   */
  unpaidTenth?: number;
}

/**
 * The cumulative annual leave earned by `asOf`, in tenths of a day.
 *
 * Service is measured in whole days and a year is 365 of them, exactly as
 * `gratuityEntitlement` measures it, so that two employees who joined a day
 * apart do not drift relative to each other because a leap day fell between
 * them. Months, where Article 29(1)(b) needs them, are twelfths of that same
 * year rather than calendar months — one convention throughout, so that the
 * six-month point and the one-year point cannot land on different days
 * depending on which rule is asking.
 *
 * One division, at the end, for the same reason the gratuity does only one:
 * dividing to a daily figure first would round every employee's day down and
 * then multiply the error by their whole service.
 *
 * Unpaid leave is taken out of service BEFORE anything else happens. That is
 * the whole of the rule — there is no separate deduction afterwards, because a
 * month of unpaid leave should not merely be netted off the balance, it should
 * never have earned anything.
 *
 * INTERPRETATION. Removing unpaid leave from service can push an employee who
 * has been on the books for a year back under the twelve-month line and into
 * the two-days-a-month band, which is a real step down. The law does not say
 * in terms whether "a year of service" in Article 29(1)(a) is a year on the
 * books or a year of service that counts; this module reads it as the latter,
 * because that is what follows from unpaid leave not counting as service at
 * all. It is a reading, not a certainty, and an employer whose counsel reads it
 * the other way will get a different figure here.
 */
export function leaveEntitlement(opts: { employee: LeaveBasis; asOf: Date | string }): number {
  const e = opts.employee;

  const perYear = BigInt(e.leaveDaysPerYear ?? STATUTORY_LEAVE_DAYS);
  if (perYear < BigInt(STATUTORY_LEAVE_DAYS)) {
    throw new LedgerError(
      `A contract giving ${perYear} days of annual leave a year gives less than the ${STATUTORY_LEAVE_DAYS} ` +
        `Article 29 requires. A contract may improve on the law; it cannot fall below it.`,
    );
  }
  if (perYear > BigInt(MAX_LEAVE_DAYS)) {
    throw new LedgerError(`${perYear} days of leave a year is longer than a year. Check the contract.`);
  }

  const joined = asDay(e.joinedOn, "The joining date");
  const requested = asDay(opts.asOf, "The date to measure leave at");
  const left = e.leftOn ? asDay(e.leftOn, "The leaving date") : null;
  // Service stops on the leaving date, so somebody who left in March earns
  // nothing for the rest of the year — Article 29(3) pays the part year only.
  const measured = left && left < requested ? left : requested;

  const unpaid = BigInt(e.unpaidTenth ?? 0);
  if (unpaid < 0n) {
    throw new LedgerError("Unpaid leave cannot be a negative number of days; that would manufacture entitlement.");
  }

  const elapsed = BigInt(dayCount(joined, measured)) * TENTHS;
  const service = elapsed - unpaid;
  if (service <= 0n) return 0;

  const months = (service * MONTHS_IN_YEAR) / (DAYS_IN_YEAR * TENTHS);

  // Article 29(1)(b) gives nothing below six months. This is a cliff in the
  // law, not a rounding artefact, so it is not smoothed.
  if (months < BAND_OPENS_AT_MONTHS) return 0;

  // Two working days a month tops out at 22 days at eleven months and is then
  // replaced by the full thirty the day the year completes. The step is the
  // law's, and pro-rating across it would pay someone at eleven months more
  // than Article 29(1)(b) allows.
  if (months < BAND_CLOSES_AT_MONTHS) return Number(DAYS_PER_MONTH_IN_BAND * months * TENTHS);

  return Number((perYear * service) / DAYS_IN_YEAR);
}

/* ------------------------------------------------------------- leave pay */

/**
 * The wage a day of leave is paid at.
 *
 * `gratuityEntitlement` reads Article 51's "wage" as the basic wage alone and
 * then measures its cap on that same base, so that one definition of the word
 * is used from end to end. This module does the same thing: it names its base
 * once, here, and every valuation in the file goes through it.
 *
 * The base is basic plus housing. Housing is the part of the package the
 * employee still needs while they are away — the rent does not stop for the
 * holiday — and every UAE contract that provides it continues it through
 * leave. Transport and other allowances reimburse a cost that is NOT incurred
 * while on leave, so they stay out, exactly as they stay out of the gratuity.
 *
 * INTERPRETATION. Article 29(9) says leave is paid at the basic wage, and read
 * strictly that would exclude housing too. In practice the contract decides,
 * and the contracts that provide housing pay it through leave; this module
 * takes basic plus housing and says so here rather than implying the question
 * is settled. Where a contract really does pay leave on basic alone, the
 * housing figure on the employee record is what to change.
 */
export interface LeavePayBasis {
  basicMinor: bigint;
  housingMinor: bigint;
}

const leavePayBase = (e: LeavePayBasis): bigint => e.basicMinor + e.housingMinor;

/**
 * What some number of tenths of a day is worth at that base.
 *
 * One division, at the end, and never through a rounded daily rate: the rate
 * shown in the register is derived for the reader and nothing is computed from
 * it. A negative number of days — leave taken in advance — values negative,
 * because it is a real position and rounding it towards zero on the way out
 * would make a balance and its value disagree about which way they point.
 */
function valueOf(baseMinor: bigint, daysTenth: number): bigint {
  const t = BigInt(daysTenth);
  const neg = t < 0n;
  const abs = neg ? -t : t;
  const v = (baseMinor * abs) / (DAYS_PER_PAY_MONTH * TENTHS);
  return neg ? -v : v;
}

/* --------------------------------------------------------- the leave kinds */

export const LEAVE_KINDS = [
  "ANNUAL", "SICK", "UNPAID", "MATERNITY", "PARENTAL", "HAJJ", "COMPASSIONATE", "ENCASHED",
] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_KIND_LABEL: Record<LeaveKind, string> = {
  ANNUAL: "Annual leave",
  SICK: "Sick leave (Article 31)",
  UNPAID: "Unpaid leave",
  MATERNITY: "Maternity leave (Article 30)",
  PARENTAL: "Parental leave (Article 32)",
  HAJJ: "Hajj leave",
  COMPASSIONATE: "Compassionate leave",
  ENCASHED: "Paid out",
};

/**
 * Which kinds come off the annual leave balance.
 *
 * ANNUAL does, obviously. ENCASHED does, because days bought back are days the
 * employee no longer has. Nothing else does: Article 31 makes sick leave a
 * separate entitlement and says in terms that it is not deducted from annual
 * leave, and maternity, parental, Hajj and compassionate leave are each their
 * own statutory grant. UNPAID does not appear here either — it has already
 * done its work by shortening service inside `leaveEntitlement`, and deducting
 * it a second time would charge the employee twice for the same absence.
 */
const CONSUMES_BALANCE: LeaveKind[] = ["ANNUAL", "ENCASHED"];

/* ------------------------------------------------------- reading a balance */

export interface LeaveBalanceResult {
  code: string;
  name: string;
  joinedOn: string;
  leftOn: string | null;
  status: string;
  leaveDaysPerYear: number;
  asOf: string;
  /** Whole days between the joining date and `asOf`, before unpaid leave. */
  serviceDays: number;
  earnedTenth: number;
  takenTenth: number;
  encashedTenth: number;
  unpaidTenth: number;
  /** Sick, maternity and the rest — recorded, and deliberately not deducted. */
  otherTenth: number;
  /** Earned less taken less encashed. Negative where leave was taken in advance. */
  balanceTenth: number;
  basicMinor: string;
  housingMinor: string;
  /** Basic plus housing, the base every valuation here goes through. */
  leavePayBaseMinor: string;
  /** That base over thirty, for the reader. Nothing is computed from it. */
  dailyRateMinor: string;
  /** The balance at that base. Negative where the balance is. */
  valueMinor: string;
  /** What this person puts into the provision — the value, floored at nil. */
  provisionMinor: string;
  provisionTenth: number;
}

type EmployeeRow = {
  id: string; code: string; name: string;
  joinedOn: Date; leftOn: Date | null; status: string;
  leaveDaysPerYear: number; basicMinor: bigint; housingMinor: bigint;
};

const EMPLOYEE_FIELDS = {
  id: true, code: true, name: true,
  joinedOn: true, leftOn: true, status: true,
  leaveDaysPerYear: true, basicMinor: true, housingMinor: true,
} as const;

/**
 * Find one employee inside the caller's org AND entity.
 *
 * Never by id, and never by code alone. The entity id arrives from a client and
 * is only ever a filter applied inside the session's org, so a guessed id reads
 * nothing.
 */
async function employeeByCode(orgId: string, entityId: string, code: string): Promise<EmployeeRow> {
  const e = await prisma.employee.findFirst({
    where: { orgId, entityId, code: (code ?? "").trim() },
    select: EMPLOYEE_FIELDS,
  });
  if (!e) throw new LedgerError(`Employee ${code || "(blank)"} is not on the payroll for this entity.`);
  return e;
}

type LeaveRow = { kind: string; startsOn: Date; endsOn: Date; daysTenth: number; paid: boolean };

/**
 * The leave one employee has on the books at `asOf`.
 *
 * A record counts from the day it BEGINS. Leave that straddles the reporting
 * date is counted in full rather than split across it: the record carries a
 * span and a number of days but not which of those days fall where, so any
 * split would be an invention, and once leave has started the days are
 * committed anyway.
 */
function tally(rows: LeaveRow[], asOf: Date) {
  let taken = 0, encashed = 0, unpaid = 0, other = 0;
  for (const r of rows) {
    if (r.startsOn > asOf) continue;
    // Only UNPAID shortens service. `paid` is a payroll fact and not the test —
    // the third phase of Article 31 sick leave is unpaid too, and unpaid sick
    // leave is still service. It is the KIND of absence that decides whether it
    // counts, never whether money happened to change hands for it.
    if (r.kind === "ANNUAL") taken += r.daysTenth;
    else if (r.kind === "ENCASHED") encashed += r.daysTenth;
    else if (r.kind === "UNPAID") unpaid += r.daysTenth;
    else other += r.daysTenth;
  }
  return { taken, encashed, unpaid, other };
}

function balanceOf(e: EmployeeRow, rows: LeaveRow[], asOf: Date): LeaveBalanceResult {
  const t = tally(rows, asOf);
  const earned = leaveEntitlement({
    employee: {
      joinedOn: e.joinedOn,
      leftOn: e.leftOn,
      leaveDaysPerYear: e.leaveDaysPerYear,
      unpaidTenth: t.unpaid,
    },
    asOf,
  });
  const balance = earned - t.taken - t.encashed;
  const base = leavePayBase(e);
  const value = valueOf(base, balance);
  // A negative balance is an employee who owes the employer days, not a
  // liability, and it is not netted against anyone else's positive balance —
  // see `provisionForPeriod`.
  const provisionTenth = balance > 0 ? balance : 0;

  return {
    code: e.code,
    name: e.name,
    joinedOn: iso(e.joinedOn),
    leftOn: e.leftOn ? iso(e.leftOn) : null,
    status: e.status,
    leaveDaysPerYear: e.leaveDaysPerYear,
    asOf: iso(asOf),
    serviceDays: Math.max(0, dayCount(e.joinedOn, e.leftOn && e.leftOn < asOf ? e.leftOn : asOf)),
    earnedTenth: earned,
    takenTenth: t.taken,
    encashedTenth: t.encashed,
    unpaidTenth: t.unpaid,
    otherTenth: t.other,
    balanceTenth: balance,
    basicMinor: e.basicMinor.toString(),
    housingMinor: e.housingMinor.toString(),
    leavePayBaseMinor: base.toString(),
    dailyRateMinor: (base / DAYS_PER_PAY_MONTH).toString(),
    valueMinor: value.toString(),
    provisionMinor: valueOf(base, provisionTenth).toString(),
    provisionTenth,
  };
}

/**
 * One employee's leave position: earned, taken, paid out, and what is left.
 *
 * A negative balance is returned as a negative balance. Somebody who has taken
 * leave in advance of earning it is a real state of affairs — it is how most
 * employers handle a January holiday — and clamping it to nil would hide a
 * debt the employee is carrying and understate nothing at all in exchange.
 */
export async function leaveBalance(opts: {
  orgId: string;
  entityId: string;
  code: string;
  asOf: Date | string;
}): Promise<LeaveBalanceResult> {
  const e = await employeeByCode(opts.orgId, opts.entityId, opts.code);
  const asOf = asDay(opts.asOf, "The date to measure the leave balance at");
  const rows = await prisma.leaveRecord.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, employeeId: e.id },
    select: { kind: true, startsOn: true, endsOn: true, daysTenth: true, paid: true },
    orderBy: { startsOn: "asc" },
  });
  return balanceOf(e, rows, asOf);
}

/* --------------------------------------------------------- recording leave */

export interface RecordLeaveResult {
  id: string;
  code: string;
  name: string;
  kind: LeaveKind;
  startsOn: string;
  endsOn: string;
  daysTenth: number;
  days: string;
  paid: boolean;
  note: string | null;
  /** The balance after the record went in, so the caller sees what it did. */
  balance: LeaveBalanceResult;
  message: string;
}

/**
 * Record a period of leave.
 *
 * Where `daysTenth` is not supplied it is derived as the CALENDAR days from the
 * first day to the last inclusive. Article 29 grants thirty *calendar* days,
 * not thirty working days, so a weekend or a public holiday falling inside a
 * period of leave is part of that leave and is counted. Deriving working days
 * instead would silently give every employee back their weekends and turn a
 * thirty-day entitlement into six working weeks. A caller who does count
 * working days — some contracts do — passes `daysTenth` and the derivation
 * steps out of the way; it may be fewer days than the span but never more.
 */
export async function recordLeave(opts: {
  orgId: string;
  entityId: string;
  code: string;
  kind?: LeaveKind;
  startsOn: Date | string;
  endsOn: Date | string;
  daysTenth?: number;
  paid?: boolean;
  note?: string;
}): Promise<RecordLeaveResult> {
  const e = await employeeByCode(opts.orgId, opts.entityId, opts.code);
  const who = `${e.name} (${e.code})`;

  const kind = (opts.kind ?? "ANNUAL") as LeaveKind;
  if (!LEAVE_KINDS.includes(kind)) {
    throw new LedgerError(
      `"${String(kind)}" is not a kind of leave this module records. It is one of ${LEAVE_KINDS.join(", ")}.`,
    );
  }
  // Encashment moves money, so it goes through `encashLeave` and gets a journal
  // with it. A hand-written ENCASHED record would reduce the balance for free.
  if (kind === "ENCASHED") {
    throw new LedgerError(
      `Leave paid out is recorded by encashing it, not by writing a record: the payment has to reach the ledger ` +
        `at the same time. Use the encashment for ${who}.`,
    );
  }

  const startsOn = asDay(opts.startsOn, `The first day of leave for ${who}`);
  const endsOn = asDay(opts.endsOn, `The last day of leave for ${who}`);
  if (endsOn < startsOn) {
    throw new LedgerError(
      `Leave for ${who} ends on ${iso(endsOn)} and starts on ${iso(startsOn)}. Check which way round the dates went in.`,
    );
  }
  if (startsOn < e.joinedOn) {
    throw new LedgerError(`${who} joined on ${iso(e.joinedOn)} and cannot have taken leave from ${iso(startsOn)}.`);
  }

  if (opts.daysTenth !== undefined && !Number.isInteger(opts.daysTenth)) {
    throw new LedgerError(
      `Leave is recorded in tenths of a day — half a day is 5 — so ${opts.daysTenth} is not a number of days.`,
    );
  }
  const span = dayCount(startsOn, endsOn) + 1;
  const daysTenth = opts.daysTenth === undefined ? span * 10 : opts.daysTenth;
  if (daysTenth <= 0) {
    throw new LedgerError(`A leave record of no days is not a record. ${who} took nothing on ${iso(startsOn)}.`);
  }
  if (daysTenth > span * 10) {
    throw new LedgerError(
      `${dayText(daysTenth)} days of leave will not fit between ${iso(startsOn)} and ${iso(endsOn)}, which is ` +
        `${span} day${span === 1 ? "" : "s"}. Half days and working-day counts make a record shorter than its span, never longer.`,
    );
  }

  // Unpaid leave is unpaid by definition; the database says so too, and letting
  // it in as paid would put salary into the payroll that was never due.
  const paid = kind === "UNPAID" ? false : opts.paid ?? true;

  if (kind === "ANNUAL") {
    const clashes = await prisma.leaveRecord.findMany({
      where: {
        orgId: opts.orgId, entityId: opts.entityId, employeeId: e.id, kind: "ANNUAL",
        startsOn: { lte: endsOn }, endsOn: { gte: startsOn },
      },
      orderBy: { startsOn: "asc" },
    });
    if (clashes.length) {
      const c = clashes[0];
      // Named, not merely refused: "there is a clash" sends someone hunting
      // through a year of records for a period they can already be told.
      throw new LedgerError(
        `${who} already has annual leave from ${iso(c.startsOn)} to ${iso(c.endsOn)}, and ${iso(startsOn)} to ` +
          `${iso(endsOn)} overlaps it. One period of leave cannot be taken twice` +
          `${clashes.length > 1 ? ` — and it clashes with ${clashes.length - 1} more` : ""}.`,
      );
    }
  }

  const row = await prisma.leaveRecord.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId, employeeId: e.id,
      kind, startsOn, endsOn, daysTenth, paid,
      note: opts.note?.trim() || null,
    },
  });

  const balance = await leaveBalance({ orgId: opts.orgId, entityId: opts.entityId, code: e.code, asOf: endsOn });

  return {
    id: row.id,
    code: e.code,
    name: e.name,
    kind,
    startsOn: iso(startsOn),
    endsOn: iso(endsOn),
    daysTenth,
    days: dayText(daysTenth),
    paid,
    note: row.note,
    balance,
    message:
      kind === "ANNUAL"
        ? `${dayText(daysTenth)} days of annual leave recorded for ${who}. ${dayText(balance.balanceTenth)} days left at ${iso(endsOn)}.`
        : kind === "UNPAID"
          ? `${dayText(daysTenth)} days of unpaid leave recorded for ${who}. It earns no annual leave, so the ` +
            `entitlement at ${iso(endsOn)} is ${dayText(balance.earnedTenth)} days rather than what the calendar alone would give.`
          : `${dayText(daysTenth)} days of ${LEAVE_KIND_LABEL[kind].toLowerCase()} recorded for ${who}. ` +
            `It is a separate entitlement and does not come off the ${dayText(balance.balanceTenth)} days of annual leave.`,
  };
}

/* ------------------------------------------------------------- encashment */

export interface EncashLeaveResult {
  code: string;
  name: string;
  on: string;
  daysTenth: number;
  days: string;
  /** The base the payment was computed on: basic plus housing. */
  leavePayBaseMinor: string;
  paidMinor: string;
  entryId: string;
  reference: string;
  balance: LeaveBalanceResult;
  message: string;
}

/**
 * Buy back days of untaken leave.
 *
 *   Dr  2260  Untaken leave provision   the liability discharged
 *     Cr  1010  Bank                      the money that left
 *
 * The debit goes to the provision rather than to salaries because that is what
 * the provision is FOR: IAS 19.11 accrued the cost when the days were earned,
 * and paying them out settles the accrual rather than incurring the cost a
 * second time. Where the provision has not yet been run, 2260 goes temporarily
 * into debit — and that is not a hole, because `provisionForPeriod` posts the
 * MOVEMENT to the position and therefore charges whatever the payment left
 * uncovered at the next period end. The books are right at every period end,
 * which is where they are read.
 *
 * More days than the balance are refused. Article 29 lets untaken leave be paid
 * out; it does not let leave that was never earned be paid out, and an
 * encashment beyond the balance is either a typo or a salary advance wearing
 * the wrong name.
 */
export async function encashLeave(opts: {
  orgId: string;
  entityId: string;
  code: string;
  daysTenth: number;
  on: Date | string;
  /** Where the money leaves from. 2200 leaves it with the next payroll run. */
  paymentAccount?: string;
  note?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<EncashLeaveResult> {
  const decimal = decimalIn(await bookCurrency(opts.orgId, opts.entityId));
  const e = await employeeByCode(opts.orgId, opts.entityId, opts.code);
  const who = `${e.name} (${e.code})`;
  const on = asDay(opts.on, `The date leave was paid out to ${who}`);

  if (!Number.isInteger(opts.daysTenth)) {
    throw new LedgerError(`Leave is paid out in tenths of a day, so ${opts.daysTenth} is not a number of days.`);
  }
  if (opts.daysTenth <= 0) {
    throw new LedgerError(`Paying out no days of leave to ${who} is not a payment.`);
  }
  if (on < e.joinedOn) {
    throw new LedgerError(`${who} joined on ${iso(e.joinedOn)}; leave cannot be paid out before that.`);
  }

  const before = await leaveBalance({ orgId: opts.orgId, entityId: opts.entityId, code: e.code, asOf: on });
  if (opts.daysTenth > before.balanceTenth) {
    throw new LedgerError(
      `${who} has ${dayText(before.balanceTenth)} days of leave at ${iso(on)}, and ${dayText(opts.daysTenth)} ` +
        `cannot be paid out of it. Article 29 pays out leave that has been earned and not taken; it does not ` +
        `pay out leave that has not been earned.`,
    );
  }

  const base = leavePayBase(e);
  const amount = valueOf(base, opts.daysTenth);
  if (amount <= 0n) {
    throw new LedgerError(
      `${who} has no basic wage or housing recorded, so ${dayText(opts.daysTenth)} days of leave are worth nothing ` +
        `to pay out. Put the salary on the employment record first.`,
    );
  }

  // The record goes in first so the journal can name it and so the two cannot
  // exist without each other: if the post is refused — a closed period, most
  // likely — the record is removed again rather than left behind reducing the
  // balance for a payment that never happened.
  const row = await prisma.leaveRecord.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId, employeeId: e.id,
      kind: "ENCASHED", startsOn: on, endsOn: on, daysTenth: opts.daysTenth, paid: true,
      note: opts.note?.trim() || `Untaken leave paid out at ${decimal(base / DAYS_PER_PAY_MONTH)} a day`,
    },
  });

  let entry;
  try {
    entry = await post({
      orgId: opts.orgId,
      entityId: opts.entityId,
      entryDate: iso(on),
      memo: `Untaken leave paid out — ${e.name} (${e.code}), ${dayText(opts.daysTenth)} days`,
      source: "payroll",
      sourceType: "LEAVE_ENCASHMENT",
      sourceId: row.id,
      externalKey: `leave-encash:${row.id}`,
      actorType: opts.actorType ?? "HUMAN",
      actorId: opts.actorId,
      series: "PR",
      lines: [
        { account: LEAVE_PROVISION, debit: amount, memo: `Leave paid out — ${e.code}` },
        { account: opts.paymentAccount ?? BANK, credit: amount, memo: `Leave encashment — ${e.name}` },
      ],
    });
  } catch (err) {
    await prisma.leaveRecord.delete({ where: { id: row.id } }).catch(() => {});
    throw err;
  }

  const after = await leaveBalance({ orgId: opts.orgId, entityId: opts.entityId, code: e.code, asOf: on });

  return {
    code: e.code,
    name: e.name,
    on: iso(on),
    daysTenth: opts.daysTenth,
    days: dayText(opts.daysTenth),
    leavePayBaseMinor: base.toString(),
    paidMinor: amount.toString(),
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    balance: after,
    message:
      `${dayText(opts.daysTenth)} days paid out to ${who} at ${decimal(base / DAYS_PER_PAY_MONTH)} a day — ` +
      `${decimal(amount)}, Dr ${LEAVE_PROVISION} Cr ${opts.paymentAccount ?? BANK} (${entry.series}-${entry.number}). ` +
      `${dayText(after.balanceTenth)} days remain.`,
  };
}

/* --------------------------------------------------------- the provision */

export interface ProvisionForPeriodResult {
  period: string;
  asOf: string;
  employees: number;
  /** The liability at the period end: what the position IS. */
  balanceMinor: string;
  daysTenth: number;
  days: string;
  /** What 2260 carried before this run. */
  openingMinor: string;
  /** The movement posted — positive a charge, negative a release. */
  chargeMinor: string;
  entryId: string | null;
  reference: string | null;
  /** True when the position was already on the ledger and nothing was posted. */
  unchanged: boolean;
  rows: { code: string; name: string; daysTenth: number; days: string; valueMinor: string }[];
  message: string;
}

/**
 * Provide for untaken leave at the end of a period.
 *
 *   Dr  6000  Salaries and wages        the movement, where the liability grew
 *     Cr  2260  Untaken leave provision
 *
 * and the other way round where it shrank.
 *
 * The entry is the MOVEMENT, never the balance. IAS 19.11 charges the cost of
 * accumulating paid absences to the periods that earn them, so what a month
 * owes is the change in the liability across it; posting the position itself
 * would charge the whole workforce's accumulated leave again every month.
 *
 * The movement is measured against what the LEDGER carries on 2260 rather than
 * against the last `LeaveProvision` row. That is what makes it idempotent on
 * the position rather than on the run: after a run the ledger equals the
 * position, so a second run finds a movement of nil and posts nothing at all —
 * and an encashment or a reversal that moved 2260 in between is picked up
 * without anybody having to remember to tell this function about it.
 *
 * A negative balance — leave taken in advance — is floored at nil per employee
 * and does not net against anybody else's. What one employee owes the employer
 * is a receivable from that employee, not a reduction in the employer's
 * liability to everyone else, and offsetting the two would state a smaller
 * liability than exists. It is also what the database insists on: a
 * LeaveProvision balance may not be negative.
 */
export async function provisionForPeriod(opts: {
  orgId: string;
  entityId: string;
  period: string;
  expenseAccount?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<ProvisionForPeriodResult> {
  const decimal = decimalIn(await bookCurrency(opts.orgId, opts.entityId));
  const period = assertPeriod(opts.period);
  const end = monthEnd(period);

  // Everyone still employed at the period end. Somebody who has left has been
  // settled — Article 29(3) pays their untaken leave out on the way — so they
  // hold no untaken-leave liability, and somebody who had not joined yet holds
  // none either.
  const employees = await prisma.employee.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: "active", joinedOn: { lte: end } },
    select: EMPLOYEE_FIELDS,
    orderBy: { code: "asc" },
  });

  const records = employees.length
    ? await prisma.leaveRecord.findMany({
        where: { orgId: opts.orgId, entityId: opts.entityId, employeeId: { in: employees.map((e) => e.id) } },
        select: { employeeId: true, kind: true, startsOn: true, endsOn: true, daysTenth: true, paid: true },
      })
    : [];
  const byEmployee = new Map<string, LeaveRow[]>();
  for (const r of records) {
    const list = byEmployee.get(r.employeeId) ?? [];
    list.push(r);
    byEmployee.set(r.employeeId, list);
  }

  let balance = 0n;
  let daysTenth = 0;
  const rows: ProvisionForPeriodResult["rows"] = [];
  for (const e of employees) {
    const b = balanceOf(e, byEmployee.get(e.id) ?? [], end);
    const value = BigInt(b.provisionMinor);
    balance += value;
    daysTenth += b.provisionTenth;
    rows.push({
      code: e.code, name: e.name,
      daysTenth: b.provisionTenth, days: dayText(b.provisionTenth),
      valueMinor: value.toString(),
    });
  }

  const opening = await provisionAccountBalance(opts.orgId, opts.entityId);
  const charge = balance - opening;
  const existing = await prisma.leaveProvision.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, period },
  });

  if (charge === 0n) {
    // The position is already on the ledger. The row is still written, because
    // a period that was measured and needed nothing is a different fact from a
    // period nobody ever looked at, and only the row can tell them apart.
    const saved = existing
      ? await prisma.leaveProvision.update({
          where: { id: existing.id },
          data: { balanceMinor: balance, daysTenth },
        })
      : await prisma.leaveProvision.create({
          data: {
            orgId: opts.orgId, entityId: opts.entityId, period,
            balanceMinor: balance, chargeMinor: 0n, daysTenth,
          },
        });
    const entry = saved.entryId
      ? await prisma.journalEntry.findFirst({
          where: { id: saved.entryId, orgId: opts.orgId, entityId: opts.entityId },
          select: { id: true, series: true, number: true },
        })
      : null;
    return {
      period, asOf: iso(end), employees: employees.length,
      balanceMinor: balance.toString(), daysTenth, days: dayText(daysTenth),
      openingMinor: opening.toString(), chargeMinor: "0",
      entryId: entry?.id ?? null,
      reference: entry ? `${entry.series}-${entry.number}` : null,
      unchanged: true,
      rows,
      message:
        `2260 already carries ${decimal(balance)} for ${dayText(daysTenth)} days of untaken leave at ` +
        `${iso(end)}, so ${period} has nothing to post.`,
    };
  }

  const lines: PostLine[] =
    charge > 0n
      ? [
          { account: opts.expenseAccount ?? LEAVE_EXPENSE, debit: charge, memo: `Untaken leave accrued in ${period}` },
          { account: LEAVE_PROVISION, credit: charge, memo: `Untaken leave at ${iso(end)} — ${dayText(daysTenth)} days` },
        ]
      : [
          { account: LEAVE_PROVISION, debit: -charge, memo: `Untaken leave at ${iso(end)} — ${dayText(daysTenth)} days` },
          { account: opts.expenseAccount ?? LEAVE_EXPENSE, credit: -charge, memo: `Untaken leave released in ${period}` },
        ];

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    // The period end, like payroll: this is a measurement of a whole month, and
    // a closed period is refused by post() in its own words rather than by a
    // paraphrase of them here. Two guards on one rule drift apart.
    entryDate: iso(end),
    memo: `Untaken leave provision at ${iso(end)}`,
    source: "payroll",
    sourceType: "LEAVE_PROVISION",
    sourceId: period,
    // The key names the POSITION being moved to, not the run that moved it. A
    // key naming the run would let two runs post the same position twice, and
    // nothing chases a leave provision afterwards to notice it doubled.
    externalKey: `leave-provision:${opts.entityId}:${period}:${balance}`,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "PR",
    lines,
  });

  const saved = existing
    ? await prisma.leaveProvision.update({
        where: { id: existing.id },
        // The charge accumulates: a period can be provided for more than once
        // when a leave record arrives late, and what the period cost profit is
        // the sum of its movements, not the last of them.
        data: { balanceMinor: balance, chargeMinor: existing.chargeMinor + charge, daysTenth, entryId: entry.id },
      })
    : await prisma.leaveProvision.create({
        data: {
          orgId: opts.orgId, entityId: opts.entityId, period,
          balanceMinor: balance, chargeMinor: charge, daysTenth, entryId: entry.id,
        },
      });

  return {
    period, asOf: iso(end), employees: employees.length,
    balanceMinor: balance.toString(), daysTenth, days: dayText(daysTenth),
    openingMinor: opening.toString(), chargeMinor: saved.chargeMinor.toString(),
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    unchanged: false,
    rows,
    message:
      charge > 0n
        ? `${decimal(charge)} charged for ${period} — Dr ${opts.expenseAccount ?? LEAVE_EXPENSE}, Cr ${LEAVE_PROVISION} ` +
          `(${entry.series}-${entry.number}). 2260 now carries ${decimal(balance)} for ${dayText(daysTenth)} days.`
        : `${decimal(-charge)} released for ${period} — Dr ${LEAVE_PROVISION}, Cr ${opts.expenseAccount ?? LEAVE_EXPENSE} ` +
          `(${entry.series}-${entry.number}). 2260 now carries ${decimal(balance)} for ${dayText(daysTenth)} days.`,
  };
}

/**
 * What 2260 carries, stated the way the register states it: positive is owed.
 *
 * Reversed entries are read alongside posted ones. A reversal and the entry it
 * reverses net to nothing, and reading only "posted" lines would count the
 * reversal on its own and move the balance by the whole amount — which shows up
 * in the register as a difference that is not there.
 */
async function provisionAccountBalance(orgId: string, entityId: string): Promise<bigint> {
  const account = await prisma.account.findFirst({
    where: { orgId, entityId, code: LEAVE_PROVISION },
    select: { id: true },
  });
  if (!account) return 0n;
  const lines = await prisma.journalLine.findMany({
    where: {
      orgId,
      accountId: account.id,
      entry: { entityId, status: { in: ["posted", "reversed"] } },
    },
    select: { functionalAmountMinor: true },
  });
  // A liability is held negative in the ledger; the register says what is owed.
  return lines.reduce((a, l) => a - l.functionalAmountMinor, 0n);
}

/* --------------------------------------------------------- the register */

export interface LeaveRegisterResult {
  asOf: string;
  employees: LeaveBalanceResult[];
  totals: {
    /** Days of untaken leave the provision is measured on — negatives excluded. */
    provisionTenth: number;
    provisionDays: string;
    provisionMinor: string;
    /** The net position including advances, for a reader who wants the whole picture. */
    netTenth: number;
    netDays: string;
    netMinor: string;
    /** Days taken in advance of being earned, stated on their own. */
    advanceTenth: number;
    advanceDays: string;
    advanceMinor: string;
  };
  /** The last period provided for, and what it said. */
  lastProvision: { period: string; balanceMinor: string; chargeMinor: string; daysTenth: number; entryId: string | null } | null;
  ledger: {
    account: string;
    balanceMinor: string;
    /** Ledger less register. Nil is the only acceptable answer at a period end. */
    differenceMinor: string;
    agrees: boolean;
  };
}

/**
 * Every employee's leave balance and its value, against the 2260 balance it is
 * supposed to agree with.
 *
 * The comparison is the point of the thing. A register nobody compares to the
 * ledger is a spreadsheet with extra steps, so the difference is returned as a
 * number rather than reconciled away — and it is genuinely non-nil between a
 * period end and the next provision run, because leave goes on being earned
 * every day while the ledger only moves when somebody posts. What it must be
 * at a period end, once that period has been provided for, is nil.
 *
 * Employees who have left are listed but contribute nothing: their untaken
 * leave was paid out on the way, so including them would state a liability for
 * people the employer no longer owes anything to.
 */
export async function leaveRegister(opts: {
  orgId: string;
  entityId: string;
  asOf: Date | string;
}): Promise<LeaveRegisterResult> {
  const asOf = asDay(opts.asOf, "The date to draw the leave register at");

  const employees = await prisma.employee.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    select: EMPLOYEE_FIELDS,
    orderBy: [{ status: "asc" }, { code: "asc" }],
  });
  const records = employees.length
    ? await prisma.leaveRecord.findMany({
        where: { orgId: opts.orgId, entityId: opts.entityId, employeeId: { in: employees.map((e) => e.id) } },
        select: { employeeId: true, kind: true, startsOn: true, endsOn: true, daysTenth: true, paid: true },
      })
    : [];
  const byEmployee = new Map<string, LeaveRow[]>();
  for (const r of records) {
    const list = byEmployee.get(r.employeeId) ?? [];
    list.push(r);
    byEmployee.set(r.employeeId, list);
  }

  const rows = employees.map((e) => balanceOf(e, byEmployee.get(e.id) ?? [], asOf));

  let provisionTenth = 0, netTenth = 0, advanceTenth = 0;
  let provision = 0n, net = 0n, advance = 0n;
  for (const r of rows) {
    // Someone who has left holds no untaken-leave liability; their row still
    // shows what they had, so nothing is hidden, but it is not provided for.
    const counts = r.status === "active";
    if (counts) {
      netTenth += r.balanceTenth;
      net += BigInt(r.valueMinor);
      if (r.balanceTenth > 0) {
        provisionTenth += r.provisionTenth;
        provision += BigInt(r.provisionMinor);
      } else {
        advanceTenth += r.balanceTenth;
        advance += BigInt(r.valueMinor);
      }
    }
  }

  const last = await prisma.leaveProvision.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { period: "desc" },
  });
  const ledgerBalance = await provisionAccountBalance(opts.orgId, opts.entityId);

  return {
    asOf: iso(asOf),
    employees: rows,
    totals: {
      provisionTenth, provisionDays: dayText(provisionTenth), provisionMinor: provision.toString(),
      netTenth, netDays: dayText(netTenth), netMinor: net.toString(),
      advanceTenth, advanceDays: dayText(advanceTenth), advanceMinor: advance.toString(),
    },
    lastProvision: last
      ? {
          period: last.period,
          balanceMinor: last.balanceMinor.toString(),
          chargeMinor: last.chargeMinor.toString(),
          daysTenth: last.daysTenth,
          entryId: last.entryId,
        }
      : null,
    ledger: {
      account: LEAVE_PROVISION,
      balanceMinor: ledgerBalance.toString(),
      differenceMinor: (ledgerBalance - provision).toString(),
      agrees: ledgerBalance === provision,
    },
  };
}

/* ------------------------------------------------------------- the records */

export interface LeaveRecordRow {
  id: string;
  code: string;
  name: string;
  kind: LeaveKind;
  kindLabel: string;
  startsOn: string;
  endsOn: string;
  daysTenth: number;
  days: string;
  paid: boolean;
  consumesBalance: boolean;
  note: string | null;
}

/** Every leave record in the entity, most recent first, for the register page. */
export async function leaveRecords(opts: {
  orgId: string;
  entityId: string;
  code?: string;
  limit?: number;
}): Promise<LeaveRecordRow[]> {
  const employee = opts.code ? await employeeByCode(opts.orgId, opts.entityId, opts.code) : null;
  const rows = await prisma.leaveRecord.findMany({
    where: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      ...(employee ? { employeeId: employee.id } : {}),
    },
    orderBy: [{ startsOn: "desc" }, { createdAt: "desc" }],
    take: Math.min(Math.max(opts.limit ?? 200, 1), 500),
  });
  if (rows.length === 0) return [];

  const employees = await prisma.employee.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, id: { in: [...new Set(rows.map((r) => r.employeeId))] } },
    select: { id: true, code: true, name: true },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  return rows.map((r) => {
    const e = byId.get(r.employeeId);
    const kind = r.kind as LeaveKind;
    return {
      id: r.id,
      code: e?.code ?? "?",
      name: e?.name ?? "Unknown",
      kind,
      kindLabel: LEAVE_KIND_LABEL[kind] ?? r.kind,
      startsOn: iso(r.startsOn),
      endsOn: iso(r.endsOn),
      daysTenth: r.daysTenth,
      days: dayText(r.daysTenth),
      paid: r.paid,
      consumesBalance: CONSUMES_BALANCE.includes(kind),
      note: r.note,
    };
  });
}
