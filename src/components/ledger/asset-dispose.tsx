"use client";

import * as React from "react";
import { Figure } from "./primitives";
import { Field, usePaymentAccounts } from "./ap-coding";
import { parseAmount } from "@/lib/ledger/format";

/**
 * Selling or scrapping a fixed asset, with the gain or loss shown before it is
 * posted.
 *
 * `disposeAsset` has been in the ledger and on the route the whole time and
 * nothing in the browser could reach it. The consequence is not cosmetic: a van
 * that was sold in March goes on depreciating every month afterwards, its cost
 * and its accumulated depreciation stay on the balance sheet, and the profit or
 * loss on selling it never reaches the income statement at all.
 *
 * Two facts about the posting decide the shape of this panel.
 *
 * The first is that the gain or loss is not an outcome to be read afterwards —
 * it is the figure the person is deciding about, and it is a residual: the
 * proceeds less whatever the register happens to carry the asset at. So the
 * working is shown here, in the order an accountant writes it, before anything
 * is sent; it is the same arithmetic `disposeAsset` does, on the same two
 * figures the register already displays.
 *
 * The second is that `disposeAsset` writes back exactly the accumulated
 * depreciation the register holds today — it does not charge the months between
 * the last depreciation run and the disposal date. That is the right behaviour
 * (a disposal is not a depreciation run, and catching up silently would post a
 * charge nobody asked for into whichever period this entry lands in), but it
 * means every uncharged month falls into the gain or loss instead of into
 * depreciation. Nobody should have to know that to use this, so the panel says
 * it whenever it is true — and says nothing when it is not, because a warning
 * that appears on every disposal is one nobody reads on the disposal that
 * needed it.
 */

export interface DisposableAsset {
  code: string;
  name: string;
  acquiredOn: string;
  /** The accounts this asset actually posts to — 1500/1590, or 1560/1570 for an intangible. */
  assetAccount: string;
  accumAccount: string;
  costMinor: string;
  accumulatedMinor: string;
  /** The last month a charge was posted for, or null if none ever was. */
  depreciatedTo: string | null;
}

export interface DisposalRequest {
  assetCode: string;
  disposedOn: string;
  /**
   * Minor units as a decimal string, the way every other amount on these
   * screens crosses the wire. `disposeAsset` accepts a string, a BigInt or a
   * number; a JavaScript number is the one of the three that cannot hold every
   * value this ledger can, so it is never the one that is sent.
   */
  proceedsMinor: string;
  proceedsAccount: string;
}

/** Where the gain and the loss land. Both are fixed inside `disposeAsset`. */
const GAIN_ACCOUNT = "4900";
const LOSS_ACCOUNT = "6900";

const monthOf = (isoDate: string) => isoDate.slice(0, 7);
const monthIndex = (period: string) => Number(period.slice(0, 4)) * 12 + Number(period.slice(5, 7));

export function AssetDisposal({
  entityId,
  asset,
  busy,
  onDispose,
  onCancel,
}: {
  entityId: string;
  asset: DisposableAsset;
  busy: boolean;
  onDispose: (request: DisposalRequest) => void;
  onCancel: () => void;
}) {
  const { accounts } = usePaymentAccounts(entityId);
  const [disposedOn, setDisposedOn] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [proceedsText, setProceedsText] = React.useState("");
  const [proceedsAccount, setProceedsAccount] = React.useState("");

  /* The account the money arrived in, chosen once the chart has answered
   * rather than written into the initial state — a chart without 1010 still has
   * to leave the picker on an account that exists. 1010 is what `disposeAsset`
   * falls back to, so it is what the picker prefers when it is there. */
  React.useEffect(() => {
    if (proceedsAccount || accounts.length === 0) return;
    setProceedsAccount(accounts.find((a) => a.code === "1010")?.code ?? accounts[0].code);
  }, [accounts, proceedsAccount]);

  const cost = BigInt(asset.costMinor);
  const accumulated = BigInt(asset.accumulatedMinor);
  const netBookValue = cost - accumulated;
  const proceeds = parseAmount(proceedsText);

  /* Positive is a gain, which is how the server reads it too. Null while the
   * proceeds field cannot be read at all, so the working shows nothing rather
   * than a figure derived from a guess at what was meant. */
  const result = proceeds === null ? null : proceeds - netBookValue;

  const blocker =
    !disposedOn ? "When was it disposed of?" :
    disposedOn < asset.acquiredOn
      ? `${asset.code} was acquired on ${asset.acquiredOn}; it cannot have been disposed of before that.` :
    proceeds === null ? "Proceeds have to be an amount — key 0 for an asset that was scrapped." :
    proceeds < 0n ? "Proceeds cannot be negative. A cost of disposal is a separate expense, not a negative sale." :
    proceeds > 0n && !proceedsAccount ? "Which account did the money arrive in?" :
    null;

  return (
    <div className="p-3" data-testid="asset-disposal">
      <div className="sw-label">
        Dispose of {asset.code} {asset.name}
      </div>
      <p className="sw-sub mt-1 max-w-[76ch]">
        The cost comes off {asset.assetAccount} and the depreciation written off to date comes back off{" "}
        {asset.accumAccount}. Whatever the proceeds do not cover is the gain or loss on disposal, and it is worked
        out below before anything is posted, because it is the figure this decision is actually about.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Disposed on" hint="The date the entry carries, so it decides the period it lands in.">
          <input
            type="date"
            className="sw-input"
            value={disposedOn}
            onChange={(e) => setDisposedOn(e.target.value)}
            data-testid="disposal-date"
          />
        </Field>
        <Field label="Proceeds" hint="What was received for it. Nothing at all for an asset that was scrapped.">
          <input
            className={`sw-input sw-cell-num ${proceeds === null ? "sw-cell-invalid" : ""}`}
            inputMode="decimal"
            aria-invalid={proceeds === null || undefined}
            value={proceedsText}
            onChange={(e) => setProceedsText(e.target.value)}
            placeholder="0.00"
            data-testid="disposal-proceeds"
          />
        </Field>
        <Field
          label="Proceeds arrived in"
          hint="A disposal on credit has no bank account to name; this control does not raise a receivable."
        >
          <select
            className="sw-select"
            aria-label="The account the proceeds arrived in"
            value={proceedsAccount}
            onChange={(e) => setProceedsAccount(e.target.value)}
            data-testid="disposal-account"
          >
            {accounts.length === 0 && <option value="1010">1010 · the ledger&apos;s default</option>}
            {accounts.map((a) => (
              <option key={a.id} value={a.code}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="sw-scroll">
          <table className="sw-table" style={{ maxWidth: "28rem" }}>
            <caption className="sr-only">
              What {asset.code} comes off the books at, and what the sale leaves behind
            </caption>
            <thead>
              <tr>
                <th>Gain or loss on disposal</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" style={{ fontWeight: 400 }}>Cost</th>
                <td className="sw-num"><Figure minor={cost} zero="zero" colour={false} /></td>
              </tr>
              <tr>
                <th scope="row" style={{ fontWeight: 400 }}>
                  Depreciation written off to date
                  {asset.depreciatedTo && <span className="sw-sub"> · to {asset.depreciatedTo}</span>}
                </th>
                {/* Shown as the deduction it is, so the column reads downwards
                    the way the working is written on paper. The parentheses do
                    that on their own; the colour is off because this is a
                    subtraction inside a working, not a negative balance. */}
                <td className="sw-num"><Figure minor={-accumulated} zero="zero" colour={false} /></td>
              </tr>
              <tr>
                <th scope="row">Net book value</th>
                <td className="sw-num" data-testid="disposal-nbv">
                  <Figure minor={netBookValue} zero="zero" colour={false} />
                </td>
              </tr>
              <tr>
                <th scope="row" style={{ fontWeight: 400 }}>Proceeds</th>
                <td className="sw-num" data-testid="disposal-proceeds-figure">
                  {proceeds === null
                    ? <span className="sw-zero">–</span>
                    : <Figure minor={proceeds} zero="zero" colour={false} />}
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">
                  {result === null
                    ? "Gain or loss on disposal"
                    : result > 0n
                      ? `Gain on disposal, credited to ${GAIN_ACCOUNT}`
                      : result < 0n
                        ? `Loss on disposal, charged to ${LOSS_ACCOUNT}`
                        : "Neither a gain nor a loss"}
                </th>
                <td className="sw-num" data-testid="disposal-result">
                  {result === null
                    ? <span className="sw-zero">–</span>
                    : <Figure minor={result} zero="zero" />}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="sw-scroll">
          <table className="sw-table" style={{ maxWidth: "36rem" }}>
            <caption className="sr-only">The entry that disposes of {asset.code}, as it will be posted</caption>
            <thead>
              <tr>
                <th style={{ width: "5rem" }}>Account</th>
                <th>The entry that posts</th>
                <th className="sw-col-debit sw-num" style={{ width: "var(--sw-col-amount)" }}>Debit</th>
                <th className="sw-col-credit sw-num" style={{ width: "var(--sw-col-amount)" }}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {proceeds !== null && proceeds > 0n && (
                <Leg account={proceedsAccount || "1010"} what="Proceeds of the sale" debit={proceeds} />
              )}
              {accumulated > 0n && (
                <Leg account={asset.accumAccount} what="Depreciation to date, taken back out" debit={accumulated} />
              )}
              <Leg account={asset.assetAccount} what={`${asset.code} off the register at cost`} credit={cost} />
              {result !== null && result > 0n && <Leg account={GAIN_ACCOUNT} what="Gain on disposal" credit={result} />}
              {result !== null && result < 0n && <Leg account={LOSS_ACCOUNT} what="Loss on disposal" debit={-result} />}
            </tbody>
          </table>
        </div>
      </div>

      {result !== null && (
        <p className="sw-sub mt-3 max-w-[76ch]" data-testid="disposal-reading">
          {result > 0n ? (
            <>
              It fetched more than the books carried it at. A gain on disposal is not turnover — it is the
              correction of an estimate that turned out to be conservative — which is why it is credited to{" "}
              {GAIN_ACCOUNT} and not to sales.
            </>
          ) : result < 0n ? (
            <>
              It fetched less than the books carried it at. Most of a loss on disposal is depreciation that was
              never charged, because the useful life or the residual value was optimistic; the loss is where that
              catches up, all in one period.
            </>
          ) : (
            <>
              The proceeds are exactly the net book value, so nothing at all falls to the income statement. That is
              unusual enough to be worth checking the proceeds against the sale document before posting.
            </>
          )}
        </p>
      )}

      <DepreciationGap asset={asset} disposedOn={disposedOn} />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="post-disposal"
          onClick={() =>
            onDispose({
              assetCode: asset.code,
              disposedOn,
              proceedsMinor: (proceeds as bigint).toString(),
              proceedsAccount: proceedsAccount || "1010",
            })
          }
        >
          {busy ? "Posting…" : "Post the disposal"}
        </button>
        <button type="button" className="sw-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {blocker && (
          <span className="sw-sub" role="status" data-testid="disposal-blocker">
            {blocker}
          </span>
        )}
        {!blocker && (
          <span className="sw-sub">
            The entry is keyed on the asset, so a disposal posted twice is posted once.
          </span>
        )}
      </div>
    </div>
  );
}

function Leg({ account, what, debit, credit }: {
  account: string; what: string; debit?: bigint; credit?: bigint;
}) {
  return (
    <tr>
      <td className="sw-code">{account}</td>
      <td className="max-w-0 truncate">{what}</td>
      <td className="sw-num">
        {debit === undefined ? <span className="sw-zero">–</span> : <Figure minor={debit} colour={false} />}
      </td>
      <td className="sw-num">
        {credit === undefined ? <span className="sw-zero">–</span> : <Figure minor={credit} colour={false} />}
      </td>
    </tr>
  );
}

/**
 * What the months between the last depreciation run and the disposal do to the
 * figure above.
 *
 * `disposeAsset` writes back the accumulated depreciation on the register and
 * charges nothing further, so an asset last depreciated in March and disposed
 * of in September comes off at a net book value six months too high — and those
 * six months land in the loss on disposal rather than in the depreciation of
 * the periods they belong to. The total charged over the asset's life is right
 * either way; the split between the two lines of the income statement is not,
 * and the split is what a reader of those statements sees.
 */
function DepreciationGap({ asset, disposedOn }: { asset: DisposableAsset; disposedOn: string }) {
  if (!disposedOn) return null;
  const period = monthOf(disposedOn);

  if (!asset.depreciatedTo) {
    return (
      <p className="sw-note mt-3 max-w-[76ch]" data-testid="disposal-depreciation-gap">
        No depreciation has ever been posted for {asset.code}, so the register still carries it at its full cost.
        Disposing of it now writes the whole of that off through the gain or loss on disposal instead of through
        the depreciation charge of the periods it was in use. Run those months first — the month picker at the top
        of this screen posts one at a time — if the charge belongs in them.
      </p>
    );
  }

  const behind = monthIndex(period) - monthIndex(asset.depreciatedTo);

  if (behind === 0) {
    return (
      <p className="sw-sub mt-3 max-w-[76ch]" data-testid="disposal-depreciation-gap">
        Depreciation is posted to {asset.depreciatedTo}, the month of the disposal, so the net book value above is
        the one the schedule actually reached.
      </p>
    );
  }

  if (behind < 0) {
    return (
      <p className="sw-note mt-3 max-w-[76ch]" data-testid="disposal-depreciation-gap">
        Depreciation has been posted to {asset.depreciatedTo}, which is after {period}. Those charges stand —
        disposing of the asset does not take them back — so the asset went on being depreciated in months it had
        already been sold in, and the gain or loss above is measured after them.
      </p>
    );
  }

  return (
    <p className="sw-note mt-3 max-w-[76ch]" data-testid="disposal-depreciation-gap">
      Depreciation is posted to {asset.depreciatedTo} and the disposal is dated {period}.{" "}
      {behind === 1 ? "That month has" : `Those ${behind} months have`} not been charged, and this disposal does
      not charge {behind === 1 ? "it" : "them"}: the asset comes off at the accumulated depreciation the register
      holds now, so {behind === 1 ? "the month falls" : "those months fall"} into the gain or loss on disposal
      rather than into depreciation. Run {behind === 1 ? "that month" : "the months in between"} first if the
      charge belongs in {behind === 1 ? "that period" : "those periods"}.
    </p>
  );
}
