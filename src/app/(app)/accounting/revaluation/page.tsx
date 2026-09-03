"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

interface Row {
  account: string; name: string; type: string; currency: string;
  txnBalanceMinor: string; carryingMinor: string;
  rate: string; rateDate: string;
  revaluedMinor: string; differenceMinor: string; gain: boolean;
}
interface Skip {
  account: string; name: string; currency: string; txnBalanceMinor: string; reason: string;
}
interface Rate { currency: string; rate: string; rateDate: string; source: string }
interface Preview {
  asOf: string;
  functionalCurrency: string;
  rows: Row[];
  skipped: Skip[];
  blockers: string[];
  totalGainMinor: string;
  totalLossMinor: string;
  netDifferenceMinor: string;
  reversalDate: string | null;
  alreadyPosted: boolean;
  reference: string | null;
  reversalReference: string | null;
  rates: Rate[];
}

/** Period end, which is the only date a revaluation is normally run at. */
const endOfThisMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};

export default function RevaluationPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(endOfThisMonth);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const q = useLedgerQuery<Preview>(
    entityId ? `/api/ledger/revaluation?entityId=${entityId}&asOf=${asOf}` : null,
    [asOf],
  );
  const p = q.data;

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/revaluation", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      q.reload();
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const revalue = async () => {
    const r = await act("revalue", { action: "revalue", asOf });
    if (!r) return;
    const n = Number(r.accountsRevalued);
    setMsg(
      r.alreadyPosted
        ? `${asOf} was already revalued as ${r.reference}, reversed on ${r.reversalDate} as ${r.reversalReference}. Nothing was posted again.`
        : n === 0
          ? `Nothing to revalue at ${asOf}.`
          : `Revalued ${n} balance${n === 1 ? "" : "s"} as ${r.reference}, reversing on ${r.reversalDate} as ${r.reversalReference}.`,
    );
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const canPost = p && !p.alreadyPosted && p.blockers.length === 0 && p.rows.length > 0;

  return (
    <>
      <PageHead
        title="Currency revaluation"
        sub="What the entity's foreign-currency balances are worth at the closing rate. Only monetary items are revalued — a receivable is a claim to currency, a machine is not (IAS 21.23). The adjustment moves the dirham carrying amount and never the foreign balance itself."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">As at</span>
              <input
                type="date"
                className="sw-input"
                style={{ width: "10rem" }}
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                aria-label="Revaluation date"
              />
            </label>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              onClick={revalue}
              aria-disabled={!canPost || busy === "revalue" || undefined}
              disabled={!canPost || busy === "revalue"}
              data-testid="run-revaluation"
            >
              {busy === "revalue" ? "Posting…" : "Post revaluation"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="revaluation-result">{msg}</div>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !p && <Loading />}

      {p && (
        <>
          {p.alreadyPosted && (
            <div className="sw-note mb-3" data-testid="already-revalued">
              {p.asOf} is already revalued —{" "}
              <Link href="/accounting/journals" className="sw-link">{p.reference}</Link>
              {p.reversalReference && <> , reversed on {p.reversalDate} as {p.reversalReference}</>}. Running it
              again returns the same entry rather than doubling the adjustment.
            </div>
          )}

          {p.blockers.map((b, i) => (
            <div key={i} className="sw-error mb-3" role="alert" data-testid="revaluation-blocker">{b}</div>
          ))}

          <Panel className="mb-4 overflow-hidden">
            <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
              <span className="sw-label">Monetary balances at {p.asOf}</span>
            </div>
            {p.rows.length === 0 ? (
              <p className="sw-sub p-3" data-testid="nothing-to-revalue">
                Nothing to revalue at {p.asOf}. Either there are no foreign-currency monetary balances, or they are
                already carried at the closing rate.
              </p>
            ) : (
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Foreign currency revaluation</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "5rem" }}>Account</th>
                      <th>Name</th>
                      <th style={{ width: "4rem" }}>Cur</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Balance</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Carried at</th>
                      <th className="sw-num" style={{ width: "6rem" }}>Rate</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Worth</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.rows.map((r) => (
                      <tr key={`${r.account}-${r.currency}`} data-testid={`reval-${r.account}-${r.currency}`}>
                        <td className="sw-code">
                          <Link href={`/accounting/accounts/${r.account}`} className="sw-link">{r.account}</Link>
                        </td>
                        <td className="max-w-0 truncate">{r.name}</td>
                        <td>{r.currency}</td>
                        <td className="sw-num"><Figure minor={r.txnBalanceMinor} currency={r.currency} colour={false} /></td>
                        <td className="sw-num"><Figure minor={r.carryingMinor} currency={p.functionalCurrency} colour={false} /></td>
                        <td className="sw-num">
                          {r.rate}
                          <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>{r.rateDate}</span>
                        </td>
                        <td className="sw-num"><Figure minor={r.revaluedMinor} currency={p.functionalCurrency} colour={false} /></td>
                        <td className="sw-num">
                          <Figure minor={r.differenceMinor} currency={p.functionalCurrency} />
                          <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>
                            {r.gain ? "gain" : "loss"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={7} style={{ textAlign: "start" }}>
                        Unrealised gain to 4950, loss to 6800
                      </th>
                      <td className="sw-num" data-testid="net-difference">
                        <Figure minor={p.netDifferenceMinor} currency={p.functionalCurrency} zero="zero" />
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            {p.reversalDate && p.rows.length > 0 && (
              <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
                The difference is unrealised, so the entry reverses on {p.reversalDate}. The next period then starts
                from the original carrying amount and the settlement books the whole realised difference once —
                leaving it in place would count part of it twice.
              </p>
            )}
          </Panel>

          {p.skipped.length > 0 && (
            <Panel className="mb-4 p-3">
              <div className="sw-label">Left alone, and why</div>
              <ul className="mt-1.5 space-y-1">
                {p.skipped.map((s) => (
                  <li key={`${s.account}-${s.currency}`} className="sw-sub" data-testid={`skipped-${s.account}`}>
                    <span className="sw-code">{s.account}</span> {s.name} ({s.currency}) — {s.reason}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Rates
            rates={p.rates}
            functional={p.functionalCurrency}
            asOf={p.asOf}
            busy={busy === "set-rate"}
            onSet={async (r) => {
              const done = await act("set-rate", { action: "set-rate", ...r });
              if (done) setMsg(`Recorded ${r.currency} at ${r.rate} for ${r.rateDate}.`);
            }}
          />
        </>
      )}
    </>
  );
}

function Rates({ rates, functional, asOf, busy, onSet }: {
  rates: Rate[];
  functional: string;
  asOf: string;
  busy: boolean;
  onSet: (r: { currency: string; rate: string; rateDate: string }) => void;
}) {
  const [currency, setCurrency] = React.useState("USD");
  const [rate, setRate] = React.useState("");
  const [rateDate, setRateDate] = React.useState(asOf);

  React.useEffect(() => { setRateDate(asOf); }, [asOf]);

  const cur = currency.trim().toUpperCase();
  const blocker =
    !/^[A-Z]{3}$/.test(cur) ? "A currency is a three-letter code, such as USD." :
    cur === functional ? `${functional} is the functional currency. It has no rate to itself.` :
    !/^\d*\.?\d+$/.test(rate.trim()) || Number(rate) <= 0
      ? "A rate is a positive number, such as 3.6725 — a zero or negative rate would erase or invert every balance it touched."
      : null;

  return (
    <Panel className="p-4">
      <div className="sw-label">Rates on file</div>
      <p className="sw-sub mt-1 max-w-[70ch]">
        The closing rate is the most recent rate recorded on or before the revaluation date. A currency with
        nothing on file blocks the run by design — a guessed rate produces a difference that looks authoritative
        and is not.
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="sw-label">Currency</span>
          <span className="mt-1 block">
            <input
              className="sw-input" style={{ width: "6rem" }} value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())} placeholder="USD"
            />
          </span>
        </label>
        <label className="block">
          <span className="sw-label">Rate to {functional}</span>
          <span className="mt-1 block">
            <input
              className="sw-input sw-cell-num" style={{ width: "9rem" }} inputMode="decimal"
              value={rate} onChange={(e) => setRate(e.target.value)} placeholder="3.6725"
            />
          </span>
        </label>
        <label className="block">
          <span className="sw-label">Applies from</span>
          <span className="mt-1 block">
            <input type="date" className="sw-input" style={{ width: "10rem" }} value={rateDate} onChange={(e) => setRateDate(e.target.value)} />
          </span>
        </label>
        <button
          type="button"
          className="sw-btn"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid="save-rate"
          onClick={() => onSet({ currency: cur, rate: rate.trim(), rateDate })}
        >
          {busy ? "Saving…" : "Record rate"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="rate-blocker">{blocker}</span>}
      </div>

      {rates.length === 0 ? (
        <div className="mt-3"><Empty>No rates recorded yet.</Empty></div>
      ) : (
        <div className="sw-scroll mt-3">
          <table className="sw-table" style={{ maxWidth: "34rem" }}>
            <caption className="sr-only">Exchange rates on file</caption>
            <thead>
              <tr>
                <th style={{ width: "5rem" }}>Currency</th>
                <th className="sw-num" style={{ width: "9rem" }}>Rate</th>
                <th style={{ width: "8rem" }}>Date</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((r) => (
                <tr key={`${r.currency}-${r.rateDate}`}>
                  <td className="sw-code">{r.currency}</td>
                  <td className="sw-num">{r.rate}</td>
                  <td>{r.rateDate}</td>
                  <td style={{ color: "var(--sw-fg-muted)" }}>{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
