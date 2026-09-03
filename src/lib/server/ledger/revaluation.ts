import { prisma } from "@/lib/server/prisma";
import { Prisma } from "@prisma/client";
import { post, LedgerError } from "./post";

/**
 * Period-end foreign currency revaluation.
 *
 * A receivable raised at USD 10,000 when the rate was 3.6730 sits in the books
 * at AED 36,730. At period end the rate is 3.6725, so the same USD 10,000 is
 * worth AED 36,725. The customer still owes USD 10,000 — nothing about the debt
 * changed — but what the entity expects to end up with in dirhams did, and
 * IAS 21.28 says that difference belongs in profit or loss in the period it
 * arises rather than waiting for the cash to land.
 *
 * Three rules drive everything below.
 *
 *  1. IAS 21.23(a): monetary items are retranslated at the closing rate.
 *     IAS 21.23(b): non-monetary items measured at historical cost are not —
 *     they stay at the rate on the transaction date. So inventory, fixed assets
 *     and prepayments are deliberately left alone, and saying so out loud (in
 *     `skipped`) is part of the answer, not an omission.
 *
 *  2. The adjustment moves the FUNCTIONAL carrying amount and nothing else. The
 *     transaction-currency balance is a fact about what is owed; if a
 *     revaluation could change it, the customer's debt would move every month
 *     the rate did. Every line this module posts is therefore in the book's
 *     functional currency, at rate 1 — see `runRevaluation`.
 *
 *  3. The difference is unrealised. It is reversed on the first day of the next
 *     period so the following period starts from the original carrying amount
 *     and the eventual settlement books the whole realised difference exactly
 *     once — see `reverseRevaluation` for why that is not optional here.
 *
 * Scaled-integer arithmetic throughout, mirroring `toFunctional` in post.ts.
 * A revaluation computed in floating point would produce a different answer
 * from the posting engine it is supposed to agree with.
 */

const FX_GAIN = "4950";
const FX_LOSS = "6800";
const SOURCE = "fx";
const SOURCE_TYPE = "FX_REVALUATION";
const REVERSAL_SOURCE_TYPE = "FX_REVALUATION_REVERSAL";
const SERIES = "FX";

/* ───────────────────────────────────────────────────── rate arithmetic ── */

/** 1e9, the same scale post.ts converts at. Both must round identically. */
const SCALE = 1_000_000_000n;

/**
 * A decimal rate string → an integer scaled by 1e9, half-up.
 *
 * The rate arrives as Decimal(20,10) and is turned into an integer here rather
 * than being passed through `Number`, because the whole point of storing it as
 * a decimal was that binary floating point cannot hold 3.6725 exactly.
 */
function rateToScaled(rate: string): bigint {
  const m = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(rate);
  if (!m) {
    throw new LedgerError(`"${rate}" is not a usable exchange rate. A rate looks like 3.6725.`);
  }
  const frac = (m[2] ?? "").padEnd(10, "0");
  let scaled = BigInt(m[1] + frac.slice(0, 9));
  if (Number(frac[9] ?? "0") >= 5) scaled += 1n;
  if (scaled === 0n) {
    throw new LedgerError(`A rate of ${rate} rounds to zero at nine decimal places, which would erase the balance it converts.`);
  }
  return scaled;
}

/**
 * Convert a transaction amount to the functional currency, half-up, no floats.
 * Deliberately the same algorithm as `toFunctional` in post.ts: the carrying
 * amount this is compared against was produced by that function, so any
 * difference in rounding would show up as a phantom revaluation difference.
 */
function convert(amountMinor: bigint, scaledRate: bigint): bigint {
  const neg = amountMinor < 0n;
  const abs = neg ? -amountMinor : amountMinor;
  const out = (abs * scaledRate + SCALE / 2n) / SCALE;
  return neg ? -out : out;
}

/* ─────────────────────────────────────────────────────── monetary items ── */

/**
 * What counts as monetary.
 *
 * IAS 21.8: "the essential feature of a monetary item is a right to receive (or
 * an obligation to deliver) a fixed or determinable number of units of
 * currency." Cash, bank, receivables, payables, tax balances, accruals and
 * loans all qualify — each of them is a claim on, or an obligation to hand
 * over, a number of dirhams that is already determined.
 *
 * Inventory, fixed assets and prepayments do not. A prepayment buys goods or
 * services, not currency; IFRIC 22 fixes it at the rate on the date the money
 * moved and leaves it there. Retranslating them would restate assets the entity
 * is never going to collect currency for, and would put a fictional gain in
 * profit or loss.
 */
const MONETARY_SUBTYPES = new Set([
  "CASH", "BANK", "AR", "AP",
  "VAT_INPUT", "VAT_OUTPUT", "VAT_RECEIVABLE", "VAT_PAYABLE",
  "PAYROLL", "EOSB", "CT_PAYABLE",
]);

const NON_MONETARY_SUBTYPES = new Map<string, string>([
  ["INVENTORY", "inventory is non-monetary — it is sold, not collected, so IAS 21.23(b) leaves it at the rate it was bought at"],
  ["FIXED_ASSET", "a fixed asset is non-monetary and stays at its historical rate (IAS 21.23(b))"],
  ["ACCUM_DEP", "accumulated depreciation follows the asset it is written against, which is non-monetary"],
  ["CWIP", "capital work in progress is non-monetary — it becomes an asset, never a receipt of currency"],
  ["GRNI", "goods received not invoiced measures stock on hand rather than a claim to currency; the obligation to pay for it sits in payables and is revalued there"],
]);

/**
 * The UAE chart carries no subtype on some accounts whose treatment is not in
 * doubt, so they are named here rather than left to a guess.
 */
// 2450 is the current portion of a borrowing and is as monetary as the 2500
// it was split out of. Leaving it out would retranslate a foreign-currency
// loan's long-term half and not its short-term half, which is worse than
// retranslating neither.
const MONETARY_CODES = new Set(["1150", "1400", "2050", "2060", "2450", "2500", "2600"]);

const NON_MONETARY_CODES = new Map<string, string>([
  ["1300", "a prepayment is a right to goods or services, not to currency — IFRIC 22 fixes it at the rate on the date it was paid"],
  ["1700", "a right-of-use asset is non-monetary and stays at its initial measurement rate"],
  ["2300", "a customer advance is consideration already received; IFRIC 22 fixes it at the receipt-date rate"],
]);

type Classification = { monetary: true } | { monetary: false; reason: string };

function classify(account: { code: string; type: string; subtype: string | null }): Classification {
  if (account.subtype && MONETARY_SUBTYPES.has(account.subtype)) return { monetary: true };
  if (account.subtype && NON_MONETARY_SUBTYPES.has(account.subtype)) {
    return { monetary: false, reason: NON_MONETARY_SUBTYPES.get(account.subtype)! };
  }
  if (MONETARY_CODES.has(account.code)) return { monetary: true };
  if (NON_MONETARY_CODES.has(account.code)) {
    return { monetary: false, reason: NON_MONETARY_CODES.get(account.code)! };
  }
  // Income and expenses are translated at the rate on the transaction date and
  // are never retranslated (IAS 21.21) — they are events, not balances. Equity
  // contributed in a foreign currency is non-monetary for the same reason.
  if (account.type === "INCOME" || account.type === "EXPENSE") {
    return { monetary: false, reason: "income and expenses are translated at the transaction-date rate and never retranslated (IAS 21.21)" };
  }
  if (account.type === "EQUITY") {
    return { monetary: false, reason: "contributed equity is non-monetary and stays at the rate it was contributed at" };
  }
  // Refusing to guess: revaluing an account whose nature is unknown is how a
  // fictional gain gets into profit or loss, and it would never be questioned
  // afterwards because the ledger would still balance.
  return {
    monetary: false,
    reason: `this account carries no subtype, so whether it is monetary cannot be decided from the chart. Give it a subtype (IAS 21.8: a monetary item is a right to receive, or an obligation to deliver, a determinable number of units of currency) and run the revaluation again`,
  };
}

/* ────────────────────────────────────────────────────────────── rates ── */

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Dates are handled as plain YYYY-MM-DD at UTC midnight, never as local time.
 * A revaluation dated 2026-03-31 in Dubai and 2026-03-30 in the database is a
 * period-end adjustment in the wrong period.
 */
function parseDay(value: string, what: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new LedgerError(`${what} looks like 2026-03-31, not "${value}".`);
  }
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${value} is not a real date.`);
  return d;
}

const asOfDate = (asOf: string) => parseDay(asOf, "A revaluation date");

export interface SetRateInput {
  orgId: string;
  entityId: string;
  currency: string;
  /** Units of the functional currency per one unit of `currency`. */
  rate: number | string;
  rateDate: string | Date;
  source?: string;
}

/**
 * Record a rate.
 *
 * The positivity check is duplicated in the database (FxRate_positive_check),
 * and it is worth having in both places. A zero or negative rate is not a
 * validation nicety: every balance it touched would be multiplied by it, so a
 * zero would value the entity's foreign receivables at nothing and a negative
 * would turn them into payables. The revaluation entry would still balance, the
 * trial balance would still tie, and nothing downstream would notice — which is
 * exactly why it has to be stopped at the door.
 */
export async function setRate(opts: SetRateInput) {
  const currency = opts.currency?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new LedgerError(`"${opts.currency}" is not a currency code. Use the three-letter ISO code, such as USD.`);
  }

  let rate: Prisma.Decimal;
  try {
    rate = new Prisma.Decimal(typeof opts.rate === "string" ? opts.rate.trim() : opts.rate);
  } catch {
    throw new LedgerError(`"${opts.rate}" is not a number. An exchange rate looks like 3.6725.`);
  }
  if (!rate.isFinite() || rate.lessThanOrEqualTo(0)) {
    throw new LedgerError(
      `An exchange rate must be greater than zero; ${rate.toString()} was supplied. ` +
        `Every balance in ${currency} would be multiplied by it — a zero rate would value them all at nothing, ` +
        `and a negative one would invert them, turning receivables into payables. The books would still balance ` +
        `afterwards, so nothing downstream would catch it.`,
    );
  }

  const rateDate = typeof opts.rateDate === "string" ? parseDay(opts.rateDate, "A rate date") : opts.rateDate;

  // A book's functional currency has no rate to itself, and storing 1 for it
  // would make it look as though it did.
  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  if (book && book.functionalCurrency === currency) {
    throw new LedgerError(`${currency} is this book's functional currency. It is what everything else is measured in, so it has no rate to itself.`);
  }

  return prisma.fxRate.upsert({
    where: {
      orgId_entityId_currency_rateDate: {
        orgId: opts.orgId, entityId: opts.entityId, currency, rateDate,
      },
    },
    create: {
      orgId: opts.orgId, entityId: opts.entityId, currency, rate,
      rateDate, source: opts.source ?? "CBUAE",
    },
    update: { rate, source: opts.source ?? "CBUAE" },
  });
}

/** The rates on file for an entity, most recent first. */
export async function ratesOnFile(opts: { orgId: string; entityId: string; limit?: number }) {
  const rows = await prisma.fxRate.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: [{ rateDate: "desc" }, { currency: "asc" }],
    take: opts.limit ?? 50,
  });
  return rows.map((r) => ({
    currency: r.currency,
    rate: r.rate.toFixed(),
    rateDate: isoDate(r.rateDate),
    source: r.source,
  }));
}

/* ──────────────────────────────────────────────────────────── preview ── */

export interface RevaluationRow {
  account: string;
  name: string;
  type: string;
  currency: string;
  /** The foreign-currency balance. Revaluation never touches this. */
  txnBalanceMinor: string;
  /** What that balance is carried at now, at the rates it was booked at. */
  carryingMinor: string;
  /** The period-end rate applied, and the day it is dated. */
  rate: string;
  rateDate: string;
  /** What it is worth at the period-end rate. */
  revaluedMinor: string;
  /** revalued − carrying, debit-positive. Positive is a gain either way round. */
  differenceMinor: string;
  gain: boolean;
}

export interface RevaluationSkip {
  account: string;
  name: string;
  currency: string;
  txnBalanceMinor: string;
  reason: string;
}

export interface RevaluationPreview {
  asOf: string;
  functionalCurrency: string;
  rows: RevaluationRow[];
  /** Never silent: every foreign-currency balance left alone, and why. */
  skipped: RevaluationSkip[];
  /** What stops the run. A blocker is refused, not worked around. */
  blockers: string[];
  totalGainMinor: string;
  totalLossMinor: string;
  netDifferenceMinor: string;
  /** Where the reversing entry would land. */
  reversalDate: string | null;
  alreadyPosted: boolean;
  reference: string | null;
  reversalReference: string | null;
}

const externalKeyFor = (entityId: string, asOf: string) => `revaluation:${entityId}:${asOf}`;
const reversalKeyFor = (entityId: string, asOf: string) => `revaluation-reversal:${entityId}:${asOf}`;

/**
 * What revaluing at `asOf` would do, and what stops it.
 *
 * Everything the run needs is computed here, so the run is this plus a posting
 * — a preview that takes a different path from the thing it previews is a
 * preview of nothing.
 */
export async function revaluationPreview(opts: {
  orgId: string;
  entityId: string;
  /** YYYY-MM-DD. */
  asOf: string;
  bookCode?: string;
}): Promise<RevaluationPreview> {
  const { orgId, entityId } = opts;
  const asOf = opts.asOf;
  const date = asOfDate(asOf);

  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: opts.bookCode ?? "PRIMARY" },
  });
  if (!book) throw new LedgerError(`No book "${opts.bookCode ?? "PRIMARY"}" for this entity. Set up the chart of accounts first.`);
  const functional = book.functionalCurrency;

  const blockers: string[] = [];

  // The period the revaluation lands in, chosen the same way post() chooses it
  // so the entry cannot end up somewhere else than the preview said.
  const period = await prisma.accountingPeriod.findFirst({
    where: { orgId, entityId, startsOn: { lte: date }, endsOn: { gte: date } },
    orderBy: [{ isAdjustment: "asc" }, { seq: "asc" }],
  });
  if (!period) {
    blockers.push(`No accounting period covers ${asOf}. Open the fiscal year before revaluing into it.`);
  } else if (period.status !== "open") {
    blockers.push(`Period ${period.label} is ${period.status.replace("_", " ")}. A revaluation posts into it, so it has to be open.`);
  }

  // The reversal lands on the first day of the period after this one. It is
  // checked here, before anything is posted, because a revaluation without its
  // reversal is worse than no revaluation at all.
  let reversalDate: string | null = null;
  if (period) {
    const next = new Date(period.endsOn);
    next.setUTCDate(next.getUTCDate() + 1);
    reversalDate = isoDate(next);
    const nextPeriod = await prisma.accountingPeriod.findFirst({
      where: { orgId, entityId, startsOn: { lte: next }, endsOn: { gte: next } },
      orderBy: [{ isAdjustment: "asc" }, { seq: "asc" }],
    });
    if (!nextPeriod) {
      blockers.push(
        `No accounting period covers ${reversalDate}, so the reversing entry could not be posted. ` +
          `Open the next fiscal year first — an unrealised difference that is never reversed is double-counted the moment the item settles.`,
      );
    } else if (nextPeriod.status !== "open") {
      blockers.push(
        `Period ${nextPeriod.label} is ${nextPeriod.status.replace("_", " ")}, so the reversing entry dated ${reversalDate} could not be posted into it. Reopen it before revaluing.`,
      );
    }
  }

  const existing = await prisma.journalEntry.findFirst({
    where: { orgId, externalKey: externalKeyFor(entityId, asOf) },
    select: { id: true, series: true, number: true },
  });
  const existingReversal = await prisma.journalEntry.findFirst({
    where: { orgId, externalKey: reversalKeyFor(entityId, asOf) },
    select: { series: true, number: true },
  });

  // Every revaluation is reversed on the first day of the following period, so
  // the only adjustments that can still be live at `asOf` are ones posted in
  // asOf's own period. Two in the same period would therefore stack, and an
  // earlier one that never got its reversal is still sitting in the carrying
  // amounts. Both are refused rather than netted off, because netting them off
  // silently would hide a run that half-failed.
  if (period && !existing) {
    const priors = await prisma.journalEntry.findMany({
      where: {
        orgId, entityId, sourceType: SOURCE_TYPE,
        entryDate: { lte: period.endsOn },
        externalKey: { not: externalKeyFor(entityId, asOf) },
      },
      select: { series: true, number: true, entryDate: true, reversals: { select: { id: true } } },
      orderBy: { entryDate: "asc" },
    });
    for (const p of priors) {
      const ref = `${p.series}-${p.number}`;
      if (p.entryDate >= period.startsOn) {
        blockers.push(
          `${period.label} was already revalued as at ${isoDate(p.entryDate)} (${ref}). A second revaluation in the same period ` +
            `stacks on top of the first, because neither is reversed until ${reversalDate}. Reverse ${ref} first, or revalue at ${isoDate(p.entryDate)} again.`,
        );
      } else if (p.reversals.length === 0) {
        blockers.push(
          `The revaluation at ${isoDate(p.entryDate)} (${ref}) was never reversed, so its adjustment is still in the carrying amounts. ` +
            `Reverse it before revaluing again, or this run will count the same difference twice.`,
        );
      }
    }
  }

  // Balances by account and transaction currency, from the lines themselves.
  // The balance cache cannot answer this: its functional-currency row for an
  // account mixes every currency posted to it, and what is needed here is the
  // functional amount of the foreign-currency lines alone.
  //
  // Reversed entries count. A reversed entry and its reversal are both real
  // postings; dropping the original would leave the reversal unmatched and
  // report a balance the ledger does not hold.
  const grouped = await prisma.journalLine.groupBy({
    by: ["accountId", "txnCurrency"],
    where: {
      orgId,
      txnCurrency: { not: functional },
      entry: {
        entityId, bookId: book.id,
        status: { in: ["posted", "reversed"] },
        entryDate: { lte: date },
      },
    },
    _sum: { txnAmountMinor: true, functionalAmountMinor: true },
  });

  const accounts = grouped.length
    ? await prisma.account.findMany({
        where: { orgId, entityId, id: { in: [...new Set(grouped.map((g) => g.accountId))] } },
        select: { id: true, code: true, name: true, type: true, subtype: true, currency: true },
      })
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));

  // Rates: the most recent rate on or before the revaluation date, per
  // currency. A rate dated after `asOf` is not the closing rate, and using it
  // would restate the period with information it did not have.
  const currencies = [...new Set(grouped.map((g) => g.txnCurrency))];
  const rateRows = currencies.length
    ? await prisma.fxRate.findMany({
        where: { orgId, entityId, currency: { in: currencies }, rateDate: { lte: date } },
        orderBy: [{ currency: "asc" }, { rateDate: "desc" }],
      })
    : [];
  const rateFor = new Map<string, { scaled: bigint; rate: string; rateDate: string }>();
  for (const r of rateRows) {
    if (rateFor.has(r.currency)) continue;
    const text = r.rate.toFixed();
    rateFor.set(r.currency, { scaled: rateToScaled(text), rate: text, rateDate: isoDate(r.rateDate) });
  }

  const rows: RevaluationRow[] = [];
  const skipped: RevaluationSkip[] = [];
  const missingRates = new Set<string>();

  const ordered = [...grouped].sort((a, b) => {
    const ca = byId.get(a.accountId)?.code ?? "";
    const cb = byId.get(b.accountId)?.code ?? "";
    return ca.localeCompare(cb, undefined, { numeric: true }) || a.txnCurrency.localeCompare(b.txnCurrency);
  });

  for (const g of ordered) {
    const account = byId.get(g.accountId);
    if (!account) continue; // an account cannot be deleted once posted to; belt and braces.
    const txnBalance = g._sum.txnAmountMinor ?? 0n;
    const carrying = g._sum.functionalAmountMinor ?? 0n;
    const base = {
      account: account.code, name: account.name,
      currency: g.txnCurrency, txnBalanceMinor: txnBalance.toString(),
    };

    const nature = classify(account);
    if (!nature.monetary) {
      skipped.push({ ...base, reason: nature.reason });
      continue;
    }

    if (txnBalance === 0n) {
      skipped.push({
        ...base,
        reason: carrying === 0n
          ? `the ${g.txnCurrency} balance is nil — there is nothing left to revalue`
          : `the ${g.txnCurrency} balance is nil, but ${functional} ${carrying.toString()} (minor units) is still carried against it. ` +
            `That is a realised difference left behind on a settled item, not an unrealised one — write it off against the settlement rather than through a period-end revaluation that would be reversed the next day`,
      });
      continue;
    }

    // An account restricted to a single currency cannot take the adjustment,
    // because the adjustment has to be in the functional currency.
    if (account.currency && account.currency !== functional) {
      skipped.push({
        ...base,
        reason: `account ${account.code} only accepts ${account.currency}, and a revaluation adjustment has to be posted in ${functional}. ` +
          `Book the adjustment for this account against an unrestricted revaluation account instead`,
      });
      continue;
    }

    const rate = rateFor.get(g.txnCurrency);
    if (!rate) {
      missingRates.add(g.txnCurrency);
      skipped.push({
        ...base,
        reason: `no ${g.txnCurrency} rate is on file as at ${asOf}`,
      });
      continue;
    }

    const revalued = convert(txnBalance, rate.scaled);
    const difference = revalued - carrying;
    if (difference === 0n) {
      skipped.push({
        ...base,
        reason: `the ${g.txnCurrency} balance is already carried at ${rate.rate} — there is no difference to book`,
      });
      continue;
    }

    rows.push({
      account: account.code,
      name: account.name,
      type: account.type,
      currency: g.txnCurrency,
      txnBalanceMinor: txnBalance.toString(),
      carryingMinor: carrying.toString(),
      rate: rate.rate,
      rateDate: rate.rateDate,
      revaluedMinor: revalued.toString(),
      differenceMinor: difference.toString(),
      // A debit to a balance-sheet account is a gain whichever side the balance
      // sits on: an asset worth more, or a liability that costs less to settle.
      // This is the sign that gets reversed by hand and produces a payable
      // revalued in the wrong direction.
      gain: difference > 0n,
    });
  }

  for (const currency of [...missingRates].sort()) {
    blockers.push(
      `No ${currency} rate is on file as at ${asOf}. Record the period-end ${currency} rate before revaluing — ` +
        `a guessed rate produces a difference that looks authoritative and is not.`,
    );
  }

  let totalGain = 0n;
  let totalLoss = 0n;
  for (const r of rows) {
    const d = BigInt(r.differenceMinor);
    if (d > 0n) totalGain += d;
    else totalLoss += -d;
  }

  return {
    asOf,
    functionalCurrency: functional,
    rows,
    skipped,
    blockers,
    totalGainMinor: totalGain.toString(),
    totalLossMinor: totalLoss.toString(),
    netDifferenceMinor: (totalGain - totalLoss).toString(),
    reversalDate,
    alreadyPosted: Boolean(existing),
    reference: existing ? `${existing.series}-${existing.number}` : null,
    reversalReference: existingReversal ? `${existingReversal.series}-${existingReversal.number}` : null,
  };
}

/* ─────────────────────────────────────────────────────────────── run ── */

export interface RevaluationResult {
  asOf: string;
  entryId: string | null;
  reference: string | null;
  accountsRevalued: number;
  totalGainMinor: string;
  totalLossMinor: string;
  netDifferenceMinor: string;
  reversalDate: string | null;
  reversalEntryId: string | null;
  reversalReference: string | null;
  skipped: RevaluationSkip[];
  alreadyPosted: boolean;
}

/**
 * Post the revaluation, and its reversal.
 *
 * One journal: each monetary account moved by its difference, with the other
 * side to 4950 or 6800. Gains and losses are carried to their own accounts
 * gross rather than netted into one line, so a gain on the bank and a loss on
 * receivables both appear — netting them would report a number that is true in
 * total and wrong about everything else.
 *
 * EVERY LINE IS IN THE FUNCTIONAL CURRENCY. No `currency` or `fxRate` is passed
 * to post(), so each line goes in at rate 1 with `txnCurrency` = the book's
 * functional currency. This is the whole safety property of the module: a
 * revaluation restates what the entity carries a foreign balance at, it does
 * not move foreign currency. Post these lines in USD instead and the receivable
 * would go from USD 10,000 to USD 9,998.64 — the customer's debt, changed by an
 * accounting estimate.
 *
 * Idempotent on `revaluation:<entity>:<asOf>`: a retry returns the entry the
 * first call made rather than doubling the adjustment.
 */
export async function runRevaluation(opts: {
  orgId: string;
  entityId: string;
  /** YYYY-MM-DD. */
  asOf: string;
  bookCode?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<RevaluationResult> {
  const { orgId, entityId, asOf } = opts;
  const preview = await revaluationPreview(opts);

  if (preview.alreadyPosted) {
    // A replay reports what was posted, not what a fresh preview would post
    // now. Those are two different numbers — once the reversal is in, the
    // carrying amounts are back on their historical basis and the preview
    // computes the same difference all over again. Reporting the preview here
    // would read as though the run had just been made twice.
    const existing = await prisma.journalEntry.findFirst({
      where: { orgId, externalKey: externalKeyFor(entityId, asOf) },
      include: { lines: { include: { account: { select: { code: true } } } } },
    });
    if (!existing) throw new LedgerError(`The revaluation at ${asOf} could not be read back. Please try again.`);
    let gain = 0n;
    let loss = 0n;
    let revalued = 0;
    for (const l of existing.lines) {
      if (l.account.code === FX_GAIN) gain += -l.functionalAmountMinor;
      else if (l.account.code === FX_LOSS) loss += l.functionalAmountMinor;
      else revalued += 1;
    }
    // Self-healing: if the reversal did not make it (the process died between
    // the two postings), post it now rather than leaving an unrealised
    // difference stranded in the next period.
    const reversal = await reverseRevaluation(opts);
    return {
      asOf,
      entryId: existing.id,
      reference: `${existing.series}-${existing.number}`,
      accountsRevalued: revalued,
      totalGainMinor: gain.toString(),
      totalLossMinor: loss.toString(),
      netDifferenceMinor: (gain - loss).toString(),
      reversalDate: reversal.reversalDate,
      reversalEntryId: reversal.entryId,
      reversalReference: reversal.reference,
      skipped: preview.skipped,
      alreadyPosted: true,
    };
  }

  if (preview.blockers.length) {
    // Blockers are refused rather than worked around: every one of them is a
    // case where posting something would be worse than posting nothing.
    throw new LedgerError(preview.blockers.join(" "));
  }

  if (preview.rows.length === 0) {
    return {
      asOf, entryId: null, reference: null, accountsRevalued: 0,
      totalGainMinor: "0", totalLossMinor: "0", netDifferenceMinor: "0",
      reversalDate: preview.reversalDate, reversalEntryId: null, reversalReference: null,
      skipped: preview.skipped, alreadyPosted: false,
    };
  }

  const gain = BigInt(preview.totalGainMinor);
  const loss = BigInt(preview.totalLossMinor);

  const lines = [
    ...preview.rows.map((r) => {
      const d = BigInt(r.differenceMinor);
      return {
        account: r.account,
        ...(d > 0n ? { debit: d } : { credit: -d }),
        memo: `${r.currency} ${r.txnBalanceMinor} at ${r.rate} — unrealised ${d > 0n ? "gain" : "loss"}`,
      };
    }),
    ...(gain > 0n ? [{ account: FX_GAIN, credit: gain, memo: `Unrealised exchange gain at ${asOf}` }] : []),
    ...(loss > 0n ? [{ account: FX_LOSS, debit: loss, memo: `Unrealised exchange loss at ${asOf}` }] : []),
  ];

  const entry = await post({
    orgId,
    entityId,
    bookCode: opts.bookCode,
    entryDate: asOf,
    memo: `Foreign currency revaluation at ${asOf}`,
    source: SOURCE,
    sourceType: SOURCE_TYPE,
    sourceId: asOf,
    externalKey: externalKeyFor(entityId, asOf),
    actorType: opts.actorType ?? "RULE",
    actorId: opts.actorId,
    series: SERIES,
    lines,
  });

  const reversal = await reverseRevaluation(opts);

  return {
    asOf,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    accountsRevalued: preview.rows.length,
    totalGainMinor: preview.totalGainMinor,
    totalLossMinor: preview.totalLossMinor,
    netDifferenceMinor: preview.netDifferenceMinor,
    reversalDate: reversal.reversalDate,
    reversalEntryId: reversal.entryId,
    reversalReference: reversal.reference,
    skipped: preview.skipped,
    alreadyPosted: false,
  };
}

/**
 * Reverse a revaluation on the first day of the following period.
 *
 * WHY THIS IS AUTOMATIC, AND WHY IT HAS TO BE.
 *
 * The difference is unrealised: nothing has been collected or paid, and the
 * rate will have moved again by the time it is. IAS 21 requires it to be
 * recognised in the period it arises, and it is — but leaving it in place would
 * break the settlement, because `postReceipt` in ar.ts books the realised
 * difference as `bank − cleared`, where `cleared` is what the invoice carried
 * the receipt at: the ORIGINAL, transaction-date amount. The subledger has no
 * knowledge of any revaluation, and it should not need any.
 *
 * Work it through with the case in the module header. USD 10,000 raised at
 * 3.6730 → AR 36,730. Revalued at 3.6725 → AR 36,725, a loss of 5. The customer
 * pays at 3.6700, so AED 36,700 lands and ar.ts credits AR with 36,730 and
 * books a realised loss of 30.
 *
 *   with the reversal:    36,725 + 5 (reversal) − 36,730 = 0. AR clears.
 *                         P&L: 5 in the first period, 30 − 5 = 25 in the
 *                         second, 30 in total — the whole realised difference,
 *                         recognised once.
 *   without it:           AR is left holding −5 forever, and the total charged
 *                         to profit or loss is 35 against an actual loss of 30.
 *
 * So the reversal is not a convention this module could take or leave: it is
 * what makes the unrealised and realised treatments add up to the truth. The
 * alternative — teaching ar.ts and ap.ts to look up outstanding revaluations
 * per document — would put period-end estimates inside the settlement path,
 * where they would be wrong every time a document was settled in two pieces.
 *
 * The original entry is deliberately left `posted` rather than being marked
 * `reversed`. It was not a mistake being corrected: it is the period-end
 * measurement, and it stands. (It also matters in practice — `balances()` in
 * statements.ts reads journal lines with `status: "posted"` for a partial
 * period, so marking the original reversed would quietly drop the difference
 * out of any profit and loss that stopped mid-period.) The link is carried by
 * `reversalOfId` on the reversing entry, which is where it belongs.
 *
 * Idempotent, and safe to call on its own to reverse a run early.
 */
export async function reverseRevaluation(opts: {
  orgId: string;
  entityId: string;
  /** The `asOf` of the revaluation being reversed. */
  asOf: string;
  bookCode?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
  /** Override the reversal date. Defaults to the first day of the next period. */
  reversalDate?: string;
}): Promise<{ entryId: string | null; reference: string | null; reversalDate: string | null; alreadyPosted: boolean }> {
  const { orgId, entityId, asOf } = opts;
  asOfDate(asOf);

  const original = await prisma.journalEntry.findFirst({
    where: { orgId, externalKey: externalKeyFor(entityId, asOf) },
    include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } }, book: true },
  });
  if (!original) {
    throw new LedgerError(`There is no revaluation as at ${asOf} for this entity to reverse.`);
  }

  const existing = await prisma.journalEntry.findFirst({
    where: { orgId, externalKey: reversalKeyFor(entityId, asOf) },
    select: { id: true, series: true, number: true, entryDate: true },
  });
  if (existing) {
    return {
      entryId: existing.id,
      reference: `${existing.series}-${existing.number}`,
      reversalDate: isoDate(existing.entryDate),
      alreadyPosted: true,
    };
  }

  let reversalDate = opts.reversalDate ?? null;
  if (!reversalDate) {
    const period = await prisma.accountingPeriod.findFirst({
      where: { orgId, entityId, startsOn: { lte: original.entryDate }, endsOn: { gte: original.entryDate } },
      orderBy: [{ isAdjustment: "asc" }, { seq: "asc" }],
    });
    if (!period) throw new LedgerError(`The revaluation at ${asOf} sits in no accounting period, so its reversal has nowhere to go.`);
    const next = new Date(period.endsOn);
    next.setUTCDate(next.getUTCDate() + 1);
    reversalDate = isoDate(next);
  }

  const reversal = await post({
    orgId,
    entityId,
    bookCode: original.book.code,
    entryDate: reversalDate,
    memo: `Reversal of the foreign currency revaluation at ${asOf} (${original.series}-${original.number})`,
    source: SOURCE,
    sourceType: REVERSAL_SOURCE_TYPE,
    sourceId: asOf,
    externalKey: reversalKeyFor(entityId, asOf),
    reversalOfId: original.id,
    actorType: opts.actorType ?? "RULE",
    actorId: opts.actorId,
    series: SERIES,
    lines: original.lines.map((l) => {
      const flipped = -l.txnAmountMinor;
      return {
        account: l.account.code,
        ...(flipped > 0n ? { debit: flipped } : { credit: -flipped }),
        memo: l.memo ?? undefined,
      };
    }),
  });

  return {
    entryId: reversal.id,
    reference: `${reversal.series}-${reversal.number}`,
    reversalDate,
    alreadyPosted: false,
  };
}
