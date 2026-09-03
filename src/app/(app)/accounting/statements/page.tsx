"use client";

import * as React from "react";
import Link from "next/link";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";

interface Line { code: string; name: string; nameAr: string | null; balanceMinor: string; presentedMinor: string }
interface Section { key: string; label: string; lines: Line[]; totalMinor: string }
interface PL {
  from: string; to: string; currency: string;
  revenue: Section; costOfSales: Section; grossProfitMinor: string;
  expenses: Section; netProfitMinor: string; grossMarginBps: number | null;
}
interface BS {
  asOf: string; currency: string;
  assets: Section; liabilities: Section; equity: Section;
  currentYearEarningsMinor: string; totalAssetsMinor: string;
  totalLiabilitiesAndEquityMinor: string; balanced: boolean; differenceMinor: string;
}

function ytd() {
  const now = new Date();
  const y = now.getUTCFullYear();
  return { from: `${y}-01-01`, to: now.toISOString().slice(0, 10) };
}

export default function StatementsPage() {
  const entityId = useEntityId();
  const [range, setRange] = React.useState(ytd);
  const { data, error, loading } = useLedgerQuery<{ profitAndLoss: PL; balanceSheet: BS }>(
    entityId ? `/api/ledger/statements?entityId=${entityId}&from=${range.from}&to=${range.to}` : null,
  );

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const pl = data?.profitAndLoss;
  const bs = data?.balanceSheet;

  return (
    <>
      <PageHead
        title="Financial statements"
        sub="Profit and loss for the period, and the balance sheet as at its end. Both come from one read of the ledger, so they cannot disagree with each other or with the trial balance."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">From</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">To</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
            </label>
          </>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading />}

      {pl && bs && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel className="overflow-hidden">
            <Head>Profit and loss</Head>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Profit and loss from {pl.from} to {pl.to}</caption>
                <Rows section={pl.revenue} currency={pl.currency} />
                <Rows section={pl.costOfSales} currency={pl.currency} />
                <Subtotal label="Gross profit" minor={pl.grossProfitMinor} currency={pl.currency}
                  note={pl.grossMarginBps === null ? undefined : `${(pl.grossMarginBps / 100).toFixed(2)}% margin`} />
                <Rows section={pl.expenses} currency={pl.currency} />
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2} style={{ textAlign: "end" }}>
                      {BigInt(pl.netProfitMinor) >= 0n ? "Net profit" : "Net loss"}
                    </th>
                    <td className="sw-num" data-testid="net-profit">
                      <Figure minor={pl.netProfitMinor} currency={pl.currency} zero="zero" />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Panel>

          <Panel className="overflow-hidden">
            <Head>Balance sheet as at {bs.asOf}</Head>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Balance sheet as at {bs.asOf}</caption>
                <Rows section={bs.assets} currency={bs.currency} />
                <Subtotal label="Total assets" minor={bs.totalAssetsMinor} currency={bs.currency} />
                <Rows section={bs.liabilities} currency={bs.currency} />
                <Rows section={bs.equity} currency={bs.currency} />
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2} style={{ textAlign: "end" }}>Liabilities and equity</th>
                    <td className="sw-num" data-testid="total-liab-eq">
                      <Figure minor={bs.totalLiabilitiesAndEquityMinor} currency={bs.currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                  {!bs.balanced && (
                    <tr>
                      <th scope="row" colSpan={2} style={{ textAlign: "end", color: "var(--sw-neg)" }}>Out of balance by</th>
                      <td className="sw-num sw-num-neg"><Figure minor={bs.differenceMinor} currency={bs.currency} zero="zero" /></td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>
            <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid="bs-note">
              {bs.balanced ? (
                <>
                  Assets equal liabilities plus equity. Equity includes{" "}
                  <Figure minor={bs.currentYearEarningsMinor} currency={bs.currency} zero="zero" /> earned so far this
                  year, which is not yet posted anywhere — it is closed to retained earnings at the year end.
                </>
              ) : (
                <>
                  The sheet does not balance. Every posting path is checked by a database constraint, so this
                  indicates a defect — please report it rather than adjusting to fit.{" "}
                  <Link href="/accounting/trial-balance" className="sw-link">Check the trial balance</Link>.
                </>
              )}
            </p>
          </Panel>
        </div>
      )}
    </>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}

function Rows({ section, currency }: { section: Section; currency: string }) {
  return (
    <tbody>
      <tr>
        <td colSpan={3} style={{ background: "var(--sw-surface-2)", height: "1.75rem" }}>
          <span className="sw-label">{section.label}</span>
        </td>
      </tr>
      {section.lines.length === 0 && (
        <tr><td colSpan={3} className="sw-sub" style={{ paddingInlineStart: "1.5rem" }}>Nothing in this period</td></tr>
      )}
      {section.lines.map((l) => (
        <tr key={l.code}>
          <td className="sw-code" style={{ width: "5rem" }}>{l.code}</td>
          <td>{l.name}</td>
          <td className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
            <Figure minor={l.presentedMinor} currency={currency} />
          </td>
        </tr>
      ))}
      <tr>
        <th scope="row" colSpan={2} style={{ textAlign: "end", fontWeight: 600 }}>Total {section.label.toLowerCase()}</th>
        <td className="sw-num" style={{ fontWeight: 600 }}>
          <Figure minor={section.totalMinor} currency={currency} zero="zero" colour={false} />
        </td>
      </tr>
    </tbody>
  );
}

function Subtotal({ label, minor, currency, note }: { label: string; minor: string; currency: string; note?: string }) {
  return (
    <tbody>
      <tr>
        <th scope="row" colSpan={2} style={{ textAlign: "end", fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>
          {label}
          {note && <span className="sw-sub ms-2" style={{ fontWeight: 400 }}>{note}</span>}
        </th>
        <td className="sw-num" style={{ fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" }}>
          <Figure minor={minor} currency={currency} zero="zero" />
        </td>
      </tr>
    </tbody>
  );
}
