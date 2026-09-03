"use client";

import * as React from "react";
import Link from "next/link";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

interface Column { key: string; label: string; isUnallocated: boolean }
interface Line {
  code: string; name: string; nameAr: string | null;
  balanceMinor: Record<string, string>;
  presentedMinor: Record<string, string>;
  totalPresentedMinor: string;
  totalBalanceMinor: string;
}
interface Section {
  key: string; label: string; lines: Line[];
  totalMinor: Record<string, string>;
  grandTotalMinor: string;
}
interface DimPL {
  from: string; to: string; currency: string;
  dimensionCode: string; dimensionName: string;
  columns: Column[];
  revenue: Section; costOfSales: Section; expenses: Section;
  grossProfitMinor: Record<string, string>;
  totalGrossProfitMinor: string;
  netProfitMinor: Record<string, string>;
  totalNetProfitMinor: string;
  reconciles: boolean;
  differenceMinor: string;
  reconciliation: { controlNetProfitMinor: string };
}
interface SummaryRow {
  key: string; label: string; isUnallocated: boolean;
  revenueMinor: string; costOfSalesMinor: string; expensesMinor: string; netProfitMinor: string;
  shareBps: string | null;
}
interface Summary {
  basis: string; basisTotalMinor: string; rows: SummaryRow[];
  roundingRemainderBps: string; currency: string;
}
interface Dimension { code: string; name: string; isRequired: boolean; status: string; values: { code: string; name: string; status: string }[] }

function ytd() {
  const now = new Date();
  return { from: `${now.getUTCFullYear()}-01-01`, to: now.toISOString().slice(0, 10) };
}

/** The reader wants a percentage; the ledger keeps basis points. Both, exactly. */
const pct = (bps: string | null) => (bps === null ? "—" : `${(Number(bps) / 100).toFixed(2)}%`);

export default function DimensionsPage() {
  const entityId = useEntityId();
  const [range, setRange] = React.useState(ytd);
  const [dimension, setDimension] = React.useState("");

  const q = useLedgerQuery<{ dimensions: Dimension[]; profitAndLoss?: DimPL; summary?: Summary }>(
    entityId
      ? `/api/ledger/dimensions?entityId=${entityId}` +
        (dimension ? `&dimension=${encodeURIComponent(dimension)}&from=${range.from}&to=${range.to}` : "")
      : null,
  );

  const dimensions = q.data?.dimensions ?? [];
  React.useEffect(() => {
    if (dimension || !dimensions.length) return;
    setDimension(dimensions[0].code);
  }, [dimensions, dimension]);

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const pl = q.data?.profitAndLoss;
  const summary = q.data?.summary;

  return (
    <>
      <PageHead
        title="Cost centres"
        sub="A profit and loss with one column per dimension value, and a column for everything that carries none. Unallocated is always shown, never spread across the others — cost that nobody owns is the number that decides whether a departmental report can be trusted."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Dimension</span>
              <select className="sw-select" style={{ width: "10rem" }} value={dimension}
                onChange={(e) => setDimension(e.target.value)}>
                {dimensions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
              </select>
            </label>
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

      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && <Loading />}
      {!q.loading && !q.error && dimensions.length === 0 && (
        <Empty>No dimensions have been defined yet. A cost centre, department, project or branch can be created through the dimensions API, and postings tagged with it will report here.</Empty>
      )}

      {pl && (
        <div className="grid gap-4">
          <Reconciliation pl={pl} />

          <Panel className="overflow-hidden">
            <Head>{pl.dimensionName} — profit and loss, {pl.from} to {pl.to}</Head>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">
                  Profit and loss by {pl.dimensionName} from {pl.from} to {pl.to}, in {pl.currency}
                </caption>
                <thead>
                  <tr>
                    <th style={{ width: "5rem" }}>Code</th>
                    <th style={{ minWidth: "12rem" }}>Account</th>
                    {pl.columns.map((c) => (
                      <th key={c.key} className="sw-num" style={{ width: "var(--sw-col-amount)", ...unallocatedTone(c) }}
                        data-testid={c.isUnallocated ? "unallocated-column" : undefined}>
                        {c.label}
                      </th>
                    ))}
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Total</th>
                  </tr>
                </thead>

                <Rows section={pl.revenue} columns={pl.columns} currency={pl.currency} />
                <Rows section={pl.costOfSales} columns={pl.columns} currency={pl.currency} />
                <SubtotalRow label="Gross profit" columns={pl.columns} currency={pl.currency}
                  values={pl.grossProfitMinor} total={pl.totalGrossProfitMinor} />
                <Rows section={pl.expenses} columns={pl.columns} currency={pl.currency} />

                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2} style={{ textAlign: "end" }}>
                      {BigInt(pl.totalNetProfitMinor) >= 0n ? "Net profit" : "Net loss"}
                    </th>
                    {pl.columns.map((c) => (
                      <td key={c.key} className="sw-num" style={unallocatedTone(c)}>
                        <Figure minor={pl.netProfitMinor[c.key]} currency={pl.currency} zero="zero" />
                      </td>
                    ))}
                    <td className="sw-num" data-testid="net-profit">
                      <Figure minor={pl.totalNetProfitMinor} currency={pl.currency} zero="zero" />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Panel>

          {summary && <SummaryPanel summary={summary} columns={pl.columns} currency={pl.currency} />}
        </div>
      )}
    </>
  );
}

/**
 * The reconciliation, stated first and in plain words. A dimensional report
 * that does not add up to the real profit and loss is worse than no report,
 * because people act on it — so the reader is told which they are looking at
 * before they read a single figure.
 */
function Reconciliation({ pl }: { pl: DimPL }) {
  return (
    <Panel>
      <p className="sw-sub px-3 py-2" data-testid="reconciliation">
        {pl.reconciles ? (
          <>
            Every column, including Unallocated, adds back to{" "}
            <Figure minor={pl.totalNetProfitMinor} currency={pl.currency} zero="zero" /> — the same net result as the{" "}
            <Link href="/accounting/statements" className="sw-link">profit and loss</Link> for this period, which is
            read from the balance cache rather than from these lines.
          </>
        ) : (
          <span style={{ color: "var(--sw-neg)" }}>
            These columns add up to{" "}
            <Figure minor={pl.totalNetProfitMinor} currency={pl.currency} zero="zero" /> but the{" "}
            <Link href="/accounting/statements" className="sw-link">profit and loss</Link> for the same period is{" "}
            <Figure minor={pl.reconciliation.controlNetProfitMinor} currency={pl.currency} zero="zero" />, a difference
            of <Figure minor={pl.differenceMinor} currency={pl.currency} zero="zero" />. Do not act on this report until
            that is explained — please report it rather than adjusting to fit.
          </span>
        )}
      </p>
    </Panel>
  );
}

function SummaryPanel({ summary, columns, currency }: { summary: Summary; columns: Column[]; currency: string }) {
  return (
    <Panel className="overflow-hidden">
      <Head>Share of {summary.basis === "netProfit" ? "net profit" : summary.basis}</Head>
      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">Each value&apos;s share of total {summary.basis}</caption>
          <thead>
            <tr>
              <th style={{ minWidth: "12rem" }}>Value</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Revenue</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost of sales</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Expenses</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
              <th className="sw-num" style={{ width: "7rem" }}>Share</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((r) => (
              <tr key={r.key} style={r.isUnallocated ? { background: "var(--sw-surface-2)" } : undefined}>
                <td>{r.label}{r.isUnallocated && <span className="sw-chip sw-chip-warn ms-2">no value</span>}</td>
                <td className="sw-num"><Figure minor={r.revenueMinor} currency={currency} /></td>
                <td className="sw-num"><Figure minor={r.costOfSalesMinor} currency={currency} /></td>
                <td className="sw-num"><Figure minor={r.expensesMinor} currency={currency} /></td>
                <td className="sw-num"><Figure minor={r.netProfitMinor} currency={currency} zero="zero" /></td>
                <td className="sw-num" title={r.shareBps === null ? undefined : `${r.shareBps} basis points`}>
                  {pct(r.shareBps)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4} style={{ textAlign: "end" }}>Total {summary.basis === "netProfit" ? "net profit" : summary.basis}</th>
              <td className="sw-num"><Figure minor={summary.basisTotalMinor} currency={currency} zero="zero" colour={false} /></td>
              <td className="sw-num">100.00%</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
        Shares are basis points, truncated rather than rounded up so no value is ever overstated.{" "}
        {BigInt(summary.roundingRemainderBps) === 0n
          ? "They add to exactly 10,000."
          : `They add to ${10_000 - Number(summary.roundingRemainderBps)}; the remaining ${summary.roundingRemainderBps} basis points are what truncation dropped, shown here rather than pushed into the largest column.`}{" "}
        Columns shown: {columns.length}, one of them Unallocated.
      </p>
    </Panel>
  );
}

const unallocatedTone = (c: Column): React.CSSProperties =>
  c.isUnallocated ? { background: "var(--sw-surface-2)", borderInlineStart: "1px solid var(--sw-line-strong)" } : {};

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}

function Rows({ section, columns, currency }: { section: Section; columns: Column[]; currency: string }) {
  const span = columns.length + 3;
  return (
    <tbody>
      <tr>
        <td colSpan={span} style={{ background: "var(--sw-surface-2)", height: "1.75rem" }}>
          <span className="sw-label">{section.label}</span>
        </td>
      </tr>
      {section.lines.length === 0 && (
        <tr><td colSpan={span} className="sw-sub" style={{ paddingInlineStart: "1.5rem" }}>Nothing in this period</td></tr>
      )}
      {section.lines.map((l) => (
        <tr key={l.code}>
          <td className="sw-code">{l.code}</td>
          <td>{l.name}</td>
          {columns.map((c) => (
            <td key={c.key} className="sw-num" style={unallocatedTone(c)}>
              <Figure minor={l.presentedMinor[c.key]} currency={currency} />
            </td>
          ))}
          <td className="sw-num"><Figure minor={l.totalPresentedMinor} currency={currency} /></td>
        </tr>
      ))}
      <tr>
        <th scope="row" colSpan={2} style={{ textAlign: "end", fontWeight: 600 }}>
          Total {section.label.toLowerCase()}
        </th>
        {columns.map((c) => (
          <td key={c.key} className="sw-num" style={{ fontWeight: 600, ...unallocatedTone(c) }}>
            <Figure minor={section.totalMinor[c.key]} currency={currency} zero="zero" colour={false} />
          </td>
        ))}
        <td className="sw-num" style={{ fontWeight: 600 }}>
          <Figure minor={section.grandTotalMinor} currency={currency} zero="zero" colour={false} />
        </td>
      </tr>
    </tbody>
  );
}

function SubtotalRow({
  label, columns, currency, values, total,
}: { label: string; columns: Column[]; currency: string; values: Record<string, string>; total: string }) {
  const edge = { borderTop: "1px solid var(--sw-line-strong)" };
  return (
    <tbody>
      <tr>
        <th scope="row" colSpan={2} style={{ textAlign: "end", fontWeight: 600, ...edge }}>{label}</th>
        {columns.map((c) => (
          <td key={c.key} className="sw-num" style={{ fontWeight: 600, ...edge, ...unallocatedTone(c) }}>
            <Figure minor={values[c.key]} currency={currency} zero="zero" />
          </td>
        ))}
        <td className="sw-num" style={{ fontWeight: 600, ...edge }}>
          <Figure minor={total} currency={currency} zero="zero" />
        </td>
      </tr>
    </tbody>
  );
}
