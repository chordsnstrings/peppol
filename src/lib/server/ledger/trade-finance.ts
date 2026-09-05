import { prisma } from "@/lib/server/prisma";
import { Prisma } from "@prisma/client";
import { post, LedgerError, type PostInput } from "./post";
import { ledgerBalances } from "./balances";
import { exponentOf } from "@/lib/ledger/format";

/**
 * Trade finance: letters of credit, bank guarantees and trust receipts.
 *
 * Two ideas hold this together, and getting either wrong misstates the
 * accounts in a way nobody notices until the bank calls.
 *
 * **A guarantee that has not been called is not a liability.** IAS 37.27
 * forbids recognising it — the obligation depends on a future event outside
 * the entity's control — and IAS 37.86 requires it to be disclosed. So issuing
 * a facility posts nothing against the amount of it. A business that books its
 * guarantees as liabilities understates its net assets by the whole facility;
 * one that says nothing about them leaves a reader with no idea what has been
 * promised. Both are wrong, and only one of them is the sort of wrong an
 * auditor catches.
 *
 * **The margin the bank holds is an asset, and it is not cash.** It cannot be
 * spent while the facility is open, so it sits in 1255 and is kept out of every
 * cash list in the product — exactly as post-dated cheques are, and for exactly
 * the same reason: the money looks like it is there. IAS 7.48 asks for
 * restricted cash to be disclosed, and this is the disclosure.
 *
 * What is posted, therefore:
 *
 *   Issue      Dr  1255  Margin deposits        cash the bank now holds
 *                Cr  1010  Bank
 *              Dr  6350  Bank charges           the commission, when it is paid
 *                Cr  1010  Bank
 *
 *   Drawn      Dr  2000  Trade payables         the supplier has been paid
 *                Cr  2470  Trust receipts         by the bank, which we now owe
 *              — on a guarantee called, the debit is an expense instead,
 *                because there is no payable behind it.
 *
 *   Settled    Dr  2470  Trust receipts
 *                Cr  1010  Bank
 *
 *   Released   Dr  1010  Bank                   the margin comes back
 *                Cr  1255  Margin deposits
 *
 * Nothing in this module posts the face of a facility. The face is a
 * disclosure, and `contingentLiabilities()` is where it is disclosed.
 *
 * **A facility is posted in the currency it was opened in.** Every line below
 * carries the facility's currency and the rate on the day the money moved — see
 * `fxFor` — because a credit opened in dollars is a promise to pay dollars, and
 * the ledger is kept in dirhams. Nothing here assumes a rate of 1.
 */

const MARGIN = "1255";
const TRUST_RECEIPT = "2470";
const BANK = "1010";
const AP_CONTROL = "2000";
const CHARGES = "6350";
const GUARANTEE_CALLED = "6900";

export type FacilityKind = "LC_IMPORT" | "LC_EXPORT" | "BANK_GUARANTEE" | "TRUST_RECEIPT";
export type FacilityStatus = "issued" | "drawn" | "expired" | "cancelled";

export const KINDS: Record<FacilityKind, string> = {
  LC_IMPORT: "Import letter of credit",
  LC_EXPORT: "Export letter of credit",
  BANK_GUARANTEE: "Bank guarantee",
  TRUST_RECEIPT: "Trust receipt",
};

/**
 * Whether a facility of this kind, if called, would fall on the entity.
 *
 * An export credit is issued by the buyer's bank in the entity's favour: it is
 * security the entity holds, not a promise the entity has made. Counting it
 * among contingent liabilities would report the entity as exposed to its own
 * customer's creditworthiness twice over — once in receivables and once here.
 */
export const isOwnExposure = (kind: FacilityKind) => kind !== "LC_EXPORT";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

function asDate(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? day(v) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date I can read.`);
  return d;
}

function minor(v: number | bigint | string, what: string): bigint {
  try {
    return typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.round(v) : String(v).trim());
  } catch {
    throw new LedgerError(`${what} is not an amount I can read.`);
  }
}

/* ---------------------------------------------------------------- the rate */

/** The book everything here posts into, and what it is measured in. */
async function functionalCurrencyOf(orgId: string, entityId: string): Promise<string | null> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  return book?.functionalCurrency ?? null;
}

/**
 * The rate as `post()` will use it.
 *
 * `toFunctional` scales the rate to an integer at 1e9, so a rate that rounds to
 * zero there would multiply every amount it touched into nothing — refused here
 * for the reason `revaluation.ts` refuses it, because the entry would still
 * balance afterwards and nothing downstream would notice.
 */
function rateNumber(text: string, currency: string, rateDate: string): number {
  const rate = Number(text);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new LedgerError(
      `The ${currency} rate on file at ${rateDate} reads "${text}", which is not a rate anything can be converted at.`,
    );
  }
  if (Math.round(rate * 1e9) === 0) {
    throw new LedgerError(
      `The ${currency} rate of ${text} on file at ${rateDate} rounds to zero at nine decimal places, which would ` +
      `erase every amount it converts.`,
    );
  }
  return rate;
}

/**
 * The same conversion `toFunctional` in post.ts makes, digit for digit: the
 * rate scaled to an integer at 1e9, half-up, no floats near the amount. The
 * disclosure below is compared against balances that function produced, so a
 * different rounding here would show up as a difference nobody posted.
 */
function convert(amountMinor: bigint, rate: number): bigint {
  if (rate === 1) return amountMinor;
  const SCALE = 1_000_000_000n;
  const scaled = BigInt(Math.round(rate * 1e9));
  const neg = amountMinor < 0n;
  const abs = neg ? -amountMinor : amountMinor;
  const out = (abs * scaled + SCALE / 2n) / SCALE;
  return neg ? -out : out;
}

/**
 * Why a currency the ledger cannot convert is refused rather than converted.
 *
 * A rate in this product multiplies MINOR UNITS directly — `toFunctional` takes
 * a line's minor amount and the rate and does nothing about how big either
 * currency's minor unit is. That is exact while both have the same number of
 * decimal places, which is every pair this ledger has met so far, and out by a
 * factor of ten per decimal place when they do not: KWD 1.000 is 1000 minor
 * units, and 1000 × 11.9 is AED 119.00 where the truth is AED 11.90.
 *
 * So a facility in a currency whose minor unit is a different size cannot be
 * posted at all. A figure out by a factor of ten balances exactly as well as a
 * right one, and the entry, the trial balance and the disclosure would all
 * agree with each other about it. The conversion belongs in post.ts; until it
 * is exponent-aware this is a refusal, not a workaround.
 */
function assertSameMinorUnit(reference: string, currency: string, functional: string, what: string): void {
  const mine = exponentOf(currency);
  const theirs = exponentOf(functional);
  if (mine === theirs) return;
  throw new LedgerError(
    `${reference} is in ${currency} and the books are kept in ${functional}. ${currency} is quoted to ${mine} ` +
    `decimal places and ${functional} to ${theirs}, and an exchange rate in this ledger converts minor units ` +
    `directly — so ${what} would reach the accounts out by a factor of ${10 ** Math.abs(mine - theirs)}. ` +
    `Record the facility in ${functional} until the ledger can convert between minor units of different sizes.`,
  );
}

/**
 * What a facility's postings are converted at, and what happens when there is
 * no rate to convert them at.
 *
 * A facility records the currency it was opened in, and nothing used to carry
 * that currency into the ledger: every line went in with no currency and no
 * rate, which `post()` treats as functional at rate 1. A USD 100,000 import
 * credit with a 10% margin therefore debited restricted cash and credited the
 * bank with AED 100,000 — cash the entity never paid, against a deposit it does
 * not hold — while the IAS 37 note beside it called the same figure dollars.
 *
 * The rate is found the way `revaluation.ts` finds one: the most recent rate on
 * or before the day the money moved, out of the same FxRate table. A rate dated
 * after that day is not the rate the bank dealt at, and using it would restate
 * the transaction with information nobody had at the time.
 *
 * There is no default of 1. A missing rate is refused exactly as a revaluation
 * refuses to run without a closing rate: posting at an assumed rate is how the
 * error above happened, and it produces a figure that looks authoritative,
 * balances, reconciles to nothing and is never questioned afterwards.
 */
async function fxFor(
  f: { orgId: string; entityId: string; reference: string; currency: string },
  on: Date,
  what: string,
): Promise<{ currency?: string; fxRate?: number }> {
  const functional = await functionalCurrencyOf(f.orgId, f.entityId);
  if (!functional) {
    throw new LedgerError(`No book "PRIMARY" for this entity. Set up the chart of accounts first.`);
  }
  if (f.currency === functional) return {};

  assertSameMinorUnit(f.reference, f.currency, functional, what);

  const row = await prisma.fxRate.findFirst({
    where: { orgId: f.orgId, entityId: f.entityId, currency: f.currency, rateDate: { lte: on } },
    orderBy: { rateDate: "desc" },
  });
  if (!row) {
    throw new LedgerError(
      `${f.reference} is in ${f.currency} and no ${f.currency} rate is on file as at ${iso(on)}, so ${what} ` +
      `cannot be posted. Record the ${f.currency} rate for that day first — at an assumed rate every ` +
      `${f.currency} on this facility would reach the books as ${functional}, which balances and ties to nothing.`,
    );
  }
  return { currency: f.currency, fxRate: rateNumber(row.rate.toFixed(), f.currency, iso(row.rateDate)) };
}

/* --------------------------------------------------- the register, then the
                                                        journal that supports it */

/**
 * Post the journal for a register event that has already been reserved, and
 * attach the entry to that event.
 *
 * Everything below moves the register FIRST. The transaction that writes it is
 * where the facility's row lock is taken, and it is the only place a second
 * drawing or a second settlement can be refused instead of being added on top
 * of a figure that was read before it existed — see `drawFacility`.
 *
 * That order leaves one gap, and this is where it is closed. A posting refused
 * after the reservation — a closed period, an archived account — would
 * otherwise leave a facility showing a drawing no journal supports, and the
 * next settlement would be sized off it. The reservation is given back and the
 * caller's error is raised unchanged.
 */
async function postForEvent(eventId: string, undo: () => Promise<unknown>, input: PostInput) {
  let entry: Awaited<ReturnType<typeof post>>;
  try {
    entry = await post(input);
  } catch (e) {
    // The error the caller sees has to be the one that says what to do about
    // it, so a failure to undo must not replace it. What that leaves behind is
    // a register event with no entry against it, which the screen already
    // shows as "not posted".
    await undo().catch(() => undefined);
    throw e;
  }
  await prisma.tradeFacilityEvent.update({ where: { id: eventId }, data: { entryId: entry.id } });
  return entry;
}

export interface NewFacility {
  reference: string;
  kind: FacilityKind;
  bank: string;
  beneficiary: string;
  currency?: string;
  amountMinor: number | bigint | string;
  marginMinor?: number | bigint | string;
  commissionMinor?: number | bigint | string;
  issuedOn: Date | string;
  expiresOn: Date | string;
  notes?: string;
}

/**
 * Open a facility.
 *
 * The face amount reaches no account. What reaches the ledger is the cash the
 * bank has taken as margin and the commission it has charged, and only if
 * there is any.
 */
export async function issueFacility(opts: {
  orgId: string; entityId: string; facility: NewFacility; actorId?: string;
}) {
  const f = opts.facility;
  const reference = f.reference.trim();
  if (!reference) throw new LedgerError("A facility needs the bank's reference for it.");
  if (!(f.kind in KINDS)) {
    throw new LedgerError(`"${f.kind}" is not a facility this ledger knows. Use one of ${Object.keys(KINDS).join(", ")}.`);
  }
  if (!f.bank.trim()) throw new LedgerError("Which bank issued it?");
  if (!f.beneficiary.trim()) throw new LedgerError("In whose favour was it issued?");

  const amountMinor = minor(f.amountMinor, "The facility amount");
  if (amountMinor <= 0n) throw new LedgerError("A facility for nothing is not a facility.");
  const marginMinor = f.marginMinor === undefined ? 0n : minor(f.marginMinor, "The margin");
  if (marginMinor < 0n) throw new LedgerError("A margin cannot be negative.");
  if (marginMinor > amountMinor) {
    throw new LedgerError(
      `The margin of ${marginMinor} is more than the ${amountMinor} facility it secures. A bank holding more than ` +
      `the face of a credit is holding a deposit, not a margin.`,
    );
  }
  const commissionMinor = f.commissionMinor === undefined ? 0n : minor(f.commissionMinor, "The commission");
  if (commissionMinor < 0n) throw new LedgerError("A commission cannot be negative.");

  const issuedOn = asDate(f.issuedOn, "The issue date");
  const expiresOn = asDate(f.expiresOn, "The expiry date");
  if (expiresOn < issuedOn) {
    throw new LedgerError("The facility expires before it is issued, which would protect nobody.");
  }

  const currency = (f.currency ?? "AED").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new LedgerError(`"${f.currency}" is not a currency code.`);

  // The rate is settled before anything is written down. A facility whose
  // margin cannot be converted is not a facility that should be recorded and
  // then found unpostable — it is a missing rate, and the answer is to record
  // the rate rather than to leave a register row nobody can act on.
  const posts = marginMinor > 0n || commissionMinor > 0n;
  const fx = posts
    ? await fxFor(
        { orgId: opts.orgId, entityId: opts.entityId, reference, currency },
        issuedOn,
        "the margin and the commission on it",
      )
    : {};

  const clash = await prisma.tradeFacility.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, reference },
  });
  if (clash) throw new LedgerError(`There is already a facility ${reference}.`);

  // The facility and the event that says it was opened are written together: a
  // facility with no issue event is a row whose history starts halfway through.
  const opened = await prisma.$transaction(async (tx) => {
    const facility = await tx.tradeFacility.create({
      data: {
        orgId: opts.orgId, entityId: opts.entityId, reference, kind: f.kind,
        bank: f.bank.trim(), beneficiary: f.beneficiary.trim(), currency,
        amountMinor, marginMinor, commissionMinor, issuedOn, expiresOn,
        notes: f.notes?.trim() || null,
      },
    });
    const event = await tx.tradeFacilityEvent.create({
      data: {
        orgId: opts.orgId, facilityId: facility.id, kind: "issue",
        happenedOn: issuedOn, amountMinor,
        memo:
          `${KINDS[f.kind]} for ${f.beneficiary.trim()}. The face of it reaches no account — an obligation that ` +
          `depends on a future event outside the entity's control is disclosed, not recognised (IAS 37.27).`,
      },
    });
    return { facility, event };
  }).catch((e) => {
    // The unique index on (org, entity, reference) is what actually decides
    // this. The check above only gets to say it in better words when it is not
    // a race — two tabs, or two people, reaching here at the same moment.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new LedgerError(`There is already a facility ${reference}.`);
    }
    throw e;
  });

  let entryId: string | null = null;
  if (posts) {
    const entry = await postForEvent(
      opened.event.id,
      // Nothing was posted, so nothing is recorded either: the row is dropped
      // rather than left holding a reference that the facility somebody is
      // actually trying to open can no longer use. The event goes with it.
      () => prisma.tradeFacility.delete({ where: { id: opened.facility.id } }),
      {
        orgId: opts.orgId, entityId: opts.entityId, entryDate: issuedOn,
        source: "trade_finance", sourceType: "FACILITY_ISSUE", sourceId: opened.facility.id,
        memo: `${KINDS[f.kind]} ${reference} — ${f.bank.trim()}`,
        externalKey: `tradefin:issue:${opened.facility.id}`,
        series: "TF", actorId: opts.actorId,
        lines: [
          ...(marginMinor > 0n
            ? [
                { account: MARGIN, debit: marginMinor, ...fx, memo: `Margin held against ${reference}` },
                { account: BANK, credit: marginMinor, ...fx, memo: `Margin paid to ${f.bank.trim()}` },
              ]
            : []),
          ...(commissionMinor > 0n
            ? [
                { account: CHARGES, debit: commissionMinor, ...fx, memo: `Commission on ${reference}` },
                { account: BANK, credit: commissionMinor, ...fx, memo: `Commission paid to ${f.bank.trim()}` },
              ]
            : []),
        ],
      },
    );
    entryId = entry.id;
  }

  return {
    facility: opened.facility,
    entryId,
    note:
      marginMinor === 0n && commissionMinor === 0n
        ? `${reference} is open. Nothing was posted: the face of a facility is a disclosure, not a liability.`
        : `${reference} is open. Only the margin and the commission were posted — the face of it is a disclosure.`,
  };
}

async function load(orgId: string, entityId: string, reference: string) {
  const f = await prisma.tradeFacility.findFirst({
    where: { orgId, entityId, reference: reference.trim() },
  });
  if (!f) throw new LedgerError(`There is no facility ${reference.trim()}.`);
  return f;
}

/**
 * Said twice — once to whoever is drawing, and once to whoever lost the race
 * for the last of the headroom — so both hear the same thing.
 */
const overdrawn = (f: { reference: string; amountMinor: bigint }, amountMinor: bigint, already: bigint) =>
  `${f.reference} is for ${f.amountMinor} and ${already} has already been drawn, so ${amountMinor} cannot ` +
  `be. A bank paying beyond the face of a credit has made a loan, and a loan is a different document.`;

/**
 * The bank pays out under the facility.
 *
 * On an import credit the bank has paid the supplier, so the payable is
 * discharged and a trust receipt takes its place — the same debt, owed to a
 * different party, and now bearing interest. On a guarantee that is called
 * there is no payable behind it, so the debit is an expense: the entity has
 * paid for somebody's failure to perform, and calling that a payable would
 * imply it is getting something for the money.
 */
export async function drawFacility(opts: {
  orgId: string; entityId: string; reference: string;
  amountMinor: number | bigint | string;
  drawnOn: Date | string;
  memo?: string;
  actorId?: string;
}) {
  const f = await load(opts.orgId, opts.entityId, opts.reference);
  if (f.status === "cancelled" || f.status === "expired") {
    throw new LedgerError(`${f.reference} is ${f.status}. Nothing can be drawn against it.`);
  }
  const amountMinor = minor(opts.amountMinor, "The amount drawn");
  if (amountMinor <= 0n) throw new LedgerError("A drawing of nothing is not a drawing.");
  if (f.drawnMinor + amountMinor > f.amountMinor) throw new LedgerError(overdrawn(f, amountMinor, f.drawnMinor));
  const drawnOn = asDate(opts.drawnOn, "The date it was drawn");

  /*
   * Nobody can call a credit that has run out.
   *
   * The status check above is not enough on its own, because `status` is
   * stored and nothing moves it: a facility that expired last month is still
   * "issued" until somebody says otherwise, so the guard let a drawing through
   * against a facility `contingentLiabilities()` had already dropped from the
   * IAS 37 note — it filters on `expiresOn >= asOf`, not on the status. The
   * register showed it lapsed, the disclosure had let it go, and the drawing
   * posted anyway.
   *
   * The test is the DAY IT WAS DRAWN, not today. A bank that paid out on the
   * 3rd against a credit expiring on the 5th did nothing wrong because the
   * paperwork reached the ledger on the 20th, and refusing that would only
   * teach people to backdate the entry to a day they can get past. What is
   * refused is a drawing that claims to have happened after the credit was
   * over.
   */
  if (drawnOn > f.expiresOn) {
    throw new LedgerError(
      `${f.reference} expired on ${iso(f.expiresOn)} and this is dated ${iso(drawnOn)}. A bank cannot pay under a ` +
      `credit that has run out, so either the date is wrong or what happened is not a drawing under this facility. ` +
      `A drawing that really did happen before expiry can still be recorded — date it the day it happened.`,
    );
  }

  if (!isOwnExposure(f.kind as FacilityKind)) {
    throw new LedgerError(
      `${f.reference} is an export credit — it is security the entity holds, not a promise it has made. Money ` +
      `arriving under it is a receipt against the invoice, and it belongs on the receivables screen.`,
    );
  }

  const fx = await fxFor(f, drawnOn, "a drawing under it");

  /*
   * The drawing is taken off the facility BEFORE it is posted, and the write is
   * what decides whether it fits.
   *
   * What used to happen: the balance was read, the check made against what had
   * been read, the journal posted, and `drawnMinor` SET from the stale figure —
   * with no transaction anywhere. Two drawings at once against a 1,000,000
   * credit, of 700,000 and 600,000, both passed a check made against 0 and both
   * posted, and the second SET the register to 600,000, losing the first
   * entirely. Equal amounts were worse: they produced the same running total,
   * so they collided on the externalKey and left two register events pointing
   * at one journal, after which `settleFacility` sized a settlement off the
   * double.
   *
   * Two things fix it, and neither of them is the check above.
   *
   * The write is an INCREMENT inside a transaction, so it takes the facility's
   * row lock: a second drawing waits for the first and adds to the figure the
   * first committed rather than to the one it read. The running total it gets
   * back is therefore unique to it, which is also what stops equal drawings
   * sharing an externalKey.
   *
   * And `TradeFacility_drawn_check` — the database's own `drawnMinor <=
   * amountMinor` — is what refuses the loser. It is the guarantee, exactly as
   * the unique index is on a double approval; the check above is kept because
   * it is the one a person reads when they are the only one drawing, and the
   * catch below turns the database's answer into the same sentence.
   *
   * `status` is deliberately not written in the same statement: the row that
   * comes back has to carry the status a concurrent close committed, so that a
   * facility cancelled while this was in flight is refused here rather than
   * having "drawn" written over it.
   */
  const reserved = await prisma.$transaction(async (tx) => {
    const moved = await tx.tradeFacility.update({
      where: { id: f.id },
      data: { drawnMinor: { increment: amountMinor } },
    });
    if (moved.status === "cancelled" || moved.status === "expired") {
      throw new LedgerError(`${f.reference} is ${moved.status}. Nothing can be drawn against it.`);
    }
    await tx.tradeFacility.update({ where: { id: f.id }, data: { status: "drawn" } });
    const event = await tx.tradeFacilityEvent.create({
      data: {
        orgId: opts.orgId, facilityId: f.id, kind: "draw",
        happenedOn: drawnOn, amountMinor, memo: opts.memo ?? null,
      },
    });
    return { after: moved.drawnMinor, eventId: event.id };
  }).catch(async (e) => {
    if (!(e instanceof Error) || !/TradeFacility_drawn_check/.test(e.message)) throw e;
    // The increment was refused, so nothing of this drawing survives. What is
    // read here is what the facility holds now — which is the figure the person
    // needs, and not the one this call read before the winner committed.
    const now = await prisma.tradeFacility.findUnique({
      where: { id: f.id }, select: { drawnMinor: true },
    });
    throw new LedgerError(overdrawn(f, amountMinor, now?.drawnMinor ?? f.drawnMinor));
  });
  const after = reserved.after;

  const debit = f.kind === "BANK_GUARANTEE" ? GUARANTEE_CALLED : AP_CONTROL;
  const entry = await postForEvent(
    reserved.eventId,
    () => prisma.$transaction(async (tx) => {
      await tx.tradeFacilityEvent.delete({ where: { id: reserved.eventId } });
      const back = await tx.tradeFacility.update({
        where: { id: f.id }, data: { drawnMinor: { decrement: amountMinor } },
      });
      // Nothing has been drawn after all. Anything else on the facility keeps
      // it "drawn", which is why this asks the row rather than assuming.
      if (back.drawnMinor === 0n && back.status === "drawn") {
        await tx.tradeFacility.update({ where: { id: f.id }, data: { status: "issued" } });
      }
    }),
    {
      orgId: opts.orgId, entityId: opts.entityId, entryDate: drawnOn,
      source: "trade_finance", sourceType: "FACILITY_DRAW", sourceId: f.id,
      memo: opts.memo ?? `${f.reference} drawn — ${f.bank}`,
      externalKey: `tradefin:draw:${f.id}:${after}`,
      series: "TF", actorId: opts.actorId,
      lines: [
        {
          account: debit, debit: amountMinor, ...fx,
          memo: f.kind === "BANK_GUARANTEE"
            ? `Guarantee ${f.reference} called by ${f.beneficiary}`
            : `${f.beneficiary} paid by ${f.bank} under ${f.reference}`,
        },
        { account: TRUST_RECEIPT, credit: amountMinor, ...fx, memo: `Owed to ${f.bank} under ${f.reference}` },
      ],
    },
  );

  return {
    reference: f.reference,
    drawnMinor: after,
    availableMinor: f.amountMinor - after,
    entryId: entry.id,
    note:
      f.kind === "BANK_GUARANTEE"
        ? `The guarantee was called. That is an expense, not a payable — the entity has paid for somebody's ` +
          `failure to perform and is getting nothing for the money.`
        : `The supplier has been paid by the bank. The debt has moved from the supplier to the bank and now bears ` +
          `interest; it has not gone away.`,
  };
}

/** Pay the bank what it advanced. */
export async function settleFacility(opts: {
  orgId: string; entityId: string; reference: string;
  amountMinor: number | bigint | string;
  settledOn: Date | string;
  actorId?: string;
}) {
  const f = await load(opts.orgId, opts.entityId, opts.reference);
  const amountMinor = minor(opts.amountMinor, "The amount settled");
  if (amountMinor <= 0n) throw new LedgerError("A settlement of nothing is not a settlement.");
  const settledOn = asDate(opts.settledOn, "The settlement date");
  const fx = await fxFor(f, settledOn, "a settlement of it");

  /*
   * The settlement is reserved before it is posted, for the reason a drawing
   * is: what the bank is owed is a running total over the events, so two
   * settlements read at once both saw the whole balance outstanding and both
   * paid it — one bank, one advance, two payments out of 1010.
   *
   * The facility row is written first purely to take its lock. There is nothing
   * on the facility a settlement changes, and no unique index it could collide
   * on, so the row is what serialises this: a second settlement waits for the
   * first, and the events it then reads include the first one instead of the
   * balance that was there before it.
   */
  const reserved = await prisma.$transaction(async (tx) => {
    await tx.tradeFacility.update({ where: { id: f.id }, data: { updatedAt: new Date() } });
    const events = await tx.tradeFacilityEvent.findMany({
      where: { orgId: opts.orgId, facilityId: f.id, kind: { in: ["draw", "settle"] } },
    });
    const outstanding = events.reduce(
      (a, e) => a + (e.kind === "draw" ? e.amountMinor : -e.amountMinor), 0n,
    );
    if (amountMinor > outstanding) {
      throw new LedgerError(
        `${f.reference} has ${outstanding} outstanding to the bank and ${amountMinor} is being paid. Paying a bank ` +
        `more than it advanced is a different transaction.`,
      );
    }
    const event = await tx.tradeFacilityEvent.create({
      data: {
        orgId: opts.orgId, facilityId: f.id, kind: "settle",
        happenedOn: settledOn, amountMinor,
      },
    });
    return { outstanding, eventId: event.id };
  });

  const entry = await postForEvent(
    reserved.eventId,
    () => prisma.tradeFacilityEvent.delete({ where: { id: reserved.eventId } }),
    {
      orgId: opts.orgId, entityId: opts.entityId, entryDate: settledOn,
      source: "trade_finance", sourceType: "FACILITY_SETTLE", sourceId: f.id,
      memo: `${f.reference} settled — ${f.bank}`,
      externalKey: `tradefin:settle:${f.id}:${reserved.outstanding - amountMinor}`,
      series: "TF", actorId: opts.actorId,
      lines: [
        { account: TRUST_RECEIPT, debit: amountMinor, ...fx, memo: `Repaid to ${f.bank} under ${f.reference}` },
        { account: BANK, credit: amountMinor, ...fx },
      ],
    },
  );

  return {
    reference: f.reference,
    outstandingMinor: reserved.outstanding - amountMinor,
    entryId: entry.id,
  };
}

/**
 * The facility comes to an end and the margin comes back.
 *
 * The margin is released whatever the facility did, because the bank holds it
 * against the promise rather than against the drawing: an import credit fully
 * drawn and fully repaid still gets its margin back.
 */
export async function closeFacility(opts: {
  orgId: string; entityId: string; reference: string;
  closedOn: Date | string;
  reason?: "expire" | "cancel";
  actorId?: string;
}) {
  const f = await load(opts.orgId, opts.entityId, opts.reference);
  if (f.status === "expired" || f.status === "cancelled") {
    throw new LedgerError(`${f.reference} is already ${f.status}.`);
  }
  const closedOn = asDate(opts.closedOn, "The closing date");
  const reason = opts.reason ?? "expire";
  const status = reason === "cancel" ? "cancelled" : "expired";
  const fx = f.marginMinor > 0n ? await fxFor(f, closedOn, "the release of the margin") : {};

  /*
   * Closing is reserved the same way a settlement is, and for the same two
   * reasons: what is still owed is a running total over the events, and the
   * status this checks is a stored value somebody else may be changing. Two
   * closings at once would each release the margin — the posting is idempotent
   * on the facility, so the ledger would hold one release, but the register
   * would hold two — and a drawing that committed between the read and the
   * write would be left against a facility recorded as closed.
   */
  const reserved = await prisma.$transaction(async (tx) => {
    const now = await tx.tradeFacility.update({ where: { id: f.id }, data: { updatedAt: new Date() } });
    if (now.status === "expired" || now.status === "cancelled") {
      throw new LedgerError(`${f.reference} is already ${now.status}.`);
    }
    const events = await tx.tradeFacilityEvent.findMany({
      where: { orgId: opts.orgId, facilityId: f.id, kind: { in: ["draw", "settle"] } },
    });
    const outstanding = events.reduce(
      (a, e) => a + (e.kind === "draw" ? e.amountMinor : -e.amountMinor), 0n,
    );
    if (outstanding > 0n) {
      throw new LedgerError(
        `${f.reference} still owes ${outstanding} to ${f.bank}. Closing it would leave a debt with no facility ` +
        `behind it, and the bank would still be holding the margin.`,
      );
    }
    await tx.tradeFacility.update({ where: { id: f.id }, data: { status, closedOn } });
    const event = await tx.tradeFacilityEvent.create({
      data: {
        orgId: opts.orgId, facilityId: f.id, kind: reason === "cancel" ? "cancel" : "expire",
        happenedOn: closedOn, amountMinor: f.marginMinor,
      },
    });
    return { eventId: event.id, wasStatus: now.status, wasClosedOn: now.closedOn };
  });

  let entryId: string | null = null;
  if (f.marginMinor > 0n) {
    const entry = await postForEvent(
      reserved.eventId,
      () => prisma.$transaction(async (tx) => {
        await tx.tradeFacilityEvent.delete({ where: { id: reserved.eventId } });
        await tx.tradeFacility.update({
          where: { id: f.id },
          data: { status: reserved.wasStatus, closedOn: reserved.wasClosedOn },
        });
      }),
      {
        orgId: opts.orgId, entityId: opts.entityId, entryDate: closedOn,
        source: "trade_finance", sourceType: "FACILITY_RELEASE", sourceId: f.id,
        memo: `${f.reference} closed — margin released by ${f.bank}`,
        externalKey: `tradefin:release:${f.id}`,
        series: "TF", actorId: opts.actorId,
        lines: [
          { account: BANK, debit: f.marginMinor, ...fx, memo: `Margin returned by ${f.bank}` },
          { account: MARGIN, credit: f.marginMinor, ...fx, memo: `Margin released on ${f.reference}` },
        ],
      },
    );
    entryId = entry.id;
  }

  return {
    reference: f.reference,
    status,
    marginReleasedMinor: f.marginMinor,
    entryId,
  };
}

/* -------------------------------------------------------- the disclosures */

export interface ContingentLiabilities {
  asOf: string;
  /**
   * The currency every figure below is in — the book's functional currency.
   *
   * A facility is opened in whatever currency the bank wrote it in, and the
   * disclosure is one number. Adding dollar minor units to dirham minor units
   * would produce a total that ties to nothing and reads as though it did, so
   * each facility is translated first; see `translate`.
   */
  functionalCurrency: string;
  /** IAS 37.86: what has been promised, by kind, and what is left of it. */
  byKind: {
    kind: FacilityKind;
    label: string;
    count: number;
    facedMinor: bigint;
    drawnMinor: bigint;
    contingentMinor: bigint;
  }[];
  totalFacedMinor: bigint;
  totalDrawnMinor: bigint;
  /** The face less what has already been called. This is the disclosure figure. */
  totalContingentMinor: bigint;
  /** Held by others in the entity's favour — security, not exposure. */
  heldInFavourMinor: bigint;
  restrictedCash: {
    /** IAS 7.48: cash the entity holds and cannot spend. */
    marginMinor: bigint;
    ledgerMinor: bigint;
    agrees: boolean;
    differenceMinor: bigint;
  };
  expiringWithin90Days: { reference: string; kind: FacilityKind; expiresOn: string; contingentMinor: bigint }[];
  /**
   * Facilities left out of every figure above because they cannot be
   * translated, and why. Never silent: a disclosure that quietly drops an
   * exposure is worse than one that says it cannot measure it.
   */
  untranslated: { reference: string; currency: string; reason: string }[];
  statement: string;
  basis: string;
}

/** A facility's own figures, or the reason they cannot be stated in the book's. */
type Translated =
  | { facedMinor: bigint; drawnMinor: bigint; marginMinor: bigint }
  | { reason: string };

/**
 * A facility's figures in the currency the books are kept in.
 *
 * Two different rates, deliberately.
 *
 * The exposure — the face, and what has been called against it — is translated
 * at the closing rate, because what an IAS 37.86 reader needs is what the
 * promise would cost if it were called now.
 *
 * The margin is translated at the rate on the day the facility was opened,
 * because it is held against what account 1255 carries and 1255 carries what
 * was paid for it. Translating it at the closing rate would report an exchange
 * difference as a missing deposit, every day the rate moved, on the one panel
 * whose whole job is to say whether the register and the ledger agree.
 */
function translate(
  f: { reference: string; currency: string; issuedOn: Date; amountMinor: bigint; drawnMinor: bigint; marginMinor: bigint },
  functional: string,
  rates: Map<string, { rateDate: Date; rate: number }[]>,
  asOf: Date,
): Translated {
  if (f.currency === functional) {
    return { facedMinor: f.amountMinor, drawnMinor: f.drawnMinor, marginMinor: f.marginMinor };
  }
  if (exponentOf(f.currency) !== exponentOf(functional)) {
    return {
      reason:
        `${f.currency} is quoted to ${exponentOf(f.currency)} decimal places and ${functional} to ` +
        `${exponentOf(functional)}, and a rate here converts minor units directly — translating it would be out ` +
        `by a factor of ${10 ** Math.abs(exponentOf(f.currency) - exponentOf(functional))}`,
    };
  }
  const on = rates.get(f.currency) ?? [];
  const closing = on.find((r) => r.rateDate <= asOf);
  if (!closing) return { reason: `no ${f.currency} rate is on file as at ${iso(asOf)}` };
  const historic = f.marginMinor > 0n ? on.find((r) => r.rateDate <= f.issuedOn) : closing;
  if (!historic) {
    return {
      reason:
        `no ${f.currency} rate is on file as at ${iso(f.issuedOn)}, the day the margin was paid, so what account ` +
        `1255 carries for it cannot be checked`,
    };
  }
  return {
    facedMinor: convert(f.amountMinor, closing.rate),
    drawnMinor: convert(f.drawnMinor, closing.rate),
    marginMinor: convert(f.marginMinor, historic.rate),
  };
}

/** Every rate on file for these currencies up to `asOf`, most recent first. */
async function ratesUpTo(orgId: string, entityId: string, currencies: string[], asOf: Date) {
  const by = new Map<string, { rateDate: Date; rate: number }[]>();
  if (currencies.length === 0) return by;
  const rows = await prisma.fxRate.findMany({
    where: { orgId, entityId, currency: { in: currencies }, rateDate: { lte: asOf } },
    orderBy: [{ currency: "asc" }, { rateDate: "desc" }],
  });
  for (const r of rows) {
    const list = by.get(r.currency) ?? [];
    list.push({ rateDate: r.rateDate, rate: rateNumber(r.rate.toFixed(), r.currency, iso(r.rateDate)) });
    by.set(r.currency, list);
  }
  return by;
}

export async function contingentLiabilities(opts: {
  orgId: string; entityId: string; asOf?: Date | string;
}): Promise<ContingentLiabilities> {
  const asOf = opts.asOf ? asDate(opts.asOf, "The date") : new Date();

  const facilities = await prisma.tradeFacility.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      issuedOn: { lte: asOf },
      OR: [{ closedOn: null }, { closedOn: { gt: asOf } }],
    },
    orderBy: [{ kind: "asc" }, { expiresOn: "asc" }],
  });

  // A facility whose expiry has passed is no longer an exposure, whatever the
  // register still says: nobody can call a credit that has run out. It is
  // dropped from the disclosure rather than waiting for somebody to close it.
  const live = facilities.filter((f) => f.expiresOn >= asOf);

  // The books' own currency, or the schema's default where the chart has not
  // been set up yet: nothing can have been posted in that case, so nothing can
  // be measured against it either.
  const functional = (await functionalCurrencyOf(opts.orgId, opts.entityId)) ?? "AED";
  const foreign = [...new Set(live.map((f) => f.currency).filter((c) => c !== functional))];
  const rates = await ratesUpTo(opts.orgId, opts.entityId, foreign, asOf);

  const groups = new Map<FacilityKind, { count: number; faced: bigint; drawn: bigint }>();
  const untranslated: { reference: string; currency: string; reason: string }[] = [];
  const inBook = new Map<string, { facedMinor: bigint; drawnMinor: bigint; marginMinor: bigint }>();
  let heldInFavour = 0n;
  let margin = 0n;
  for (const f of live) {
    const kind = f.kind as FacilityKind;
    const t = translate(f, functional, rates, asOf);
    if ("reason" in t) {
      untranslated.push({ reference: f.reference, currency: f.currency, reason: t.reason });
      continue;
    }
    inBook.set(f.id, t);
    margin += t.marginMinor;
    if (!isOwnExposure(kind)) { heldInFavour += t.facedMinor - t.drawnMinor; continue; }
    const g = groups.get(kind) ?? { count: 0, faced: 0n, drawn: 0n };
    g.count += 1;
    g.faced += t.facedMinor;
    g.drawn += t.drawnMinor;
    groups.set(kind, g);
  }

  const byKind = [...groups.entries()].map(([kind, g]) => ({
    kind, label: KINDS[kind], count: g.count,
    facedMinor: g.faced, drawnMinor: g.drawn,
    contingentMinor: g.faced - g.drawn,
  }));

  const totalFaced = byKind.reduce((a, r) => a + r.facedMinor, 0n);
  const totalDrawn = byKind.reduce((a, r) => a + r.drawnMinor, 0n);

  // The margin on the register against what 1255 actually holds, both in the
  // book's currency. A difference is either a margin somebody released without
  // closing the facility or a posting by hand, and both are findings.
  const ledger = await ledgerBalances({ orgId: opts.orgId, entityId: opts.entityId, codes: [MARGIN] });
  const held = ledger.get(MARGIN) ?? 0n;

  const soon = new Date(asOf.getTime() + 90 * 86_400_000);

  return {
    asOf: iso(asOf),
    functionalCurrency: functional,
    byKind,
    totalFacedMinor: totalFaced,
    totalDrawnMinor: totalDrawn,
    totalContingentMinor: totalFaced - totalDrawn,
    heldInFavourMinor: heldInFavour,
    restrictedCash: {
      marginMinor: margin,
      ledgerMinor: held,
      agrees: margin === held,
      differenceMinor: margin - held,
    },
    expiringWithin90Days: live
      .filter((f) => isOwnExposure(f.kind as FacilityKind) && f.expiresOn <= soon && inBook.has(f.id))
      .map((f) => ({
        reference: f.reference,
        kind: f.kind as FacilityKind,
        expiresOn: iso(f.expiresOn),
        contingentMinor: inBook.get(f.id)!.facedMinor - inBook.get(f.id)!.drawnMinor,
      })),
    untranslated,
    statement:
      (totalFaced === 0n
        ? untranslated.length === 0
          ? "The entity has given no guarantees or letters of credit that are still in force."
          // Not "none given": there are some, and none of them could be stated
          // here. Saying the first would be a clean sentence about nothing.
          : `Every guarantee and letter of credit the entity has given is in a currency this note cannot state in ${functional}.`
        : `The entity has given guarantees and credits with a face of ${totalFaced} of which ${totalDrawn} has been ` +
          `called. None of the remainder is recognised as a liability: the obligation depends on a future event ` +
          `outside the entity's control, which IAS 37.27 says is a contingent liability and IAS 37.86 says must be ` +
          `disclosed rather than provided for.`) +
      // Said in the disclosure itself rather than left to a field nobody reads.
      // A figure that quietly excludes an exposure is not a smaller figure, it
      // is a wrong one, and the reader is the person who can fix it.
      (untranslated.length === 0
        ? ""
        : ` ${untranslated.length === 1 ? "One facility is" : `${untranslated.length} facilities are`} left out of ` +
          `these figures because ${untranslated.length === 1 ? "it cannot" : "they cannot"} be stated in ` +
          `${functional}: ${untranslated.map((u) => `${u.reference} (${u.currency}) — ${u.reason}`).join("; ")}.`),
    basis: "IAS 37.27, IAS 37.86, IAS 7.48",
  };
}

/**
 * The most facilities one read will list, and how far back a closed one is
 * still worth listing.
 *
 * The old read took the first 500 ordered by status ascending, which sorts
 * "cancelled" and "drawn" before "expired" and "issued" — so the live undrawn
 * facilities, the only ones anybody can still act on, were the first to fall
 * off as dead rows accumulated. Two changes fix that: everything still open is
 * read whatever its age, and what is closed is bounded by date instead of by
 * luck of the alphabet.
 */
const MAX_FACILITIES = 500;
const CLOSED_MONTHS = 24;

/** Lapsed references named on the screen. The panel says how many there are. */
const MAX_LAPSED = 200;

export async function facilityRegister(opts: {
  orgId: string; entityId: string; asOf?: Date | string; status?: FacilityStatus;
}) {
  const asOf = opts.asOf ? asDate(opts.asOf, "The date") : new Date();
  const since = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - CLOSED_MONTHS, asOf.getUTCDate()));

  const page = await prisma.tradeFacility.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      ...(opts.status ? { status: opts.status } : {}),
      OR: [
        // Still open, however long ago it was issued: the bank is holding
        // margin against it and somebody has to act on it.
        { status: { in: ["issued", "drawn"] } },
        // Closed, but recent enough that a reader is still reconciling it.
        { expiresOn: { gte: since } },
      ],
    },
    // Soonest expiry first, so what has lapsed and what is about to lapse are
    // at the top rather than behind a decade of settled paper.
    orderBy: [{ expiresOn: "asc" }, { reference: "asc" }],
    take: MAX_FACILITIES + 1,
  });
  const truncated = page.length > MAX_FACILITIES;
  const facilities = truncated ? page.slice(0, MAX_FACILITIES) : page;

  const events = facilities.length
    ? await prisma.tradeFacilityEvent.findMany({
        where: { orgId: opts.orgId, facilityId: { in: facilities.map((f) => f.id) } },
        orderBy: { happenedOn: "asc" },
      })
    : [];

  const byFacility = new Map<string, typeof events>();
  for (const e of events) byFacility.set(e.facilityId, [...(byFacility.get(e.facilityId) ?? []), e]);

  /**
   * A facility past its expiry that nobody has closed. The bank is still
   * holding the margin and the register still shows a facility that has
   * lapsed — the first overstates cash, the second leaves a line on a
   * screen that no longer means anything.
   *
   * A drawn facility counts. Drawing against a credit does not close it:
   * the balance may be settled, the margin is still with the bank, and
   * "drawn" is exactly the state a forgotten facility sits in.
   *
   * Asked of the database rather than read off the page above, and without
   * the status filter: whether the bank is still holding margin against a
   * dead facility does not change because somebody is looking at the
   * cancelled ones.
   */
  const lapsedRows = await prisma.tradeFacility.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      status: { in: ["issued", "drawn"] },
      expiresOn: { lt: asOf },
    },
    orderBy: { expiresOn: "asc" },
    take: MAX_LAPSED + 1,
    select: { reference: true },
  });
  const lapsedTruncated = lapsedRows.length > MAX_LAPSED;

  const lapsedCount = lapsedTruncated
    ? await prisma.tradeFacility.count({
        where: {
          orgId: opts.orgId, entityId: opts.entityId,
          status: { in: ["issued", "drawn"] },
          expiresOn: { lt: asOf },
        },
      })
    : lapsedRows.length;

  return {
    asOf: iso(asOf),
    since: iso(since),
    /** True when more facilities matched than were listed. */
    truncated,
    listed: facilities.length,
    facilities: facilities.map((f) => {
      const mine = byFacility.get(f.id) ?? [];
      const outstanding = mine.reduce(
        (a, e) => a + (e.kind === "draw" ? e.amountMinor : e.kind === "settle" ? -e.amountMinor : 0n), 0n,
      );
      const daysToExpiry = Math.round((f.expiresOn.getTime() - asOf.getTime()) / 86_400_000);
      return {
        reference: f.reference,
        kind: f.kind as FacilityKind,
        kindLabel: KINDS[f.kind as FacilityKind],
        bank: f.bank,
        beneficiary: f.beneficiary,
        currency: f.currency,
        amountMinor: f.amountMinor,
        marginMinor: f.marginMinor,
        commissionMinor: f.commissionMinor,
        drawnMinor: f.drawnMinor,
        availableMinor: f.amountMinor - f.drawnMinor,
        owedToBankMinor: outstanding,
        issuedOn: iso(f.issuedOn),
        expiresOn: iso(f.expiresOn),
        daysToExpiry,
        expired: f.expiresOn < asOf && (f.status === "issued" || f.status === "drawn"),
        status: f.status as FacilityStatus,
        ownExposure: isOwnExposure(f.kind as FacilityKind),
        notes: f.notes,
        events: mine.map((e) => ({
          kind: e.kind, happenedOn: iso(e.happenedOn),
          amountMinor: e.amountMinor, entryId: e.entryId, memo: e.memo,
        })),
      };
    }),
    lapsed: lapsedRows.slice(0, MAX_LAPSED).map((f) => f.reference),
    lapsedCount,
  };
}
