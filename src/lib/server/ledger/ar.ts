import { prisma } from "@/lib/server/prisma";
import { post, LedgerError, type PostLine } from "./post";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";
import { marginSchemeLineTax } from "@/lib/domain/tax";

/**
 * The accounts-receivable subledger.
 *
 * An invoice and its journal entry are two different things. The invoice is the
 * document sent to the customer; the entry is what it did to the books. Keeping
 * them separate is what makes it possible to correct one without rewriting the
 * other, and it is why posting lives here rather than inside the invoice save
 * path.
 *
 * Posting is idempotent on the invoice id, so the send pipeline, a webhook and
 * a manual retry can all call it and the books see one entry. Nothing is ever
 * un-posted: a cancelled or credited invoice produces a reversing entry.
 *
 * The shape of a sales entry:
 *
 *   Dr  1100  Trade receivables        gross (what the customer owes)
 *     Cr  4xxx  Revenue                  net, split by what was sold
 *     Cr  2100  VAT output               the tax collected on behalf of the FTA
 *
 * A credit note is the same entry with every side flipped.
 */

/** Where each tax treatment's revenue lands, absent a product-level override. */
const REVENUE_BY_PROFILE: Record<TaxProfileCode, string> = {
  STANDARD_5: "4000",
  ZERO_EXPORT: "4200",
  ZERO_OTHER: "4000",
  EXEMPT: "4000",
  OUT_OF_SCOPE: "4900",
  // The buyer accounts for the tax, so the seller books revenue only.
  REVERSE_CHARGE: "4100",
  DESIGNATED_ZONE: "4200",
  MARGIN_SCHEME: "4000",
};

/**
 * The memo on the margin-scheme tax line, shared with `vat.ts`.
 *
 * A constant rather than a repeated string because the VAT return reads it: it
 * is how the return tells tax the customer was charged from tax the business
 * owes out of its own margin, and the two are indistinguishable on the account
 * and on the tax code. Change the wording here and the return follows.
 */
export const MARGIN_TAX_MEMO = "VAT on the margin — not charged to the customer";

const AR_CONTROL = "1100";
const VAT_OUTPUT = "2100";
const FX_GAIN = "4950";
const FX_LOSS = "6800";

/** Minor units from the domain's number-typed totals, checked for integrality. */
function minor(v: number | undefined, what: string): bigint {
  const n = v ?? 0;
  if (!Number.isInteger(n)) {
    throw new LedgerError(`${what} must be in whole minor units, got ${n}.`);
  }
  return BigInt(n);
}

/**
 * Revenue split by account. Lines that share a revenue account are summed, so
 * an invoice with forty line items still posts three or four journal lines —
 * the ledger records what happened to the business, not a copy of the document.
 */
function revenueByAccount(lines: InvoiceLine[]): Map<string, { net: bigint; taxCode: TaxProfileCode }> {
  const out = new Map<string, { net: bigint; taxCode: TaxProfileCode }>();
  for (const l of lines) {
    const account = REVENUE_BY_PROFILE[l.taxProfileCode] ?? "4000";
    const prev = out.get(account);
    const net = minor(l.lineNetMinor, `Line ${l.lineNo} net`);
    // Lines are only merged when they share an account, and an account only
    // serves one treatment, so the tax code stays unambiguous.
    out.set(account, prev ? { net: prev.net + net, taxCode: prev.taxCode } : { net, taxCode: l.taxProfileCode });
  }
  return out;
}

export interface PostInvoiceResult {
  entryId: string;
  reference: string;
  alreadyPosted: boolean;
}

/**
 * Post a sales invoice or credit note to the general ledger.
 *
 * `externalKey` makes this safe to call more than once: the second call returns
 * the entry the first one made rather than doubling the revenue.
 */
export async function postInvoice(opts: {
  orgId: string;
  invoice: Invoice;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<PostInvoiceResult> {
  const { invoice: inv, orgId } = opts;

  if (inv.direction !== "OUTBOUND") {
    throw new LedgerError("Only a sales invoice posts through the receivables subledger.");
  }

  const externalKey = `invoice:${inv.id}`;
  const existing = await prisma.journalEntry.findFirst({
    where: { orgId, externalKey },
    select: { id: true, series: true, number: true },
  });
  if (existing) {
    return { entryId: existing.id, reference: `${existing.series}-${existing.number}`, alreadyPosted: true };
  }

  // A credit note reverses the sign of everything on the document.
  const isCredit = inv.docType === "TAX_CREDIT_NOTE";
  const sign = isCredit ? -1n : 1n;

  const gross = minor(inv.totals.payableMinor, "Invoice total") * sign;
  const vat = minor(inv.totals.vatMinor, "VAT total") * sign;
  const revenue = revenueByAccount(inv.lines);

  // Margin-scheme output tax.
  //
  // The document shows no tax — Executive Regulation Article 43 forbids it —
  // and the customer pays a VAT-inclusive price. The business still owes the
  // FTA 5/105 of the margin under Article 29, so the liability has to come out
  // of the revenue rather than be added to the invoice: revenue is what was
  // charged less the tax embedded in it. Adding it to the payable amount would
  // charge the customer a tax they were told the document does not carry.
  //
  // It is taken off the accounts the margin lines themselves credit, so a
  // document that mixes margin and standard-rated lines reduces only the
  // margin revenue.
  const marginTaxByAccount = new Map<string, bigint>();
  for (const l of inv.lines) {
    const { taxMinor } = marginSchemeLineTax(l);
    if (!taxMinor) continue;
    const account = REVENUE_BY_PROFILE[l.taxProfileCode] ?? "4000";
    marginTaxByAccount.set(account, (marginTaxByAccount.get(account) ?? 0n) + BigInt(taxMinor));
  }
  const marginTax = [...marginTaxByAccount.values()].reduce((a, v) => a + v, 0n) * sign;

  const netTotal = [...revenue.values()].reduce((a, r) => a + r.net, 0n) * sign;
  // The document has to be internally consistent before it reaches the books.
  // Catching this here names the invoice; catching it in the ledger names a
  // journal the user has never seen.
  if (netTotal + vat !== gross) {
    throw new LedgerError(
      `Invoice ${inv.number} does not add up: lines total ${netTotal + vat} but the payable amount is ${gross}. ` +
        `Fix the document before posting it.`,
    );
  }

  const currency = inv.currency || "AED";
  // Foreign-currency invoices carry the CBUAE rate they were issued at, so the
  // books convert at the rate on the document rather than at today's rate.
  const fxRate = currency === "AED" ? undefined : Number(inv.fx?.rateToAED ?? 0);
  if (fxRate !== undefined && !(fxRate > 0)) {
    throw new LedgerError(
      `Invoice ${inv.number} is in ${currency} but carries no exchange rate to AED. ` +
        `Set the rate on the invoice before posting it.`,
    );
  }
  const fx = fxRate === undefined ? {} : { currency, fxRate };

  /**
   * A credit note against exactly one invoice settles that invoice.
   *
   * Without this the credit note stands as its own open item forever: the
   * ageing shows the invoice gross and the credit separately, the over-90
   * column is overstated by the amount of a credit that may relate to exactly
   * that invoice, and a collections letter chases money the customer does not
   * owe.
   *
   * Exactly one, and only where the document carries that invoice's id. A
   * credit note naming three invoices needs an allocation across them, and
   * nobody has made it — spreading it by amount would be arithmetic presented
   * as a decision. One named only by number could match two documents with the
   * same number in different years. In both cases the note stands alone, which
   * is what it did before, and which is at least visibly incomplete rather
   * than confidently wrong.
   */
  const credits = isCredit
    ? (inv.precedingInvoices ?? []).map((p) => p.invoiceId).filter((id): id is string => !!id?.trim())
    : [];
  const settlesId = credits.length === 1 ? credits[0] : undefined;

  const lines: PostLine[] = [
    {
      account: AR_CONTROL,
      ...(gross > 0n ? { debit: gross } : { credit: -gross }),
      ...fx,
      ...(settlesId ? { settlesId } : {}),
      memo: `${inv.buyer?.nameEn ?? "Customer"} — ${inv.number}`,
    },
  ];

  const emirate = inv.seller?.address?.emirate ?? undefined;
  for (const [account, r] of revenue) {
    const amount = (r.net - (marginTaxByAccount.get(account) ?? 0n)) * sign;
    if (amount === 0n) continue;
    lines.push({
      account, ...(amount > 0n ? { credit: amount } : { debit: -amount }), ...fx,
      taxCode: r.taxCode, taxEmirate: emirate,
    });
  }

  if (vat !== 0n) {
    lines.push({
      account: VAT_OUTPUT,
      ...(vat > 0n ? { credit: vat } : { debit: -vat }),
      ...fx,
      memo: "VAT on sales",
      taxCode: "OUTPUT_VAT",
      taxEmirate: emirate,
    });
  }

  if (marginTax !== 0n) {
    // A separate line from the ordinary output tax, and deliberately so: on
    // the VAT return the two are the same liability, but on the invoice one
    // was charged to the customer and the other was not, and only a separate
    // line lets anybody see afterwards which was which.
    lines.push({
      account: VAT_OUTPUT,
      ...(marginTax > 0n ? { credit: marginTax } : { debit: -marginTax }),
      ...fx,
      memo: MARGIN_TAX_MEMO,
      taxCode: "OUTPUT_VAT",
      taxEmirate: emirate,
    });
  }

  const entry = await post({
    orgId,
    entityId: inv.entityId,
    entryDate: inv.issueDate,
    // The terms are on the document; carrying them to the entry is what lets
    // the ageing tell "old" from "overdue" without assuming everyone pays on
    // the same terms.
    dueDate: inv.dueDate ?? null,
    memo: `${isCredit ? "Credit note" : "Invoice"} ${inv.number} — ${inv.buyer?.nameEn ?? "customer"}`,
    source: "invoice",
    sourceType: inv.docType,
    sourceId: inv.id,
    externalKey,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "SI",
    lines,
  });

  return { entryId: entry.id, reference: `${entry.series}-${entry.number}`, alreadyPosted: false };
}

/** One invoice a receipt is applied to, and what applying it does to the books. */
export interface ReceiptAllocation {
  /**
   * The open item this settles. It becomes the settlement stamp on this
   * line — not on the entry — which is the whole point: an entry can name one
   * document, and a bank transfer clearing five invoices needs to name five.
   */
  invoiceId: string;
  invoiceNumber: string;
  /**
   * What comes off 1100 for this invoice, in the functional currency. It is
   * what the receivable was carried at, which is not always what arrived.
   */
  clearedMinor: number | bigint;
  /**
   * This invoice's share of the money that actually arrived, in the functional
   * currency. Defaults to `clearedMinor`, and differs only where the invoice
   * was raised at one rate and paid at another — the difference is then the
   * realised exchange gain or loss on that invoice, and it is booked per
   * invoice because two invoices raised at two rates produce two differences.
   */
  receivedMinor?: number | bigint;
}

export interface PostReceiptResult extends PostInvoiceResult {
  /**
   * What arrived and was applied to no invoice. It stays on the receivables
   * account as a credit in the customer's favour rather than being forced onto
   * an invoice it does not belong to — an over-payment is a fact about the
   * customer, not about any one document.
   */
  onAccountMinor: bigint;
}

/**
 * Post one receipt from a customer against the invoices it settles.
 *
 *   Dr  1010  Bank                     what arrived — ONE line
 *     Cr  1100  Trade receivables        per invoice, each naming its own
 *     Cr  1100  Trade receivables        what was over-paid, on account
 *     Cr  4950 / Dr 6800                 the difference on each invoice
 *
 * One bank line, and that is the reason this exists. Posting an entry per
 * invoice would debit the bank five times for a statement line that shows one
 * transfer, and the reconciler's exact-amount matcher would never pair any of
 * them: six permanently unmatched items for one payment, growing every month.
 * The shape is the one `payment-runs.ts` already uses on the payables side, and
 * what makes it possible is settlement recorded on the LINE — every reader of
 * the sales ledger keys `settlesId ?? entry.settlesId ?? sourceId`, line first.
 *
 * Three things happen in real life and all three are handled here rather than
 * pushed back at the user. More money arrives than was allocated, and the
 * remainder sits on account. Less arrives than the invoice was raised for, and
 * the item simply stays open for the rest — nothing special is needed, because
 * the open item is a netted balance and not a flag. And the money arrives in a
 * currency whose rate has moved since each invoice was raised, which is why the
 * exchange difference is computed per invoice and not once on the total.
 */
export async function postCustomerReceipt(opts: {
  orgId: string;
  entityId: string;
  paymentId: string;
  receivedOn: Date | string;
  /** What actually landed in the bank, in the functional currency. */
  bankAmountMinor: number | bigint;
  allocations: ReceiptAllocation[];
  bankAccount?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<PostReceiptResult> {
  const externalKey = `receipt:${opts.paymentId}`;
  const existing = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey },
    include: { lines: { select: { settlesId: true, functionalAmountMinor: true, accountId: true } } },
  });
  if (existing) {
    // What went on account is read back off the entry rather than recomputed,
    // so a retry reports what was actually posted and not what this call would
    // have posted.
    const onAccount = existing.lines
      .filter((l) => l.settlesId === null && l.functionalAmountMinor < 0n)
      .reduce((a, l) => a - l.functionalAmountMinor, 0n);
    return {
      entryId: existing.id,
      reference: `${existing.series}-${existing.number}`,
      alreadyPosted: true,
      onAccountMinor: onAccount,
    };
  }

  const bank = BigInt(opts.bankAmountMinor);
  if (bank <= 0n) throw new LedgerError("A receipt has to be a positive amount.");

  const allocations = opts.allocations ?? [];
  if (allocations.length === 0) {
    throw new LedgerError(
      "A receipt has to say which invoices it pays. Money credited to the receivables account against no document " +
        "is money the ageing can never clear.",
    );
  }

  const seen = new Set<string>();
  const applied = allocations.map((a) => {
    const id = (a.invoiceId ?? "").trim();
    if (!id) {
      throw new LedgerError(
        `The line for ${a.invoiceNumber || "one of the invoices"} names no invoice, so settling it would clear nothing ` +
          `in the ageing. Give it the invoice id, or take it off the receipt.`,
      );
    }
    if (seen.has(id)) {
      // Two lines for one invoice would each stamp the same open item, which
      // nets to the right total and reads as two settlements of one document.
      throw new LedgerError(
        `${a.invoiceNumber || id} appears twice on this receipt. Put one line on it for the whole amount being applied.`,
      );
    }
    seen.add(id);
    const cleared = BigInt(a.clearedMinor);
    const received = a.receivedMinor === undefined ? cleared : BigInt(a.receivedMinor);
    if (cleared <= 0n) throw new LedgerError(`The amount applied to ${a.invoiceNumber || id} has to be positive.`);
    if (received <= 0n) throw new LedgerError(`The money applied to ${a.invoiceNumber || id} has to be positive.`);
    return { invoiceId: id, invoiceNumber: a.invoiceNumber || id, cleared, received };
  });

  const allocated = applied.reduce((a, x) => a + x.received, 0n);
  if (allocated > bank) {
    throw new LedgerError(
      `The receipt allocates ${allocated} across ${applied.length} invoice${applied.length === 1 ? "" : "s"} but only ` +
        `${bank} arrived. Reduce what is applied, or split the payment.`,
    );
  }
  const onAccount = bank - allocated;

  const single = applied.length === 1 && onAccount === 0n;
  const lines: PostLine[] = [
    {
      account: opts.bankAccount ?? "1010",
      debit: bank,
      memo: single ? `Receipt for ${applied[0].invoiceNumber}` : `Receipt — ${applied.length} invoices`,
    },
  ];

  for (const x of applied) {
    lines.push({
      account: AR_CONTROL,
      credit: x.cleared,
      settlesId: x.invoiceId,
      memo: `Settles ${x.invoiceNumber}`,
    });
    // More money arrived than the receivable carried -> a gain; less -> a loss.
    // Per invoice, because gains on one and losses on another are two events;
    // netting them first would post a single figure that is neither.
    const diff = x.received - x.cleared;
    if (diff > 0n) lines.push({ account: FX_GAIN, credit: diff, memo: `Realised exchange difference on ${x.invoiceNumber}` });
    if (diff < 0n) lines.push({ account: FX_LOSS, debit: -diff, memo: `Realised exchange difference on ${x.invoiceNumber}` });
  }

  if (onAccount > 0n) {
    // Deliberately unstamped. An unallocated credit belongs to the customer and
    // not to a document, so it stands as its own open item until somebody says
    // which invoice it pays — which is a decision, not arithmetic.
    lines.push({ account: AR_CONTROL, credit: onAccount, memo: "On account — not applied to an invoice" });
  }

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: opts.receivedOn,
    memo: single ? `Receipt — ${applied[0].invoiceNumber}` : `Receipt — ${applied.length} invoices`,
    source: "payment",
    sourceType: "RECEIPT",
    sourceId: opts.paymentId,
    // Only where the receipt settles exactly one document and nothing is left
    // over. Anything else cannot be named at entry level without naming one of
    // several, and a reader that trusted it would clear the wrong invoice.
    ...(single ? { settlesId: applied[0].invoiceId } : {}),
    externalKey,
    actorType: opts.actorType ?? "INTEGRATION",
    actorId: opts.actorId,
    series: "CR",
    lines,
  });

  return {
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPosted: false,
    onAccountMinor: onAccount,
  };
}

/**
 * Post a receipt against one invoice.
 *
 *   Dr  1010  Bank             what arrived
 *     Cr  1100  Trade receivables  what the customer no longer owes
 *
 * Any difference between the two — because the invoice was raised in USD and
 * the money arrived at a different rate — is a realised exchange gain or loss,
 * and it is booked explicitly rather than silently absorbed into the bank line.
 *
 * The single-invoice form of `postCustomerReceipt`, kept because every caller
 * has one invoice in hand and should not have to build a list to say so.
 */
export async function postReceipt(opts: {
  orgId: string;
  entityId: string;
  /** The invoice being settled — used for the idempotency key and the memo. */
  invoiceId: string;
  invoiceNumber: string;
  paymentId: string;
  receivedOn: Date | string;
  /** What actually landed in the bank, in the functional currency. */
  bankAmountMinor: number | bigint;
  /** What the invoice carried this receipt at, in the functional currency. */
  clearedAmountMinor?: number | bigint;
  bankAccount?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<PostInvoiceResult> {
  const bank = BigInt(opts.bankAmountMinor);
  return postCustomerReceipt({
    orgId: opts.orgId,
    entityId: opts.entityId,
    paymentId: opts.paymentId,
    receivedOn: opts.receivedOn,
    bankAmountMinor: bank,
    bankAccount: opts.bankAccount,
    actorId: opts.actorId,
    actorType: opts.actorType,
    allocations: [
      {
        invoiceId: opts.invoiceId,
        invoiceNumber: opts.invoiceNumber,
        clearedMinor: opts.clearedAmountMinor === undefined ? bank : BigInt(opts.clearedAmountMinor),
        receivedMinor: bank,
      },
    ],
  });
}

/** The AR ageing report, straight from the ledger rather than from the documents. */
/** One document, netted down to what is still outstanding on it. */
export interface OpenItem {
  sourceId: string;
  memo: string;
  /** The day the document was raised. */
  date: string;
  /** The day it falls due, where the document carried terms. */
  dueDate: string | null;
  outstandingMinor: string;
  /** Days since it was raised — what the ageing bands are measured on. */
  daysOld: number;
  /** Days past its own due date; nil where none is known or it is not yet due. */
  daysOverdue: number;
}

/** Whole days, so a report run at teatime says the same as one run at dawn. */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

export async function receivablesAgeing(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date;
}) {
  const asOf = opts.asOf ?? new Date();
  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: AR_CONTROL },
  });
  if (!account) throw new LedgerError("The receivables control account does not exist for this entity.");

  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: account.id,
      entry: { orgId: opts.orgId, status: { in: ["posted", "reversed"] }, entryDate: { lte: asOf } },
    },
    include: {
      entry: { select: { entryDate: true, dueDate: true, sourceId: true, settlesId: true, sourceType: true, memo: true, source: true } },
    },
    orderBy: { entry: { entryDate: "asc" } },
  });

  // Net each document down to what is still outstanding on it. A receipt is
  // keyed by the invoice it settles, not by its own id — otherwise a payment
  // never meets the invoice it paid and the ageing shows both forever.
  //
  // The document's own age is what matters, so the date comes from the invoice
  // that opened the item, never from the receipt that closed part of it.
  const byDoc = new Map<string, { memo: string; date: Date; due: Date | null; outstanding: bigint; opened: boolean }>();
  for (const l of lines) {
    // Line-level settlement first: one batch payment entry discharges several
    // bills, and the entry-level column can only name one of them.
    const key = l.settlesId ?? l.entry.settlesId ?? l.entry.sourceId ?? l.id;
    const opensItem = l.entry.source === "invoice";
    const prev = byDoc.get(key);
    if (prev) {
      prev.outstanding += l.functionalAmountMinor;
      if (opensItem && !prev.opened) { prev.memo = l.entry.memo ?? prev.memo; prev.date = l.entry.entryDate; prev.due = l.entry.dueDate; prev.opened = true; }
    } else {
      byDoc.set(key, {
        memo: l.entry.memo ?? "", date: l.entry.entryDate, due: l.entry.dueDate,
        outstanding: l.functionalAmountMinor, opened: opensItem,
      });
    }
  }
  const bySource = byDoc;

  // The keys name the band they hold. They used to be d30/d60/d90/d90plus,
  // which read as though d90 were "90 days and over" when it is the 91 to
  // 120 band — a name that quietly understates the oldest debt to anybody
  // reading the figures rather than the code that cut them.
  const buckets = { current: 0n, d31_60: 0n, d61_90: 0n, d91_120: 0n, over120: 0n };
  const open: OpenItem[] = [];
  let overdue = 0n;
  for (const [sourceId, row] of bySource) {
    if (row.outstanding === 0n) continue;
    const days = daysBetween(row.date, asOf);
    const bucket = days <= 30 ? "current" : days <= 60 ? "d31_60" : days <= 90 ? "d61_90" : days <= 120 ? "d91_120" : "over120";
    buckets[bucket] += row.outstanding;
    // Overdue is a different question from old, and only the due date answers
    // it. The bands stay measured from the document date, so a report that has
    // always meant "age" keeps meaning it; what is added is the fact that used
    // to be missing.
    const daysOverdue = row.due ? Math.max(0, daysBetween(row.due, asOf)) : 0;
    if (daysOverdue > 0) overdue += row.outstanding;
    open.push({
      sourceId, memo: row.memo,
      date: row.date.toISOString().slice(0, 10),
      dueDate: row.due ? row.due.toISOString().slice(0, 10) : null,
      outstandingMinor: row.outstanding.toString(),
      daysOld: days, daysOverdue,
    });
  }

  open.sort((a, b) => b.daysOld - a.daysOld);
  return {
    asOf: asOf.toISOString().slice(0, 10),
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.toString()])),
    totalMinor: Object.values(buckets).reduce((a, b) => a + b, 0n).toString(),
    /** Of the total, what is past its own due date. Nil where none is known. */
    overdueMinor: overdue.toString(),
    open,
  };
}
