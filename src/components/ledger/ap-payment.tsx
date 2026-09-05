"use client";

import * as React from "react";
import { api, ApiError } from "./use-ledger";
import { Figure } from "./primitives";
import { Field, toWireMinor, usePaymentAccounts } from "./ap-coding";
import { parseAmount, toInput } from "@/lib/ledger/format";
import { todayISO } from "@/lib/utils";

/**
 * Paying a supplier.
 *
 *   Dr  2000  Trade payables    what is no longer owed
 *     Cr  1010  Bank              what left the account
 *
 * The reference is the whole safety of this. `postSupplierPayment` is
 * idempotent on it — the entry's external key is `supplier-payment:<reference>`
 * — so the same reference twice returns the first entry and posts nothing.
 * That is what stands between a slow network and a supplier paid twice, and it
 * only works if the reference is the bank's, not one this screen invents: two
 * different transfers must never be able to collide on it, and one transfer
 * retried must never fail to.
 */

export interface PaymentResult {
  entryId: string;
  reference: string;
  alreadyPosted: boolean;
}

export function SupplierPayment({
  entityId,
  billId,
  billLabel,
  outstandingMinor,
  onPosted,
  onCancel,
}: {
  entityId: string;
  billId: string;
  /** How the bill is named in the sentence this panel writes back. */
  billLabel: string;
  outstandingMinor: string;
  onPosted: (result: PaymentResult, amountMinor: bigint) => void;
  onCancel: () => void;
}) {
  const { accounts, error: chartError, loading: chartLoading } = usePaymentAccounts(entityId);
  const outstanding = BigInt(outstandingMinor);

  const [reference, setReference] = React.useState("");
  const [paidOn, setPaidOn] = React.useState(todayISO);
  const [amount, setAmount] = React.useState(() => toInput(outstanding));
  const [cleared, setCleared] = React.useState("");
  const [bankAccount, setBankAccount] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* The current account is where a supplier payment goes from unless somebody
   * says otherwise, and it is what `postSupplierPayment` falls back to. Chosen
   * once the chart has loaded rather than hard-coded into the initial state,
   * because a chart without 1010 must still leave the picker on a real
   * account. */
  React.useEffect(() => {
    if (bankAccount || accounts.length === 0) return;
    setBankAccount(accounts.find((a) => a.code === "1010")?.code ?? accounts[0].code);
  }, [accounts, bankAccount]);

  const bank = parseAmount(amount);
  /* Blank means "the same as what left the bank", which is the right answer for
   * every payment that is not settling a balance raised at another day's rate.
   * Unreadable is tracked apart from blank so an empty field is never marked
   * wrong — and never marked wrong because the field above it is. */
  const clearedTyped = cleared.trim() === "" ? null : parseAmount(cleared);
  const clearedUnreadable = cleared.trim() !== "" && clearedTyped === null;
  const clearedMinor = cleared.trim() === "" ? bank : clearedTyped;
  const difference = bank !== null && clearedMinor !== null ? clearedMinor - bank : 0n;

  const blocker =
    !reference.trim() ? "The bank's own reference for this payment. Posting the same one twice is refused, which is what stops a supplier being paid twice." :
    !paidOn ? "When did the money leave?" :
    bank === null ? "That is not an amount." :
    bank <= 0n ? "A payment has to be a positive amount." :
    clearedUnreadable || clearedMinor === null ? "The amount cleared from payables is not an amount." :
    toWireMinor(bank) === null || toWireMinor(clearedMinor) === null ? "That amount is too large to send without losing fils." :
    chartLoading ? "Reading the chart of accounts…" :
    accounts.length === 0
      ? "This chart has no bank or cash account, so there is nowhere for a payment to leave from." :
    !bankAccount ? "Which account did it leave from?" :
    null;

  const submit = async () => {
    if (blocker || bank === null || clearedMinor === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<PaymentResult>("/api/ledger/ap/post", {
        method: "POST",
        body: JSON.stringify({
          billId,
          kind: "payment",
          paymentId: reference.trim(),
          paidOn,
          bankAmountMinor: toWireMinor(bank),
          // Sent only when it was given: left out, the ledger carries the
          // payable off at exactly what left the bank, which is the right
          // answer for every payment that is not settling a foreign balance.
          ...(cleared.trim() === "" ? {} : { clearedAmountMinor: toWireMinor(clearedMinor) }),
          bankAccount,
        }),
      });
      onPosted(result, bank);
    } catch (e) {
      // 403, 404 and 422 all carry a sentence written for the person reading
      // it — an approval rule that has not been satisfied says so here, and
      // that is the correct answer rather than a failure.
      setError(e instanceof ApiError ? e.message : "The ledger could not be reached, so nothing was posted. Try again in a moment.");
      setBusy(false);
    }
  };

  return (
    <div className="p-3">
      <div className="sw-label">Paying {billLabel}</div>
      <p className="sw-sub mt-1 max-w-[76ch]">
        {outstanding > 0n ? (
          <>
            <Figure minor={outstanding} /> is still outstanding on it. What is recorded here is the money leaving
            the bank; the payable comes down by the same amount unless the two are told apart below. Both figures are
            in the book&rsquo;s own currency, whatever the bill was raised in — what a foreign bill costs is what the
            bank took for it.
          </>
        ) : (
          <>Nothing is outstanding on this document, so a payment against it would put the account the other way up.</>
        )}
      </p>

      {chartError && <div className="sw-error mt-3" role="alert">{chartError}</div>}

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Bank reference" hint="Posting it twice returns the first entry rather than paying again.">
          <input
            className="sw-input"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="TT-88421"
          />
        </Field>
        <Field label="Paid on">
          <input type="date" className="sw-input" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </Field>
        <Field label="Left the bank">
          <input
            className={`sw-input sw-cell-num ${bank === null ? "sw-cell-invalid" : ""}`}
            inputMode="decimal"
            aria-invalid={bank === null || undefined}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </Field>
        <Field label="Paid from">
          <select
            className="sw-select"
            aria-label="The account the payment left from"
            value={bankAccount}
            onChange={(e) => setBankAccount(e.target.value)}
          >
            {accounts.map((a) => <option key={a.id} value={a.code}>{a.code} · {a.name}</option>)}
          </select>
        </Field>
        <Field
          label="Cleared from payables"
          hint="Only where it differs — a foreign balance settled at another day's rate. The difference posts as a realised exchange gain or loss."
        >
          <input
            className={`sw-input sw-cell-num ${clearedUnreadable ? "sw-cell-invalid" : ""}`}
            inputMode="decimal"
            aria-invalid={clearedUnreadable || undefined}
            value={cleared}
            onChange={(e) => setCleared(e.target.value)}
            placeholder="Same as what left the bank"
          />
        </Field>
      </div>

      {difference !== 0n && (
        <p className="sw-note mt-3 max-w-[76ch]">
          The payable is carried off at <Figure minor={clearedMinor ?? 0n} /> against <Figure minor={bank ?? 0n} /> leaving
          the bank, so <Figure minor={difference > 0n ? difference : -difference} /> posts as a realised exchange{" "}
          {difference > 0n ? "gain to 4950" : "loss to 6800"} — not as a discount or a write-off.
        </p>
      )}

      {error && <div className="sw-error mt-3" role="alert" data-testid="payment-error">{error}</div>}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="payment-submit"
          onClick={submit}
        >
          {busy ? "Posting…" : "Record the payment"}
        </button>
        <button type="button" className="sw-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="payment-blocker">{blocker}</span>}
      </div>
    </div>
  );
}
