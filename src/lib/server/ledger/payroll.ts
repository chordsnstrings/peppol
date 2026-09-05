import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { post, LedgerError, type PostLine } from "./post";
import { assertApproved } from "./approvals";

/**
 * Payroll: the employee register, the monthly run, end-of-service gratuity and
 * the WPS salary file.
 *
 * Three records are kept apart on purpose. The *employee* is a contract — a
 * basic wage, a joining date, a bank instruction — and nothing in the ledger
 * describes it. The *payslip* is what that contract produced in one month. The
 * *ledger* holds only the consequence, in totals. Keeping them separate is what
 * makes `payrollSummary` a control rather than a restatement: if the payslips
 * and 6000/2200/2250 disagree, that is a finding.
 *
 * The journal is posted in account totals rather than one line per employee.
 * Individual salaries in the general ledger are readable by everyone with
 * ledger access, and the per-employee detail already exists — on the payslips.
 *
 * Gratuity follows Federal Decree-Law 33/2021 (the UAE Labour Law), Article 51:
 * computed on the BASIC wage only, 21 days' pay for each of the first five
 * years and 30 days for each year after that, with fractions of a year paid pro
 * rata once one full year is complete, and the whole entitlement capped. It is
 * accrued monthly rather than recognised on departure, because IAS 19 puts the
 * cost in the periods that earned it, not the period the employee happened to
 * resign in.
 */

/* ------------------------------------------------------------ the accounts */

const SALARY_EXPENSE = "6000";
const EOSB_EXPENSE = "6050";
const SALARY_PAYABLE = "2200";
const EOSB_PROVISION = "2250";
const PENSION_PAYABLE = "2230";
const BANK = "1010";
/**
 * Deductions are, overwhelmingly, recovery of a salary advance — Article 25 of
 * the Labour Law caps what may be withheld and lists the permitted reasons, and
 * an advance is the first of them. Crediting 1400 clears the advance the
 * employee already drew rather than inventing income.
 */
const EMPLOYEE_ADVANCES = "1400";

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

const monthStart = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
};
/** Day 0 of the next month is the last day of this one. */
const monthEnd = (period: string) => {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0));
};
/** The month-end before `d` — the point last month's cumulative was measured at. */
const previousMonthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));

function assertPeriod(period: string, what = "A payroll period"): string {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new LedgerError(`${what} looks like 2026-03.`);
  const m = Number(period.slice(5));
  if (m < 1 || m > 12) throw new LedgerError(`There is no month ${period.slice(5)} — a payroll period looks like 2026-03.`);
  return period;
}

/**
 * Minor units as a decimal string, in the currency the wage is paid in. Money
 * never becomes a float, and the number of decimals is the currency's own: this
 * used to split the digits two from the right, which is right for a dirham and
 * wrong by a factor of ten for a Kuwaiti or Bahraini dinar or an Omani rial.
 */
const decimalIn = (currency: string) => (minor: bigint) =>
  fmtMinor(minor, currency, { sign: "minus", zero: "zero" });

/**
 * The GPSSA floor and cap are dirham amounts set by law, not book figures, so
 * they are read in dirhams whatever currency the entity keeps its books in.
 * `pensionContribution` is handed rates and a salary and has no book to ask.
 */
const inDirhams = decimalIn("AED");

/**
 * An amount for the WPS SIF file: dirhams, and no thousands separator. The
 * record itself ends with the literal AED, and the file is comma-delimited —
 * a grouped figure would split one field into two and the bank would reject
 * the whole file.
 */
const sifAmount = (minor: bigint) => inDirhams(minor).replace(/,/g, "");

/** The currency this entity keeps its books in, which is the one wages are in. */
async function bookCurrency(orgId: string, entityId: string): Promise<string> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  return book?.functionalCurrency ?? "AED";
}

/* --------------------------------------------------------- pension schemes */

export type PensionScheme = "NONE" | "GPSSA" | "GCC_HOME_STATE";

/**
 * Who is provided for by a pension rather than by a gratuity.
 *
 * Article 51 of Federal Decree-Law 33/2021 gives end-of-service gratuity to the
 * *foreign* worker. A UAE national in the private sector is covered instead by
 * the pension and social security scheme under Federal Law 7/1999, and a GCC
 * national by their own home state's scheme under the Insurance Protection
 * Extension Programme. Accruing a gratuity as well as contributing to a pension
 * provides for the same service twice; accruing neither of the contributions
 * understates what it costs to employ them every month. This module used to do
 * both.
 *
 * Membership is declared on the employee, never inferred from nationality.
 * Eligibility is a legal fact about a person — a GCC national may or may not be
 * enrolled, a UAE national may be registered late, and a dual national is a
 * question for somebody who knows the case. The nationality field is recorded
 * for context and decides nothing, which is the same stance the related-party
 * note takes: declared, never detected.
 */
export const accruesGratuity = (scheme: PensionScheme) => scheme === "NONE";

/**
 * The contribution rates, and the fact that they are inputs.
 *
 * These are the private-sector rates in force at the time of writing and they
 * are a starting point, not law this module can vouch for: they have been
 * amended more than once, they differ for an employee who joined after a
 * particular date, and the government's own share is not the employer's to pay.
 * So they are arguments with documented defaults, exactly as the deferred tax
 * module takes a depreciation rate — the structure is the rule here, the
 * percentages are a policy input the business confirms.
 *
 * The contribution salary is not gross pay. It is defined by the scheme, is
 * generally the basic wage plus the allowances named in the contract, and is
 * bounded — which is why the floor and the cap are here rather than left to
 * whoever calls this.
 */
export interface PensionRates {
  /** Withheld from the employee, in basis points. 5% is 500. */
  employeeBps: number;
  /** The employer's own share, in basis points. */
  employerBps: number;
  /** The least the contribution salary may be, in minor units. */
  floorMinor: bigint;
  /** The most it may be. */
  capMinor: bigint;
}

export const GPSSA_DEFAULT_RATES: PensionRates = {
  employeeBps: 500,
  employerBps: 1_250,
  floorMinor: 100_000n,      // AED 1,000 a month
  capMinor: 5_000_000n,      // AED 50,000 a month
};

export interface PensionContribution {
  scheme: PensionScheme;
  /** What the rate was applied to, after the floor and the cap. */
  contributionSalaryMinor: bigint;
  employeeMinor: bigint;
  employerMinor: bigint;
  totalMinor: bigint;
  /** Why the salary was moved, where it was. */
  note: string | null;
}

/**
 * One month's contributions.
 *
 * Rounded once per side, half away from zero. Rounding a total and splitting it
 * would put a fil in whichever side the arithmetic happened to favour, and the
 * employee's half is withheld from their pay — a fil there is a figure somebody
 * queries.
 */
export function pensionContribution(opts: {
  scheme: PensionScheme;
  /** Basic plus the allowances the contract makes pensionable. */
  contributionSalaryMinor: bigint | number | string;
  rates?: PensionRates;
}): PensionContribution {
  const scheme = opts.scheme;
  if (scheme === "NONE") {
    return { scheme, contributionSalaryMinor: 0n, employeeMinor: 0n, employerMinor: 0n, totalMinor: 0n, note: null };
  }

  const rates = opts.rates ?? GPSSA_DEFAULT_RATES;
  const raw = BigInt(opts.contributionSalaryMinor);
  if (raw < 0n) throw new LedgerError("A contribution salary cannot be negative.");

  let salary = raw;
  let note: string | null = null;
  if (raw < rates.floorMinor) {
    salary = rates.floorMinor;
    note = `The contribution salary was raised to the scheme's floor of ${inDirhams(rates.floorMinor)}.`;
  } else if (raw > rates.capMinor) {
    salary = rates.capMinor;
    note = `The contribution salary was capped at ${inDirhams(rates.capMinor)}; pay above the cap does not contribute.`;
  }

  const share = (bps: number) => {
    const n = salary * BigInt(bps);
    const q = n / 10_000n;
    return n % 10_000n * 2n >= 10_000n ? q + 1n : q;
  };
  const employeeMinor = share(rates.employeeBps);
  const employerMinor = share(rates.employerBps);

  return {
    scheme,
    contributionSalaryMinor: salary,
    employeeMinor,
    employerMinor,
    totalMinor: employeeMinor + employerMinor,
    note,
  };
}

/* -------------------------------------------------------- the gratuity rule */

const DAYS_IN_YEAR = 365n;
/** Article 51 values a day at the monthly basic wage over thirty, not over the calendar month. */
const DAYS_PER_PAY_MONTH = 30n;
const DAYS_PER_YEAR_FIRST_FIVE = 21n;
const DAYS_PER_YEAR_THEREAFTER = 30n;
const FIRST_TIER_YEARS = 5n;
/**
 * Article 51(4) caps the gratuity at "the wage of two years". The whole
 * entitlement is measured on the basic wage, so the ceiling is measured on the
 * same base — letting housing and transport raise a ceiling on an entitlement
 * they never fed would be arithmetic with two different definitions of "wage".
 */
const CAP_MONTHS_OF_BASIC = 24n;

export interface GratuityBasis {
  basicMinor: bigint | number | string;
  joinedOn: Date | string;
  /** Set once the employee has left; service stops accruing on this date. */
  leftOn?: Date | string | null;
}

/**
 * The cumulative end-of-service entitlement earned by `asOf`.
 *
 * Pure, so the rule can be argued with in a unit test rather than only observed
 * through a database. Service is measured in whole days and a year is taken as
 * 365 of them: Article 51(2) pays fractions of a year pro rata, so a day is the
 * natural unit, and a fixed 365 keeps two employees who joined a day apart from
 * drifting relative to each other because a leap day fell between them.
 *
 * One division, at the end. Dividing the daily rate first would round every
 * employee's day rate down and then multiply the error by their whole service.
 */
export function gratuityEntitlement(opts: {
  basicMinor: bigint | number | string;
  joinedOn: Date | string;
  asOf: Date | string;
}): bigint {
  const basic = BigInt(opts.basicMinor);
  if (basic < 0n) throw new LedgerError("A basic wage cannot be negative, so no gratuity can be computed from one.");

  const joined = asDay(opts.joinedOn, "The joining date");
  const asOf = asDay(opts.asOf, "The date to measure gratuity at");
  const days = BigInt(dayCount(joined, asOf));

  // Article 51(1): nothing at all below one continuous year. This is a cliff in
  // the law, not a rounding artefact, so it is not smoothed.
  if (days < DAYS_IN_YEAR) return 0n;

  const firstTierDays = FIRST_TIER_YEARS * DAYS_IN_YEAR;
  const inFirstTier = days < firstTierDays ? days : firstTierDays;
  const beyond = days - inFirstTier;

  const daysOfPay = DAYS_PER_YEAR_FIRST_FIVE * inFirstTier + DAYS_PER_YEAR_THEREAFTER * beyond;
  const earned = (basic * daysOfPay) / (DAYS_PER_PAY_MONTH * DAYS_IN_YEAR);

  const cap = basic * CAP_MONTHS_OF_BASIC;
  return earned > cap ? cap : earned;
}

export interface GratuityAccrual {
  /** Whole days of continuous service counted. */
  serviceDays: number;
  /** Everything earned to the end of this month. */
  cumulativeMinor: bigint;
  /** What had been earned by the end of last month. */
  priorMinor: bigint;
  /** The increment this month has to carry — what gets provided for. */
  accrualMinor: bigint;
}

/**
 * The gratuity increment for the month ending `asOf`.
 *
 * Charging the increment rather than a flat twenty-first of a month's pay is
 * what makes the provision correct at every date in between: the balance on
 * 2250 always equals what would be owed if everyone resigned that day. It also
 * absorbs the step at five years and the cap without any special case — both
 * are already in the cumulative curve.
 */
export function gratuityAccrual(employee: GratuityBasis, asOf: Date | string): GratuityAccrual {
  const joined = asDay(employee.joinedOn, "The joining date");
  const requested = asDay(asOf, "The accrual date");
  // Service stops on the leaving date, so a mid-month leaver accrues to the day
  // they left and not to the end of a month they did not work.
  const left = employee.leftOn ? asDay(employee.leftOn, "The leaving date") : null;
  const measured = left && left < requested ? left : requested;

  const cumulative = gratuityEntitlement({ basicMinor: employee.basicMinor, joinedOn: joined, asOf: measured });
  const prior = gratuityEntitlement({
    basicMinor: employee.basicMinor,
    joinedOn: joined,
    asOf: previousMonthEnd(requested),
  });

  // The cumulative curve only rises, but a basic wage cut between two runs could
  // make it fall. A negative accrual would credit the expense of a month the
  // employee did work; the release belongs to the settlement instead.
  const accrual = cumulative > prior ? cumulative - prior : 0n;

  return {
    serviceDays: dayCount(joined, measured),
    cumulativeMinor: cumulative,
    priorMinor: prior,
    accrualMinor: accrual,
  };
}

/* --------------------------------------------------------- the employee row */

export type ContractType = "UNLIMITED" | "LIMITED";

export interface NewEmployee {
  code: string;
  name: string;
  nameAr?: string;
  emiratesId?: string;
  /** The 14-digit MOHRE person identifier. Without it a WPS file cannot be built. */
  molPersonId?: string;
  /** The 9-digit routing code of the employee's bank or exchange house. */
  routingCode?: string;
  iban?: string;
  joinedOn: string;
  contractType?: ContractType;
  basicMinor: number | bigint | string;
  housingMinor?: number | bigint | string;
  transportMinor?: number | bigint | string;
  otherMinor?: number | bigint | string;
  /**
   * Calendar days of annual leave a full year of service earns. Federal
   * Decree-Law 33/2021 Article 29 gives 30; a contract may give more and never
   * less, which is what the database holds.
   */
  leaveDaysPerYear?: number;
  /** ISO country code, where it is known. Recorded for context; decides nothing. */
  nationality?: string;
  /**
   * NONE | GPSSA | GCC_HOME_STATE. The field that decides whether this employee
   * accrues an Article 51 gratuity or contributes to a pension — never both.
   */
  pensionScheme?: PensionScheme;
}


/**
 * A scheme this module knows, or a refusal naming the three.
 *
 * Refused rather than defaulted: a mistyped scheme silently becoming NONE would
 * accrue a gratuity for somebody who should be contributing to a pension, which
 * is the exact error this whole field exists to stop.
 */
function checkScheme(v: string | undefined, who: string): PensionScheme | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toUpperCase();
  if (s === "NONE" || s === "GPSSA" || s === "GCC_HOME_STATE") return s;
  throw new LedgerError(
    `"${v}" is not a pension scheme this ledger knows for ${who}. Use NONE, GPSSA or GCC_HOME_STATE. ` +
      `A UAE national in the private sector is normally GPSSA; a foreign worker is NONE and accrues the ` +
      `Article 51 gratuity instead.`,
  );
}

const UAE_IBAN = /^AE\d{21}$/;
const MOL_PERSON_ID = /^\d{14}$/;
const ROUTING_CODE = /^\d{9}$/;

/** Strip the spaces people paste IBANs with; the bank file cannot carry them. */
const tidy = (v: string | undefined | null) => (v ?? "").replace(/\s+/g, "").trim();

function checkBankDetails(e: { iban?: string; molPersonId?: string; routingCode?: string }, who: string) {
  const iban = tidy(e.iban);
  if (iban && !UAE_IBAN.test(iban)) {
    throw new LedgerError(
      `"${iban}" is not a UAE IBAN for ${who} — it should be AE followed by 21 digits. ` +
        `Salaries under the Wage Protection System can only be paid to a UAE account.`,
    );
  }
  const mol = tidy(e.molPersonId);
  if (mol && !MOL_PERSON_ID.test(mol)) {
    throw new LedgerError(`The MOL person id for ${who} has to be exactly 14 digits; "${mol}" is ${mol.length}.`);
  }
  const routing = tidy(e.routingCode);
  if (routing && !ROUTING_CODE.test(routing)) {
    throw new LedgerError(`The routing code for ${who} has to be exactly 9 digits; "${routing}" is ${routing.length}.`);
  }
  return { iban: iban || null, molPersonId: mol || null, routingCode: routing || null };
}

function checkPay(e: {
  basicMinor: number | bigint | string;
  housingMinor?: number | bigint | string;
  transportMinor?: number | bigint | string;
  otherMinor?: number | bigint | string;
}, who: string) {
  const basic = BigInt(e.basicMinor);
  const housing = BigInt(e.housingMinor ?? 0);
  const transport = BigInt(e.transportMinor ?? 0);
  const other = BigInt(e.otherMinor ?? 0);
  // Gratuity is computed on the basic wage alone, so an employee whose whole
  // package sits in allowances would silently accrue nothing. Refusing the
  // record is better than paying them nothing on the way out.
  if (basic <= 0n) {
    throw new LedgerError(
      `${who} needs a basic salary above zero — end-of-service gratuity is computed on the basic wage only, ` +
        `so a package held entirely in allowances would accrue nothing.`,
    );
  }
  if (housing < 0n || transport < 0n || other < 0n) {
    throw new LedgerError(`${who} has a negative allowance. A deduction is a deduction, not a negative allowance.`);
  }
  return { basic, housing, transport, other };
}

/** Put someone on the payroll. */
/**
 * The leave a contract gives, checked before the database has to.
 *
 * The floor is the law's, not a preference: Article 29 gives 30 calendar days
 * and a contract cannot take them away, so a lower figure is a data-entry
 * mistake and refusing it is more useful than storing it.
 */
function checkLeaveDays(v: number | undefined, who: string): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 30 || v > 365) {
    throw new LedgerError(
      `${who} is given ${v} days of annual leave a year. Federal Decree-Law 33/2021 Article 29 gives 30 calendar ` +
        `days after a year of service, and a contract may improve on that but never reduce it.`,
    );
  }
  return v;
}

export async function addEmployee(opts: { orgId: string; entityId: string; employee: NewEmployee }) {
  const e = opts.employee;
  const code = (e.code ?? "").trim();
  const name = (e.name ?? "").trim();
  if (!code) throw new LedgerError("An employee needs a code — it is what the payslips and the payroll run refer to.");
  if (!name) throw new LedgerError(`Employee ${code} needs a name; the WPS file and the payslip both carry it.`);

  const who = `${name} (${code})`;
  const joined = asDay(e.joinedOn, `The joining date for ${who}`);
  const contractType: ContractType = e.contractType ?? "UNLIMITED";
  if (contractType !== "UNLIMITED" && contractType !== "LIMITED") {
    throw new LedgerError(
      `${who} has contract type "${String(contractType)}". Only UNLIMITED or LIMITED are recorded — ` +
        `Federal Decree-Law 33/2021 converted every unlimited contract to a fixed term, but records ` +
        `predating it still say unlimited and have to stay readable.`,
    );
  }
  const pay = checkPay(e, who);
  const bank = checkBankDetails(e, who);

  const clash = await prisma.employee.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code },
  });
  if (clash) throw new LedgerError(`Employee ${code} is already on the payroll — they are ${clash.name}.`);

  return prisma.employee.create({
    data: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      code,
      name,
      nameAr: e.nameAr?.trim() || null,
      emiratesId: tidy(e.emiratesId) || null,
      molPersonId: bank.molPersonId,
      routingCode: bank.routingCode,
      iban: bank.iban,
      joinedOn: joined,
      contractType,
      basicMinor: pay.basic,
      housingMinor: pay.housing,
      transportMinor: pay.transport,
      otherMinor: pay.other,
      ...(e.leaveDaysPerYear === undefined ? {} : { leaveDaysPerYear: checkLeaveDays(e.leaveDaysPerYear, who)! }),
      nationality: (e.nationality ?? "").trim().toUpperCase() || null,
      ...(checkScheme(e.pensionScheme, who) === undefined ? {} : { pensionScheme: checkScheme(e.pensionScheme, who)! }),
    },
  });
}

export interface EmployeeChanges {
  name?: string;
  nameAr?: string | null;
  emiratesId?: string | null;
  molPersonId?: string | null;
  routingCode?: string | null;
  iban?: string | null;
  joinedOn?: string;
  contractType?: ContractType;
  basicMinor?: number | bigint | string;
  housingMinor?: number | bigint | string;
  transportMinor?: number | bigint | string;
  otherMinor?: number | bigint | string;
  /**
   * Calendar days of annual leave a full year of service earns. Federal
   * Decree-Law 33/2021 Article 29 gives 30; a contract may give more and never
   * less, which is what the database holds.
   */
  leaveDaysPerYear?: number;
  /** ISO country code, where it is known. Recorded for context; decides nothing. */
  nationality?: string;
  /**
   * NONE | GPSSA | GCC_HOME_STATE. The field that decides whether this employee
   * accrues an Article 51 gratuity or contributes to a pension — never both.
   */
  pensionScheme?: PensionScheme;
}

/**
 * Amend an employment record.
 *
 * A pay change is prospective: it changes what the next run computes and leaves
 * every posted payslip exactly as it was, for the same reason a change in
 * accounting estimate does not rewrite last year. The joining date is the one
 * field that cannot move once anything is posted, because gratuity already
 * charged to 6050 was measured from it.
 */
export async function updateEmployee(opts: {
  orgId: string;
  entityId: string;
  employeeCode: string;
  changes: EmployeeChanges;
}) {
  const current = await prisma.employee.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.employeeCode },
  });
  if (!current) throw new LedgerError(`Employee ${opts.employeeCode} is not on the payroll.`);

  const c = opts.changes;
  const name = c.name === undefined ? current.name : c.name.trim();
  if (!name) throw new LedgerError(`Employee ${current.code} cannot be left without a name.`);
  const who = `${name} (${current.code})`;

  const pay = checkPay(
    {
      basicMinor: c.basicMinor ?? current.basicMinor,
      housingMinor: c.housingMinor ?? current.housingMinor,
      transportMinor: c.transportMinor ?? current.transportMinor,
      otherMinor: c.otherMinor ?? current.otherMinor,
    },
    who,
  );
  const bank = checkBankDetails(
    {
      iban: c.iban === undefined ? current.iban ?? undefined : c.iban ?? undefined,
      molPersonId: c.molPersonId === undefined ? current.molPersonId ?? undefined : c.molPersonId ?? undefined,
      routingCode: c.routingCode === undefined ? current.routingCode ?? undefined : c.routingCode ?? undefined,
    },
    who,
  );

  let joinedOn = current.joinedOn;
  if (c.joinedOn !== undefined) {
    const next = asDay(c.joinedOn, `The joining date for ${who}`);
    if (next.getTime() !== current.joinedOn.getTime()) {
      const posted = await prisma.payslip.count({
        where: { orgId: opts.orgId, employeeId: current.id, status: { in: ["posted", "paid"] } },
      });
      if (posted > 0) {
        throw new LedgerError(
          `${who} already has ${posted} posted payslip${posted === 1 ? "" : "s"}, and the gratuity charged on ` +
            `${posted === 1 ? "it" : "them"} was measured from ${iso(current.joinedOn)}. Moving the joining date now ` +
            `would restate an expense that has been posted; reverse the runs first if the date really is wrong.`,
        );
      }
      if (current.leftOn && next > current.leftOn) {
        throw new LedgerError(`${who} cannot join on ${iso(next)} and leave on ${iso(current.leftOn)}.`);
      }
      joinedOn = next;
    }
  }

  return prisma.employee.update({
    where: { id: current.id },
    data: {
      name,
      nameAr: c.nameAr === undefined ? undefined : c.nameAr?.trim() || null,
      emiratesId: c.emiratesId === undefined ? undefined : tidy(c.emiratesId) || null,
      molPersonId: bank.molPersonId,
      routingCode: bank.routingCode,
      iban: bank.iban,
      joinedOn,
      contractType: c.contractType ?? current.contractType,
      basicMinor: pay.basic,
      housingMinor: pay.housing,
      transportMinor: pay.transport,
      otherMinor: pay.other,
      leaveDaysPerYear: checkLeaveDays(c.leaveDaysPerYear, who),
      nationality: c.nationality === undefined ? current.nationality : (c.nationality.trim().toUpperCase() || null),
      pensionScheme: checkScheme(c.pensionScheme, who) ?? current.pensionScheme,
    },
  });
}

/* ------------------------------------------------------------- the monthly run */

export interface PayslipFigures {
  employeeId: string;
  code: string;
  name: string;
  /** Calendar days of the month the person was actually on the payroll. */
  daysOnPayroll: number;
  daysInMonth: number;
  basicMinor: string;
  allowancesMinor: string;
  overtimeMinor: string;
  deductionsMinor: string;
  grossMinor: string;
  netMinor: string;
  gratuityMinor: string;
  status: string;
}

export interface PayrollRunResult {
  period: string;
  employees: number;
  payslips: PayslipFigures[];
  totals: {
    grossMinor: string;
    deductionsMinor: string;
    netMinor: string;
    gratuityMinor: string;
  };
  /** True when the month is already in the ledger and was returned, not re-run. */
  alreadyPosted: boolean;
  entryId: string | null;
  reference: string | null;
  /** Employees left out of the run, and why — silence here hides an unpaid person. */
  skipped: { code: string; reason: string }[];
}

/** Variable pay a caller supplies for the month; there is nothing to derive it from. */
export interface PayrollEntry {
  code: string;
  overtimeMinor?: number | bigint | string;
  deductionsMinor?: number | bigint | string;
}

const payrollKey = (entityId: string, period: string) => `payroll:${entityId}:${period}`;
const paymentKey = (entityId: string, period: string) => `payroll-payment:${entityId}:${period}`;

async function existingEntry(orgId: string, externalKey: string) {
  return prisma.journalEntry.findFirst({
    where: { orgId, externalKey },
    select: { id: true, series: true, number: true },
  });
}

/**
 * What one journal entry actually charged to a set of accounts, in the book's
 * own currency. Used to ask the ledger what it holds rather than assuming it
 * holds what the payslips say — which is the whole difference between a control
 * and a restatement.
 */
async function chargedTo(orgId: string, entryId: string, codes: string[]): Promise<bigint> {
  const lines = await prisma.journalLine.findMany({
    where: { orgId, entryId, account: { code: { in: codes } } },
    select: { functionalAmountMinor: true },
  });
  return lines.reduce((a, l) => a + l.functionalAmountMinor, 0n);
}

function figuresOf(p: {
  employeeId: string;
  basicMinor: bigint;
  allowancesMinor: bigint;
  overtimeMinor: bigint;
  deductionsMinor: bigint;
  netMinor: bigint;
  gratuityMinor: bigint;
  status: string;
}, employee: { code: string; name: string }, days: { onPayroll: number; inMonth: number }): PayslipFigures {
  return {
    employeeId: p.employeeId,
    code: employee.code,
    name: employee.name,
    daysOnPayroll: days.onPayroll,
    daysInMonth: days.inMonth,
    basicMinor: p.basicMinor.toString(),
    allowancesMinor: p.allowancesMinor.toString(),
    overtimeMinor: p.overtimeMinor.toString(),
    deductionsMinor: p.deductionsMinor.toString(),
    grossMinor: (p.basicMinor + p.allowancesMinor + p.overtimeMinor).toString(),
    netMinor: p.netMinor.toString(),
    gratuityMinor: p.gratuityMinor.toString(),
    status: p.status,
  };
}

/**
 * Build or refresh the draft payslips for one month.
 *
 * Idempotent in the way that matters: once the month has been posted the run
 * returns what is already there rather than recomputing it. A posted payslip is
 * the support for a journal that exists, and quietly rebuilding it would leave
 * the ledger describing figures nobody can see any more.
 *
 * A joiner or leaver is pro-rated on calendar days. That is the convention the
 * Labour Law's daily-wage arithmetic implies and, more practically, it is what
 * the "days on payroll" column of the WPS file has to agree with.
 */
export async function runPayroll(opts: {
  orgId: string;
  entityId: string;
  /** YYYY-MM. */
  period: string;
  entries?: PayrollEntry[];
  actorId?: string;
  /**
   * The pension rates in force for this entity. Defaults to the private-sector
   * GPSSA rates documented on GPSSA_DEFAULT_RATES, which are a starting point
   * rather than law this module can vouch for.
   */
  pensionRates?: PensionRates;
}): Promise<PayrollRunResult> {
  const decimal = decimalIn(await bookCurrency(opts.orgId, opts.entityId));
  const period = assertPeriod(opts.period);
  const start = monthStart(period);
  const end = monthEnd(period);
  const daysInMonth = dayCount(start, end) + 1;

  const employees = await prisma.employee.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { code: "asc" },
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  const posted = await existingEntry(opts.orgId, payrollKey(opts.entityId, period));
  if (posted) {
    const rows = await prisma.payslip.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, period },
      orderBy: { createdAt: "asc" },
    });
    const payslips = rows.map((p) => {
      const e = byId.get(p.employeeId);
      const from = e && e.joinedOn > start ? e.joinedOn : start;
      const to = e?.leftOn && e.leftOn < end ? e.leftOn : end;
      return figuresOf(
        p,
        { code: e?.code ?? "?", name: e?.name ?? "Unknown" },
        { onPayroll: Math.min(daysInMonth, Math.max(0, dayCount(from, to) + 1)), inMonth: daysInMonth },
      );
    });
    return {
      period,
      employees: payslips.length,
      payslips,
      totals: totalsOf(rows),
      alreadyPosted: true,
      entryId: posted.id,
      reference: `${posted.series}-${posted.number}`,
      skipped: [{ code: "*", reason: `${period} is already posted as ${posted.series}-${posted.number}; nothing was recomputed` }],
    };
  }

  // Variable pay is keyed by employee code. A code nobody recognises is almost
  // always a typo, and silently dropping it would pay someone the wrong amount.
  const extras = new Map<string, PayrollEntry>();
  for (const entry of opts.entries ?? []) {
    const code = (entry.code ?? "").trim();
    if (!employees.some((e) => e.code === code)) {
      throw new LedgerError(`There is no employee ${code || "(blank)"} on this payroll to apply overtime or a deduction to.`);
    }
    extras.set(code, entry);
  }

  const existingSlips = await prisma.payslip.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, period },
  });
  const slipByEmployee = new Map(existingSlips.map((p) => [p.employeeId, p]));

  const skipped: { code: string; reason: string }[] = [];
  const drafts: {
    employee: (typeof employees)[number];
    daysOnPayroll: number;
    basic: bigint;
    allowances: bigint;
    overtime: bigint;
    deductions: bigint;
    net: bigint;
    gratuity: bigint;
    pension: PensionContribution;
  }[] = [];

  for (const e of employees) {
    const slip = slipByEmployee.get(e.id);
    if (slip && slip.status !== "draft") {
      skipped.push({ code: e.code, reason: `already ${slip.status} for ${period}` });
      continue;
    }
    if (e.joinedOn > end) {
      skipped.push({ code: e.code, reason: `joined on ${iso(e.joinedOn)}, after this period` });
      continue;
    }
    if (e.leftOn && e.leftOn < start) {
      skipped.push({ code: e.code, reason: `left on ${iso(e.leftOn)}, before this period` });
      continue;
    }

    const from = e.joinedOn > start ? e.joinedOn : start;
    const to = e.leftOn && e.leftOn < end ? e.leftOn : end;
    const daysOnPayroll = dayCount(from, to) + 1;

    const full = e.basicMinor;
    const allowancesFull = e.housingMinor + e.transportMinor + e.otherMinor;
    // A whole month is not divided at all — dividing and multiplying by the same
    // number would still lose a fil to truncation for no reason.
    const basic = daysOnPayroll >= daysInMonth ? full : (full * BigInt(daysOnPayroll)) / BigInt(daysInMonth);
    const allowances =
      daysOnPayroll >= daysInMonth ? allowancesFull : (allowancesFull * BigInt(daysOnPayroll)) / BigInt(daysInMonth);

    const extra = extras.get(e.code);
    const overtime = BigInt(extra?.overtimeMinor ?? 0);
    const deductions = BigInt(extra?.deductionsMinor ?? 0);
    if (overtime < 0n) throw new LedgerError(`Overtime for ${e.name} (${e.code}) cannot be negative; record a deduction instead.`);
    if (deductions < 0n) throw new LedgerError(`A deduction for ${e.name} (${e.code}) cannot be negative; record it as overtime or an allowance.`);

    const gross = basic + allowances + overtime;
    if (gross === 0n) {
      skipped.push({ code: e.code, reason: "no pay is recorded against this employee for the month" });
      continue;
    }
    if (deductions > gross) {
      throw new LedgerError(
        `Deductions of ${decimal(deductions)} for ${e.name} (${e.code}) are more than their ${period} pay of ` +
          `${decimal(gross)}. Net pay cannot be negative — recover the balance over more than one month.`,
      );
    }

    const scheme = (e.pensionScheme ?? "NONE") as PensionScheme;

    // Article 51 gives the gratuity to the foreign worker. An employee in a
    // pension scheme is provided for by the scheme, and accruing both would
    // provide for the same service twice.
    const { accrualMinor } = accruesGratuity(scheme)
      ? gratuityAccrual({ basicMinor: e.basicMinor, joinedOn: e.joinedOn, leftOn: e.leftOn }, end)
      : { accrualMinor: 0n };

    /*
     * The contribution salary is the basic wage plus the allowances the
     * contract makes pensionable. Nothing in this schema records which
     * allowances those are, so basic plus housing is taken — the common case —
     * and that is said here rather than presented as the scheme's own
     * definition. Overtime is excluded, which is not a judgement call: it is
     * not part of the wage.
     */
    const pension = pensionContribution({
      scheme,
      contributionSalaryMinor: BigInt(e.basicMinor) + BigInt(e.housingMinor ?? 0n),
      rates: opts.pensionRates,
    });

    drafts.push({
      employee: e,
      daysOnPayroll,
      basic,
      allowances,
      overtime,
      deductions,
      // The employee's share is withheld, so it reduces what reaches their bank
      // and belongs in what the WPS file carries as paid.
      net: gross - deductions - pension.employeeMinor,
      gratuity: accrualMinor,
      pension,
    });
  }

  // A draft left behind by an earlier run for somebody who is now excluded would
  // otherwise be picked up by postPayroll and paid. Refreshing the month means
  // removing it, not ignoring it.
  const keep = new Set(drafts.map((d) => d.employee.id));
  const stale = existingSlips.filter((p) => p.status === "draft" && !keep.has(p.employeeId));
  if (stale.length) {
    await prisma.payslip.deleteMany({ where: { id: { in: stale.map((p) => p.id) } } });
    for (const p of stale) {
      const e = byId.get(p.employeeId);
      skipped.push({ code: e?.code ?? p.employeeId, reason: `a stale draft for ${period} was removed` });
    }
  }

  const saved = [];
  for (const d of drafts) {
    saved.push(
      await prisma.payslip.upsert({
        where: { orgId_employeeId_period: { orgId: opts.orgId, employeeId: d.employee.id, period } },
        create: {
          orgId: opts.orgId,
          entityId: opts.entityId,
          employeeId: d.employee.id,
          period,
          basicMinor: d.basic,
          allowancesMinor: d.allowances,
          overtimeMinor: d.overtime,
          deductionsMinor: d.deductions,
          netMinor: d.net,
          gratuityMinor: d.gratuity,
          pensionEmployeeMinor: d.pension.employeeMinor,
          pensionEmployerMinor: d.pension.employerMinor,
        },
        update: {
          basicMinor: d.basic,
          allowancesMinor: d.allowances,
          overtimeMinor: d.overtime,
          deductionsMinor: d.deductions,
          netMinor: d.net,
          gratuityMinor: d.gratuity,
          pensionEmployeeMinor: d.pension.employeeMinor,
          pensionEmployerMinor: d.pension.employerMinor,
        },
      }),
    );
  }

  return {
    period,
    employees: saved.length,
    payslips: saved.map((p, i) =>
      figuresOf(p, drafts[i].employee, { onPayroll: drafts[i].daysOnPayroll, inMonth: daysInMonth }),
    ),
    totals: totalsOf(saved),
    alreadyPosted: false,
    entryId: null,
    reference: null,
    skipped,
  };
}

function totalsOf(rows: { basicMinor: bigint; allowancesMinor: bigint; overtimeMinor: bigint; deductionsMinor: bigint; netMinor: bigint; gratuityMinor: bigint }[]) {
  const gross = rows.reduce((a, p) => a + p.basicMinor + p.allowancesMinor + p.overtimeMinor, 0n);
  const deductions = rows.reduce((a, p) => a + p.deductionsMinor, 0n);
  const net = rows.reduce((a, p) => a + p.netMinor, 0n);
  const gratuity = rows.reduce((a, p) => a + p.gratuityMinor, 0n);
  return {
    grossMinor: gross.toString(),
    deductionsMinor: deductions.toString(),
    netMinor: net.toString(),
    gratuityMinor: gratuity.toString(),
  };
}

/* ------------------------------------------------------------- posting the run */

export interface PostPayrollResult {
  period: string;
  entryId: string;
  reference: string;
  alreadyPosted: boolean;
  /**
   * True where this entry is a second journal for a month already posted,
   * raised for payslips that reached draft after the first one. The figures
   * below are that entry's, not the month's — the month is `payrollSummary`.
   */
  supplementary: boolean;
  payslips: number;
  grossMinor: string;
  deductionsMinor: string;
  netMinor: string;
  gratuityMinor: string;
}

/**
 * Post the month's payroll — one journal for the run, and one more for anything
 * that reaches draft after it.
 *
 *   Dr  6000  Salaries and wages          gross — the cost of employing people
 *   Dr  6050  End-of-service benefits     the gratuity this month earned
 *     Cr  2200  Salaries payable            net — what the employees are owed
 *     Cr  2250  EOSB provision              the gratuity, held until they leave
 *     Cr  1400  Employee advances           whatever was recovered by deduction
 *
 * The expense is gross because gross is what employing somebody costs; the
 * deduction is not a smaller cost, it is a debt the employee repaid out of it.
 * That is why 2200 receives net rather than gross and the difference has to land
 * somewhere real.
 */
export async function postPayroll(opts: {
  orgId: string;
  entityId: string;
  period: string;
  postingDate?: string;
  deductionAccount?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<PostPayrollResult> {
  const decimal = decimalIn(await bookCurrency(opts.orgId, opts.entityId));
  const period = assertPeriod(opts.period);
  const monthKey = payrollKey(opts.entityId, period);

  const month = await existingEntry(opts.orgId, monthKey);

  /*
   * Only a payslip the ledger has not received is waiting to be posted, and the
   * month's first journal is no longer treated as the end of the matter.
   *
   * It used to be: an entry under the month's key meant the month was done, and
   * the totals reported back were taken from every payslip carrying that month
   * — drafts included. So a payslip that reached draft after the run was posted
   * was stranded twice over. The figure quoted back included an employee the
   * ledger had never heard of, and `payPayroll` pays a posted payslip and
   * nothing else, so that person was never paid. Salaries payable was
   * understated by their net pay and nothing anywhere said so: the journal that
   * existed balanced, and the trial balance tied on it.
   */
  const drafts = await prisma.payslip.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, period, status: "draft" },
    orderBy: { id: "asc" },
  });

  if (month && drafts.length === 0) {
    // The month is on the books and nothing is outstanding. What is reported is
    // what actually reached the ledger, which is what "already posted" means.
    const reached = await prisma.payslip.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, period, status: { in: ["posted", "paid"] } },
    });
    return {
      period,
      entryId: month.id,
      reference: `${month.series}-${month.number}`,
      alreadyPosted: true,
      supplementary: false,
      payslips: reached.length,
      ...totalsOf(reached),
    };
  }

  if (drafts.length === 0) {
    throw new LedgerError(`There are no draft payslips for ${period}. Run the payroll for that month before posting it.`);
  }

  const gross = drafts.reduce((a, p) => a + p.basicMinor + p.allowancesMinor + p.overtimeMinor, 0n);
  const deductions = drafts.reduce((a, p) => a + p.deductionsMinor, 0n);
  const net = drafts.reduce((a, p) => a + p.netMinor, 0n);
  const gratuity = drafts.reduce((a, p) => a + p.gratuityMinor, 0n);
  const pensionEmployee = drafts.reduce((a, p) => a + p.pensionEmployeeMinor, 0n);
  const pensionEmployer = drafts.reduce((a, p) => a + p.pensionEmployerMinor, 0n);

  /*
   * A posted month with drafts still against it happened one of two ways, and
   * they need opposite answers, so they are told apart before anything is
   * written.
   *
   * If not one payslip in the month names that entry, the run was cut off
   * between `post()` committing and the payslips being marked: the journal is
   * on the books and the register does not know it. The drafts in hand are then
   * the ones the entry was raised from — and the way to be sure is to ask the
   * entry what it charged. Where the two agree, the link is repaired and
   * nothing further is posted; the cost is already in the ledger, and the
   * payslips have to say so or the month can never be paid.
   *
   * Where they do not agree, something has happened this function cannot name —
   * a late payslip on top of an interrupted run is the likely one — and it says
   * so instead of guessing which of the drafts the entry already covers.
   */
  if (month) {
    const linked = await prisma.payslip.count({
      where: { orgId: opts.orgId, entityId: opts.entityId, period, entryId: month.id },
    });
    if (linked === 0) {
      const charged = await chargedTo(opts.orgId, month.id, [SALARY_EXPENSE, EOSB_EXPENSE]);
      const outstanding = gross + pensionEmployer + gratuity;
      if (charged !== outstanding) {
        throw new LedgerError(
          `${period} is posted as ${month.series}-${month.number}, which charged ${decimal(charged)} to salaries and ` +
            `end of service, but no payslip for the month is linked to it and the ${drafts.length} still in draft come ` +
            `to ${decimal(outstanding)}. The run was interrupted between the journal and the payslips, and the two no ` +
            `longer describe the same month — reconcile them against ${month.series}-${month.number} before anything ` +
            `else is posted for ${period}.`,
        );
      }
      await prisma.payslip.updateMany({
        where: { id: { in: drafts.map((p) => p.id) } },
        data: { status: "posted", entryId: month.id },
      });
      return {
        period,
        entryId: month.id,
        reference: `${month.series}-${month.number}`,
        alreadyPosted: true,
        supplementary: false,
        payslips: drafts.length,
        ...totalsOf(drafts),
      };
    }
  }

  const lines: PostLine[] = [];
  if (gross > 0n) lines.push({ account: SALARY_EXPENSE, debit: gross, memo: `Payroll ${period} — ${drafts.length} employee${drafts.length === 1 ? "" : "s"}` });
  if (gratuity > 0n) lines.push({ account: EOSB_EXPENSE, debit: gratuity, memo: `Gratuity accrued for ${period}` });
  /*
   * The employer's share is a cost of employing somebody and is charged; the
   * employee's is withheld out of the gross already charged above, so it is
   * moved from net pay to the authority rather than charged again. Both are
   * owed to the same authority and settle as one payment, so both credit 2230.
   */
  if (pensionEmployer > 0n) {
    lines.push({ account: SALARY_EXPENSE, debit: pensionEmployer, memo: `Employer pension contributions for ${period}` });
  }
  if (net > 0n) lines.push({ account: SALARY_PAYABLE, credit: net, memo: `Net pay for ${period}` });
  if (pensionEmployee + pensionEmployer > 0n) {
    lines.push({
      account: PENSION_PAYABLE,
      credit: pensionEmployee + pensionEmployer,
      memo: `Pension contributions for ${period} — ${decimal(pensionEmployee)} withheld, ${decimal(pensionEmployer)} employer`,
    });
  }
  if (gratuity > 0n) lines.push({ account: EOSB_PROVISION, credit: gratuity, memo: `Gratuity provision for ${period}` });
  if (deductions > 0n) {
    lines.push({
      account: opts.deductionAccount ?? EMPLOYEE_ADVANCES,
      credit: deductions,
      memo: `Deductions recovered in ${period}`,
    });
  }

  /*
   * What is being posted, and under which key.
   *
   * The month's first journal keeps the month's own key, which is what every
   * other reader of a posted month looks it up by. A payslip that reaches draft
   * after that gets a journal of its own, keyed on the last of the drafts it
   * covers — the same derivation `reimburse()` uses for the same reason. A
   * retry finds the same set of drafts, computes the same key and is handed the
   * entry it already posted; once those payslips are marked, they are out of
   * the set and the key of the next supplement is a different one.
   */
  const supplementary = Boolean(month);
  const externalKey = month ? `${monthKey}:${drafts[drafts.length - 1].id}` : monthKey;
  const already = supplementary ? await existingEntry(opts.orgId, externalKey) : null;

  /*
   * The organisation's own approval rules, before a payslip becomes a payment.
   *
   * PAYROLL is one of the five subjects `approvals.ts` takes rules for, and it
   * was the last posting path not asking. A rule saying "payroll needs a
   * director" appeared on the approvals screen, showed in the queue, and bound
   * on nothing.
   *
   * The subject id is the period, which is what `sourceId` and the idempotency
   * key already use — so a signature is given for March's payroll and covers
   * March's payroll, not the next month's. The amount is the GROSS cost of
   * what is being posted, employer pension included: that is the figure an
   * approval limit is written against, and net pay would understate it by every
   * deduction withheld. A supplement is asked about separately and at its own
   * size, because it is a further charge and nobody signed for it.
   *
   * This is skipped only where the entry already exists, so re-posting hands
   * back the original. A rule written today cannot turn last month's harmless
   * retry into a refusal.
   */
  if (!already) {
    await assertApproved({
      orgId: opts.orgId,
      entityId: opts.entityId,
      subjectType: "PAYROLL",
      subjectId: period,
      amountMinor: gross + gratuity + pensionEmployer,
      reference: period,
      currency: await bookCurrency(opts.orgId, opts.entityId),
    });
  }

  // Payroll is a period-end measurement of a whole month, so it lands on the
  // last day of that month unless a caller has a reason to date it otherwise.
  const entryDate = opts.postingDate ?? iso(monthEnd(period));

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate,
    memo: supplementary
      ? `Payroll for ${period} — ${drafts.length} payslip${drafts.length === 1 ? "" : "s"} posted after the month's run`
      : `Payroll for ${period}`,
    source: "payroll",
    sourceType: "PAYROLL_RUN",
    sourceId: period,
    externalKey,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "PR",
    lines,
  });

  // Only once the journal has committed. The other order would leave payslips
  // marked posted with nothing behind them in the books.
  await prisma.payslip.updateMany({
    where: { id: { in: drafts.map((p) => p.id) } },
    data: { status: "posted", entryId: entry.id },
  });

  return {
    period,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPosted: Boolean(already),
    supplementary,
    payslips: drafts.length,
    grossMinor: gross.toString(),
    deductionsMinor: deductions.toString(),
    netMinor: net.toString(),
    gratuityMinor: gratuity.toString(),
  };
}

/* ----------------------------------------------------------------- paying it */

export interface PayPayrollResult {
  period: string;
  entryId: string;
  reference: string;
  alreadyPaid: boolean;
  /** True where this transfer settles payslips posted after the month was paid. */
  supplementary: boolean;
  payslips: number;
  paidMinor: string;
}

/**
 * Discharge the month's salaries.
 *
 *   Dr  2200  Salaries payable   what is no longer owed
 *     Cr  1010  Bank               what left the account
 *
 * Separate from posting because they are separate events: the liability arises
 * when the month is worked, and it is settled when the transfer clears. Under
 * the Wage Protection System the transfer is also the thing MOHRE watches, so
 * conflating the two would lose the date that matters.
 */
export async function payPayroll(opts: {
  orgId: string;
  entityId: string;
  period: string;
  paidOn?: string;
  bankAccount?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<PayPayrollResult> {
  const period = assertPeriod(opts.period);
  const monthKey = paymentKey(opts.entityId, period);

  const month = await existingEntry(opts.orgId, monthKey);

  const posted = await prisma.payslip.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, period, status: "posted" },
    orderBy: { id: "asc" },
  });

  if (month && posted.length === 0) {
    const paid = await prisma.payslip.findMany({ where: { orgId: opts.orgId, entityId: opts.entityId, period, status: "paid" } });
    return {
      period,
      entryId: month.id,
      reference: `${month.series}-${month.number}`,
      alreadyPaid: true,
      supplementary: false,
      payslips: paid.length,
      paidMinor: paid.reduce((a, p) => a + p.netMinor, 0n).toString(),
    };
  }

  if (posted.length === 0) {
    throw new LedgerError(`No posted payroll for ${period} is waiting to be paid. Post the month before paying it.`);
  }

  const net = posted.reduce((a, p) => a + p.netMinor, 0n);
  if (net <= 0n) throw new LedgerError(`The net pay for ${period} is zero, so there is nothing to transfer.`);

  /*
   * A month already paid, with payslips still waiting on it. Two ways again,
   * and here the two answers are "move money" and "do not", so the ambiguity
   * has to fall the safe way.
   *
   * Where the month's transfer already discharged exactly what is outstanding,
   * this is the same run reaching the bank and then dying before the payslips
   * were marked: the money has gone, and repeating it would send it twice. The
   * payslips are marked and nothing is posted.
   *
   * Otherwise these are payslips posted after the month was paid — a
   * supplementary run from `postPayroll` — and they are transferred on their
   * own entry. The one case this reads wrongly is a late payslip whose net
   * happens to equal the whole of the first transfer, and it reads it as money
   * already sent, which is the direction that cannot overpay anybody.
   * `payrollSummary` shows it, because 2200 then holds a net no posted payslip
   * accounts for.
   */
  if (month && (await chargedTo(opts.orgId, month.id, [SALARY_PAYABLE])) === net) {
    await prisma.payslip.updateMany({ where: { id: { in: posted.map((p) => p.id) } }, data: { status: "paid" } });
    return {
      period,
      entryId: month.id,
      reference: `${month.series}-${month.number}`,
      alreadyPaid: true,
      supplementary: false,
      payslips: posted.length,
      paidMinor: net.toString(),
    };
  }

  const supplementary = Boolean(month);
  const externalKey = month ? `${monthKey}:${posted[posted.length - 1].id}` : monthKey;
  const already = supplementary ? await existingEntry(opts.orgId, externalKey) : null;

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: opts.paidOn ?? iso(monthEnd(period)),
    memo: supplementary
      ? `Salaries paid for ${period} — ${posted.length} payslip${posted.length === 1 ? "" : "s"} posted after the month's transfer`
      : `Salaries paid for ${period}`,
    source: "payroll",
    sourceType: "PAYROLL_PAYMENT",
    sourceId: period,
    externalKey,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "PP",
    lines: [
      { account: SALARY_PAYABLE, debit: net, memo: `Salaries for ${period}` },
      { account: opts.bankAccount ?? BANK, credit: net, memo: `WPS transfer for ${period}` },
    ],
  });

  await prisma.payslip.updateMany({ where: { id: { in: posted.map((p) => p.id) } }, data: { status: "paid" } });

  return {
    period,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPaid: Boolean(already),
    supplementary,
    payslips: posted.length,
    paidMinor: net.toString(),
  };
}

/* -------------------------------------------------------- end of service */

export interface SettlementResult {
  employeeCode: string;
  leftOn: string;
  serviceDays: number;
  /** What Article 51 says is owed, measured to the leaving date. */
  entitlementMinor: string;
  /** What had been provided for on 2250 out of the monthly accruals. */
  provisionHeldMinor: string;
  /** Entitlement less provision: positive is a top-up, negative a release. */
  differenceMinor: string;
  entryId: string | null;
  reference: string | null;
}

/**
 * Settle an employee's end-of-service gratuity and take them off the payroll.
 *
 *   Dr  2250  EOSB provision   everything held for this person
 *   Dr  6050  EOSB expense     the shortfall, if the accrual under-provided
 *     Cr  6050  EOSB expense     the release, if it over-provided
 *     Cr  1010  Bank             the entitlement, paid out
 *
 * The provision is cleared in full rather than to the entitlement, because the
 * balance on 2250 is meant to be the sum of what everyone still employed would
 * be owed. Leaving a stub behind for somebody who has gone would make that
 * untrue, and it is the statement `payrollSummary` checks.
 *
 * Article 53 requires the settlement within fourteen days of termination, which
 * is why the default credit is the bank and not the payables account: the
 * ordinary case is money that leaves, not a balance that waits.
 */
export async function settleEndOfService(opts: {
  orgId: string;
  entityId: string;
  employeeCode: string;
  leftOn: string;
  /** Where the settlement is paid from, or 2200 to leave it with the next run. */
  settlementAccount?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<SettlementResult> {
  const employee = await prisma.employee.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.employeeCode },
  });
  if (!employee) throw new LedgerError(`Employee ${opts.employeeCode} is not on the payroll.`);
  if (employee.status !== "active") {
    throw new LedgerError(
      `${employee.name} (${employee.code}) already left on ${employee.leftOn ? iso(employee.leftOn) : "an earlier date"}; ` +
        `an end-of-service settlement is made once.`,
    );
  }

  const leftOn = asDay(opts.leftOn, `The leaving date for ${employee.name} (${employee.code})`);
  if (leftOn < employee.joinedOn) {
    throw new LedgerError(
      `${employee.name} (${employee.code}) joined on ${iso(employee.joinedOn)} and cannot leave on ${iso(leftOn)}.`,
    );
  }

  const entitlement = gratuityEntitlement({ basicMinor: employee.basicMinor, joinedOn: employee.joinedOn, asOf: leftOn });

  // Only posted accruals reached 2250. A draft payslip is a proposal; releasing
  // a provision that was never made would credit an expense nobody charged.
  const accrued = await prisma.payslip.findMany({
    where: { orgId: opts.orgId, employeeId: employee.id, status: { in: ["posted", "paid"] } },
    select: { gratuityMinor: true },
  });
  const held = accrued.reduce((a, p) => a + p.gratuityMinor, 0n);
  const difference = entitlement - held;

  const lines: PostLine[] = [];
  if (held > 0n) lines.push({ account: EOSB_PROVISION, debit: held, memo: `Provision released — ${employee.code}` });
  if (difference > 0n) lines.push({ account: EOSB_EXPENSE, debit: difference, memo: `Gratuity under-provided — ${employee.code}` });
  if (difference < 0n) lines.push({ account: EOSB_EXPENSE, credit: -difference, memo: `Gratuity over-provided — ${employee.code}` });
  if (entitlement > 0n) {
    lines.push({
      account: opts.settlementAccount ?? BANK,
      credit: entitlement,
      memo: `End-of-service settlement — ${employee.name}`,
    });
  }

  let entryId: string | null = null;
  let reference: string | null = null;
  // Someone who leaves inside their first year is owed nothing and had nothing
  // provided. There is no entry to post, and inventing a balanced pair of zero
  // lines to have something to show would be a lie about the books.
  if (lines.length > 0) {
    const entry = await post({
      orgId: opts.orgId,
      entityId: opts.entityId,
      entryDate: iso(leftOn),
      memo: `End of service — ${employee.name} (${employee.code})`,
      source: "payroll",
      sourceType: "EOSB_SETTLEMENT",
      sourceId: employee.id,
      externalKey: `eosb:${employee.id}`,
      actorType: opts.actorType ?? "HUMAN",
      actorId: opts.actorId,
      series: "PR",
      lines,
    });
    entryId = entry.id;
    reference = `${entry.series}-${entry.number}`;
  }

  // status and leftOn move together — the database enforces that one implies
  // the other, and it is the same fact stated twice.
  await prisma.employee.update({
    where: { id: employee.id },
    data: { status: "left", leftOn },
  });

  return {
    employeeCode: employee.code,
    leftOn: iso(leftOn),
    serviceDays: dayCount(employee.joinedOn, leftOn),
    entitlementMinor: entitlement.toString(),
    provisionHeldMinor: held.toString(),
    differenceMinor: difference.toString(),
    entryId,
    reference,
  };
}

/* ------------------------------------------------------------- the WPS file */

export interface WpsFile {
  period: string;
  filename: string;
  /** Number of EDR records, which is what the SCR trailer declares. */
  records: number;
  totalMinor: string;
  csv: string;
}

/**
 * The UAE Wage Protection System Salary Information File.
 *
 * The SIF is a flat CSV a bank uploads on the employer's behalf: one EDR
 * (Employee Detail Record) per person, then a single SCR (Salary Control
 * Record) trailer the bank reconciles the batch against.
 *
 *   EDR, MOL person id, employee routing code, IBAN, pay start, pay end,
 *        days on payroll, fixed pay, variable pay
 *   SCR, MOL establishment id, employer routing code, created on, created at,
 *        salary month, record count, total salary, currency
 *
 * A bank rejects the *whole file* for one malformed record, so every missing
 * identifier is collected and named at once. Reporting them one per attempt
 * would cost a round trip through the bank for each employee.
 *
 * Fixed and variable have to add up to what is actually transferred, or the
 * batch will not reconcile against the SCR total — so a deduction is taken out
 * of the variable component first, and only then out of the fixed one.
 */
export async function wpsFile(opts: {
  orgId: string;
  entityId: string;
  period: string;
  /** The employer's MOHRE establishment identifier, 13 digits. */
  employerId?: string;
  /** The routing code of the employer's own bank, 9 digits. */
  employerAgentId?: string;
  /** Fixed for tests; the file records when it was produced. */
  createdAt?: Date;
}): Promise<WpsFile> {
  const period = assertPeriod(opts.period, "A salary month");

  const employerId = tidy(opts.employerId);
  const employerAgentId = tidy(opts.employerAgentId);
  if (!/^\d{13}$/.test(employerId)) {
    throw new LedgerError(
      `The salary file needs the employer's 13-digit MOHRE establishment id${employerId ? `, not "${employerId}"` : ""}. ` +
        `It is the number on the establishment card.`,
    );
  }
  if (!ROUTING_CODE.test(employerAgentId)) {
    throw new LedgerError(
      `The salary file needs the 9-digit routing code of the employer's own bank${employerAgentId ? `, not "${employerAgentId}"` : ""}.`,
    );
  }

  const payslips = await prisma.payslip.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, period },
    include: { employee: true },
    orderBy: { employee: { code: "asc" } },
  });
  if (payslips.length === 0) {
    throw new LedgerError(`There is no payroll for ${period} to build a salary file from. Run the month first.`);
  }

  const missing: string[] = [];
  for (const p of payslips) {
    const e = p.employee;
    const gaps: string[] = [];
    if (!tidy(e.molPersonId)) gaps.push("no MOL person id");
    if (!tidy(e.routingCode)) gaps.push("no routing code");
    if (!tidy(e.iban)) gaps.push("no IBAN");
    if (gaps.length) missing.push(`${e.name} (${e.code}) has ${gaps.join(" and ")}`);
  }
  if (missing.length) {
    throw new LedgerError(
      `The ${period} salary file cannot be built: ${missing.join("; ")}. ` +
        `A bank rejects the whole file for one incomplete record, so fix all of these before generating it.`,
    );
  }

  const start = monthStart(period);
  const end = monthEnd(period);
  const daysInMonth = dayCount(start, end) + 1;

  let total = 0n;
  const rows: string[] = [];
  for (const p of payslips) {
    const e = p.employee;
    const from = e.joinedOn > start ? e.joinedOn : start;
    const to = e.leftOn && e.leftOn < end ? e.leftOn : end;
    const daysOnPayroll = Math.min(daysInMonth, Math.max(0, dayCount(from, to) + 1));

    let fixed = p.basicMinor + p.allowancesMinor;
    let variable = p.overtimeMinor;
    let outstanding = p.deductionsMinor;
    const fromVariable = outstanding < variable ? outstanding : variable;
    variable -= fromVariable;
    outstanding -= fromVariable;
    fixed -= outstanding;

    total += fixed + variable;
    rows.push(
      [
        "EDR",
        tidy(e.molPersonId),
        tidy(e.routingCode),
        tidy(e.iban),
        iso(from),
        iso(to),
        String(daysOnPayroll),
        sifAmount(fixed),
        sifAmount(variable),
      ].join(","),
    );
  }

  const created = opts.createdAt ?? new Date();
  const createdOn = created.toISOString().slice(0, 10);
  const createdAt = created.toISOString().slice(11, 16);

  rows.push(
    [
      "SCR",
      employerId,
      employerAgentId,
      createdOn,
      createdAt,
      period,
      String(payslips.length),
      sifAmount(total),
      "AED",
    ].join(","),
  );

  return {
    period,
    filename: `SIF_${employerId}_${period.replace("-", "")}.csv`,
    records: payslips.length,
    totalMinor: total.toString(),
    // A trailing newline: some bank uploaders drop a final record without one.
    csv: `${rows.join("\n")}\n`,
  };
}

/* ------------------------------------------------------------- the summary */

export interface PayrollSummary {
  period: string;
  payslips: PayslipFigures[];
  totals: { grossMinor: string; deductionsMinor: string; netMinor: string; gratuityMinor: string };
  employees: {
    code: string;
    name: string;
    joinedOn: string;
    leftOn: string | null;
    contractType: string;
    basicMinor: string;
    allowancesMinor: string;
    status: string;
    /** What this person would be owed today if they walked out. */
    gratuityToDateMinor: string;
    wpsReady: boolean;
  }[];
  /** What the payslips themselves say, on the same three measures as `ledger`. */
  register: {
    /** Gross of the payslips posted for this month. */
    salariesMinor: string;
    /** Net of every payslip posted and not yet paid, whatever the period. */
    payableMinor: string;
    /** Gratuity accrued for everyone still employed. */
    provisionMinor: string;
  };
  ledger: {
    /** Debits to 6000 dated inside this month. */
    salariesMinor: string;
    /** The whole 2200 balance — salaries owed and not yet transferred. */
    payableMinor: string;
    /** The whole 2250 balance — gratuity held for people still employed. */
    provisionMinor: string;
    salariesAgree: boolean;
    payableAgrees: boolean;
    provisionAgrees: boolean;
    agrees: boolean;
  };
}

/**
 * The payslips, and what the ledger says about them.
 *
 * Three comparisons, each of which is a real statement that can be false:
 *
 *   6000 charged this month  === gross of the payslips posted for this month
 *   2200 balance             === net of every payslip posted and not yet paid
 *   2250 balance             === gratuity accrued for everyone still employed
 *
 * Only posted payslips take part. A draft has not claimed to be in the ledger,
 * so counting it would manufacture a disagreement out of unfinished work.
 *
 * The 2250 comparison is exact because a settlement clears one person's whole
 * provision and then takes them off the active list — the two sides fall away
 * together. A settlement routed to 2200 instead of the bank is the one case the
 * payable comparison will show as differing until the next payment run clears it.
 */
export async function payrollSummary(opts: {
  orgId: string;
  entityId: string;
  period: string;
}): Promise<PayrollSummary> {
  const period = assertPeriod(opts.period);
  const start = monthStart(period);
  const end = monthEnd(period);
  const daysInMonth = dayCount(start, end) + 1;

  const employees = await prisma.employee.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: [{ status: "asc" }, { code: "asc" }],
  });
  const byId = new Map(employees.map((e) => [e.id, e]));

  const slips = await prisma.payslip.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, period },
  });
  slips.sort((a, b) => (byId.get(a.employeeId)?.code ?? "").localeCompare(byId.get(b.employeeId)?.code ?? ""));

  const payslips = slips.map((p) => {
    const e = byId.get(p.employeeId);
    const from = e && e.joinedOn > start ? e.joinedOn : start;
    const to = e?.leftOn && e.leftOn < end ? e.leftOn : end;
    return figuresOf(
      p,
      { code: e?.code ?? "?", name: e?.name ?? "Unknown" },
      { onPayroll: Math.min(daysInMonth, Math.max(0, dayCount(from, to) + 1)), inMonth: daysInMonth },
    );
  });

  // ── the register side ──────────────────────────────────────────────────
  const grossPosted = slips
    .filter((p) => p.status !== "draft")
    .reduce((a, p) => a + p.basicMinor + p.allowancesMinor + p.overtimeMinor, 0n);

  const unpaid = await prisma.payslip.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: "posted" },
    select: { netMinor: true },
  });
  const owed = unpaid.reduce((a, p) => a + p.netMinor, 0n);

  const activeIds = employees.filter((e) => e.status === "active").map((e) => e.id);
  const accruals = activeIds.length
    ? await prisma.payslip.findMany({
        where: { orgId: opts.orgId, employeeId: { in: activeIds }, status: { in: ["posted", "paid"] } },
        select: { gratuityMinor: true },
      })
    : [];
  const provided = accruals.reduce((a, p) => a + p.gratuityMinor, 0n);

  // ── the ledger side ────────────────────────────────────────────────────
  const accounts = await prisma.account.findMany({
    where: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      code: { in: [SALARY_EXPENSE, SALARY_PAYABLE, EOSB_PROVISION] },
    },
    select: { id: true, code: true },
  });
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]));

  const inMonth = accounts.length
    ? await prisma.journalLine.findMany({
        where: {
          orgId: opts.orgId,
          accountId: { in: accounts.map((a) => a.id) },
          entry: { status: { in: ["posted", "reversed"] }, entryDate: { gte: start, lte: end } },
        },
        select: { accountId: true, functionalAmountMinor: true },
      })
    : [];
  const allTime = accounts.length
    ? await prisma.journalLine.findMany({
        where: {
          orgId: opts.orgId,
          accountId: { in: accounts.map((a) => a.id) },
          entry: { status: { in: ["posted", "reversed"] } },
        },
        select: { accountId: true, functionalAmountMinor: true },
      })
    : [];

  let salaries = 0n;
  for (const l of inMonth) if (codeOf.get(l.accountId) === SALARY_EXPENSE) salaries += l.functionalAmountMinor;
  let payable = 0n;
  let provision = 0n;
  for (const l of allTime) {
    const code = codeOf.get(l.accountId);
    // Liabilities are held negative in the ledger; the report shows what is owed.
    if (code === SALARY_PAYABLE) payable += -l.functionalAmountMinor;
    if (code === EOSB_PROVISION) provision += -l.functionalAmountMinor;
  }

  const salariesAgree = salaries === grossPosted;
  const payableAgrees = payable === owed;
  const provisionAgrees = provision === provided;

  return {
    period,
    payslips,
    totals: totalsOf(slips),
    employees: employees.map((e) => ({
      code: e.code,
      name: e.name,
      joinedOn: iso(e.joinedOn),
      leftOn: e.leftOn ? iso(e.leftOn) : null,
      contractType: e.contractType,
      basicMinor: e.basicMinor.toString(),
      allowancesMinor: (e.housingMinor + e.transportMinor + e.otherMinor).toString(),
      status: e.status,
      gratuityToDateMinor: gratuityEntitlement({
        basicMinor: e.basicMinor,
        joinedOn: e.joinedOn,
        asOf: e.leftOn ?? end,
      }).toString(),
      wpsReady: Boolean(tidy(e.molPersonId) && tidy(e.routingCode) && tidy(e.iban)),
    })),
    register: {
      salariesMinor: grossPosted.toString(),
      payableMinor: owed.toString(),
      provisionMinor: provided.toString(),
    },
    ledger: {
      salariesMinor: salaries.toString(),
      payableMinor: payable.toString(),
      provisionMinor: provision.toString(),
      salariesAgree,
      payableAgrees,
      provisionAgrees,
      agrees: salariesAgree && payableAgrees && provisionAgrees,
    },
  };
}
