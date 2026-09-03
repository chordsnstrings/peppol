"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEntityId, useLedgerQuery, api, ApiError } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";

interface Line { id: string; lineNo: number; txnAmountMinor: string; txnCurrency: string; memo: string | null; account: { code: string; name: string } }
interface Entry {
  id: string; series: string; number: number; entryDate: string; memo: string | null;
  status: string; source: string; actorType: string;
  period: { label: string; status: string } | null;
  reversalOfId: string | null;
  lines: Line[];
}

export default function JournalRegister() {
  const entityId = useEntityId();
  const posted = useSearchParams().get("posted");
  const { data, error, loading, reload } = useLedgerQuery<{ entries: Entry[] }>(
    entityId ? `/api/ledger/journals?entityId=${entityId}&limit=100` : null,
  );
  const [open, setOpen] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const reverse = async (id: string, reference: string) => {
    setBusy(id);
    setActionError(null);
    try {
      await api(`/api/ledger/journals/${id}/reverse`, {
        method: "POST",
        body: JSON.stringify({ memo: `Reversal of ${reference}` }),
      });
      reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "The entry could not be reversed.");
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const entries = data?.entries ?? [];

  return (
    <>
      <PageHead
        title="Journal register"
        sub="Every posted entry, newest first. A posted entry is never edited or deleted — a mistake is corrected by a reversal, so the record of what was thought at the time survives."
        actions={<Link href="/accounting/journals/new" className="sw-btn sw-btn-primary">New entry</Link>}
      />

      {posted && (
        <div className="sw-note mb-3" role="status">
          Posted <strong>{posted}</strong>.
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {actionError && <ErrorNote>{actionError}</ErrorNote>}
      {loading && <Loading />}
      {!loading && !error && entries.length === 0 && (
        <Empty>
          Nothing has been posted yet. <Link href="/accounting/journals/new" className="sw-link">Post the first entry</Link>.
        </Empty>
      )}

      {entries.length > 0 && (
        <Panel className="overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <thead>
                <tr>
                  <th style={{ width: "2.25rem" }}><span className="sr-only">Expand</span></th>
                  <th style={{ width: "8rem" }}>Reference</th>
                  <th style={{ width: "7rem" }}>Date</th>
                  <th>Description</th>
                  <th className="hidden sm:table-cell" style={{ width: "7rem" }}>Period</th>
                  <th className="hidden md:table-cell" style={{ width: "8rem" }}>Source</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                  <th style={{ width: "6rem" }}>Status</th>
                  <th style={{ width: "6rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const reference = `${e.series}-${e.number}`;
                  const total = e.lines.reduce((a, l) => a + (BigInt(l.txnAmountMinor) > 0n ? BigInt(l.txnAmountMinor) : 0n), 0n);
                  const expanded = open === e.id;
                  return (
                    <React.Fragment key={e.id}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-label={`${expanded ? "Collapse" : "Expand"} ${reference}`}
                            onClick={() => setOpen(expanded ? null : e.id)}
                            className="px-1"
                            style={{ color: "var(--sw-fg-muted)" }}
                          >
                            {expanded ? "▾" : "▸"}
                          </button>
                        </td>
                        <td className="sw-code">{reference}</td>
                        <td>{e.entryDate.slice(0, 10)}</td>
                        <td className="max-w-0 truncate">{e.memo ?? <span className="sw-zero">–</span>}</td>
                        <td className="hidden sm:table-cell sw-code">{e.period?.label ?? "–"}</td>
                        <td className="hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>
                          {e.source}
                          {e.actorType !== "HUMAN" && <span className="sw-chip ms-1">{e.actorType.toLowerCase()}</span>}
                        </td>
                        <td className="sw-num"><Figure minor={total} currency={e.lines[0]?.txnCurrency ?? "AED"} colour={false} /></td>
                        <td><StatusChip status={e.status} /></td>
                        <td>
                          {e.status === "posted" && !e.reversalOfId && (
                            <button
                              type="button"
                              className="sw-link text-[0.8125rem]"
                              onClick={() => reverse(e.id, reference)}
                              disabled={busy === e.id}
                            >
                              {busy === e.id ? "Reversing…" : "Reverse"}
                            </button>
                          )}
                        </td>
                      </tr>
                      {expanded &&
                        e.lines.map((l) => {
                          const amt = BigInt(l.txnAmountMinor);
                          return (
                            <tr key={l.id} style={{ background: "var(--sw-surface-2)" }}>
                              <td />
                              <td className="sw-code" style={{ paddingInlineStart: "1.5rem" }}>
                                <Link href={`/accounting/accounts/${encodeURIComponent(l.account.code)}`} className="sw-link">
                                  {l.account.code}
                                </Link>
                              </td>
                              <td colSpan={4}>
                                {l.account.name}
                                {l.memo && <span style={{ color: "var(--sw-fg-muted)" }}> — {l.memo}</span>}
                              </td>
                              <td className="sw-num">
                                {amt > 0n ? <Figure minor={amt} currency={l.txnCurrency} colour={false} /> : <span className="sw-zero">–</span>}
                              </td>
                              <td className="sw-num" colSpan={2}>
                                {amt < 0n ? <Figure minor={-amt} currency={l.txnCurrency} colour={false} /> : <span className="sw-zero">–</span>}
                              </td>
                            </tr>
                          );
                        })}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}
