"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { TemplateForm, type TemplateWire } from "@/components/ledger/recurring-template-form";
import { TemplateActions, endingMeans } from "@/components/ledger/recurring-actions";

interface TemplateLine {
  account: string;
  debit?: string;
  credit?: string;
  memo?: string;
}
interface TemplateRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  frequency: string;
  status: string;
  autoReverse: boolean;
  startsOn: string;
  endsOn: string | null;
  lastRunPeriod: string | null;
  runCount: number;
  nextDuePeriod: string | null;
  behind: boolean;
  periodsDue: number;
  lines: TemplateLine[] | null;
  amountMinor: string | null;
  problem: string | null;
  dueThisPeriod: boolean;
  reason: string | null;
}
interface StatusPayload {
  asOf: string;
  templates: TemplateRow[];
  behindCount: number;
}
interface RunResult {
  period: string;
  templatesPosted: number;
  totalMinor: string;
  posted: {
    code: string; name: string; reference: string; amountMinor: string;
    reversalReference: string | null; reversesOn: string | null; alreadyPosted: boolean;
  }[];
  skipped: { code: string; reason: string }[];
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

const KIND_LABEL: Record<string, string> = {
  STANDING: "Standing charge",
  ACCRUAL: "Accrual",
  PREPAYMENT: "Prepayment",
};
const FREQ_LABEL: Record<string, string> = {
  MONTHLY: "Monthly",
  QUARTERLY: "Quarterly",
  ANNUAL: "Annual",
};

export default function RecurringJournalsPage() {
  const entityId = useEntityId();
  const [period, setPeriod] = React.useState(thisMonth);
  const { data, error, loading, reload } = useLedgerQuery<StatusPayload>(
    entityId ? `/api/ledger/recurring?entityId=${entityId}&asOf=${period}` : null,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [run, setRun] = React.useState<RunResult | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const today = React.useMemo(() => new Date().toISOString().slice(0, 10), []);

  const act = async <T,>(label: string, body: Record<string, unknown>): Promise<T | null> => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<T>("/api/ledger/recurring", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      reload();
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const runPeriod = async () => {
    const r = await act<RunResult>("run", { action: "run", period });
    if (!r) return;
    setRun(r);
    const n = r.templatesPosted;
    const reversals = r.posted.filter((p) => p.reversalReference).length;
    setMsg(
      n === 0
        ? `Nothing was due in ${period}.` +
          (r.skipped.length ? ` ${r.skipped.length} template${r.skipped.length === 1 ? " was" : "s were"} skipped — see below.` : "")
        : `Posted ${n} template${n === 1 ? "" : "s"} for ${period}.` +
          (reversals ? ` ${reversals} reverse${reversals === 1 ? "s" : ""} on the first of ${nextMonth(period)}.` : "") +
          (r.skipped.length ? ` ${r.skipped.length} skipped.` : ""),
    );
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Recurring journals"
        sub="Standing charges, accruals and prepayments. The template is the instruction; each run posts its own journal, which still says what it said on the day after the template has been edited or retired."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Month</span>
              <input
                type="month"
                className="sw-input"
                style={{ width: "9rem" }}
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                aria-label="Month to post"
              />
            </label>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              onClick={runPeriod}
              aria-disabled={busy === "run" || undefined}
              disabled={busy === "run"}
              data-testid="run-recurring"
            >
              {busy === "run" ? "Posting…" : "Run this month"}
            </button>
            <button type="button" className="sw-btn" onClick={() => { setAdding((a) => !a); setEditing(null); }}>
              {adding ? "Cancel" : "New template"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="run-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <TemplateForm
          busy={busy === "create"}
          onCancel={() => setAdding(false)}
          onSave={async (template: TemplateWire) => {
            const r = await act("create", { action: "create", template });
            if (r) { setAdding(false); setMsg(`Saved template ${template.code} ${template.name}.`); }
          }}
        />
      )}

      {data && data.behindCount > 0 && (
        <Panel className="mb-4 p-3">
          <p className="sw-sub" style={{ color: "var(--sw-neg)" }} data-testid="behind-note">
            {data.behindCount} template{data.behindCount === 1 ? " is" : "s are"} behind. A missed accrual is
            invisible in the ledger — the thing that is wrong is an entry that is not there — so run the months
            in order rather than jumping to this one.
          </p>
        </Panel>
      )}

      {run && run.posted.length > 0 && (
        <Panel className="mb-4 p-3">
          <div className="sw-label">Posted for {run.period}</div>
          <ul className="mt-1.5 space-y-0.5">
            {run.posted.map((p) => (
              <li key={p.code} className="sw-sub" data-testid="posted-row">
                <span className="sw-code">{p.code}</span> — {p.reference}
                {p.alreadyPosted && " (already on the books; found, not re-posted)"}
                {p.reversalReference && ` · releases as ${p.reversalReference} on ${p.reversesOn}`}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {run && run.skipped.length > 0 && (
        <Panel className="mb-4 p-3">
          <div className="sw-label">Skipped</div>
          <ul className="mt-1.5 space-y-0.5">
            {run.skipped.map((s) => (
              <li key={s.code} className="sw-sub" data-testid="skipped-row">
                <span className="sw-code">{s.code}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {loading && !data && <Loading />}

      {data && (data.templates.length === 0 ? (
        <Empty>No standing instructions yet.</Empty>
      ) : (
        <Panel className="overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Recurring journal templates</caption>
              <thead>
                <tr>
                  <th style={{ width: "7rem" }}>Code</th>
                  <th>Template</th>
                  <th className="hidden md:table-cell" style={{ width: "9rem" }}>Kind</th>
                  <th className="hidden lg:table-cell" style={{ width: "7rem" }}>Frequency</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                  <th style={{ width: "7rem" }}>Last run</th>
                  <th style={{ width: "8rem" }}>Next due</th>
                  <th style={{ width: "7rem" }}>Status</th>
                  <th style={{ width: "16rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {data.templates.map((t) => (
                  <React.Fragment key={t.id}>
                    <tr>
                      <td className="sw-code">{t.code}</td>
                      <td className="max-w-0 truncate">
                        {t.name}
                        {t.problem && (
                          <span className="block text-[0.6875rem]" style={{ color: "var(--sw-neg)" }}>{t.problem}</span>
                        )}
                        {!t.problem && !t.dueThisPeriod && t.reason && (
                          <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>
                            Not due in {data.asOf} — {t.reason}
                          </span>
                        )}
                      </td>
                      <td className="hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>
                        {KIND_LABEL[t.kind] ?? t.kind}
                        {t.autoReverse && <span className="sw-sub"> · reverses</span>}
                      </td>
                      <td className="hidden lg:table-cell" style={{ color: "var(--sw-fg-muted)" }}>
                        {FREQ_LABEL[t.frequency] ?? t.frequency}
                      </td>
                      <td className="sw-num"><Figure minor={t.amountMinor} colour={false} /></td>
                      <td>
                        {t.lastRunPeriod ?? <span className="sw-zero">never</span>}
                        {t.runCount > 0 && (
                          <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>
                            {t.runCount} run{t.runCount === 1 ? "" : "s"}
                          </span>
                        )}
                      </td>
                      <td>
                        {t.nextDuePeriod ?? <span className="sw-zero">finished</span>}
                        {t.behind && (
                          <span className="block text-[0.6875rem]" style={{ color: "var(--sw-neg)" }} data-testid="behind-chip">
                            behind by {t.periodsDue} period{t.periodsDue === 1 ? "" : "s"}
                          </span>
                        )}
                      </td>
                      <td><StatusChip status={t.status} /></td>
                      <td>
                        <TemplateActions
                          row={t}
                          busy={busy === t.code}
                          editing={editing === t.code}
                          today={today}
                          onEdit={() => { setEditing(editing === t.code ? null : t.code); setAdding(false); }}
                          onPause={async () => {
                            const r = await act(t.code, { action: "pause", code: t.code });
                            if (r) setMsg(`${t.code} ${t.name} is paused. It posts nothing until it is resumed, and keeps its run history.`);
                          }}
                          onResume={async () => {
                            const r = await act(t.code, { action: "resume", code: t.code });
                            if (r) setMsg(`${t.code} ${t.name} is active again, from the period it is next due for.`);
                          }}
                          onEnd={async (endsOn) => {
                            const r = await act(t.code, { action: "end", code: t.code, endsOn });
                            if (r) setMsg(endingMeans(t, endsOn));
                          }}
                        />
                      </td>
                    </tr>
                    {editing === t.code && (
                      <tr>
                        <td colSpan={9} style={{ background: "var(--sw-surface-2)", padding: "0.75rem" }}>
                          <TemplateForm
                            existing={t}
                            busy={busy === t.code}
                            onCancel={() => setEditing(null)}
                            onSave={async (patch: TemplateWire) => {
                              const r = await act(t.code, { action: "update", code: t.code, patch });
                              if (r) {
                                setEditing(null);
                                setMsg(
                                  `Saved ${patch.code} ${patch.name}. What it has already posted is untouched — ` +
                                    `each journal still says what it said on the day.`,
                                );
                              }
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            An accrual is released on the first day of the following period, so the supplier invoice, when it
            arrives, is not counted a second time.{" "}
            <Link href="/accounting/accounts/2050" className="sw-link">Open accrued expenses</Link>{" "}or{" "}
            <Link href="/accounting/accounts/1300" className="sw-link">prepaid expenses</Link>. A template whose
            purpose has passed is paused or ended here rather than left running: a rent accrual that goes on posting
            after the lease ended makes a correct, balanced, dated entry every month that is entirely wrong, and
            nothing about it looks unusual anywhere else in the ledger.
          </p>
        </Panel>
      ))}
    </>
  );
}

function nextMonth(period: string) {
  const [y, m] = period.split("-").map(Number);
  const i = y * 12 + (m - 1) + 1;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}
