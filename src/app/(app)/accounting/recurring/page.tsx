"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { parseAmount } from "@/lib/ledger/format";

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
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)}>
              {adding ? "Cancel" : "New template"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="run-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <NewTemplateForm
          busy={busy === "create"}
          onSave={async (template) => {
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
                </tr>
              </thead>
              <tbody>
                {data.templates.map((t) => (
                  <tr key={t.id}>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            An accrual is released on the first day of the following period, so the supplier invoice, when it
            arrives, is not counted a second time.{" "}
            <Link href="/accounting/accounts/2050" className="sw-link">Open accrued expenses</Link>{" "}or{" "}
            <Link href="/accounting/accounts/1300" className="sw-link">prepaid expenses</Link>.
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

/* ------------------------------------------------------------ the save form */

interface DraftLine { account: string; side: "debit" | "credit"; amount: string; memo: string }

const BLANK: DraftLine = { account: "", side: "debit", amount: "", memo: "" };

/**
 * The form checks what it can before the request goes out, but the server is
 * the authority — it is the one that knows whether 1100 is a control account.
 */
function NewTemplateForm({ busy, onSave }: {
  busy: boolean;
  onSave: (t: {
    code: string; name: string; frequency: string; kind: string;
    startsOn: string; endsOn?: string; autoReverse?: boolean;
    lines: { account: string; debit?: string; credit?: string; memo?: string }[];
  }) => void;
}) {
  const [f, setF] = React.useState({
    code: "", name: "", frequency: "MONTHLY", kind: "STANDING",
    startsOn: new Date().toISOString().slice(0, 10), endsOn: "",
  });
  const [autoReverseTouched, setTouched] = React.useState(false);
  const [autoReverse, setAutoReverse] = React.useState(false);
  const [lines, setLines] = React.useState<DraftLine[]>([{ ...BLANK }, { ...BLANK, side: "credit" }]);

  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setLines((ls) => ls.map((l, j) => (i === j ? { ...l, ...patch } : l)));

  // An accrual reverses unless someone says otherwise; a prepayment release
  // never does, because it is the release itself.
  const reverses = autoReverseTouched ? autoReverse : f.kind === "ACCRUAL";

  const parsed = lines.map((l) => ({ ...l, minor: parseAmount(l.amount) }));
  const debits = parsed.reduce((a, l) => a + (l.side === "debit" && l.minor ? l.minor : 0n), 0n);
  const credits = parsed.reduce((a, l) => a + (l.side === "credit" && l.minor ? l.minor : 0n), 0n);
  const filled = parsed.filter((l) => l.account.trim() && l.minor && l.minor > 0n);

  const blocker =
    !f.code.trim() ? "Give the template a code." :
    !f.name.trim() ? "Give the template a name." :
    filled.length < 2 ? "A template needs at least two lines — one line cannot balance." :
    filled.length !== parsed.length ? "Every line needs an account and an amount." :
    debits !== credits ? `It does not balance — out by ${Number(debits - credits) / 100}.` :
    f.kind === "PREPAYMENT" && reverses ? "A prepayment release is not reversed. Turn reversal off, or make this an accrual." :
    f.endsOn && f.endsOn < f.startsOn ? "It would end before it starts." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">New recurring template</div>
      <p className="sw-sub mt-1 max-w-[70ch]">
        The lines are checked now rather than at run time. A template that would fail every month at midnight is
        worse than one that refuses to be saved.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code"><input className="sw-input" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="RENT" /></Field>
        <Field label="Name"><input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Office rent" /></Field>
        <Field label="Kind">
          <select className="sw-select" value={f.kind} onChange={(e) => { set("kind", e.target.value); setTouched(false); }}>
            <option value="STANDING">Standing charge</option>
            <option value="ACCRUAL">Accrual</option>
            <option value="PREPAYMENT">Prepayment release</option>
          </select>
        </Field>
        <Field label="Frequency">
          <select className="sw-select" value={f.frequency} onChange={(e) => set("frequency", e.target.value)}>
            <option value="MONTHLY">Monthly</option>
            <option value="QUARTERLY">Quarterly</option>
            <option value="ANNUAL">Annual</option>
          </select>
        </Field>
        <Field label="Starts"><input type="date" className="sw-input" value={f.startsOn} onChange={(e) => set("startsOn", e.target.value)} /></Field>
        <Field label="Ends (optional)"><input type="date" className="sw-input" value={f.endsOn} onChange={(e) => set("endsOn", e.target.value)} /></Field>
        <label className="flex items-end gap-2 pb-1">
          <input
            type="checkbox"
            checked={reverses}
            onChange={(e) => { setTouched(true); setAutoReverse(e.target.checked); }}
            data-testid="auto-reverse"
          />
          <span className="sw-sub">Reverse on the first of the next period</span>
        </label>
      </div>

      <div className="sw-label mt-4">Lines</div>
      <div className="mt-2 space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[7rem_7rem_var(--sw-col-amount)_1fr]">
            <input className="sw-input" value={l.account} onChange={(e) => setLine(i, { account: e.target.value })} placeholder="6100" aria-label={`Account for line ${i + 1}`} />
            <select className="sw-select" value={l.side} onChange={(e) => setLine(i, { side: e.target.value as DraftLine["side"] })} aria-label={`Side for line ${i + 1}`}>
              <option value="debit">Debit</option>
              <option value="credit">Credit</option>
            </select>
            <input className="sw-input sw-cell-num" inputMode="decimal" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} placeholder="15,000.00" aria-label={`Amount for line ${i + 1}`} />
            <input className="sw-input" value={l.memo} onChange={(e) => setLine(i, { memo: e.target.value })} placeholder="Memo (optional)" aria-label={`Memo for line ${i + 1}`} />
          </div>
        ))}
      </div>
      <button type="button" className="sw-btn mt-2" onClick={() => setLines((ls) => [...ls, { ...BLANK }])}>
        Add line
      </button>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid="save-template"
          onClick={() => onSave({
            code: f.code.trim(), name: f.name.trim(), frequency: f.frequency, kind: f.kind,
            startsOn: f.startsOn, ...(f.endsOn ? { endsOn: f.endsOn } : {}),
            autoReverse: reverses,
            lines: parsed.map((l) => ({
              account: l.account.trim(),
              ...(l.side === "debit" ? { debit: (l.minor as bigint).toString() } : { credit: (l.minor as bigint).toString() }),
              ...(l.memo.trim() ? { memo: l.memo.trim() } : {}),
            })),
          })}
        >
          {busy ? "Saving…" : "Save template"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="template-blocker">{blocker}</span>}
        {!blocker && (
          <span className="sw-sub">
            <Figure minor={debits} colour={false} /> each {f.frequency.toLowerCase().replace("ly", "")} period
            {reverses && ", released on the first of the next"}.
          </span>
        )}
      </div>
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
