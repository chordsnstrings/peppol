"use client";

import * as React from "react";
import { api, ApiError } from "./use-ledger";
import { Figure } from "./primitives";
import {
  AccountSelect,
  postingArithmetic,
  suggestAccount,
  useCodingMemory,
  usePurchaseAccounts,
} from "./ap-coding";
import { TAX_PROFILES } from "@/lib/domain/tax";
import { fmtMinor } from "@/lib/ledger/format";
import type { Invoice } from "@/lib/domain/types";

/**
 * Coding a bill and posting it.
 *
 * Every line gets an account, and the account is sent with the request rather
 * than left to the server's fallback — a screen that shows one destination and
 * relies on another to be the same is a screen that is right until somebody
 * edits one of them. What posts is what is on screen.
 *
 * Posting is idempotent on the bill's id, so pressing this twice cannot make
 * two entries: the second call finds the first and says so.
 */

export interface PostBillResult {
  entryId: string;
  reference: string;
  alreadyPosted: boolean;
  /** Self-accounted VAT on this bill — it belongs on both boxes of the return. */
  reverseChargeMinor: string;
}

export function BillCoding({
  entityId,
  bill,
  onPosted,
  onCancel,
}: {
  entityId: string;
  bill: Invoice;
  onPosted: (result: PostBillResult) => void;
  onCancel: () => void;
}) {
  const { accounts, error: chartError, loading: chartLoading } = usePurchaseAccounts(entityId);
  const { memory, remember, ready } = useCodingMemory(entityId);
  const [coding, setCoding] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  /* Fill the blanks once both the chart and the memory are in. Only the blanks:
   * anything already chosen is somebody's decision and outranks a suggestion. */
  React.useEffect(() => {
    if (!ready || accounts.length === 0) return;
    setCoding((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const line of bill.lines) {
        if (next[line.id]) continue;
        const suggestion = suggestAccount(memory, bill, line, accounts);
        if (suggestion) {
          next[line.id] = suggestion;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [ready, accounts, memory, bill]);

  const uncoded = bill.lines.find((l) => !coding[l.id]);
  const arithmetic = postingArithmetic(bill);

  const blocker =
    chartLoading ? "Reading the chart of accounts…" :
    accounts.length === 0 ? "This entity's chart has no account a purchase can be charged to." :
    uncoded ? `Line ${uncoded.lineNo} has no account yet.` :
    null;

  const post = async () => {
    if (blocker) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<PostBillResult>("/api/ledger/ap/post", {
        method: "POST",
        body: JSON.stringify({ billId: bill.id, kind: "bill", coding }),
      });
      // Remembered only once the ledger has taken it. Coding somebody abandoned
      // — or that an approval rule refused — is not evidence about where this
      // supplier's costs belong.
      await remember(bill, coding);
      onPosted(result);
    } catch (e) {
      /* The server's own sentence, whatever it was. A missing `ap.manage`
       * grant, a bill that no longer exists and an approval rule that has not
       * been satisfied all answer here, and the last of those is the ledger
       * working rather than failing — so it is shown as it was written, not
       * translated into "something went wrong". */
      setError(e instanceof ApiError ? e.message : "The ledger could not be reached, so nothing was posted. Try again in a moment.");
      setBusy(false);
    }
  };

  return (
    <div className="p-3">
      <div className="sw-label">
        Coding {bill.number} — {bill.seller?.nameEn ?? "supplier"}
      </div>
      <p className="sw-sub mt-1 max-w-[80ch]">
        Each line opens on the account this description was coded to last time, then on what this supplier&rsquo;s
        money usually goes to, then on the treatment&rsquo;s default. Posting debits these accounts and the
        recoverable input VAT, and credits trade payables with what is owed.
      </p>

      {chartError && <div className="sw-error mt-3" role="alert">{chartError}</div>}

      <div className="sw-scroll mt-3">
        <table className="sw-table sw-grid">
          <caption className="sr-only">Every line of {bill.number} and the account it will be charged to</caption>
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>#</th>
              <th style={{ minWidth: "12rem" }}>Description</th>
              <th style={{ width: "10rem" }}>Treatment</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
              <th className="sw-num" style={{ width: "7rem" }}>VAT</th>
              <th style={{ minWidth: "14rem" }}>Charge to</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.id}>
                <td className="sw-code" style={{ paddingInline: "0.625rem" }}>{l.lineNo}</td>
                <td className="max-w-0 truncate" style={{ paddingInline: "0.625rem" }} title={l.description}>{l.description}</td>
                <td style={{ paddingInline: "0.625rem" }}>{TAX_PROFILES[l.taxProfileCode]?.label ?? l.taxProfileCode}</td>
                <td className="sw-num" style={{ paddingInline: "0.625rem" }}>
                  <Figure minor={l.lineNetMinor} currency={bill.currency} colour={false} />
                </td>
                <td className="sw-num" style={{ paddingInline: "0.625rem" }}>
                  <Figure minor={l.lineVatMinor} currency={bill.currency} colour={false} />
                </td>
                <td>
                  <AccountSelect
                    accounts={accounts}
                    value={coding[l.id] ?? ""}
                    inGrid
                    ariaLabel={`The account line ${l.lineNo}, ${l.description}, is charged to`}
                    onChange={(code) => setCoding((c) => ({ ...c, [l.id]: code }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3} style={{ textAlign: "end" }}>Payable to the supplier</th>
              <td className="sw-num" colSpan={3}>
                <Figure minor={bill.totals.payableMinor} currency={bill.currency} zero="zero" colour={false} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {arithmetic.driftMinor !== 0n && (
        <p className="sw-note mt-3 max-w-[80ch]">
          The ledger adds this bill up line by line and gets {fmtMinor(arithmetic.linesMinor, bill.currency)} against
          the document&rsquo;s own total of {fmtMinor(arithmetic.payableMinor, bill.currency)}, because VAT is rounded
          once per rate on a document and once per line by the check. It will refuse the posting until the lines that
          share a rate are entered as one line.
        </p>
      )}

      {error && <div className="sw-error mt-3" role="alert" data-testid="coding-error">{error}</div>}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="coding-post"
          onClick={post}
        >
          {busy ? "Posting…" : "Post to the ledger"}
        </button>
        <button type="button" className="sw-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="coding-blocker">{blocker}</span>}
      </div>
    </div>
  );
}
