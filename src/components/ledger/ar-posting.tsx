"use client";

import * as React from "react";
import { api, ApiError, useLedgerQuery } from "./use-ledger";
import { toWireMinor } from "./ap-coding";
import { fmtMinor, parseAmount, toInput } from "@/lib/ledger/format";
import type { Invoice } from "@/lib/domain/types";

/**
 * The sales ledger, reached from the screens that raise the documents.
 *
 * `postInvoice` and `postReceipt` have been complete and tested since the
 * subledger was written, and nothing in the browser called either of them: the
 * daily loop an accounting product exists for — raise an invoice, put it on the
 * books, receive against it — was reachable only through the API, so the
 * ageing, the statements, the VAT return, credit control and the trial balance
 * were all being fed by nothing. This module is the single place the screens
 * use to reach POST /api/ledger/ar/post, together with the one read that
 * answers the question each of those screens has to ask first: has this invoice
 * reached the books already?
 *
 * There is deliberately no second way in. post() refuses a control account on
 * `source: "manual"`, so a manual journal cannot stand in for a document, and
 * everything here goes through the same route with the same guards.
 */

/** The receivables control account every sales posting moves. */
export const AR_CONTROL = "1100";

/** What either posting answers with. */
export interface PostedEntry {
  entryId: string;
  /** The journal reference, e.g. SI-42 — what a person quotes and looks up. */
  reference: string;
  /**
   * True when the entry was already there. Both postings are idempotent — an
   * invoice on its own id, a receipt on the payment id below — so a second
   * press finds the first entry instead of doubling the revenue. A screen that
   * reported that as "posted" would be claiming it had just done something it
   * did not do, which is why every caller here branches on it.
   */
  alreadyPosted: boolean;
}

/**
 * Whether this document belongs in the sales ledger at all, and why not.
 *
 * The route refuses a draft by name and `postInvoice` refuses anything that is
 * not an outbound document; the other two are refusals only a screen can make,
 * because the ledger has no opinion about a proforma or a cancelled draft and
 * would happily recognise revenue for either. Returning the sentence rather
 * than a boolean is what lets a screen say why the action is not on offer
 * instead of silently omitting it.
 */
export function whyNotPostable(inv: Invoice): string | null {
  if (inv.direction !== "OUTBOUND") {
    return "Only a sales invoice posts through the receivables subledger.";
  }
  if (inv.docType === "PROFORMA") {
    return "A proforma is an offer rather than a tax document, so it makes no entry. Convert it to a tax invoice first.";
  }
  if (inv.lifecycleStatus === "DRAFT") {
    return "A draft can still change, and revenue recognised from something that can still change has to be un-recognised. Finalise it first.";
  }
  if (inv.lifecycleStatus === "CANCELLED") {
    return "A cancelled document never became a sale, so there is nothing to put on the books.";
  }
  return null;
}

/** The shorthand every list needs beside `whyNotPostable`. */
export function isPostable(inv: Invoice): boolean {
  return whyNotPostable(inv) === null;
}

/**
 * Put an invoice or credit note on the books.
 *
 * The invoice is named by id and nothing else: the route reads the document
 * from the store rather than taking amounts from the request, because a client
 * that could hand over the figures could book revenue that appeared on no
 * document.
 */
export async function postInvoiceToLedger(invoiceId: string): Promise<PostedEntry> {
  return api<PostedEntry>("/api/ledger/ar/post", {
    method: "POST",
    body: JSON.stringify({ kind: "invoice", invoiceId }),
  });
}

export interface ReceiptToPost {
  invoiceId: string;
  /** The day the money landed, yyyy-mm-dd. It dates the journal entry. */
  receivedOn: string;
  /** What actually arrived, in the book's functional currency. */
  bankAmountMinor: bigint;
  /**
   * What comes off the invoice, where that is not the same as what arrived.
   * Omitted, the whole amount banked clears the invoice.
   */
  clearedAmountMinor?: bigint;
  /** The account the money landed in. The ledger defaults to 1010. */
  bankAccount?: string;
}

/**
 * The id this receipt is idempotent on.
 *
 * `postCustomerReceipt` keys on `receipt:<paymentId>`, and the browser holds no
 * Payment row id — /api/invoices/:id/mark-paid creates one and does not answer
 * with it. A fresh random id per attempt would mean a double-click, or a retry
 * after a dropped response, posts the same money twice; a key derived from what
 * the receipt IS means the second attempt finds the first entry and the screen
 * says so.
 *
 * The cost is real and is stated wherever it bites: a genuine second receipt
 * for the same invoice, on the same day, for the same amount cannot be posted
 * as a separate entry. That is rare, it is recoverable by dating or splitting
 * the second one, and it is a far better failure than silently doubling a
 * customer's payment.
 */
export function receiptPaymentId(r: {
  invoiceId: string;
  receivedOn: string;
  bankAmountMinor: bigint;
}): string {
  return `${r.invoiceId}:${r.receivedOn}:${r.bankAmountMinor.toString()}`;
}

/**
 * Post one customer receipt against one invoice.
 *
 * The amounts cross the wire as JSON numbers because that is what this route
 * takes, and they go through `toWireMinor` — the same boundary the payables
 * panels use — so an amount too large for a double is refused here rather than
 * posted a fils out. Nothing else in this module lets a Number near a
 * minor-unit value; this one conversion is the wire format itself.
 */
export async function postReceiptToLedger(r: ReceiptToPost): Promise<PostedEntry> {
  const bankAmountMinor = toWireMinor(r.bankAmountMinor);
  const clearedAmountMinor =
    r.clearedAmountMinor === undefined ? undefined : toWireMinor(r.clearedAmountMinor);
  if (bankAmountMinor === null || clearedAmountMinor === null) {
    throw new ApiError("That amount is too large to send without losing fils.", 400);
  }
  return api<PostedEntry>("/api/ledger/ar/post", {
    method: "POST",
    body: JSON.stringify({
      kind: "receipt",
      invoiceId: r.invoiceId,
      paymentId: receiptPaymentId(r),
      receivedOn: r.receivedOn,
      bankAmountMinor,
      // Sent only where it was given: left out, the invoice is carried off at
      // exactly what arrived, which is the right answer for every receipt that
      // is not settling a balance raised at another day's rate.
      ...(clearedAmountMinor === undefined ? {} : { clearedAmountMinor }),
      ...(r.bankAccount ? { bankAccount: r.bankAccount } : {}),
    }),
  });
}

/**
 * What to show when a posting fails.
 *
 * Every refusal this route makes was written to be read by the person who hit
 * it — the permission the grant is missing, the period no accounting period
 * covers, the account that does not exist, the document that does not add up —
 * so the server's own sentence is shown as it stands. Only a failure that
 * carried no sentence at all gets one from here, and it says the one thing the
 * user needs to know about it: nothing was written.
 */
export function ledgerProblem(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return "The ledger could not be reached, so nothing was posted. Try again in a moment.";
}

/** One document's entry in the sales ledger. */
export interface InvoicePosting {
  entryId: string;
  reference: string;
  /**
   * The entry was posted and later reversed. It still stands — nothing is ever
   * un-posted — but the invoice is no longer in the books at its own value, and
   * a screen that said only "on the books as SI-12" would be hiding that.
   */
  reversed: boolean;
}

export interface SalesLedgerIndex {
  /** Invoice id → the entry that put it on the books. */
  postings: Map<string, InvoicePosting>;
  /**
   * True when the read reached every movement in its window. When it is false
   * the movements left out are the OLDEST — the read takes the newest end — so
   * a document missing from `postings` is unknown rather than unposted, and a
   * screen has to say "unknown" rather than guess.
   */
  complete: boolean;
  /** Movements read, and movements there are, in the window asked for. */
  read: number;
  movements: number;
}

interface GeneralLedgerLine {
  entryId: string;
  reference: string;
  source: string;
  sourceId: string | null;
  status: string;
}

interface GeneralLedgerPage {
  lineCount: number;
  listed: number;
  truncated: boolean;
  lines: GeneralLedgerLine[];
}

/**
 * Which documents have reached the books, read from the control account itself.
 *
 * The alternative would be a flag on the invoice, and a flag is a second copy
 * of a fact the ledger already holds: it can be written when the posting fails,
 * missed when the posting succeeds, and it survives a reversal that the books
 * do not. Account 1100 is where a sales posting lands, so asking 1100 is asking
 * the only authority there is.
 *
 * `range` narrows the read, and every caller should give one it can justify —
 * an invoice screen asks about the day its own document was raised, a list asks
 * from the oldest invoice it is showing. The general-ledger read is capped, so
 * a window that is too wide comes back `truncated` and the answer for the
 * oldest documents in it becomes "unknown", which is honest but is not useful.
 */
export function useSalesLedger(
  entityId: string | undefined,
  /* Named `range` rather than `window`, which inside a component would shadow
   * the global of that name for every line below it. */
  range?: { from?: string; to?: string; limit?: number },
): { index: SalesLedgerIndex | null; error: string | null; loading: boolean; reload: () => void } {
  const query = new URLSearchParams();
  if (entityId) query.set("entityId", entityId);
  if (range?.from) query.set("from", range.from);
  if (range?.to) query.set("to", range.to);
  query.set("limit", String(range?.limit ?? 1000));

  const { data, error, loading, reload } = useLedgerQuery<GeneralLedgerPage>(
    entityId ? `/api/ledger/accounts/${AR_CONTROL}?${query.toString()}` : null,
  );

  const index = React.useMemo<SalesLedgerIndex | null>(() => {
    if (!data) return null;
    const postings = new Map<string, InvoicePosting>();
    for (const line of data.lines) {
      /* Only the entries a document opened. A receipt moves 1100 too and names
       * the invoice it settles, and taking its reference as the invoice's would
       * show a customer's payment as the entry that raised the sale. */
      if (line.source !== "invoice" || !line.sourceId) continue;
      const seen = postings.get(line.sourceId);
      /* Lines arrive oldest first, so the first one for a document is the entry
       * that put it on the books. A reversal repeats the same sourceId with its
       * own reference, and it is the original that answers "which entry is this
       * invoice's" — the reversal is recorded on it as a state instead. */
      if (seen) {
        if (line.status === "reversed") seen.reversed = true;
        continue;
      }
      postings.set(line.sourceId, {
        entryId: line.entryId,
        reference: line.reference,
        reversed: line.status === "reversed",
      });
    }
    return {
      postings,
      complete: !data.truncated,
      read: data.listed,
      movements: data.lineCount,
    };
  }, [data]);

  return { index, error, loading, reload };
}

/** Where a journal reference links to — the register opens on that entry. */
export function journalHref(entryId: string): string {
  return `/accounting/journals?entry=${encodeURIComponent(entryId)}`;
}

/**
 * The currency the receipt arithmetic works in.
 *
 * A receipt is posted in the book's functional currency, whatever the invoice
 * was raised in, and this is what decides how many decimals an amount is parsed
 * and formatted with. The manual entry grid makes the same assumption for the
 * same reason: no read publishes `book.functionalCurrency` to the browser, and
 * every book this product opens is opened in dirhams.
 *
 * It is an assumption, so no screen prints it as a fact. The forms say "the
 * book's own currency" and the figures are rendered as bare numerals, which is
 * what the rest of the ledger does — and where an invoice is in another
 * currency the form says so and asks for what actually landed in the bank
 * rather than guessing at a rate.
 */
export const BOOK_CURRENCY = "AED";

export interface ReceiptDraft {
  receivedOn: string;
  setReceivedOn: (v: string) => void;
  /** What arrived, as typed. */
  banked: string;
  setBanked: (v: string) => void;
  /** What comes off the invoice, as typed. Blank means "the same". */
  cleared: string;
  setCleared: (v: string) => void;
  bankAccount: string;
  setBankAccount: (v: string) => void;
  bankedMinor: bigint | null;
  clearedMinor: bigint | null;
  /** Why this cannot be posted yet, in the words the user needs. */
  blocker: string | null;
  /** What posting it will do besides clearing the invoice. */
  consequences: string[];
  toPost: ReceiptToPost | null;
}

/**
 * The fields of a customer receipt, and what posting them will actually do.
 *
 * Two screens ask for a receipt in two different visual languages, and both ask
 * the same four questions, so the arithmetic and the warnings live here once.
 *
 * The consequences are the part that matters. `postReceipt` puts any difference
 * between what arrived and what was cleared into the realised exchange
 * accounts — 4950 or 6800 — whatever the reason for the difference was. That is
 * right for a rate that moved and it is not what a bookkeeper means by a
 * settlement discount, so the form says where the money is going in the words
 * of the chart of accounts rather than in the words of the intention. A short
 * payment needs no difference at all: clear what arrived and the item simply
 * stays open for the rest.
 */
export function useReceiptDraft(opts: {
  /** The day the form opens on — today, from the caller. */
  today: string;
  /** What to offer as the amount banked, where the caller knows it. */
  suggestMinor?: bigint | null;
  /** What the ledger still shows outstanding on the invoice, where known. */
  openMinor?: bigint | null;
  invoiceId: string;
}): ReceiptDraft {
  const [receivedOn, setReceivedOn] = React.useState(opts.today);
  /* Only the first render's suggestion. The form is mounted when it is opened,
   * so this is the amount the caller knew at that moment; anything later would
   * overwrite what the person is in the middle of typing. */
  const [banked, setBanked] = React.useState(() =>
    opts.suggestMinor && opts.suggestMinor > 0n ? toInput(opts.suggestMinor, BOOK_CURRENCY) : "",
  );
  const [cleared, setCleared] = React.useState("");
  const [bankAccount, setBankAccount] = React.useState("");

  const bankedMinor = parseAmount(banked, BOOK_CURRENCY);
  const clearedMinor = cleared.trim() === "" ? null : parseAmount(cleared, BOOK_CURRENCY);

  const blocker: string | null = (() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedOn)) return "Which day did the money land?";
    if (banked.trim() === "") return "How much arrived?";
    if (bankedMinor === null) return "The amount banked is not a number I can read.";
    if (bankedMinor <= 0n) return "A receipt has to be a positive amount.";
    if (cleared.trim() !== "" && clearedMinor === null) {
      return "The amount cleared is not a number I can read.";
    }
    if (clearedMinor !== null && clearedMinor <= 0n) {
      return "The amount cleared off the invoice has to be positive.";
    }
    if (toWireMinor(bankedMinor) === null || (clearedMinor !== null && toWireMinor(clearedMinor) === null)) {
      return "That amount is too large to send without losing fils.";
    }
    return null;
  })();

  const consequences: string[] = [];
  if (bankedMinor !== null && bankedMinor > 0n) {
    const applied = clearedMinor !== null && clearedMinor > 0n ? clearedMinor : bankedMinor;
    const difference = applied - bankedMinor;
    if (difference > 0n) {
      consequences.push(
        `${fmtMinor(difference, BOOK_CURRENCY, { zero: "zero" })} more comes off the invoice than arrived. ` +
          `The ledger books that difference as a realised exchange loss to 6800 — not as a discount or a write-off.`,
      );
    }
    if (difference < 0n) {
      consequences.push(
        `${fmtMinor(-difference, BOOK_CURRENCY, { zero: "zero" })} more arrived than comes off the invoice. ` +
          `The ledger books that difference as a realised exchange gain to 4950 — not as money on account.`,
      );
    }
    if (opts.openMinor !== undefined && opts.openMinor !== null) {
      const left = opts.openMinor - applied;
      if (left > 0n) {
        consequences.push(
          `The invoice stays open for ${fmtMinor(left, BOOK_CURRENCY, { zero: "zero" })} and keeps its own age in the ageing.`,
        );
      }
      if (left < 0n) {
        consequences.push(
          `That clears ${fmtMinor(-left, BOOK_CURRENCY, { zero: "zero" })} more than is outstanding, so the document ` +
            `stands in the ageing as an unapplied credit until somebody says what it pays.`,
        );
      }
    }
  }

  const toPost: ReceiptToPost | null =
    blocker !== null || bankedMinor === null
      ? null
      : {
          invoiceId: opts.invoiceId,
          receivedOn,
          bankAmountMinor: bankedMinor,
          ...(clearedMinor !== null ? { clearedAmountMinor: clearedMinor } : {}),
          ...(bankAccount ? { bankAccount } : {}),
        };

  return {
    receivedOn, setReceivedOn,
    banked, setBanked,
    cleared, setCleared,
    bankAccount, setBankAccount,
    bankedMinor, clearedMinor,
    blocker, consequences, toPost,
  };
}

/**
 * The day after a yyyy-mm-dd date.
 *
 * An invoice's entry is dated on the invoice, so a screen looking for one
 * document's posting only has to read that day. The window closes a day late
 * rather than exactly, because a document date that ever carries a time would
 * otherwise fall outside a window that ends at midnight — and the read is
 * filtered by document id anyway, so the extra day costs nothing.
 */
export function dayAfter(date: string): string {
  const next = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(next.getTime())) return date.slice(0, 10);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
