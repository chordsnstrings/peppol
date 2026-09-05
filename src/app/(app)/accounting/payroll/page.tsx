"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";
import { fmtMinor, parseAmount, toInput } from "@/lib/ledger/format";

interface Payslip {
  employeeId: string; code: string; name: string;
  daysOnPayroll: number; daysInMonth: number;
  basicMinor: string; allowancesMinor: string; overtimeMinor: string;
  deductionsMinor: string; grossMinor: string; netMinor: string; gratuityMinor: string;
  status: string;
}
interface EmployeeRow {
  code: string; name: string; joinedOn: string; leftOn: string | null;
  contractType: string; basicMinor: string; allowancesMinor: string;
  status: string; gratuityToDateMinor: string; wpsReady: boolean;
}
interface Summary {
  period: string;
  payslips: Payslip[];
  totals: { grossMinor: string; deductionsMinor: string; netMinor: string; gratuityMinor: string };
  employees: EmployeeRow[];
  register: { salariesMinor: string; payableMinor: string; provisionMinor: string };
  ledger: {
    salariesMinor: string; payableMinor: string; provisionMinor: string;
    salariesAgree: boolean; payableAgrees: boolean; provisionAgrees: boolean; agrees: boolean;
  };
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function PayrollPage() {
  const entityId = useEntityId();
  const ask = useAsk();
  const [period, setPeriod] = React.useState(thisMonth);
  const { data, error, loading, reload } = useLedgerQuery<Summary>(
    entityId ? `/api/ledger/payroll?entityId=${entityId}&period=${period}` : null,
    [period],
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [skipped, setSkipped] = React.useState<{ code: string; reason: string }[]>([]);
  const [adding, setAdding] = React.useState(false);
  /** Which employee row is open, and for which of the two per-row forms. */
  const [openRow, setOpenRow] = React.useState<{ code: string; mode: "amend" | "settle" } | null>(null);
  const [sif, setSif] = React.useState<{ filename: string; csv: string; records: number } | null>(null);
  const [employer, setEmployer] = React.useState({ id: "", agent: "" });

  const act = async <T,>(label: string, body: Record<string, unknown>): Promise<T | null> => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<T>("/api/ledger/payroll", {
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

  const run = async () => {
    const r = await act<{ employees: number; alreadyPosted: boolean; totals: Summary["totals"]; skipped: { code: string; reason: string }[] }>(
      "run", { action: "run", period },
    );
    if (!r) return;
    setSkipped(r.skipped ?? []);
    setMsg(
      r.alreadyPosted
        ? `${period} is already posted — the payslips below are what the ledger was built from.`
        : `Drafted ${r.employees} payslip${r.employees === 1 ? "" : "s"} for ${period}. Nothing is in the ledger until it is posted.`,
    );
  };

  const postRun = async () => {
    const r = await act<{ reference: string; alreadyPosted: boolean; netMinor: string }>("post", { action: "post", period });
    if (!r) return;
    setMsg(r.alreadyPosted ? `${period} was already posted as ${r.reference}.` : `Posted ${period} as ${r.reference}.`);
  };

  const pay = async () => {
    const r = await act<{ reference: string; alreadyPaid: boolean; paidMinor: string }>("pay", { action: "pay", period });
    if (!r) return;
    setMsg(r.alreadyPaid ? `${period} was already paid as ${r.reference}.` : `Paid ${period} as ${r.reference}.`);
  };

  const buildSif = async () => {
    setSif(null);
    const r = await act<{ filename: string; csv: string; records: number; totalMinor: string }>("wps", {
      action: "wps", period, employerId: employer.id, employerAgentId: employer.agent,
    });
    if (!r) return;
    setSif(r);
    setMsg(`${r.filename} — ${r.records} record${r.records === 1 ? "" : "s"}. Check it before it goes to the bank.`);
  };

  // The file is built server-side and shown before it is saved: a bank rejects
  // the whole batch for one bad record, so the operator gets to look first.
  const download = () => {
    if (!sif) return;
    const url = URL.createObjectURL(new Blob([sif.csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = sif.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * A pay rise, a corrected IBAN, a name spelled properly.
   *
   * The alternative before this existed was a second employee code, which
   * restarts the gratuity clock — the record would then show two people with
   * one person's service, and Article 51 is computed from the joining date.
   */
  const amend = async (code: string, changes: Record<string, unknown>) => {
    const r = await act<{ employee: { code: string; name: string } }>("update-employee", {
      action: "update-employee", employeeCode: code, changes,
    });
    if (!r) return;
    setOpenRow(null);
    setMsg(
      `Amended ${r.employee.code} ${r.employee.name}. A pay change takes effect from the next run — every posted ` +
        `payslip stays exactly as it was, for the same reason a change in estimate does not rewrite last year.`,
    );
  };

  /**
   * Settling a leaver, which is the only thing that ever writes a leaving date.
   *
   * Without it a person who left in March keeps drawing a full salary, a WPS
   * record, a gratuity increment and a leave provision every month afterwards —
   * and because the payslips and the ledger both carry the same wrong figure,
   * the reconciliation above cannot detect it. Article 53 of Federal
   * Decree-Law 33/2021 gives fourteen days from the end of the contract.
   */
  const settle = async (e: EmployeeRow, leftOn: string, settlementAccount: string) => {
    const answer = await ask({
      title: `Settle ${e.name} (${e.code})?`,
      detail:
        `This posts the end-of-service settlement dated ${leftOn}, releases the gratuity held at 2250, and marks ` +
        `${e.code} as left so no further run pays them. A settlement is made once. Article 53 of Federal ` +
        `Decree-Law 33/2021 requires it within fourteen days of the contract ending.`,
      confirmLabel: "Settle",
      destructive: true,
    });
    if (answer === null) return;

    const r = await act<{
      entitlementMinor: string; provisionHeldMinor: string; differenceMinor: string;
      serviceDays: number; reference: string | null;
    }>("settle", { action: "settle", employeeCode: e.code, leftOn, settlementAccount });
    if (!r) return;
    setOpenRow(null);
    setMsg(
      r.reference
        ? `Settled ${e.code} on ${leftOn}: ${r.serviceDays} days of service, ${fmtMinor(r.entitlementMinor, "AED", { zero: "zero" })} ` +
          `owed against ${fmtMinor(r.provisionHeldMinor, "AED", { zero: "zero" })} already provided. Posted as ${r.reference}.`
        : `${e.code} left on ${leftOn} after ${r.serviceDays} days. Nothing was owed and nothing had been provided, ` +
          `so there was no entry to post.`,
    );
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const posted = data?.payslips.some((p) => p.status !== "draft") ?? false;
  const paid = data?.payslips.length ? data.payslips.every((p) => p.status === "paid") : false;

  return (
    <>
      <PageHead
        title="Payroll"
        sub="The month's payslips, the gratuity they accrue, and the ledger accounts both have to agree with. End-of-service is provided for month by month under Article 51, not left to the day somebody resigns."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Month</span>
              <input
                type="month"
                className="sw-input"
                style={{ width: "9rem" }}
                value={period}
                onChange={(e) => { setPeriod(e.target.value); setSkipped([]); setSif(null); }}
                aria-label="Payroll month"
              />
            </label>
            <button
              type="button" className="sw-btn sw-btn-primary" onClick={run}
              disabled={busy === "run"} aria-disabled={busy === "run" || undefined}
              data-testid="run-payroll"
            >
              {busy === "run" ? "Running…" : "Run payroll"}
            </button>
            <button
              type="button" className="sw-btn" onClick={postRun}
              disabled={busy === "post" || posted} aria-disabled={busy === "post" || posted || undefined}
              data-testid="post-payroll"
            >
              {busy === "post" ? "Posting…" : "Post"}
            </button>
            <button
              type="button" className="sw-btn" onClick={pay}
              disabled={busy === "pay" || !posted || paid} aria-disabled={busy === "pay" || !posted || paid || undefined}
              data-testid="pay-payroll"
            >
              {busy === "pay" ? "Paying…" : "Pay"}
            </button>
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)}>
              {adding ? "Cancel" : "Add employee"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="payroll-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <AddEmployee
          busy={busy === "add-employee"}
          onAdd={async (employee) => {
            const r = await act("add-employee", { action: "add-employee", employee });
            if (r) { setAdding(false); setMsg(`Added ${employee.code} ${employee.name} to the payroll.`); }
          }}
        />
      )}

      {skipped.length > 0 && (
        <Panel className="mb-4 p-3">
          <div className="sw-label">Left out of the run</div>
          <ul className="mt-1.5 space-y-0.5" data-testid="payroll-skipped">
            {skipped.map((s) => (
              <li key={s.code} className="sw-sub">
                <span className="sw-code">{s.code}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {loading && !data && <Loading />}

      {data && (
        <>
          <Panel className="mb-4 p-4">
            <div className="sw-label">Payslips against the ledger</div>
            <table className="sw-table mt-3" style={{ maxWidth: "48rem" }}>
              <caption className="sr-only">The payslips for this period against accounts 6000, 2200 and 2250</caption>
              <thead>
                <tr>
                  <th />
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Payslips</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Ledger</th>
                  <th style={{ width: "7rem" }} />
                </tr>
              </thead>
              <tbody>
                <Compare label={`Salaries charged in ${data.period}`} account="6000" a={data.register.salariesMinor} b={data.ledger.salariesMinor} ok={data.ledger.salariesAgree} />
                <Compare label="Salaries owed and not yet paid" account="2200" a={data.register.payableMinor} b={data.ledger.payableMinor} ok={data.ledger.payableAgrees} />
                <Compare label="Gratuity held for people still employed" account="2250" a={data.register.provisionMinor} b={data.ledger.provisionMinor} ok={data.ledger.provisionAgrees} />
              </tbody>
            </table>
            {!data.ledger.agrees && (
              <p className="sw-sub mt-2" style={{ color: "var(--sw-neg)" }}>
                The payslips and the ledger disagree. That is a finding, not a display problem — a run was
                probably posted and then amended, or something reached 2200 or 2250 outside payroll.
              </p>
            )}
          </Panel>

          <Panel className="mb-4 p-4">
            <div className="sw-label">WPS salary information file</div>
            <p className="sw-sub mt-1 max-w-[70ch]">
              One EDR record per employee and an SCR trailer the bank reconciles the batch against. A bank
              rejects the whole file for one incomplete record, so it refuses to build until every person has
              a MOL person id, a routing code and a UAE IBAN.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <Field label="Establishment id (13 digits)">
                <input className="sw-input" inputMode="numeric" value={employer.id}
                  onChange={(e) => setEmployer((x) => ({ ...x, id: e.target.value }))} placeholder="1234567890123" />
              </Field>
              <Field label="Employer routing code (9 digits)">
                <input className="sw-input" inputMode="numeric" value={employer.agent}
                  onChange={(e) => setEmployer((x) => ({ ...x, agent: e.target.value }))} placeholder="023456789" />
              </Field>
              <button
                type="button" className="sw-btn" onClick={buildSif}
                disabled={busy === "wps"} aria-disabled={busy === "wps" || undefined}
                data-testid="build-sif"
              >
                {busy === "wps" ? "Building…" : "Build file"}
              </button>
              {sif && (
                <button type="button" className="sw-btn sw-btn-primary" onClick={download} data-testid="download-sif">
                  Download {sif.filename}
                </button>
              )}
            </div>
            {sif && (
              <pre className="sw-scroll mt-3 p-2 text-[0.6875rem]" data-testid="sif-preview"
                style={{ border: "1px solid var(--sw-line)", whiteSpace: "pre", overflowX: "auto" }}>
                {sif.csv}
              </pre>
            )}
          </Panel>

          {data.payslips.length === 0 ? (
            <Empty>No payslips for {data.period} yet. Run the payroll for the month.</Empty>
          ) : (
            <Panel className="mb-4 overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Payslips for {data.period}</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "6rem" }}>Code</th>
                      <th>Employee</th>
                      <th className="hidden md:table-cell" style={{ width: "5rem" }}>Days</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Basic</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Allowances</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Deductions</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Gratuity</th>
                      <th style={{ width: "6rem" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payslips.map((p) => (
                      <tr key={p.code}>
                        <td className="sw-code">{p.code}</td>
                        <td className="max-w-0 truncate">{p.name}</td>
                        <td className="hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>
                          {p.daysOnPayroll}/{p.daysInMonth}
                        </td>
                        <td className="sw-num"><Figure minor={p.basicMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={p.allowancesMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={p.deductionsMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={p.netMinor} /></td>
                        <td className="sw-num"><Figure minor={p.gratuityMinor} colour={false} /></td>
                        <td><StatusChip status={p.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={3} style={{ textAlign: "start" }}>{data.period}</th>
                      <td className="sw-num" colSpan={2}><Figure minor={data.totals.grossMinor} zero="zero" colour={false} /></td>
                      <td className="sw-num"><Figure minor={data.totals.deductionsMinor} zero="zero" colour={false} /></td>
                      <td className="sw-num" data-testid="payroll-net"><Figure minor={data.totals.netMinor} zero="zero" /></td>
                      <td className="sw-num" data-testid="payroll-gratuity"><Figure minor={data.totals.gratuityMinor} zero="zero" colour={false} /></td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>
          )}

          <Panel className="overflow-hidden">
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Employees</caption>
                <thead>
                  <tr>
                    <th style={{ width: "6rem" }}>Code</th>
                    <th>Employee</th>
                    <th style={{ width: "7rem" }}>Joined</th>
                    <th className="hidden md:table-cell" style={{ width: "7rem" }}>Left</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Basic</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Gratuity to date</th>
                    <th style={{ width: "8rem" }}>WPS</th>
                    <th style={{ width: "6rem" }}>Status</th>
                    <th style={{ width: "11rem" }}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {data.employees.map((e) => (
                    <React.Fragment key={e.code}>
                      <tr>
                        <td className="sw-code">{e.code}</td>
                        <td className="max-w-0 truncate">{e.name}</td>
                        <td>{e.joinedOn}</td>
                        <td className="hidden md:table-cell">{e.leftOn ?? "—"}</td>
                        <td className="sw-num"><Figure minor={e.basicMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={e.gratuityToDateMinor} zero="zero" colour={false} /></td>
                        <td>
                          <span className={`sw-chip ${e.wpsReady ? "sw-chip-ok" : "sw-chip-bad"}`}>
                            {e.wpsReady ? "ready" : "details missing"}
                          </span>
                        </td>
                        <td><StatusChip status={e.status} /></td>
                        <td>
                          <span className="flex flex-wrap items-center gap-1 py-1">
                            <button
                              type="button"
                              className="sw-btn sw-btn-sm"
                              aria-expanded={openRow?.code === e.code && openRow.mode === "amend"}
                              onClick={() => setOpenRow((o) =>
                                o?.code === e.code && o.mode === "amend" ? null : { code: e.code, mode: "amend" })}
                            >
                              <span aria-hidden="true">Amend</span>
                              <span className="sr-only">{`Amend ${e.name}`}</span>
                            </button>
                            {e.status === "active" && (
                              <button
                                type="button"
                                className="sw-btn sw-btn-sm"
                                aria-expanded={openRow?.code === e.code && openRow.mode === "settle"}
                                onClick={() => setOpenRow((o) =>
                                  o?.code === e.code && o.mode === "settle" ? null : { code: e.code, mode: "settle" })}
                              >
                                <span aria-hidden="true">Settle</span>
                                <span className="sr-only">{`Settle end of service for ${e.name}`}</span>
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                      {openRow?.code === e.code && (
                        <tr>
                          <td colSpan={9} style={{ background: "var(--sw-ground)" }}>
                            {openRow.mode === "amend" ? (
                              <AmendEmployee
                                employee={e}
                                busy={busy === "update-employee"}
                                onSave={(changes) => amend(e.code, changes)}
                                onCancel={() => setOpenRow(null)}
                              />
                            ) : (
                              <SettleEmployee
                                employee={e}
                                busy={busy === "settle"}
                                onSettle={(leftOn, account) => settle(e, leftOn, account)}
                                onCancel={() => setOpenRow(null)}
                              />
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
              Gratuity to date is what each person would be owed if they left today — 21 days of basic pay a
              year for the first five years, 30 after that, capped at two years&rsquo; basic.{" "}
              <Link href="/accounting/accounts/2250" className="sw-link">Open the provision</Link>.
            </p>
          </Panel>
        </>
      )}
    </>
  );
}

function Compare({ label, account, a, b, ok }: {
  label: string; account: string; a: string; b: string; ok: boolean;
}) {
  return (
    <tr>
      <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>{label}</th>
      <td className="sw-num"><Figure minor={a} zero="zero" colour={false} /></td>
      <td className="sw-num"><Figure minor={b} zero="zero" colour={false} /></td>
      <td>
        <Link href={`/accounting/accounts/${account}`} className="sw-link">{account}</Link>{" "}
        <span className={`sw-chip ${ok ? "sw-chip-ok" : "sw-chip-bad"}`}>{ok ? "agrees" : "differs"}</span>
      </td>
    </tr>
  );
}

function AddEmployee({ busy, onAdd }: {
  busy: boolean;
  onAdd: (e: {
    code: string; name: string; joinedOn: string; contractType: "UNLIMITED" | "LIMITED";
    basicMinor: string; housingMinor: string; transportMinor: string;
    molPersonId?: string; routingCode?: string; iban?: string;
  }) => void;
}) {
  const [f, setF] = React.useState({
    code: "", name: "", joinedOn: new Date().toISOString().slice(0, 10),
    contractType: "LIMITED" as "UNLIMITED" | "LIMITED",
    basic: "", housing: "", transport: "", mol: "", routing: "", iban: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const basic = parseAmount(f.basic);
  const housing = parseAmount(f.housing) ?? 0n;
  const transport = parseAmount(f.transport) ?? 0n;
  const iban = f.iban.replace(/\s+/g, "");

  const blocker =
    !f.code.trim() ? "Give the employee a code." :
    !f.name.trim() ? "Give the employee a name." :
    basic === null || basic <= 0n ? "Gratuity is computed on basic pay, so a basic salary is required." :
    f.mol && !/^\d{14}$/.test(f.mol) ? "A MOL person id is 14 digits." :
    f.routing && !/^\d{9}$/.test(f.routing) ? "A routing code is 9 digits." :
    iban && !/^AE\d{21}$/.test(iban) ? "A UAE IBAN is AE followed by 21 digits." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Add an employee</div>
      <p className="sw-sub mt-1 max-w-[70ch]">
        The contract, not a transaction. Basic pay is kept apart from allowances because end-of-service
        gratuity is computed on the basic wage alone — a package hidden in allowances accrues nothing.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code"><input className="sw-input" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="E-001" /></Field>
        <Field label="Name"><input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Ahmed Al Mansouri" /></Field>
        <Field label="Joined"><input type="date" className="sw-input" value={f.joinedOn} onChange={(e) => set("joinedOn", e.target.value)} /></Field>
        <Field label="Contract">
          <select className="sw-select" value={f.contractType} onChange={(e) => set("contractType", e.target.value)}>
            <option value="LIMITED">Limited term</option>
            <option value="UNLIMITED">Unlimited (pre-2022)</option>
          </select>
        </Field>
        <Field label="Basic salary"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.basic} onChange={(e) => set("basic", e.target.value)} placeholder="10,000.00" /></Field>
        <Field label="Housing allowance"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.housing} onChange={(e) => set("housing", e.target.value)} placeholder="4,000.00" /></Field>
        <Field label="Transport allowance"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.transport} onChange={(e) => set("transport", e.target.value)} placeholder="1,000.00" /></Field>
        <Field label="MOL person id"><input className="sw-input" inputMode="numeric" value={f.mol} onChange={(e) => set("mol", e.target.value)} placeholder="14 digits" /></Field>
        <Field label="Routing code"><input className="sw-input" inputMode="numeric" value={f.routing} onChange={(e) => set("routing", e.target.value)} placeholder="9 digits" /></Field>
        <Field label="IBAN"><input className="sw-input" value={f.iban} onChange={(e) => set("iban", e.target.value)} placeholder="AE07 0331 2345 6789 0123 456" /></Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="save-employee"
          onClick={() => onAdd({
            code: f.code.trim(), name: f.name.trim(), joinedOn: f.joinedOn, contractType: f.contractType,
            basicMinor: (basic as bigint).toString(),
            housingMinor: housing.toString(), transportMinor: transport.toString(),
            ...(f.mol ? { molPersonId: f.mol } : {}),
            ...(f.routing ? { routingCode: f.routing } : {}),
            ...(iban ? { iban } : {}),
          })}
        >
          {busy ? "Saving…" : "Add to payroll"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="employee-blocker">{blocker}</span>}
      </div>
    </Panel>
  );
}

/**
 * Amending an employment record.
 *
 * Only what changed is sent. `updateEmployee` reads an omitted field as "leave
 * it alone" and an explicit null as "clear it", so a blank bank field here has
 * to mean unchanged — otherwise opening this form on somebody and pressing Save
 * would wipe the WPS details the file cannot be built without.
 *
 * The joining date is deliberately not offered: the module refuses to move it
 * once a payslip is posted, because the gratuity already charged to 6050 was
 * measured from it, and a control that only ever refuses is a control better
 * expressed as an absent field.
 */
function AmendEmployee({ employee, busy, onSave, onCancel }: {
  employee: EmployeeRow;
  busy: boolean;
  onSave: (changes: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [f, setF] = React.useState({
    name: employee.name,
    basic: toInput(employee.basicMinor),
    mol: "", routing: "", iban: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const basic = parseAmount(f.basic);
  const iban = f.iban.replace(/\s+/g, "");

  const blocker =
    !f.name.trim() ? "An employee cannot be left without a name." :
    basic === null || basic <= 0n ? "Gratuity is computed on basic pay, so the basic salary has to stay above nil." :
    f.mol && !/^\d{14}$/.test(f.mol) ? "A MOL person id is 14 digits." :
    f.routing && !/^\d{9}$/.test(f.routing) ? "A routing code is 9 digits." :
    iban && !/^AE\d{21}$/.test(iban) ? "A UAE IBAN is AE followed by 21 digits." :
    null;

  const changes = () => {
    const c: Record<string, unknown> = {};
    if (f.name.trim() !== employee.name) c.name = f.name.trim();
    if ((basic as bigint).toString() !== employee.basicMinor) c.basicMinor = (basic as bigint).toString();
    if (f.mol) c.molPersonId = f.mol;
    if (f.routing) c.routingCode = f.routing;
    if (iban) c.iban = iban;
    return c;
  };
  const nothing = Object.keys(changes()).length === 0;

  return (
    <div className="p-3">
      <div className="sw-label">Amend {employee.code}</div>
      <p className="sw-sub mt-1 max-w-[75ch]">
        A pay change applies from the next run and leaves every posted payslip alone. The bank fields are blank
        because a blank one is left as it is — fill one in only to set or correct it.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Name">
          <input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)}
            aria-label={`Name for ${employee.code}`} />
        </Field>
        <Field label="Basic salary">
          <input className="sw-input sw-cell-num" inputMode="decimal" value={f.basic}
            onChange={(e) => set("basic", e.target.value)} aria-label={`Basic salary for ${employee.code}`} />
        </Field>
        <Field label="MOL person id">
          <input className="sw-input" inputMode="numeric" value={f.mol} placeholder="unchanged"
            onChange={(e) => set("mol", e.target.value)} aria-label={`MOL person id for ${employee.code}`} />
        </Field>
        <Field label="Routing code">
          <input className="sw-input" inputMode="numeric" value={f.routing} placeholder="unchanged"
            onChange={(e) => set("routing", e.target.value)} aria-label={`Routing code for ${employee.code}`} />
        </Field>
        <Field label="IBAN">
          <input className="sw-input" value={f.iban} placeholder="unchanged"
            onChange={(e) => set("iban", e.target.value)} aria-label={`IBAN for ${employee.code}`} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || nothing || busy}
          aria-disabled={blocker !== null || nothing || busy || undefined}
          data-testid={`amend-${employee.code}`}
          onClick={() => onSave(changes())}
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button type="button" className="sw-btn" onClick={onCancel}>Cancel</button>
        {(blocker || nothing) && (
          <span className="sw-sub" role="status">{blocker ?? "Nothing has been changed yet."}</span>
        )}
      </div>
    </div>
  );
}

/**
 * The end-of-service settlement.
 *
 * The date is asked for rather than assumed: the contract ended when it ended,
 * and settling on today's date would measure service and the fourteen-day
 * Article 53 window from the wrong day.
 */
function SettleEmployee({ employee, busy, onSettle, onCancel }: {
  employee: EmployeeRow;
  busy: boolean;
  onSettle: (leftOn: string, settlementAccount: string) => void;
  onCancel: () => void;
}) {
  const [leftOn, setLeftOn] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [account, setAccount] = React.useState("1010");
  const tooEarly = leftOn < employee.joinedOn;

  return (
    <div className="p-3">
      <div className="sw-label">Settle {employee.code} — {employee.name}</div>
      <p className="sw-sub mt-1 max-w-[75ch]">
        Gratuity to date is <Figure minor={employee.gratuityToDateMinor} zero="zero" colour={false} />, which is what
        would be owed if they left today; the settlement is measured on the date below, not on this figure. What has
        already been provided at 2250 is released, the difference goes to 6050, and the entitlement is credited to
        wherever it is being paid from.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="Last day">
          <input type="date" className="sw-input" style={{ width: "10rem" }} value={leftOn}
            onChange={(e) => setLeftOn(e.target.value)} aria-label={`Last day for ${employee.code}`} />
        </Field>
        <Field label="Settle from">
          <select className="sw-select" style={{ width: "16rem" }} value={account}
            onChange={(e) => setAccount(e.target.value)} aria-label={`Settle from — the account paying ${employee.code}`}>
            <option value="1010">1010 Bank — paid now</option>
            <option value="2200">2200 Salaries payable — pay with the next run</option>
          </select>
        </Field>
        <button
          type="button"
          className="sw-btn sw-btn-danger"
          disabled={tooEarly || busy}
          aria-disabled={tooEarly || busy || undefined}
          data-testid={`settle-${employee.code}`}
          onClick={() => onSettle(leftOn, account)}
        >
          {busy ? "Settling…" : "Settle end of service"}
        </button>
        <button type="button" className="sw-btn" onClick={onCancel}>Cancel</button>
      </div>
      {tooEarly && (
        <p className="sw-sub mt-2" style={{ color: "var(--sw-neg)" }} role="status">
          {employee.code} joined on {employee.joinedOn} and cannot leave before that.
        </p>
      )}
    </div>
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
