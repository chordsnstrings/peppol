"use client";

import * as React from "react";
import { Figure } from "./primitives";
import { Field } from "./ap-coding";
import { parseAmount, toInput } from "@/lib/ledger/format";
import { todayISO } from "@/lib/utils";

/**
 * The receipts on an expense claim — the table and the form that adds to it.
 *
 * Two screens put the same receipt on a claim: the panel that drafts a new one,
 * and the claim detail, where a claim that came back from an approver is
 * corrected. They are the same act with the same rules — a description, an
 * account, net, VAT, and the TRN that decides whether the VAT can be reclaimed
 * at all — so they are one implementation. Two would drift, and the half that
 * drifted would be the one that only runs after a rejection.
 */

export interface DraftLine {
  spentOn: string;
  description: string;
  accountCode: string;
  netMinor: string;
  vatMinor: string;
  supplierTrn: string;
  vatRecoverable: boolean;
  receiptRef: string;
}

/** A line as either side has it: drafted in the browser, or saved with an id. */
export interface ClaimLineRow {
  id?: string;
  spentOn: string;
  description: string;
  accountCode: string;
  netMinor: string;
  vatMinor: string;
  supplierTrn: string | null;
  vatRecoverable: boolean;
  receiptRef: string | null;
}

/** The accounts an expense claim realistically lands in. */
export const CLAIM_ACCOUNTS: [string, string][] = [
  ["6400", "Travel and entertainment"],
  ["6900", "Other operating expenses"],
  ["6150", "Utilities"],
  ["6300", "Government fees and licences"],
  ["6450", "Repairs and maintenance"],
  ["6200", "Marketing and advertising"],
];

const emptyLine = () => ({
  // `todayISO()` and not `new Date().toISOString()`: the second is UTC, so
  // between midnight and 04:00 in the Gulf it offers yesterday — which can be
  // in the previous VAT quarter — as the day the money was spent.
  spentOn: todayISO(),
  description: "",
  accountCode: "6400",
  net: "",
  vat: "",
  supplierTrn: "",
  vatRecoverable: false,
  receiptRef: "",
});

/**
 * How a line's VAT was treated, in the words that say what it did to the books
 * rather than in the flag's own name.
 */
export function vatTreatment(line: { vatMinor: string; vatRecoverable: boolean; supplierTrn: string | null }): string {
  if (line.vatRecoverable) return `reclaimed · ${line.supplierTrn ?? ""}`;
  return BigInt(line.vatMinor) > 0n ? "added to the expense" : "none";
}

export function ClaimLinesTable({
  lines,
  currency = "AED",
  onRemove,
  removingIndex,
  onEdit,
  editingIndex,
  caption,
}: {
  lines: ClaimLineRow[];
  currency?: string;
  /** Omitted where the claim can no longer be changed, which takes the column away with it. */
  onRemove?: (index: number) => void;
  removingIndex?: number | null;
  /** Likewise. A drafted line that has no id yet cannot be corrected in place. */
  onEdit?: (index: number) => void;
  editingIndex?: number | null;
  caption: string;
}) {
  const actions = Boolean(onRemove || onEdit);
  const net = lines.reduce((a, l) => a + BigInt(l.netMinor), 0n);
  const vat = lines.reduce((a, l) => a + BigInt(l.vatMinor), 0n);

  return (
    <div className="sw-scroll">
      <table className="sw-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th style={{ width: "7rem" }}>Spent</th>
            <th>Description</th>
            <th style={{ width: "6rem" }}>Account</th>
            <th className="hidden md:table-cell" style={{ width: "7rem" }}>Receipt</th>
            <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
            <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>VAT</th>
            <th style={{ width: "11rem" }}>VAT treatment</th>
            {actions && (
              <th style={{ width: onEdit ? "9rem" : "5rem" }}>
                <span className="sr-only">Correct or remove this receipt</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id ?? `${l.description}-${i}`} data-testid="claim-line">
              <td>{l.spentOn}</td>
              <td className="max-w-0 truncate">{l.description}</td>
              <td className="sw-code">{l.accountCode}</td>
              <td className="hidden md:table-cell sw-sub">{l.receiptRef || "—"}</td>
              <td className="sw-num"><Figure minor={l.netMinor} currency={currency} colour={false} /></td>
              <td className="sw-num"><Figure minor={l.vatMinor} currency={currency} colour={false} /></td>
              <td className="sw-sub">{vatTreatment(l)}</td>
              {actions && (
                <td>
                  <div className="flex gap-1">
                    {onEdit && l.id && (
                      <button
                        type="button"
                        className="sw-btn sw-btn-sm"
                        aria-pressed={editingIndex === i}
                        data-testid="edit-claim-line"
                        onClick={() => onEdit(i)}
                      >
                        {editingIndex === i ? "Editing" : "Correct"}
                      </button>
                    )}
                    {onRemove && (
                      <button
                        type="button"
                        className="sw-btn sw-btn-sm"
                        disabled={removingIndex === i}
                        data-testid="remove-claim-line"
                        onClick={() => onRemove(i)}
                      >
                        {removingIndex === i ? "…" : "Remove"}
                      </button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={4} style={{ textAlign: "end" }}>
              {lines.length} receipt{lines.length === 1 ? "" : "s"}
            </th>
            <td className="sw-num"><Figure minor={net} currency={currency} zero="zero" colour={false} /></td>
            <td className="sw-num"><Figure minor={vat} currency={currency} zero="zero" colour={false} /></td>
            <td colSpan={actions ? 2 : 1} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * One receipt, and the rules said before the request rather than after it.
 *
 * The server remains the authority — `prepareLine` refuses all of this again
 * with a sentence naming the line — and this is courtesy, so that a claimant
 * fixing a rejected claim is not rejected a second time by the software.
 */
export function ClaimLineFields({
  busy = false,
  onAdd,
  initial = null,
  submitLabel = "Add receipt",
  busyLabel = "Adding…",
  onCancel,
}: {
  busy?: boolean;
  onAdd: (line: DraftLine) => void;
  /**
   * The saved line being corrected, or null to draft a new one.
   *
   * Correcting a receipt is the same act as entering one, under the same rules,
   * so it is the same form. Keying the whole line again into a second form that
   * happened to look similar is how the two would drift, and the half that
   * drifted would be the one only reached after a rejection.
   */
  initial?: ClaimLineRow | null;
  submitLabel?: string;
  busyLabel?: string;
  onCancel?: () => void;
}) {
  const from = React.useCallback(
    (row: ClaimLineRow) => ({
      spentOn: row.spentOn,
      description: row.description,
      accountCode: row.accountCode,
      net: toInput(row.netMinor),
      vat: toInput(row.vatMinor),
      supplierTrn: row.supplierTrn ?? "",
      vatRecoverable: row.vatRecoverable,
      receiptRef: row.receiptRef ?? "",
    }),
    [],
  );
  const [line, setLine] = React.useState(() => (initial ? from(initial) : emptyLine()));

  /* Re-seed when the row being corrected changes — pressing Correct on a second
   * row while the first is open must show the second row, not the first. Keyed
   * on the id rather than the object so a re-render that rebuilds an identical
   * row does not throw away what the user has typed into it. */
  const seeded = React.useRef(initial?.id ?? null);
  React.useEffect(() => {
    const id = initial?.id ?? null;
    if (id === seeded.current) return;
    seeded.current = id;
    setLine(initial ? from(initial) : emptyLine());
  }, [initial, from]);

  const net = parseAmount(line.net);
  const vat = parseAmount(line.vat) ?? 0n;

  const blocker =
    !line.description.trim() ? "Say what was bought." :
    net === null || net === 0n ? "How much was it?" :
    vat === null || vat < 0n ? "VAT cannot be negative." :
    line.vatRecoverable && !/^\d{15}$/.test(line.supplierTrn.trim())
      ? "Reclaiming VAT needs the supplier's fifteen-digit TRN from the tax invoice." :
    line.vatRecoverable && vat <= 0n ? "There is no VAT on this line to reclaim." :
    null;

  const add = () => {
    if (blocker || net === null) return;
    onAdd({
      spentOn: line.spentOn,
      description: line.description.trim(),
      accountCode: line.accountCode,
      netMinor: net.toString(),
      vatMinor: (vat ?? 0n).toString(),
      supplierTrn: line.supplierTrn.trim(),
      vatRecoverable: line.vatRecoverable,
      receiptRef: line.receiptRef.trim(),
    });
    // Correcting a line leaves the form showing what was corrected, because the
    // row it belongs to is still on screen and blanking it would read as the
    // edit having been thrown away.
    if (initial) return;
    // The date and the account carry over to the next receipt; a claim is
    // usually one trip, and re-keying the same day eight times is how a
    // claimant ends up keying it wrong once.
    setLine((l) => ({ ...l, description: "", net: "", vat: "", supplierTrn: "", vatRecoverable: false, receiptRef: "" }));
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Spent on">
          <input type="date" className="sw-input" value={line.spentOn} onChange={(e) => setLine({ ...line, spentOn: e.target.value })} />
        </Field>
        <Field label="Description">
          <input className="sw-input" value={line.description} onChange={(e) => setLine({ ...line, description: e.target.value })} placeholder="Airport taxi" data-testid="line-description" />
        </Field>
        <Field label="Account">
          <select className="sw-select" value={line.accountCode} onChange={(e) => setLine({ ...line, accountCode: e.target.value })}>
            {CLAIM_ACCOUNTS.map(([code, name]) => <option key={code} value={code}>{code} {name}</option>)}
          </select>
        </Field>
        <Field label="Receipt reference">
          <input className="sw-input" value={line.receiptRef} onChange={(e) => setLine({ ...line, receiptRef: e.target.value })} placeholder="R-1042" />
        </Field>
        <Field label="Net">
          <input className="sw-input sw-cell-num" inputMode="decimal" value={line.net} onChange={(e) => setLine({ ...line, net: e.target.value })} placeholder="1,000.00" data-testid="line-net" />
        </Field>
        <Field label="VAT">
          <input className="sw-input sw-cell-num" inputMode="decimal" value={line.vat} onChange={(e) => setLine({ ...line, vat: e.target.value })} placeholder="50.00" />
        </Field>
        <Field label="Supplier TRN">
          <input className="sw-input" inputMode="numeric" value={line.supplierTrn} onChange={(e) => setLine({ ...line, supplierTrn: e.target.value })} placeholder="100123456700003" />
        </Field>
        <label className="flex items-end gap-2 pb-1.5">
          <input
            type="checkbox"
            className="sw-check"
            checked={line.vatRecoverable}
            onChange={(e) => setLine({ ...line, vatRecoverable: e.target.checked })}
            data-testid="vat-recoverable"
          />
          <span className="sw-label" style={{ textTransform: "none" }}>Reclaim this VAT</span>
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid={initial ? "save-claim-line" : "add-claim-line"}
          onClick={add}
        >
          {busy ? busyLabel : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="sw-btn sw-btn-sm" onClick={onCancel} data-testid="cancel-claim-line">
            Leave it as it was
          </button>
        )}
        {blocker && <span className="sw-sub" role="status" data-testid="line-blocker">{blocker}</span>}
        {!blocker && !line.vatRecoverable && vat > 0n && (
          <span className="sw-sub">
            This VAT will be added to {line.accountCode} rather than reclaimed — that is the treatment when there is
            no valid tax invoice behind it.
          </span>
        )}
      </div>
    </>
  );
}
