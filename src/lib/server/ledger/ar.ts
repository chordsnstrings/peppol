import { prisma } from "@/lib/server/prisma";
import { post, LedgerError, type PostLine } from "./post";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

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

  const lines: PostLine[] = [
    {
      account: AR_CONTROL,
      ...(gross > 0n ? { debit: gross } : { credit: -gross }),
      ...fx,
      memo: `${inv.buyer?.nameEn ?? "Customer"} — ${inv.number}`,
    },
  ];

  const emirate = inv.seller?.address?.emirate ?? undefined;
  for (const [account, r] of revenue) {
    const amount = r.net * sign;
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

/**
 * Post a receipt against an invoice.
 *
 *   Dr  1010  Bank             what arrived
 *     Cr  1100  Trade receivables  what the customer no longer owes
 *
 * Any difference between the two — because the invoice was raised in USD and
 * the money arrived at a different rate — is a realised exchange gain or loss,
 * and it is booked explicitly rather than silently absorbed into the bank line.
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
  const externalKey = `receipt:${opts.paymentId}`;
  const existing = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey },
    select: { id: true, series: true, number: true },
  });
  if (existing) {
    return { entryId: existing.id, reference: `${existing.series}-${existing.number}`, alreadyPosted: true };
  }

  const bank = BigInt(opts.bankAmountMinor);
  const cleared = opts.clearedAmountMinor === undefined ? bank : BigInt(opts.clearedAmountMinor);
  if (bank <= 0n) throw new LedgerError("A receipt has to be a positive amount.");

  const lines: PostLine[] = [
    { account: opts.bankAccount ?? "1010", debit: bank, memo: `Receipt for ${opts.invoiceNumber}` },
    { account: AR_CONTROL, credit: cleared, memo: `Settles ${opts.invoiceNumber}` },
  ];

  // More money arrived than the receivable carried → a gain; less → a loss.
  const diff = bank - cleared;
  if (diff > 0n) lines.push({ account: FX_GAIN, credit: diff, memo: "Realised exchange difference" });
  if (diff < 0n) lines.push({ account: FX_LOSS, debit: -diff, memo: "Realised exchange difference" });

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: opts.receivedOn,
    memo: `Receipt — ${opts.invoiceNumber}`,
    source: "payment",
    sourceType: "RECEIPT",
    sourceId: opts.paymentId,
    settlesId: opts.invoiceId,
    externalKey,
    actorType: opts.actorType ?? "INTEGRATION",
    actorId: opts.actorId,
    series: "CR",
    lines,
  });

  return { entryId: entry.id, reference: `${entry.series}-${entry.number}`, alreadyPosted: false };
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

  const buckets = { current: 0n, d30: 0n, d60: 0n, d90: 0n, d90plus: 0n };
  const open: OpenItem[] = [];
  let overdue = 0n;
  for (const [sourceId, row] of bySource) {
    if (row.outstanding === 0n) continue;
    const days = daysBetween(row.date, asOf);
    const bucket = days <= 30 ? "current" : days <= 60 ? "d30" : days <= 90 ? "d60" : days <= 120 ? "d90" : "d90plus";
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
