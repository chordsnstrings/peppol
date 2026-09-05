"use client";

import * as React from "react";
import { Landmark } from "lucide-react";
import { fmtMinor } from "@/lib/ledger/format";
import { formatMoney } from "@/lib/domain/money";
import { outstandingMinor } from "@/lib/domain/ar";
import type { Invoice } from "@/lib/domain/types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { todayISO } from "@/lib/utils";
import { usePaymentAccounts } from "./ap-coding";
import {
  BOOK_CURRENCY,
  ledgerProblem,
  postReceiptToLedger,
  useReceiptDraft,
  type PostedEntry,
} from "./ar-posting";

/**
 * Recording a customer receipt from an invoice screen.
 *
 * The same four questions the receivables panel asks, in the visual language
 * of the document screens — those pages are built on the product's own UI kit
 * and do not load the ledger stylesheet, so this is a second presentation of
 * one form rather than a second form: the arithmetic, the warnings and the call
 * all live in `ar-posting.tsx`.
 *
 * Marking an invoice paid and posting the receipt are two different acts. The
 * first records what the customer did on the document; the second is what it
 * did to the books, and until now nothing in the browser could do it. So this
 * is offered after a payment is recorded rather than folded into it: the person
 * who marks a payment is not always the person who decides which account it
 * lands in or on what date it clears.
 */
export function ReceiptModal({
  invoice,
  suggestMinor,
  warning,
  onClose,
  onPosted,
}: {
  invoice: Invoice;
  /**
   * What to offer as the amount banked. Callers that have just recorded a
   * payment pass what they recorded; otherwise the invoice's own outstanding
   * amount is offered, and only where the document is in the book's currency.
   */
  suggestMinor?: bigint | null;
  /**
   * Something the caller knows about this invoice's standing in the books that
   * changes what posting a receipt will mean — chiefly that the invoice itself
   * has not been posted, in which case the credit has no debit to clear.
   */
  warning?: string;
  onClose: () => void;
  onPosted: (entry: PostedEntry) => void;
}) {
  /* The invoice's own entity, not the one the shell happens to be showing: a
   * deep link can open a document belonging to another entity, and the accounts
   * offered have to be the ones the receipt will actually post into. */
  const { accounts } = usePaymentAccounts(invoice.entityId);
  const foreign = invoice.currency !== BOOK_CURRENCY;

  /* The document's own arithmetic is in whole minor units — the domain types
   * carry them as integers — so this crosses into BigInt exactly. Nothing is
   * offered for a foreign-currency invoice: what lands in the bank is a dirham
   * amount at a rate this screen does not know, and a suggestion would be a
   * guess presented as a figure. */
  const outstanding = outstandingMinor(invoice);
  const suggestion =
    suggestMinor !== undefined && suggestMinor !== null
      ? suggestMinor
      : foreign || !Number.isInteger(outstanding)
        ? null
        : BigInt(outstanding);

  const draft = useReceiptDraft({
    today: todayISO(),
    suggestMinor: suggestion,
    invoiceId: invoice.id,
  });
  const [posting, setPosting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const { bankAccount, setBankAccount } = draft;
  React.useEffect(() => {
    if (bankAccount || accounts.length === 0) return;
    setBankAccount(accounts.find((a) => a.code === "1010")?.code ?? accounts[0].code);
  }, [accounts, bankAccount, setBankAccount]);

  const submit = async () => {
    if (!draft.toPost) return;
    setPosting(true);
    setError(null);
    try {
      onPosted(await postReceiptToLedger(draft.toPost));
    } catch (e) {
      setError(ledgerProblem(e));
    } finally {
      setPosting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Post the receipt to the ledger"
      description={`Debit the bank, credit receivables, and clear ${invoice.number} in the ageing.`}
    >
      <div className="space-y-4 p-5 sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date received">
            <Input
              type="date"
              value={draft.receivedOn}
              onChange={(e) => draft.setReceivedOn(e.target.value)}
            />
          </Field>

          <Field
            label="Amount banked"
            help={
              foreign
                ? `${invoice.number} is in ${invoice.currency}. Key what actually reached the bank, in the book's own currency.`
                : "In the book's own currency."
            }
          >
            <Input
              inputMode="decimal"
              placeholder="0.00"
              value={draft.banked}
              onChange={(e) => draft.setBanked(e.target.value)}
            />
          </Field>

          <Field
            label="Banked to"
            help={
              accounts.length === 0
                ? "No account in this chart is marked as cash or bank. Left empty, the receipt is banked to 1010."
                : undefined
            }
          >
            {accounts.length > 0 ? (
              <Select value={draft.bankAccount} onChange={(e) => draft.setBankAccount(e.target.value)}>
                {accounts.map((a) => (
                  <option key={a.id} value={a.code}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                placeholder="1010"
                value={draft.bankAccount}
                onChange={(e) => draft.setBankAccount(e.target.value)}
              />
            )}
          </Field>

          <Field label="Cleared off the invoice" help="Only where it differs from what arrived.">
            <Input
              inputMode="decimal"
              placeholder="Same as banked"
              value={draft.cleared}
              onChange={(e) => draft.setCleared(e.target.value)}
            />
          </Field>
        </div>

        <p className="text-xs text-muted-foreground">
          {invoice.number} was raised for{" "}
          {formatMoney(invoice.totals.taxInclusiveMinor, invoice.currency)}
          {invoice.amountPaidMinor
            ? ` and the document records ${formatMoney(invoice.amountPaidMinor, invoice.currency)} received.`
            : "."}{" "}
          What the ledger still shows outstanding is on the receivables screen; this posts what you
          key here.
        </p>

        {(warning || draft.consequences.length > 0) && (
          <div className="space-y-1 rounded-lg border border-warning/25 bg-warning/[0.08] p-3 text-xs">
            {warning && <p className="font-medium">{warning}</p>}
            {draft.consequences.map((c) => (
              <p key={c}>{c}</p>
            ))}
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-destructive/20 bg-destructive/[0.08] p-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {draft.blocker && (
            <span className="me-auto text-xs text-muted-foreground">{draft.blocker}</span>
          )}
          {!draft.blocker && draft.bankedMinor !== null && (
            <span className="me-auto text-xs text-muted-foreground tnum">
              Posting {fmtMinor(draft.bankedMinor, BOOK_CURRENCY, { zero: "zero" })}
            </span>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            icon={<Landmark />}
            loading={posting}
            disabled={draft.toPost === null}
            onClick={submit}
          >
            Post receipt
          </Button>
        </div>
      </div>
    </Modal>
  );
}
