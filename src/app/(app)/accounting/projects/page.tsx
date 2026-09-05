"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";
import { ProjectBudgetRevision } from "@/components/ledger/project-budget";
import { fmtMinor, parseAmount } from "@/lib/ledger/format";

interface ProjectRow {
  code: string; name: string; customerName: string | null;
  startsOn: string; endsOn: string | null; budgetMinor: string; status: string;
}
interface SummaryRow {
  key: string; label: string; isUnassigned: boolean;
  status: string | null; customerName: string | null;
  revenueMinor: string; costMinor: string; netMinor: string;
  budgetMinor: string | null; percentOfBudgetBps: string | null;
  overBudget: boolean; marginBps: string | null;
}
interface Summary {
  from: string; to: string; currency: string;
  rows: SummaryRow[];
  totalRevenueMinor: string; totalCostMinor: string; totalNetMinor: string;
  unassignedCostMinor: string; unassignedShareBps: string | null;
  reconciles: boolean; differenceMinor: string; controlNetProfitMinor: string;
}
interface WipRow {
  code: string; name: string; customerName: string | null; status: string;
  costToDateMinor: string; invoicedMinor: string; wipMinor: string; overBilled: boolean;
  budgetMinor: string; percentOfBudgetBps: string | null; overBudget: boolean;
}
interface Wip {
  asOf: string; from: string; currency: string; basis: string; rows: WipRow[];
  totalCostMinor: string; totalInvoicedMinor: string; totalWipMinor: string;
  excludedStatuses: string[];
}
interface Profitability {
  code: string; name: string; customerName: string | null; status: string;
  startsOn: string; endsOn: string | null; from: string; to: string; currency: string;
  revenueMinor: string; costMinor: string; grossProfitMinor: string; grossMarginBps: string | null;
  budgetMinor: string; hasBudget: boolean; spentMinor: string; remainingMinor: string;
  percentOfBudgetBps: string | null; overBudget: boolean; overBudgetByMinor: string;
  reconciles: boolean; differenceMinor: string;
}
interface DetailLine {
  entryId: string; reference: string; date: string;
  accountCode: string; accountName: string; accountType: string;
  memo: string | null; source: string; status: string;
  debitMinor: string; creditMinor: string; runningMinor: string;
}
interface Detail {
  code: string; name: string; from: string; to: string; currency: string;
  lines: DetailLine[]; truncated: boolean;
  totals: { revenueMinor: string; costMinor: string; otherMinor: string } | null;
}

function ytd() {
  const now = new Date();
  return { from: `${now.getUTCFullYear()}-01-01`, to: now.toISOString().slice(0, 10) };
}

/**
 * The ledger keeps basis points; a reader wants a percentage. Both, exactly —
 * the conversion happens once, here, at the point of display, and the basis
 * points stay on the element's title so the underlying figure is never lost.
 */
const pct = (bps: string | null) => (bps === null ? "—" : `${(Number(bps) / 100).toFixed(2)}%`);

export default function ProjectsPage() {
  const entityId = useEntityId();
  const [range, setRange] = React.useState(ytd);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [drafting, setDrafting] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const ask = useAsk();

  const q = useLedgerQuery<{ projects: ProjectRow[]; summary?: Summary }>(
    entityId ? `/api/ledger/projects?entityId=${entityId}&from=${range.from}&to=${range.to}` : null,
  );
  const wipQ = useLedgerQuery<{ workInProgress?: Wip }>(
    entityId ? `/api/ledger/projects?entityId=${entityId}&asOf=${range.to}` : null,
  );
  const oneQ = useLedgerQuery<{ profitability?: Profitability; detail?: Detail }>(
    entityId && selected
      ? `/api/ledger/projects?entityId=${entityId}&project=${encodeURIComponent(selected)}&from=${range.from}&to=${range.to}`
      : null,
  );

  const reloadAll = () => { q.reload(); wipQ.reload(); oneQ.reload(); };

  const act = async (key: string, body: Record<string, unknown>) => {
    setBusy(key); setErr(null); setMsg(null);
    try {
      await api<Record<string, unknown>>("/api/ledger/projects", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      reloadAll();
      return true;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const projects = q.data?.projects ?? [];
  const summary = q.data?.summary;
  const wip = wipQ.data?.workInProgress;

  return (
    <>
      <PageHead
        title="Projects and job costing"
        sub="What each job earned, what it cost, and how that sits against the price it was quoted at. Cost that carries no project is its own row and is never spread across the jobs — a per-job margin that quietly absorbs a share of unassigned cost is a margin nobody can defend."
        actions={
          <>
            <button type="button" className="sw-btn" data-testid="new-project" onClick={() => setDrafting((d) => !d)}>
              {drafting ? "Cancel" : "New project"}
            </button>
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

      {err && <ErrorNote>{err}</ErrorNote>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {msg && <div className="sw-note" role="status">{msg}</div>}

      {drafting && (
        <NewProject
          busy={busy === "create"}
          onCancel={() => setDrafting(false)}
          onCreate={async (body) => {
            const ok = await act("create", { action: "create", ...body });
            if (ok) { setDrafting(false); setMsg(`Project ${String(body.code)} created. Tag costs to it with the PROJECT dimension.`); }
          }}
        />
      )}

      {q.loading && <Loading />}
      {!q.loading && !q.error && projects.length === 0 && (
        <Empty>
          No projects yet. Create one and every posting tagged <code className="sw-code">{"{ PROJECT: \"CODE\" }"}</code> is
          costed against it; everything else stays in Unassigned, which is exactly where it should be until somebody says otherwise.
        </Empty>
      )}

      <div className="grid gap-4">
        {summary && <Reconciliation summary={summary} />}
        {summary && (
          <SummaryPanel summary={summary} selected={selected} onSelect={(c) => setSelected((s) => (s === c ? null : c))} />
        )}

        {oneQ.error && <ErrorNote>{oneQ.error}</ErrorNote>}
        {oneQ.data?.profitability && (
          <OneProject
            p={oneQ.data.profitability}
            detail={oneQ.data.detail}
            busy={busy === `close:${oneQ.data.profitability.code}`}
            revising={busy === `budget:${oneQ.data.profitability.code}`}
            onRevise={async (code, budgetMinor) => {
              const p = oneQ.data!.profitability!;
              const ok = await act(`budget:${code}`, { action: "update", code, budgetMinor });
              // The panel stays open on a refusal, with the figure still typed
              // in it: the answer to "that is not an amount I can read" is to
              // correct it, not to key the whole thing again.
              if (!ok) return false;
              /* Both figures, named. The old one is about to stop existing —
               * the project row holds a single budget — so this sentence is
               * the only record of what it was that anybody will be handed. */
              const was = fmtMinor(p.budgetMinor, p.currency, { zero: "zero" });
              const now = fmtMinor(budgetMinor, p.currency, { zero: "zero" });
              const moved = BigInt(budgetMinor) - BigInt(p.budgetMinor);
              setMsg(
                `${code} was budgeted at ${was} and is now budgeted at ${now} — ` +
                  `${moved > 0n ? "an increase" : "a reduction"} of ${fmtMinor(moved < 0n ? -moved : moved, p.currency, { zero: "zero" })}. ` +
                  `Cost of ${fmtMinor(p.spentMinor, p.currency, { zero: "zero" })} is measured against the new figure from now on; ` +
                  `the old one is not kept anywhere, so record what was agreed where it will be found.`,
              );
              return true;
            }}
            onClose={async (code) => {
              const go = await ask({
                title: `Mark ${code} complete?`,
                detail:
                  "The job is stamped as finishing today and its project tag is archived, so it stops being offered " +
                  "for new cost. Nothing is written to the ledger — cost already posted stays exactly as posted — but " +
                  "the job leaves the work in progress list below, which carries only work still in flight.",
                confirmLabel: "Mark complete",
              });
              if (go === null) return;
              const ok = await act(`close:${code}`, { action: "close", code });
              if (ok) setMsg(`${code} is complete.`);
            }}
          />
        )}

        {wipQ.error && <ErrorNote>{wipQ.error}</ErrorNote>}
        {wip && <WipPanel wip={wip} />}
      </div>
    </>
  );
}

/**
 * The reconciliation, stated before any figure is read. Every project plus
 * Unassigned has to equal the profit and loss for the same dates; when it does
 * not, the reader is told not to act on the report rather than left to find the
 * discrepancy themselves.
 */
function Reconciliation({ summary }: { summary: Summary }) {
  return (
    <Panel>
      <p className="sw-sub px-3 py-2" data-testid="reconciliation">
        {summary.reconciles ? (
          <>
            Every project, plus Unassigned, adds back to{" "}
            <Figure minor={summary.totalNetMinor} currency={summary.currency} zero="zero" /> — the same result as the{" "}
            <Link href="/accounting/statements" className="sw-link">profit and loss</Link> for {summary.from} to {summary.to},
            which is read from the balance cache rather than from these lines.{" "}
            {BigInt(summary.unassignedCostMinor) === 0n ? (
              <>Nothing in this period was left unassigned.</>
            ) : (
              <>
                <Figure minor={summary.unassignedCostMinor} currency={summary.currency} /> of cost carries no project
                {summary.unassignedShareBps !== null && <> — {pct(summary.unassignedShareBps)} of all cost</>}. Until that is
                tagged, every margin below is understated by whatever share of it belongs to that job.
              </>
            )}
          </>
        ) : (
          <span style={{ color: "var(--sw-neg)" }}>
            These rows add up to <Figure minor={summary.totalNetMinor} currency={summary.currency} zero="zero" /> but the{" "}
            <Link href="/accounting/statements" className="sw-link">profit and loss</Link> for the same dates is{" "}
            <Figure minor={summary.controlNetProfitMinor} currency={summary.currency} zero="zero" />, a difference of{" "}
            <Figure minor={summary.differenceMinor} currency={summary.currency} zero="zero" />. Do not act on this report
            until that is explained — please report it rather than adjusting to fit.
          </span>
        )}
      </p>
    </Panel>
  );
}

function SummaryPanel({
  summary, selected, onSelect,
}: { summary: Summary; selected: string | null; onSelect: (code: string) => void }) {
  return (
    <Panel className="overflow-hidden">
      <Head>Job costing — {summary.from} to {summary.to}</Head>
      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">
            Revenue, cost and margin for every project from {summary.from} to {summary.to}, in {summary.currency}, with a
            row for cost carrying no project
          </caption>
          <thead>
            <tr>
              <th style={{ width: "7rem" }}>Code</th>
              <th style={{ minWidth: "12rem" }}>Project</th>
              <th style={{ width: "10rem" }}>Customer</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Revenue</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
              <th className="sw-num" style={{ width: "6rem" }}>Margin</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Budget</th>
              <th className="sw-num" style={{ width: "8rem" }}>Spent</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((r) => (
              <tr key={r.key}
                data-testid={r.isUnassigned ? "unassigned-row" : `project-row-${r.key}`}
                style={{
                  ...(r.isUnassigned ? { background: "var(--sw-surface-2)", borderTop: "1px solid var(--sw-line-strong)" } : {}),
                  ...(selected === r.key ? { outline: "1px solid var(--sw-accent)" } : {}),
                }}>
                <td className="sw-code">
                  {r.isUnassigned ? "—" : (
                    <button type="button" className="sw-link" onClick={() => onSelect(r.key)}>{r.key}</button>
                  )}
                </td>
                <td>
                  {r.label}
                  {r.isUnassigned && <span className="sw-chip sw-chip-warn ms-2">no project</span>}
                  {r.status && <span className="ms-2"><StatusChip status={r.status} /></span>}
                </td>
                <td className="sw-sub">{r.customerName ?? "—"}</td>
                <td className="sw-num"><Figure minor={r.revenueMinor} currency={summary.currency} /></td>
                <td className="sw-num"><Figure minor={r.costMinor} currency={summary.currency} /></td>
                <td className="sw-num"><Figure minor={r.netMinor} currency={summary.currency} zero="zero" /></td>
                <td className="sw-num" title={r.marginBps === null ? "No revenue, so no margin" : `${r.marginBps} basis points`}>
                  {pct(r.marginBps)}
                </td>
                <td className="sw-num">
                  {r.budgetMinor === null ? "—" : <Figure minor={r.budgetMinor} currency={summary.currency} colour={false} />}
                </td>
                <td className="sw-num"
                  title={r.percentOfBudgetBps === null ? "No budget was set, so there is no percentage to report" : `${r.percentOfBudgetBps} basis points`}>
                  {pct(r.percentOfBudgetBps)}
                  {r.overBudget && <span className="sw-chip sw-chip-bad ms-2" data-testid={`over-budget-${r.key}`}>over</span>}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3} style={{ textAlign: "end" }}>All projects and Unassigned</th>
              <td className="sw-num"><Figure minor={summary.totalRevenueMinor} currency={summary.currency} zero="zero" colour={false} /></td>
              <td className="sw-num"><Figure minor={summary.totalCostMinor} currency={summary.currency} zero="zero" colour={false} /></td>
              <td className="sw-num" data-testid="total-net"><Figure minor={summary.totalNetMinor} currency={summary.currency} zero="zero" /></td>
              <td colSpan={3} className="sw-sub" style={{ paddingInlineStart: "0.5rem" }}>
                equals the profit and loss for these dates
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

function OneProject({
  p, detail, busy, revising, onClose, onRevise,
}: {
  p: Profitability;
  detail?: Detail;
  busy: boolean;
  revising: boolean;
  onClose: (code: string) => void;
  /** True once the new figure is on the project. False leaves the panel open. */
  onRevise: (code: string, budgetMinor: string) => Promise<boolean>;
}) {
  const [budgeting, setBudgeting] = React.useState(false);

  /* The panel follows the selection. Leaving it open across a change of
   * project would put one job's figures under another job's heading, which is
   * the one mistake a job-costing screen cannot afford to make. */
  React.useEffect(() => setBudgeting(false), [p.code]);

  return (
    <Panel className="overflow-hidden">
      <Head>
        {p.code} — {p.name}
        {p.customerName ? ` · ${p.customerName}` : ""} · {p.from} to {p.to}
      </Head>

      <div className="flex flex-wrap items-center gap-4 px-3 py-2" data-testid="project-figures">
        <Stat label="Revenue" minor={p.revenueMinor} currency={p.currency} />
        <Stat label="Cost" minor={p.costMinor} currency={p.currency} />
        <Stat label="Gross profit" minor={p.grossProfitMinor} currency={p.currency} />
        <div>
          <div className="sw-label">Margin</div>
          <div className="sw-num" title={p.grossMarginBps === null ? undefined : `${p.grossMarginBps} basis points`}>
            {pct(p.grossMarginBps)}
          </div>
        </div>
        <Stat label="Budget" minor={p.budgetMinor} currency={p.currency} />
        <Stat label="Remaining" minor={p.remainingMinor} currency={p.currency} />
        <div>
          <div className="sw-label">Budget consumed</div>
          <div className="sw-num" data-testid="percent-consumed"
            title={p.hasBudget ? `${p.percentOfBudgetBps} basis points` : "No budget was set for this project"}>
            {p.hasBudget ? pct(p.percentOfBudgetBps) : "no budget set"}
          </div>
        </div>
        {p.overBudget && (
          <span className="sw-chip sw-chip-bad" data-testid="over-budget">
            over budget by <Figure minor={p.overBudgetByMinor} currency={p.currency} colour={false} />
          </span>
        )}
        <button
          type="button"
          className="sw-btn sw-btn-sm"
          aria-expanded={budgeting}
          onClick={() => setBudgeting((b) => !b)}
          data-testid="revise-budget"
        >
          {budgeting ? "Stop revising" : p.hasBudget ? "Revise the budget" : "Set a budget"}
        </button>
        {p.status !== "complete" && p.status !== "cancelled" && (
          <button type="button" className="sw-btn sw-btn-sm" disabled={busy} onClick={() => onClose(p.code)}
            data-testid="close-project">
            {busy ? "Closing…" : "Mark complete"}
          </button>
        )}
      </div>

      {!p.hasBudget && (
        <p className="sw-sub px-3 pb-2">
          No budget was quoted for this job, so there is no percentage of it to consume. That is not the same as being on
          budget, and it is not shown as 0%.
        </p>
      )}

      {budgeting && (
        <ProjectBudgetRevision
          project={{
            code: p.code,
            name: p.name,
            currency: p.currency,
            budgetMinor: p.budgetMinor,
            // The report's own figure, not a second definition of what was
            // spent: `spentMinor` is exactly `costMinor` on the server.
            spentMinor: p.spentMinor,
            hasBudget: p.hasBudget,
          }}
          busy={revising}
          onCancel={() => setBudgeting(false)}
          onRevise={async (budgetMinor) => {
            if (await onRevise(p.code, budgetMinor)) setBudgeting(false);
          }}
        />
      )}

      {detail && (
        <div className="sw-scroll" style={{ borderTop: "1px solid var(--sw-line)" }}>
          <table className="sw-table">
            <caption className="sr-only">
              The journal lines tagged to project {p.code} between {detail.from} and {detail.to}, in {detail.currency}
            </caption>
            <thead>
              <tr>
                <th style={{ width: "6.5rem" }}>Date</th>
                <th style={{ width: "7rem" }}>Reference</th>
                <th style={{ width: "5rem" }}>Account</th>
                <th style={{ minWidth: "12rem" }}>Narration</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Debit</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Credit</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.length === 0 && (
                <tr><td colSpan={6} className="sw-sub">Nothing has been tagged to this project in these dates.</td></tr>
              )}
              {detail.lines.map((l, i) => (
                <tr key={`${l.entryId}-${i}`}>
                  <td>{l.date}</td>
                  <td className="sw-code">
                    <Link href={`/accounting/journals?entry=${l.entryId}`} className="sw-link">{l.reference}</Link>
                  </td>
                  <td className="sw-code">{l.accountCode}</td>
                  <td>{l.memo ?? l.accountName}</td>
                  <td className="sw-num"><Figure minor={l.debitMinor} currency={detail.currency} colour={false} /></td>
                  <td className="sw-num"><Figure minor={l.creditMinor} currency={detail.currency} colour={false} /></td>
                </tr>
              ))}
            </tbody>
            {detail.totals && (
              <tfoot>
                <tr>
                  <th scope="row" colSpan={4} style={{ textAlign: "end" }}>Tagged to this project</th>
                  <td className="sw-num" title="Cost">
                    <Figure minor={detail.totals.costMinor} currency={detail.currency} zero="zero" colour={false} />
                  </td>
                  <td className="sw-num" title="Revenue">
                    <Figure minor={detail.totals.revenueMinor} currency={detail.currency} zero="zero" colour={false} />
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {detail?.truncated && (
        <p className="sw-sub px-3 py-2">
          Only the first {detail.lines.length} lines are shown, so no total is printed under them — a total of some of the
          lines is not a total. Narrow the dates to see the rest.
        </p>
      )}
    </Panel>
  );
}

function WipPanel({ wip }: { wip: Wip }) {
  return (
    <Panel className="overflow-hidden">
      <Head>Work in progress as at {wip.asOf}</Head>
      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">
            Cost incurred less amounts invoiced on projects still running, as at {wip.asOf}, in {wip.currency}
          </caption>
          <thead>
            <tr>
              <th style={{ width: "7rem" }}>Code</th>
              <th style={{ minWidth: "12rem" }}>Project</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost to date</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Invoiced</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost less invoiced</th>
              <th style={{ width: "8rem" }} />
            </tr>
          </thead>
          <tbody>
            {wip.rows.length === 0 && (
              <tr><td colSpan={6} className="sw-sub">No project is still running as at this date.</td></tr>
            )}
            {wip.rows.map((r) => (
              <tr key={r.code} data-testid={`wip-row-${r.code}`}>
                <td className="sw-code">{r.code}</td>
                <td>{r.name}<span className="ms-2"><StatusChip status={r.status} /></span></td>
                <td className="sw-num"><Figure minor={r.costToDateMinor} currency={wip.currency} colour={false} /></td>
                <td className="sw-num"><Figure minor={r.invoicedMinor} currency={wip.currency} colour={false} /></td>
                <td className="sw-num"><Figure minor={r.wipMinor} currency={wip.currency} zero="zero" /></td>
                <td>{r.overBilled && <span className="sw-chip sw-chip-warn">billed ahead of cost</span>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2} style={{ textAlign: "end" }}>Total</th>
              <td className="sw-num"><Figure minor={wip.totalCostMinor} currency={wip.currency} zero="zero" colour={false} /></td>
              <td className="sw-num"><Figure minor={wip.totalInvoicedMinor} currency={wip.currency} zero="zero" colour={false} /></td>
              <td className="sw-num" data-testid="total-wip"><Figure minor={wip.totalWipMinor} currency={wip.currency} zero="zero" /></td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid="wip-basis">
        This is a cost-to-date view: what has been posted to each running job, less what has been invoiced against it. It
        is <strong>not</strong> IFRS 15 revenue recognition — there is no percentage of completion, no estimate of costs
        to complete, and no contract asset or liability here. Nothing on this panel has been posted, and none of it
        belongs in the accounts without an accountant applying that judgement on top of it. Completed and cancelled
        projects are left out.
      </p>
    </Panel>
  );
}

function NewProject({
  busy, onCreate, onCancel,
}: { busy: boolean; onCancel: () => void; onCreate: (body: Record<string, unknown>) => void }) {
  const [f, setF] = React.useState({
    code: "", name: "", customerName: "",
    startsOn: new Date().toISOString().slice(0, 10), endsOn: "", budget: "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const budget = parseAmount(f.budget);

  return (
    <Panel className="mb-4">
      <form
        className="grid gap-3 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate({
            code: f.code, name: f.name, customerName: f.customerName || null,
            startsOn: f.startsOn, endsOn: f.endsOn || null,
            budgetMinor: (budget ?? 0n).toString(),
          });
        }}
      >
        <div className="flex flex-wrap gap-3">
          <Field label="Code"><input className="sw-input" required value={f.code} onChange={set("code")}
            placeholder="SITE_A" data-testid="project-code" /></Field>
          <Field label="Name"><input className="sw-input" required value={f.name} onChange={set("name")}
            placeholder="Marina Tower fit-out" style={{ width: "16rem" }} /></Field>
          <Field label="Customer"><input className="sw-input" value={f.customerName} onChange={set("customerName")} /></Field>
          <Field label="Starts"><input type="date" className="sw-input" required value={f.startsOn} onChange={set("startsOn")} /></Field>
          <Field label="Ends"><input type="date" className="sw-input" value={f.endsOn} onChange={set("endsOn")} /></Field>
          <Field label="Budget"><input className="sw-input" inputMode="decimal" value={f.budget} onChange={set("budget")}
            placeholder="0.00" style={{ width: "9rem" }} /></Field>
        </div>
        <p className="sw-sub">
          The budget is what the job was quoted at. Leave it empty and the job has no budget — the report then says so
          rather than showing it as on budget.
        </p>
        <div className="flex gap-2">
          <button type="submit" className="sw-btn sw-btn-primary sw-btn-sm" disabled={busy || budget === null}>
            {busy ? "Creating…" : "Create project"}
          </button>
          <button type="button" className="sw-btn sw-btn-sm" onClick={onCancel}>Cancel</button>
          {budget === null && <span className="sw-sub" style={{ color: "var(--sw-neg)" }}>That budget is not a number.</span>}
        </div>
      </form>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="sw-label">{label}</span>
      {children}
    </label>
  );
}

function Stat({ label, minor, currency }: { label: string; minor: string; currency: string }) {
  return (
    <div>
      <div className="sw-label">{label}</div>
      <div className="sw-num"><Figure minor={minor} currency={currency} zero="zero" /></div>
    </div>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}
