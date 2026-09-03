"use client";

import * as React from "react";
import Link from "next/link";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

interface Ageing {
  asOf: string;
  buckets: Record<string, string>;
  totalMinor: string;
  open: { sourceId: string; memo: string; date: string; outstandingMinor: string; daysOld: number }[];
}

const BUCKETS: { key: string; label: string; hint: string }[] = [
  { key: "current", label: "Current", hint: "0–30 days" },
  { key: "d30", label: "31–60", hint: "one month late" },
  { key: "d60", label: "61–90", hint: "two months late" },
  { key: "d90", label: "91–120", hint: "three months late" },
  { key: "d90plus", label: "120+", hint: "provision territory" },
];

export default function ReceivablesPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(() => new Date().toISOString().slice(0, 10));
  const { data, error, loading } = useLedgerQuery<Ageing>(
    entityId ? `/api/ledger/ar/ageing?entityId=${entityId}&asOf=${asOf}` : null,
  );

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Receivables"
        sub="What customers still owe, netted document by document straight from the ledger. A payment is matched to the invoice it settles, so a paid invoice leaves this report rather than lingering in it."
        actions={
          <label className="flex items-center gap-1.5">
            <span className="sw-label">As at</span>
            <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading />}

      {data && (
        <>
          <Panel className="mb-4 p-4">
            <div className="sw-label">Ageing</div>
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
              {BUCKETS.map((b) => (
                <div key={b.key}>
                  <div className="sw-label">{b.label}</div>
                  <div className="mt-0.5 text-[0.9375rem] font-semibold tabular-nums">
                    <Figure minor={data.buckets[b.key] ?? "0"} />
                  </div>
                  <div className="text-[0.6875rem]" style={{ color: "var(--sw-fg-faint)" }}>{b.hint}</div>
                </div>
              ))}
              <div style={{ borderInlineStart: "2px solid var(--sw-line-strong)", paddingInlineStart: "0.75rem" }}>
                <div className="sw-label">Total owed</div>
                <div className="mt-0.5 text-[1.0625rem] font-semibold tabular-nums">
                  <Figure minor={data.totalMinor} zero="zero" />
                </div>
              </div>
            </div>
          </Panel>

          {data.open.length === 0 ? (
            <Empty>Nothing is outstanding as at {data.asOf}. Every invoice raised has been settled.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Open receivables as at {data.asOf}</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "7rem" }}>Raised</th>
                      <th>Document</th>
                      <th className="sw-num" style={{ width: "6rem" }}>Age</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.open.map((o) => (
                      <tr key={o.sourceId}>
                        <td>{o.date}</td>
                        <td className="max-w-0 truncate">
                          <Link href={`/invoices/${encodeURIComponent(o.sourceId)}`} className="sw-link">
                            {o.memo || o.sourceId}
                          </Link>
                        </td>
                        <td className="sw-num">
                          {o.daysOld} d
                          {o.daysOld > 120 && <span className="sw-chip sw-chip-bad ms-1">overdue</span>}
                        </td>
                        <td className="sw-num"><Figure minor={o.outstandingMinor} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={3} style={{ textAlign: "end" }}>Total</th>
                      <td className="sw-num" data-testid="ar-total"><Figure minor={data.totalMinor} zero="zero" /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
                This ties to account 1100 Trade receivables on the trial balance —{" "}
                <Link href="/accounting/accounts/1100" className="sw-link">open the control account</Link> to see
                every movement behind it.
              </p>
            </Panel>
          )}
        </>
      )}
    </>
  );
}
