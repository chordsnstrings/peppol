"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";

interface Preview {
  fiscalYear: string; startsOn: string; endsOn: string; currency: string;
  lines: { code: string; name: string; type: string; balanceMinor: string; closingMinor: string }[];
  netProfitMinor: string; retainedEarningsAccount: string;
  blockers: string[]; alreadyClosed: boolean; closingReference: string | null;
}
interface Period { id: string; label: string; status: string; isAdjustment: boolean }

export default function YearEndPage() {
  const entityId = useEntityId();
  const [year, setYear] = React.useState(() => String(new Date().getUTCFullYear()));
  const [lockPeriods, setLockPeriods] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const periods = useLedgerQuery<{ periods: Period[] }>(entityId ? `/api/ledger/periods?entityId=${entityId}` : null);
  const q = useLedgerQuery<Preview>(
    entityId ? `/api/ledger/close?entityId=${entityId}&fiscalYear=${year}` : null,
    [year],
  );

  const years = React.useMemo(() => {
    const set = new Set((periods.data?.periods ?? []).map((p) => p.label.slice(0, 4)));
    const now = String(new Date().getUTCFullYear());
    set.add(now);
    return [...set].sort();
  }, [periods.data]);

  const act = async (action: "close" | "open-next") => {
    setBusy(action); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/close", {
        method: "POST",
        body: JSON.stringify({ entityId, fiscalYear: year, action, lockPeriods }),
      });
      if (action === "close") {
        setMsg(
          r.alreadyClosed
            ? `${year} was already closed as ${r.reference}.`
            : `Closed ${year} as ${r.reference}. ${r.accountsClosed} accounts brought to zero` +
              (Number(r.periodsLocked) > 0 ? `, ${r.periodsLocked} periods locked` : "") + ".",
        );
      } else {
        setMsg(r.created ? `Opened ${r.label} with ${r.periods} periods.` : `${r.label} was already open.`);
      }
      q.reload();
      periods.reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const p = q.data;
  const canClose = p && !p.alreadyClosed && p.blockers.length === 0 && p.lines.length > 0;

  return (
    <>
      <PageHead
        title="Year end"
        sub="Closing a year is one journal entry: every income and expense account brought to zero against retained earnings. The balance sheet carries itself, because balance-sheet accounts simply accumulate — nothing is copied forward, so nothing can disagree."
        actions={
          <label className="flex items-center gap-2">
            <span className="sw-label">Fiscal year</span>
            <select className="sw-select" style={{ width: "7rem" }} value={year} onChange={(e) => setYear(e.target.value)}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="close-result">{msg}</div>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !p && <Loading />}

      {p && (
        <>
          {p.alreadyClosed && (
            <div className="sw-note mb-4" data-testid="already-closed">
              {p.fiscalYear} is closed. The closing entry is{" "}
              <Link href="/accounting/journals" className="sw-link">{p.closingReference}</Link>. The year stays
              fully readable — closing archives nothing.
            </div>
          )}

          {p.blockers.map((b, i) => (
            <div key={i} className="sw-error mb-3" role="alert" data-testid="close-blocker">{b}</div>
          ))}

          <Panel className="mb-4 overflow-hidden">
            <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
              <span className="sw-label">
                What closing {p.fiscalYear} does — {p.startsOn} to {p.endsOn}
              </span>
            </div>
            {p.lines.length === 0 ? (
              <p className="sw-sub p-3">
                No income or expenses were posted in {p.fiscalYear}. There is nothing to carry to retained earnings.
              </p>
            ) : (
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Accounts that will be closed for {p.fiscalYear}</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "6rem" }}>Code</th>
                      <th>Account</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Balance now</th>
                      <th className="sw-col-debit sw-num" style={{ width: "var(--sw-col-amount)" }}>Debit</th>
                      <th className="sw-col-credit sw-num" style={{ width: "var(--sw-col-amount)" }}>Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.lines.map((l) => {
                      const c = BigInt(l.closingMinor);
                      return (
                        <tr key={l.code}>
                          <td className="sw-code">{l.code}</td>
                          <td>{l.name}</td>
                          <td className="sw-num"><Figure minor={l.balanceMinor} currency={p.currency} /></td>
                          <td className="sw-num">{c > 0n ? <Figure minor={c} currency={p.currency} colour={false} /> : <span className="sw-zero">–</span>}</td>
                          <td className="sw-num">{c < 0n ? <Figure minor={-c} currency={p.currency} colour={false} /> : <span className="sw-zero">–</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={2} style={{ textAlign: "end" }}>
                        {BigInt(p.netProfitMinor) >= 0n ? "Profit" : "Loss"} to {p.retainedEarningsAccount} Retained earnings
                      </th>
                      <td className="sw-num" data-testid="close-result-amount">
                        <Figure minor={p.netProfitMinor} currency={p.currency} zero="zero" />
                      </td>
                      <td className="sw-num">
                        {BigInt(p.netProfitMinor) < 0n ? <Figure minor={-BigInt(p.netProfitMinor)} currency={p.currency} colour={false} /> : <span className="sw-zero">–</span>}
                      </td>
                      <td className="sw-num">
                        {BigInt(p.netProfitMinor) > 0n ? <Figure minor={p.netProfitMinor} currency={p.currency} colour={false} /> : <span className="sw-zero">–</span>}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Panel>

          <Panel className="p-4">
            <div className="sw-label">Close the year</div>
            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={lockPeriods}
                onChange={(e) => setLockPeriods(e.target.checked)}
                data-testid="lock-periods"
              />
              <span className="text-[0.8125rem]">
                Lock every period in {p.fiscalYear} afterwards.
                <span className="sw-sub block">
                  A locked period never reopens. That is what lets a filed return stay true — and it means a
                  correction has to be posted into a later period instead. Leave this off until the year is
                  genuinely finished.
                </span>
              </span>
            </label>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="sw-btn sw-btn-primary"
                onClick={() => act("close")}
                aria-disabled={!canClose || busy !== null || undefined}
                disabled={!canClose || busy !== null}
                data-testid="close-year"
              >
                {busy === "close" ? "Closing…" : `Close ${p.fiscalYear}`}
              </button>
              <button
                type="button"
                className="sw-btn"
                onClick={() => act("open-next")}
                disabled={busy !== null}
                data-testid="open-next-year"
              >
                {busy === "open-next" ? "Opening…" : "Open the next year"}
              </button>
              {!canClose && !p.alreadyClosed && (
                <span className="sw-sub" role="status">
                  {p.blockers[0] ?? "There is nothing to close."}
                </span>
              )}
            </div>

            <p className="sw-sub mt-3 max-w-[70ch]">
              Opening the next year creates its periods and nothing else. There is no opening-balance journal
              because there does not need to be one: balance-sheet accounts accumulate across years by
              themselves, and the profit and loss starts at zero because this close brought it there.
            </p>
          </Panel>
        </>
      )}
    </>
  );
}
