import { prisma } from "@/lib/server/prisma";
import { post, reverse, LedgerError } from "./post";
import { attributeDocument, partyIndex } from "./counterparties";
import type { Invoice } from "@/lib/domain/types";

/**
 * Writing a receivable off, and taking the VAT back where the law allows it.
 *
 * A debt that will never be paid has to be able to leave the sales ledger.
 * Until this existed it could not: 1100 is a control account, `post()` refuses
 * a control account on a manual journal — correctly, that is what a control
 * account is for — and no subledger owned the operation. So an uncollectable
 * invoice aged forever, the ageing overstated receivables by money nobody was
 * ever going to send, and the dunning ladder kept writing to a customer who
 * had gone.
 *
 * The write-off:
 *
 *   Dr  6260  Bad debts written off     (or 1150, against the allowance)
 *     Cr  1100  Trade receivables         carrying the document on the LINE
 *
 * The settlement stamp is on the line rather than the entry, the same way
 * `payment-runs.ts` stamps a per-bill line, because every reader of the sales
 * ledger keys `settlesId ?? entry.settlesId ?? sourceId` — line first. Without
 * it the write-off would stand as an open credit of its own and the invoice
 * would still be sitting in the over-120 column beside it.
 *
 * Where the entity carries an allowance on 1150 the debit can go there
 * instead, which is what an allowance is for: the expense was already taken
 * when the allowance was raised, and charging 6260 again would take it twice.
 * It is asked, never guessed — the two produce the same balance sheet and a
 * different income statement, and which one is right depends on whether this
 * particular debt was among the ones the allowance was raised for.
 *
 * THE TAX IS A SEPARATE DECISION. Article 64(1) of Federal Decree-Law No. 8 of
 * 2017 lets a supplier reduce the output tax it already paid on money it never
 * received, but only where the tax was charged and paid, the consideration has
 * been written off in the accounts, more than six months have passed since the
 * supply, and the customer has been notified of the amount written off. Two of
 * those are facts this module cannot see — whether the business wants to claim
 * the relief at all, and whether it has actually sent the notice — so the
 * adjustment is a second act with its own date, and the write-off never makes
 * it automatically.
 *
 *   Dr  2100  VAT output                the tax the FTA gives back
 *     Cr  1100  Trade receivables         the last of the open item
 *
 * Which is why the write-off itself clears the debt NET of any tax element the
 * business has told us it intends to reclaim: the tax stays on the open item
 * until the relief is taken, and then the item closes to nothing. Declare no
 * tax element — the default — and the whole gross goes to expense and the item
 * closes at once, which is the right answer for a supply that bore no tax and
 * for a business that is not claiming.
 */

const AR_CONTROL = "1100";
const VAT_OUTPUT = "2100";
const BAD_DEBT = "6260";
const ALLOWANCE = "1150";

/**
 * Article 64(1)(c) says "more than six (6) months". 180 days is the reading
 * taken here, and it is the shorter of the two so the check never refuses a
 * debt the law would allow; it is also exactly what the database constraint
 * enforces, so this and the constraint can never disagree about a date.
 */
const RELIEF_DAYS = 180;

export type WriteOffAgainst = "expense" | "allowance";

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (d: Date | string) => (typeof d === "string" ? new Date(`${d}T00:00:00.000Z`) : d);
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);

/**
 * The tax within part of a document, in proportion to the whole of it.
 *
 * Rounded once, at the end, multiplication before division, half-up. A partial
 * write-off takes a proportional slice of the tax because a partial payment
 * took a proportional slice of it too — the customer did not pay the net first
 * and the VAT afterwards.
 */
function taxWithin(amount: bigint, gross: bigint, vat: bigint): bigint {
  if (gross <= 0n || vat <= 0n || amount <= 0n) return 0n;
  if (amount >= gross) return vat;
  return (2n * vat * amount + gross) / (2n * gross);
}

/* --------------------------------------------------- reading the open items */

interface OpenDoc {
  documentId: string;
  memo: string;
  invoicedOn: Date;
  dueDate: Date | null;
  outstanding: bigint;
  /** What the item opened at, and the output tax inside that, from the invoice. */
  openedGross: bigint;
  openedVat: bigint;
  openingEntryId: string | null;
  opened: boolean;
}

async function accountId(orgId: string, entityId: string, code: string): Promise<string> {
  const account = await prisma.account.findFirst({ where: { orgId, entityId, code }, select: { id: true } });
  if (!account) {
    throw new LedgerError(
      `Account ${code} does not exist for this entity, so there is nothing to write a debt off against. ` +
        `Open the chart of accounts for the entity first.`,
    );
  }
  return account.id;
}

/**
 * Every open item on the receivables control account, netted the way
 * `receivablesAgeing` nets it and keyed by the same expression, so the list a
 * user picks a debt from and the ageing they are trying to clear can never
 * name different items.
 *
 * `status: { in: ["posted", "reversed"] }` matters here as much as anywhere:
 * filtering to posted alone would count a reversing entry while dropping the
 * original, and an invoice that was raised and reversed would show up as a
 * debt available to write off.
 */
async function openItems(opts: { orgId: string; entityId: string; asOf: Date }): Promise<Map<string, OpenDoc>> {
  const arId = await accountId(opts.orgId, opts.entityId, AR_CONTROL);

  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: arId,
      entry: { orgId: opts.orgId, status: { in: ["posted", "reversed"] }, entryDate: { lte: opts.asOf } },
    },
    include: {
      entry: { select: { id: true, entryDate: true, dueDate: true, sourceId: true, settlesId: true, memo: true, source: true } },
    },
    orderBy: [{ entry: { entryDate: "asc" } }, { lineNo: "asc" }],
  });

  const docs = new Map<string, OpenDoc>();
  for (const l of lines) {
    // Line-level settlement first: one receipt clears several invoices and the
    // entry-level column can only name one of them.
    const key = l.settlesId ?? l.entry.settlesId ?? l.entry.sourceId ?? l.id;
    const opensItem = l.entry.source === "invoice";
    const prev = docs.get(key);
    if (prev) {
      prev.outstanding += l.functionalAmountMinor;
      // First invoice-sourced line wins, so a credit note against the invoice
      // reduces the balance without becoming the document the item is about.
      if (opensItem && !prev.opened) {
        prev.memo = l.entry.memo ?? prev.memo;
        prev.invoicedOn = l.entry.entryDate;
        prev.dueDate = l.entry.dueDate;
        prev.openedGross = l.functionalAmountMinor;
        prev.openingEntryId = l.entry.id;
        prev.opened = true;
      }
      continue;
    }
    docs.set(key, {
      documentId: key,
      memo: l.entry.memo ?? "",
      invoicedOn: l.entry.entryDate,
      dueDate: l.entry.dueDate,
      outstanding: l.functionalAmountMinor,
      openedGross: opensItem ? l.functionalAmountMinor : 0n,
      openedVat: 0n,
      openingEntryId: opensItem ? l.entry.id : null,
      opened: opensItem,
    });
  }

  // The output tax on each opening entry, so the tax element of a write-off is
  // read off the books rather than assumed to be a twenty-first of the balance.
  // A zero-rated or exempt supply then correctly offers no relief at all.
  const openingIds = [...docs.values()].map((d) => d.openingEntryId).filter((id): id is string => !!id);
  if (openingIds.length) {
    const vatId = await prisma.account.findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, code: VAT_OUTPUT },
      select: { id: true },
    });
    if (vatId) {
      const vatLines = await prisma.journalLine.findMany({
        where: { accountId: vatId.id, entryId: { in: openingIds } },
        select: { entryId: true, functionalAmountMinor: true },
      });
      const byEntry = new Map<string, bigint>();
      for (const v of vatLines) {
        // Output tax is a credit, so it arrives negative; the tax on the
        // document is the positive of it.
        byEntry.set(v.entryId, (byEntry.get(v.entryId) ?? 0n) - v.functionalAmountMinor);
      }
      for (const d of docs.values()) {
        if (d.openingEntryId) d.openedVat = byEntry.get(d.openingEntryId) ?? 0n;
      }
    }
  }

  return docs;
}

/** The invoice number and the customer behind each open item, where the document store knows them. */
async function documentFacts(opts: { orgId: string; entityId: string; ids: string[] }) {
  const facts = new Map<string, { number: string; partyKey: string; partyName: string }>();
  if (!opts.ids.length) return facts;

  const [records, parties] = await Promise.all([
    prisma.record.findMany({ where: { orgId: opts.orgId, store: "invoices", id: { in: opts.ids } } }),
    prisma.counterparty.findMany({ where: { orgId: opts.orgId, entityId: opts.entityId } }),
  ]);
  const idx = partyIndex(parties);
  const byId = new Map(parties.map((p) => [p.id, p]));

  for (const row of records) {
    let inv: Invoice | undefined;
    try { inv = JSON.parse(row.data) as Invoice; } catch { inv = undefined; }
    if (!inv || inv.direction !== "OUTBOUND") continue;
    const partyId = attributeDocument(inv, idx, "buyer");
    const party = partyId ? byId.get(partyId) : undefined;
    const name = (inv.buyer?.nameEn ?? "").trim();
    facts.set(row.id, {
      number: (inv.number ?? "").trim(),
      // The counterparty code where the document can be attributed to one, so
      // the register groups by the same key the rest of the product does. A
      // document nobody has set up a customer for still has a name on its face,
      // and a name is worth more in a register than a blank.
      partyKey: party?.code.trim() || name || row.id,
      partyName: party?.name || name || "Customer",
    });
  }
  return facts;
}

/* ------------------------------------------------------------- the register */

export interface WriteOffCandidate {
  documentId: string;
  /** The invoice number where the document store has it, else the entry memo. */
  reference: string;
  memo: string;
  partyKey: string;
  partyName: string;
  invoicedOn: string;
  daysOld: number;
  outstandingMinor: bigint;
  /** The output tax inside what is still outstanding. Nil on an untaxed supply. */
  vatMinor: bigint;
  /** The first day Article 64(1)(c) is satisfied for this supply. */
  reliefEligibleOn: string;
  reliefEligible: boolean;
}

export interface WriteOffRow {
  id: string;
  documentId: string;
  documentRef: string;
  partyKey: string;
  partyName: string;
  amountMinor: bigint;
  vatMinor: bigint;
  writtenOffOn: string;
  invoicedOn: string;
  reason: string;
  notifiedOn: string | null;
  vatAdjusted: boolean;
  entryId: string | null;
  /** What still sits on the open item — the tax element, until relief is taken. */
  outstandingMinor: bigint;
  reliefEligibleOn: string;
  /** Empty where the adjustment can be made; otherwise why it cannot. */
  blockedBecause: string[];
}

export interface WriteOffView {
  asOf: string;
  /** The credit balance on 1150. What may be written off against the allowance. */
  allowanceMinor: bigint;
  candidates: WriteOffCandidate[];
  writeOffs: WriteOffRow[];
}

/** The credit balance carried on 1150 at a date. A contra-asset, so a credit is a positive allowance. */
async function allowanceBalance(opts: { orgId: string; entityId: string; asOf: Date }): Promise<bigint> {
  const id = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: ALLOWANCE },
    select: { id: true },
  });
  if (!id) return 0n;
  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: id.id,
      entry: { orgId: opts.orgId, status: { in: ["posted", "reversed"] }, entryDate: { lte: opts.asOf } },
    },
    select: { functionalAmountMinor: true },
  });
  return lines.reduce((a, l) => a - l.functionalAmountMinor, 0n);
}

/** Why the output tax on this write-off may not be adjusted yet, in the words of the condition. */
function reliefBlockers(row: { invoicedOn: Date; writtenOffOn: Date; notifiedOn: Date | null; vatMinor: bigint }): string[] {
  const out: string[] = [];
  const eligibleOn = addDays(row.invoicedOn, RELIEF_DAYS);
  if (row.vatMinor <= 0n) {
    out.push("No output tax was left on this write-off to adjust.");
  }
  if (row.writtenOffOn < eligibleOn) {
    out.push(
      `Article 64(1)(c): more than six months must have passed since the supply. The supply was on ` +
        `${iso(row.invoicedOn)}, so the earliest the tax may be adjusted is ${iso(eligibleOn)}.`,
    );
  }
  if (!row.notifiedOn) {
    out.push(
      "Article 64(1)(d): the customer must be notified of the amount written off before the output tax may be " +
        "adjusted. Record the date the notice was sent.",
    );
  }
  return out;
}

/** Everything the write-off screen reads: what may be written off, and what has been. */
export async function writeOffsView(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date | string;
}): Promise<WriteOffView> {
  const asOf = opts.asOf ? asDate(opts.asOf) : new Date();
  const [docs, rows, allowance] = await Promise.all([
    openItems({ orgId: opts.orgId, entityId: opts.entityId, asOf }),
    prisma.receivableWriteOff.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId },
      orderBy: [{ writtenOffOn: "desc" }, { createdAt: "desc" }],
    }),
    allowanceBalance({ orgId: opts.orgId, entityId: opts.entityId, asOf }),
  ]);

  const written = new Set(rows.map((r) => r.documentId));
  const ids = [...new Set([...docs.keys(), ...rows.map((r) => r.documentId)])];
  const facts = await documentFacts({ orgId: opts.orgId, entityId: opts.entityId, ids });

  const candidates: WriteOffCandidate[] = [];
  for (const doc of docs.values()) {
    // A credit balance is money owed TO the customer, not a debt to write off.
    if (doc.outstanding <= 0n) continue;
    if (written.has(doc.documentId)) continue;
    const fact = facts.get(doc.documentId);
    const eligibleOn = addDays(doc.invoicedOn, RELIEF_DAYS);
    candidates.push({
      documentId: doc.documentId,
      reference: fact?.number || doc.memo || doc.documentId,
      memo: doc.memo,
      partyKey: fact?.partyKey ?? doc.documentId,
      partyName: fact?.partyName ?? "Customer",
      invoicedOn: iso(doc.invoicedOn),
      daysOld: daysBetween(doc.invoicedOn, asOf),
      outstandingMinor: doc.outstanding,
      vatMinor: taxWithin(doc.outstanding, doc.openedGross, doc.openedVat),
      reliefEligibleOn: iso(eligibleOn),
      reliefEligible: asOf >= eligibleOn,
    });
  }
  // Oldest first: the debt most likely to be irrecoverable is the one to look at.
  candidates.sort((a, b) => b.daysOld - a.daysOld || a.reference.localeCompare(b.reference));

  const writeOffs: WriteOffRow[] = rows.map((r) => ({
    id: r.id,
    documentId: r.documentId,
    documentRef: r.documentRef,
    partyKey: r.partyKey,
    partyName: r.partyName,
    amountMinor: r.amountMinor,
    vatMinor: r.vatMinor,
    writtenOffOn: iso(r.writtenOffOn),
    invoicedOn: iso(r.invoicedOn),
    reason: r.reason,
    notifiedOn: r.notifiedOn ? iso(r.notifiedOn) : null,
    vatAdjusted: r.vatAdjusted,
    entryId: r.entryId,
    outstandingMinor: docs.get(r.documentId)?.outstanding ?? 0n,
    reliefEligibleOn: iso(addDays(r.invoicedOn, RELIEF_DAYS)),
    blockedBecause: r.vatAdjusted ? [] : reliefBlockers(r),
  }));

  return { asOf: iso(asOf), allowanceMinor: allowance, candidates, writeOffs };
}

/* ---------------------------------------------------------- writing one off */

export interface WriteOffResult {
  id: string;
  entryId: string;
  reference: string;
  /** What was charged to 6260 or 1150 — the amount less any tax element held back. */
  chargedMinor: bigint;
  /** The tax left on the open item until the Article 64 adjustment is made. */
  vatHeldMinor: bigint;
}

export async function writeOffReceivable(opts: {
  orgId: string;
  entityId: string;
  /** The open item to close, keyed as the ageing keys it. */
  documentId: string;
  /** How much of it is irrecoverable. Defaults to the whole outstanding balance. */
  amountMinor?: number | bigint;
  /**
   * The output tax inside that amount which the business intends to reclaim
   * under Article 64. It is held back from the expense and stays on the open
   * item until the adjustment is made. Nought — the default — writes the whole
   * gross off and closes the item at once.
   */
  vatMinor?: number | bigint;
  writtenOffOn: Date | string;
  reason: string;
  /** Straight to expense, or against an allowance already carried on 1150. */
  against?: WriteOffAgainst;
  /** When the customer was told the amount written off, where they have been. */
  notifiedOn?: Date | string | null;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<WriteOffResult> {
  const { orgId, entityId } = opts;
  const writtenOffOn = asDate(opts.writtenOffOn);
  const reason = (opts.reason ?? "").trim();
  const against: WriteOffAgainst = opts.against ?? "expense";

  if (reason.length < 4) {
    throw new LedgerError(
      "Say why the debt is irrecoverable. A write-off with no reason is a number nobody can defend to an auditor, " +
        "and Article 64(1) makes the reason a condition rather than a note.",
    );
  }

  const existing = await prisma.receivableWriteOff.findFirst({
    where: { orgId, entityId, documentId: opts.documentId },
  });
  if (existing) {
    // Deliberately a refusal rather than a silent second posting. Returning the
    // first one would quietly ignore a different amount or a different reason,
    // and writing the same debt off twice would double the expense.
    throw new LedgerError(
      `${existing.documentRef} was already written off on ${iso(existing.writtenOffOn)} for ${existing.amountMinor} ` +
        `(${existing.reason}). Reverse that write-off first if it needs to be done differently.`,
    );
  }

  const docs = await openItems({ orgId, entityId, asOf: writtenOffOn });
  const doc = docs.get(opts.documentId);
  if (!doc) {
    throw new LedgerError(
      `Nothing on the receivables account names ${opts.documentId} as at ${iso(writtenOffOn)}, so there is no debt ` +
        `to write off. Check the document, or the date — a debt cannot be written off before it was raised.`,
    );
  }
  if (doc.outstanding <= 0n) {
    throw new LedgerError(
      `${doc.memo || opts.documentId} has nothing outstanding as at ${iso(writtenOffOn)}` +
        `${doc.outstanding < 0n ? " — it is in the customer's favour" : ""}. There is no debt to write off.`,
    );
  }
  if (writtenOffOn < doc.invoicedOn) {
    throw new LedgerError(
      `${iso(writtenOffOn)} is before the document was raised on ${iso(doc.invoicedOn)}. A debt cannot go bad ` +
        `before it exists.`,
    );
  }

  const amount = opts.amountMinor === undefined ? doc.outstanding : BigInt(opts.amountMinor);
  if (amount <= 0n) throw new LedgerError("A write-off has to be a positive amount. Writing off nothing is not a write-off.");
  if (amount > doc.outstanding) {
    throw new LedgerError(
      `${doc.memo || opts.documentId} has ${doc.outstanding} outstanding as at ${iso(writtenOffOn)}, so ${amount} ` +
        `cannot be written off it. Writing off more than is owed turns a bad debt into a credit the customer never had.`,
    );
  }

  const vat = opts.vatMinor === undefined ? 0n : BigInt(opts.vatMinor);
  if (vat < 0n) throw new LedgerError("The tax element of a write-off cannot be negative.");
  if (vat > amount) {
    throw new LedgerError(`The tax element (${vat}) cannot be more than the amount written off (${amount}).`);
  }
  const availableVat = taxWithin(amount, doc.openedGross, doc.openedVat);
  if (vat > availableVat) {
    throw new LedgerError(
      `Only ${availableVat} of output tax sits inside ${amount} on ${doc.memo || opts.documentId}, so ${vat} cannot ` +
        `be reclaimed on it. Article 64 gives back the tax that was actually accounted for, and no more.`,
    );
  }

  const charged = amount - vat;
  if (charged <= 0n) {
    throw new LedgerError(
      "The whole of this write-off is tax, which leaves nothing to charge to the profit and loss account. " +
        "Article 64 adjusts the tax on consideration written off; it is not a write-off in its own right.",
    );
  }

  const debitAccount = against === "allowance" ? ALLOWANCE : BAD_DEBT;
  if (against === "allowance") {
    const allowance = await allowanceBalance({ orgId, entityId, asOf: writtenOffOn });
    if (allowance < charged) {
      throw new LedgerError(
        `The allowance on ${ALLOWANCE} carries ${allowance} at ${iso(writtenOffOn)}, which is less than the ${charged} ` +
          `being written off. Raise the allowance first, or write this debt off to ${BAD_DEBT} — using more allowance ` +
          `than was ever set aside charges the expense to a period that never took it.`,
      );
    }
  }

  const fact = (await documentFacts({ orgId, entityId, ids: [opts.documentId] })).get(opts.documentId);
  const notifiedOn = opts.notifiedOn ? asDate(opts.notifiedOn) : null;

  // The record is written first so its id can key the posting: the entry then
  // carries an externalKey unique to this write-off, which is what makes a
  // retry post once and a later write-off of the same debt — after this one is
  // reversed — a genuinely new entry rather than a hit on the old key. If the
  // posting is refused the record goes with it, because a write-off nobody
  // posted is not a write-off.
  const row = await prisma.receivableWriteOff.create({
    data: {
      orgId, entityId,
      documentId: opts.documentId,
      documentRef: fact?.number || doc.memo || opts.documentId,
      partyKey: fact?.partyKey || opts.documentId,
      partyName: fact?.partyName || "Customer",
      amountMinor: amount,
      vatMinor: vat,
      writtenOffOn,
      invoicedOn: doc.invoicedOn,
      reason,
      notifiedOn,
      actorId: opts.actorId,
    },
  });

  try {
    const entry = await post({
      orgId, entityId,
      entryDate: writtenOffOn,
      memo: `Bad debt written off — ${row.documentRef}${row.partyName ? ` (${row.partyName})` : ""}`,
      // Not "manual": 1100 is a control account and this module is the
      // subledger that owns writing a receivable off.
      source: "write_off",
      sourceType: "BAD_DEBT_WRITE_OFF",
      sourceId: row.id,
      externalKey: `write-off:${row.id}`,
      actorType: opts.actorType ?? "HUMAN",
      actorId: opts.actorId,
      series: "WO",
      lines: [
        { account: debitAccount, debit: charged, memo: `${row.documentRef} — ${reason}` },
        {
          account: AR_CONTROL,
          credit: charged,
          // On the line, not the entry. This is what closes the open item.
          settlesId: opts.documentId,
          memo: `Written off ${row.documentRef}`,
        },
      ],
    });
    await prisma.receivableWriteOff.update({ where: { id: row.id }, data: { entryId: entry.id } });
    return {
      id: row.id,
      entryId: entry.id,
      reference: `${entry.series}-${entry.number}`,
      chargedMinor: charged,
      vatHeldMinor: vat,
    };
  } catch (e) {
    await prisma.receivableWriteOff.delete({ where: { id: row.id } }).catch(() => undefined);
    throw e;
  }
}

/* ------------------------------------------------------ adjusting the output tax */

export interface VatAdjustmentResult {
  id: string;
  entryId: string;
  reference: string;
  vatMinor: bigint;
  alreadyAdjusted: boolean;
}

/**
 * Take the output tax back on a debt already written off — Article 64(1).
 *
 * Every condition is checked here, by name, before anything is written. The
 * database enforces the two that can be expressed as a constraint, but a
 * constraint violation reaches the user as a database error naming a check
 * nobody has heard of; a bookkeeper needs to be told which condition is not met
 * and what would meet it.
 *
 * The condition this cannot check is Article 64(1)(a) — that the tax was
 * charged and paid to the FTA. It is true of anything this product posted, but
 * an opening balance imported from a previous system is outside what the ledger
 * can see, so it stays the filer's assertion rather than a check pretending to
 * be one.
 */
export async function adjustWriteOffVat(opts: {
  orgId: string;
  entityId: string;
  /** The write-off, or the document it was made against. */
  writeOffId?: string;
  documentId?: string;
  /** When the customer was notified, where it was not already recorded. */
  notifiedOn?: Date | string;
  /** When the adjustment is posted. The return it lands on. */
  adjustedOn?: Date | string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<VatAdjustmentResult> {
  const { orgId, entityId } = opts;
  // Without one of the two this would match the first write-off in the entity
  // and adjust the tax on a debt nobody named.
  if (!opts.writeOffId && !opts.documentId) {
    throw new LedgerError("Which write-off is the tax being adjusted on? Name the write-off or the document.");
  }
  const row = await prisma.receivableWriteOff.findFirst({
    where: {
      orgId, entityId,
      ...(opts.writeOffId ? { id: opts.writeOffId } : {}),
      ...(opts.documentId ? { documentId: opts.documentId } : {}),
    },
  });
  if (!row) {
    throw new LedgerError(
      "There is no write-off to adjust the tax on. A debt has to be written off in the accounts before " +
        "Article 64 relief can be claimed on it — that is condition (b).",
    );
  }

  const adjustedOn = opts.adjustedOn ? asDate(opts.adjustedOn) : new Date();

  if (row.vatAdjusted) {
    const posted = await prisma.journalEntry.findFirst({
      where: { orgId, externalKey: `write-off-vat:${row.id}` },
      select: { id: true, series: true, number: true },
    });
    return {
      id: row.id,
      entryId: posted?.id ?? "",
      reference: posted ? `${posted.series}-${posted.number}` : "",
      vatMinor: row.vatMinor,
      alreadyAdjusted: true,
    };
  }

  const notifiedOn = opts.notifiedOn ? asDate(opts.notifiedOn) : row.notifiedOn;
  const blockers = reliefBlockers({
    invoicedOn: row.invoicedOn,
    writtenOffOn: row.writtenOffOn,
    notifiedOn,
    vatMinor: row.vatMinor,
  });
  if (blockers.length) throw new LedgerError(blockers.join(" "));
  if (notifiedOn && notifiedOn > adjustedOn) {
    throw new LedgerError(
      `The notice to the customer is dated ${iso(notifiedOn)}, after the ${iso(adjustedOn)} this adjustment would be ` +
        `posted. The relief runs from the notification, so it cannot be claimed on a return that closes before it.`,
    );
  }

  const entry = await post({
    orgId, entityId,
    entryDate: adjustedOn,
    memo: `Bad debt relief — ${row.documentRef} (Article 64)`,
    source: "write_off",
    sourceType: "BAD_DEBT_RELIEF",
    sourceId: row.id,
    externalKey: `write-off-vat:${row.id}`,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "WO",
    lines: [
      {
        account: VAT_OUTPUT,
        debit: row.vatMinor,
        // Tagged as output tax so the VAT return reads it: box 1's tax figure
        // is the sum of every OUTPUT_VAT line, credits positive, so a debit
        // here reduces the tax declared without touching the supplies figure —
        // which is right, because a bad debt does not undo a sale.
        taxCode: "OUTPUT_VAT",
        memo: `Article 64 relief on ${row.documentRef}`,
      },
      {
        account: AR_CONTROL,
        credit: row.vatMinor,
        settlesId: row.documentId,
        memo: `Tax element written off — ${row.documentRef}`,
      },
    ],
  });

  await prisma.receivableWriteOff.update({
    where: { id: row.id },
    data: { vatAdjusted: true, notifiedOn: notifiedOn ?? row.notifiedOn },
  });

  return { id: row.id, entryId: entry.id, reference: `${entry.series}-${entry.number}`, vatMinor: row.vatMinor, alreadyAdjusted: false };
}

/* ------------------------------------------------------------- reversing it */

export interface ReverseWriteOffResult {
  documentId: string;
  /** The reversing entries, newest act first: the tax adjustment, then the write-off. */
  entryIds: string[];
  references: string[];
  restoredMinor: bigint;
}

/**
 * Put a written-off debt back.
 *
 * A customer who pays after being written off is common enough that the
 * write-off is worth nothing without this. Correction is by reversal, as
 * everywhere else in this ledger: the original entries stay exactly as posted
 * and mirror-image entries are posted against them, so the write-off and its
 * undoing are both on the record.
 *
 * `reverse()` carries the line's own `settlesId` into the reversal, which is
 * what puts the debt back on the SAME open item instead of opening a new one
 * beside it. Without that the customer would show a debt and a credit of equal
 * size and the ageing would be right only in total.
 *
 * Where the output tax was adjusted, that is reversed too and first. Leaving it
 * adjusted would mean the debt is back on the books and the FTA has still given
 * the tax back — a claim the business is no longer entitled to.
 */
export async function reverseWriteOff(opts: {
  orgId: string;
  entityId: string;
  writeOffId?: string;
  documentId?: string;
  reversedOn?: Date | string;
  reason?: string;
  actorId?: string;
}): Promise<ReverseWriteOffResult> {
  const { orgId, entityId } = opts;
  if (!opts.writeOffId && !opts.documentId) {
    throw new LedgerError("Which write-off is being reversed? Name the write-off or the document.");
  }
  const row = await prisma.receivableWriteOff.findFirst({
    where: {
      orgId, entityId,
      ...(opts.writeOffId ? { id: opts.writeOffId } : {}),
      ...(opts.documentId ? { documentId: opts.documentId } : {}),
    },
  });
  if (!row) throw new LedgerError("There is no write-off to reverse against that document.");

  const reversedOn = opts.reversedOn ? asDate(opts.reversedOn) : new Date();
  const why = (opts.reason ?? "").trim();
  const entryIds: string[] = [];
  const references: string[] = [];
  let restored = 0n;

  if (row.vatAdjusted) {
    const vatEntry = await prisma.journalEntry.findFirst({
      where: { orgId, externalKey: `write-off-vat:${row.id}` },
      select: { id: true, status: true },
    });
    if (vatEntry && vatEntry.status === "posted") {
      const r = await reverse({
        orgId, entryId: vatEntry.id, entryDate: reversedOn, actorId: opts.actorId,
        memo: `Bad debt relief reversed — ${row.documentRef}${why ? ` (${why})` : ""}`,
      });
      entryIds.push(r.id);
      references.push(`${r.series}-${r.number}`);
      restored += row.vatMinor;
    }
  }

  if (row.entryId) {
    const entry = await prisma.journalEntry.findFirst({
      where: { orgId, id: row.entryId },
      select: { id: true, status: true },
    });
    if (entry && entry.status === "posted") {
      const r = await reverse({
        orgId, entryId: entry.id, entryDate: reversedOn, actorId: opts.actorId,
        memo: `Write-off reversed — ${row.documentRef}${why ? ` (${why})` : ""}`,
      });
      entryIds.push(r.id);
      references.push(`${r.series}-${r.number}`);
      restored += row.amountMinor - row.vatMinor;
    } else if (entry) {
      throw new LedgerError(
        `The write-off of ${row.documentRef} is already ${entry.status}, so there is nothing left to reverse.`,
      );
    }
  }

  // The row goes, and the journal keeps the history: both the write-off and its
  // reversal are posted and immutable. Keeping a row for a write-off that no
  // longer stands would hold the one-per-document index against a debt that is
  // open again, so a customer whose payment later bounces could never have it
  // written off a second time.
  await prisma.receivableWriteOff.delete({ where: { id: row.id } });

  return { documentId: row.documentId, entryIds, references, restoredMinor: restored };
}
