"use client";

import * as React from "react";
import { todayISO } from "@/lib/utils";
import { Figure } from "./primitives";
import { Field, usePaymentAccounts } from "./ap-coding";
import {
  ledgerProblem,
  postReceiptToLedger,
  useReceiptDraft,
  type PostedEntry,
} from "./ar-posting";

/**
 * Receiving money from a customer.
 *
 *   Dr  1010  Bank                what arrived
 *     Cr  1100  Trade receivables   what the customer no longer owes
 *
 * The mirror of `SupplierPayment` on the payables side, and it opens in the
 * ageing row it belongs to for the same reason: this is what somebody sitting
 * with a bank statement is doing, one open item at a time.
 *
 * The one difference from paying a supplier is the reference. A supplier
 * payment is idempotent on the bank's own reference, which the person keys; a
 * customer receipt has no such reference to hand — the payment row this product
 * writes when an invoice is marked paid is never given to the browser — so the
 * key is derived from the invoice, the day and the amount. `receiptPaymentId`
 * says what that costs and why it is still the safer of the two failures.
 */
export function CustomerReceipt({
  entityId,
  invoiceId,
  invoiceLabel,
  outstandingMinor,
  onPosted,
  onCancel,
}: {
  entityId: string;
  invoiceId: string;
  /** How the invoice is named in the sentence this panel writes back. */
  invoiceLabel: string;
  outstandingMinor: string;
  onPosted: (result: PostedEntry, amountMinor: bigint) => void;
  onCancel: () => void;
}) {
  const { accounts } = usePaymentAccounts(entityId);
  const outstanding = BigInt(outstandingMinor);
  const draft = useReceiptDraft({
    today: todayISO(),
    suggestMinor: outstanding,
    openMinor: outstanding,
    invoiceId,
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* The current account is where a customer receipt lands unless somebody says
   * otherwise, and it is what `postReceipt` falls back to. Chosen once the
   * chart has answered rather than hard-coded into the initial state, because a
   * chart without 1010 must still leave the picker on a real account. */
  const { bankAccount, setBankAccount } = draft;
  React.useEffect(() => {
    if (bankAccount || accounts.length === 0) return;
    setBankAccount(accounts.find((a) => a.code === "1010")?.code ?? accounts[0].code);
  }, [accounts, bankAccount, setBankAccount]);

  const submit = async () => {
    if (!draft.toPost || draft.bankedMinor === null) return;
    setBusy(true);
    setError(null);
    try {
      const banked = draft.bankedMinor;
      onPosted(await postReceiptToLedger(draft.toPost), banked);
    } catch (e) {
      // 403, 404 and 422 all carry a sentence written for the person reading
      // it — a closed period, a missing account, a grant that does not cover
      // this entity — so it is shown as it stands.
      setError(ledgerProblem(e));
      setBusy(false);
    }
  };

  return (
    <div className="p-3">
      <div className="sw-label">Receipt against {invoiceLabel}</div>
      <p className="sw-sub mt-1 max-w-[76ch]">
        {outstanding > 0n ? (
          <>
            <Figure minor={outstanding} /> is still outstanding on it. What is recorded here is the money
            arriving in the bank; the receivable comes down by the same amount unless the two are told
            apart below. Both figures are in the book&apos;s own currency, whatever the invoice was raised
            in.
          </>
        ) : (
          <>
            Nothing is outstanding on this document, so a receipt against it would leave a credit standing
            in the customer&apos;s favour rather than clearing anything.
          </>
        )}
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Received on">
          <input
            type="date"
            className="sw-input"
            value={draft.receivedOn}
            onChange={(e) => draft.setReceivedOn(e.target.value)}
          />
        </Field>
        <Field label="Reached the bank" hint="In the book's own currency.">
          <input
            className={`sw-input sw-cell-num ${draft.bankedMinor === null ? "sw-cell-invalid" : ""}`}
            inputMode="decimal"
            aria-invalid={draft.bankedMinor === null || undefined}
            value={draft.banked}
            onChange={(e) => draft.setBanked(e.target.value)}
            placeholder="0.00"
            data-testid="receipt-amount"
          />
        </Field>
        <Field label="Banked to">
          <select
            className="sw-select"
            aria-label="The account the money arrived in"
            value={draft.bankAccount}
            onChange={(e) => draft.setBankAccount(e.target.value)}
          >
            {accounts.length === 0 && <option value="">1010 · the ledger&apos;s default</option>}
            {accounts.map((a) => (
              <option key={a.id} value={a.code}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Cleared off the invoice"
          hint="Only where it differs from what arrived — a short payment simply leaves the rest outstanding."
        >
          <input
            className={`sw-input sw-cell-num ${
              draft.cleared.trim() !== "" && draft.clearedMinor === null ? "sw-cell-invalid" : ""
            }`}
            inputMode="decimal"
            aria-invalid={(draft.cleared.trim() !== "" && draft.clearedMinor === null) || undefined}
            value={draft.cleared}
            onChange={(e) => draft.setCleared(e.target.value)}
            placeholder="Same as what arrived"
          />
        </Field>
      </div>

      {draft.consequences.length > 0 && (
        <div className="sw-note mt-3 max-w-[76ch]" data-testid="receipt-consequences">
          {draft.consequences.map((c) => (
            <p key={c}>{c}</p>
          ))}
        </div>
      )}

      {error && (
        <div className="sw-error mt-3" role="alert" data-testid="receipt-error">
          {error}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={draft.toPost === null || busy}
          aria-disabled={draft.toPost === null || busy || undefined}
          data-testid="receipt-submit"
          onClick={submit}
        >
          {busy ? "Posting…" : "Record the receipt"}
        </button>
        <button type="button" className="sw-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {draft.blocker && (
          <span className="sw-sub" role="status" data-testid="receipt-blocker">
            {draft.blocker}
          </span>
        )}
      </div>
    </div>
  );
}
