"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
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
  const [defining, setDefining] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

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

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/dimensions", {
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
            <button type="button" className="sw-btn" onClick={() => setDefining((d) => !d)} data-testid="toggle-define">
              {defining ? "Close" : "Define"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="dimension-result">{msg}</div>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && <Loading />}
      {!q.loading && !q.error && dimensions.length === 0 && !defining && (
        <Empty>
          No dimensions have been defined yet. A cost centre, department, project or branch is defined with the
          Define button above, and every posting tagged with one reports here.
        </Empty>
      )}

      {defining && (
        <Define
          dimensions={dimensions}
          busy={busy}
          onCreate={async (d) => {
            const r = await act("create-dimension", { action: "create-dimension", ...d });
            if (r) { setDimension(d.code.trim().toUpperCase()); setMsg(`${d.name} is now a dimension. Add its values, then tag postings with them in the journal grid.`); }
          }}
          onAddValue={async (v) => {
            const r = await act("add-value", { action: "add-value", ...v });
            if (r) setMsg(`${v.name} is now a value of ${v.dimension}.`);
          }}
          onRequire={async (r) => {
            const done = await act("require-on-account", { action: "require-on-account", ...r });
            if (done) setMsg(`Account ${r.accountCode} now refuses a posting that carries no ${r.dimension}. That is the only way Unallocated stays at nil on the costs that matter — asking people to remember is not a control.`);
          }}
        />
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

/**
 * Defining a dimension, giving it values, and making it mandatory on an
 * account.
 *
 * All three writes existed and were reachable from nothing: a browser user
 * could read a cost-centre profit and loss and never create the cost centre it
 * would report on, so every column but Unallocated was empty for everybody. The
 * third control is the one that does the real work — a dimension nobody is
 * forced to supply is a dimension that is supplied about half the time, and a
 * departmental report that is half right is worse than none.
 */
function Define({ dimensions, busy, onCreate, onAddValue, onRequire }: {
  dimensions: Dimension[];
  busy: string | null;
  onCreate: (d: { code: string; name: string; isRequired: boolean }) => void;
  onAddValue: (v: { dimension: string; code: string; name: string }) => void;
  onRequire: (r: { dimension: string; accountCode: string }) => void;
}) {
  const [dim, setDim] = React.useState({ code: "", name: "", isRequired: false });
  const [val, setVal] = React.useState({ dimension: dimensions[0]?.code ?? "", code: "", name: "" });
  const [req, setReq] = React.useState({ dimension: dimensions[0]?.code ?? "", accountCode: "" });

  // A dimension created a moment ago should be the one the two lower forms are
  // pointing at, without the reader having to notice the picker went blank.
  React.useEffect(() => {
    if (!dimensions.length) return;
    setVal((v) => (dimensions.some((d) => d.code === v.dimension) ? v : { ...v, dimension: dimensions[0].code }));
    setReq((r) => (dimensions.some((d) => d.code === r.dimension) ? r : { ...r, dimension: dimensions[0].code }));
  }, [dimensions]);

  const chosen = dimensions.find((d) => d.code === req.dimension);

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Define a dimension</div>
      <p className="sw-sub mt-1 max-w-[75ch]">
        A dimension is a second way of cutting the same postings — a cost centre, a department, a project, a branch.
        The code is what a posting carries and never changes; the name is what a report is headed with.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code">
          <input className="sw-input" value={dim.code} placeholder="COST_CENTRE"
            onChange={(e) => setDim((d) => ({ ...d, code: e.target.value }))} />
        </Field>
        <Field label="Name">
          <input className="sw-input" value={dim.name} placeholder="Cost centre"
            onChange={(e) => setDim((d) => ({ ...d, name: e.target.value }))} />
        </Field>
        <label className="flex items-end gap-2 pb-1">
          <input type="checkbox" className="sw-check" checked={dim.isRequired}
            onChange={(e) => setDim((d) => ({ ...d, isRequired: e.target.checked }))} />
          <span className="sw-sub">Expected on every posting</span>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            className="sw-btn sw-btn-primary"
            disabled={!dim.code.trim() || !dim.name.trim() || busy === "create-dimension"}
            aria-disabled={!dim.code.trim() || !dim.name.trim() || busy === "create-dimension" || undefined}
            data-testid="create-dimension"
            onClick={() => { onCreate(dim); setDim({ code: "", name: "", isRequired: false }); }}
          >
            {busy === "create-dimension" ? "Saving…" : "Create"}
          </button>
        </div>
      </div>
      <p className="sw-sub mt-1 max-w-[75ch]">
        &ldquo;Expected on every posting&rdquo; is advisory and decides nothing on its own. What actually refuses an
        untagged posting is requiring the dimension on an account, below.
      </p>

      {dimensions.length > 0 && (
        <>
          <div className="sw-label mt-5">Add a value</div>
          <p className="sw-sub mt-1 max-w-[75ch]">
            OPS, SALES, ADMIN under a cost centre. UNALLOCATED is the column for postings that carry no value, so it
            cannot also be one.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Dimension">
              <select className="sw-select" value={val.dimension}
                onChange={(e) => setVal((v) => ({ ...v, dimension: e.target.value }))}>
                {dimensions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Value code">
              <input className="sw-input" value={val.code} placeholder="OPS"
                onChange={(e) => setVal((v) => ({ ...v, code: e.target.value }))} />
            </Field>
            <Field label="Value name">
              <input className="sw-input" value={val.name} placeholder="Operations"
                onChange={(e) => setVal((v) => ({ ...v, name: e.target.value }))} />
            </Field>
            <div className="flex items-end">
              <button
                type="button"
                className="sw-btn"
                disabled={!val.dimension || !val.code.trim() || !val.name.trim() || busy === "add-value"}
                aria-disabled={!val.dimension || !val.code.trim() || !val.name.trim() || busy === "add-value" || undefined}
                data-testid="add-dimension-value"
                onClick={() => { onAddValue(val); setVal((v) => ({ ...v, code: "", name: "" })); }}
              >
                {busy === "add-value" ? "Saving…" : "Add value"}
              </button>
            </div>
          </div>

          <div className="sw-label mt-5">Require it on an account</div>
          <p className="sw-sub mt-1 max-w-[75ch]">
            The posting rule, not a reminder: a line to this account with no value for the dimension is refused
            outright. Set it on the sub-accounts that carry the cost — a heading is never posted to, and a dimension
            with no values yet would lock the account out entirely, so both are refused.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Dimension">
              <select className="sw-select" value={req.dimension}
                onChange={(e) => setReq((r) => ({ ...r, dimension: e.target.value }))}>
                {dimensions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Account code">
              <input className="sw-input sw-code" value={req.accountCode} placeholder="6100"
                onChange={(e) => setReq((r) => ({ ...r, accountCode: e.target.value }))} />
            </Field>
            <div className="flex items-end">
              <button
                type="button"
                className="sw-btn"
                disabled={!req.dimension || !req.accountCode.trim() || busy === "require-on-account"}
                aria-disabled={!req.dimension || !req.accountCode.trim() || busy === "require-on-account" || undefined}
                data-testid="require-dimension"
                onClick={() => onRequire(req)}
              >
                {busy === "require-on-account" ? "Saving…" : "Require"}
              </button>
            </div>
            {chosen && chosen.values.length === 0 && (
              <p className="sw-sub self-end pb-1" style={{ color: "var(--sw-neg)" }}>
                {chosen.name} has no values yet, so nothing could satisfy the requirement.
              </p>
            )}
          </div>

          <div className="sw-label mt-5">Defined so far</div>
          <div className="sw-scroll mt-2">
            <table className="sw-table">
              <caption className="sr-only">Dimensions defined in this organisation and their values</caption>
              <thead>
                <tr>
                  <th style={{ width: "10rem" }}>Code</th>
                  <th style={{ width: "12rem" }}>Name</th>
                  <th>Values</th>
                </tr>
              </thead>
              <tbody data-testid="defined-dimensions">
                {dimensions.map((d) => (
                  <tr key={d.code}>
                    <td className="sw-code">{d.code}</td>
                    <td>
                      {d.name}
                      {d.isRequired && <span className="sw-chip ms-2">expected</span>}
                    </td>
                    <td>
                      {d.values.length === 0
                        ? <span className="sw-sub">None yet — a dimension with no values tags nothing.</span>
                        : d.values.map((v) => (
                            <span key={v.code} className="sw-chip me-1" title={v.name}>{v.code}</span>
                          ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
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
