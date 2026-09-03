"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, StatusChip } from "@/components/ledger/primitives";

interface CheckResult {
  key: string; label: string; severity: "blocker" | "advisory" | "done";
  detail: string; href: string; amountMinor?: string; count?: number;
}
interface MonthEnd {
  period: string; startsOn: string; endsOn: string; status: string;
  checks: CheckResult[];
  failed: { key: string; label: string; reason: string }[];
  blockers: number; advisories: number; canClose: boolean; note: string;
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

const HEADING: Record<CheckResult["severity"], string> = {
  blocker: "Would make the month wrong",
  advisory: "Worth doing first",
  done: "Done",
};

const EXPLAIN: Record<CheckResult["severity"], string> = {
  blocker: "Close over one of these and the month stays wrong. A hard-closed month can be reopened; a locked one never can.",
  advisory: "None of these would make the month untrue. They are things the books would be better for.",
  done: "Checked and settled.",
};

export default function MonthEndPage() {
  const entityId = useEntityId();
  const [period, setPeriod] = React.useState(thisMonth);
  const { data, error, loading, reload } = useLedgerQuery<MonthEnd>(
    entityId ? `/api/ledger/month-end?entityId=${entityId}&period=${period}` : null,
    [period],
  );
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const close = async (acceptAdvisories: boolean) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api<{ note: string }>("/api/ledger/month-end", {
        method: "POST", body: JSON.stringify({ entityId, period, acceptAdvisories }),
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

  const groups: CheckResult["severity"][] = ["blocker", "advisory", "done"];

  return (
    <>
      <PageHead
        title="Month end"
        sub={
          "Not a list of nags — the last look before a door shuts. A closed month can be reopened by somebody with " +
          "the permission; a locked one never can. So the things that would make the month wrong are kept apart " +
          "from the things that would merely be better done first."
        }
        actions={
          <label className="flex items-center gap-1.5">
            <span className="sw-label">Month</span>
            <input type="month" className="sw-input" style={{ width: "9rem" }} value={period}
              onChange={(e) => setPeriod(e.target.value)} aria-label="Month to check" />
          </label>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="month-end-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {data && (
        <>
          <Panel className="mb-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="sw-label">{data.period}</div>
                <p className="sw-sub mt-1">{data.startsOn} to {data.endsOn}</p>
                <div className="mt-2"><StatusChip status={data.status} /></div>
              </div>
              <div className="max-w-[42ch]">
                <div className="sw-label">Where it stands</div>
                <p className="sw-sub mt-1" data-testid="month-end-note">{data.note}</p>
              </div>
              <div>
                <div className="sw-label">Close it</div>
                <div className="mt-1 flex flex-wrap gap-2">
                  <button type="button" className="sw-btn sw-btn-primary" data-testid="close-month"
                    disabled={!data.canClose || busy || data.status === "locked"}
                    aria-disabled={!data.canClose || undefined}
                    onClick={() => close(false)}>
                    {busy ? "Closing…" : data.status === "open" ? "Soft close" : "Hard close"}
                  </button>
                  {data.canClose && data.advisories > 0 && (
                    <button type="button" className="sw-btn" disabled={busy} onClick={() => close(true)}>
                      Close over the {data.advisories} advisor{data.advisories === 1 ? "y" : "ies"}
                    </button>
                  )}
                </div>
                <p className="sw-sub mt-2 max-w-[32ch]">
                  A month closes one state at a time — open, soft closed, hard closed — so it never skips a state
                  something else relies on.
                </p>
              </div>
            </div>
          </Panel>

          {data.failed.length > 0 && (
            <Panel className="mb-4 p-3">
              <div className="sw-label" style={{ color: "var(--sw-neg)" }}>Could not be checked</div>
              <ul className="mt-1.5 space-y-0.5" data-testid="month-end-failed">
                {data.failed.map((f) => (
                  <li key={f.key} className="sw-sub"><span className="sw-code">{f.label}</span> — {f.reason}</li>
                ))}
              </ul>
              <p className="sw-sub mt-2 max-w-[70ch]">
                A check that did not run is not a check that passed, so the month is not offered for closing until
                these can be answered.
              </p>
            </Panel>
          )}

          {groups.map((severity) => {
            const rows = data.checks.filter((c) => c.severity === severity);
            if (!rows.length) return null;
            return (
              <Panel key={severity} className="mb-4 overflow-hidden">
                <div className="p-3 pb-0">
                  <div className="sw-label" style={severity === "blocker" ? { color: "var(--sw-neg)" } : undefined}>
                    {HEADING[severity]}
                  </div>
                  <p className="sw-sub mt-1 max-w-[70ch]">{EXPLAIN[severity]}</p>
                </div>
                <table className="sw-table mt-2">
                  <caption className="sr-only">{HEADING[severity]} for {data.period}</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "18rem" }}>Check</th>
                      <th>What it found</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                      <th style={{ width: "6rem" }} />
                    </tr>
                  </thead>
                  <tbody data-testid={`month-end-${severity}`}>
                    {rows.map((c) => (
                      <tr key={c.key}>
                        <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>{c.label}</th>
                        <td className="sw-sub">{c.detail}</td>
                        <td className="sw-num">
                          {c.amountMinor ? <Figure minor={c.amountMinor} /> : c.count !== undefined ? c.count : <span className="sw-sub">—</span>}
                        </td>
                        <td>
                          <Link href={`${c.href}`} className="sw-link-btn">Go</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            );
          })}
        </>
      )}
    </>
  );
}
