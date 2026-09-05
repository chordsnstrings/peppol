import { prisma } from "@/lib/server/prisma";
import { Prisma } from "@prisma/client";
import { fmtMinor } from "@/lib/ledger/format";

/**
 * The posting service — the ONLY path by which anything reaches the general
 * ledger. Documents (invoices, bills, payments, payroll runs) are one thing;
 * posting them is a separate, idempotent act that happens here.
 *
 * Amounts are signed integer minor units throughout: a debit is positive, a
 * credit is negative, so "balanced" is literally sum === 0n. No floats ever
 * touch a ledger amount.
 *
 * The database enforces the invariants independently (see the ledger_core
 * migration). The checks here exist to fail fast with a message a human can
 * act on — they are not the guarantee.
 */

export class LedgerError extends Error {
  status = 422;
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

export interface PostLine {
  /** Account code within the entity's chart, e.g. "1000". */
  account: string;
  /**
   * Supply exactly one of debit / credit, in minor units. A decimal string is
   * accepted (and is what the HTTP API sends) because minor units past 2^53
   * cannot survive JSON as a number.
   */
  debit?: number | bigint | string;
  credit?: number | bigint | string;
  /** Transaction currency; defaults to the book's functional currency. */
  currency?: string;
  /** Rate to the functional currency. Required when currency differs. */
  fxRate?: number;
  memo?: string;
  /**
   * The tax treatment this line was raised under (STANDARD_5, ZERO_EXPORT,
   * REVERSE_CHARGE …). The VAT return groups by it, which is what lets the
   * return be computed from the ledger instead of from a second pass over the
   * documents — the two then cannot disagree.
   */
  taxCode?: string;
  /** Emirate of supply; the VAT 201 splits standard-rated supplies by it. */
  taxEmirate?: string;
  /**
   * The open item this line settles. Use it where one entry discharges several
   * documents — a batch payment run. `PostInput.settlesId` names one document
   * for the whole entry, which cannot express that, and an open item that
   * still looks outstanding is one that gets paid twice.
   */
  settlesId?: string;
  /** { dimensionCode: valueCode }, e.g. { COST_CENTRE: "OPS" }. */
  dimensions?: Record<string, string>;
}

export interface PostInput {
  orgId: string;
  entityId: string;
  bookCode?: string;
  entryDate: Date | string;
  /**
   * When the document falls due, where it has terms. Ageing falls back to the
   * entry date without it, which assumes every counterparty is on the same
   * terms — and chases the ones who are not.
   */
  dueDate?: Date | string | null;
  memo?: string;
  /**
   * Post into a named period rather than the one the date falls in.
   *
   * The year-end adjustment period deliberately overlaps the last trading
   * month — that is what makes it an adjustment period — so a date alone
   * cannot say which of the two an entry belongs to. Only a year-end close
   * should need this; everything else is answered by the date.
   */
  periodId?: string;
  /** manual | invoice | bill | payment | bank | payroll | depreciation | fx */
  source?: string;
  sourceType?: string;
  sourceId?: string;
  /** Idempotency key — a retry with the same key returns the original entry. */
  externalKey?: string;
  /**
   * Set when this entry reverses another. It goes in at INSERT rather than
   * being patched on afterwards, because a posted entry is immutable — the
   * link is part of what the entry *is*, not a later edit to it.
   */
  reversalOfId?: string;
  /**
   * The document this entry settles. `sourceId` says what caused the entry
   * (the receipt); `settlesId` says what it discharges (the invoice). Open-item
   * ageing nets a document's postings by this.
   */
  settlesId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
  actorId?: string;
  series?: string;
  lines: PostLine[];
}

const asDate = (d: Date | string) => (typeof d === "string" ? new Date(d) : d);

/** Signed minor units from a debit/credit pair. */
function signed(line: PostLine): bigint {
  const hasD = line.debit !== undefined && line.debit !== null;
  const hasC = line.credit !== undefined && line.credit !== null;
  if (hasD === hasC) {
    throw new LedgerError(`Line on account ${line.account} must carry exactly one of debit or credit.`);
  }
  const raw = hasD ? line.debit! : line.credit!;
  if (typeof raw === "number" && !Number.isInteger(raw)) {
    throw new LedgerError(`Amount on account ${line.account} must be in whole minor units, got ${raw}.`);
  }
  if (typeof raw === "string" && !/^-?\d+$/.test(raw.trim())) {
    throw new LedgerError(`Amount on account ${line.account} must be in whole minor units, got "${raw}".`);
  }
  const v = BigInt(typeof raw === "string" ? raw.trim() : raw);
  if (v < 0n) throw new LedgerError(`Use the debit/credit side rather than a negative amount on account ${line.account}.`);
  if (v === 0n) throw new LedgerError(`A zero amount on account ${line.account} carries no information.`);
  return hasD ? v : -v;
}

/** Convert a transaction amount into the functional currency, half-up, no floats. */
function toFunctional(amount: bigint, rate: number): bigint {
  if (rate === 1) return amount;
  if (!(rate > 0) || !Number.isFinite(rate)) throw new LedgerError(`Exchange rate must be a positive number, got ${rate}.`);
  // Scale the rate to an integer to keep the multiplication exact.
  const SCALE = 1_000_000_000n;
  const scaled = BigInt(Math.round(rate * 1e9));
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const half = SCALE / 2n;
  const out = (abs * scaled + half) / SCALE;
  return neg ? -out : out;
}

/**
 * Post a balanced journal entry. Atomic: the number allocation, the entry, its
 * lines and the balance cache all commit together or not at all.
 */
/**
 * The database raises `ledger: …` for every invariant it enforces. Surface those
 * as LedgerError so a guard we have not mirrored in application code still
 * reaches the user as an actionable message rather than a generic 500.
 */
function rethrowLedgerErrors(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /ledger:\s*([^\n"]+)/.exec(msg);
  if (m) throw new LedgerError(m[1].trim().replace(/^entry \S+ /, "This entry "));
  throw e;
}

export async function post(input: PostInput) {
  const {
    orgId, entityId, bookCode = "PRIMARY", entryDate, dueDate, memo, source = "manual",
    sourceType, sourceId, externalKey, reversalOfId, settlesId, periodId,
    actorType = "HUMAN", actorId, series = "GJ", lines,
  } = input;

  if (!lines || lines.length < 2) throw new LedgerError("A journal entry needs at least two lines.");

  // Idempotency: a retried post must not double-post.
  if (externalKey) {
    const existing = await prisma.journalEntry.findFirst({
      where: { orgId, externalKey },
      include: { lines: true },
    });
    if (existing) return existing;
  }

  const date = asDate(entryDate);
  const due = dueDate == null ? null : asDate(dueDate);
  if (due && due < date) {
    throw new LedgerError(
      `${iso(due)} is before ${iso(date)}. A document cannot fall due before it is raised — check which way round the dates went in.`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const book = await tx.book.findFirst({ where: { orgId, entityId, code: bookCode } });
    if (!book) throw new LedgerError(`No book "${bookCode}" for this entity. Set up the chart of accounts first.`);

    const period = periodId
      ? await tx.accountingPeriod.findFirst({ where: { id: periodId, orgId, entityId } })
      : // Ordinary postings never land in an adjustment period by accident: it
        // overlaps the last trading month, so ordering puts the real month
        // first and a caller has to ask for the other one by name.
        await tx.accountingPeriod.findFirst({
          where: { orgId, entityId, startsOn: { lte: date }, endsOn: { gte: date } },
          orderBy: [{ isAdjustment: "asc" }, { seq: "asc" }],
        });
    if (!period) {
      throw new LedgerError(
        periodId
          ? "That accounting period does not exist for this entity."
          : `No accounting period covers ${date.toISOString().slice(0, 10)}. Open the fiscal year first.`,
      );
    }
    if (period.status !== "open") {
      throw new LedgerError(`Period ${period.label} is ${period.status.replace("_", " ")}. Post to an open period, or reopen it.`);
    }

    // Resolve accounts by code in one query.
    const codes = [...new Set(lines.map((l) => l.account))];
    const accounts = await tx.account.findMany({ where: { orgId, entityId, code: { in: codes } } });
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    for (const c of codes) if (!byCode.has(c)) throw new LedgerError(`Account ${c} does not exist in this entity's chart.`);

    // Resolve dimension codes → value ids.
    const dimPairs = lines.flatMap((l) => Object.entries(l.dimensions ?? {}));
    const dimValues = new Map<string, { dimensionId: string; valueId: string; status: string; name: string }>();
    if (dimPairs.length) {
      const dims = await tx.dimension.findMany({
        where: { orgId, code: { in: [...new Set(dimPairs.map(([d]) => d))] } },
        include: { values: true },
      });
      for (const d of dims) {
        // Archived values are still resolvable, so a posting can be refused by
        // name rather than reported as an unknown value — "SITE_A is closed" is
        // a different problem from "there is no SITE_A", and telling someone
        // the wrong one sends them to create a duplicate.
        for (const v of d.values) {
          dimValues.set(`${d.code}:${v.code}`, { dimensionId: d.id, valueId: v.id, status: v.status, name: v.name });
        }
      }
      const known = new Set(dims.map((x) => x.code));
      for (const [d, v] of dimPairs) {
        // Blaming the value when the dimension itself is unknown sends someone
        // looking in the wrong place entirely.
        if (!known.has(d)) {
          throw new LedgerError(
            `There is no dimension called "${d}" in this organisation. ` +
              `Create it before posting against it, or check the spelling.`,
          );
        }
        const found = dimValues.get(`${d}:${v}`);
        if (!found) {
          const options = dims
            .find((x) => x.code === d)?.values.filter((x) => x.status === "active").map((x) => x.code).slice(0, 6) ?? [];
          throw new LedgerError(
            `"${v}" is not a value of ${d}.` + (options.length ? ` The ones that exist are ${options.join(", ")}.` : ""),
          );
        }
        // An archived value is a closed cost centre or a finished job. Letting
        // a late posting land on one is how cost quietly arrives against work
        // that was reported as complete.
        if (found.status !== "active") {
          throw new LedgerError(
            `${d} value "${v}"${found.name ? ` (${found.name})` : ""} has been closed, so nothing further can be ` +
              `posted against it. Reopen it, or post to an open one.`,
          );
        }
      }
    }

    // Normalise lines and prove the entry balances before touching the database.
    const prepared = lines.map((l, i) => {
      const account = byCode.get(l.account)!;
      const txnAmountMinor = signed(l);
      const currency = l.currency ?? book.functionalCurrency;
      const fxRate = currency === book.functionalCurrency ? 1 : l.fxRate ?? 0;
      if (currency !== book.functionalCurrency && !fxRate) {
        throw new LedgerError(`Line ${i + 1} is in ${currency}; supply an fxRate to ${book.functionalCurrency}.`);
      }
      if (account.requiresDimension && !(l.dimensions ?? {})[account.requiresDimension]) {
        throw new LedgerError(`Account ${account.code} requires a ${account.requiresDimension}.`);
      }
      // These are enforced by the database too; checking here means the message
      // names the account and tells the user what to do instead of raising a 500.
      if (!account.isPostable) {
        throw new LedgerError(`${account.code} ${account.name} is a heading, not a postable account. Choose one of its sub-accounts.`);
      }
      if (account.status !== "active") {
        throw new LedgerError(`Account ${account.code} ${account.name} is archived.`);
      }
      if (account.isControl && source === "manual") {
        throw new LedgerError(`${account.code} ${account.name} is a control account — it is maintained by its subledger. Raise the underlying document instead of a manual journal.`);
      }
      if (account.currency && account.currency !== currency) {
        throw new LedgerError(`Account ${account.code} ${account.name} only accepts ${account.currency}.`);
      }
      return {
        lineNo: i + 1,
        orgId,
        accountId: account.id,
        txnCurrency: currency,
        txnAmountMinor,
        fxRate: new Prisma.Decimal(fxRate),
        functionalCurrency: book.functionalCurrency,
        functionalAmountMinor: toFunctional(txnAmountMinor, fxRate),
        memo: l.memo ?? null,
        taxCode: l.taxCode ?? null,
        taxEmirate: l.taxEmirate ?? null,
        settlesId: l.settlesId ?? null,
        dims: Object.entries(l.dimensions ?? {}).map(([d, v]) => dimValues.get(`${d}:${v}`)!),
      };
    });

    // A cross-currency entry (say, USD received into an AED ledger) is one
    // economic event whose sides are in different currencies; it balances only
    // after conversion. So the invariant is the functional-currency balance.
    // For a single-currency entry we also check that currency directly, purely
    // because it yields a far better message for the common mistake.
    const currencies = new Set(prepared.map((p) => p.txnCurrency));
    if (currencies.size === 1) {
      const [cur] = [...currencies];
      const sum = prepared.reduce((a, p) => a + p.txnAmountMinor, 0n);
      if (sum !== 0n) {
        throw new LedgerError(`Entry does not balance in ${cur}: it is out by ${fmt(sum, cur)}. Debits must equal credits.`);
      }
    }
    const fnSum = prepared.reduce((a, p) => a + p.functionalAmountMinor, 0n);
    if (fnSum !== 0n) {
      throw new LedgerError(`Entry does not balance in ${book.functionalCurrency} after conversion (out by ${fmt(fnSum, book.functionalCurrency)}). Check the exchange rates — a cross-currency entry balances once converted.`);
    }

    const [{ n: number }] = await tx.$queryRaw<{ n: string }[]>`
      SELECT gl_next_number(${orgId}, ${entityId}, ${series}) AS n`;

    const entry = await tx.journalEntry.create({
      data: {
        orgId, entityId, bookId: book.id, periodId: period.id, series, number,
        entryDate: date, dueDate: due, status: "posted", memo: memo ?? null,
        source, sourceType: sourceType ?? null, sourceId: sourceId ?? null,
        externalKey: externalKey ?? null, reversalOfId: reversalOfId ?? null,
        settlesId: settlesId ?? null,
        actorType, actorId: actorId ?? null,
        lines: {
          create: prepared.map((p) => ({
            lineNo: p.lineNo, orgId: p.orgId, accountId: p.accountId,
            txnCurrency: p.txnCurrency, txnAmountMinor: p.txnAmountMinor, fxRate: p.fxRate,
            functionalCurrency: p.functionalCurrency, functionalAmountMinor: p.functionalAmountMinor,
            memo: p.memo, taxCode: p.taxCode, taxEmirate: p.taxEmirate, settlesId: p.settlesId,
            dimensions: { create: p.dims.map((d) => ({ dimensionId: d.dimensionId, valueId: d.valueId })) },
          })),
        },
      },
      include: { lines: true },
    });

    await bumpBalances(tx, { orgId, entityId, bookId: book.id, periodId: period.id }, prepared);
    return entry;
  }).catch(rethrowLedgerErrors);
}

/**
 * Correction is reversal-only: the original entry stays exactly as posted and a
 * mirror-image entry is posted against it. This is what makes the ledger
 * defensible in an audit.
 */
export async function reverse(opts: {
  orgId: string;
  entryId: string;
  entryDate?: Date | string;
  memo?: string;
  actorId?: string;
}) {
  const original = await prisma.journalEntry.findFirst({
    where: { id: opts.entryId, orgId: opts.orgId },
    include: {
      lines: {
        include: {
          account: true,
          // The reversal has to rebuild the line's dimensions, so the codes
          // have to come back with it — see the note where they are copied.
          dimensions: { include: { value: { include: { dimension: true } } } },
        },
        orderBy: { lineNo: "asc" },
      },
      book: true,
    },
  });
  if (!original) throw new LedgerError("That journal entry does not exist.");
  if (original.status !== "posted") throw new LedgerError(`Only a posted entry can be reversed; this one is ${original.status}.`);

  const reversal = await post({
    orgId: original.orgId,
    entityId: original.entityId,
    bookCode: original.book.code,
    entryDate: opts.entryDate ?? original.entryDate,
    memo: opts.memo ?? `Reversal of ${original.series}-${original.number}`,
    source: original.source,
    sourceType: original.sourceType ?? undefined,
    sourceId: original.sourceId ?? undefined,
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: original.series,
    reversalOfId: original.id,
    lines: original.lines.map((l) => {
      const flipped = -l.txnAmountMinor;
      return {
        account: l.account.code,
        ...(flipped > 0n ? { debit: flipped } : { credit: -flipped }),
        currency: l.txnCurrency,
        fxRate: Number(l.fxRate),
        memo: l.memo ?? undefined,
        // The reversal has to carry the tax treatment too, or reversing an
        // invoice would quietly leave its supply on the VAT return.
        taxCode: l.taxCode ?? undefined,
        taxEmirate: l.taxEmirate ?? undefined,
        // And which open item the line settled: without it, reversing a batch
        // payment would credit the bank back but leave the bills discharged.
        settlesId: l.settlesId ?? undefined,
        // And its dimensions, for two reasons. Without them a cost-centre
        // report is right in total and wrong in every column — the cost stays
        // against the department and the credit lands in Unallocated, and
        // because the total still reconciles nothing catches it. Worse, an
        // account marked requiresDimension could not be reversed at all: post()
        // would refuse its own reversal, making correction impossible on
        // exactly the accounts carrying the strongest control.
        dimensions: l.dimensions.length
          ? Object.fromEntries(l.dimensions.map((d) => [d.value.dimension.code, d.value.code]))
          : undefined,
      };
    }),
  });

  // The only mutation a posted entry ever receives: posted → reversed.
  await prisma.journalEntry.update({ where: { id: original.id }, data: { status: "reversed" } });

  return reversal;
}

/* ------------------------------------------------------------------ helpers */

/** A date as the reader wrote it, for a message about two dates. */
function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

/**
 * An amount in the currency it is an amount of.
 *
 * This used to split the digits two from the right whatever the currency was,
 * which is right for a dirham and wrong by a factor of ten for a Kuwaiti or
 * Bahraini dinar or an Omani rial — all three of which have three decimals.
 * The two messages below name the currency in the same sentence, so an entry a
 * fils out in KWD said "out by 0.01" two words after the word KWD, and the
 * bookkeeper hunting a one-fils rounding difference was hunting the wrong
 * figure. `fmtMinor` is the one function that knows each currency's exponent.
 */
function fmt(minor: bigint, currency: string) {
  return fmtMinor(minor, currency, { sign: "minus", zero: "zero" });
}

function tallyBy<T>(rows: T[], key: (r: T) => string, val: (r: T) => bigint) {
  const m = new Map<string, bigint>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0n) + val(r));
  return m;
}

/**
 * Balances are maintained incrementally at post time and anchored per period.
 * A balance is never derived by summing the whole ledger — that is the query
 * that stops working at a few million lines.
 */
async function bumpBalances(
  tx: Prisma.TransactionClient,
  scope: { orgId: string; entityId: string; bookId: string; periodId: string },
  lines: { accountId: string; txnCurrency: string; txnAmountMinor: bigint; functionalCurrency: string; functionalAmountMinor: bigint }[],
) {
  type Agg = { accountId: string; currency: string; debit: bigint; credit: bigint };
  const agg = new Map<string, Agg>();
  const add = (accountId: string, currency: string, signedMinor: bigint) => {
    const k = `${accountId}|${currency}`;
    const e = agg.get(k) ?? { accountId, currency, debit: 0n, credit: 0n };
    if (signedMinor > 0n) e.debit += signedMinor;
    else e.credit += -signedMinor;
    agg.set(k, e);
  };

  for (const l of lines) {
    // The functional-currency row is the one the trial balance and the financial
    // statements read, so every line contributes to it — including the far side
    // of a cross-currency entry, which is exactly what stops the TB tying if you
    // cache in transaction currency instead.
    add(l.accountId, l.functionalCurrency, l.functionalAmountMinor);
    // Keep a transaction-currency row too, so a USD bank account can report its
    // USD balance rather than only its AED equivalent.
    if (l.txnCurrency !== l.functionalCurrency) add(l.accountId, l.txnCurrency, l.txnAmountMinor);
  }

  for (const e of agg.values()) {
    await tx.accountBalance.upsert({
      where: {
        bookId_accountId_periodId_currency: {
          bookId: scope.bookId, accountId: e.accountId, periodId: scope.periodId, currency: e.currency,
        },
      },
      create: {
        orgId: scope.orgId, entityId: scope.entityId, bookId: scope.bookId,
        accountId: e.accountId, periodId: scope.periodId, currency: e.currency,
        debitMinor: e.debit, creditMinor: e.credit, closingMinor: e.debit - e.credit,
      },
      update: {
        debitMinor: { increment: e.debit },
        creditMinor: { increment: e.credit },
        closingMinor: { increment: e.debit - e.credit },
      },
    });
  }
}
