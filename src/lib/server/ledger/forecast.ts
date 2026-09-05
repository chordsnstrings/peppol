import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { receivablesAgeing, type OpenItem } from "./ar";
import { payablesAgeing } from "./ap";
import { templateStatus, parseTemplateLines, templateTotal } from "./recurring";
import { cashCodes } from "./cash";
import { lastCompletedPeriod } from "./tax-periods";

/**
 * A cash flow forecast.
 *
 * The cash flow statement says where the money went. This says where it is
 * going, which is a different question and the one a business actually loses
 * sleep over: not "was last quarter profitable" but "can I make payroll on the
 * twenty-fifth".
 *
 * Everything here is a projection, and the module is built so that nobody can
 * mistake it for a fact. Every line carries where it came from and how firm it
 * is — `committed` for money the business has already agreed to move, `expected`
 * for an invoice that will probably be paid on its terms, `estimated` for a
 * recurring charge that has not been raised yet. A forecast that presents all
 * three in the same weight is a forecast that gets believed and then blamed.
 *
 * The one piece of judgement it offers is behaviour. A customer's terms say
 * when an invoice falls due; the ledger says when that customer has actually
 * paid, every time before. Forecasting on terms alone is forecasting on a
 * promise nobody has kept — so the caller may ask for the expected date to be
 * shifted by each customer's own record. It is opt-in, it is labelled on every
 * line it moves, and the number of past payments it is drawn from is returned
 * with it, because an average of one is not an average.
 */

export type Firmness = "committed" | "expected" | "estimated";

export interface ForecastLine {
  /** The day the money is expected to move. */
  on: string;
  /** Positive is money in, negative is money out. */
  amountMinor: bigint;
  label: string;
  /** ar | ap | payment_run | recurring | lease | vat */
  source: string;
  firmness: Firmness;
  /** The document, template or run this came from. */
  ref: string | null;
  /** Set where the date was moved from the due date by past behaviour. */
  shiftedDays?: number;
}

export interface ForecastBucket {
  /** The first day of the bucket. */
  from: string;
  to: string;
  inMinor: bigint;
  outMinor: bigint;
  netMinor: bigint;
  /** Cash at the end of the bucket, opening balance carried through. */
  closingMinor: bigint;
  lines: ForecastLine[];
}

export interface Forecast {
  from: string;
  to: string;
  bucket: "week" | "month";
  currency: string;
  openingMinor: bigint;
  buckets: ForecastBucket[];
  closingMinor: bigint;
  /** The first day the projection goes below nothing, if it ever does. */
  shortfallOn: string | null;
  shortfallMinor: bigint | null;
  /** What could not be projected, and why — never silently dropped. */
  gaps: { source: string; reason: string }[];
  basis: "due" | "behaviour";
}

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/** Terms fall back to thirty days, the only default this product applies. */
const TERM_DAYS = 30;

/** The FTA gives 28 days after a tax period to file and pay. */
const VAT_FILING_DAYS = 28;

function dueOf(o: OpenItem): Date {
  return o.dueDate ? day(o.dueDate) : addDays(day(o.date), TERM_DAYS);
}

/* ------------------------------------------------------------------- cash */

/**
 * What is in the bank and the tills as at a date.
 *
 * Read from the journal rather than the balance cache because a forecast is
 * asked for on an arbitrary day, and the cache is anchored to period ends.
 * Both halves of a reversed pair are counted, so a reversal nets to nothing
 * instead of moving the opening balance by its full amount.
 */
async function cashOnHand(opts: { orgId: string; entityId: string; asOf: Date }) {
  const accounts = await prisma.account.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId, status: "active",
      subtype: { in: ["BANK", "CASH"] },
    },
    select: { id: true, code: true, name: true },
  });
  if (!accounts.length) return { total: 0n, accounts: [] as { code: string; name: string; balanceMinor: bigint }[] };

  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      accountId: { in: accounts.map((a) => a.id) },
      entry: { status: { in: ["posted", "reversed"] }, entryDate: { lte: opts.asOf } },
    },
    select: { accountId: true, functionalAmountMinor: true },
  });

  const by = new Map(accounts.map((a) => [a.id, 0n]));
  for (const l of lines) by.set(l.accountId, (by.get(l.accountId) ?? 0n) + l.functionalAmountMinor);

  return {
    total: [...by.values()].reduce((a, b) => a + b, 0n),
    accounts: accounts.map((a) => ({ code: a.code, name: a.name, balanceMinor: by.get(a.id) ?? 0n })),
  };
}

/* -------------------------------------------------------------- behaviour */

export interface PaymentBehaviour {
  /** The open-item key the ledger settled. */
  counterparty: string;
  /** Mean days between falling due and being settled. Negative means early. */
  meanDays: number;
  /** How many settled documents that average is drawn from. */
  sample: number;
}

/**
 * How late each customer actually pays, from the ledger's own record.
 *
 * A settled item's payment date is the date of the last line that closed it —
 * not the first, because a part payment does not clear a debt. Items still
 * open are excluded: a debt nobody has paid yet says nothing about how long
 * payment takes, and including it as "not late yet" would drag every average
 * towards zero and make the forecast optimistic in exactly the way that hurts.
 */
export async function paymentBehaviour(opts: {
  orgId: string;
  entityId: string;
  /** Fewer settled documents than this and the average is not worth having. */
  minSample?: number;
}): Promise<{ overall: PaymentBehaviour; byMemo: Map<string, PaymentBehaviour> }> {
  const minSample = opts.minSample ?? 2;

  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "1100" },
    select: { id: true },
  });
  if (!account) throw new LedgerError("The receivables control account does not exist for this entity.");

  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      accountId: account.id,
      entry: { status: { in: ["posted", "reversed"] } },
    },
    select: {
      settlesId: true, functionalAmountMinor: true,
      entry: { select: { entryDate: true, dueDate: true, sourceId: true, settlesId: true, source: true, memo: true } },
    },
    orderBy: { entry: { entryDate: "asc" } },
  });

  interface Doc { memo: string; due: Date | null; opened: Date | null; outstanding: bigint; lastSettled: Date | null }
  const docs = new Map<string, Doc>();
  for (const l of lines) {
    const key = l.settlesId ?? l.entry.settlesId ?? l.entry.sourceId;
    if (!key) continue;
    const d = docs.get(key) ?? { memo: "", due: null, opened: null, outstanding: 0n, lastSettled: null };
    d.outstanding += l.functionalAmountMinor;
    if (l.entry.source === "invoice" && !d.opened) {
      d.opened = l.entry.entryDate;
      d.due = l.entry.dueDate;
      d.memo = l.entry.memo ?? "";
    } else if (l.functionalAmountMinor < 0n) {
      // A credit to receivables is money coming off the debt.
      d.lastSettled = l.entry.entryDate;
    }
    docs.set(key, d);
  }

  const samples: { memo: string; days: number }[] = [];
  for (const d of docs.values()) {
    if (d.outstanding !== 0n || !d.opened || !d.lastSettled) continue;
    const due = d.due ?? addDays(d.opened, TERM_DAYS);
    samples.push({ memo: d.memo, days: Math.round((d.lastSettled.getTime() - due.getTime()) / DAY) });
  }

  const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const overall: PaymentBehaviour = {
    counterparty: "*", meanDays: mean(samples.map((s) => s.days)), sample: samples.length,
  };

  // Grouped by the memo, which is the only party name a journal line carries.
  // It is a weak key and it is said so here rather than pretended otherwise:
  // where it does not group cleanly the overall average is used instead.
  const groups = new Map<string, number[]>();
  for (const s of samples) {
    if (!s.memo) continue;
    groups.set(s.memo, [...(groups.get(s.memo) ?? []), s.days]);
  }
  const byMemo = new Map<string, PaymentBehaviour>();
  for (const [memo, xs] of groups) {
    if (xs.length < minSample) continue;
    byMemo.set(memo, { counterparty: memo, meanDays: mean(xs), sample: xs.length });
  }

  return { overall, byMemo };
}

/* -------------------------------------------------------------- the lines */

/** Each source is gathered separately so one failing degrades its own row. */
type Source = {
  key: string;
  run(ctx: { orgId: string; entityId: string; from: Date; to: Date }): Promise<ForecastLine[]>;
};

const receivablesIn: Source = {
  key: "ar",
  async run({ orgId, entityId, from, to }) {
    const ageing = await receivablesAgeing({ orgId, entityId, asOf: from });
    return ageing.open
      .filter((o) => BigInt(o.outstandingMinor) > 0n)
      .map((o) => {
        const due = dueOf(o);
        // An invoice already past due is not expected on its due date — it is
        // expected as soon as anyone chases it, which is the day the forecast
        // starts. Dating it in the past would drop it out of every bucket.
        const on = due < from ? from : due;
        return {
          on: iso(on),
          amountMinor: BigInt(o.outstandingMinor),
          label: o.memo || o.sourceId,
          source: "ar",
          firmness: "expected" as Firmness,
          ref: o.sourceId,
        };
      })
      .filter((l) => day(l.on) <= to);
  },
};

const payablesOut: Source = {
  key: "ap",
  async run({ orgId, entityId, from, to }) {
    const ageing = await payablesAgeing({ orgId, entityId, asOf: from });
    return ageing.open
      .filter((o) => BigInt(o.outstandingMinor) > 0n)
      .map((o) => {
        const due = dueOf(o);
        const on = due < from ? from : due;
        return {
          on: iso(on),
          amountMinor: -BigInt(o.outstandingMinor),
          label: o.memo || o.sourceId,
          source: "ap",
          firmness: "expected" as Firmness,
          ref: o.sourceId,
        };
      })
      .filter((l) => day(l.on) <= to);
  },
};

const paymentRunsOut: Source = {
  key: "payment_run",
  async run({ orgId, entityId, from, to }) {
    // An approved run is money the business has decided to move and one
    // signature away from moving. That is committed, not expected — and it is
    // also already counted in payables, so the payables line for anything in
    // an approved run is removed by the caller rather than double-counted.
    const runs = await prisma.paymentRun.findMany({
      where: { orgId, entityId, status: "approved", runDate: { gte: from, lte: to } },
      include: { items: true },
    });
    return runs.map((r) => ({
      on: iso(r.runDate),
      amountMinor: -r.items.filter((i) => !i.excluded).reduce((a, i) => a + i.amountMinor, 0n),
      label: `Payment run ${r.reference}`,
      source: "payment_run",
      firmness: "committed" as Firmness,
      ref: r.id,
    })).filter((l) => l.amountMinor !== 0n);
  },
};

const recurringOut: Source = {
  key: "recurring",
  async run({ orgId, entityId, from, to }) {
    const status = await templateStatus({ orgId, entityId, asOf: iso(from).slice(0, 7) });
    // A template posting to a bank account this chart calls cash but the four
    // seeded codes do not was previously read as an accrual and forecast as no
    // movement at all — the one failure mode a cash forecast cannot have.
    const cashList = new Set(await cashCodes({ orgId, entityId }));
    const out: ForecastLine[] = [];

    for (const t of status.templates) {
      if (t.status !== "active" || !t.lines) continue;
      const cash = t.lines.filter((l) => cashList.has(l.account));
      if (!cash.length) continue;
      // Only the cash side matters to a forecast: an accrual moves no money.
      const amount = cash.reduce((a, l) => a + BigInt(l.debit ?? 0) - BigInt(l.credit ?? 0), 0n);
      if (amount === 0n) continue;

      // Monthly templates fall on the first of each month in the window; that
      // is when the period they post for begins, and a forecast this coarse
      // gains nothing from pretending to know the day.
      for (let d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); d <= to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
        if (d < from) continue;
        if (t.endsOn && d > day(t.endsOn)) break;
        out.push({
          on: iso(d),
          amountMinor: amount,
          label: `${t.code} ${t.name}`,
          source: "recurring",
          firmness: "estimated",
          ref: t.code,
        });
      }
    }
    return out;
  },
};

const vatOut: Source = {
  key: "vat",
  async run({ orgId, entityId, from, to }) {
    // What the books say is owed to the FTA right now, falling due 28 days
    // after the end of the quarter it sits in. The return has not been filed,
    // so this is an estimate — but it is the largest single payment most
    // small businesses make, and a forecast that leaves it out is worse than
    // no forecast at all.
    const accounts = await prisma.account.findMany({
      where: { orgId, entityId, code: { in: ["2100", "2110", "1350"] } },
      select: { id: true, code: true },
    });
    if (!accounts.length) return [];

    const lines = await prisma.journalLine.findMany({
      where: {
        orgId, accountId: { in: accounts.map((a) => a.id) },
        entry: { status: { in: ["posted", "reversed"] }, entryDate: { lte: from } },
      },
      select: { functionalAmountMinor: true },
    });
    // Output tax is a credit and input tax a debit, so the net owed is the
    // negated sum — nil or a debit means the FTA owes the business.
    const net = -lines.reduce((a, l) => a + l.functionalAmountMinor, 0n);
    if (net <= 0n) return [];

    // The FTA's period, not the calendar's. This was `Math.floor(month / 3)`,
    // which put a February-stagger taxpayer's VAT payment a month out — in a
    // cash forecast, where the whole value is knowing which week the money
    // leaves.
    const period = await lastCompletedPeriod({ orgId, entityId, regime: "VAT", asOf: from });
    const due = new Date(`${period.dueOn}T00:00:00.000Z`);
    if (due > to) return [];

    return [{
      on: period.dueOn,
      amountMinor: -net,
      label: `VAT for the period to ${period.to}`,
      source: "vat",
      firmness: "estimated" as Firmness,
      ref: null,
    }];
  },
};


const SOURCES: Source[] = [receivablesIn, payablesOut, paymentRunsOut, recurringOut, vatOut];

/* ---------------------------------------------------------- the forecast */

export async function cashForecast(opts: {
  orgId: string;
  entityId: string;
  from: string;
  to: string;
  bucket?: "week" | "month";
  /** "behaviour" shifts each expected receipt by how late that customer pays. */
  basis?: "due" | "behaviour";
}): Promise<Forecast> {
  const from = day(opts.from);
  const to = day(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new LedgerError("A forecast needs two dates it can read.");
  }
  if (to <= from) throw new LedgerError("A forecast has to end after it begins.");
  if (to.getTime() - from.getTime() > 400 * DAY) {
    throw new LedgerError("A forecast beyond about a year is arithmetic, not information. Ask for a shorter window.");
  }

  const bucket = opts.bucket ?? "week";
  const basis = opts.basis ?? "due";

  const book = await prisma.book.findFirst({ where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" } });
  if (!book) throw new LedgerError("No ledger has been opened for this entity.");

  const opening = await cashOnHand({ orgId: opts.orgId, entityId: opts.entityId, asOf: from });

  const gaps: { source: string; reason: string }[] = [];
  const gathered = await Promise.all(
    SOURCES.map(async (s) => {
      try {
        return await s.run({ orgId: opts.orgId, entityId: opts.entityId, from, to });
      } catch (e) {
        // One source failing must degrade its own row rather than blank the
        // forecast: a business with no recurring journals should still see
        // its receivables.
        gaps.push({ source: s.key, reason: e instanceof Error ? e.message : "could not be read" });
        return [] as ForecastLine[];
      }
    }),
  );
  let lines = gathered.flat();

  // A bill inside an approved payment run is already counted as committed, so
  // its payables line would pay it twice.
  const inRuns = new Set(
    (await prisma.paymentRunItem.findMany({
      where: { orgId: opts.orgId, excluded: false, run: { entityId: opts.entityId, status: "approved" } },
      select: { billId: true },
    })).map((i) => i.billId).filter((x): x is string => !!x),
  );
  if (inRuns.size) lines = lines.filter((l) => !(l.source === "ap" && l.ref && inRuns.has(l.ref)));

  if (basis === "behaviour") {
    const behaviour = await paymentBehaviour({ orgId: opts.orgId, entityId: opts.entityId });
    lines = lines.map((l) => {
      if (l.source !== "ar") return l;
      const b = behaviour.byMemo.get(l.label) ?? (behaviour.overall.sample >= 2 ? behaviour.overall : null);
      if (!b || b.meanDays === 0) return l;
      const moved = addDays(day(l.on), b.meanDays);
      return { ...l, on: iso(moved < from ? from : moved), shiftedDays: b.meanDays };
    });
  }

  const buckets = buildBuckets(from, to, bucket);
  for (const l of lines) {
    const at = day(l.on);
    const b = buckets.find((x) => at >= day(x.from) && at <= day(x.to));
    // A line pushed past the window by behaviour is money that will not arrive
    // inside it. Dropping it is the honest answer; folding it into the last
    // bucket would flatter the closing balance.
    if (b) b.lines.push(l);
  }

  let running = opening.total;
  let shortfallOn: string | null = null;
  let shortfallMinor: bigint | null = null;
  for (const b of buckets) {
    b.lines.sort((x, y) => x.on.localeCompare(y.on) || x.label.localeCompare(y.label));
    b.inMinor = b.lines.filter((l) => l.amountMinor > 0n).reduce((a, l) => a + l.amountMinor, 0n);
    b.outMinor = b.lines.filter((l) => l.amountMinor < 0n).reduce((a, l) => a + l.amountMinor, 0n);
    b.netMinor = b.inMinor + b.outMinor;
    running += b.netMinor;
    b.closingMinor = running;
    if (running < 0n && shortfallOn === null) {
      shortfallOn = b.to;
      shortfallMinor = running;
    }
  }

  return {
    from: opts.from, to: opts.to, bucket, basis,
    currency: book.functionalCurrency,
    openingMinor: opening.total,
    buckets,
    closingMinor: running,
    shortfallOn,
    shortfallMinor,
    gaps,
  };
}

function buildBuckets(from: Date, to: Date, bucket: "week" | "month"): ForecastBucket[] {
  const out: ForecastBucket[] = [];
  let start = from;
  while (start <= to) {
    const end = bucket === "week"
      ? addDays(start, 6)
      : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    const capped = end > to ? to : end;
    out.push({
      from: iso(start), to: iso(capped),
      inMinor: 0n, outMinor: 0n, netMinor: 0n, closingMinor: 0n, lines: [],
    });
    start = addDays(capped, 1);
  }
  return out;
}

/** The cash position now, for the header of the screen. */
export async function cashPosition(opts: { orgId: string; entityId: string; asOf?: string }) {
  const asOf = opts.asOf ? day(opts.asOf) : new Date();
  const cash = await cashOnHand({ orgId: opts.orgId, entityId: opts.entityId, asOf });
  return { asOf: iso(asOf), totalMinor: cash.total, accounts: cash.accounts };
}
