import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { receivablesAgeing } from "./ar";
import { fmtMinor } from "@/lib/ledger/format";
import type { Counterparty } from "@prisma/client";
import type { Invoice } from "@/lib/domain/types";

/**
 * Counterparties and credit control.
 *
 * Everything here is a *lens* on the ledger. Nothing in this file posts, and
 * nothing in it changes a balance — a statement of account, an ageing split by
 * customer and a credit check are three ways of reading the same receivables
 * control account, and if any of them could write to it they would stop being
 * evidence and start being opinion.
 *
 * Two ideas run through the whole module.
 *
 * **A nil credit limit is not a limit of zero.** `creditLimitMinor` is nullable
 * on purpose. Null means *nobody has set a limit* — the account has never been
 * assessed, so there is no headroom figure to report and nothing to check a
 * sale against. Zero means *no credit at all* — an assessment was made and the
 * answer was cash up front. Collapsing the two is the single easiest mistake
 * here and it fails in the worst direction: treat null as zero and every sale
 * to every unassessed customer is blocked; treat zero as null and the cash-only
 * customer is handed credit. So headroom is `null` where no limit is set, never
 * `Infinity` and never some large number standing in for one, and every
 * sentence this module produces says which of the two situations it is in.
 *
 * **Suggest; never act.** `dunningList` says who to chase and why, and stops
 * there. Putting an account on hold is a commercial decision — the customer may
 * have paid this morning, or be the group's largest account, or be mid-way
 * through a dispute the ledger knows nothing about. A system that placed the
 * hold itself would stop a sale nobody meant to stop. `placeOnHold` exists and
 * is the only way an account is held, it demands a reason, and it records it.
 *
 * Documents are matched to a party through the same open-item key the AR module
 * ages by — `settlesId ?? sourceId` — so a receipt lands on the invoice it
 * settles rather than floating as an item of its own. Whose document it is comes
 * from the document store, because a journal line does not record a
 * counterparty; that is the one fact taken from outside the ledger, exactly as
 * the FAF extract takes it.
 */

/** The receivables control account. Mirrors `AR_CONTROL` in ar.ts. */
const AR_CONTROL = "1100";

/**
 * How many ids go into one `in (…)`.
 *
 * PostgreSQL's wire protocol carries a hard limit of 65,535 bind parameters,
 * and past it a query does not slow down — it fails. Every sales document a
 * business has ever raised is one id here, so a shop billing eleven hundred
 * customers a month crosses that line inside five years and the statement
 * screen stops working altogether. The ledger export chunks at the same 5,000
 * and for the same reason.
 */
const ID_CHUNK = 5_000;

export const KINDS = ["CUSTOMER", "SUPPLIER", "BOTH"] as const;
export type CounterpartyKind = (typeof KINDS)[number];

/** A party that can be sold to. A supplier-only record cannot. */
const sells = (kind: string) => kind === "CUSTOMER" || kind === "BOTH";

const DAY = 86_400_000;
const asDate = (d: Date | string) => (typeof d === "string" ? new Date(d) : d);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY);
/** Dates in the ledger are UTC midnight, so day arithmetic is plain addition. */
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
/** Money in a sentence. Same shape as the approvals module uses. */
const aed = (v: bigint, currency = "AED") => `${currency} ${fmtMinor(v, currency, { zero: "zero" })}`;

/* ------------------------------------------------------------------ master */

export interface NewCounterparty {
  code: string;
  name: string;
  nameAr?: string;
  kind?: string;
  trn?: string | null;
  email?: string | null;
  phone?: string | null;
  /** Days from the invoice date. 0 means due on receipt. */
  paymentTerms?: number;
  /**
   * Omit it or pass null for "no limit has been set". Pass 0 only when the
   * decision really is that this customer gets no credit at all.
   */
  creditLimitMinor?: number | bigint | string | null;
  currency?: string;
  notes?: string;
  onHold?: boolean;
  holdReason?: string;
}

async function load(orgId: string, entityId: string, code: string): Promise<Counterparty> {
  const party = await prisma.counterparty.findFirst({ where: { orgId, entityId, code: code.trim() } });
  if (!party) throw new LedgerError(`There is no counterparty with the code ${code.trim()} in this entity.`);
  return party;
}

/**
 * A UAE TRN is fifteen digits, and it is what makes a tax invoice claimable by
 * the buyer. A wrong one is worse than a blank one: the customer discovers it
 * when their input tax is disallowed, months later.
 */
function checkedTrn(raw: string | null | undefined, who: string): string | null {
  const trn = (raw ?? "").toString().trim();
  if (!trn) return null;
  if (!/^\d{15}$/.test(trn)) {
    const wrong = /^\d+$/.test(trn) ? `this one has ${trn.length}` : "this one is not all digits";
    throw new LedgerError(
      `"${trn}" is not a UAE TRN — a TRN is fifteen digits, and ${wrong}. Every tax invoice raised to ${who} will ` +
        `carry it, and the buyer cannot recover input tax against a TRN that does not match their registration. ` +
        `Copy it from their trade licence, or leave it blank until you have it.`,
    );
  }
  return trn;
}

function checkedEmail(raw: string | null | undefined): string | null {
  const email = (raw ?? "").toString().trim();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new LedgerError(
      `"${email}" is not an email address that will deliver. Statements and reminders go to it, and a bounced ` +
        `reminder looks exactly like a customer who is ignoring you.`,
    );
  }
  return email;
}

function checkedTerms(raw: number | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!Number.isInteger(raw)) {
    throw new LedgerError(`Payment terms are a whole number of days, so ${raw} is not one.`);
  }
  if (raw < 0) {
    throw new LedgerError(
      `Payment terms of ${raw} days would make every invoice due before it was raised. Use 0 for "due on receipt".`,
    );
  }
  if (raw > 365) {
    throw new LedgerError(
      `Payment terms of ${raw} days are longer than a year. If credit really runs that long it is a financing ` +
        `arrangement rather than trade terms, and it belongs in a contract rather than on the customer record.`,
    );
  }
  return raw;
}

/**
 * Read a credit limit off an input, keeping null and zero apart.
 *
 * `undefined` and `null` both mean "no limit set". `0` means a limit of nothing,
 * which is a real and different answer.
 */
function checkedLimit(raw: number | bigint | string | null | undefined, who: string): bigint | null {
  if (raw === undefined || raw === null) return null;
  // An emptied input field is a cleared limit, not a limit of zero — the user
  // deleted the number rather than typing a nought.
  if (typeof raw === "string" && raw.trim() === "") return null;
  let v: bigint;
  if (typeof raw === "bigint") v = raw;
  else if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new LedgerError(
        `A credit limit is in whole minor units — fils, not dirhams — and ${raw} is not a whole number. ` +
          `A limit of 5,000 dirhams is 500000.`,
      );
    }
    v = BigInt(raw);
  } else {
    if (!/^-?\d+$/.test(raw.trim())) {
      throw new LedgerError(`"${raw}" is not a credit limit. Give it in whole minor units, so 500000 for 5,000 dirhams.`);
    }
    v = BigInt(raw.trim());
  }
  if (v < 0n) {
    throw new LedgerError(
      `A credit limit of ${v} is negative, which cannot mean anything for ${who}. Use 0 if they get no credit at ` +
        `all, or clear the limit entirely if none has been decided — those are different things and both are allowed.`,
    );
  }
  return v;
}

/** A hold that does not say why is a dead end for whoever has to release it. */
function checkedReason(raw: string | undefined | null, what: string): string {
  const reason = (raw ?? "").trim();
  if (reason.length < 4) {
    throw new LedgerError(
      `${what} needs a reason, and "${reason}" is not one. Whoever picks this account up next has to decide ` +
        `whether it still applies, and they cannot do that from a blank field.`,
    );
  }
  return reason;
}

function checkedKind(raw: string | undefined, fallback: CounterpartyKind): CounterpartyKind {
  if (raw === undefined) return fallback;
  if (!(KINDS as readonly string[]).includes(raw)) {
    throw new LedgerError(`A counterparty is one of ${KINDS.join(", ")}. "${raw}" is not.`);
  }
  return raw as CounterpartyKind;
}

/**
 * Two parties in one entity may not share a code, a TRN or a name.
 *
 * The code is what people quote. The TRN identifies one taxable person, so two
 * records carrying it are the same customer entered twice and their credit is
 * being assessed against half their debt each. The name is how a document with
 * no explicit customer link is attributed, so two identical names make every
 * such document ambiguous.
 */
async function assertUnique(
  orgId: string,
  entityId: string,
  fields: { code: string; name: string; trn: string | null },
  exceptId?: string,
) {
  const clashes = await prisma.counterparty.findMany({
    where: {
      orgId,
      entityId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
      OR: [
        { code: fields.code },
        { name: fields.name },
        ...(fields.trn ? [{ trn: fields.trn }] : []),
      ],
    },
  });
  for (const c of clashes) {
    if (c.code === fields.code) {
      throw new LedgerError(`The code ${fields.code} is already "${c.name}". Two counterparties cannot share one.`);
    }
    if (fields.trn && c.trn === fields.trn) {
      throw new LedgerError(
        `TRN ${fields.trn} is already on "${c.name}" (${c.code}). A TRN identifies one taxable person, so this ` +
          `would be the same customer entered twice — and each copy would be credit-checked against half the debt.`,
      );
    }
    if (c.name === fields.name) {
      throw new LedgerError(
        `"${fields.name}" is already the name of counterparty ${c.code}. Documents that carry no customer link are ` +
          `matched by name, so two identical names would make every one of them ambiguous. Add something that ` +
          `distinguishes them — a branch, an emirate, the legal suffix.`,
      );
    }
  }
}

export async function createCounterparty(opts: {
  orgId: string;
  entityId: string;
  counterparty: NewCounterparty;
  /** Who opened it, recorded on the hold where the account is opened on one. */
  actorId?: string;
}): Promise<Counterparty> {
  const c = opts.counterparty;
  const code = (c.code ?? "").trim();
  if (!code) throw new LedgerError("A counterparty needs a code.");
  if (!/^[A-Za-z0-9._-]+$/.test(code)) {
    throw new LedgerError(
      `"${code}" is not a usable counterparty code. Use letters, digits, dots, dashes or underscores — a code ` +
        `with spaces or punctuation in it breaks every statement and export that quotes it.`,
    );
  }
  const name = (c.name ?? "").trim();
  if (!name) throw new LedgerError("A counterparty needs a name — it is what appears on their statement.");

  const kind = checkedKind(c.kind, "CUSTOMER");
  const trn = checkedTrn(c.trn, name);
  const email = checkedEmail(c.email);
  const paymentTerms = checkedTerms(c.paymentTerms, 30);
  const creditLimitMinor = checkedLimit(c.creditLimitMinor, name);
  const currency = (c.currency ?? "AED").trim().toUpperCase() || "AED";
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new LedgerError(`"${currency}" is not a currency code. Use the three-letter ISO code, e.g. AED.`);
  }

  // Opening an account already on hold is legitimate — a customer can arrive
  // with a history — but it still has to say why.
  const onHold = c.onHold === true;
  const holdReason = onHold ? checkedReason(c.holdReason, "Opening an account on hold") : null;

  await assertUnique(opts.orgId, opts.entityId, { code, name, trn });

  const created = await prisma.counterparty.create({
    data: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      code,
      name,
      nameAr: c.nameAr?.trim() || null,
      kind,
      trn,
      email,
      phone: c.phone?.toString().trim() || null,
      paymentTerms,
      creditLimitMinor,
      onHold,
      holdReason,
      currency,
      notes: c.notes?.trim() || null,
    },
  });

  /*
   * There is one hold, and it lives in CreditHold — including a hold the
   * account is opened with.
   *
   * `placeOnHold` was made to write the row for exactly this reason: credit
   * control derives holds only from CreditHold and never reads the flag, so a
   * flag with no row behind it reads as `decision: "allow"` from creditCheck,
   * counts as nought in the on-hold summary, shows an empty hold history, and
   * passes the sales-order credit gate — while the customer chip on screen says
   * the account is stopped. Fixing the hold verb and leaving the create verb
   * alone left the same defect reachable through a different door, and the door
   * a customer who arrives with a history comes through.
   *
   * Deferred import for the same reason `placeOnHold` gives: credit-control.ts
   * imports this module, so a static import here would be a cycle.
   */
  if (onHold && holdReason) {
    const { placeCreditHold } = await import("./credit-control");
    await placeCreditHold({
      orgId: opts.orgId, entityId: opts.entityId, partyKey: code,
      reason: holdReason, actorId: opts.actorId,
    });
  }

  return created;
}

export interface CounterpartyChange {
  name?: string;
  nameAr?: string | null;
  kind?: string;
  trn?: string | null;
  email?: string | null;
  phone?: string | null;
  paymentTerms?: number;
  /**
   * Leave the key out to keep the current limit. Pass `null` to clear it back
   * to "no limit set". Pass `0` to say this customer gets no credit at all.
   * Those last two are different answers and this is where they part.
   */
  creditLimitMinor?: number | bigint | string | null;
  currency?: string;
  notes?: string | null;
}

/**
 * Change a counterparty.
 *
 * A hold is deliberately not changeable from here. It has to carry a reason and
 * leave a trail, and letting it ride along with a phone-number edit is how an
 * account ends up held with nobody able to say by whom or why — see
 * `placeOnHold` and `releaseHold`.
 */
export async function updateCounterparty(opts: {
  orgId: string;
  entityId: string;
  code: string;
  change: CounterpartyChange & { onHold?: boolean };
}): Promise<Counterparty> {
  const party = await load(opts.orgId, opts.entityId, opts.code);
  const c = opts.change;

  if (c.onHold !== undefined) {
    throw new LedgerError(
      `A hold is not an ordinary field edit. Use "place on hold" or "release hold" — both take a reason and both ` +
        `are recorded, so the next person to look at ${party.name} can see why sales were stopped and decide.`,
    );
  }

  const data: Record<string, unknown> = {};
  let name = party.name;
  let trn = party.trn;

  if (c.name !== undefined) {
    name = c.name.trim();
    if (!name) throw new LedgerError("A counterparty cannot have an empty name — it is what appears on their statement.");
    data.name = name;
  }
  if (c.nameAr !== undefined) data.nameAr = c.nameAr?.trim() || null;
  if (c.trn !== undefined) {
    trn = checkedTrn(c.trn, name);
    data.trn = trn;
  }
  if (c.email !== undefined) data.email = checkedEmail(c.email);
  if (c.phone !== undefined) data.phone = c.phone?.toString().trim() || null;
  if (c.notes !== undefined) data.notes = c.notes?.trim() || null;
  if (c.paymentTerms !== undefined) data.paymentTerms = checkedTerms(c.paymentTerms, party.paymentTerms);

  // The distinction the whole module turns on, made once, here.
  if (c.creditLimitMinor !== undefined) {
    data.creditLimitMinor = checkedLimit(c.creditLimitMinor, name);
  }

  if (c.currency !== undefined) {
    const currency = c.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new LedgerError(`"${c.currency}" is not a currency code. Use the three-letter ISO code, e.g. AED.`);
    }
    data.currency = currency;
  }

  if (c.kind !== undefined) {
    const kind = checkedKind(c.kind, party.kind as CounterpartyKind);
    // Narrowing a customer out of existence would take their open invoices off
    // every receivables screen while the debt is still owed.
    if (sells(party.kind) && !sells(kind)) {
      const open = await outstandingOf({ orgId: opts.orgId, entityId: opts.entityId, party });
      if (open !== 0n) {
        throw new LedgerError(
          `${party.name} still carries ${aed(open, party.currency)} on the sales ledger, so it cannot become a ` +
            `${kind.toLowerCase()}-only record. The debt would disappear from every customer report while it is ` +
            `still owed. Settle or write it off first, or use BOTH if they are now a supplier as well.`,
        );
      }
    }
    data.kind = kind;
  }

  if (Object.keys(data).length === 0) throw new LedgerError("There is nothing to change.");
  if (c.name !== undefined || c.trn !== undefined) {
    await assertUnique(opts.orgId, opts.entityId, { code: party.code, name, trn }, party.id);
  }
  return prisma.counterparty.update({ where: { id: party.id }, data });
}

/**
 * Archive a counterparty: it stops appearing on working screens and keeps every
 * document that names it.
 *
 * Refused while anything is outstanding, for the same reason an account with a
 * balance cannot be archived — filing away a customer who still owes money
 * hides a debt the business is still owed.
 */
export async function archiveCounterparty(opts: {
  orgId: string;
  entityId: string;
  code: string;
}): Promise<Counterparty> {
  const party = await load(opts.orgId, opts.entityId, opts.code);
  if (party.status === "archived") throw new LedgerError(`${party.code} ${party.name} is already archived.`);

  const open = await outstandingOf({ orgId: opts.orgId, entityId: opts.entityId, party });
  if (open > 0n) {
    throw new LedgerError(
      `${party.name} still owes ${aed(open, party.currency)}. Archiving them now would take that debt off every ` +
        `customer screen while it is still collectable. Collect it, or write it off, and then archive.`,
    );
  }
  if (open < 0n) {
    throw new LedgerError(
      `${party.name} is carrying ${aed(-open, party.currency)} in their favour — a credit note or a payment on ` +
        `account that has not been applied. Apply or refund it before archiving, or the money quietly disappears.`,
    );
  }

  return prisma.counterparty.update({ where: { id: party.id }, data: { status: "archived" } });
}

export async function restoreCounterparty(opts: {
  orgId: string;
  entityId: string;
  code: string;
}): Promise<Counterparty> {
  const party = await load(opts.orgId, opts.entityId, opts.code);
  if (party.status === "active") throw new LedgerError(`${party.code} ${party.name} is already active.`);
  return prisma.counterparty.update({ where: { id: party.id }, data: { status: "active" } });
}

/* ------------------------------------------------- reading the sales ledger */

interface ActivityLine {
  /** The open-item key: the invoice, whether this line raised it or settles it. */
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
  /** The document's own number where the store knows it, else the journal's. */
  number: string;
  description: string;
  /** The date the item opened — the invoice date, never the receipt's. */
  date: Date;
  /** The document's own due date, where it carried terms of its own. */
  due: Date | null;
  reference: string;
  outstanding: bigint;
  opened: boolean;
}

interface Activity {
  lines: ActivityLine[];
  docs: Map<string, DocFacts>;
  /**
   * The same documents, bucketed by the party they belong to.
   *
   * `openItemsOf` used to walk the whole map once per counterparty, which on a
   * thousand customers and a hundred thousand documents is a hundred million
   * comparisons on the event loop — and the event loop is single-threaded, so
   * every other request on the process waits behind the customers screen while
   * it runs. Bucketing once turns the same answer into one pass.
   */
  byParty: Map<string, DocFacts[]>;
  /** The earliest entry date read, or null where the whole ledger was read. */
  since: Date | null;
}

/** An activity with nothing in it — the answer when there is nobody to ask about. */
const noActivity = (): Activity => ({
  lines: [],
  docs: new Map<string, DocFacts>(),
  byParty: new Map<string, DocFacts[]>(),
  since: null,
});

export interface PartyIndex {
  byId: Map<string, string>;
  byCode: Map<string, string>;
  byTrn: Map<string, string>;
  byName: Map<string, string>;
}

export function partyIndex(parties: Counterparty[]): PartyIndex {
  const idx: PartyIndex = { byId: new Map(), byCode: new Map(), byTrn: new Map(), byName: new Map() };
  for (const p of parties) {
    idx.byId.set(p.id, p.id);
    idx.byCode.set(p.code.trim().toLowerCase(), p.id);
    if (p.trn) idx.byTrn.set(p.trn.trim(), p.id);
    idx.byName.set(p.name.trim().toLowerCase(), p.id);
  }
  return idx;
}

/**
 * Whose document is this?
 *
 * An explicit link on the document is decisive — if it names a party, that is
 * the party, even where the name typed onto the face of it was later edited.
 * Only when there is no link do we fall back to the TRN (which identifies one
 * taxable person) and finally to the name, which is why two counterparties are
 * not allowed to share one.
 *
 * The same ladder answers for a supplier, reading the seller instead of the
 * buyer. It is one function rather than two because a product with two
 * attribution rules has two answers to "whose is this", and the weaker one
 * ends up governing who gets paid — which is the more expensive half to get
 * wrong.
 */
export function attributeDocument(
  inv: Invoice,
  idx: PartyIndex,
  side: "buyer" | "seller" = "buyer",
): string | null {
  const link = (inv.customerId ?? "").trim();
  if (link) return idx.byId.get(link) ?? idx.byCode.get(link.toLowerCase()) ?? null;

  const party = side === "buyer" ? inv.buyer : inv.seller;
  const trn = (party?.trn ?? "").trim();
  if (trn) {
    const byTrn = idx.byTrn.get(trn);
    if (byTrn) return byTrn;
  }
  const name = (party?.nameEn ?? "").trim().toLowerCase();
  return (name && idx.byName.get(name)) || null;
}

const partyIdOf = (inv: Invoice, idx: PartyIndex) => attributeDocument(inv, idx, "buyer");

/**
 * Whose documents are these?
 *
 * A journal line records what an entry did to the books; it does not record
 * that invoice `x` was to Al Marri Trading. The document store does, so that is
 * where it is read from — the one fact taken from outside the ledger, and the
 * same source the FAF extract uses for the same reason.
 *
 * The ids go over in chunks. Every sales document ever raised can appear in
 * this list, and `id: { in: [...] }` is one bind parameter each, so the query
 * that used to be written in one go stopped working — not slowly, but at all —
 * on the businesses with the longest history.
 */
async function attributedDocuments(
  orgId: string,
  ids: string[],
  idx: PartyIndex,
): Promise<Map<string, { partyId: string | null; number: string }>> {
  const out = new Map<string, { partyId: string | null; number: string }>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const stored = await prisma.record.findMany({
      where: { orgId, store: "invoices", id: { in: ids.slice(i, i + ID_CHUNK) } },
    });
    for (const row of stored) {
      let inv: Invoice | undefined;
      try { inv = JSON.parse(row.data) as Invoice; } catch { inv = undefined; }
      if (!inv || inv.direction !== "OUTBOUND") continue;
      out.set(row.id, { partyId: partyIdOf(inv, idx), number: (inv.number ?? "").trim() });
    }
  }
  return out;
}

/**
 * Every movement on the receivables control account up to a date, netted into
 * open items exactly as `receivablesAgeing` nets them, and attributed to a
 * counterparty.
 *
 * The keying is deliberately the same expression ar.ts uses — `settlesId ??
 * sourceId` — rather than a second one that happens to agree today. A statement
 * that keyed differently would drift from the ageing the first time either
 * changed, and the whole point of a statement of account is that the customer's
 * copy and ours are the same number.
 *
 * **`since` bounds the read without changing the netting.** The control account
 * grows for the life of the business and reading all of it to explain what is
 * owed this month is work nobody asked for. What makes a lower bound safe is
 * the second read below: every document the window touched has its earlier
 * halves fetched by key, so a receipt inside the window still meets the invoice
 * outside it and nets against it exactly. A document that had no movement in
 * the window at all is the only thing left out, and the caller is told the date
 * so it can account for those itself — `counterpartyStatement` carries them in
 * the opening balance, which is what an opening balance is for.
 */
async function receivableActivity(opts: {
  orgId: string;
  entityId: string;
  to: Date;
  parties: Counterparty[];
  /** Read nothing dated before this. Null or omitted reads the whole ledger. */
  since?: Date | null;
}): Promise<Activity> {
  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: AR_CONTROL },
  });
  if (!account) {
    throw new LedgerError(
      `The receivables control account ${AR_CONTROL} does not exist for this entity, so there is nothing for a ` +
        `statement or a credit check to read. Open the books for the entity first.`,
    );
  }

  const since = opts.since ?? null;
  const include = {
    entry: {
      select: {
        entryDate: true, dueDate: true, sourceId: true, settlesId: true, sourceType: true,
        memo: true, source: true, series: true, number: true,
      },
    },
  } as const;
  const entryWhere = {
    orgId: opts.orgId,
    status: { in: ["posted", "reversed"] },
    entryDate: since ? { gte: since, lte: opts.to } : { lte: opts.to },
  };

  const inWindow = await prisma.journalLine.findMany({
    where: { accountId: account.id, entry: entryWhere },
    include,
    orderBy: { entry: { entryDate: "asc" } },
  });

  // The open-item key, exactly as ar.ts computes it. Line-level settlement
  // first: one batch entry can discharge several documents, and the entry-level
  // column names only one of them.
  type Row = (typeof inWindow)[number];
  const keyOf = (l: Row) => l.settlesId ?? l.entry.settlesId ?? l.entry.sourceId ?? l.id;

  /*
   * The other halves of the documents the window touched.
   *
   * Without this a receipt dated inside the window would open an item of its
   * own — a credit balance on a customer who owes money — because the invoice
   * it settles was raised before the window and never read. Fetching by key
   * costs one query per five thousand documents and makes the bound honest
   * rather than approximate.
   */
  const carried: Row[] = [];
  if (since) {
    const keys = [...new Set(inWindow.map(keyOf))];
    const touched = new Set(keys);
    for (let i = 0; i < keys.length; i += ID_CHUNK) {
      const batch = keys.slice(i, i + ID_CHUNK);
      const earlier = await prisma.journalLine.findMany({
        where: {
          accountId: account.id,
          entry: { orgId: opts.orgId, status: { in: ["posted", "reversed"] }, entryDate: { lt: since } },
          OR: [
            { settlesId: { in: batch } },
            { entry: { settlesId: { in: batch } } },
            { entry: { sourceId: { in: batch } } },
          ],
        },
        include,
      });
      // An entry can name one document in `sourceId` while a line of it settles
      // another, so a row fetched by the entry's id may key to somewhere else
      // entirely. Keeping only the keys the window actually holds stops a
      // fragment of an untouched document appearing as an item of its own.
      carried.push(...earlier.filter((l) => touched.has(keyOf(l))));
    }
  }

  const rows = carried.length ? [...inWindow, ...carried] : inWindow;

  // A statement is read down the page, so its order has to be total: two
  // documents on the same day must always come out in the same sequence, or the
  // customer's copy and this month's copy disagree over nothing.
  const seq = (n: string) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
  const sorted = [...rows].sort(
    (a, b) =>
      a.entry.entryDate.getTime() - b.entry.entryDate.getTime() ||
      a.entry.series.localeCompare(b.entry.series) ||
      seq(a.entry.number) - seq(b.entry.number) ||
      a.lineNo - b.lineNo,
  );

  const lines: ActivityLine[] = [];
  const docs = new Map<string, DocFacts>();
  for (const l of sorted) {
    const key = keyOf(l);
    const reference = `${l.entry.series}-${l.entry.number}`;
    const opensItem = l.entry.source === "invoice";
    lines.push({
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
      // The item's identity and age come from the invoice that opened it, never
      // from the receipt that closed part of it.
      if (opensItem && !prev.opened) {
        prev.description = l.entry.memo ?? prev.description;
        prev.date = l.entry.entryDate;
        prev.due = l.entry.dueDate;
        prev.reference = reference;
        prev.opened = true;
      }
    } else {
      docs.set(key, {
        key,
        partyId: null,
        number: "",
        description: l.entry.memo ?? "",
        date: l.entry.entryDate,
        due: l.entry.dueDate,
        reference,
        outstanding: l.functionalAmountMinor,
        opened: opensItem,
      });
    }
  }

  const attributed = await attributedDocuments(opts.orgId, [...docs.keys()], partyIndex(opts.parties));
  const byParty = new Map<string, DocFacts[]>();
  for (const doc of docs.values()) {
    const known = attributed.get(doc.key);
    if (known) {
      doc.partyId = known.partyId;
      if (known.number) doc.number = known.number;
    }
    if (!doc.partyId) continue;
    const bucket = byParty.get(doc.partyId);
    if (bucket) bucket.push(doc);
    else byParty.set(doc.partyId, [doc]);
  }

  return { lines, docs, byParty, since };
}

export interface OpenItem {
  documentId: string;
  /** The document number, falling back to the journal reference. */
  number: string;
  reference: string;
  description: string;
  date: string;
  /** The document's own due date, or the invoice date plus this party's terms. */
  dueDate: string;
  outstandingMinor: string;
  daysOld: number;
  /** 0 when it is not yet due. Never negative — "minus four days late" is noise. */
  daysOverdue: number;
}

function openItemsOf(activity: Activity, party: Counterparty, asOf: Date): OpenItem[] {
  const out: OpenItem[] = [];
  // This party's documents only. Reading them out of the bucket rather than
  // filtering the whole map is what keeps a screen of a thousand customers from
  // being a thousand passes over every document the business has ever raised.
  for (const doc of activity.byParty.get(party.id) ?? []) {
    if (doc.outstanding === 0n) continue;
    // The document's own terms beat the party's default: an invoice raised on
    // sixty days does not become late on the thirty-first because the customer
    // record says thirty.
    const due = doc.due ?? addDays(doc.date, party.paymentTerms);
    // A credit sitting in the customer's favour is not "overdue" — nobody is
    // late paying it, and colouring it red sends the collections team after
    // money the business owes.
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

/** What this party owes in total on the sales ledger, as at a date. */
async function outstandingOf(opts: {
  orgId: string;
  entityId: string;
  party: Counterparty;
  asOf?: Date;
}): Promise<bigint> {
  const asOf = opts.asOf ?? new Date();
  const activity = await receivableActivity({
    orgId: opts.orgId, entityId: opts.entityId, to: asOf, parties: [opts.party],
  });
  let total = 0n;
  for (const doc of activity.byParty.get(opts.party.id) ?? []) total += doc.outstanding;
  return total;
}

/* ---------------------------------------------------- statement of account */

export interface StatementLine {
  date: string;
  /** The document number the customer knows it by, e.g. INV-0042. */
  number: string;
  /** The journal reference behind it, for anyone reconciling from this side. */
  reference: string;
  documentId: string;
  description: string;
  debitMinor: string;
  creditMinor: string;
  /** Running balance after this line — what the customer owed at that moment. */
  balanceMinor: string;
}

/**
 * A statement of account: what was owed at the start, everything that happened,
 * and what is owed at the end.
 *
 * The closing balance is checked against this party's share of
 * `receivablesAgeing` and the answer is returned as `agrees`. That check is run
 * against the real ageing function rather than against a second sum of our own,
 * because the failure it is there to catch is precisely the two of them drifting
 * apart — a statement the customer can reconcile against a control account
 * nobody else can is not a statement, it is a claim.
 *
 * **Where the ledger is read from.** A statement asked for a period does not
 * need to read the years before it line by line: everything earlier belongs in
 * the opening balance, and an opening balance is one figure. So the ledger read
 * starts at `from`, and the two things that would otherwise be lost are put
 * back exactly — the earlier halves of documents this period touched come from
 * the keyed read inside `receivableActivity`, and documents that had no
 * movement in the period at all are carried in at their balance from the same
 * ageing the statement ties to. Asked for a statement with no start date, it
 * reads everything, because then every line is meant to be on the page.
 * `readFrom` says which of the two happened.
 */
export async function counterpartyStatement(opts: {
  orgId: string;
  entityId: string;
  code: string;
  from?: Date | string;
  to?: Date | string;
}) {
  const party = await load(opts.orgId, opts.entityId, opts.code);
  const to = asDate(opts.to ?? new Date());
  const from = opts.from === undefined ? null : asDate(opts.from);
  if (from && from.getTime() > to.getTime()) {
    throw new LedgerError(`A statement cannot run from ${iso(from)} back to ${iso(to)}.`);
  }

  // The tie, read first because it is also where the brought-forward balances
  // come from. `receivablesAgeing` is the report the trial balance backs, so
  // the party's share of it is the number this statement has to reach.
  const ageing = await receivablesAgeing({ orgId: opts.orgId, entityId: opts.entityId, asOf: to });

  const activity = await receivableActivity({
    orgId: opts.orgId, entityId: opts.entityId, to, parties: [party], since: from,
  });

  /*
   * The open items the period never touched.
   *
   * A document with no movement between `from` and `to` holds the same balance
   * at both ends, so the ageing's figure for it at `to` is also its figure at
   * `from` — which is precisely what the opening balance is made of. They are
   * attributed from the document store the same way every other document here
   * is, because the ageing knows what is open and not whose it is.
   */
  const untouched = ageing.open.filter((o) => !activity.docs.has(o.sourceId));
  const carriedIn = activity.since && untouched.length
    ? await attributedDocuments(opts.orgId, untouched.map((o) => o.sourceId), partyIndex([party]))
    : new Map<string, { partyId: string | null; number: string }>();

  const mine = (key: string) =>
    (activity.docs.get(key)?.partyId ?? carriedIn.get(key)?.partyId) === party.id;

  let opening = untouched
    .filter((o) => carriedIn.get(o.sourceId)?.partyId === party.id)
    .reduce((a, o) => a + BigInt(o.outstandingMinor), 0n);
  let balance = opening;
  const lines: StatementLine[] = [];
  for (const l of activity.lines) {
    if (!mine(l.key)) continue;
    // Anything before the window is folded into the opening balance rather than
    // dropped, so the statement still adds up on its own.
    if (from && l.date.getTime() < from.getTime()) {
      opening += l.amountMinor;
      balance = opening;
      continue;
    }
    balance += l.amountMinor;
    const doc = activity.docs.get(l.key);
    lines.push({
      date: iso(l.date),
      number: doc?.number || l.reference,
      reference: l.reference,
      documentId: l.key,
      description: l.description,
      debitMinor: (l.amountMinor > 0n ? l.amountMinor : 0n).toString(),
      creditMinor: (l.amountMinor < 0n ? -l.amountMinor : 0n).toString(),
      balanceMinor: balance.toString(),
    });
  }
  const closing = balance;

  const share = ageing.open
    .filter((o) => mine(o.sourceId))
    .reduce((a, o) => a + BigInt(o.outstandingMinor), 0n);
  const agrees = share === closing;

  return {
    code: party.code,
    name: party.name,
    currency: party.currency,
    paymentTerms: party.paymentTerms,
    from: from ? iso(from) : null,
    to: iso(to),
    /** Where the ledger read started. Null means it read the whole account. */
    readFrom: activity.since ? iso(activity.since) : null,
    openingMinor: opening.toString(),
    lines,
    closingMinor: closing.toString(),
    ageingShareMinor: share.toString(),
    agrees,
    note:
      (agrees
        ? `The closing balance of ${aed(closing, party.currency)} is exactly what ${party.name} contributes to the ` +
          `receivables ageing at ${iso(to)}, which ties this statement to the ${AR_CONTROL} control account on the ` +
          `trial balance.`
        : `This statement closes at ${aed(closing, party.currency)} but ${party.name} contributes ` +
          `${aed(share, party.currency)} to the receivables ageing at ${iso(to)}, a difference of ` +
          `${aed(closing - share, party.currency)}. Do not send it: one of the two is wrong, and a statement that ` +
          `disagrees with the control account will be disputed the day it arrives.`) +
      (activity.since
        ? ` The ledger was read from ${iso(activity.since)}. Anything still owing on a document that has had no ` +
          `movement since then is in the opening balance of ${aed(opening, party.currency)} rather than itemised ` +
          `below, which is what an opening balance is for.`
        : ""),
  };
}

/* --------------------------------------------------------- credit standing */

export interface CreditStatus {
  code: string;
  name: string;
  currency: string;
  asOf: string;
  paymentTerms: number;
  status: string;
  outstandingMinor: string;
  overdueMinor: string;
  /** Null when nothing is overdue. */
  oldestOverdueDays: number | null;
  /** Null means no limit has been set — it does not mean nil. */
  creditLimitMinor: string | null;
  limitSet: boolean;
  /** Null wherever `limitSet` is false. Never Infinity, never a stand-in. */
  headroomMinor: string | null;
  overLimit: boolean;
  overdue: boolean;
  onHold: boolean;
  holdReason: string | null;
  items: OpenItem[];
  summary: string;
}

function creditStatusFrom(party: Counterparty, items: OpenItem[], asOf: Date): CreditStatus {
  const outstanding = items.reduce((a, i) => a + BigInt(i.outstandingMinor), 0n);
  const overdueItems = items.filter((i) => i.daysOverdue > 0);
  const overdueMinor = overdueItems.reduce((a, i) => a + BigInt(i.outstandingMinor), 0n);
  const oldest = overdueItems.reduce((a, i) => Math.max(a, i.daysOverdue), 0);

  const limit = party.creditLimitMinor;
  const limitSet = limit !== null;
  // Headroom is a number only where a limit exists. There is no honest number
  // for "how much more may they take" when nobody has said how much they may
  // take at all, and Infinity or 999,999,999 both read as an answer.
  const headroom = limitSet ? limit - outstanding : null;
  const overLimit = limitSet && outstanding > limit;

  const cur = party.currency;
  const parts: string[] = [];
  if (!limitSet) {
    parts.push(
      `No credit limit has been set for ${party.name}, so there is no headroom to report. That is not a limit of ` +
        `nothing — it means nobody has assessed this account yet. They owe ${aed(outstanding, cur)} today. Set a ` +
        `limit if you want sales to them checked.`,
    );
  } else if (limit === 0n) {
    parts.push(
      `${party.name} has a credit limit of ${aed(0n, cur)} — no credit at all, so every sale needs payment up ` +
        `front. They owe ${aed(outstanding, cur)}.`,
    );
  } else if (overLimit) {
    parts.push(
      `${party.name} owes ${aed(outstanding, cur)} against a credit limit of ${aed(limit, cur)}, which is ` +
        `${aed(outstanding - limit, cur)} over.`,
    );
  } else {
    parts.push(
      `${party.name} owes ${aed(outstanding, cur)} against a credit limit of ${aed(limit, cur)}, leaving ` +
        `${aed(headroom as bigint, cur)} of headroom.`,
    );
  }
  if (overdueItems.length > 0) {
    parts.push(
      `${aed(overdueMinor, cur)} of that is overdue, the oldest by ${oldest} day${oldest === 1 ? "" : "s"} against ` +
        `${party.paymentTerms === 0 ? "payment on receipt" : `${party.paymentTerms}-day terms`}.`,
    );
  } else if (outstanding > 0n) {
    parts.push(
      `Nothing is overdue on ${party.paymentTerms === 0 ? "payment-on-receipt" : `${party.paymentTerms}-day`} terms.`,
    );
  }
  if (party.onHold) parts.push(`The account is on hold: ${party.holdReason}.`);

  return {
    code: party.code,
    name: party.name,
    currency: cur,
    asOf: iso(asOf),
    paymentTerms: party.paymentTerms,
    status: party.status,
    outstandingMinor: outstanding.toString(),
    overdueMinor: overdueMinor.toString(),
    oldestOverdueDays: overdueItems.length > 0 ? oldest : null,
    creditLimitMinor: limitSet ? limit.toString() : null,
    limitSet,
    headroomMinor: headroom === null ? null : headroom.toString(),
    overLimit,
    overdue: overdueItems.length > 0,
    onHold: party.onHold,
    holdReason: party.holdReason,
    items,
    summary: parts.join(" "),
  };
}

/**
 * Where a customer stands: what they owe, how much of it is late and by how
 * long on *their* terms, their limit, and the two flags a caller actually
 * branches on — `overLimit` and `overdue`.
 *
 * The flags exist so nobody has to re-derive them from the numbers. A caller
 * comparing `outstandingMinor` to `creditLimitMinor` itself has to remember
 * that the limit may be null, and the day someone forgets is the day every
 * unassessed customer is refused.
 */
export async function creditStatus(opts: {
  orgId: string;
  entityId: string;
  code: string;
  asOf?: Date | string;
}): Promise<CreditStatus> {
  const party = await load(opts.orgId, opts.entityId, opts.code);
  const asOf = asDate(opts.asOf ?? new Date());
  const activity = await receivableActivity({
    orgId: opts.orgId, entityId: opts.entityId, to: asOf, parties: [party],
  });
  return creditStatusFrom(party, openItemsOf(activity, party, asOf), asOf);
}

/* ------------------------------------------------------------- collections */

export const DUNNING_ACTIONS = ["remind", "demand", "hold", "refer"] as const;
export type DunningAction = (typeof DUNNING_ACTIONS)[number];

/**
 * How late something has to be before each step is worth suggesting.
 *
 * These are starting points, not law. They are here as one table rather than
 * scattered through the code so that a business with different collection
 * practice can see the whole policy at once and argue with it.
 */
const BANDS: { upTo: number; action: DunningAction; step: string }[] = [
  { upTo: 14, action: "remind", step: "a reminder with the statement attached" },
  { upTo: 45, action: "demand", step: "a firm demand naming a payment date" },
  { upTo: 90, action: "hold", step: "putting the account on hold until it is cleared" },
  { upTo: Infinity, action: "refer", step: "referring it for recovery, and considering a provision" },
];

const bandFor = (days: number) => BANDS.find((b) => days <= b.upTo) ?? BANDS[BANDS.length - 1];

export interface DunningRow {
  code: string;
  name: string;
  email: string | null;
  phone: string | null;
  currency: string;
  outstandingMinor: string;
  overdueMinor: string;
  oldestOverdueDays: number;
  paymentTerms: number;
  creditLimitMinor: string | null;
  limitSet: boolean;
  overLimit: boolean;
  onHold: boolean;
  suggested: DunningAction;
  /** Why this step, in a sentence, with the numbers that drove it. */
  reason: string;
  items: OpenItem[];
}

/**
 * Who to chase, worst first, with a suggested next step and the reason for it.
 *
 * Nothing here changes anything. Not one account is held, no letter is sent, no
 * flag is set. That restraint is the design, not an omission: the customer may
 * have paid this morning, the debt may be a disputed line on one invoice, the
 * account may be the group's largest. A system that placed the hold itself
 * would stop a sale that nobody meant to stop, and the person who finds out is
 * the salesperson standing in front of the customer.
 */
export async function dunningList(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date | string;
  /** Ignore anything less late than this. Defaults to 1 — anything overdue. */
  minAgeDays?: number;
}) {
  const asOf = asDate(opts.asOf ?? new Date());
  const minAgeDays = opts.minAgeDays ?? 1;
  if (!Number.isInteger(minAgeDays) || minAgeDays < 0) {
    throw new LedgerError(`A minimum age is a whole number of days, so ${opts.minAgeDays} is not one.`);
  }

  const parties = await prisma.counterparty.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: "active", kind: { in: ["CUSTOMER", "BOTH"] } },
    orderBy: { code: "asc" },
  });
  if (parties.length === 0) {
    return { asOf: iso(asOf), minAgeDays, rows: [], totalOverdueMinor: "0", note: NEVER_ACTS };
  }

  // One pass over the ledger for every customer, rather than one query each —
  // a collections screen that takes a minute to load is a collections screen
  // nobody opens.
  const activity = await receivableActivity({
    orgId: opts.orgId, entityId: opts.entityId, to: asOf, parties,
  });

  const rows: DunningRow[] = [];
  for (const party of parties) {
    const all = openItemsOf(activity, party, asOf);
    // Zero would mean "everything, due or not", which is a list of customers
    // rather than a list of debts. Anything overdue is the floor.
    const items = all.filter((i) => i.daysOverdue >= Math.max(1, minAgeDays));
    if (items.length === 0) continue;
    const status = creditStatusFrom(party, all, asOf);
    const oldest = items.reduce((a, i) => Math.max(a, i.daysOverdue), 0);
    const overdueMinor = items.reduce((a, i) => a + BigInt(i.outstandingMinor), 0n);
    const band = bandFor(oldest);
    const cur = party.currency;

    const reason =
      `${party.name} has ${aed(overdueMinor, cur)} overdue across ${items.length} ` +
      `document${items.length === 1 ? "" : "s"}, the oldest by ${oldest} days against ` +
      `${party.paymentTerms === 0 ? "payment-on-receipt" : `${party.paymentTerms}-day`} terms. ` +
      `At that age the usual next step is ${band.step}.` +
      (status.overLimit
        ? ` They are also ${aed(BigInt(status.outstandingMinor) - BigInt(status.creditLimitMinor as string), cur)} over their credit limit.`
        : "") +
      (party.onHold ? ` The account is already on hold: ${party.holdReason}.` : "") +
      ` Nothing has been done to the account — this is a suggestion.`;

    rows.push({
      code: party.code,
      name: party.name,
      email: party.email,
      phone: party.phone,
      currency: cur,
      outstandingMinor: status.outstandingMinor,
      overdueMinor: overdueMinor.toString(),
      oldestOverdueDays: oldest,
      paymentTerms: party.paymentTerms,
      creditLimitMinor: status.creditLimitMinor,
      limitSet: status.limitSet,
      overLimit: status.overLimit,
      onHold: party.onHold,
      suggested: band.action,
      reason,
      items,
    });
  }

  // Worst first: oldest debt, then largest. Whoever works this list top-down
  // should be spending their morning on the accounts that will hurt most.
  rows.sort(
    (a, b) =>
      b.oldestOverdueDays - a.oldestOverdueDays ||
      (BigInt(b.overdueMinor) > BigInt(a.overdueMinor) ? 1 : BigInt(b.overdueMinor) < BigInt(a.overdueMinor) ? -1 : 0) ||
      a.code.localeCompare(b.code),
  );

  return {
    asOf: iso(asOf),
    minAgeDays,
    rows,
    totalOverdueMinor: rows.reduce((a, r) => a + BigInt(r.overdueMinor), 0n).toString(),
    note: NEVER_ACTS,
  };
}

const NEVER_ACTS =
  "Every line here is a suggestion. No account has been held, no reminder has been sent and nothing has been " +
  "written to any record by producing this list. Holding an account is a commercial decision — the customer may " +
  "have paid this morning — so it takes a person and a reason.";

/* -------------------------------------------------------------------- holds */

/**
 * Stop new sales to a counterparty, on the record.
 *
 * The reason is not paperwork. Whoever is asked to release this hold in three
 * weeks has to decide whether it still applies, and "on hold" with an empty
 * field tells them nothing — so they either release it blind or leave a paying
 * customer blocked. Both are worse than the debt.
 */
export async function placeOnHold(opts: {
  orgId: string;
  entityId: string;
  code: string;
  reason: string;
  actorId?: string;
  at?: Date | string;
}): Promise<{ counterparty: Counterparty; note: string }> {
  const party = await load(opts.orgId, opts.entityId, opts.code);
  const reason = checkedReason(opts.reason, "Placing an account on hold");
  if (party.onHold) {
    throw new LedgerError(
      `${party.name} is already on hold: ${party.holdReason}. Release it first if the reason has changed, so the ` +
        `record shows both decisions rather than quietly overwriting the first one.`,
    );
  }

  const at = asDate(opts.at ?? new Date());

  /*
   * There is one hold, and it lives in CreditHold.
   *
   * This function used to set the flag and append a note and nothing else,
   * while credit-control.ts derives holds exclusively from CreditHold rows and
   * never reads the flag. So a hold placed from the Customers screen produced
   * `decision: "allow"` from creditCheck, counted as nought in the register's
   * on-hold summary, and showed an empty hold history — while the Customers
   * chip and checkCreditBeforeSale both honoured it. The screen stated the
   * opposite at the moment of the act: "A hold stops the next order."
   *
   * Credit limits were unified when they were built — setCreditLimit mirrors
   * onto the counterparty and limitFrom falls back to it — which made holds the
   * inconsistent case rather than a considered difference.
   *
   * The import is deferred because credit-control.ts imports this module; a
   * static import here would be a cycle. procurement.ts does the same for
   * inventory.ts and for the same reason.
   */
  const { placeCreditHold } = await import("./credit-control");
  await placeCreditHold({
    orgId: opts.orgId, entityId: opts.entityId, partyKey: party.code,
    reason, on: at, actorId: opts.actorId,
  });

  // The note trail belongs to the customer record and is what somebody reads
  // on this screen; the hold row is the history the credit controller reads.
  const trail = record(party.notes, `${iso(at)} Placed on hold${who(opts.actorId)}: ${reason}`);
  const updated = await prisma.counterparty.update({
    where: { id: party.id },
    data: { onHold: true, holdReason: reason, notes: trail },
  });
  return {
    counterparty: updated,
    note: `${party.name} is on hold. New sales to them should stop until someone releases it, and the reason on ` +
      `record is: ${reason}`,
  };
}

/**
 * Let sales resume — also with a reason, because the release is the decision
 * that matters. A hold that can be lifted silently is a hold that gets lifted
 * by whoever is under most pressure to ship.
 */
export async function releaseHold(opts: {
  orgId: string;
  entityId: string;
  code: string;
  reason: string;
  actorId?: string;
  at?: Date | string;
}): Promise<{ counterparty: Counterparty; note: string }> {
  const party = await load(opts.orgId, opts.entityId, opts.code);
  const reason = checkedReason(opts.reason, "Releasing a hold");
  if (!party.onHold) throw new LedgerError(`${party.name} is not on hold, so there is nothing to release.`);

  const at = asDate(opts.at ?? new Date());

  // The same single store. A release recorded on the flag alone would leave the
  // CreditHold row open forever, and the credit controller's register would go
  // on refusing sales this screen says are allowed.
  const { releaseCreditHold } = await import("./credit-control");
  await releaseCreditHold({
    orgId: opts.orgId, entityId: opts.entityId, partyKey: party.code,
    reason, on: at, actorId: opts.actorId,
  }).catch((e) => {
    // A counterparty flagged before the two stores were unified has no row to
    // release. Clearing the flag is still the right outcome, and the backfill
    // migration means this can only be a record created outside both paths.
    if (e instanceof LedgerError && /not on hold/.test(e.message)) return;
    throw e;
  });

  const trail = record(
    party.notes,
    `${iso(at)} Hold released${who(opts.actorId)}: ${reason} (was held for: ${party.holdReason})`,
  );
  const updated = await prisma.counterparty.update({
    where: { id: party.id },
    data: { onHold: false, holdReason: null, notes: trail },
  });
  return {
    counterparty: updated,
    note: `The hold on ${party.name} is released and the reason is on the record: ${reason}`,
  };
}

const who = (actorId?: string) => (actorId ? ` by ${actorId}` : "");

/**
 * Both decisions are appended to the record rather than replacing it.
 *
 * `holdReason` only ever holds the reason for the hold in force, so on its own
 * it loses the history the moment a hold is released — and the question anyone
 * asks about a re-held account is what happened the last two times.
 */
function record(existing: string | null, entry: string): string {
  return [existing?.trim(), entry].filter(Boolean).join("\n");
}

/* ------------------------------------------------------- the sale-time gate */

export interface CreditDecision {
  allowed: boolean;
  code: string;
  name: string;
  currency: string;
  amountMinor: string;
  outstandingMinor: string;
  /** Where the balance would land if this sale went out. */
  wouldBeMinor: string;
  creditLimitMinor: string | null;
  limitSet: boolean;
  headroomMinor: string | null;
  /** Null unless the sale breaches a limit that exists. */
  overByMinor: string | null;
  overdueMinor: string;
  onHold: boolean;
  /** A full sentence, whichever way the answer went. */
  reason: string;
}

/**
 * The guard an invoicing path calls before a sale goes out.
 *
 * **Where this belongs.** It is meant to be called from the invoice *issue*
 * path — the API route that marks a document sent, or the UI action behind it —
 * before the document is committed, so the answer can be shown to the person
 * raising it while they can still do something about it. It is deliberately
 * *not* called from `postInvoice` in ar.ts, and it must not be: by the time an
 * invoice reaches the ledger it has been issued to the customer, and refusing
 * to post it would leave the books denying a document the customer is already
 * holding. Credit control decides whether to sell; the ledger records what was
 * sold. This file does not wire itself into either — the caller does.
 *
 * When it says no, the sentence names the limit, the current balance and the
 * amount that would be over, because "credit check failed" sends the
 * salesperson to accounts and accounts back to the salesperson.
 */
export async function checkCreditBeforeSale(opts: {
  orgId: string;
  entityId: string;
  code: string;
  amountMinor: number | bigint | string;
  asOf?: Date | string;
}): Promise<CreditDecision> {
  const party = await load(opts.orgId, opts.entityId, opts.code);
  const asOf = asDate(opts.asOf ?? new Date());

  const amount = BigInt(typeof opts.amountMinor === "string" ? opts.amountMinor.trim() : opts.amountMinor);
  if (typeof opts.amountMinor === "number" && !Number.isInteger(opts.amountMinor)) {
    throw new LedgerError(`A sale amount is in whole minor units, so ${opts.amountMinor} is not one.`);
  }
  if (amount <= 0n) {
    throw new LedgerError(
      `A credit check needs the amount of the sale, and ${amount} is not one. A credit note reduces the balance ` +
        `and never needs checking.`,
    );
  }

  const status = creditStatusFrom(
    party,
    openItemsOf(
      await receivableActivity({ orgId: opts.orgId, entityId: opts.entityId, to: asOf, parties: [party] }),
      party,
      asOf,
    ),
    asOf,
  );
  const outstanding = BigInt(status.outstandingMinor);
  const wouldBe = outstanding + amount;
  const cur = party.currency;
  const limit = party.creditLimitMinor;

  const base = {
    code: party.code,
    name: party.name,
    currency: cur,
    amountMinor: amount.toString(),
    outstandingMinor: status.outstandingMinor,
    wouldBeMinor: wouldBe.toString(),
    creditLimitMinor: status.creditLimitMinor,
    limitSet: status.limitSet,
    headroomMinor: status.headroomMinor,
    overdueMinor: status.overdueMinor,
    onHold: party.onHold,
  };

  if (party.status !== "active") {
    return {
      ...base, allowed: false, overByMinor: null,
      reason:
        `${party.name} (${party.code}) is archived, so nothing should be sold to them. If they are trading again, ` +
        `restore the account first — that is a decision worth making explicitly.`,
    };
  }
  if (!sells(party.kind)) {
    return {
      ...base, allowed: false, overByMinor: null,
      reason:
        `${party.name} is recorded as a supplier, not a customer, so a sale to them would never appear on any ` +
        `receivables report. Change the record to BOTH if they are now both.`,
    };
  }
  if (party.onHold) {
    return {
      ...base, allowed: false, overByMinor: null,
      reason:
        `${party.name} is on hold: ${party.holdReason}. They owe ${aed(outstanding, cur)}, of which ` +
        `${aed(BigInt(status.overdueMinor), cur)} is overdue. Releasing the hold is a commercial decision and it ` +
        `has to be taken, with a reason, before this sale goes out.`,
    };
  }
  if (limit === null) {
    // No limit set is not a refusal. Nobody has assessed this account, so there
    // is nothing to check the sale against — say exactly that rather than
    // inventing a threshold or blocking the sale.
    return {
      ...base, allowed: true, overByMinor: null,
      reason:
        `No credit limit has been set for ${party.name}, so this sale of ${aed(amount, cur)} was not checked ` +
        `against one. They owe ${aed(outstanding, cur)} today and would owe ${aed(wouldBe, cur)} after it. ` +
        `A nil limit is not a limit of zero — it means the account has never been assessed.`,
    };
  }
  if (wouldBe > limit) {
    const over = wouldBe - limit;
    return {
      ...base, allowed: false, overByMinor: over.toString(),
      reason:
        `${party.name} owes ${aed(outstanding, cur)} and this sale of ${aed(amount, cur)} would take them to ` +
        `${aed(wouldBe, cur)}, which is ${aed(over, cur)} over their credit limit of ${aed(limit, cur)}` +
        (limit === 0n ? " — they are a cash-up-front account" : "") + `. ` +
        `Take payment on account, raise the limit deliberately, or have the sale approved.`,
    };
  }
  return {
    ...base, allowed: true, overByMinor: null,
    reason:
      `${party.name} owes ${aed(outstanding, cur)}; this sale of ${aed(amount, cur)} takes them to ` +
      `${aed(wouldBe, cur)} against a limit of ${aed(limit, cur)}, leaving ${aed(limit - wouldBe, cur)}.`,
  };
}

/* ------------------------------------------------------------------ listing */

/**
 * Every counterparty with where it stands, in one pass over the ledger — what
 * the customers screen shows before anybody clicks into anything.
 */
export async function listCounterparties(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date | string;
  includeArchived?: boolean;
  kind?: string;
}) {
  const asOf = asDate(opts.asOf ?? new Date());
  const parties = await prisma.counterparty.findMany({
    where: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      ...(opts.includeArchived ? {} : { status: "active" }),
      ...(opts.kind ? { kind: { in: opts.kind === "BOTH" ? ["BOTH"] : [opts.kind, "BOTH"] } } : {}),
    },
    orderBy: { code: "asc" },
  });
  if (parties.length === 0) return { asOf: iso(asOf), counterparties: [] };

  const sellable = parties.filter((p) => sells(p.kind));
  const activity = sellable.length
    ? await receivableActivity({ orgId: opts.orgId, entityId: opts.entityId, to: asOf, parties: sellable })
    : noActivity();

  return {
    asOf: iso(asOf),
    counterparties: parties.map((p) => {
      const status = creditStatusFrom(p, sells(p.kind) ? openItemsOf(activity, p, asOf) : [], asOf);
      // The detail belongs on the party's own screen; the list needs the shape.
      const { items: _items, ...head } = status;
      return { ...head, kind: p.kind, trn: p.trn, email: p.email, phone: p.phone, nameAr: p.nameAr, openItems: status.items.length };
    }),
  };
}
