import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { postInvoice } from "./ar";
import { computeTotals } from "@/lib/domain/tax";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";
import { TAX_PROFILES } from "@/lib/domain/tax";

/**
 * Subscriptions — an invoice that recurs on its own schedule.
 *
 * A template is not an invoice. It is the instruction for making one, and each
 * invoice it makes is a separate document with its own number, its own date
 * and its own life: it can be edited, credited or cancelled without the
 * template knowing, exactly as a hand-raised invoice can. `recurring.ts` does
 * the same for journals, and the two are deliberately apart — a journal
 * template posts, an invoice template raises a document somebody sends.
 *
 * The failure a subscription can least afford is billing a customer twice for
 * one period, so that is not guarded by a check but by a unique index on
 * (template, scheduled date). A re-run collides rather than duplicating, and a
 * run interrupted halfway can simply be run again.
 *
 * What it deliberately does not do is decide when a period was earned. An
 * invoice raised on the first of the month for that month is revenue of that
 * month; one raised annually in advance is not revenue of the day it was
 * raised. That is IFRS 15 and it belongs in `revenue.ts` — this module raises
 * the document and says so, rather than quietly implying the two are the same.
 */

export type Frequency = "WEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUAL";

export interface TemplateLine {
  description: string;
  quantityMilli: number | bigint | string;
  unitPriceMinor: number | bigint | string;
  taxCode?: string;
  accountCode?: string;
}

export interface NewSubscription {
  code: string;
  customerCode?: string;
  customerName: string;
  customerTrn?: string;
  frequency?: Frequency;
  startsOn: Date | string;
  endsOn?: Date | string | null;
  paymentTerms?: number;
  currency?: string;
  notes?: string;
  lines: TemplateLine[];
}

const MILLI = 1000n;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

function asDate(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? day(v.slice(0, 10)) : v;
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
 * The next scheduled date after this one.
 *
 * Month arithmetic on a date near the end of a month is where every recurring
 * biller goes wrong: the 31st plus a month is not the 31st of a month with 30
 * days in it. Rolling back to the last day of the shorter month keeps the run
 * on the end of the month, which is what "monthly on the 31st" means to
 * everybody who set it up; rolling forward into the next month would silently
 * skip a period.
 */
export function nextDate(from: Date, frequency: Frequency): Date {
  if (frequency === "WEEKLY") return new Date(from.getTime() + 7 * 86_400_000);

  const months = frequency === "MONTHLY" ? 1 : frequency === "QUARTERLY" ? 3 : 12;
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();
  const lastOfTarget = new Date(Date.UTC(y, m + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m + months, Math.min(d, lastOfTarget)));
}

function readLines(value: unknown, where: string): TemplateLine[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new LedgerError(`${where} has no lines, so it would raise an invoice for nothing.`);
  }
  return value as TemplateLine[];
}

/** A template line becomes an invoice line, priced through the one tax table. */
function invoiceLines(lines: TemplateLine[], where: string): InvoiceLine[] {
  return lines.map((l, i) => {
    const description = (l.description ?? "").trim();
    if (!description) throw new LedgerError(`Line ${i + 1} of ${where} has no description.`);

    const quantityMilli = minor(l.quantityMilli, `Line ${i + 1} quantity`);
    if (quantityMilli <= 0n) throw new LedgerError(`Line ${i + 1} of ${where} has a quantity of nil or less.`);
    const unitPriceMinor = minor(l.unitPriceMinor, `Line ${i + 1} unit price`);
    if (unitPriceMinor < 0n) throw new LedgerError(`Line ${i + 1} of ${where} has a negative price.`);

    const taxCode = (l.taxCode ?? "STANDARD_5").trim().toUpperCase();
    if (!(taxCode in TAX_PROFILES)) {
      throw new LedgerError(
        `Line ${i + 1} of ${where} carries tax code "${l.taxCode}", which this ledger does not know. ` +
          `Use one of ${Object.keys(TAX_PROFILES).join(", ")}.`,
      );
    }

    // The margin scheme prices from the purchase cost of the particular thing
    // being sold, and a subscription bills the same line every period. There
    // is no cost for a template to carry, and computing 5% of the whole price
    // — which is what this used to do — would charge the customer a tax the
    // scheme exists to avoid, on an invoice that under Executive Regulation
    // Article 43 must not show tax at all.
    if (taxCode === "MARGIN_SCHEME") {
      throw new LedgerError(
        `Line ${i + 1} of ${where} is on the margin scheme, which prices from what the particular item cost. ` +
          `A subscription bills the same line every period and has no such cost, so the tax cannot be worked out. ` +
          `Raise those sales as invoices.`,
      );
    }

    // Quantity is thousandths everywhere in this product; the invoice model
    // takes a plain number, so it is converted once, here, rather than each
    // caller deciding.
    const qty = Number(quantityMilli) / Number(MILLI);
    const net = (quantityMilli * unitPriceMinor) / MILLI;
    const rate = TAX_PROFILES[taxCode as TaxProfileCode].ratePercent;
    const vat = (net * BigInt(Math.round(rate * 100))) / 10_000n;

    return {
      id: `l${i + 1}`,
      lineNo: i + 1,
      description,
      qty,
      unitCode: "C62",
      unitPriceMinor: Number(unitPriceMinor),
      taxProfileCode: taxCode as TaxProfileCode,
      lineNetMinor: Number(net),
      lineVatMinor: Number(vat),
    } as InvoiceLine;
  });
}

/* ------------------------------------------------------------ the template */

export async function createSubscription(opts: {
  orgId: string;
  entityId: string;
  subscription: NewSubscription;
}) {
  const s = opts.subscription;
  const code = (s.code ?? "").trim();
  if (!code) throw new LedgerError("A subscription needs a code — it is what the invoices it raises refer back to.");
  if (!(s.customerName ?? "").trim()) throw new LedgerError(`${code} needs the customer it bills.`);

  const startsOn = asDate(s.startsOn, "The start date");
  const endsOn = s.endsOn ? asDate(s.endsOn, "The end date") : null;
  if (endsOn && endsOn < startsOn) {
    throw new LedgerError(
      `${code} ends on ${iso(endsOn)} and starts on ${iso(startsOn)}. It would raise nothing, and a run that ` +
        `silently does nothing is the one nobody notices for a quarter.`,
    );
  }

  const frequency: Frequency = s.frequency ?? "MONTHLY";
  // Validated here as well as by the database so the message is a sentence.
  if (!["WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL"].includes(frequency)) {
    throw new LedgerError(`${code} recurs "${frequency}". It can recur weekly, monthly, quarterly or annually.`);
  }

  const lines = readLines(s.lines, code);
  invoiceLines(lines, code); // proves they can be priced before anything is stored

  const clash = await prisma.recurringInvoice.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code },
    select: { customerName: true },
  });
  if (clash) throw new LedgerError(`Subscription ${code} already exists — it bills ${clash.customerName}.`);

  return prisma.recurringInvoice.create({
    data: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      code,
      customerCode: s.customerCode?.trim() || null,
      customerName: s.customerName.trim(),
      customerTrn: s.customerTrn?.trim() || null,
      frequency,
      startsOn,
      endsOn,
      nextOn: startsOn,
      paymentTerms: s.paymentTerms ?? 30,
      currency: s.currency ?? "AED",
      lines: lines as unknown as object,
      notes: s.notes?.trim() || null,
    },
  });
}

async function templateOf(scope: { orgId: string; entityId: string }, code: string) {
  const t = await prisma.recurringInvoice.findFirst({
    where: { orgId: scope.orgId, entityId: scope.entityId, code },
  });
  if (!t) throw new LedgerError(`There is no subscription ${code} on this entity.`);
  return t;
}

export async function pauseSubscription(opts: { orgId: string; entityId: string; code: string }) {
  const t = await templateOf(opts, opts.code);
  if (t.status === "ended") throw new LedgerError(`${t.code} has ended; there is nothing to pause.`);
  return prisma.recurringInvoice.update({ where: { id: t.id }, data: { status: "paused" } });
}

/**
 * Resume a paused subscription.
 *
 * The periods it missed while paused are deliberately not raised. A pause is a
 * decision not to bill, and quietly catching up would send a customer three
 * invoices on one day for a service somebody had decided to stop charging for.
 * The next date moves forward to the first scheduled date from today.
 */
export async function resumeSubscription(opts: {
  orgId: string; entityId: string; code: string; asOf?: Date | string;
}) {
  const t = await templateOf(opts, opts.code);
  if (t.status === "ended") throw new LedgerError(`${t.code} has ended and cannot be resumed. Create a new subscription.`);

  const asOf = opts.asOf ? asDate(opts.asOf, "The resume date") : new Date();
  let nextOn = t.nextOn;
  let skipped = 0;
  while (nextOn < asOf) {
    nextOn = nextDate(nextOn, t.frequency as Frequency);
    skipped++;
  }

  const updated = await prisma.recurringInvoice.update({
    where: { id: t.id },
    data: { status: "active", nextOn },
  });
  return {
    ...updated,
    skipped,
    note:
      skipped === 0
        ? `${t.code} is active again, next due ${iso(nextOn)}.`
        : `${t.code} is active again, next due ${iso(nextOn)}. The ${skipped} period${skipped === 1 ? "" : "s"} it ` +
          `was paused for ${skipped === 1 ? "is" : "are"} not billed — a pause is a decision not to charge, and ` +
          `catching up would send one customer several invoices on one day.`,
  };
}

export async function endSubscription(opts: { orgId: string; entityId: string; code: string; on?: Date | string }) {
  const t = await templateOf(opts, opts.code);
  const on = opts.on ? asDate(opts.on, "The end date") : new Date();
  return prisma.recurringInvoice.update({
    where: { id: t.id },
    data: { status: "ended", endsOn: on },
  });
}

/* --------------------------------------------------------------- the runs */

export interface DueSubscription {
  code: string;
  customerName: string;
  scheduledOn: string;
  frequency: string;
  totalMinor: bigint;
  /** Periods behind, where a run was missed. Each is raised separately. */
  periodsDue: number;
}

/**
 * What is due to be raised as at a date, and for how much.
 *
 * Several periods can be due at once, and they are counted rather than folded
 * into one invoice: a customer on a monthly subscription who was not billed
 * for three months owes three months, and one invoice for the total loses
 * which period each part was for — which is the thing a query about the bill
 * always turns on.
 */
export async function dueSubscriptions(opts: {
  orgId: string; entityId: string; asOf?: Date | string;
}): Promise<{ asOf: string; due: DueSubscription[]; totalMinor: bigint }> {
  const asOf = opts.asOf ? asDate(opts.asOf, "The run date") : new Date();

  const templates = await prisma.recurringInvoice.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: "active", nextOn: { lte: asOf } },
    orderBy: { nextOn: "asc" },
  });

  const due: DueSubscription[] = [];
  for (const t of templates) {
    if (t.endsOn && t.nextOn > t.endsOn) continue;

    let scheduled = t.nextOn;
    let periods = 0;
    while (scheduled <= asOf && (!t.endsOn || scheduled <= t.endsOn)) {
      periods++;
      scheduled = nextDate(scheduled, t.frequency as Frequency);
    }
    if (periods === 0) continue;

    const lines = invoiceLines(readLines(t.lines, t.code), t.code);
    const totals = computeTotals(lines);
    due.push({
      code: t.code,
      customerName: t.customerName,
      scheduledOn: iso(t.nextOn),
      frequency: t.frequency,
      totalMinor: BigInt(totals.payableMinor) * BigInt(periods),
      periodsDue: periods,
    });
  }

  return { asOf: iso(asOf), due, totalMinor: due.reduce((a, d) => a + d.totalMinor, 0n) };
}

export interface IssueResult {
  code: string;
  raised: { invoiceId: string; number: string; scheduledOn: string; totalMinor: bigint; reference: string }[];
  alreadyRaised: string[];
  nextOn: string;
}

/**
 * Raise the invoices a subscription owes, one per scheduled period.
 *
 * Each is a real document: it goes into the store the rest of the product
 * reads invoices from, and it posts through the receivables subledger like any
 * other. A period already raised is reported rather than raised again — the
 * unique index would refuse it anyway, and catching it here means a run that
 * was interrupted halfway can simply be run again.
 */
export async function issueDue(opts: {
  orgId: string;
  entityId: string;
  code: string;
  asOf?: Date | string;
  actorId?: string;
}): Promise<IssueResult> {
  const t = await templateOf(opts, opts.code);
  if (t.status !== "active") {
    throw new LedgerError(`${t.code} is ${t.status}, so nothing is due from it.`);
  }

  const asOf = opts.asOf ? asDate(opts.asOf, "The run date") : new Date();
  const lines = invoiceLines(readLines(t.lines, t.code), t.code);
  const totals = computeTotals(lines);

  const raised: IssueResult["raised"] = [];
  const alreadyRaised: string[] = [];
  let scheduled = t.nextOn;
  let count = t.issuedCount;

  while (scheduled <= asOf && (!t.endsOn || scheduled <= t.endsOn)) {
    const existing = await prisma.recurringInvoiceIssue.findFirst({
      where: { templateId: t.id, scheduledOn: scheduled },
      select: { invoiceNumber: true },
    });
    if (existing) {
      alreadyRaised.push(iso(scheduled));
      scheduled = nextDate(scheduled, t.frequency as Frequency);
      continue;
    }

    count++;
    const invoiceId = `${t.id}-${iso(scheduled)}`;
    const number = `${t.code}-${String(count).padStart(4, "0")}`;
    const dueDate = new Date(scheduled.getTime() + t.paymentTerms * 86_400_000);

    const invoice: Invoice = {
      id: invoiceId,
      orgId: opts.orgId,
      entityId: opts.entityId,
      direction: "OUTBOUND",
      docType: "TAX_INVOICE",
      number,
      issueDate: iso(scheduled),
      supplyDate: iso(scheduled),
      dueDate: iso(dueDate),
      currency: t.currency,
      customerId: t.customerCode ?? undefined,
      buyer: { nameEn: t.customerName, trn: t.customerTrn ?? undefined },
      seller: { nameEn: "" },
      lines,
      totals,
      lifecycleStatus: "READY",
      exchangeStatus: "NOT_SENT",
      reportingStatusC2: "NOT_REPORTED",
      source: "RULE",
      compliance: { taxableEventDate: iso(scheduled), daysRemaining: 14, breached: false },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as Invoice;

    // The document first, then the posting. An invoice that reached the ledger
    // without reaching the store would be a receivable with nothing behind it.
    await prisma.record.upsert({
      where: { store_id: { store: "invoices", id: invoiceId } },
      create: {
        store: "invoices", id: invoiceId, orgId: opts.orgId, entityId: opts.entityId,
        invoiceId, data: JSON.stringify(invoice),
      },
      update: { data: JSON.stringify(invoice) },
    });

    const posted = await postInvoice({ orgId: opts.orgId, invoice, actorId: opts.actorId, actorType: "RULE" });

    await prisma.recurringInvoiceIssue.create({
      data: {
        orgId: opts.orgId, templateId: t.id,
        scheduledOn: scheduled, issuedOn: new Date(),
        invoiceId, invoiceNumber: number, totalMinor: BigInt(totals.payableMinor),
      },
    });

    raised.push({
      invoiceId, number, scheduledOn: iso(scheduled),
      totalMinor: BigInt(totals.payableMinor),
      reference: posted.reference,
    });
    scheduled = nextDate(scheduled, t.frequency as Frequency);
  }

  const ended = Boolean(t.endsOn && scheduled > t.endsOn);
  await prisma.recurringInvoice.update({
    where: { id: t.id },
    data: {
      nextOn: scheduled,
      issuedCount: count,
      ...(raised.length ? { lastIssuedOn: new Date() } : {}),
      ...(ended ? { status: "ended" } : {}),
    },
  });

  return { code: t.code, raised, alreadyRaised, nextOn: iso(scheduled) };
}

/** Every subscription due as at a date, raised in one pass. */
export async function issueAllDue(opts: {
  orgId: string; entityId: string; asOf?: Date | string; actorId?: string;
}) {
  const { due } = await dueSubscriptions(opts);
  const results: IssueResult[] = [];
  for (const d of due) results.push(await issueDue({ ...opts, code: d.code }));
  return {
    results,
    invoicesRaised: results.reduce((a, r) => a + r.raised.length, 0),
    totalMinor: results.reduce((a, r) => a + r.raised.reduce((b, x) => b + x.totalMinor, 0n), 0n),
  };
}

/* -------------------------------------------------------------- the screen */

export async function subscriptionRegister(opts: { orgId: string; entityId: string; asOf?: Date | string }) {
  const asOf = opts.asOf ? asDate(opts.asOf, "The date") : new Date();
  const templates = await prisma.recurringInvoice.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    include: { issued: { orderBy: { scheduledOn: "desc" }, take: 6 } },
    orderBy: [{ status: "asc" }, { code: "asc" }],
  });

  const rows = templates.map((t) => {
    const lines = invoiceLines(readLines(t.lines, t.code), t.code);
    const totals = computeTotals(lines);
    return {
      code: t.code,
      customerName: t.customerName,
      frequency: t.frequency,
      status: t.status,
      startsOn: iso(t.startsOn),
      endsOn: t.endsOn ? iso(t.endsOn) : null,
      nextOn: iso(t.nextOn),
      overdue: t.status === "active" && t.nextOn <= asOf,
      perInvoiceMinor: BigInt(totals.payableMinor),
      issuedCount: t.issuedCount,
      billedMinor: t.issued.reduce((a, i) => a + i.totalMinor, 0n),
      recent: t.issued.map((i) => ({
        scheduledOn: iso(i.scheduledOn),
        number: i.invoiceNumber,
        totalMinor: i.totalMinor,
        invoiceId: i.invoiceId,
      })),
    };
  });

  const active = rows.filter((r) => r.status === "active");
  return {
    asOf: iso(asOf),
    subscriptions: rows,
    summary: {
      activeCount: active.length,
      overdueCount: active.filter((r) => r.overdue).length,
      /**
       * What the active subscriptions bill in a year, at today's prices. It is
       * the figure a subscription business is actually run on, and it is not
       * in any statement — the statements say what was billed, not what will
       * be.
       */
      annualisedMinor: active.reduce((a, r) => {
        const perYear = r.frequency === "WEEKLY" ? 52n : r.frequency === "MONTHLY" ? 12n : r.frequency === "QUARTERLY" ? 4n : 1n;
        return a + r.perInvoiceMinor * perYear;
      }, 0n),
    },
  };
}
