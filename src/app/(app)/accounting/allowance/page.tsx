"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

/**
 * The allowance for doubtful debts.
 *
 * The screen is the matrix. IFRS 9.5.5.15 requires a lifetime expected credit
 * loss allowance on every trade receivable, and IFRS 9.B5.5.35 says how it is
 * measured in practice: age the debt, apply a loss rate to each band, and the
 * sum is the allowance. So the rates are the only thing on this page anybody
 * types, everything else is the ledger, and the arithmetic between them is
 * shown line by line rather than announced as a total.
 *
 * The loss rates belong to the business, not to this product. The defaults it
 * arrives with are a starting point and the page says so plainly — an assumed
 * rate presented as a measured one is exactly the claim these accounts must not
 * make.
 */

interface MatrixRow {
  band: string;
  label: string;
  grossMinor: string;
  exposureMinor: string;
  rateBps: number;
  ratePercent: string;
  lossMinor: string;
}

interface Measurement {
  entryId: string;
  reference: string;
  date: string;
  movementMinor: string;
  memo: string;
}

interface View {
  asOf: string;
  currency: string;
  ratesSupplied: boolean;
  rates: Record<string, number>;
  matrix: MatrixRow[];
  grossReceivablesMinor: string;
  exposureMinor: string;
  targetMinor: string;
  carriedMinor: string;
  movementMinor: string;
  netReceivablesMinor: string;
  postedEntryId: string | null;
  postedReference: string | null;
  history: Measurement[];
}

interface PostResult {
  asOf: string;
  posted: boolean;
  alreadyPosted: boolean;
  reference: string | null;
  note: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A percentage as typed, into whole basis points, without a float touching it.
 *
 * `Number("2.5") * 100` is 250.00000000000003 often enough to matter, and a
 * rate that arrives as 250.00000000000003 is refused by the server for not
 * being a whole number — which reads as the page being broken. Splitting on the
 * point and padding keeps the whole conversion in integers.
 *
 * Returns null for anything that is not a percentage, so the field can keep
 * what the user typed instead of silently becoming nought.
 */
function toBasisPoints(text: string): number | null {
  const m = /^\s*(\d{1,3})(?:[.,](\d{1,2}))?\s*%?\s*$/.exec(text);
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bps > 10_000 ? null : bps;
}

/** Whole basis points as an editable percentage. 250 → "2.50". */
function toPercentInput(bps: number): string {
  return `${Math.trunc(bps / 100)}.${String(Math.abs(bps % 100)).padStart(2, "0")}`;
}

export default function AllowancePage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(today);
  /** What is in the rate fields, as typed. Empty means "leave it at default". */
  const [typed, setTyped] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  // Only the rates that parse are sent, so a half-typed "1." never re-reads the
  // whole page against a rate nobody meant. The ones that do not parse are
  // marked on the field instead.
  const query = Object.entries(typed)
    .map(([band, text]) => [band, text.trim() === "" ? null : toBasisPoints(text)] as const)
    .filter(([, bps]) => bps !== null)
    .map(([band, bps]) => `&${band}=${bps}`)
    .join("");

  const { data, error, loading, reload } = useLedgerQuery<View>(
    entityId ? `/api/ledger/allowance?entityId=${entityId}&asOf=${asOf}${query}` : null,
    [asOf, query],
  );

  const invalid = Object.entries(typed).filter(([, t]) => t.trim() !== "" && toBasisPoints(t) === null);

  const post = async () => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const rates = Object.fromEntries(
        Object.entries(typed)
          .map(([band, text]) => [band, text.trim() === "" ? null : toBasisPoints(text)] as const)
          .filter(([, bps]) => bps !== null),
      );
      const r = await api<PostResult>("/api/ledger/allowance", {
        method: "POST",
        body: JSON.stringify({ entityId, asOf, rates }),
      });
      setMsg(r.note);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const movement = data ? BigInt(data.movementMinor) : 0n;

  return (
    <>
      <PageHead
        title="Allowance for doubtful debts"
        sub={
          "IFRS 9.5.5.15 requires a trade receivable to be carried at what was invoiced less a lifetime expected " +
          "credit loss allowance, from the day it is recognised — there is no waiting for a customer to fail. The " +
          "allowance is measured on a provision matrix: a loss rate for each ageing band, applied to what is " +
          "outstanding in it. What is posted is the movement, never the target, because the allowance is a " +
          "position and only the change in it belongs in this year's result."
        }
        actions={
          <label className="flex items-center gap-1.5">
            <span className="sw-label">As at</span>
            <input
              type="date"
              className="sw-input"
              style={{ width: "10rem" }}
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              aria-label="Date to measure the allowance at"
            />
          </label>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="allowance-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading label="Reading the ageing…" />}

      {data && (
        <>
          <Panel className="mb-4 p-4">
            <dl className="grid gap-4 sm:grid-cols-4">
              <div>
                <dt className="sw-label">Receivables, gross</dt>
                <dd className="sw-num mt-1 text-lg" data-testid="gross-receivables">
                  <Figure minor={data.grossReceivablesMinor} currency={data.currency} colour={false} />
                </dd>
                <p className="sw-sub mt-0.5">
                  What account 1100 carries at {data.asOf}, before any allowance is deducted.
                </p>
              </div>
              <div>
                <dt className="sw-label">Allowance the matrix asks for</dt>
                <dd className="sw-num mt-1 text-lg" data-testid="target-allowance">
                  <Figure minor={data.targetMinor} currency={data.currency} colour={false} />
                </dd>
                <p className="sw-sub mt-0.5">
                  The five bands below, added up. It is a position at {data.asOf}, not a charge for the year.
                </p>
              </div>
              <div>
                <dt className="sw-label">Allowance carried</dt>
                <dd className="sw-num mt-1 text-lg" data-testid="carried-allowance">
                  <Figure minor={data.carriedMinor} currency={data.currency} colour={false} />
                </dd>
                <p className="sw-sub mt-0.5">
                  On account 1150 at {data.asOf}. A debt{" "}
                  <Link href="/accounting/write-offs" className="sw-link">written off</Link> against it takes no
                  further expense.
                </p>
              </div>
              <div>
                <dt className="sw-label">Movement to post</dt>
                <dd className="sw-num mt-1 text-lg" data-testid="movement">
                  <Figure minor={data.movementMinor} currency={data.currency} zero="zero" />
                </dd>
                <p className="sw-sub mt-0.5">
                  {movement > 0n
                    ? "A charge to 6700 Bad debt expense, credited to 1150."
                    : movement < 0n
                      ? "A release: 1150 is debited and the expense credited back."
                      : "The allowance carried is already what the matrix measures. Nothing to post."}
                </p>
              </div>
            </dl>
          </Panel>

          <Panel className="mb-4 overflow-hidden">
            <div
              className="border-b px-3 py-2"
              style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}
            >
              <span className="sw-label">The provision matrix at {data.asOf}</span>
            </div>
            <div className="sw-scroll">
              <table className="sw-table" data-testid="provision-matrix">
                <caption className="sr-only">
                  Trade receivables by age of the document, the loss rate applied to each band, and the expected
                  credit loss it produces.
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ minWidth: "14rem" }}>Age of the debt</th>
                    <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Outstanding</th>
                    <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Exposure</th>
                    <th scope="col" className="sw-num" style={{ width: "8rem" }}>Loss rate</th>
                    <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
                      Expected credit loss
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.matrix.map((r) => {
                    const text = typed[r.band] ?? "";
                    const bad = text.trim() !== "" && toBasisPoints(text) === null;
                    return (
                      <tr key={r.band} data-testid={`band-${r.band}`}>
                        <th scope="row" style={{ fontWeight: 400 }}>
                          {r.label}
                          {r.grossMinor !== r.exposureMinor && (
                            <div className="sw-sub">
                              A credit balance in this band cannot suffer a credit loss, so the rate is applied to
                              nil rather than to a negative.
                            </div>
                          )}
                        </th>
                        <td className="sw-num">
                          <Figure minor={r.grossMinor} currency={data.currency} />
                        </td>
                        <td className="sw-num">
                          <Figure minor={r.exposureMinor} currency={data.currency} colour={false} />
                        </td>
                        <td className="sw-num">
                          <input
                            className={`sw-input sw-input-sm sw-num ${bad ? "sw-cell-invalid" : ""}`}
                            style={{ width: "5.5rem" }}
                            inputMode="decimal"
                            value={text === "" ? toPercentInput(r.rateBps) : text}
                            aria-label={`Loss rate for receivables ${r.label.toLowerCase()}, as a percentage`}
                            aria-invalid={bad || undefined}
                            onChange={(e) => setTyped((t) => ({ ...t, [r.band]: e.target.value }))}
                          />
                        </td>
                        <td className="sw-num">
                          <Figure minor={r.lossMinor} currency={data.currency} colour={false} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Lifetime expected credit losses at {data.asOf}</th>
                    <td className="sw-num" style={{ fontWeight: 600 }}>
                      <Figure minor={data.grossReceivablesMinor} currency={data.currency} zero="zero" colour={false} />
                    </td>
                    <td className="sw-num">
                      <Figure minor={data.exposureMinor} currency={data.currency} zero="zero" colour={false} />
                    </td>
                    <td className="sw-num" />
                    <td className="sw-num" style={{ fontWeight: 600 }} data-testid="matrix-total">
                      <Figure minor={data.targetMinor} currency={data.currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="grid gap-2 px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
              {invalid.length > 0 && (
                <p className="sw-sub" style={{ color: "var(--sw-neg)" }} data-testid="rate-invalid">
                  A loss rate is a percentage between 0 and 100, with up to two decimals — 2.5 or 2.50 for two and
                  a half per cent. Until every rate reads as one, the matrix above is measured on the last set that
                  did.
                </p>
              )}
              <p className="sw-sub" style={{ maxWidth: "80ch" }} data-testid="rates-provenance">
                {data.ratesSupplied
                  ? "These are the rates you have entered. They are recorded on the journal entry the movement " +
                    "posts, so the figure can be explained later without this screen agreeing with the ageing it " +
                    "was cut from."
                  : "These are the product's default rates. They are a starting point and not a measurement of " +
                    "this business's own collection history, which is what IFRS 9.B5.5.35 asks the matrix to be " +
                    "built from — enter the rates your own experience supports before relying on the figure."}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="sw-btn sw-btn-primary"
                  data-testid="post-allowance"
                  disabled={busy || movement === 0n || data.postedEntryId !== null || invalid.length > 0}
                  onClick={post}
                >
                  {movement >= 0n ? "Post the charge" : "Post the release"}
                </button>
                {data.postedEntryId !== null ? (
                  <span className="sw-sub" data-testid="already-posted">
                    The allowance at {data.asOf} was already measured and posted as {data.postedReference}. Measuring
                    it again on the same date is one decision changed, not a further charge — reverse that entry
                    first.
                  </span>
                ) : movement === 0n ? (
                  <span className="sw-sub">Nothing to post at {data.asOf}.</span>
                ) : (
                  <span className="sw-sub">
                    One entry, dated {data.asOf}: the difference between the matrix and what 1150 already carries.
                  </span>
                )}
              </div>
            </div>
          </Panel>

          <h2 className="sw-label mb-2">Every measurement this entity has posted</h2>
          {data.history.length === 0 ? (
            <Empty>
              No allowance has ever been measured for this entity, so trade receivables are carried gross and the
              accounting policy note says so.
            </Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table" data-testid="allowance-history">
                  <caption className="sr-only">
                    Allowance movements posted, newest first, with the matrix recorded on each entry
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: "7rem" }}>Measured at</th>
                      <th scope="col" style={{ width: "8rem" }}>Entry</th>
                      <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Movement</th>
                      <th scope="col">The matrix it was measured on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.map((m) => (
                      <tr key={m.entryId}>
                        <th scope="row" style={{ fontWeight: 400 }}>{m.date}</th>
                        <td>
                          <Link href={`/accounting/journals?entry=${m.entryId}`} className="sw-link">
                            {m.reference}
                          </Link>
                        </td>
                        <td className="sw-num"><Figure minor={m.movementMinor} currency={data.currency} /></td>
                        <td className="sw-sub" style={{ maxWidth: "60ch" }}>{m.memo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <p className="sw-sub mt-4" style={{ maxWidth: "80ch" }}>
            The matrix is recorded on the entry it produced, not kept in a table beside the ledger. A judgement
            stored anywhere else stops agreeing with the accounts the first time somebody posts a journal, and by
            the time an auditor asks where a number came from the ageing it was cut from is a different ageing.
          </p>
        </>
      )}
    </>
  );
}
