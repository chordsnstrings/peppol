"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";
import { parseAmount } from "@/lib/ledger/format";

interface VLine {
  code: string; name: string; nameAr: string | null;
  budgetMinor: string; actualMinor: string; varianceMinor: string;
  varianceBps: number | null; favourable: boolean; unbudgeted: boolean;
}
interface VSection {
  key: "income" | "expenses"; label: string; favourableWhen: "above" | "below";
  lines: VLine[]; budgetMinor: string; actualMinor: string; varianceMinor: string;
  varianceBps: number | null; favourable: boolean;
}
interface Variance {
  scenario: string; from: string; to: string; currency: string;
  periods: string[]; partialPeriods: string[];
  income: VSection; expenses: VSection;
  netBudgetMinor: string; netActualMinor: string; netVarianceMinor: string;
  netVarianceBps: number | null; netFavourable: boolean;
  unbudgetedCount: number; warnings: string[];
}
interface SBlock {
  key: string; label: string; favourableWhen: "above" | "below";
  budgetFullYearMinor: string; budgetToDateMinor: string; actualToDateMinor: string;
  varianceToDateMinor: string; varianceToDateBps: number | null; favourableToDate: boolean;
  projectedFullYearMinor: string; projectedVarianceMinor: string; projectedFavourable: boolean;
}
interface Summary {
  scenario: string; fiscalYear: string; asOf: string; currency: string;
  yearStartsOn: string; yearEndsOn: string; elapsedDays: number; totalDays: number;
  income: SBlock; expenses: SBlock; net: SBlock;
  projectionBasis: string; warnings: string[];
}
interface Period { id: string; label: string; isAdjustment: boolean }

function ytd() {
  const now = new Date();
  return { from: `${now.getUTCFullYear()}-01-01`, to: now.toISOString().slice(0, 10) };
}

/** Basis points as a percentage, or a dash where there is no rate to give. */
function Rate({ bps }: { bps: number | null }) {
  if (bps === null) return <span className="sw-zero" title="No budget, so no percentage variance">n/a</span>;
  return <>{(bps / 100).toFixed(2)}%</>;
}

/**
 * Favourable or adverse, in a word. Revenue above budget and spend above budget
 * carry the same sign, so the sign is never left to say which is which.
 */
function Verdict({ favourable, zero }: { favourable: boolean; zero?: boolean }) {
  if (zero) return <span className="sw-zero">on budget</span>;
  return (
    <span className={`sw-chip ${favourable ? "sw-chip-ok" : "sw-chip-bad"}`}>
      {favourable ? "favourable" : "adverse"}
    </span>
  );
}

export default function BudgetPage() {
  const entityId = useEntityId();
  const [range, setRange] = React.useState(ytd);
  const [scenario, setScenario] = React.useState("BUDGET");
  const [year, setYear] = React.useState(() => String(new Date().getUTCFullYear()));
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const periods = useLedgerQuery<{ periods: Period[] }>(entityId ? `/api/ledger/periods?entityId=${entityId}` : null);
  const q = useLedgerQuery<Variance>(
    entityId
      ? `/api/ledger/budget?entityId=${entityId}&scenario=${encodeURIComponent(scenario)}&from=${range.from}&to=${range.to}`
      : null,
    [scenario, range.from, range.to],
  );
  const s = useLedgerQuery<Summary>(
    entityId
      ? `/api/ledger/budget?view=summary&entityId=${entityId}&scenario=${encodeURIComponent(scenario)}&fiscalYear=${year}&asOf=${range.to}`
      : null,
    [scenario, year, range.to],
  );

  const years = React.useMemo(() => {
    const set = new Set((periods.data?.periods ?? []).map((p) => p.label.slice(0, 4)));
    set.add(String(new Date().getUTCFullYear()));
    return [...set].sort();
  }, [periods.data]);

  const months = React.useMemo(
    () => (periods.data?.periods ?? []).filter((p) => !p.isAdjustment && p.label.startsWith(year)).map((p) => p.label),
    [periods.data, year],
  );

  const reload = () => { q.reload(); s.reload(); };

  const [form, setForm] = React.useState({ period: "", account: "", amount: "", note: "" });
  const [copy, setCopy] = React.useState({ to: "FORECAST", uplift: "0", overwrite: false });

  const submitLine = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setMsg(null);
    // parseAmount reads an empty field as zero, and a zero budget is a real
    // plan ("we intend to spend nothing here"). So an empty field is refused
    // rather than quietly saved as one.
    if (!form.amount.trim()) { setErr("Enter the amount budgeted. Type 0 if the plan is to spend nothing."); return; }
    if (!form.account.trim()) { setErr("Enter the account code this budget is set against, such as 6100."); return; }
    const period = form.period || months[0];
    if (!period) { setErr(`No months are open in ${year}. Open the fiscal year before budgeting against it.`); return; }
    const minor = parseAmount(form.amount);
    if (minor === null) { setErr(`"${form.amount}" is not an amount.`); return; }
    setBusy("set");
    try {
      const r = await api<{ written: number; scenario: string }>("/api/ledger/budget", {
        method: "POST",
        body: JSON.stringify({
          action: "set", entityId, scenario, fiscalYear: year,
          lines: [{
            period, accountCode: form.account.trim(),
            amountMinor: minor.toString(), note: form.note || undefined,
          }],
        }),
      });
      setMsg(`Budgeted ${form.account.trim()} for ${period} in ${r.scenario}.`);
      setForm((f) => ({ ...f, amount: "", note: "" }));
      reload();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  const submitCopy = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setMsg(null);
    if (!/^-?\d+$/.test(copy.uplift.trim())) {
      setErr("An uplift is a whole number of basis points — 500 is five per cent.");
      return;
    }
    setBusy("copy");
    try {
      const r = await api<{ copied: number; replaced: number; to: string }>("/api/ledger/budget", {
        method: "POST",
        body: JSON.stringify({
          action: "copy", entityId, from: scenario, to: copy.to.trim(),
          fiscalYear: year, upliftBps: Number(copy.uplift.trim()), overwrite: copy.overwrite,
        }),
      });
      setMsg(
        `Copied ${r.copied} line${r.copied === 1 ? "" : "s"} into ${r.to}` +
          (r.replaced ? `, replacing ${r.replaced}` : "") + ".",
      );
      reload();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : "That did not work.");
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;
  const v = q.data;

  return (
    <>
      <PageHead
        title="Budget and variance"
        sub="What was planned against what happened. The actuals here are the profit and loss for the same dates — the same read, not a second one — so this page and the statements cannot disagree. Every line says which way its variance points."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Scenario</span>
              <input className="sw-input" style={{ width: "8rem" }} value={scenario}
                onChange={(e) => setScenario(e.target.value.toUpperCase())} data-testid="scenario" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Year</span>
              <select className="sw-select" style={{ width: "6rem" }} value={year} onChange={(e) => setYear(e.target.value)}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
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

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="budget-result">{msg}</div>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !v && <Loading />}

      {v && (
        <>
          {v.warnings.map((w, i) => (
            <div key={i} className="sw-error mb-3" role="alert" data-testid="budget-warning">{w}</div>
          ))}

          <Panel className="mb-4 overflow-hidden">
            <Head>
              {v.scenario} against actual — {v.from} to {v.to}
            </Head>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Budget against actual from {v.from} to {v.to}</caption>
                <thead>
                  <tr>
                    <th style={{ width: "5rem" }}>Code</th>
                    <th>Account</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Budget</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Actual</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Variance</th>
                    <th className="sw-num" style={{ width: "5.5rem" }}>Rate</th>
                    <th style={{ width: "9rem" }}>Verdict</th>
                  </tr>
                </thead>
                <Rows section={v.income} currency={v.currency} />
                <Rows section={v.expenses} currency={v.currency} />
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2} style={{ textAlign: "end" }}>Net result</th>
                    <td className="sw-num"><Figure minor={v.netBudgetMinor} currency={v.currency} zero="zero" colour={false} /></td>
                    <td className="sw-num" data-testid="budget-net-actual">
                      <Figure minor={v.netActualMinor} currency={v.currency} zero="zero" colour={false} />
                    </td>
                    <td className="sw-num" data-testid="budget-net-variance">
                      <Figure minor={v.netVarianceMinor} currency={v.currency} zero="zero" colour={false} />
                    </td>
                    <td className="sw-num"><Rate bps={v.netVarianceBps} /></td>
                    <td><Verdict favourable={v.netFavourable} zero={v.netVarianceMinor === "0"} /></td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid="budget-note">
              Income is favourable above budget, expenses below it — which is why the verdict is a word rather than a
              sign. Covering {v.periods.length} budget month{v.periods.length === 1 ? "" : "s"}
              {v.partialPeriods.length > 0 && <>, of which {v.partialPeriods.join(", ")} {v.partialPeriods.length === 1 ? "is" : "are"} only partly in range</>}.{" "}
              The actuals are the same figures as the{" "}
              <Link href="/accounting/statements" className="sw-link">profit and loss</Link> for these dates.
            </p>
          </Panel>
        </>
      )}

      {s.data && (
        <Panel className="mb-4 overflow-hidden">
          <Head>
            Year to date against the {s.data.fiscalYear} plan — {s.data.elapsedDays} of {s.data.totalDays} days elapsed
          </Head>
          <div className="sw-scroll">
            <table className="sw-table" data-testid="budget-summary">
              <caption className="sr-only">Year to date against the full-year budget, with a run-rate projection</caption>
              <thead>
                <tr>
                  <th>Section</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Actual to date</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Budget to date</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Variance</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Full-year budget</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Projected full year</th>
                  <th style={{ width: "9rem" }}>Verdict to date</th>
                </tr>
              </thead>
              <tbody>
                {[s.data.income, s.data.expenses, s.data.net].map((b) => (
                  <tr key={b.key} data-testid={`summary-${b.key}`}>
                    <th scope="row">{b.label}</th>
                    <td className="sw-num"><Figure minor={b.actualToDateMinor} currency={s.data!.currency} zero="zero" colour={false} /></td>
                    <td className="sw-num"><Figure minor={b.budgetToDateMinor} currency={s.data!.currency} zero="zero" colour={false} /></td>
                    <td className="sw-num"><Figure minor={b.varianceToDateMinor} currency={s.data!.currency} zero="zero" colour={false} /></td>
                    <td className="sw-num"><Figure minor={b.budgetFullYearMinor} currency={s.data!.currency} zero="zero" colour={false} /></td>
                    <td className="sw-num" style={{ fontStyle: "italic" }}>
                      <Figure minor={b.projectedFullYearMinor} currency={s.data!.currency} zero="zero" colour={false} />
                    </td>
                    <td><Verdict favourable={b.favourableToDate} zero={b.varianceToDateMinor === "0"} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid="projection-basis">
            {s.data.projectionBasis}
          </p>
        </Panel>
      )}
      {s.error && <ErrorNote>{s.error}</ErrorNote>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-4">
          <div className="sw-label">Budget a line</div>
          <p className="sw-sub mt-1.5">
            One figure per account per month, on the account&apos;s natural side: revenue and expenses both entered
            as positive amounts. A budget against a bank account or a receivable is refused — those hold a balance,
            not a plan.
          </p>
          <form className="mt-3 grid gap-2 sm:grid-cols-2" onSubmit={submitLine} data-testid="budget-form">
            <label className="grid gap-1">
              <span className="sw-label">Month</span>
              <select className="sw-select" value={form.period || months[0] || ""}
                onChange={(e) => setForm((f) => ({ ...f, period: e.target.value }))}>
                {months.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="sw-label">Account code</span>
              <input className="sw-input" placeholder="6100" value={form.account}
                onChange={(e) => setForm((f) => ({ ...f, account: e.target.value }))} data-testid="budget-account" />
            </label>
            <label className="grid gap-1">
              <span className="sw-label">Amount</span>
              <input className="sw-input sw-num" inputMode="decimal" placeholder="12,000.00" value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} data-testid="budget-amount" />
            </label>
            <label className="grid gap-1">
              <span className="sw-label">Note</span>
              <input className="sw-input" placeholder="Agreed at the January board" value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className="sw-btn sw-btn-primary" disabled={busy !== null} data-testid="set-budget">
                {busy === "set" ? "Saving…" : `Save into ${scenario}`}
              </button>
            </div>
          </form>
        </Panel>

        <Panel className="p-4">
          <div className="sw-label">Copy this scenario</div>
          <p className="sw-sub mt-1.5">
            Clone {scenario} for {year} into another scenario, uplifted by a whole number of basis points — 500 is
            five per cent, −250 shaves two and a half. The uplift is applied in integer minor units, so the copied
            sections still add up to the copied total.
          </p>
          <form className="mt-3 grid gap-2 sm:grid-cols-2" onSubmit={submitCopy}>
            <label className="grid gap-1">
              <span className="sw-label">Into scenario</span>
              <input className="sw-input" value={copy.to}
                onChange={(e) => setCopy((c) => ({ ...c, to: e.target.value.toUpperCase() }))} data-testid="copy-to" />
            </label>
            <label className="grid gap-1">
              <span className="sw-label">Uplift (basis points)</span>
              <input className="sw-input sw-num" inputMode="numeric" value={copy.uplift}
                onChange={(e) => setCopy((c) => ({ ...c, uplift: e.target.value }))} data-testid="copy-uplift" />
            </label>
            <label className="flex items-start gap-2 sm:col-span-2">
              <input type="checkbox" className="mt-0.5" checked={copy.overwrite}
                onChange={(e) => setCopy((c) => ({ ...c, overwrite: e.target.checked }))} />
              <span className="text-[0.8125rem]">
                Replace whatever the target scenario already holds for {year}.
                <span className="sw-sub block">Without this, a copy onto a scenario someone has worked on is refused.</span>
              </span>
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className="sw-btn" disabled={busy !== null} data-testid="copy-scenario">
                {busy === "copy" ? "Copying…" : "Copy"}
              </button>
            </div>
          </form>
        </Panel>
      </div>
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

function Rows({ section, currency }: { section: VSection; currency: string }) {
  return (
    <tbody>
      <tr>
        <td colSpan={7} style={{ background: "var(--sw-surface-2)", height: "1.75rem" }}>
          <span className="sw-label">
            {section.label} — favourable {section.favourableWhen} budget
          </span>
        </td>
      </tr>
      {section.lines.length === 0 && (
        <tr><td colSpan={7} className="sw-sub" style={{ paddingInlineStart: "1.5rem" }}>Nothing budgeted and nothing posted</td></tr>
      )}
      {section.lines.map((l) => (
        <tr key={l.code} data-testid={`variance-${l.code}`}>
          <td className="sw-code">{l.code}</td>
          <td>
            {l.name}
            {l.unbudgeted && <span className="sw-chip sw-chip-warn ms-2" data-testid="unbudgeted">unbudgeted</span>}
          </td>
          <td className="sw-num"><Figure minor={l.budgetMinor} currency={currency} colour={false} /></td>
          <td className="sw-num"><Figure minor={l.actualMinor} currency={currency} colour={false} /></td>
          <td className="sw-num"><Figure minor={l.varianceMinor} currency={currency} colour={false} /></td>
          <td className="sw-num"><Rate bps={l.varianceBps} /></td>
          <td><Verdict favourable={l.favourable} zero={l.varianceMinor === "0"} /></td>
        </tr>
      ))}
      <tr>
        <th scope="row" colSpan={2} style={{ textAlign: "end", fontWeight: 600 }}>Total {section.label.toLowerCase()}</th>
        <td className="sw-num" style={{ fontWeight: 600 }}><Figure minor={section.budgetMinor} currency={currency} zero="zero" colour={false} /></td>
        <td className="sw-num" style={{ fontWeight: 600 }}><Figure minor={section.actualMinor} currency={currency} zero="zero" colour={false} /></td>
        <td className="sw-num" style={{ fontWeight: 600 }}><Figure minor={section.varianceMinor} currency={currency} zero="zero" colour={false} /></td>
        <td className="sw-num" style={{ fontWeight: 600 }}><Rate bps={section.varianceBps} /></td>
        <td><Verdict favourable={section.favourable} zero={section.varianceMinor === "0"} /></td>
      </tr>
    </tbody>
  );
}
