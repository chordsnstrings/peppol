"use client";

import * as React from "react";
import { useEntityId, useLedgerQuery, api, ApiError } from "@/components/ledger/use-ledger";
import { PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";

interface Period {
  id: string; label: string; seq: number; startsOn: string; endsOn: string;
  status: string; isAdjustment: boolean; closedAt: string | null;
}

/** Mirrors the server's transition map — the server is still the authority. */
const NEXT: Record<string, { to: string; label: string; warn?: string }[]> = {
  open: [{ to: "soft_closed", label: "Soft close" }],
  soft_closed: [
    { to: "open", label: "Reopen" },
    { to: "hard_closed", label: "Hard close" },
  ],
  hard_closed: [{ to: "locked", label: "Lock", warn: "A locked period never reopens. Corrections after this point have to be posted into an open period." }],
  locked: [],
};

const EXPLAIN: Record<string, string> = {
  open: "Entries can be posted.",
  soft_closed: "Closed to routine posting, still reversible by an administrator.",
  hard_closed: "Closed. Only a lock remains.",
  locked: "Sealed permanently. Correct in a later period.",
};

export default function PeriodsPage() {
  const entityId = useEntityId();
  const { data, error, loading, reload } = useLedgerQuery<{ periods: Period[] }>(
    entityId ? `/api/ledger/periods?entityId=${entityId}` : null,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const move = async (p: Period, to: string, warn?: string) => {
    if (warn && !window.confirm(`${warn}\n\nLock ${p.label}?`)) return;
    setBusy(p.id);
    setActionError(null);
    try {
      await api("/api/ledger/periods", { method: "PATCH", body: JSON.stringify({ periodId: p.id, status: to }) });
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "That period could not be changed.");
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const periods = data?.periods ?? [];

  return (
    <>
      <PageHead
        title="Accounting periods"
        sub="Periods move one way: open → soft closed → hard closed → locked. A locked period never reopens, which is the point — it is what lets a filed return stay true."
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {actionError && <ErrorNote>{actionError}</ErrorNote>}
      {loading && <Loading />}
      {!loading && !error && periods.length === 0 && <Empty>The books are not open yet.</Empty>}

      {periods.length > 0 && (
        <Panel className="overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Accounting periods and the state each one is in</caption>
              <thead>
                <tr>
                  <th style={{ width: "9rem" }}>Period</th>
                  <th style={{ width: "7rem" }}>From</th>
                  <th style={{ width: "7rem" }}>To</th>
                  <th style={{ width: "8rem" }}>Status</th>
                  <th className="hidden md:table-cell">What that means</th>
                  <th style={{ width: "14rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id}>
                    <td className="sw-code">
                      {p.label}
                      {p.isAdjustment && <span className="sw-chip ms-1">adjustment</span>}
                    </td>
                    <td>{p.startsOn.slice(0, 10)}</td>
                    <td>{p.endsOn.slice(0, 10)}</td>
                    <td><StatusChip status={p.status} /></td>
                    <td className="hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>{EXPLAIN[p.status]}</td>
                    <td>
                      <span className="flex flex-wrap gap-1.5 py-1">
                        {(NEXT[p.status] ?? []).map((n) => (
                          <button
                            key={n.to}
                            type="button"
                            className="sw-btn sw-btn-sm"
                            disabled={busy === p.id}
                            onClick={() => move(p, n.to, n.warn)}
                          >
                            {busy === p.id ? "…" : n.label}
                          </button>
                        ))}
                        {p.status === "locked" && <span className="sw-sub">—</span>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
