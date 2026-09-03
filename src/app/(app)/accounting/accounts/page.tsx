"use client";

import * as React from "react";
import Link from "next/link";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

interface Account {
  id: string; code: string; name: string; nameAr: string | null; type: string;
  subtype: string | null; parentId: string | null; isPostable: boolean;
  isControl: boolean; currency: string | null; status: string;
}

const TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;
const TYPE_LABEL: Record<string, string> = {
  ASSET: "Assets", LIABILITY: "Liabilities", EQUITY: "Equity", INCOME: "Income", EXPENSE: "Expenses",
};

export default function ChartOfAccounts() {
  const entityId = useEntityId();
  const [q, setQ] = React.useState("");
  const [type, setType] = React.useState<string>("");
  const { data, error, loading } = useLedgerQuery<{ accounts: Account[] }>(
    entityId ? `/api/ledger/accounts?entityId=${entityId}` : null,
  );

  const accounts = React.useMemo(() => {
    const all = data?.accounts ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((a) => {
      if (type && a.type !== type) return false;
      if (!needle) return true;
      // One field matching both a code prefix and a name — a bookkeeper who
      // knows "1100" and one who knows "receivables" both find it here.
      return a.code.toLowerCase().startsWith(needle) || a.name.toLowerCase().includes(needle) || (a.nameAr ?? "").includes(q.trim());
    });
  }, [data, q, type]);

  const grouped = React.useMemo(() => {
    const m = new Map<string, Account[]>();
    for (const a of accounts) m.set(a.type, [...(m.get(a.type) ?? []), a]);
    return m;
  }, [accounts]);

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Chart of accounts"
        sub="The accounts every journal line has to land in. Control accounts (receivables, payables, VAT) are fed by their subledgers and refuse a manual journal — that is what keeps the subledger and the ledger from disagreeing."
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="acct-search">Search accounts</label>
        <input
          id="acct-search"
          className="sw-input max-w-[22rem]"
          placeholder="Code or name — 1100, receivables, الذمم"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="sr-only" htmlFor="acct-type">Account type</label>
        <select id="acct-type" className="sw-select max-w-[12rem]" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
        <span className="sw-sub ms-auto" aria-live="polite">
          {loading ? "" : `${accounts.length} account${accounts.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading />}
      {!loading && !error && accounts.length === 0 && (
        <Empty>
          No accounts match. If the books are not open yet, start from the{" "}
          <Link href="/accounting" className="sw-link">Accounting overview</Link>.
        </Empty>
      )}

      {TYPES.filter((t) => grouped.has(t)).map((t) => (
        <Panel key={t} className="mb-4 overflow-hidden">
          <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
            <span className="sw-label">{TYPE_LABEL[t]}</span>
          </div>
          <div className="sw-scroll">
            <table className="sw-table">
              <thead>
                <tr>
                  <th style={{ width: "6rem" }}>Code</th>
                  <th>Name</th>
                  <th className="hidden md:table-cell">العربية</th>
                  <th style={{ width: "9rem" }}>Kind</th>
                </tr>
              </thead>
              <tbody>
                {(grouped.get(t) ?? []).map((a) => (
                  <tr key={a.id}>
                    <td className="sw-code">
                      {a.isPostable ? (
                        <Link href={`/accounting/accounts/${encodeURIComponent(a.code)}`} className="sw-link">{a.code}</Link>
                      ) : a.code}
                    </td>
                    <td style={{ paddingInlineStart: a.parentId ? "1.5rem" : undefined }}>
                      <span style={{ fontWeight: a.isPostable ? 400 : 600 }}>{a.name}</span>
                    </td>
                    <td className="hidden md:table-cell" dir="rtl" style={{ color: "var(--sw-fg-muted)" }}>{a.nameAr ?? ""}</td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {!a.isPostable && <span className="sw-chip">header</span>}
                        {a.isControl && <span className="sw-chip sw-chip-accent" title="Fed by its subledger — manual journals are refused">control</span>}
                        {a.currency && <span className="sw-chip">{a.currency}</span>}
                        {a.status !== "active" && <span className="sw-chip sw-chip-warn">{a.status}</span>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ))}
    </>
  );
}
