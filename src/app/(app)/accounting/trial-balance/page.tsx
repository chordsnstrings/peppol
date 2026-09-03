"use client";

import * as React from "react";
import Link from "next/link";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

interface Period { id: string; label: string; status: string; startsOn: string; endsOn: string }
interface Row { accountId: string; code: string; name: string; nameAr: string | null; type: string; debitMinor: string; creditMinor: string; balanceMinor: string }
interface TB { currency: string; periodLabel: string; rows: Row[]; totalDebitMinor: string; totalCreditMinor: string; differenceMinor: string; balanced: boolean }

const TYPE_ORDER = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
const TYPE_LABEL: Record<string, string> = {
  ASSET: "Assets", LIABILITY: "Liabilities", EQUITY: "Equity", INCOME: "Income", EXPENSE: "Expenses",
};

export default function TrialBalancePage() {
  const entityId = useEntityId();
  const periodsQ = useLedgerQuery<{ periods: Period[] }>(entityId ? `/api/ledger/periods?entityId=${entityId}` : null);
  const [period, setPeriod] = React.useState<string>("");

  const periods = periodsQ.data?.periods ?? [];
  React.useEffect(() => {
    if (period || !periods.length) return;
    // Open on the period covering today. Defaulting to the first *open* period
    // shows an empty statement for a whole year of books opened in January.
    const today = new Date().toISOString().slice(0, 10);
    const current = periods.find((p) => today >= p.startsOn.slice(0, 10) && today <= p.endsOn.slice(0, 10));
    setPeriod((current ?? periods[periods.length - 1]).label);
  }, [periods, period]);

  const tb = useLedgerQuery<TB>(
    entityId && period ? `/api/ledger/trial-balance?entityId=${entityId}&period=${encodeURIComponent(period)}` : null,
  );

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const rows = tb.data?.rows ?? [];
  const byType = TYPE_ORDER.map((t) => [t, rows.filter((r) => r.type === t)] as const).filter(([, rs]) => rs.length);

  return (
    <>
      <PageHead
        title="Trial balance"
        sub="Cumulative to the end of the chosen period, read from period-anchored balances rather than summed across the whole ledger — so it answers as fast on the ten-millionth line as on the first."
        actions={
          <label className="flex items-center gap-2">
            <span className="sw-label">Period</span>
            <select className="sw-select" value={period} onChange={(e) => setPeriod(e.target.value)} style={{ width: "10rem" }}>
              {periods.map((p) => <option key={p.id} value={p.label}>{p.label}</option>)}
            </select>
          </label>
        }
      />

      {periodsQ.error && <ErrorNote>{periodsQ.error}</ErrorNote>}
      {tb.error && <ErrorNote>{tb.error}</ErrorNote>}
      {(tb.loading || periodsQ.loading) && <Loading />}
      {!tb.loading && !tb.error && tb.data && rows.length === 0 && (
        <Empty>Nothing has been posted to {period} yet.</Empty>
      )}

      {tb.data && rows.length > 0 && (
        <Panel className="overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Trial balance as at the end of {tb.data.periodLabel}, in {tb.data.currency}</caption>
              <thead>
                <tr>
                  <th style={{ width: "6rem" }}>Code</th>
                  <th>Account</th>
                  <th className="sw-col-debit sw-num" style={{ width: "var(--sw-col-amount)" }}>Debit</th>
                  <th className="sw-col-credit sw-num" style={{ width: "var(--sw-col-amount)" }}>Credit</th>
                </tr>
              </thead>
              {byType.map(([type, rs]) => (
                <tbody key={type}>
                  <tr>
                    <td colSpan={4} style={{ background: "var(--sw-surface-2)", height: "1.75rem" }}>
                      <span className="sw-label">{TYPE_LABEL[type]}</span>
                    </td>
                  </tr>
                  {rs.map((r) => {
                    const bal = BigInt(r.balanceMinor);
                    return (
                      <tr key={r.accountId}>
                        <td className="sw-code">
                          <Link href={`/accounting/accounts/${encodeURIComponent(r.code)}`} className="sw-link">{r.code}</Link>
                        </td>
                        <td>{r.name}</td>
                        <td className="sw-num">{bal > 0n ? <Figure minor={bal} currency={tb.data!.currency} colour={false} /> : <span className="sw-zero">–</span>}</td>
                        <td className="sw-num">{bal < 0n ? <Figure minor={-bal} currency={tb.data!.currency} colour={false} /> : <span className="sw-zero">–</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
              <tfoot>
                <tr>
                  <td colSpan={2} style={{ textAlign: "end" }}>Totals ({tb.data.currency})</td>
                  <td className="sw-num" data-testid="tb-debit"><Figure minor={tb.data.totalDebitMinor} currency={tb.data.currency} zero="zero" colour={false} /></td>
                  <td className="sw-num" data-testid="tb-credit"><Figure minor={tb.data.totalCreditMinor} currency={tb.data.currency} zero="zero" colour={false} /></td>
                </tr>
                {!tb.data.balanced && (
                  <tr>
                    <td colSpan={2} style={{ textAlign: "end", color: "var(--sw-neg)" }}>Out of balance</td>
                    <td className="sw-num sw-num-neg" colSpan={2}>
                      <Figure minor={tb.data.differenceMinor} currency={tb.data.currency} zero="zero" />
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            {tb.data.balanced
              ? "Debits equal credits."
              : "Debits and credits disagree. Every posting path in this system is checked by a database constraint, so this indicates a defect — please report it rather than adjusting to fit."}
          </p>
        </Panel>
      )}
    </>
  );
}
