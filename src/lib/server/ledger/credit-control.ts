import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { receivablesAgeing } from "./ar";
import { attributeDocument, partyIndex } from "./counterparties";
import { listOrders, orderDetail } from "./sales-orders";
import { fmtMinor } from "@/lib/ledger/format";
import type { Counterparty, CreditHold, DunningNotice } from "@prisma/client";
import type { Invoice } from "@/lib/domain/types";

/**
 * Credit control: how much a customer may owe, whether they may owe any more
 * today, what to send them when they do not pay, and what they can be shown to
 * prove it.
 *
 * Nothing in this module posts. Not one function here moves a balance, and
 * none of them may: a credit limit that could touch the ledger would stop being
 * a control and start being an entry, and the first argument about a customer's
 * balance would then be an argument about the control that was supposed to
 * settle it.
 *
 * Four ideas hold the whole file up.
 *
 * **Exposure is computed, never accumulated.** There is no `exposureMinor`
 * column anywhere. Every figure below is recomputed from the receivables
 * control account plus what has been committed on open sales orders, each time
 * it is asked for. A stored running total is wrong the first time somebody
 * posts a journal by hand, reverses an invoice, or imports an opening balance,
 * and nobody finds out until a customer disputes a statement six weeks later.
 * Recomputing costs a query; a wrong stored total costs a relationship.
 *
 * **A limit has a date.** `Counterparty.creditLimitMinor` holds one number and
 * no history, which cannot answer the only question worth asking about a
 * breach: what was this customer allowed to owe on the day that order was
 * taken? So limits are rows in `CreditLimit`, the limit in force on a date is
 * the latest row on or before it, and raising a limit today does not
 * retrospectively bless last quarter.
 *
 * **No limit set is not a limit of nil.** They are opposite facts. Nil is an
 * assessment — cash up front. Nothing is the absence of an assessment. The
 * default each one implies is argued at `decide()` below, where the choice is
 * actually made.
 *
 * **It suggests and records; it does not send.** `dunningLetter` returns text.
 * There is no mail transport in this product — no SMTP client, no provider
 * credentials, no queue — so nothing here can put a letter in front of a
 * customer, and pretending otherwise would let a collections run report as done
 * when nothing left the building. A person sends it, and `recordDunning` writes
 * down that they did.
 *
 * Placing a hold *is* a write, and the only one that stops a sale. It takes a
 * person and a reason, and releasing it records the release rather than
 * deleting the hold.
 */

/* ------------------------------------------------------------- small tools */

const DAY = 86_400_000;
const BPS = 10_000n;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

function asDate(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? day(v.slice(0, 10)) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date I can read.`);
  return d;
}

function minor(v: number | bigint | string, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string") {
    if (!/^-?\d+$/.test(v.trim())) throw new LedgerError(`${what} must be a whole number of minor units, not "${v}".`);
    return BigInt(v.trim());
  }
  if (!Number.isInteger(v)) throw new LedgerError(`${what} must be in whole minor units, got ${v}.`);
  return BigInt(v);
}

/** Half-up, once, at the end. Multiplication first so nothing is lost early. */
function divHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new LedgerError("Division by nothing.");
  const neg = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = (n * 2n + d) / (d * 2n);
  return neg ? -q : q;
}

/** Money inside a sentence, in the same shape the rest of the ledger writes it. */
const money = (v: bigint, currency: string) => `${currency} ${fmtMinor(v, currency, { zero: "zero" })}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The receivables control account. Mirrors `AR_CONTROL` in ar.ts. */
const AR_CONTROL = "1100";

/** A party that can be sold to. A supplier-only record cannot. */
const sells = (kind: string) => kind === "CUSTOMER" || kind === "BOTH";

/**
 * The books' own currency. A limit is compared against a balance, and a
 * comparison across two currencies is a comparison at some rate — so both sides
 * are held in the functional currency, which is the one the receivables control
 * account is kept in.
 */
async function functionalCurrency(orgId: string, entityId: string): Promise<string> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, kind: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  return book?.functionalCurrency ?? "AED";
}

/* ------------------------------------------------------------ finding them */

/**
 * The key everything here joins on is the counterparty's own `code`.
 *
 * A caller may hand over the code, the record's id, or the customer's name,
 * because all three are what somebody has to hand at the point of asking; they
 * are resolved to the code once, here, so that a limit filed under "ACME" and a
 * hold filed under "acme" can never be two arrangements for one customer.
 */
export function partyKeyOf(party: Counterparty): string {
  return party.code.trim();
}

async function resolveParty(opts: { orgId: string; entityId: string; partyKey: string }): Promise<Counterparty> {
  const key = (opts.partyKey ?? "").trim();
  if (!key) throw new LedgerError("Which customer? A credit check needs one.");
  const scope = { orgId: opts.orgId, entityId: opts.entityId };

  const exact = await prisma.counterparty.findFirst({ where: { ...scope, code: key } });
  if (exact) return exact;

  const loose = await prisma.counterparty.findMany({
    where: { ...scope, OR: [{ id: key }, { code: { equals: key, mode: "insensitive" } }, { name: { equals: key, mode: "insensitive" } }] },
  });
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) {
    throw new LedgerError(
      `"${key}" matches ${loose.length} customers in this entity (${loose.map((p) => p.code).join(", ")}). ` +
        `Use the code, so the credit check is against the account you mean.`,
    );
  }
  throw new LedgerError(
    `There is no customer with the code ${key} in this entity, so there is nothing to check credit against. ` +
      `Open the customer record first — a sale to a party nobody has set up appears on no receivables report.`,
  );
}

/* ------------------------------------------------- reading the sales ledger */

interface Movement {
  key: string;
  date: Date;
  reference: string;
  description: string;
  amountMinor: bigint;
  source: string;
}

interface DocFacts {
  key: string;
  partyId: string | null;
  number: string;
  description: string;
  date: Date;
  due: Date | null;
  reference: string;
  outstanding: bigint;
  opened: boolean;
}

interface SalesLedger {
  movements: Movement[];
  docs: Map<string, DocFacts>;
}

/**
 * Every movement on the receivables control account up to a date, netted into
 * open items and attributed to a customer.
 *
 * The open-item key is the same expression ar.ts and counterparties.ts use —
 * `settlesId ?? sourceId` — rather than a second one that happens to agree
 * today. A receipt is keyed by the invoice it settles, so it lands on that
 * invoice instead of floating as an item of its own; and the item's date and
 * age come from the invoice that opened it, never from the receipt that closed
 * part of it.
 *
 * `status: { in: ["posted", "reversed"] }` is not a detail. Filtering to
 * "posted" alone counts a reversing entry while dropping the original, which
 * moves the balance by the full amount in the wrong direction — an invoice that
 * was raised and reversed would show as a credit the customer never had.
 *
 * Whose document it is comes from the document store, because a journal line
 * records what an entry did to the books and never who it was with. That is the
 * one fact taken from outside the ledger, and it is read through the same
 * attribution ladder counterparties.ts uses so the two can never disagree about
 * whose invoice this is.
 */
async function salesLedger(opts: {
  orgId: string;
  entityId: string;
  to: Date;
  parties: Counterparty[];
}): Promise<SalesLedger> {
  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: AR_CONTROL },
  });
  if (!account) {
    throw new LedgerError(
      `The receivables control account ${AR_CONTROL} does not exist for this entity, so there is no exposure to ` +
        `measure a credit limit against. Open the books for the entity first.`,
    );
  }

  const rows = await prisma.journalLine.findMany({
    where: {
      accountId: account.id,
      entry: { orgId: opts.orgId, status: { in: ["posted", "reversed"] }, entryDate: { lte: opts.to } },
    },
    include: {
      entry: {
        select: {
          entryDate: true, dueDate: true, sourceId: true, settlesId: true,
          memo: true, source: true, series: true, number: true,
        },
      },
    },
  });

  // A statement is read down the page, so the order has to be total: two
  // documents on one day must come out in the same sequence every time, or this
  // month's copy and the customer's copy disagree over nothing.
  const seq = (n: string) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
  const sorted = [...rows].sort(
    (a, b) =>
      a.entry.entryDate.getTime() - b.entry.entryDate.getTime() ||
      a.entry.series.localeCompare(b.entry.series) ||
      seq(a.entry.number) - seq(b.entry.number) ||
      a.lineNo - b.lineNo,
  );

  const movements: Movement[] = [];
  const docs = new Map<string, DocFacts>();
  for (const l of sorted) {
    const key = l.settlesId ?? l.entry.settlesId ?? l.entry.sourceId ?? l.id;
    const reference = `${l.entry.series}-${l.entry.number}`;
    const opensItem = l.entry.source === "invoice";
    movements.push({
      key,
      date: l.entry.entryDate,
      reference,
      description: l.memo ?? l.entry.memo ?? "",
      amountMinor: l.functionalAmountMinor,
      source: l.entry.source,
    });

    const prev = docs.get(key);
    if (prev) {
      prev.outstanding += l.functionalAmountMinor;
      if (opensItem && !prev.opened) {
        prev.description = l.entry.memo ?? prev.description;
        prev.date = l.entry.entryDate;
        prev.due = l.entry.dueDate;
        prev.reference = reference;
        prev.opened = true;
      }
    } else {
      docs.set(key, {
        key, partyId: null, number: "",
        description: l.entry.memo ?? "",
        date: l.entry.entryDate, due: l.entry.dueDate, reference,
        outstanding: l.functionalAmountMinor, opened: opensItem,
      });
    }
  }

  const ids = [...docs.keys()];
  const stored = ids.length
    ? await prisma.record.findMany({ where: { orgId: opts.orgId, store: "invoices", id: { in: ids } } })
    : [];
  const idx = partyIndex(opts.parties);
  for (const row of stored) {
    const doc = docs.get(row.id);
    if (!doc) continue;
    let inv: Invoice | undefined;
    try { inv = JSON.parse(row.data) as Invoice; } catch { inv = undefined; }
    if (!inv || inv.direction !== "OUTBOUND") continue;
    doc.partyId = attributeDocument(inv, idx, "buyer");
    if (inv.number) doc.number = inv.number.trim();
  }

  return { movements, docs };
}

export interface OpenItem {
  documentId: string;
  number: string;
  reference: string;
  description: string;
  date: string;
  dueDate: string;
  outstandingMinor: string;
  daysOld: number;
  /** Nought when it is not yet due. Never negative — "minus four days late" is noise. */
  daysOverdue: number;
}

function openItemsOf(ledger: SalesLedger, party: Counterparty, asOf: Date): OpenItem[] {
  const out: OpenItem[] = [];
  for (const doc of ledger.docs.values()) {
    if (doc.partyId !== party.id || doc.outstanding === 0n) continue;
    // The document's own terms beat the party's default: an invoice raised on
    // sixty days does not fall late on the thirty-first because the customer
    // record happens to say thirty.
    const due = doc.due ?? addDays(doc.date, party.paymentTerms);
    // Money sitting in the customer's favour is not late — nobody is behind on
    // paying it, and ageing it sends collections after money the business owes.
    const daysOverdue = doc.outstanding > 0n ? Math.max(0, daysBetween(due, asOf)) : 0;
    out.push({
      documentId: doc.key,
      number: doc.number || doc.reference,
      reference: doc.reference,
      description: doc.description,
      date: iso(doc.date),
      dueDate: iso(due),
      outstandingMinor: doc.outstanding.toString(),
      daysOld: daysBetween(doc.date, asOf),
      daysOverdue,
    });
  }
  out.sort((a, b) => b.daysOverdue - a.daysOverdue || a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  return out;
}

/* ---------------------------------------------------------------- the limit */

export type LimitSource = "assessment" | "customer record" | "none";

export interface LimitInForce {
  /** Null means nobody has assessed this account. It is not a limit of nil. */
  limitMinor: string | null;
  limitSet: boolean;
  effectiveFrom: string | null;
  basis: string | null;
  setBy: string | null;
  source: LimitSource;
  /**
   * What the customer record carries, and whether it says the same thing.
   * The two are written together, so a disagreement means somebody edited the
   * customer record directly — worth showing rather than quietly preferring
   * one of them.
   */
  recordMinor: string | null;
  recordAgrees: boolean;
}

function limitFrom(
  party: Counterparty,
  rows: { limitMinor: bigint; effectiveFrom: Date; basis: string; setBy: string | null }[],
  asOf: Date,
): LimitInForce {
  // The latest assessment on or before the date. Later ones exist but had not
  // been made yet, and a limit raised in March cannot excuse February.
  const inForce = rows
    .filter((r) => r.effectiveFrom.getTime() <= asOf.getTime())
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];

  const record = party.creditLimitMinor;
  if (inForce) {
    return {
      limitMinor: inForce.limitMinor.toString(),
      limitSet: true,
      effectiveFrom: iso(inForce.effectiveFrom),
      basis: inForce.basis,
      setBy: inForce.setBy,
      source: "assessment",
      recordMinor: record === null ? null : record.toString(),
      recordAgrees: record !== null && record === inForce.limitMinor,
    };
  }
  // No assessment yet, but the customer record may carry a figure typed in on
  // the customers screen before credit control existed. It counts — refusing to
  // read it would report every one of those customers as unassessed — but it
  // carries no date, so it is dated from the beginning of time and labelled.
  if (record !== null) {
    return {
      limitMinor: record.toString(), limitSet: true,
      effectiveFrom: null,
      basis: "Set on the customer record, with no assessment date recorded.",
      setBy: null, source: "customer record",
      recordMinor: record.toString(), recordAgrees: true,
    };
  }
  return {
    limitMinor: null, limitSet: false, effectiveFrom: null, basis: null, setBy: null,
    source: "none", recordMinor: null, recordAgrees: true,
  };
}

/**
 * Assess a customer, on a date, with a reason.
 *
 * The counterparty record is written at the same time. Two screens showing two
 * different limits for one customer is worse than either of them being wrong,
 * because the person looking at the lower one thinks they are being careful.
 * The assessment rows remain the authority — they are the ones with dates — and
 * `recordAgrees` reports it whenever the record has since been edited past them.
 */
export async function setCreditLimit(opts: {
  orgId: string;
  entityId: string;
  partyKey: string;
  limitMinor: number | bigint | string;
  effectiveFrom?: Date | string;
  basis: string;
  actorId?: string;
}) {
  const party = await resolveParty(opts);
  const key = partyKeyOf(party);
  const currency = await functionalCurrency(opts.orgId, opts.entityId);
  const limit = minor(opts.limitMinor, "A credit limit");
  const effectiveFrom = asDate(opts.effectiveFrom ?? new Date(), "The date a limit takes effect");

  if (limit < 0n) {
    throw new LedgerError(
      `A credit limit of ${money(limit, currency)} would mean ${party.name} has to hold money with us before they ` +
        `may buy. That is a deposit arrangement, not a limit. Use nought for cash up front.`,
    );
  }
  const basis = (opts.basis ?? "").trim();
  if (!basis) {
    throw new LedgerError(
      `Set a reason for the limit of ${money(limit, currency)} on ${party.name}. Whoever is asked to raise it next ` +
        `year has only this sentence to weigh — "how it was arrived at" is the whole of a credit file.`,
    );
  }
  if (!sells(party.kind)) {
    throw new LedgerError(
      `${party.name} is recorded as a supplier, so no sale to them would ever reach the receivables ledger and a ` +
        `credit limit would check nothing. Change the record to BOTH if they are now both.`,
    );
  }

  const clash = await prisma.creditLimit.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, partyKey: key, effectiveFrom },
  });
  if (clash) {
    throw new LedgerError(
      `${party.name} already has a limit of ${money(clash.limitMinor, currency)} effective ${iso(effectiveFrom)}: ` +
        `${clash.basis}. Two limits on one day leave "the limit in force" with two answers. Date this one from a ` +
        `different day, or correct that assessment.`,
    );
  }

  const row = await prisma.creditLimit.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId, partyKey: key,
      limitMinor: limit, effectiveFrom, basis, setBy: opts.actorId ?? null,
    },
  });
  await prisma.counterparty.update({ where: { id: party.id }, data: { creditLimitMinor: limit } });

  return {
    limit: row,
    note:
      limit === 0n
        ? `${party.name} is assessed at no credit at all from ${iso(effectiveFrom)} — every sale needs payment up ` +
          `front. That is a decision, and it reads differently from a customer nobody has assessed.`
        : `${party.name} may owe up to ${money(limit, currency)} from ${iso(effectiveFrom)}. Nothing has been ` +
          `posted; this changes what the credit check answers, not what the customer owes.`,
  };
}

/** Every assessment this customer has had, newest first. */
export async function creditLimitHistory(opts: { orgId: string; entityId: string; partyKey: string }) {
  const party = await resolveParty(opts);
  const rows = await prisma.creditLimit.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, partyKey: partyKeyOf(party) },
    orderBy: { effectiveFrom: "desc" },
  });
  return {
    code: party.code,
    name: party.name,
    currency: await functionalCurrency(opts.orgId, opts.entityId),
    limits: rows.map((r) => ({
      id: r.id,
      limitMinor: r.limitMinor.toString(),
      effectiveFrom: iso(r.effectiveFrom),
      basis: r.basis,
      setBy: r.setBy,
    })),
  };
}

/* ----------------------------------------------------------------- the hold */

/**
 * Stop new sales to a customer, on the record.
 *
 * The reason is not paperwork. Whoever is asked to release this in three weeks
 * has to decide whether it still applies, and "on hold" with an empty field
 * tells them nothing — so they either release it blind or leave a paying
 * customer blocked. Both cost more than the debt did.
 */
export async function placeCreditHold(opts: {
  orgId: string;
  entityId: string;
  partyKey: string;
  reason: string;
  on?: Date | string;
  actorId?: string;
}): Promise<{ hold: CreditHold; note: string }> {
  const party = await resolveParty(opts);
  const key = partyKeyOf(party);
  const reason = (opts.reason ?? "").trim();
  if (!reason) {
    throw new LedgerError(
      `Say why ${party.name} is being held. A hold with no reason blocks a sale nobody can explain, and the person ` +
        `asked to lift it next week has nothing to weigh against the order in front of them.`,
    );
  }

  const existing = await prisma.creditHold.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, partyKey: key, releasedOn: null },
  });
  if (existing) {
    throw new LedgerError(
      `${party.name} is already on hold since ${iso(existing.placedOn)}: ${existing.reason}. Release that one first ` +
        `if the reason has changed, so the record shows both decisions instead of overwriting the first.`,
    );
  }

  const placedOn = asDate(opts.on ?? new Date(), "The date a hold is placed");
  const hold = await prisma.creditHold.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId, partyKey: key,
      placedOn, placedBy: opts.actorId ?? null, reason,
    },
  });
  // The customer record carries the flag every other screen reads, so it is set
  // here too. The hold row is the history; the flag is the signal.
  await prisma.counterparty.update({
    where: { id: party.id },
    data: { onHold: true, holdReason: reason },
  });

  return {
    hold,
    note:
      `${party.name} is on hold from ${iso(placedOn)}. New sales to them should stop until somebody releases it. ` +
      `Nothing has been posted and nothing they already owe has changed — a hold governs the next order, not the ` +
      `last one.`,
  };
}

/**
 * Let sales resume. The release is recorded on the hold rather than deleting
 * it: the question anybody asks about a re-held account is what happened the
 * last two times, and a deleted hold answers none of it.
 */
export async function releaseCreditHold(opts: {
  orgId: string;
  entityId: string;
  partyKey: string;
  reason: string;
  on?: Date | string;
  actorId?: string;
}): Promise<{ hold: CreditHold; note: string }> {
  const party = await resolveParty(opts);
  const key = partyKeyOf(party);
  const reason = (opts.reason ?? "").trim();
  if (!reason) {
    throw new LedgerError(
      `Say why the hold on ${party.name} is being lifted. The release is the decision that matters — a hold that ` +
        `can be lifted silently gets lifted by whoever is under most pressure to ship.`,
    );
  }

  const held = await prisma.creditHold.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, partyKey: key, releasedOn: null },
  });
  if (!held) throw new LedgerError(`${party.name} is not on hold, so there is nothing to release.`);

  const releasedOn = asDate(opts.on ?? new Date(), "The date a hold is released");
  if (releasedOn.getTime() < held.placedOn.getTime()) {
    throw new LedgerError(
      `The hold on ${party.name} was placed on ${iso(held.placedOn)} and cannot be released on ${iso(releasedOn)}, ` +
        `which is before it existed.`,
    );
  }

  const hold = await prisma.creditHold.update({
    where: { id: held.id },
    data: { releasedOn, releasedBy: opts.actorId ?? null, releaseReason: reason },
  });
  await prisma.counterparty.update({ where: { id: party.id }, data: { onHold: false, holdReason: null } });

  return {
    hold,
    note:
      `The hold on ${party.name} is released, ${plural(daysBetween(held.placedOn, releasedOn), "day")} after it was ` +
      `placed. Both decisions stay on the record: held for "${held.reason}", released because "${reason}".`,
  };
}

/** Every hold this customer has had, in force or not, newest first. */
export async function creditHoldHistory(opts: { orgId: string; entityId: string; partyKey: string }) {
  const party = await resolveParty(opts);
  const rows = await prisma.creditHold.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, partyKey: partyKeyOf(party) },
    orderBy: { placedOn: "desc" },
  });
  return {
    code: party.code,
    name: party.name,
    holds: rows.map((h) => ({
      id: h.id,
      placedOn: iso(h.placedOn),
      placedBy: h.placedBy,
      reason: h.reason,
      releasedOn: h.releasedOn ? iso(h.releasedOn) : null,
      releasedBy: h.releasedBy,
      releaseReason: h.releaseReason,
      inForce: h.releasedOn === null,
      heldDays: daysBetween(h.placedOn, h.releasedOn ?? new Date()),
    })),
  };
}

/* ------------------------------------------------------------- the exposure */

export interface CommittedOrder {
  id: string;
  number: string;
  status: string;
  issuedOn: string;
  /** Gross, because that is what the customer will owe once it is invoiced. */
  remainingGrossMinor: string;
}

export interface Exposure {
  /** Open items on the receivables control account. */
  ledgerMinor: string;
  /** Accepted orders not yet invoiced — a promise the business has taken. */
  committedMinor: string;
  totalMinor: string;
  pastDueMinor: string;
  oldestPastDueDays: number | null;
  items: OpenItem[];
  orders: CommittedOrder[];
  /**
   * Orders in another currency, left out of the total. Converting them would
   * need a rate nobody has stated, and a made-up rate in a credit limit is a
   * made-up limit.
   */
  excludedForeignOrders: { number: string; currency: string; remainingGrossMinor: string }[];
}

/**
 * What has actually been committed on open orders.
 *
 * A quote is an offer and does not count: nobody has agreed to anything. A
 * draft or sent order has not been accepted either. An accepted or part-invoiced
 * order has been, and the part of it still to be billed is money the business
 * has promised to extend but has not yet lent — which is precisely the sort of
 * exposure a limit checked only against invoices misses, right up until three
 * months of orders land in one week.
 *
 * The amount still to be billed is taken from the sales-order module rather
 * than recomputed here, because the VAT on it is that module's arithmetic and a
 * second computation of the same tax is a second answer.
 *
 * One honest limitation, stated because it would otherwise be discovered. An
 * order carries the date it was raised but no history of its status, so an
 * exposure asked for as at a past date leaves out orders raised after that date
 * — which is right — but reads today's status for the ones it keeps. The ledger
 * half of the exposure is exact at any date; the committed half is exact today
 * and an approximation looking backwards, and a decision taken on a historic
 * date should say so.
 */
async function committedOrders(opts: {
  orgId: string;
  entityId: string;
  asOf: Date;
  functional: string;
}): Promise<Map<string, { orders: CommittedOrder[]; totalMinor: bigint; foreign: Exposure["excludedForeignOrders"] }>> {
  const { orders } = await listOrders({ orgId: opts.orgId, entityId: opts.entityId });
  const on = iso(opts.asOf);
  const committed = orders.filter(
    (o) =>
      o.kind === "ORDER" &&
      (o.status === "accepted" || o.status === "part_invoiced") &&
      o.customerCode &&
      o.issuedOn <= on,
  );

  const out = new Map<string, { orders: CommittedOrder[]; totalMinor: bigint; foreign: Exposure["excludedForeignOrders"] }>();
  for (const o of committed) {
    const key = (o.customerCode as string).trim();
    const bucket = out.get(key) ?? { orders: [], totalMinor: 0n, foreign: [] };
    const detail = await orderDetail({ orgId: opts.orgId, orderId: o.id, entityId: opts.entityId });
    const remaining = BigInt(detail.remaining.grossMinor);
    if (remaining === 0n) { out.set(key, bucket); continue; }
    if (o.currency !== opts.functional) {
      bucket.foreign.push({ number: o.number, currency: o.currency, remainingGrossMinor: remaining.toString() });
    } else {
      bucket.orders.push({
        id: o.id, number: o.number, status: o.status, issuedOn: o.issuedOn,
        remainingGrossMinor: remaining.toString(),
      });
      bucket.totalMinor += remaining;
    }
    out.set(key, bucket);
  }
  return out;
}

/* ------------------------------------------------------------- the standing */

export interface CreditStanding {
  code: string;
  name: string;
  email: string | null;
  currency: string;
  asOf: string;
  paymentTerms: number;
  status: string;
  kind: string;
  limit: LimitInForce;
  exposure: Exposure;
  /** Null wherever no limit is set. Never Infinity, never a stand-in figure. */
  headroomMinor: string | null;
  /** How much of the limit is used, in basis points. Null with no limit. */
  usedBps: number | null;
  overLimitMinor: string | null;
  onHold: boolean;
  hold: { placedOn: string; placedBy: string | null; reason: string } | null;
  lastNotice: { stage: DunningStage; sentOn: string; sentTo: string; daysAgo: number } | null;
}

interface Context {
  asOf: Date;
  currency: string;
  ledger: SalesLedger;
  limits: Map<string, { limitMinor: bigint; effectiveFrom: Date; basis: string; setBy: string | null }[]>;
  holds: Map<string, CreditHold>;
  committed: Map<string, { orders: CommittedOrder[]; totalMinor: bigint; foreign: Exposure["excludedForeignOrders"] }>;
  notices: Map<string, DunningNotice[]>;
}

/**
 * Everything the decision needs, read once for a set of customers.
 *
 * One pass rather than one query per customer, because a credit-control screen
 * that takes a minute to load is a screen nobody opens before taking the order.
 */
async function context(opts: {
  orgId: string;
  entityId: string;
  asOf: Date;
  parties: Counterparty[];
}): Promise<Context> {
  const keys = opts.parties.map(partyKeyOf);
  const scope = { orgId: opts.orgId, entityId: opts.entityId };
  const currency = await functionalCurrency(opts.orgId, opts.entityId);

  const [ledger, limitRows, holdRows, noticeRows, committed] = await Promise.all([
    salesLedger({ ...scope, to: opts.asOf, parties: opts.parties }),
    prisma.creditLimit.findMany({ where: { ...scope, partyKey: { in: keys } } }),
    prisma.creditHold.findMany({ where: { ...scope, partyKey: { in: keys }, releasedOn: null } }),
    prisma.dunningNotice.findMany({
      where: { ...scope, partyKey: { in: keys }, sentOn: { lte: opts.asOf } },
      orderBy: [{ sentOn: "desc" }, { createdAt: "desc" }],
    }),
    committedOrders({ ...scope, asOf: opts.asOf, functional: currency }),
  ]);

  const limits = new Map<string, { limitMinor: bigint; effectiveFrom: Date; basis: string; setBy: string | null }[]>();
  for (const r of limitRows) {
    const list = limits.get(r.partyKey) ?? [];
    list.push({ limitMinor: r.limitMinor, effectiveFrom: r.effectiveFrom, basis: r.basis, setBy: r.setBy });
    limits.set(r.partyKey, list);
  }
  const holds = new Map(holdRows.map((h) => [h.partyKey, h]));
  const notices = new Map<string, DunningNotice[]>();
  for (const n of noticeRows) {
    const list = notices.get(n.partyKey) ?? [];
    list.push(n);
    notices.set(n.partyKey, list);
  }

  return { asOf: opts.asOf, currency, ledger, limits, holds, committed, notices };
}

function standingOf(ctx: Context, party: Counterparty): CreditStanding {
  const key = partyKeyOf(party);
  const items = sells(party.kind) ? openItemsOf(ctx.ledger, party, ctx.asOf) : [];
  const ledgerMinor = items.reduce((a, i) => a + BigInt(i.outstandingMinor), 0n);
  const pastDue = items.filter((i) => i.daysOverdue > 0);
  const pastDueMinor = pastDue.reduce((a, i) => a + BigInt(i.outstandingMinor), 0n);
  const oldest = pastDue.reduce((a, i) => Math.max(a, i.daysOverdue), 0);

  const committed = ctx.committed.get(key) ?? { orders: [], totalMinor: 0n, foreign: [] };
  const total = ledgerMinor + committed.totalMinor;

  const limit = limitFrom(party, ctx.limits.get(key) ?? [], ctx.asOf);
  const limitMinor = limit.limitMinor === null ? null : BigInt(limit.limitMinor);
  const headroom = limitMinor === null ? null : limitMinor - total;
  // Basis points of the limit consumed. Multiplication before division, and the
  // rounding happens once — a limit of nil has no percentage, only a breach.
  const usedBps =
    limitMinor === null || limitMinor === 0n ? null : Number(divHalfUp(total * BPS, limitMinor));

  const hold = ctx.holds.get(key) ?? null;
  const notice = (ctx.notices.get(key) ?? [])[0] ?? null;

  return {
    code: party.code,
    name: party.name,
    email: party.email,
    currency: ctx.currency,
    asOf: iso(ctx.asOf),
    paymentTerms: party.paymentTerms,
    status: party.status,
    kind: party.kind,
    limit,
    exposure: {
      ledgerMinor: ledgerMinor.toString(),
      committedMinor: committed.totalMinor.toString(),
      totalMinor: total.toString(),
      pastDueMinor: pastDueMinor.toString(),
      oldestPastDueDays: pastDue.length ? oldest : null,
      items,
      orders: committed.orders,
      excludedForeignOrders: committed.foreign,
    },
    headroomMinor: headroom === null ? null : headroom.toString(),
    usedBps,
    overLimitMinor: limitMinor !== null && total > limitMinor ? (total - limitMinor).toString() : null,
    onHold: hold !== null,
    hold: hold ? { placedOn: iso(hold.placedOn), placedBy: hold.placedBy, reason: hold.reason } : null,
    lastNotice: notice
      ? {
          stage: notice.stage as DunningStage,
          sentOn: iso(notice.sentOn),
          sentTo: notice.sentTo,
          daysAgo: daysBetween(notice.sentOn, ctx.asOf),
        }
      : null,
  };
}

/** Where one customer stands: exposure, limit, hold, and what was last sent. */
export async function creditStanding(opts: {
  orgId: string;
  entityId: string;
  partyKey: string;
  asOf?: Date | string;
}): Promise<CreditStanding> {
  const party = await resolveParty(opts);
  const asOf = asDate(opts.asOf ?? new Date(), "The as-at date");
  const ctx = await context({ orgId: opts.orgId, entityId: opts.entityId, asOf, parties: [party] });
  return standingOf(ctx, party);
}

/* -------------------------------------------------------------- the decision */

export const CREDIT_REASONS = [
  "archived", "not_a_customer", "on_hold", "over_limit", "would_exceed_limit", "past_due", "no_limit_set",
] as const;
export type CreditReasonCode = (typeof CREDIT_REASONS)[number];

export interface CreditReason {
  code: CreditReasonCode;
  /** Whether this reason on its own stops the sale. */
  blocking: boolean;
  /** A whole sentence with the figures in it. "Credit check failed" helps nobody. */
  message: string;
}

export type CreditDecision = "allow" | "review" | "refuse";

export interface CreditCheck {
  decision: CreditDecision;
  /** False only where something blocking was found. `review` still allows. */
  allowed: boolean;
  code: string;
  name: string;
  currency: string;
  asOf: string;
  additionalMinor: string;
  exposureMinor: string;
  wouldBeMinor: string;
  creditLimitMinor: string | null;
  limitSet: boolean;
  limitEffectiveFrom: string | null;
  headroomMinor: string | null;
  /** By how much the limit would be passed. Null where no limit exists. */
  overByMinor: string | null;
  pastDueMinor: string;
  oldestPastDueDays: number | null;
  pastDueDays: number | null;
  reasons: CreditReason[];
  standing: CreditStanding;
  summary: string;
}

/**
 * How many days past due is too many, before a further sale needs a person.
 *
 * Sixty is a starting point rather than law, which is why it is one constant
 * and an argument rather than a number buried in a comparison. Pass null to
 * turn the test off for a business that collects on a different rhythm.
 */
export const DEFAULT_PAST_DUE_DAYS = 60;

function decide(
  standing: CreditStanding,
  additional: bigint,
  pastDueDays: number | null,
): { decision: CreditDecision; reasons: CreditReason[]; wouldBe: bigint; overBy: bigint | null } {
  const cur = standing.currency;
  const exposure = BigInt(standing.exposure.totalMinor);
  const wouldBe = exposure + additional;
  const limit = standing.limit.limitMinor === null ? null : BigInt(standing.limit.limitMinor);
  const reasons: CreditReason[] = [];

  if (standing.status !== "active") {
    reasons.push({
      code: "archived", blocking: true,
      message:
        `${standing.name} (${standing.code}) is archived, so nothing should be sold to them. If they are trading ` +
        `again, restore the account first — that is a decision worth taking on purpose.`,
    });
  }
  if (!sells(standing.kind)) {
    reasons.push({
      code: "not_a_customer", blocking: true,
      message:
        `${standing.name} is recorded as a supplier, not a customer, so a sale to them would appear on no ` +
        `receivables report and no credit limit would ever check it. Change the record to BOTH if they are now both.`,
    });
  }
  if (standing.onHold && standing.hold) {
    reasons.push({
      code: "on_hold", blocking: true,
      message:
        `${standing.name} has been on hold since ${standing.hold.placedOn}: ${standing.hold.reason}. Releasing it ` +
        `is a commercial decision and has to be taken, with a reason, before this goes out.`,
    });
  }

  if (limit === null) {
    // The choice, and why it goes this way.
    //
    // "No limit set" does NOT refuse. Refusing would block the first order of
    // every new customer, and the only way to clear the block, in front of a
    // customer, is to type a limit in — so limits get typed to unblock sales
    // rather than because anyone assessed the account, and within a month every
    // figure in the table is fiction. A control everybody routes around
    // controls nothing.
    //
    // Allowing it is not "letting them through" either: the answer comes back
    // `review`, it names the gap, and every other test still bites. An
    // unassessed customer who is past due or on hold is still refused, on those
    // grounds, which are the grounds that actually describe the risk. The one
    // case this lets past is a customer nobody has assessed who owes nothing
    // late — and the honest thing to say about that customer is that no limit
    // has been set, not to pretend one was set at nil.
    reasons.push({
      code: "no_limit_set", blocking: false,
      message:
        `No credit limit has been set for ${standing.name}, so ${money(additional, cur)} was not checked against ` +
        `one. Their exposure today is ${money(exposure, cur)} and would be ${money(wouldBe, cur)} after this. ` +
        `A nil limit is not a limit of nought — it means the account has never been assessed. Assess it.`,
    });
  } else if (exposure > limit) {
    reasons.push({
      code: "over_limit", blocking: true,
      message:
        `${standing.name} is already ${money(exposure - limit, cur)} over their credit limit: they carry ` +
        `${money(exposure, cur)} against a limit of ${money(limit, cur)}` +
        (standing.limit.effectiveFrom ? ` set from ${standing.limit.effectiveFrom}` : "") +
        `. The limit was passed before this sale was asked about.`,
    });
  } else if (wouldBe > limit) {
    reasons.push({
      code: "would_exceed_limit", blocking: true,
      message:
        `${standing.name} carries ${money(exposure, cur)} and ${money(additional, cur)} more would take them to ` +
        `${money(wouldBe, cur)}, which is ${money(wouldBe - limit, cur)} over their limit of ${money(limit, cur)}` +
        (limit === 0n ? " — they are a cash-up-front account" : "") +
        `. Take payment on account, raise the limit deliberately, or have it approved.`,
    });
  }

  const oldest = standing.exposure.oldestPastDueDays;
  if (pastDueDays !== null && oldest !== null && oldest > pastDueDays) {
    reasons.push({
      code: "past_due", blocking: true,
      message:
        `${standing.name} has ${money(BigInt(standing.exposure.pastDueMinor), cur)} past due, the oldest by ` +
        `${plural(oldest, "day")} against ` +
        `${standing.paymentTerms === 0 ? "payment on receipt" : `${standing.paymentTerms}-day terms`} — beyond the ` +
        `${plural(pastDueDays, "day")} this entity allows before a further sale needs a person. Selling more to a ` +
        `customer who has not paid for the last lot increases the loss rather than the revenue.`,
    });
  }

  const blocking = reasons.some((r) => r.blocking);
  const decision: CreditDecision = blocking ? "refuse" : reasons.length ? "review" : "allow";
  const overBy = limit === null ? null : wouldBe > limit ? wouldBe - limit : 0n;
  return { decision, reasons, wouldBe, overBy };
}

/**
 * The gate an order or an invoice path calls before it commits.
 *
 * **Where this belongs.** Call it from the point where the *commitment* is
 * made — accepting an order, or issuing an invoice — before the document goes
 * to the customer, so the answer can be shown to the person raising it while
 * they can still do something about it. It is deliberately not called from
 * `postInvoice` in ar.ts and it must not be: by the time an invoice reaches the
 * ledger it has been issued, and refusing to post it would leave the books
 * denying a document the customer is holding. Credit control decides whether to
 * sell; the ledger records what was sold.
 *
 * Every reason is returned separately, and each says whether it blocks on its
 * own. A single collapsed boolean makes the answer un-appealable: the person in
 * front of the customer cannot tell "they are eight hundred over" from "nobody
 * has ever assessed this account", and those need opposite responses.
 */
export async function creditCheck(opts: {
  orgId: string;
  entityId: string;
  partyKey: string;
  /** What this order or invoice would add. Nought asks "where do they stand?". */
  additionalMinor?: number | bigint | string;
  asOf?: Date | string;
  /** Days past due beyond which a further sale needs a person. Null turns it off. */
  pastDueDays?: number | null;
}): Promise<CreditCheck> {
  const party = await resolveParty(opts);
  const asOf = asDate(opts.asOf ?? new Date(), "The as-at date");
  const additional = minor(opts.additionalMinor ?? 0, "The amount being checked");
  if (additional < 0n) {
    throw new LedgerError(
      `A credit check needs what the sale would add, and ${additional} is not that. A credit note reduces the ` +
        `balance and never needs checking.`,
    );
  }
  const pastDueDays = opts.pastDueDays === undefined ? DEFAULT_PAST_DUE_DAYS : opts.pastDueDays;
  if (pastDueDays !== null && (!Number.isInteger(pastDueDays) || pastDueDays < 0)) {
    throw new LedgerError(`A past-due threshold is a whole number of days, so ${opts.pastDueDays} is not one.`);
  }

  const ctx = await context({ orgId: opts.orgId, entityId: opts.entityId, asOf, parties: [party] });
  const standing = standingOf(ctx, party);
  const { decision, reasons, wouldBe, overBy } = decide(standing, additional, pastDueDays);

  const cur = standing.currency;
  const head =
    decision === "refuse"
      ? `Refused, on ${plural(reasons.filter((r) => r.blocking).length, "ground")}.`
      : decision === "review"
        ? "Allowed, but somebody should look at it."
        : `Allowed. ${standing.name} would carry ${money(wouldBe, cur)}` +
          (standing.limit.limitMinor !== null
            ? ` against a limit of ${money(BigInt(standing.limit.limitMinor), cur)}, leaving ` +
              `${money(BigInt(standing.limit.limitMinor) - wouldBe, cur)}.`
            : ".");

  return {
    decision,
    allowed: decision !== "refuse",
    code: standing.code,
    name: standing.name,
    currency: cur,
    asOf: iso(asOf),
    additionalMinor: additional.toString(),
    exposureMinor: standing.exposure.totalMinor,
    wouldBeMinor: wouldBe.toString(),
    creditLimitMinor: standing.limit.limitMinor,
    limitSet: standing.limit.limitSet,
    limitEffectiveFrom: standing.limit.effectiveFrom,
    headroomMinor: standing.headroomMinor,
    overByMinor: overBy === null ? null : overBy.toString(),
    pastDueMinor: standing.exposure.pastDueMinor,
    oldestPastDueDays: standing.exposure.oldestPastDueDays,
    pastDueDays,
    reasons,
    standing,
    summary: [head, ...reasons.map((r) => r.message)].join(" "),
  };
}

/* ------------------------------------------------------------------ dunning */

export const DUNNING_STAGES = ["reminder", "first", "second", "final"] as const;
export type DunningStage = (typeof DUNNING_STAGES)[number];

/**
 * The ladder: how late something has to be before each rung is warranted.
 *
 * One table rather than four thresholds scattered through the code, so a
 * business that collects on a different rhythm can see the whole policy at once
 * and argue with it. These are days past the document's own due date, not days
 * since it was raised — a sixty-day invoice is not late on its thirty-first day
 * however old it looks.
 */
export const DUNNING_LADDER: { stage: DunningStage; fromDays: number; description: string }[] = [
  { stage: "reminder", fromDays: 7, description: "a courteous reminder with the statement" },
  { stage: "first", fromDays: 14, description: "a first written request naming a date" },
  { stage: "second", fromDays: 30, description: "a second request, warning that the account may be held" },
  { stage: "final", fromDays: 60, description: "a final request before the account is held and referred internally" },
];

const rankOf = (stage: DunningStage) => DUNNING_STAGES.indexOf(stage);

/** The rung an age alone warrants, or null when nothing is late enough yet. */
export function stageForDays(days: number): DunningStage | null {
  let found: DunningStage | null = null;
  for (const rung of DUNNING_LADDER) if (days >= rung.fromDays) found = rung.stage;
  return found;
}

/**
 * How long to leave between letters. Seven days, because the point of a ladder
 * is that each rung means more than the last, and a letter that arrives every
 * morning teaches the customer that none of them mean anything.
 */
export const DEFAULT_COOLOFF_DAYS = 7;

export interface DunningRow {
  code: string;
  name: string;
  email: string | null;
  currency: string;
  pastDueMinor: string;
  exposureMinor: string;
  oldestPastDueDays: number;
  itemCount: number;
  /** What the age alone warrants. */
  stageByAge: DunningStage;
  /** What should actually go next, given what has already gone. */
  stageDue: DunningStage;
  lastStage: DunningStage | null;
  lastSentOn: string | null;
  daysSinceLast: number | null;
  /** True where a letter went inside the cooling-off period. */
  suppressed: boolean;
  onHold: boolean;
  overLimit: boolean;
  reason: string;
  items: OpenItem[];
}

/**
 * Work out the next rung for a customer who is late.
 *
 * Two rules, and both matter. The ladder never restarts: a customer who has had
 * the first letter gets the second, not the first again, because repeating a
 * rung is how a collections process becomes background noise. And it never
 * jumps past what the age warrants by more than one rung, because sending a
 * final demand to somebody nine days late is a threat the business cannot back
 * and will not thank itself for.
 */
function nextStage(byAge: DunningStage, last: DunningStage | null): DunningStage {
  if (last === null) return byAge;
  const wanted = Math.max(rankOf(byAge), rankOf(last) + 1);
  return DUNNING_STAGES[Math.min(wanted, DUNNING_STAGES.length - 1)];
}

/**
 * Who to chase, worst first, at which rung, and what has already gone to them.
 *
 * Nothing here changes anything and nothing is sent. There is no mail transport
 * in this product, so the output is a list a person works through — and every
 * row says what it is based on, because a collections list nobody can check is
 * a list nobody trusts by the second week.
 */
export async function dunningPlan(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date | string;
  cooloffDays?: number;
}) {
  const asOf = asDate(opts.asOf ?? new Date(), "The as-at date");
  const cooloff = opts.cooloffDays ?? DEFAULT_COOLOFF_DAYS;
  if (!Number.isInteger(cooloff) || cooloff < 0) {
    throw new LedgerError(`A cooling-off period is a whole number of days, so ${opts.cooloffDays} is not one.`);
  }

  const parties = await prisma.counterparty.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: "active", kind: { in: ["CUSTOMER", "BOTH"] } },
    orderBy: { code: "asc" },
  });
  if (parties.length === 0) {
    return { asOf: iso(asOf), cooloffDays: cooloff, rows: [], totalPastDueMinor: "0", currency: await functionalCurrency(opts.orgId, opts.entityId), note: NEVER_SENDS };
  }

  const ctx = await context({ orgId: opts.orgId, entityId: opts.entityId, asOf, parties });
  const rows: DunningRow[] = [];

  for (const party of parties) {
    const standing = standingOf(ctx, party);
    const oldest = standing.exposure.oldestPastDueDays;
    if (oldest === null) continue;
    const byAge = stageForDays(oldest);
    if (byAge === null) continue;

    const last = standing.lastNotice;
    const stageDue = nextStage(byAge, last?.stage ?? null);
    const suppressed = last !== null && last.daysAgo < cooloff;
    const items = standing.exposure.items.filter((i) => i.daysOverdue > 0);
    const cur = standing.currency;

    const reason =
      `${standing.name} has ${money(BigInt(standing.exposure.pastDueMinor), cur)} past due across ` +
      `${plural(items.length, "document")}, the oldest by ${plural(oldest, "day")} against ` +
      `${party.paymentTerms === 0 ? "payment-on-receipt" : `${party.paymentTerms}-day`} terms. ` +
      (last === null
        ? `Nothing has been sent yet, so the ladder starts at ${stageDue}.`
        : `The ${last.stage} letter went on ${last.sentOn}, ${plural(last.daysAgo, "day")} ago, so the next rung is ` +
          `${stageDue}.`) +
      (suppressed
        ? ` Held back: a letter went inside the last ${plural(cooloff, "day")}, and one every morning teaches them ` +
          `that none of them mean anything.`
        : "") +
      (standing.overLimitMinor
        ? ` They are also ${money(BigInt(standing.overLimitMinor), cur)} over their credit limit.`
        : "") +
      (standing.onHold ? ` The account is already on hold: ${standing.hold?.reason}` : "");

    rows.push({
      code: standing.code, name: standing.name, email: standing.email, currency: cur,
      pastDueMinor: standing.exposure.pastDueMinor,
      exposureMinor: standing.exposure.totalMinor,
      oldestPastDueDays: oldest,
      itemCount: items.length,
      stageByAge: byAge,
      stageDue,
      lastStage: last?.stage ?? null,
      lastSentOn: last?.sentOn ?? null,
      daysSinceLast: last?.daysAgo ?? null,
      suppressed,
      onHold: standing.onHold,
      overLimit: standing.overLimitMinor !== null,
      reason,
      items,
    });
  }

  // Worst first: latest, then largest. Whoever works this list from the top is
  // spending the morning on the debts that will hurt most.
  rows.sort(
    (a, b) =>
      b.oldestPastDueDays - a.oldestPastDueDays ||
      (BigInt(b.pastDueMinor) > BigInt(a.pastDueMinor) ? 1 : BigInt(b.pastDueMinor) < BigInt(a.pastDueMinor) ? -1 : 0) ||
      a.code.localeCompare(b.code),
  );

  return {
    asOf: iso(asOf),
    cooloffDays: cooloff,
    currency: ctx.currency,
    rows,
    totalPastDueMinor: rows.reduce((a, r) => a + BigInt(r.pastDueMinor), 0n).toString(),
    note: NEVER_SENDS,
  };
}

const NEVER_SENDS =
  "Nothing on this list has been sent. There is no mail transport in this product — no SMTP client, no provider " +
  "credentials, no queue — so a letter reaches a customer only when a person sends it, and only then should it be " +
  "recorded here. No account has been held and no record has been written by producing this list.";

/* ------------------------------------------------------------- the letters */

export interface DunningLetter {
  code: string;
  name: string;
  stage: DunningStage;
  to: string | null;
  subject: string;
  body: string;
  pastDueMinor: string;
  oldestPastDueDays: number;
  itemCount: number;
  note: string;
}

const OPENING: Record<DunningStage, string> = {
  reminder:
    "We are writing about the account below, which shows an amount now past its due date. This may well have " +
    "crossed with your payment, in which case please ignore this note.",
  first:
    "The amount below remains outstanding past its due date. We would be grateful for payment, or for a note of " +
    "what is holding it, so that we can put it right.",
  second:
    "The amount below is still outstanding and no payment has reached us since we last wrote. We would rather " +
    "agree how it is to be cleared than let it run on.",
  final:
    "The amount below remains unpaid despite our earlier requests. Unless it is settled, or a schedule is agreed, " +
    "we will place the account on hold, which means we will not be able to accept further orders.",
};

const CLOSING: Record<DunningStage, string> = {
  reminder: "If there is anything wrong with any of these documents, please tell us and we will look into it.",
  first: "Please arrange payment, or contact us to discuss it, within seven days of this letter.",
  second:
    "Please arrange payment within seven days, or contact us to agree a schedule. We would prefer to agree one " +
    "than to hold the account.",
  final:
    "Please contact us within seven days. If we do not hear from you, the account will be placed on hold and the " +
    "balance referred internally for recovery.",
};

/**
 * The letter text. It is returned, not sent.
 *
 * It says nothing the business cannot do. It does not threaten legal action,
 * which is not this module's to promise and rarely the business's intention;
 * it does not charge interest, which is only due where the contract says so;
 * and where it mentions a hold it means the hold this module can actually
 * place. A demand that over-claims is a demand the customer's own lawyer
 * teaches them to ignore.
 *
 * One thing in it is a legal step rather than a courtesy. Article 64(1) of
 * Federal Decree-Law No. 8 of 2017 on Value Added Tax lets a supplier adjust
 * the output tax on a bad debt only where the consideration has been written
 * off in the accounts, more than six months have passed since the date of
 * supply, and **the supplier has notified the customer** of the amount written
 * off. So the notice trail matters beyond collections: without a recorded
 * notification there is no relief to claim, and the VAT on an invoice nobody
 * ever paid stays paid. Items past 180 days are called out for that reason.
 */
export async function dunningLetter(opts: {
  orgId: string;
  entityId: string;
  partyKey: string;
  stage?: DunningStage;
  asOf?: Date | string;
  /** How the business signs itself. The entity's own name, where it has one. */
  from?: string;
}): Promise<DunningLetter> {
  const party = await resolveParty(opts);
  const asOf = asDate(opts.asOf ?? new Date(), "The as-at date");
  const ctx = await context({ orgId: opts.orgId, entityId: opts.entityId, asOf, parties: [party] });
  const standing = standingOf(ctx, party);
  const cur = standing.currency;

  const items = standing.exposure.items.filter((i) => i.daysOverdue > 0);
  const oldest = standing.exposure.oldestPastDueDays;
  if (oldest === null || items.length === 0) {
    throw new LedgerError(
      `${party.name} has nothing past due at ${iso(asOf)}, so there is nothing to write to them about. ` +
        `They carry ${money(BigInt(standing.exposure.ledgerMinor), cur)} on the sales ledger, all of it within terms.`,
    );
  }

  const byAge = stageForDays(oldest);
  const stage = opts.stage ?? nextStage(byAge ?? "reminder", standing.lastNotice?.stage ?? null);
  if (!DUNNING_STAGES.includes(stage)) {
    throw new LedgerError(`"${stage}" is not a rung on this ladder. Use one of ${DUNNING_STAGES.join(", ")}.`);
  }

  const pastDue = items.reduce((a, i) => a + BigInt(i.outstandingMinor), 0n);
  const width = Math.max(12, ...items.map((i) => i.number.length));
  const table = items
    .map(
      (i) =>
        `  ${i.number.padEnd(width)}  ${i.date}  due ${i.dueDate}  ` +
        `${money(BigInt(i.outstandingMinor), cur).padStart(18)}  ${plural(i.daysOverdue, "day")} past due`,
    )
    .join("\n");

  const stale = items.filter((i) => i.daysOverdue >= 180);
  const unallocated = standing.exposure.items.filter((i) => BigInt(i.outstandingMinor) < 0n);

  const body = [
    `${party.name}`,
    `Statement of overdue account as at ${iso(asOf)}`,
    "",
    OPENING[stage],
    "",
    `Past due: ${money(pastDue, cur)} across ${plural(items.length, "document")}, the oldest by ` +
      `${plural(oldest, "day")} against ` +
      `${party.paymentTerms === 0 ? "payment-on-receipt terms" : `${party.paymentTerms}-day terms`}.`,
    "",
    table,
    "",
    `Total past due: ${money(pastDue, cur)}`,
    `Total on the account, including amounts not yet due: ` +
      `${money(BigInt(standing.exposure.ledgerMinor), cur)}`,
    ...(unallocated.length
      ? [
          "",
          `We also hold ${money(-unallocated.reduce((a, i) => a + BigInt(i.outstandingMinor), 0n), cur)} on your ` +
            `account that is not yet set against an invoice. Tell us which documents it is meant for and we will ` +
            `apply it.`,
        ]
      : []),
    ...(stale.length
      ? [
          "",
          `${plural(stale.length, "document")} on this account ` +
            `${stale.length === 1 ? "is" : "are"} more than six months past due. Please note that, where an amount ` +
            `is written off as a bad debt, we are required to notify you of the amount written off before the VAT ` +
            `on it can be adjusted — Article 64(1) of Federal Decree-Law No. 8 of 2017. This letter is not that ` +
            `notice; we would much rather be paid.`,
        ]
      : []),
    "",
    CLOSING[stage],
    "",
    opts.from ? `${opts.from}` : "Accounts receivable",
  ].join("\n");

  return {
    code: party.code,
    name: party.name,
    stage,
    to: party.email,
    subject: `${party.name} — overdue account, ${money(pastDue, cur)} as at ${iso(asOf)}`,
    body,
    pastDueMinor: pastDue.toString(),
    oldestPastDueDays: oldest,
    itemCount: items.length,
    note:
      "This text has not been sent and cannot be: there is no mail transport in this product. Copy it into whatever " +
      "the business actually sends from, and then record that it went, so the ladder knows where it stands.",
  };
}

/**
 * Record that a letter went out.
 *
 * This is the memory the ladder runs on, so it is written only for something a
 * person actually sent. It refuses two things: the same rung inside the
 * cooling-off period, and a rung below one already climbed. Both refusals exist
 * because a ladder that repeats or slides back is not a ladder — it is four
 * different letters that all mean "we would like to be paid", which the
 * customer works out by the third one.
 */
export async function recordDunning(opts: {
  orgId: string;
  entityId: string;
  partyKey: string;
  stage?: DunningStage;
  sentTo?: string;
  sentOn?: Date | string;
  cooloffDays?: number;
  actorId?: string;
  from?: string;
}) {
  const party = await resolveParty(opts);
  const key = partyKeyOf(party);
  const sentOn = asDate(opts.sentOn ?? new Date(), "The date a letter went out");
  const cooloff = opts.cooloffDays ?? DEFAULT_COOLOFF_DAYS;

  const letter = await dunningLetter({
    orgId: opts.orgId, entityId: opts.entityId, partyKey: key,
    stage: opts.stage, asOf: sentOn, from: opts.from,
  });

  const sentTo = (opts.sentTo ?? party.email ?? "").trim();
  if (!sentTo) {
    throw new LedgerError(
      `There is no email address on ${party.name}'s record and none was given, so there is nowhere to say this ` +
        `letter went. "We chased them" with no address is not evidence, and it is the evidence that matters when ` +
        `the debt is argued about.`,
    );
  }

  const previous = await prisma.dunningNotice.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, partyKey: key },
    orderBy: [{ sentOn: "desc" }, { createdAt: "desc" }],
  });
  const last = previous[0];
  if (last) {
    const gap = daysBetween(last.sentOn, sentOn);
    if (gap < 0) {
      throw new LedgerError(
        `The ${last.stage} letter to ${party.name} is recorded as going out on ${iso(last.sentOn)}, which is after ` +
          `${iso(sentOn)}. Record them in the order they were sent, or the ladder reads backwards.`,
      );
    }
    if (gap < cooloff) {
      throw new LedgerError(
        `The ${last.stage} letter went to ${party.name} on ${iso(last.sentOn)}, ${plural(gap, "day")} ago. ` +
          `Leave ${plural(cooloff, "day")} between letters — one every morning teaches the customer that none of ` +
          `them mean anything. The next one can go on ${iso(addDays(last.sentOn, cooloff))}.`,
      );
    }
    const highest = previous.reduce((a, n) => Math.max(a, rankOf(n.stage as DunningStage)), -1);
    if (rankOf(letter.stage) < highest) {
      throw new LedgerError(
        `${party.name} has already had the ${DUNNING_STAGES[highest]} letter, so a ${letter.stage} now would step ` +
          `back down the ladder. Escalate, or leave it and agree a schedule — do not restart.`,
      );
    }
  }

  const notice = await prisma.dunningNotice.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId, partyKey: key,
      stage: letter.stage, sentOn, sentTo,
      overdueMinor: BigInt(letter.pastDueMinor),
      oldestDays: letter.oldestPastDueDays,
      itemCount: letter.itemCount,
      letter: letter.body,
      recordedBy: opts.actorId ?? null,
    },
  });

  return {
    notice: {
      id: notice.id,
      stage: notice.stage as DunningStage,
      sentOn: iso(notice.sentOn),
      sentTo: notice.sentTo,
      overdueMinor: notice.overdueMinor.toString(),
      oldestDays: notice.oldestDays,
      itemCount: notice.itemCount,
    },
    letter,
    note:
      `Recorded that the ${letter.stage} letter went to ${sentTo} on ${iso(sentOn)}. This module did not send it — ` +
      `it has no way to. The next rung will be ${nextStage(stageForDays(letter.oldestPastDueDays) ?? "reminder", letter.stage)}, ` +
      `and not before ${iso(addDays(sentOn, cooloff))}.`,
  };
}

/** What has already been sent to one customer, newest first. */
export async function dunningHistory(opts: { orgId: string; entityId: string; partyKey: string }) {
  const party = await resolveParty(opts);
  const rows = await prisma.dunningNotice.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, partyKey: partyKeyOf(party) },
    orderBy: [{ sentOn: "desc" }, { createdAt: "desc" }],
  });
  return {
    code: party.code,
    name: party.name,
    notices: rows.map((n) => ({
      id: n.id,
      stage: n.stage as DunningStage,
      sentOn: iso(n.sentOn),
      sentTo: n.sentTo,
      overdueMinor: n.overdueMinor.toString(),
      oldestDays: n.oldestDays,
      itemCount: n.itemCount,
      recordedBy: n.recordedBy,
      letter: n.letter,
    })),
  };
}

/* -------------------------------------------------- statement of account */

export interface StatementMovement {
  date: string;
  number: string;
  reference: string;
  documentId: string;
  description: string;
  /** What it did to the account. Positive is a charge, negative a payment. */
  debitMinor: string;
  creditMinor: string;
  balanceMinor: string;
  kind: "invoiced" | "credited" | "received";
}

export interface AgeingBands {
  notYetDue: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  over90: string;
}

/**
 * Every open item for one customer as at a date, banded, footed, and tied to
 * the ageing the trial balance backs.
 *
 * **The bands are days past due, not days since the invoice.** ar.ts bands the
 * receivables ageing by document age, which is the right cut for a balance
 * sheet note; a statement is a collections document, and a 45-day-old invoice
 * on 60-day terms is not late. Putting it in a "31-60 days" column beside money
 * that genuinely is late invites the customer to argue about the wrong figure.
 * The two reports therefore answer different questions and their columns are
 * not meant to reconcile — which is said here rather than left to be discovered.
 *
 * **It foots.** opening + invoiced − received − credited = closing, checked and
 * returned as `foots`. The classification is exhaustive by construction:
 * charges raised by an invoice document are `invoiced`, credits raised by one
 * are `credited`, and every other movement on the account — receipts, refunds,
 * write-backs — is `received`, net. A refund therefore shows as a negative
 * receipt, which is the honest reading: it is money that went back out.
 *
 * **And it ties.** The total is checked against this customer's share of
 * `receivablesAgeing`, the report the trial balance backs, and the answer is
 * returned as `agrees`. That check runs against the real ageing function rather
 * than a second sum of our own, because the failure it exists to catch is
 * precisely the two drifting apart.
 */
export async function statementOfAccount(opts: {
  orgId: string;
  entityId: string;
  partyKey: string;
  from?: Date | string;
  asOf?: Date | string;
}) {
  const party = await resolveParty(opts);
  const asOf = asDate(opts.asOf ?? new Date(), "The as-at date");
  const from = opts.from === undefined ? null : asDate(opts.from, "The date a statement runs from");
  if (from && from.getTime() > asOf.getTime()) {
    throw new LedgerError(`A statement cannot run from ${iso(from)} back to ${iso(asOf)}.`);
  }

  const currency = await functionalCurrency(opts.orgId, opts.entityId);
  const ledger = await salesLedger({ orgId: opts.orgId, entityId: opts.entityId, to: asOf, parties: [party] });
  const mine = (key: string) => ledger.docs.get(key)?.partyId === party.id;

  let opening = 0n;
  let invoiced = 0n;
  let credited = 0n;
  let received = 0n;
  let balance = 0n;
  const movements: StatementMovement[] = [];

  for (const m of ledger.movements) {
    if (!mine(m.key)) continue;
    // Anything before the window folds into the opening balance rather than
    // being dropped, so the statement still adds up on its own paper.
    if (from && m.date.getTime() < from.getTime()) {
      opening += m.amountMinor;
      balance = opening;
      continue;
    }
    balance += m.amountMinor;
    const kind: StatementMovement["kind"] =
      m.source === "invoice" ? (m.amountMinor >= 0n ? "invoiced" : "credited") : "received";
    if (kind === "invoiced") invoiced += m.amountMinor;
    else if (kind === "credited") credited += -m.amountMinor;
    else received += -m.amountMinor;

    const doc = ledger.docs.get(m.key);
    movements.push({
      date: iso(m.date),
      number: doc?.number || m.reference,
      reference: m.reference,
      documentId: m.key,
      description: m.description,
      debitMinor: (m.amountMinor > 0n ? m.amountMinor : 0n).toString(),
      creditMinor: (m.amountMinor < 0n ? -m.amountMinor : 0n).toString(),
      balanceMinor: balance.toString(),
      kind,
    });
  }
  const closing = balance;
  const foots = opening + invoiced - received - credited === closing;

  const all = openItemsOf(ledger, party, asOf);
  const items = all.filter((i) => BigInt(i.outstandingMinor) > 0n);
  const unallocated = all.filter((i) => BigInt(i.outstandingMinor) < 0n);

  const bands = { notYetDue: 0n, d1_30: 0n, d31_60: 0n, d61_90: 0n, over90: 0n };
  for (const i of items) {
    const v = BigInt(i.outstandingMinor);
    const d = i.daysOverdue;
    if (d === 0) bands.notYetDue += v;
    else if (d <= 30) bands.d1_30 += v;
    else if (d <= 60) bands.d31_60 += v;
    else if (d <= 90) bands.d61_90 += v;
    else bands.over90 += v;
  }
  const bandsTotal = Object.values(bands).reduce((a, b) => a + b, 0n);
  const unallocatedMinor = unallocated.reduce((a, i) => a + BigInt(i.outstandingMinor), 0n);
  const total = bandsTotal + unallocatedMinor;

  // The tie. `receivablesAgeing` is the report the trial balance backs, so this
  // customer's share of it is the number a statement has to reach.
  const ageing = await receivablesAgeing({ orgId: opts.orgId, entityId: opts.entityId, asOf });
  const share = ageing.open
    .filter((o) => mine(o.sourceId))
    .reduce((a, o) => a + BigInt(o.outstandingMinor), 0n);
  const agrees = share === closing && total === closing;

  return {
    code: party.code,
    name: party.name,
    currency,
    paymentTerms: party.paymentTerms,
    from: from ? iso(from) : null,
    asOf: iso(asOf),
    openingMinor: opening.toString(),
    invoicedMinor: invoiced.toString(),
    receivedMinor: received.toString(),
    creditedMinor: credited.toString(),
    closingMinor: closing.toString(),
    foots,
    movements,
    items,
    unallocated,
    unallocatedMinor: unallocatedMinor.toString(),
    bands: {
      notYetDue: bands.notYetDue.toString(),
      d1_30: bands.d1_30.toString(),
      d31_60: bands.d31_60.toString(),
      d61_90: bands.d61_90.toString(),
      over90: bands.over90.toString(),
    } as AgeingBands,
    bandsTotalMinor: bandsTotal.toString(),
    totalMinor: total.toString(),
    ageingShareMinor: share.toString(),
    agrees,
    note: !foots
      ? `This statement does not foot: ${money(opening, currency)} opening plus ${money(invoiced, currency)} ` +
        `invoiced less ${money(received, currency)} received and ${money(credited, currency)} credited comes to ` +
        `${money(opening + invoiced - received - credited, currency)}, not the ${money(closing, currency)} it ` +
        `closes at. Do not send it.`
      : agrees
        ? `Opening ${money(opening, currency)} plus ${money(invoiced, currency)} invoiced, less ` +
          `${money(received, currency)} received and ${money(credited, currency)} credited, closes at ` +
          `${money(closing, currency)} — which is exactly what ${party.name} contributes to the receivables ageing ` +
          `at ${iso(asOf)}, and so ties this statement to the ${AR_CONTROL} control account on the trial balance.`
        : `This statement closes at ${money(closing, currency)} but ${party.name} contributes ` +
          `${money(share, currency)} to the receivables ageing at ${iso(asOf)}, a difference of ` +
          `${money(closing - share, currency)}. Do not send it: one of the two is wrong, and a statement that ` +
          `disagrees with the control account is disputed the day it arrives.`,
  };
}

/* ----------------------------------------------------------------- the list */

/**
 * Every customer, where they stand, and what the ladder would send them — the
 * screen's one read.
 */
export async function creditControlRegister(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date | string;
  pastDueDays?: number | null;
  includeArchived?: boolean;
}) {
  const asOf = asDate(opts.asOf ?? new Date(), "The as-at date");
  const pastDueDays = opts.pastDueDays === undefined ? DEFAULT_PAST_DUE_DAYS : opts.pastDueDays;

  const parties = await prisma.counterparty.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      kind: { in: ["CUSTOMER", "BOTH"] },
      ...(opts.includeArchived ? {} : { status: "active" }),
    },
    orderBy: { code: "asc" },
  });
  const currency = await functionalCurrency(opts.orgId, opts.entityId);
  if (parties.length === 0) {
    return {
      asOf: iso(asOf), currency, pastDueDays,
      customers: [],
      summary: {
        count: 0, onHold: 0, overLimit: 0, unassessed: 0,
        exposureMinor: "0", committedMinor: "0", pastDueMinor: "0", limitMinor: "0",
      },
      note: NEVER_SENDS,
    };
  }

  const ctx = await context({ orgId: opts.orgId, entityId: opts.entityId, asOf, parties });
  const customers = parties.map((p) => {
    const standing = standingOf(ctx, p);
    const { decision, reasons } = decide(standing, 0n, pastDueDays);
    const oldest = standing.exposure.oldestPastDueDays;
    const byAge = oldest === null ? null : stageForDays(oldest);
    // The detail belongs on the customer's own panel; the list needs the shape.
    const { items: _items, orders: _orders, ...exposure } = standing.exposure;
    return {
      ...standing,
      exposure: { ...exposure, itemCount: standing.exposure.items.length, orderCount: standing.exposure.orders.length },
      decision,
      reasons,
      stageDue: byAge === null ? null : nextStage(byAge, standing.lastNotice?.stage ?? null),
    };
  });

  const sum = (pick: (c: (typeof customers)[number]) => string) =>
    customers.reduce((a, c) => a + BigInt(pick(c)), 0n).toString();

  return {
    asOf: iso(asOf),
    currency,
    pastDueDays,
    customers,
    summary: {
      count: customers.length,
      onHold: customers.filter((c) => c.onHold).length,
      overLimit: customers.filter((c) => c.overLimitMinor !== null).length,
      unassessed: customers.filter((c) => !c.limit.limitSet).length,
      exposureMinor: sum((c) => c.exposure.totalMinor),
      committedMinor: sum((c) => c.exposure.committedMinor),
      pastDueMinor: sum((c) => c.exposure.pastDueMinor),
      // What the business has agreed to be exposed to, where it has said. A
      // customer with no limit contributes nothing to this figure rather than
      // an assumed nought, so the total is "the limits that exist", not "the
      // limits we would like to think exist".
      limitMinor: customers
        .reduce((a, c) => a + (c.limit.limitMinor === null ? 0n : BigInt(c.limit.limitMinor)), 0n)
        .toString(),
    },
    note: NEVER_SENDS,
  };
}
