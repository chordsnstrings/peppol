import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { post, LedgerError } from "./post";
import { ledgerBalances } from "./balances";

/**
 * Time worked, and the work in progress it becomes.
 *
 * For a service business time is the raw material, and unbilled time is either
 * an asset or it is not. That is a question the accounts have to answer, not
 * one to leave in a spreadsheet — a firm that has done three months of work
 * and billed none of it has either an asset worth something or a very bad
 * quarter, and the difference is a decision somebody has to take.
 *
 * Two opinions this module holds, both stated so they can be argued with:
 *
 *   Time is recorded in MINUTES. A quarter of an hour is 15, not 0.25, and a
 *   month of quarter-hours summed as floats does not add up to what anybody
 *   wrote down.
 *
 *   Work in progress is carried at COST, not at what it will be billed for.
 *   Carrying it at the charge-out rate recognises a profit on work nobody has
 *   agreed to pay for yet, which is the oldest way for a professional firm to
 *   flatter itself. Where no cost rate is known the time is recorded and
 *   carried at nothing, and the register says how much of it that is — a
 *   figure of nil that nobody can see is worse than one they can.
 */

export const WIP_ACCOUNT = "1330";

export type EntryStatus = "draft" | "approved" | "invoiced" | "written_off";

export interface NewTimeEntry {
  employeeCode: string;
  projectCode?: string;
  workedOn: Date | string;
  minutes: number;
  /** Charge-out rate per hour, in minor units. */
  rateMinor: number | bigint | string;
  /** Cost per hour. Nil means unknown, which is different from free. */
  costRateMinor?: number | bigint | string | null;
  description: string;
  billable?: boolean;
}

const MINUTES_PER_HOUR = 60n;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monthOf = (d: Date) => iso(d).slice(0, 7);

function asDate(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? new Date(`${v.slice(0, 10)}T00:00:00.000Z`) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date I can read.`);
  return d;
}

function minor(v: number | bigint | string, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v.trim())) throw new LedgerError(`${what} must be a whole number of minor units.`);
    return BigInt(v.trim());
  }
  if (!Number.isInteger(v)) throw new LedgerError(`${what} must be in whole minor units, got ${v}.`);
  return BigInt(v);
}

/**
 * What a stretch of time is worth at a rate per hour.
 *
 * Rounded half-up once, at the end. Rounding per entry and summing would drift
 * by a fil a line over a month of six-minute units, and a timesheet that does
 * not agree with the invoice raised from it is a conversation nobody wants.
 */
export function valueOf(minutes: number, ratePerHourMinor: bigint): bigint {
  if (!Number.isInteger(minutes) || minutes <= 0) return 0n;
  const raw = BigInt(minutes) * ratePerHourMinor;
  const q = raw / MINUTES_PER_HOUR;
  const r = raw % MINUTES_PER_HOUR;
  return r * 2n >= MINUTES_PER_HOUR ? q + 1n : q;
}

/** Minutes as hours and minutes, for a screen. 90 is "1h 30m". */
export function asHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/* --------------------------------------------------------------- recording */

export async function recordTime(opts: { orgId: string; entityId: string; entry: NewTimeEntry }) {
  const e = opts.entry;
  const employeeCode = (e.employeeCode ?? "").trim();
  if (!employeeCode) throw new LedgerError("A time entry needs to say who worked.");
  const description = (e.description ?? "").trim();
  if (!description) {
    throw new LedgerError(
      "A time entry needs to say what the time was spent on. An hour against a project with no description is an " +
        "hour nobody can defend when the client asks what it was.",
    );
  }
  if (!Number.isInteger(e.minutes) || e.minutes <= 0) {
    throw new LedgerError("Time is recorded in whole minutes, and an entry of none is not an entry.");
  }
  if (e.minutes > 1440) {
    throw new LedgerError(`${e.minutes} minutes is more than a day. Split it across the days it was actually worked.`);
  }

  const workedOn = asDate(e.workedOn, "The date worked");
  const rate = minor(e.rateMinor, "The charge-out rate");
  const cost = e.costRateMinor === null || e.costRateMinor === undefined
    ? null
    : minor(e.costRateMinor, "The cost rate");

  if (e.projectCode) {
    const project = await prisma.project.findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, code: e.projectCode.trim() },
      select: { code: true, status: true },
    });
    if (!project) {
      throw new LedgerError(`There is no project ${e.projectCode} on this entity. Time booked to a project nobody has opened is time nobody will find.`);
    }
    if (project.status !== "active") {
      throw new LedgerError(`Project ${project.code} is ${project.status}, so time cannot be booked to it.`);
    }
  }

  return prisma.timeEntry.create({
    data: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      employeeCode,
      projectCode: e.projectCode?.trim() || null,
      workedOn,
      minutes: e.minutes,
      rateMinor: rate,
      costRateMinor: cost,
      description,
      billable: e.billable !== false,
    },
  });
}

async function entryOf(scope: { orgId: string; entityId: string }, id: string) {
  const t = await prisma.timeEntry.findFirst({ where: { id, orgId: scope.orgId, entityId: scope.entityId } });
  if (!t) throw new LedgerError("That time entry does not exist on this entity.");
  return t;
}

export async function approveTime(opts: { orgId: string; entityId: string; ids: string[] }) {
  if (!opts.ids.length) throw new LedgerError("Nothing was chosen to approve.");
  const entries = await prisma.timeEntry.findMany({
    where: { id: { in: opts.ids }, orgId: opts.orgId, entityId: opts.entityId },
  });
  const wrong = entries.filter((t) => t.status !== "draft");
  if (wrong.length) {
    throw new LedgerError(
      `${wrong.length} of those ${wrong.length === 1 ? "entries is" : "entries are"} already ` +
        `${wrong[0].status.replace("_", " ")}, so ${wrong.length === 1 ? "it" : "they"} cannot be approved again.`,
    );
  }
  const r = await prisma.timeEntry.updateMany({
    where: { id: { in: opts.ids }, orgId: opts.orgId, entityId: opts.entityId, status: "draft" },
    data: { status: "approved" },
  });
  return { approved: r.count };
}

/**
 * Time that will not be charged for.
 *
 * The reason is required, and it is the point of the feature rather than
 * paperwork: written-off time is the only honest measure of how well a firm
 * estimates, and a write-off with no reason teaches nobody anything.
 */
export async function writeOffTime(opts: {
  orgId: string; entityId: string; ids: string[]; reason: string;
}) {
  const reason = (opts.reason ?? "").trim();
  if (reason.length < 4) {
    throw new LedgerError(
      "Writing time off needs a reason. It is the only honest measure a firm has of how well it estimates, and a " +
        "write-off with no reason teaches nobody anything.",
    );
  }
  const entries = await prisma.timeEntry.findMany({
    where: { id: { in: opts.ids }, orgId: opts.orgId, entityId: opts.entityId },
  });
  const invoiced = entries.filter((t) => t.status === "invoiced");
  if (invoiced.length) {
    throw new LedgerError(
      `${invoiced.length} of those ${invoiced.length === 1 ? "entry has" : "entries have"} been invoiced. Time that ` +
        `has been charged is written off with a credit note, not by editing the timesheet.`,
    );
  }
  const r = await prisma.timeEntry.updateMany({
    where: { id: { in: opts.ids }, orgId: opts.orgId, entityId: opts.entityId, status: { not: "invoiced" } },
    data: { status: "written_off", writeOffReason: reason },
  });
  return { writtenOff: r.count, reason };
}

/** Mark time as charged, naming the invoice it went onto. */
export async function markInvoiced(opts: {
  orgId: string; entityId: string; ids: string[]; invoiceId: string;
}) {
  const invoiceId = (opts.invoiceId ?? "").trim();
  if (!invoiceId) throw new LedgerError("Invoiced time has to name the invoice, or the charge cannot be traced to the hours behind it.");

  const entries = await prisma.timeEntry.findMany({
    where: { id: { in: opts.ids }, orgId: opts.orgId, entityId: opts.entityId },
  });
  const nonBillable = entries.filter((t) => !t.billable);
  if (nonBillable.length) {
    throw new LedgerError(
      `${nonBillable.length} of those ${nonBillable.length === 1 ? "entry is" : "entries are"} marked non-billable. ` +
        `Non-billable time is recorded because what it cost is real, not because anybody is going to pay for it.`,
    );
  }
  const notApproved = entries.filter((t) => t.status !== "approved");
  if (notApproved.length) {
    throw new LedgerError(
      `${notApproved.length} of those entries ${notApproved.length === 1 ? "has" : "have"} not been approved. ` +
        `Approval is what somebody other than the person who wrote the time does to it before a client sees it.`,
    );
  }

  const r = await prisma.timeEntry.updateMany({
    where: { id: { in: opts.ids }, orgId: opts.orgId, entityId: opts.entityId, status: "approved" },
    data: { status: "invoiced", invoiceId },
  });
  return { invoiced: r.count, invoiceId };
}

/* ------------------------------------------------------------------ the WIP */

export interface WipState {
  asOf: string;
  /** Unbilled billable time, valued at cost. */
  balanceMinor: bigint;
  minutes: number;
  /** What it would be billed for, which is not what it is carried at. */
  chargeableMinor: bigint;
  /** Time with no cost rate, and therefore carried at nothing. */
  unratedMinutes: number;
  byProject: {
    projectCode: string | null;
    minutes: number;
    costMinor: bigint;
    chargeableMinor: bigint;
    unratedMinutes: number;
  }[];
}

/**
 * Unbilled billable time as at a date, at cost.
 *
 * Draft time is included. It has been worked whether or not anybody has looked
 * at it yet, and excluding it would make the balance sheet depend on how
 * promptly a manager gets round to approving timesheets.
 */
export async function wipAt(opts: { orgId: string; entityId: string; asOf: Date | string }): Promise<WipState> {
  const asOf = asDate(opts.asOf, "The date");

  const entries = await prisma.timeEntry.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      workedOn: { lte: asOf },
      billable: true,
      status: { in: ["draft", "approved"] },
    },
    orderBy: [{ projectCode: "asc" }, { workedOn: "asc" }],
  });

  const byProject = new Map<string, { minutes: number; cost: bigint; charge: bigint; unrated: number }>();
  let minutes = 0;
  let cost = 0n;
  let charge = 0n;
  let unrated = 0;

  for (const t of entries) {
    const key = t.projectCode ?? "";
    const g = byProject.get(key) ?? { minutes: 0, cost: 0n, charge: 0n, unrated: 0 };
    const c = t.costRateMinor === null ? 0n : valueOf(t.minutes, t.costRateMinor);
    if (t.costRateMinor === null) { g.unrated += t.minutes; unrated += t.minutes; }
    g.minutes += t.minutes;
    g.cost += c;
    g.charge += valueOf(t.minutes, t.rateMinor);
    byProject.set(key, g);
    minutes += t.minutes;
    cost += c;
    charge += valueOf(t.minutes, t.rateMinor);
  }

  return {
    asOf: iso(asOf),
    balanceMinor: cost,
    minutes,
    chargeableMinor: charge,
    unratedMinutes: unrated,
    byProject: [...byProject.entries()].map(([projectCode, g]) => ({
      projectCode: projectCode || null,
      minutes: g.minutes,
      costMinor: g.cost,
      chargeableMinor: g.charge,
      unratedMinutes: g.unrated,
    })),
  };
}

export interface WipRunResult {
  period: string;
  balanceMinor: bigint;
  chargeMinor: bigint;
  minutes: number;
  posted: boolean;
  entryId: string | null;
  note: string;
}

/**
 * Bring work in progress on the balance sheet to what the timesheets say.
 *
 * The movement is measured against what account 1330 actually holds rather
 * than against the last posting row, which is what makes it idempotent on the
 * position: a second run finds nothing and posts nothing, and time invoiced in
 * between is absorbed without anyone telling it.
 *
 *   Dr  1330  Work in progress      the increase
 *     Cr  5100  Direct labour         the cost held back from the month
 *
 * and the reverse as work is billed. It is a reclassification, not income:
 * nothing is recognised as revenue until an invoice is raised.
 */
export async function runWip(opts: {
  orgId: string; entityId: string; period: string; actorId?: string;
}): Promise<WipRunResult> {
  if (!/^\d{4}-\d{2}$/.test(opts.period)) {
    throw new LedgerError(`"${opts.period}" is not a month. Give it as 2026-03.`);
  }
  const fmt = fmtIn(await bookCurrency(opts.orgId, opts.entityId));
  const [y, m] = opts.period.split("-").map(Number);
  const endsOn = new Date(Date.UTC(y, m, 0));

  const state = await wipAt({ orgId: opts.orgId, entityId: opts.entityId, asOf: endsOn });
  const ledger = await ledgerBalances({ orgId: opts.orgId, entityId: opts.entityId, codes: [WIP_ACCOUNT] });
  const held = ledger.get(WIP_ACCOUNT) ?? 0n;
  const movement = state.balanceMinor - held;

  if (movement === 0n) {
    return {
      period: opts.period, balanceMinor: state.balanceMinor, chargeMinor: 0n, minutes: state.minutes,
      posted: false, entryId: null,
      note: `Work in progress is already carried at ${fmt(state.balanceMinor)}. Nothing posted.`,
    };
  }

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: endsOn,
    source: "wip",
    sourceType: "WORK_IN_PROGRESS",
    sourceId: opts.period,
    memo: `Work in progress — ${opts.period}`,
    // The key names the position being moved to, not the run: re-running after
    // nothing has changed is a no-op, and a genuinely different balance is a
    // different key.
    externalKey: `wip:${opts.entityId}:${opts.period}:${state.balanceMinor}`,
    series: "WP",
    actorId: opts.actorId,
    lines: movement > 0n
      ? [
          { account: WIP_ACCOUNT, debit: movement, memo: `Unbilled time carried forward` },
          { account: "5100", credit: movement, memo: `Cost held back from ${opts.period}` },
        ]
      : [
          { account: WIP_ACCOUNT, credit: -movement, memo: `Unbilled time released` },
          { account: "5100", debit: -movement, memo: `Cost released into ${opts.period}` },
        ],
  });

  await prisma.wipPosting.upsert({
    where: { orgId_entityId_period: { orgId: opts.orgId, entityId: opts.entityId, period: opts.period } },
    create: {
      orgId: opts.orgId, entityId: opts.entityId, period: opts.period,
      balanceMinor: state.balanceMinor, chargeMinor: movement, minutes: state.minutes, entryId: entry.id,
    },
    update: { balanceMinor: state.balanceMinor, chargeMinor: movement, minutes: state.minutes, entryId: entry.id },
  });

  return {
    period: opts.period, balanceMinor: state.balanceMinor, chargeMinor: movement, minutes: state.minutes,
    posted: true, entryId: entry.id,
    note:
      `${movement > 0n ? "Held back" : "Released"} ${fmt(movement > 0n ? movement : -movement)} of cost. Work in ` +
      `progress now stands at ${fmt(state.balanceMinor)}, carried at cost — not at what it will be billed for.`,
  };
}

/* -------------------------------------------------------------- the screen */

/** Recovery: what was billed against what the time was worth at the rate. */
export async function utilisation(opts: {
  orgId: string; entityId: string; from: Date | string; to: Date | string;
}) {
  const from = asDate(opts.from, "The start date");
  const to = asDate(opts.to, "The end date");
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const entries = await prisma.timeEntry.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, workedOn: { gte: from, lte: to } },
  });

  const byPerson = new Map<string, {
    minutes: number; billableMinutes: number; invoicedMinutes: number; writtenOffMinutes: number;
    chargeableMinor: bigint; invoicedMinor: bigint; writtenOffMinor: bigint;
  }>();

  for (const t of entries) {
    const g = byPerson.get(t.employeeCode) ?? {
      minutes: 0, billableMinutes: 0, invoicedMinutes: 0, writtenOffMinutes: 0,
      chargeableMinor: 0n, invoicedMinor: 0n, writtenOffMinor: 0n,
    };
    const value = valueOf(t.minutes, t.rateMinor);
    g.minutes += t.minutes;
    if (t.billable) { g.billableMinutes += t.minutes; g.chargeableMinor += value; }
    if (t.status === "invoiced") { g.invoicedMinutes += t.minutes; g.invoicedMinor += value; }
    if (t.status === "written_off") { g.writtenOffMinutes += t.minutes; g.writtenOffMinor += value; }
    byPerson.set(t.employeeCode, g);
  }

  const rows = [...byPerson.entries()].map(([employeeCode, g]) => ({
    employeeCode,
    ...g,
    /**
     * Billable time as a share of time recorded, in basis points. Undefined
     * where nothing was recorded — a rate against no time is not nought
     * percent, it is a question with no answer.
     */
    utilisationBps: g.minutes === 0 ? null : Math.round((g.billableMinutes * 10_000) / g.minutes),
    /** Invoiced against chargeable: how much of the work actually got paid for. */
    recoveryBps: g.chargeableMinor === 0n ? null : Number((g.invoicedMinor * 10_000n) / g.chargeableMinor),
  })).sort((a, b) => b.minutes - a.minutes);

  return {
    from: iso(from), to: iso(to),
    people: rows,
    totals: {
      minutes: rows.reduce((a, r) => a + r.minutes, 0),
      billableMinutes: rows.reduce((a, r) => a + r.billableMinutes, 0),
      chargeableMinor: rows.reduce((a, r) => a + r.chargeableMinor, 0n),
      invoicedMinor: rows.reduce((a, r) => a + r.invoicedMinor, 0n),
      writtenOffMinor: rows.reduce((a, r) => a + r.writtenOffMinor, 0n),
    },
  };
}

/**
 * The timesheet register, with the ledger balance work in progress must agree
 * with. A WIP balance no timesheet accounts for is either a posting by hand or
 * time invoiced without the run being made, and both are findings.
 */
export async function timesheetRegister(opts: {
  orgId: string; entityId: string; asOf?: Date | string; status?: EntryStatus; projectCode?: string;
}) {
  const asOf = opts.asOf ? asDate(opts.asOf, "The date") : new Date();
  const state = await wipAt({ orgId: opts.orgId, entityId: opts.entityId, asOf });

  const entries = await prisma.timeEntry.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      workedOn: { lte: asOf },
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.projectCode ? { projectCode: opts.projectCode } : {}),
    },
    orderBy: [{ workedOn: "desc" }, { employeeCode: "asc" }],
    take: 500,
  });

  const ledger = await ledgerBalances({ orgId: opts.orgId, entityId: opts.entityId, codes: [WIP_ACCOUNT] });
  const held = ledger.get(WIP_ACCOUNT) ?? 0n;

  return {
    asOf: iso(asOf),
    wip: state,
    entries: entries.map((t) => ({
      id: t.id,
      employeeCode: t.employeeCode,
      projectCode: t.projectCode,
      workedOn: iso(t.workedOn),
      minutes: t.minutes,
      hours: asHours(t.minutes),
      rateMinor: t.rateMinor,
      costRateMinor: t.costRateMinor,
      chargeableMinor: valueOf(t.minutes, t.rateMinor),
      costMinor: t.costRateMinor === null ? null : valueOf(t.minutes, t.costRateMinor),
      description: t.description,
      billable: t.billable,
      status: t.status,
      invoiceId: t.invoiceId,
      writeOffReason: t.writeOffReason,
    })),
    reconciliation: {
      registerMinor: state.balanceMinor,
      ledgerMinor: held,
      differenceMinor: state.balanceMinor - held,
      agrees: state.balanceMinor === held,
      /** How much of the register is carried at nothing for want of a cost rate. */
      unratedMinutes: state.unratedMinutes,
    },
  };
}

/**
 * A figure in the book's own currency. Through `fmtMinor`, which knows each
 * currency's exponent: two decimals is right for a dirham and wrong by a
 * factor of ten for a Kuwaiti or Bahraini dinar or an Omani rial.
 */
const fmtIn = (currency: string) => (v: bigint) => fmtMinor(v, currency, { zero: "zero" });

/** The currency this entity keeps its books in. */
async function bookCurrency(orgId: string, entityId: string): Promise<string> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  return book?.functionalCurrency ?? "AED";
}
