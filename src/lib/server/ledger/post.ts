import { prisma } from "@/lib/server/prisma";
import { Prisma } from "@prisma/client";

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
  /** Supply exactly one of debit / credit, in minor units. */
  debit?: number | bigint;
  credit?: number | bigint;
  /** Transaction currency; defaults to the book's functional currency. */
  currency?: string;
  /** Rate to the functional currency. Required when currency differs. */
  fxRate?: number;
  memo?: string;
  /** { dimensionCode: valueCode }, e.g. { COST_CENTRE: "OPS" }. */
  dimensions?: Record<string, string>;
}

export interface PostInput {
  orgId: string;
  entityId: string;
  bookCode?: string;
  entryDate: Date | string;
  memo?: string;
  /** manual | invoice | bill | payment | bank | payroll | depreciation | fx */
  source?: string;
  sourceType?: string;
  sourceId?: string;
  /** Idempotency key — a retry with the same key returns the original entry. */
  externalKey?: string;
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
  const v = BigInt(raw);
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
export async function post(input: PostInput) {
  const {
    orgId, entityId, bookCode = "PRIMARY", entryDate, memo, source = "manual",
    sourceType, sourceId, externalKey, actorType = "HUMAN", actorId, series = "GJ", lines,
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

  return prisma.$transaction(async (tx) => {
    const book = await tx.book.findFirst({ where: { orgId, entityId, code: bookCode } });
    if (!book) throw new LedgerError(`No book "${bookCode}" for this entity. Set up the chart of accounts first.`);

    const period = await tx.accountingPeriod.findFirst({
      where: { orgId, entityId, startsOn: { lte: date }, endsOn: { gte: date } },
    });
    if (!period) {
      throw new LedgerError(`No accounting period covers ${date.toISOString().slice(0, 10)}. Open the fiscal year first.`);
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
    const dimValues = new Map<string, { dimensionId: string; valueId: string }>();
    if (dimPairs.length) {
      const dims = await tx.dimension.findMany({
        where: { orgId, code: { in: [...new Set(dimPairs.map(([d]) => d))] } },
        include: { values: true },
      });
      for (const d of dims) {
        for (const v of d.values) dimValues.set(`${d.code}:${v.code}`, { dimensionId: d.id, valueId: v.id });
      }
      for (const [d, v] of dimPairs) {
        if (!dimValues.has(`${d}:${v}`)) throw new LedgerError(`Unknown ${d} value "${v}".`);
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
        throw new LedgerError(`Entry does not balance in ${cur}: it is out by ${fmt(sum)}. Debits must equal credits.`);
      }
    }
    const fnSum = prepared.reduce((a, p) => a + p.functionalAmountMinor, 0n);
    if (fnSum !== 0n) {
      throw new LedgerError(`Entry does not balance in ${book.functionalCurrency} after conversion (out by ${fmt(fnSum)}). Check the exchange rates — a cross-currency entry balances once converted.`);
    }

    const [{ n: number }] = await tx.$queryRaw<{ n: string }[]>`
      SELECT gl_next_number(${orgId}, ${entityId}, ${series}) AS n`;

    const entry = await tx.journalEntry.create({
      data: {
        orgId, entityId, bookId: book.id, periodId: period.id, series, number,
        entryDate: date, status: "posted", memo: memo ?? null,
        source, sourceType: sourceType ?? null, sourceId: sourceId ?? null,
        externalKey: externalKey ?? null, actorType, actorId: actorId ?? null,
        lines: {
          create: prepared.map((p) => ({
            lineNo: p.lineNo, orgId: p.orgId, accountId: p.accountId,
            txnCurrency: p.txnCurrency, txnAmountMinor: p.txnAmountMinor, fxRate: p.fxRate,
            functionalCurrency: p.functionalCurrency, functionalAmountMinor: p.functionalAmountMinor,
            memo: p.memo,
            dimensions: { create: p.dims.map((d) => ({ dimensionId: d.dimensionId, valueId: d.valueId })) },
          })),
        },
      },
      include: { lines: true },
    });

    await bumpBalances(tx, { orgId, entityId, bookId: book.id, periodId: period.id }, prepared);
    return entry;
  });
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
    include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } }, book: true },
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
    lines: original.lines.map((l) => {
      const flipped = -l.txnAmountMinor;
      return {
        account: l.account.code,
        ...(flipped > 0n ? { debit: flipped } : { credit: -flipped }),
        currency: l.txnCurrency,
        fxRate: Number(l.fxRate),
        memo: l.memo ?? undefined,
      };
    }),
  });

  await prisma.$transaction([
    prisma.journalEntry.update({ where: { id: reversal.id }, data: { reversalOfId: original.id } }),
    prisma.journalEntry.update({ where: { id: original.id }, data: { status: "reversed" } }),
  ]);

  return reversal;
}

/* ------------------------------------------------------------------ helpers */

function fmt(minor: bigint) {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const s = abs.toString().padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
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
