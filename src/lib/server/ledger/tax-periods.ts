import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";

/**
 * The tax period a registration actually has, rather than the one a calendar
 * implies.
 *
 * The FTA assigns a tax period when it registers a taxable person, and it does
 * not assign the same one to everybody. Article 62 of the Executive Regulation
 * sets a standard period of three calendar months ending on the date the
 * Authority determines, one month for taxable persons it decides on, and lets
 * it vary the period for a particular person. In practice a quarterly
 * registrant is put on one of three staggers — Jan/Apr/Jul/Oct, Feb/May/Aug/Nov
 * or Mar/Jun/Sep/Dec — and told which on the registration certificate.
 *
 * Before this module the product had nowhere to record that, and three separate
 * places inferred a calendar quarter from `Math.floor(month / 3)`. For a
 * business on the February stagger every one of those inferences was wrong by a
 * month at both ends and the deadline it computed was a month late; for a
 * monthly filer it produced one reminder per three returns. An inference that
 * is right for two registrants in three is worse than no answer at all, because
 * it is stated with the same confidence either way.
 *
 * So: the registration is recorded, the periods are derived from it, and an
 * entity with no registration recorded gets no derived period — which is every
 * entity that existed before this, and none of them is told anything new.
 *
 * This records that a return was filed. It does not file one: nothing here
 * talks to EmaraTax.
 */

export type TaxRegime = "VAT" | "CORPORATE_TAX" | "EXCISE";
export type TaxFrequency = "MONTHLY" | "QUARTERLY" | "ANNUAL";

const REGIMES: TaxRegime[] = ["VAT", "CORPORATE_TAX", "EXCISE"];
const FREQUENCIES: TaxFrequency[] = ["MONTHLY", "QUARTERLY", "ANNUAL"];

/** How many calendar months one period of each frequency covers. */
const MONTHS_IN_PERIOD: Record<TaxFrequency, number> = { MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 };

/**
 * Article 64 of the Executive Regulation: a return is due, and the tax on it
 * payable, no later than the 28th day following the end of the tax period.
 *
 * Every tax period here ends on the last day of a month, so "28 days after the
 * end" and "the 28th of the following month" are the same date — including in a
 * leap year, where 29 February plus 28 days is 28 March. Adding the days is the
 * form the article is written in, so it is the form used.
 */
export const FILING_DAYS_AFTER_PERIOD_END = 28;

const DAY_MS = 86_400_000;

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/* ------------------------------------------------------ dates, in whole months */

/**
 * Months are counted as one running number so that a period can be stepped
 * forward without any wrapping arithmetic at a year end — the place this kind
 * of code goes wrong. Index 0 is January of year 0; `monthOf` is 1..12.
 */
const monthIndexOf = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
const yearOf = (idx: number) => Math.floor(idx / 12);
const monthOf = (idx: number) => (idx % 12) + 1;
const firstDayOf = (idx: number) => new Date(Date.UTC(yearOf(idx), monthOf(idx) - 1, 1));
/** Day 0 of the next month is the last day of this one, leap years included. */
const lastDayOf = (idx: number) => new Date(Date.UTC(yearOf(idx), monthOf(idx), 0));

const iso = (d: Date) => d.toISOString().slice(0, 10);

function parseDate(value: Date | string, what: string): Date {
  const d = typeof value === "string" ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : value;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date this ledger can read.`);
  return d;
}

/** The due date for a period ending on `periodEnd`. Article 64. */
export function dueDateFor(periodEnd: Date | string): string {
  const end = parseDate(periodEnd, "A tax period end");
  return iso(new Date(end.getTime() + FILING_DAYS_AFTER_PERIOD_END * DAY_MS));
}

/* --------------------------------------------------------------- the periods */

/** What a registration needs to say for its periods to be derivable. */
export interface PeriodRule {
  frequency: TaxFrequency;
  /** The month the stagger's first period ends, 1..12. Feb/May/Aug/Nov is 2. */
  firstPeriodEndMonth: number;
}

export interface TaxPeriod {
  /** The period as the return carries it — and the key a filing is recorded under. */
  label: string;
  /** Inclusive ISO dates. */
  from: string;
  to: string;
  /** The 28th day after the end of it (Article 64). */
  dueOn: string;
}

function assertRule(rule: PeriodRule): { length: number; anchor: number } {
  if (!FREQUENCIES.includes(rule.frequency)) {
    throw new LedgerError(
      `"${rule.frequency}" is not a tax period frequency. Use one of ${FREQUENCIES.join(", ")} — ` +
        `the certificate the FTA issued says which one this registration is on.`,
    );
  }
  const anchor = rule.firstPeriodEndMonth;
  if (!Number.isInteger(anchor) || anchor < 1 || anchor > 12) {
    throw new LedgerError(
      `The month a tax period ends in is 1 to 12, not ${anchor}. A quarterly registrant assigned ` +
        `February, May, August and November has 2 here.`,
    );
  }
  return { length: MONTHS_IN_PERIOD[rule.frequency], anchor };
}

/**
 * The index of the month a period ends in, at or after month `idx`.
 *
 * Only the stagger's offset within the period length matters, so this works for
 * every one of the twelve possible `firstPeriodEndMonth` values without any of
 * them being special: a quarterly registrant anchored on month 2 ends in
 * February, May, August and November, and one anchored on month 5 ends in
 * exactly the same four, which is the same stagger written down differently.
 */
function periodEndAtOrAfter(idx: number, anchor: number, length: number): number {
  const past = (((monthOf(idx) - anchor) % length) + length) % length;
  return past === 0 ? idx : idx + (length - past);
}

function labelFor(startIdx: number, endIdx: number): string {
  const sm = MONTH_NAMES[monthOf(startIdx) - 1];
  const em = MONTH_NAMES[monthOf(endIdx) - 1];
  const sy = yearOf(startIdx);
  const ey = yearOf(endIdx);
  if (startIdx === endIdx) return `${em} ${ey}`;
  // A period that straddles a year end has to say both years or two different
  // periods share a label, and a filing is recorded under the label.
  return sy === ey ? `${sm}-${em} ${ey}` : `${sm} ${sy}-${em} ${ey}`;
}

function periodEndingAt(endIdx: number, length: number): TaxPeriod {
  const startIdx = endIdx - length + 1;
  const to = lastDayOf(endIdx);
  return {
    label: labelFor(startIdx, endIdx),
    from: iso(firstDayOf(startIdx)),
    to: iso(to),
    dueOn: dueDateFor(to),
  };
}

/** The tax period a date falls in. */
export function taxPeriodFor(rule: PeriodRule, date: Date | string): TaxPeriod {
  const { length, anchor } = assertRule(rule);
  const d = parseDate(date, "A tax period date");
  return periodEndingAt(periodEndAtOrAfter(monthIndexOf(d), anchor, length), length);
}

/**
 * Every tax period the registration implies that overlaps the range, in order.
 *
 * Overlap rather than containment: a caller asking about a year wants the
 * period that straddles the start of it, because that is the return that
 * carries the first weeks of the year.
 */
export function taxPeriodsBetween(rule: PeriodRule, from: Date | string, to: Date | string): TaxPeriod[] {
  const { length, anchor } = assertRule(rule);
  const start = parseDate(from, "A tax period range start");
  const end = parseDate(to, "A tax period range end");
  if (end < start) throw new LedgerError("The range of tax periods ends before it starts.");

  const out: TaxPeriod[] = [];
  const lastIdx = monthIndexOf(end);
  let endIdx = periodEndAtOrAfter(monthIndexOf(start), anchor, length);
  // Bounded by the range: a period whose first month is past the end of the
  // range cannot overlap it.
  while (endIdx - length + 1 <= lastIdx) {
    out.push(periodEndingAt(endIdx, length));
    endIdx += length;
  }
  return out;
}

/* ---------------------------------------------------------- the registration */

export interface Registration {
  id: string;
  regime: TaxRegime;
  trn: string | null;
  frequency: TaxFrequency;
  firstPeriodEndMonth: number;
  registeredOn: string | null;
  deregisteredOn: string | null;
}

const asRegistration = (r: {
  id: string;
  regime: string;
  trn: string | null;
  frequency: string;
  firstPeriodEndMonth: number;
  registeredOn: Date | null;
  deregisteredOn: Date | null;
}): Registration => ({
  id: r.id,
  regime: r.regime as TaxRegime,
  trn: r.trn,
  frequency: r.frequency as TaxFrequency,
  firstPeriodEndMonth: r.firstPeriodEndMonth,
  registeredOn: r.registeredOn ? iso(r.registeredOn) : null,
  deregisteredOn: r.deregisteredOn ? iso(r.deregisteredOn) : null,
});

function assertRegime(regime: string): TaxRegime {
  if (!REGIMES.includes(regime as TaxRegime)) {
    throw new LedgerError(`"${regime}" is not a tax regime this ledger records. Use one of ${REGIMES.join(", ")}.`);
  }
  return regime as TaxRegime;
}

/**
 * The TRN as the FTA issues it: fifteen digits.
 *
 * Refused rather than cleaned up, because a TRN one digit short is a TRN that
 * belongs to nobody and it will be printed on every tax invoice the entity
 * issues. The commonest cause is a spreadsheet dropping a leading zero, so the
 * message says so.
 */
function cleanTrn(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 15) return digits;
  if (digits.length === 14) {
    throw new LedgerError(
      `A TRN is 15 digits and "${raw.trim()}" has 14. A leading zero is usually the one missing — ` +
        `a spreadsheet strips it.`,
    );
  }
  throw new LedgerError(`A TRN is 15 digits and "${raw.trim()}" has ${digits.length}.`);
}

/** The registration recorded for an entity under a regime, if there is one. */
export async function getRegistration(opts: {
  orgId: string;
  entityId: string;
  regime?: TaxRegime;
}): Promise<Registration | null> {
  const regime = assertRegime(opts.regime ?? "VAT");
  const row = await prisma.taxRegistration.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, regime },
  });
  return row ? asRegistration(row) : null;
}

/**
 * Record a registration, or amend the one already recorded.
 *
 * One per entity per regime — the schema enforces it — because a second VAT
 * registration for the same entity would mean two sets of tax periods and no
 * way to say which return a filing belongs to. Amending is therefore an update
 * in place rather than a new row, and it deliberately does not touch the
 * filings already recorded against it: a stagger that changes changes the
 * periods from here on, and the returns already filed were filed for the
 * periods that applied then.
 */
export async function recordRegistration(opts: {
  orgId: string;
  entityId: string;
  regime?: TaxRegime;
  trn?: string | null;
  frequency: TaxFrequency;
  firstPeriodEndMonth: number;
  registeredOn?: string | null;
  deregisteredOn?: string | null;
}): Promise<Registration> {
  const regime = assertRegime(opts.regime ?? "VAT");
  assertRule({ frequency: opts.frequency, firstPeriodEndMonth: opts.firstPeriodEndMonth });
  const trn = cleanTrn(opts.trn);
  const registeredOn = opts.registeredOn ? parseDate(opts.registeredOn, "The registration date") : null;
  const deregisteredOn = opts.deregisteredOn
    ? parseDate(opts.deregisteredOn, "The deregistration date")
    : null;
  if (registeredOn && deregisteredOn && deregisteredOn < registeredOn) {
    throw new LedgerError("A registration cannot end before it began.");
  }

  const data = {
    trn,
    frequency: opts.frequency,
    firstPeriodEndMonth: opts.firstPeriodEndMonth,
    registeredOn,
    deregisteredOn,
  };
  const row = await prisma.taxRegistration.upsert({
    where: { orgId_entityId_regime: { orgId: opts.orgId, entityId: opts.entityId, regime } },
    create: { orgId: opts.orgId, entityId: opts.entityId, regime, ...data },
    update: data,
  });
  return asRegistration(row);
}

/* --------------------------------------------------------------- the filings */

export interface Filing {
  id: string;
  periodLabel: string;
  periodFrom: string;
  periodTo: string;
  dueOn: string;
  filedOn: string | null;
  reference: string | null;
  netVatMinor: string | null;
  filedBy: string | null;
  notes: string | null;
}

const asFiling = (f: {
  id: string;
  periodLabel: string;
  periodFrom: Date;
  periodTo: Date;
  dueOn: Date;
  filedOn: Date | null;
  reference: string | null;
  netVatMinor: bigint | null;
  filedBy: string | null;
  notes: string | null;
}): Filing => ({
  id: f.id,
  periodLabel: f.periodLabel,
  periodFrom: iso(f.periodFrom),
  periodTo: iso(f.periodTo),
  dueOn: iso(f.dueOn),
  filedOn: f.filedOn ? iso(f.filedOn) : null,
  reference: f.reference,
  netVatMinor: f.netVatMinor === null ? null : f.netVatMinor.toString(),
  filedBy: f.filedBy,
  notes: f.notes,
});

async function registrationOrRefuse(opts: {
  orgId: string;
  entityId: string;
  regime: TaxRegime;
}): Promise<Registration> {
  const reg = await getRegistration(opts);
  if (!reg) {
    throw new LedgerError(
      `No ${opts.regime} registration is recorded for this entity, so this ledger does not know what its tax ` +
        `periods are. Record the registration — the frequency and the month the first period ends — first.`,
    );
  }
  return reg;
}

/**
 * How far back periods are looked for when a label has to be resolved or an
 * outstanding list built and no start date was given.
 *
 * Five years is the period Article 78 of Federal Decree-Law 8/2017 requires
 * records to be kept for, and the FTA's assessment window under the Tax
 * Procedures Law runs to five years too, so a return older than that is beyond
 * the point where anything can still be done about it.
 */
const LOOK_BACK_YEARS = 5;

function searchFrom(reg: Registration, asOf: Date, since?: string): Date {
  if (since) return parseDate(since, "The start of the outstanding period");
  if (reg.registeredOn) return parseDate(reg.registeredOn, "The registration date");
  return new Date(Date.UTC(asOf.getUTCFullYear() - LOOK_BACK_YEARS, asOf.getUTCMonth(), 1));
}

/** How the periods run, in a sentence, for a screen and for an error message. */
function ruleInWords(reg: Registration): string {
  const month = MONTH_NAMES[reg.firstPeriodEndMonth - 1];
  if (reg.frequency === "MONTHLY") return "Monthly periods, each ending on the last day of the month";
  if (reg.frequency === "ANNUAL") return `An annual period ending on the last day of ${month}`;
  return `Quarterly periods ending in ${month} and every third month after it`;
}

/**
 * Record that a return was filed.
 *
 * Refused for a period that has not ended: a return covers a period, and until
 * the last day of it there are still supplies to come that belong on it. The
 * FTA's own portal will not accept one either, so a filing recorded here for a
 * running period would be a record of something that did not happen.
 */
export async function recordFiling(opts: {
  orgId: string;
  entityId: string;
  regime?: TaxRegime;
  /** The period, as `taxPeriodsBetween` labels it. */
  periodLabel: string;
  filedOn?: string;
  filedBy?: string;
  reference?: string;
  /** What the return came to, positive payable and negative reclaimable. */
  netVatMinor?: string | number | bigint | null;
  notes?: string;
  /** Read the clock once, so a test and a screen see the same "today". */
  asOf?: Date | string;
}): Promise<Filing> {
  const regime = assertRegime(opts.regime ?? "VAT");
  const asOf = opts.asOf ? parseDate(opts.asOf, "The date this is being recorded as at") : new Date();
  const reg = await registrationOrRefuse({ orgId: opts.orgId, entityId: opts.entityId, regime });

  // A year past today, so the label of the period that is running now resolves
  // and can be refused for what it is rather than as an unknown label.
  const horizon = new Date(Date.UTC(asOf.getUTCFullYear() + 1, asOf.getUTCMonth(), asOf.getUTCDate()));
  const periods = taxPeriodsBetween(reg, searchFrom(reg, asOf), horizon);
  const period = periods.find((p) => p.label === opts.periodLabel);
  if (!period) {
    throw new LedgerError(
      `"${opts.periodLabel}" is not a tax period of this registration. Its periods are ` +
        `${periods.slice(-4).map((p) => p.label).join(", ")}.`,
    );
  }

  const periodEnd = parseDate(period.to, "The tax period end");
  if (periodEnd > asOf) {
    throw new LedgerError(
      `The ${period.label} tax period runs to ${period.to} and has not ended, so there is no return to file ` +
        `for it yet. It falls due on ${period.dueOn}.`,
    );
  }

  const filedOn = opts.filedOn ? parseDate(opts.filedOn, "The filing date") : asOf;
  if (filedOn < periodEnd) {
    throw new LedgerError(
      `The ${period.label} return cannot have been filed on ${iso(filedOn)}: the period it covers only ended ` +
        `on ${period.to}.`,
    );
  }
  if (filedOn > asOf) throw new LedgerError("A return cannot be recorded as filed on a date that has not arrived.");

  const already = await prisma.taxFiling.findUnique({
    where: { registrationId_periodLabel: { registrationId: reg.id, periodLabel: period.label } },
  });
  if (already) {
    // Not overwritten. A filing carries the FTA's own reference and the person
    // who submitted it, and quietly replacing those loses the only record of
    // what was actually sent.
    throw new LedgerError(
      `The ${period.label} return is already recorded as filed` +
        (already.filedOn ? ` on ${iso(already.filedOn)}` : "") +
        (already.reference ? `, reference ${already.reference}` : "") +
        `. A correction to a filed return is a voluntary disclosure, not a second filing.`,
    );
  }

  const row = await prisma.taxFiling.create({
    data: {
      orgId: opts.orgId,
      registrationId: reg.id,
      periodLabel: period.label,
      periodFrom: parseDate(period.from, "The tax period start"),
      periodTo: periodEnd,
      dueOn: parseDate(period.dueOn, "The tax period due date"),
      filedOn,
      reference: opts.reference?.trim() || null,
      netVatMinor:
        opts.netVatMinor === undefined || opts.netVatMinor === null || opts.netVatMinor === ""
          ? null
          : BigInt(opts.netVatMinor),
      filedBy: opts.filedBy ?? null,
      notes: opts.notes?.trim() || null,
    },
  });
  return asFiling(row);
}

/** The filing recorded for a period, if there is one. */
export async function filingFor(opts: {
  orgId: string;
  entityId: string;
  regime?: TaxRegime;
  periodLabel: string;
}): Promise<Filing | null> {
  const regime = assertRegime(opts.regime ?? "VAT");
  const reg = await getRegistration({ orgId: opts.orgId, entityId: opts.entityId, regime });
  if (!reg) return null;
  const row = await prisma.taxFiling.findUnique({
    where: { registrationId_periodLabel: { registrationId: reg.id, periodLabel: opts.periodLabel } },
  });
  return row ? asFiling(row) : null;
}

export interface OutstandingPeriod extends TaxPeriod {
  /** Days past the due date. Nought where it is due but not yet late. */
  daysOverdue: number;
  overdue: boolean;
}

export interface OutstandingReturns {
  registered: boolean;
  regime: TaxRegime;
  frequency: TaxFrequency | null;
  firstPeriodEndMonth: number | null;
  asOf: string;
  /** Ended periods with no filing recorded against them, oldest first. */
  periods: OutstandingPeriod[];
  /** Why the list is what it is, including when it is empty because nothing is known. */
  note: string;
}

/**
 * The periods that have ended and have no filing recorded.
 *
 * A period still running is not outstanding — there is nothing to file yet —
 * and a period that has ended but is not yet at its due date is outstanding
 * without being late. The two are separated rather than merged, because "due"
 * and "overdue" carry different consequences: Article 25 of the Tax Procedures
 * Law penalises the late return, not the unfiled-but-not-yet-due one.
 */
export async function outstandingReturns(opts: {
  orgId: string;
  entityId: string;
  regime?: TaxRegime;
  asOf?: Date | string;
  /** Ignore periods ending before this. Defaults to the registration date. */
  since?: string;
}): Promise<OutstandingReturns> {
  const regime = assertRegime(opts.regime ?? "VAT");
  const asOf = opts.asOf ? parseDate(opts.asOf, "The date the list is read as at") : new Date();
  const reg = await getRegistration({ orgId: opts.orgId, entityId: opts.entityId, regime });

  if (!reg) {
    return {
      registered: false,
      regime,
      frequency: null,
      firstPeriodEndMonth: null,
      asOf: iso(asOf),
      periods: [],
      note:
        `No ${regime} registration is recorded for this entity, so this ledger cannot say what its tax periods ` +
        `are or whether any return is outstanding. Record the registration to find out.`,
    };
  }

  const ended = taxPeriodsBetween(reg, searchFrom(reg, asOf, opts.since), asOf).filter(
    (p) => parseDate(p.to, "A tax period end") <= asOf,
  );
  // A deregistered person stops having tax periods after the final one, and
  // chasing them for returns they do not owe is how a list stops being read.
  const inScope = reg.deregisteredOn
    ? ended.filter((p) => p.from <= reg.deregisteredOn!)
    : ended;

  const filed = new Set(
    (
      await prisma.taxFiling.findMany({
        where: { registrationId: reg.id, periodLabel: { in: inScope.map((p) => p.label) } },
        select: { periodLabel: true },
      })
    ).map((f) => f.periodLabel),
  );

  const periods: OutstandingPeriod[] = inScope
    .filter((p) => !filed.has(p.label))
    .map((p) => {
      const due = parseDate(p.dueOn, "A tax period due date");
      const days = Math.floor((asOf.getTime() - due.getTime()) / DAY_MS);
      return { ...p, daysOverdue: days > 0 ? days : 0, overdue: days > 0 };
    });

  return {
    registered: true,
    regime,
    frequency: reg.frequency,
    firstPeriodEndMonth: reg.firstPeriodEndMonth,
    asOf: iso(asOf),
    periods,
    note:
      `${ruleInWords(reg)}. Each return is due on the 28th day following the end of its period (Article 64 of ` +
      `the Executive Regulation). A period still running is not listed: there is nothing to file for it yet.`,
  };
}
