"use client";

import * as React from "react";
import { Figure } from "./primitives";
import { parseAmount, toInput } from "@/lib/ledger/format";
import { TAX_PROFILE_LIST } from "@/lib/domain/tax";

/**
 * Correcting a quotation or a sales order.
 *
 * Until this existed the only way to fix a transposed digit was to cancel the
 * document and key it again under a new number — which is not a correction. It
 * leaves the customer holding SQ-00012 while the business works from SQ-00013,
 * and it burns a number out of a gapless sequence for a typo.
 *
 * `updateOrder` in sales-orders.ts already allowed the change and drew the line
 * in exactly the right place, so this screen's whole job is to draw the same
 * line where a person can see it:
 *
 *   draft, sent            — freely. The customer has an offer, not an
 *                            agreement, and correcting an offer is not a
 *                            variation of anything.
 *   accepted, part_invoiced — a variation, and a real one: the customer may
 *                            change what they asked for. But no line may be
 *                            cut below what has already been invoiced, because
 *                            that figure is a tax invoice somebody is holding.
 *   invoiced, declined,
 *   expired, cancelled     — not at all. The whole value of a finished or
 *                            refused document is that it still says what it
 *                            said.
 *
 * Every rule here is also enforced by the subledger, and the subledger is the
 * authority: this refuses early so the reader is told which line is wrong and
 * why before a round trip, not so the server can stop checking.
 *
 * One thing this editor deliberately does not claim to protect is a delivery.
 * `updateOrder` compares a new quantity against `invoicedMilli` only, so a line
 * can still be cut below what has already left the warehouse on a delivery
 * note; the note would then quote a quantity its order no longer carries.
 * Saying so in the interface would need the delivered quantity, which the order
 * detail does not carry, and a reassurance drawn from nothing is worse than
 * silence.
 */

/* ------------------------------------------------------------------ numbers */

/**
 * Quantities are thousandths. "1.5" is 1500, and a float would lose the edges.
 *
 * The read-only view and the editor both read these from here rather than
 * keeping a copy each: two parsers that disagree about what "1.5" means would
 * disagree in the one place it matters, which is between what a person typed
 * and what the document then says.
 */
export function toMilli(text: string): bigint | null {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * 1000n + BigInt(frac.padEnd(3, "0"));
}

/** Thousandths back out as a human reads them. */
export function fromMilli(milli: string | bigint): string {
  const m = BigInt(milli);
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const frac = (abs % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / 1000n}${frac ? "." + frac : ""}`;
}

/** A discount as it is typed — "12.5" percent — into the basis points stored. */
export function toBps(text: string): number | null {
  const t = text.trim();
  if (!t) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export const pct = (b: number) => `${(b / 100).toFixed(b % 100 === 0 ? 0 : 2)}%`;

const MILLI = 1000n;
const BPS = 10_000n;

/**
 * What a line comes to, as typed — a mirror of `lineNet` in sales-orders.ts,
 * rounded once and half-up at the minor unit for the same reason: discounting a
 * rounded extension and rounding again drifts by a fil a line, and on a
 * hundred-line quote that difference is what the customer queries.
 *
 * The server's figure is the one the document carries. This one exists so the
 * person typing can see what they are about to agree to.
 */
function lineNetMinor(unitPriceMinor: bigint, quantityMilli: bigint, discountBps: number): bigint {
  const numerator = unitPriceMinor * quantityMilli * (BPS - BigInt(discountBps));
  const denominator = MILLI * BPS;
  return (numerator + denominator / 2n) / denominator;
}

/* -------------------------------------------------------------------- wire */

/** Only what the editor reads. The detail carries more; it does not need it. */
export interface EditableLine {
  id: string;
  lineNo: number;
  description: string;
  sku: string | null;
  accountCode: string | null;
  quantityMilli: string;
  unitPriceMinor: string;
  discountBps: number;
  taxCode: string;
  invoicedMilli: string;
}

export interface EditableOrder {
  id: string;
  number: string;
  kind: "QUOTE" | "ORDER";
  status: string;
  currency: string;
  customerName: string;
  customerCode: string | null;
  customerTrn: string | null;
  issuedOn: string;
  validUntil: string | null;
  notes: string | null;
  lines: EditableLine[];
}

/** The four states `updateOrder` accepts a change in. */
export const EDITABLE = ["draft", "sent", "accepted", "part_invoiced"];

/**
 * Why a document cannot be changed, in the words the subledger would refuse it
 * with. A control that simply disappears teaches nobody the rule; one that says
 * "the customer said no, so re-quote instead" teaches it once.
 */
const CLOSED: Record<string, string> = {
  invoiced: "every line has been invoiced in full, so there is nothing left to agree",
  declined: "the customer said no — re-quote rather than reopening what they turned down",
  expired: "a quotation past its validity is re-quoted, not revived",
  cancelled: "it was withdrawn",
};

export function whyNotEditable(order: { number: string; status: string }): string | null {
  if (EDITABLE.includes(order.status)) return null;
  return `${order.number} cannot be changed: ${CLOSED[order.status] ?? "it is finished"}.`;
}

/* ------------------------------------------------------------------ editing */

interface DraftLine {
  /** Absent on a line being added — the subledger gives it its number. */
  id?: string;
  lineNo: number | null;
  description: string;
  sku: string;
  qty: string;
  price: string;
  discount: string;
  taxCode: string;
  account: string;
  /** What has already been billed on this line. A floor, not a suggestion. */
  invoicedMilli: string;
}

const toDraft = (l: EditableLine, currency: string): DraftLine => ({
  id: l.id,
  lineNo: l.lineNo,
  description: l.description,
  sku: l.sku ?? "",
  qty: fromMilli(l.quantityMilli),
  // `toInput` writes the decimal at the currency's own exponent — the three
  // places of a dinar are not a rounding of the two of a dirham — and
  // `parseAmount` reads it back at the same one.
  price: toInput(l.unitPriceMinor, currency),
  discount: l.discountBps === 0 ? "" : (l.discountBps / 100).toString(),
  taxCode: l.taxCode,
  account: l.accountCode ?? "",
  invoicedMilli: l.invoicedMilli,
});

const emptyLine = (): DraftLine => ({
  lineNo: null,
  description: "",
  sku: "",
  qty: "",
  price: "",
  discount: "",
  taxCode: "STANDARD_5",
  account: "",
  invoicedMilli: "0",
});

export function OrderEditor({ order, busy, onCancel, onSave }: {
  order: EditableOrder;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const [head, setHead] = React.useState({
    customerName: order.customerName,
    customerCode: order.customerCode ?? "",
    customerTrn: order.customerTrn ?? "",
    issuedOn: order.issuedOn,
    validUntil: order.validUntil ?? "",
    notes: order.notes ?? "",
  });
  const [lines, setLines] = React.useState<DraftLine[]>(() => order.lines.map((l) => toDraft(l, order.currency)));

  const setField = (k: keyof typeof head, v: string) => setHead((h) => ({ ...h, [k]: v }));
  const setLine = (i: number, k: keyof DraftLine, v: string) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  /** Every line, parsed, with whatever is wrong with it named. */
  const parsed = lines.map((l) => {
    const qty = toMilli(l.qty);
    const price = parseAmount(l.price, order.currency);
    const discount = toBps(l.discount);
    const invoiced = BigInt(l.invoicedMilli);
    const fault =
      !l.description.trim() ? "needs a description — a customer cannot agree to a line nobody can read"
      : qty === null || qty <= 0n ? "needs a quantity, to three decimal places at most"
      : qty < invoiced ? `has been invoiced for ${fromMilli(invoiced)}, so it cannot be cut to ${fromMilli(qty)}`
      : price === null || price < 0n ? "needs a unit price"
      : discount === null || discount > 10_000 ? "is discounted by more than the whole of the line"
      : null;
    return { line: l, qty, price, discount, invoiced, fault };
  });

  const netMinor = parsed.reduce(
    (a, r) => a + (r.fault === null ? lineNetMinor(r.price as bigint, r.qty as bigint, r.discount as number) : 0n),
    0n,
  );

  const firstFault = parsed.findIndex((r) => r.fault !== null);
  const blocker =
    !head.customerName.trim() ? `${order.number} still needs a customer. Taking the name off it would leave an offer made to nobody.`
    : lines.length === 0 ? `${order.number} would have nothing on it. A document with no lines offers the customer nothing.`
    : head.validUntil && head.validUntil < head.issuedOn ? "It cannot stop being valid before it is issued."
    : firstFault >= 0 ? `Line ${lines[firstFault].lineNo ?? firstFault + 1} ${parsed[firstFault].fault}.`
    : null;

  const submit = () => {
    if (blocker) return;
    onSave({
      customerName: head.customerName.trim(),
      customerCode: head.customerCode.trim() || null,
      customerTrn: head.customerTrn.trim() || null,
      issuedOn: head.issuedOn,
      validUntil: head.validUntil || null,
      notes: head.notes.trim() || null,
      // The whole set, because that is what the patch means: a line left out of
      // it is a line taken off the order.
      lines: parsed.map((r) => ({
        id: r.line.id,
        description: r.line.description.trim(),
        sku: r.line.sku.trim() || undefined,
        quantityMilli: (r.qty as bigint).toString(),
        unitPriceMinor: (r.price as bigint).toString(),
        discountBps: r.discount as number,
        taxCode: r.line.taxCode,
        accountCode: r.line.account.trim() || undefined,
      })),
    });
  };

  const varied = order.status === "accepted" || order.status === "part_invoiced";

  return (
    <>
      <div className="sw-label">
        Changing {order.number}
      </div>
      <p className="sw-sub mt-1 max-w-[80ch]">
        {varied ? (
          <>
            {order.number} has been agreed, so this is a variation rather than a correction, and it is recorded on the
            document the customer will be held to. A line already invoiced cannot be taken off and cannot be cut below
            what was billed &mdash; that figure is a tax invoice somebody is holding, and an order that disagreed with
            it would be billing for goods it says were never ordered.
          </>
        ) : (
          <>
            Nothing has been agreed yet, so this is a correction and it costs nothing. The document keeps its number:
            cancelling and re-keying would leave the customer quoting {order.number} while the business works from the
            next one.
          </>
        )}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Customer">
          <input
            className="sw-input"
            value={head.customerName}
            onChange={(e) => setField("customerName", e.target.value)}
            data-testid="edit-customer"
          />
        </Field>
        <Field label="Customer code">
          <input className="sw-input" value={head.customerCode} onChange={(e) => setField("customerCode", e.target.value)} />
        </Field>
        <Field label="Customer TRN">
          <input className="sw-input sw-code" value={head.customerTrn} onChange={(e) => setField("customerTrn", e.target.value)} />
        </Field>
        <Field label="Issued on">
          <input type="date" className="sw-input" value={head.issuedOn} onChange={(e) => setField("issuedOn", e.target.value)} />
        </Field>
        <Field label="Valid until">
          <input type="date" className="sw-input" value={head.validUntil} onChange={(e) => setField("validUntil", e.target.value)} />
        </Field>
        <Field label="Notes">
          <input className="sw-input" value={head.notes} onChange={(e) => setField("notes", e.target.value)} placeholder="optional" />
        </Field>
      </div>

      <div className="sw-scroll mt-3">
        <table className="sw-table sw-grid">
          <caption className="sr-only">The lines of {order.number}, as they are being changed</caption>
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>#</th>
              <th style={{ minWidth: "12rem" }}>Description</th>
              <th style={{ width: "7rem" }}>SKU</th>
              <th className="sw-num" style={{ width: "6rem" }}>Quantity</th>
              <th className="sw-num" style={{ width: "8rem" }}>Unit price</th>
              <th className="sw-num" style={{ width: "5.5rem" }}>Discount %</th>
              <th style={{ width: "9rem" }}>Tax</th>
              <th style={{ width: "6rem" }}>Account</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
              <th className="sw-num" style={{ width: "5.5rem" }}>Invoiced</th>
              <th style={{ width: "5rem" }}><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {parsed.map((r, i) => {
              const billed = r.invoiced > 0n;
              const cannotRemove = billed
                ? `Line ${r.line.lineNo} has been invoiced for ${fromMilli(r.invoiced)}, so it cannot be taken off the order. Credit the invoice first.`
                : undefined;
              return (
                <tr key={r.line.id ?? `new-${i}`} data-testid={`edit-line-${i}`}>
                  <td style={{ padding: "0 0.625rem" }}>
                    {r.line.lineNo ?? <span className="sw-chip">new</span>}
                  </td>
                  <td>
                    <input
                      className={`sw-cell ${!r.line.description.trim() ? "sw-cell-invalid" : ""}`}
                      value={r.line.description}
                      aria-label={`Description of line ${r.line.lineNo ?? i + 1}`}
                      aria-invalid={!r.line.description.trim() || undefined}
                      onChange={(e) => setLine(i, "description", e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className="sw-cell sw-code"
                      value={r.line.sku}
                      aria-label={`SKU of line ${r.line.lineNo ?? i + 1}`}
                      onChange={(e) => setLine(i, "sku", e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className={`sw-cell sw-cell-num ${r.qty === null || r.qty <= 0n || r.qty < r.invoiced ? "sw-cell-invalid" : ""}`}
                      inputMode="decimal"
                      value={r.line.qty}
                      aria-label={
                        `Quantity of line ${r.line.lineNo ?? i + 1}` +
                        (billed ? `, at least ${fromMilli(r.invoiced)} already invoiced` : "")
                      }
                      aria-invalid={r.qty === null || r.qty <= 0n || r.qty < r.invoiced || undefined}
                      onChange={(e) => setLine(i, "qty", e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className={`sw-cell sw-cell-num ${r.price === null || r.price < 0n ? "sw-cell-invalid" : ""}`}
                      inputMode="decimal"
                      value={r.line.price}
                      aria-label={`Unit price of line ${r.line.lineNo ?? i + 1}, in ${order.currency}`}
                      aria-invalid={r.price === null || r.price < 0n || undefined}
                      onChange={(e) => setLine(i, "price", e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className={`sw-cell sw-cell-num ${r.discount === null || r.discount > 10_000 ? "sw-cell-invalid" : ""}`}
                      inputMode="decimal"
                      value={r.line.discount}
                      aria-label={`Discount on line ${r.line.lineNo ?? i + 1}, per cent`}
                      aria-invalid={r.discount === null || r.discount > 10_000 || undefined}
                      onChange={(e) => setLine(i, "discount", e.target.value)}
                    />
                  </td>
                  <td>
                    <select
                      className="sw-cell"
                      value={r.line.taxCode}
                      aria-label={`Tax treatment of line ${r.line.lineNo ?? i + 1}`}
                      onChange={(e) => setLine(i, "taxCode", e.target.value)}
                    >
                      {TAX_PROFILE_LIST.map((p) => (
                        <option key={p.code} value={p.code}>{p.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="sw-cell sw-code"
                      value={r.line.account}
                      aria-label={`Revenue account of line ${r.line.lineNo ?? i + 1}`}
                      onChange={(e) => setLine(i, "account", e.target.value)}
                    />
                  </td>
                  <td className="sw-num" style={{ padding: "0 0.625rem" }}>
                    <Figure
                      minor={r.fault === null ? lineNetMinor(r.price as bigint, r.qty as bigint, r.discount as number) : 0n}
                      currency={order.currency}
                      colour={false}
                    />
                  </td>
                  <td className="sw-num" style={{ padding: "0 0.625rem" }}>
                    {billed ? fromMilli(r.invoiced) : <span className="sw-zero">–</span>}
                  </td>
                  <td style={{ padding: "0 0.625rem" }}>
                    <button
                      type="button"
                      className="sw-btn sw-btn-sm"
                      aria-disabled={cannotRemove ? true : undefined}
                      title={cannotRemove}
                      data-testid={`remove-line-${i}`}
                      onClick={() => {
                        if (cannotRemove) return;
                        setLines((ls) => ls.filter((_, j) => j !== i));
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={8} style={{ textAlign: "end" }}>Net of discount, as typed</th>
              <td className="sw-num" data-testid="edit-net">
                <Figure minor={netMinor} currency={order.currency} zero="zero" colour={false} />
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="save-order"
          onClick={submit}
        >
          {busy ? "Saving…" : "Save the change"}
        </button>
        <button type="button" className="sw-btn" onClick={onCancel} disabled={busy} data-testid="cancel-order-edit">
          Leave it as it is
        </button>
        <button
          type="button"
          className="sw-btn"
          disabled={busy}
          data-testid="add-line"
          onClick={() => setLines((ls) => [...ls, emptyLine()])}
        >
          Add a line
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="edit-blocker">{blocker}</span>}
        {!blocker && (
          <span className="sw-sub">
            The tax is recomputed from the treatment on each line when this is saved. Nothing is posted &mdash; a
            quotation and an order still reach the books only through the invoice.
          </span>
        )}
      </div>
    </>
  );
}

/**
 * A labelled control, the same six lines the sales-order screen draws.
 *
 * Not the one `ap-coding` exports, which is the same shape: importing it would
 * pull the bill-coding module — its account memory, its purchase tax defaults
 * and its account picker — into a bundle that quotes goods and never codes a
 * bill.
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
