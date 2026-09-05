"use client";

import * as React from "react";
import { put } from "@/lib/db/database";
import { addEvent, makeDraft, recalc } from "@/lib/db/repo";
import { computeTotals, recomputeLines, TAX_PROFILES } from "@/lib/domain/tax";
import { CURRENCIES } from "@/lib/domain/peppol";
import { fmtMinor, parseAmount } from "@/lib/ledger/format";
import { id as makeId, todayISO, addDays } from "@/lib/utils";
import { Figure, Panel } from "./primitives";
import { Field, postingArithmetic, toWireMinor } from "./ap-coding";
import type { Entity, Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

/**
 * Entering a bill the business has received.
 *
 * A purchase invoice is the same document as a sales invoice seen from the
 * other end, so it is stored as one: an `Invoice` with `direction: "INBOUND"`,
 * our own entity in `buyer` and the supplier in `seller`. That is what
 * `postBill` reads, and it is why nothing new had to be invented to hold it.
 *
 * What this panel does NOT do is post. A document that has been received is
 * not yet a cost anybody has agreed to; coding it is a separate decision, made
 * in the panel next door, and keeping the two apart is what lets the screen
 * say honestly which bills have reached the ledger and which have only been
 * typed in.
 */

/**
 * The treatments a purchase line can carry.
 *
 * Two of the eight are deliberately absent. A zero-rated export is a statement
 * about a supply LEAVING the country, which is the seller's treatment of it and
 * never the buyer's — a UAE business receiving goods from abroad is importing,
 * not exporting. The profit-margin scheme is the seller's too: the document
 * states no tax (Executive Regulation Article 43), the buyer recovers none, and
 * offering the code here would ask a buyer for the seller's own purchase price
 * in order to compute a margin the buyer never made.
 *
 * An import of goods, which a bill genuinely can carry, is missing for a
 * different reason and is not one this screen can fix: `IMPORT_GOODS` is a
 * `PurchaseTaxProfileCode`, and `InvoiceLine.taxProfileCode` is typed to the
 * document codes alone. Recording one under a code that means something else
 * would be worse than not offering it.
 */
const PURCHASE_TREATMENTS: TaxProfileCode[] = [
  "STANDARD_5",
  "ZERO_OTHER",
  "EXEMPT",
  "OUT_OF_SCOPE",
  "REVERSE_CHARGE",
  "DESIGNATED_ZONE",
];

interface DraftLine {
  key: number;
  description: string;
  qty: string;
  price: string;
  treatment: TaxProfileCode;
}

let nextKey = 1;
const blankLine = (): DraftLine => ({
  key: nextKey++,
  description: "",
  qty: "1",
  price: "",
  treatment: "STANDARD_5",
});

/** A quantity as typed. Null where it is not a positive number. */
function parseQty(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,4})?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function BillEntry({
  entity,
  onSaved,
  onCancel,
}: {
  entity: Entity;
  onSaved: (bill: Invoice) => void;
  onCancel: () => void;
}) {
  const [supplier, setSupplier] = React.useState("");
  const [supplierTrn, setSupplierTrn] = React.useState("");
  const [number, setNumber] = React.useState("");
  const [credit, setCredit] = React.useState(false);
  const [issueDate, setIssueDate] = React.useState(todayISO);
  const [dueDate, setDueDate] = React.useState(() => addDays(todayISO(), 30));
  const [currency, setCurrency] = React.useState(entity.defaultCurrency || "AED");
  const [rateToAED, setRateToAED] = React.useState("");
  const [lines, setLines] = React.useState<DraftLine[]>(() => [blankLine()]);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const patch = (key: number, change: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...change } : l)));

  /* The document as the tax computation sees it, rebuilt on every keystroke.
   * The same two functions run again inside `recalc` when it is saved, so what
   * the panel shows and what is stored cannot be two different documents. */
  const parsed = lines.map((l) => ({
    line: l,
    qty: parseQty(l.qty),
    // An empty amount cell is not nought — it is a line nobody has finished.
    // `parseAmount` reads "" as 0, which would quietly store a line of nothing.
    price: l.price.trim() === "" ? null : parseAmount(l.price, currency),
  }));
  /* A row somebody has begun. A wholly empty one is a spare and is ignored;
   * a half-filled one is an omission and has to be said out loud. */
  const started = parsed.filter((p) => p.line.description.trim() !== "" || p.line.price.trim() !== "");
  const usable = started.filter((p) => p.qty !== null && p.price !== null && p.line.description.trim() !== "");
  const invoiceLines: InvoiceLine[] = recomputeLines(
    usable.map((p, i) => ({
      id: makeId("ln"),
      lineNo: i + 1,
      description: p.line.description.trim(),
      qty: p.qty as number,
      unitCode: "C62",
      // Every amount on this screen is parsed as minor units in BigInt and
      // becomes a JavaScript number only here, at the edge of the document
      // store, which carries them as JSON numbers. `blocker` refuses anything
      // that will not survive the conversion, so this cast cannot lose fils.
      unitPriceMinor: Number(p.price as bigint),
      taxProfileCode: p.line.treatment,
      lineNetMinor: 0,
      lineVatMinor: 0,
    })),
  );
  const totals = computeTotals(invoiceLines);
  const anyReverseCharge = invoiceLines.some((l) => l.taxProfileCode === "REVERSE_CHARGE");

  const badLine = started.find(
    (p) => p.qty === null || p.price === null || p.line.description.trim() === "",
  );
  /* Both ends of the arithmetic. The typed price is checked because it crosses
   * the wire as a JSON number; the computed net and VAT are checked because
   * `computeLine` multiplies by the quantity in floating point, and past
   * 2^53 minor units that multiplication starts losing whole fils. */
  const oversized =
    parsed.some((p) => p.price !== null && toWireMinor(p.price) === null) ||
    invoiceLines.some((l) => !Number.isSafeInteger(l.lineNetMinor) || !Number.isSafeInteger(l.lineVatMinor));
  const rate = rateToAED.trim() === "" ? null : Number(rateToAED);

  const blocker =
    !supplier.trim() ? "Who sent the bill?" :
    !number.trim() ? "What number does the supplier's document carry? It is what stops the same bill being entered twice." :
    !issueDate ? "When was it issued?" :
    !dueDate ? "When does it fall due? The payables ageing is cut on this date." :
    // `post()` refuses an entry whose due date precedes its date, so a bill
    // saved this way could never be posted. Caught here, where the two dates
    // are on screen together and the fix is obvious.
    dueDate < issueDate ? "A bill cannot fall due before it was issued — check which way round the dates went in." :
    badLine ? `Line ${lines.indexOf(badLine.line) + 1} needs a description, a quantity and an amount.` :
    oversized ? "That is more money than this ledger can count in whole fils. Check the amount." :
    usable.length === 0 ? "Add at least one line — a description and an amount." :
    currency !== "AED" && (rate === null || !Number.isFinite(rate) || rate <= 0)
      ? `A ${currency} bill needs its rate to AED before it can be posted.` :
    null;

  /* What `postBill` will check, checked here first. It is a warning rather than
   * a blocker: the document is a true record of what the supplier sent, and
   * refusing to store it would not make the arithmetic agree. See
   * `postingArithmetic` for why the two figures can differ at all. */
  const arithmetic =
    usable.length > 0
      ? postingArithmetic({ lines: invoiceLines, totals })
      : { linesMinor: 0n, payableMinor: 0n, driftMinor: 0n };

  const save = async () => {
    if (blocker) return;
    setSaving(true);
    setError(null);
    try {
      /* `makeDraft` builds a document for this entity with the ids, the
       * timestamps and the sending state a record needs. On a purchase every
       * party is the other way round: the entity it filled in as the seller is
       * the buyer here, and the seller is whoever sent the bill. */
      const draft = makeDraft(entity);
      const bill = recalc({
        ...draft,
        id: makeId("bill"),
        direction: "INBOUND",
        docType: credit ? "TAX_CREDIT_NOTE" : "TAX_INVOICE",
        number: number.trim(),
        issueDate,
        supplyDate: issueDate,
        dueDate,
        currency,
        fx:
          currency === "AED"
            ? undefined
            // The rate as it was typed rather than as JavaScript would print it
            // back: `postBill` reads this string, and a rate is a decimal the
            // person entering it copied off a source they can be asked about.
            : { rateToAED: rateToAED.trim(), source: "MANUAL", rateDate: issueDate },
        buyer: draft.seller,
        seller: { nameEn: supplier.trim(), ...(supplierTrn.trim() ? { trn: supplierTrn.trim() } : {}) },
        lines: invoiceLines,
      });
      await put("invoices", bill);
      await addEvent(
        bill.id,
        "received",
        `${credit ? "Supplier credit" : "Bill"} ${bill.number} from ${bill.seller.nameEn} recorded. Not in the ledger until it is coded and posted.`,
        "user",
        "neutral",
      );
      onSaved(bill);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The bill could not be saved.");
      setSaving(false);
    }
  };

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">A bill the business has received</div>
      <p className="sw-sub mt-1 max-w-[76ch]">
        Recorded as the supplier sent it. Nothing is posted here — the entry that debits the cost and credits
        payables is made once the lines have been coded, in the step below.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Supplier">
          <input
            className="sw-input"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            placeholder="Gulf Steel LLC"
          />
        </Field>
        <Field label="Supplier TRN">
          <input
            className="sw-input"
            value={supplierTrn}
            onChange={(e) => setSupplierTrn(e.target.value)}
            placeholder="100000000000003"
          />
        </Field>
        <Field label="Their document number">
          <input
            className="sw-input"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="INV-4471"
          />
        </Field>
        <Field label="Document">
          <select
            className="sw-select"
            value={credit ? "credit" : "bill"}
            onChange={(e) => setCredit(e.target.value === "credit")}
          >
            <option value="bill">Bill</option>
            <option value="credit">Credit note</option>
          </select>
        </Field>
        <Field label="Issued">
          <input type="date" className="sw-input" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
        </Field>
        <Field label="Due" hint="What the ageing measures lateness against.">
          <input type="date" className="sw-input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </Field>
        <Field label="Currency">
          <select className="sw-select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        {currency !== "AED" && (
          <Field label="Rate to AED" hint="The ledger keeps the books in dirhams and will not post without it.">
            <input
              className="sw-input sw-cell-num"
              inputMode="decimal"
              value={rateToAED}
              onChange={(e) => setRateToAED(e.target.value)}
              placeholder="3.6725"
            />
          </Field>
        )}
      </div>

      <div className="sw-scroll mt-3">
        <table className="sw-table sw-grid">
          <caption className="sr-only">The lines of the supplier&rsquo;s document</caption>
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>#</th>
              <th style={{ minWidth: "14rem" }}>Description</th>
              <th className="sw-num" style={{ width: "5rem" }}>Qty</th>
              <th className="sw-num" style={{ width: "9rem" }}>Unit price</th>
              <th style={{ width: "12rem" }}>VAT treatment</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
              <th className="sw-num" style={{ width: "7rem" }}>VAT</th>
              <th style={{ width: "3rem" }}><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const p = parsed[i];
              const computed = invoiceLines[usable.findIndex((u) => u.line.key === l.key)];
              // An empty cell is unfinished, not wrong. The rail belongs on
              // text that was typed and cannot be read as an amount.
              const priceUnreadable = l.price.trim() !== "" && p.price === null;
              return (
                <tr key={l.key}>
                  <td className="sw-code" style={{ paddingInline: "0.5rem" }}>{i + 1}</td>
                  <td>
                    <input
                      className="sw-cell"
                      aria-label={`Line ${i + 1} description`}
                      value={l.description}
                      onChange={(e) => patch(l.key, { description: e.target.value })}
                      placeholder="Steel bar 12mm"
                    />
                  </td>
                  <td>
                    <input
                      className={`sw-cell sw-cell-num ${p.qty === null && l.qty.trim() !== "" ? "sw-cell-invalid" : ""}`}
                      aria-label={`Line ${i + 1} quantity`}
                      aria-invalid={p.qty === null && l.qty.trim() !== "" ? true : undefined}
                      inputMode="decimal"
                      value={l.qty}
                      onChange={(e) => patch(l.key, { qty: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className={`sw-cell sw-cell-num ${priceUnreadable ? "sw-cell-invalid" : ""}`}
                      aria-label={`Line ${i + 1} unit price, excluding VAT`}
                      aria-invalid={priceUnreadable || undefined}
                      inputMode="decimal"
                      value={l.price}
                      onChange={(e) => patch(l.key, { price: e.target.value })}
                      placeholder="0.00"
                    />
                  </td>
                  <td>
                    <select
                      className="sw-cell"
                      aria-label={`Line ${i + 1} VAT treatment`}
                      value={l.treatment}
                      onChange={(e) => patch(l.key, { treatment: e.target.value as TaxProfileCode })}
                    >
                      {PURCHASE_TREATMENTS.map((code) => (
                        <option key={code} value={code}>{TAX_PROFILES[code].label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="sw-num" style={{ paddingInline: "0.625rem" }}>
                    <Figure minor={computed?.lineNetMinor ?? 0} currency={currency} colour={false} />
                  </td>
                  <td className="sw-num" style={{ paddingInline: "0.625rem" }}>
                    <Figure minor={computed?.lineVatMinor ?? 0} currency={currency} colour={false} />
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <button
                      type="button"
                      className="sw-icon-btn"
                      aria-label={`Remove line ${i + 1}`}
                      // The last line is emptied rather than removed, as the
                      // journal grid does: a table with no rows at all is a
                      // control somebody has to work out how to restart.
                      onClick={() =>
                        setLines((ls) =>
                          ls.length > 1
                            ? ls.filter((x) => x.key !== l.key)
                            : ls.map((x) => (x.key === l.key ? blankLine() : x)),
                        )
                      }
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={5} style={{ textAlign: "end" }}>Net, VAT and total</th>
              <td className="sw-num"><Figure minor={totals.taxExclusiveMinor} currency={currency} colour={false} /></td>
              <td className="sw-num"><Figure minor={totals.vatMinor} currency={currency} colour={false} /></td>
              <td />
            </tr>
            <tr>
              <th scope="row" colSpan={5} style={{ textAlign: "end" }}>Payable to the supplier</th>
              <td className="sw-num" colSpan={2} data-testid="bill-payable">
                <Figure minor={totals.payableMinor} currency={currency} zero="zero" colour={false} />
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="sw-btn sw-btn-sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>
          Add a line
        </button>
        {anyReverseCharge && (
          <span className="sw-sub">
            A reverse-charge line carries no VAT from the supplier. The ledger will account for both sides of it
            when the bill is posted, so it reaches both boxes of the return without any money crossing.
          </span>
        )}
      </div>

      {arithmetic.driftMinor !== 0n && (
        <p className="sw-note mt-3 max-w-[80ch]">
          These lines add up to {fmtMinor(arithmetic.linesMinor, currency)} line by line, and the document&rsquo;s own
          total is {fmtMinor(arithmetic.payableMinor, currency)}. VAT is rounded once per rate on a document and once
          per line by the posting check, so the two differ by {fmtMinor(arithmetic.driftMinor, currency, { sign: "minus" })} and
          the ledger will refuse this bill until the lines sharing a rate are put on one line. It can still be saved:
          it is a true record of what the supplier sent.
        </p>
      )}

      {error && <div className="sw-error mt-3" role="alert">{error}</div>}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || saving}
          aria-disabled={blocker !== null || saving || undefined}
          data-testid="bill-save"
          onClick={save}
        >
          {saving ? "Saving…" : "Save the bill"}
        </button>
        <button type="button" className="sw-btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {blocker
          ? <span className="sw-sub" role="status" data-testid="bill-blocker">{blocker}</span>
          : <span className="sw-sub">Saved as a received document. Coding it is the next step.</span>}
      </div>
    </Panel>
  );
}
