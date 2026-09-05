"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";
import { fmtMinor, parseAmount } from "@/lib/ledger/format";

interface Entry {
  id: string;
  employeeCode: string;
  projectCode: string | null;
  workedOn: string;
  minutes: number;
  hours: string;
  rateMinor: string;
  costRateMinor: string | null;
  chargeableMinor: string;
  costMinor: string | null;
  description: string;
  billable: boolean;
  status: string;
  invoiceId: string | null;
  writeOffReason: string | null;
}

interface Register {
  asOf: string;
  wip: {
    asOf: string;
    balanceMinor: string;
    minutes: number;
    chargeableMinor: string;
    unratedMinutes: number;
    byProject: {
      projectCode: string | null;
      minutes: number;
      costMinor: string;
      chargeableMinor: string;
      unratedMinutes: number;
    }[];
  };
  entries: Entry[];
  reconciliation: {
    registerMinor: string;
    ledgerMinor: string;
    differenceMinor: string;
    agrees: boolean;
    unratedMinutes: number;
  };
}

interface Person {
  employeeCode: string;
  minutes: number;
  billableMinutes: number;
  invoicedMinutes: number;
  writtenOffMinutes: number;
  chargeableMinor: string;
  invoicedMinor: string;
  writtenOffMinor: string;
  utilisationBps: number | null;
  recoveryBps: number | null;
}

interface Utilisation {
  from: string;
  to: string;
  people: Person[];
  totals: {
    minutes: number;
    billableMinutes: number;
    chargeableMinor: string;
    invoicedMinor: string;
    writtenOffMinor: string;
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);
const monthStart = () => `${thisMonth()}-01`;

/** Minutes as hours and minutes. Never a decimal — 1.5 h and 1 h 30 both read, 1.05 h does not. */
function hoursOf(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Basis points as a percentage, one decimal. Null is a question with no answer, not nought. */
function pct(bps: number | null): string {
  return bps === null ? "—" : `${(bps / 100).toFixed(1)}%`;
}

export default function TimesheetsPage() {
  const entityId = useEntityId();
  const ask = useAsk();
  const [asOf, setAsOf] = React.useState(today);
  const [filter, setFilter] = React.useState("");
  const [tab, setTab] = React.useState<"register" | "utilisation">("register");

  const q = new URLSearchParams({ entityId: entityId ?? "", asOf });
  if (filter) q.set("status", filter);
  const { data, error, loading, reload } = useLedgerQuery<Register>(
    entityId ? `/api/ledger/timesheets?${q.toString()}` : null,
    [asOf, filter],
  );

  const [from, setFrom] = React.useState(monthStart);
  const [to, setTo] = React.useState(today);
  const util = useLedgerQuery<Utilisation>(
    entityId && tab === "utilisation"
      ? `/api/ledger/timesheets?entityId=${entityId}&view=utilisation&from=${from}&to=${to}`
      : null,
    [tab, from, to],
  );

  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [invoiceRef, setInvoiceRef] = React.useState("");

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/timesheets", {
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

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const chosen = [...picked];

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Timesheets and work in progress"
        sub={
          "Time is recorded in minutes, because a decimal hour is a rounding waiting to happen. Unbilled billable " +
          "time is carried on the balance sheet at what it cost, never at what it will be billed for — the margin " +
          "is earned when the invoice is raised, not when the work is done. The run measures the movement against " +
          "what account 1330 actually holds, so running it twice posts once."
        }
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">As at</span>
              <input type="date" className="sw-input" style={{ width: "10rem" }} value={asOf}
                onChange={(e) => setAsOf(e.target.value)} aria-label="Date to show the register up to" />
            </label>
            <button type="button" className="sw-btn sw-btn-primary" data-testid="run-wip"
              disabled={busy === "wip"}
              onClick={async () => {
                const r = await act("wip", { action: "wip", period: asOf.slice(0, 7) });
                if (r) setMsg(String(r.note));
              }}>
              {busy === "wip" ? "Posting…" : `Run WIP for ${asOf.slice(0, 7)}`}
            </button>
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)} data-testid="toggle-add-time">
              {adding ? "Cancel" : "Record time"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="timesheet-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <NewTime
          busy={busy === "record"}
          onRecord={async (entry) => {
            const r = await act("record", { action: "record", entry });
            if (r) { setAdding(false); setMsg(`Recorded ${hoursOf(entry.minutes)} for ${entry.employeeCode}. It is not on the ledger until the run.`); }
          }}
        />
      )}

      <nav className="sw-tabs mb-4" aria-label="What to show">
        <button type="button" className="sw-tab" aria-current={tab === "register" ? "page" : undefined}
          onClick={() => setTab("register")}>Register</button>
        <button type="button" className="sw-tab" aria-current={tab === "utilisation" ? "page" : undefined}
          onClick={() => setTab("utilisation")}>Utilisation and recovery</button>
      </nav>

      {tab === "register" && (
        <>
          {loading && !data && <Loading />}
          {data && (
            <>
              <Panel className="mb-4 p-4">
                <dl className="grid gap-4 sm:grid-cols-4">
                  <div>
                    <dt className="sw-label">Unbilled time</dt>
                    <dd className="sw-num mt-1 text-lg">{hoursOf(data.wip.minutes)}</dd>
                  </div>
                  <div>
                    <dt className="sw-label">Carried at cost</dt>
                    <dd className="sw-num mt-1 text-lg" data-testid="wip-balance">
                      <Figure minor={data.wip.balanceMinor} colour={false} />
                    </dd>
                  </div>
                  <div>
                    <dt className="sw-label">What it would be billed</dt>
                    <dd className="sw-num mt-1 text-lg"><Figure minor={data.wip.chargeableMinor} colour={false} /></dd>
                    <p className="sw-sub mt-0.5">Not an asset. The difference is margin not yet earned.</p>
                  </div>
                  <div>
                    <dt className="sw-label">On the ledger</dt>
                    <dd className="sw-num mt-1 text-lg" data-testid="wip-ledger">
                      <Figure minor={data.reconciliation.ledgerMinor} colour={false} />
                    </dd>
                    <p className="sw-sub mt-0.5">
                      {data.reconciliation.agrees
                        ? "Agrees with the register."
                        : "Differs from the register — run WIP, or find the posting by hand."}
                    </p>
                  </div>
                </dl>

                {!data.reconciliation.agrees && (
                  <p className="sw-sub mt-3" style={{ color: "var(--sw-warn)" }} role="status" data-testid="wip-difference">
                    Account 1330 is out by <Figure minor={data.reconciliation.differenceMinor} />. The register is what
                    the timesheets say; the ledger is what was posted. Only the run reconciles them.
                  </p>
                )}
                {data.reconciliation.unratedMinutes > 0 && (
                  <p className="sw-sub mt-2">
                    {hoursOf(data.reconciliation.unratedMinutes)} has no cost rate and is therefore carried at nothing.
                    Unknown cost is not free cost — the balance understates the asset until a rate is given.
                  </p>
                )}
              </Panel>

              {data.wip.byProject.length > 0 && (
                <Panel className="mb-4 overflow-hidden">
                  <div className="sw-scroll">
                    <table className="sw-table">
                      <caption className="sr-only">Unbilled time by project</caption>
                      <thead>
                        <tr>
                          <th>Project</th>
                          <th className="sw-num" style={{ width: "7rem" }}>Time</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>At cost</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Chargeable</th>
                        </tr>
                      </thead>
                      <tbody data-testid="wip-projects">
                        {data.wip.byProject.map((p) => (
                          <tr key={p.projectCode ?? "—"}>
                            <td className="sw-code">{p.projectCode ?? "No project"}</td>
                            <td className="sw-num">{hoursOf(p.minutes)}</td>
                            <td className="sw-num"><Figure minor={p.costMinor} colour={false} /></td>
                            <td className="sw-num"><Figure minor={p.chargeableMinor} colour={false} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}

              <div className="mb-3 flex flex-wrap items-end gap-3">
                <label className="flex items-center gap-1.5">
                  <span className="sw-label">Showing</span>
                  <select className="sw-select" style={{ width: "12rem" }} value={filter}
                    onChange={(e) => { setFilter(e.target.value); setPicked(new Set()); }}
                    aria-label="Which entries to show">
                    <option value="">everything</option>
                    <option value="draft">not yet approved</option>
                    <option value="approved">approved</option>
                    <option value="invoiced">invoiced</option>
                    <option value="written_off">written off</option>
                  </select>
                </label>
                {chosen.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2" role="group" aria-label="What to do with the chosen entries">
                    <span className="sw-sub">{chosen.length} chosen</span>
                    <button type="button" className="sw-btn sw-btn-sm" disabled={busy === "approve"}
                      data-testid="approve-time"
                      onClick={async () => {
                        const r = await act("approve", { action: "approve", ids: chosen });
                        if (r) { setPicked(new Set()); setMsg(`Approved ${r.approved} entr${Number(r.approved) === 1 ? "y" : "ies"}.`); }
                      }}>
                      Approve
                    </button>
                    <button type="button" className="sw-btn sw-btn-sm" disabled={busy === "writeOff"}
                      data-testid="write-off-time"
                      onClick={async () => {
                        const rows = data.entries.filter((t) => picked.has(t.id));
                        const mins = rows.reduce((a, t) => a + t.minutes, 0);
                        const charge = rows.reduce((a, t) => a + BigInt(t.chargeableMinor), 0n);
                        const reason = await ask({
                          title:
                            rows.length === 1
                              ? `Why is this ${hoursOf(mins)} not being billed?`
                              : `Why are these ${rows.length} entries — ${hoursOf(mins)} — not being billed?`,
                          detail:
                            "The time stops counting towards work in progress, so the next run takes its cost back out " +
                            "of 1330 and leaves it in 5100: the firm carries what the work cost. The " +
                            `${fmtMinor(charge, "AED", { zero: "zero" })} it would have been billed at was never revenue, ` +
                            "so nothing reverses there. Nothing is deleted either — the entries stay on the record with " +
                            "this reason against them, and it is the answer a client gets when they ask why an hour on " +
                            "their matter was not charged.",
                          reason: {
                            label: "Reason",
                            placeholder: "Quoted four hours, the migration took nine",
                            minLength: 10,
                            hint:
                              "Written-off time is the only honest measure a firm has of how well it estimates. " +
                              "A one-word reason teaches nobody anything.",
                          },
                          confirmLabel: "Write it off",
                        });
                        if (reason === null) return;
                        const r = await act("writeOff", { action: "writeOff", ids: chosen, reason });
                        if (r) { setPicked(new Set()); setMsg(`Wrote off ${r.writtenOff} entr${Number(r.writtenOff) === 1 ? "y" : "ies"}. It stays on the record with its reason.`); }
                      }}>
                      Write off
                    </button>
                    <label className="flex items-center gap-1.5">
                      <span className="sw-label">Onto invoice</span>
                      <input className="sw-input sw-input-sm sw-code" style={{ width: "9rem" }}
                        value={invoiceRef} placeholder="INV-1042" data-testid="invoice-ref"
                        aria-label="Which invoice the chosen time went onto"
                        onChange={(e) => setInvoiceRef(e.target.value)} />
                    </label>
                    <button type="button" className="sw-btn sw-btn-sm"
                      disabled={busy === "invoice" || !invoiceRef.trim()}
                      aria-disabled={busy === "invoice" || !invoiceRef.trim() || undefined}
                      data-testid="invoice-time"
                      onClick={async () => {
                        const r = await act("invoice", {
                          action: "invoice", ids: chosen, invoiceId: invoiceRef.trim(),
                        });
                        if (r) {
                          setPicked(new Set());
                          setInvoiceRef("");
                          setMsg(
                            `Charged ${r.invoiced} entr${Number(r.invoiced) === 1 ? "y" : "ies"} onto ${r.invoiceId}. ` +
                            `The next work-in-progress run takes that cost out of 1330 and leaves it in 5100, ` +
                            `where the margin on the invoice is earned.`,
                          );
                        }
                      }}>
                      Invoiced
                    </button>
                  </div>
                )}
              </div>

              {data.entries.length === 0 ? (
                <Empty>No time recorded up to {data.asOf}.</Empty>
              ) : (
                <Panel className="overflow-hidden">
                  <div className="sw-scroll">
                    <table className="sw-table">
                      <caption className="sr-only">Time recorded, with what it is worth</caption>
                      <thead>
                        <tr>
                          <th style={{ width: "2.5rem" }}><span className="sr-only">Chosen</span></th>
                          <th style={{ width: "7rem" }}>Worked</th>
                          <th style={{ width: "8rem" }}>Who</th>
                          <th style={{ width: "8rem" }}>Project</th>
                          <th>What was done</th>
                          <th className="sw-num" style={{ width: "6rem" }}>Time</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Chargeable</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>At cost</th>
                          <th style={{ width: "7rem" }}>Status</th>
                        </tr>
                      </thead>
                      <tbody data-testid="timesheet-rows">
                        {data.entries.map((t) => (
                          <tr key={t.id}>
                            <td>
                              <input type="checkbox" className="sw-check" checked={picked.has(t.id)}
                                onChange={() => toggle(t.id)}
                                disabled={t.status !== "draft" && t.status !== "approved"}
                                aria-label={`Choose ${t.employeeCode} on ${t.workedOn}`} />
                            </td>
                            <td>{t.workedOn}</td>
                            <td className="sw-code">{t.employeeCode}</td>
                            <td className="sw-code">{t.projectCode ?? "—"}</td>
                            <td className="max-w-0 truncate">
                              {t.description}
                              {!t.billable && <span className="sw-chip ml-1.5">not billable</span>}
                              {t.writeOffReason && <span className="sw-sub"> — {t.writeOffReason}</span>}
                            </td>
                            <td className="sw-num">{hoursOf(t.minutes)}</td>
                            <td className="sw-num"><Figure minor={t.chargeableMinor} colour={false} /></td>
                            <td className="sw-num">
                              {t.costMinor === null
                                ? <span className="sw-sub">no rate</span>
                                : <Figure minor={t.costMinor} colour={false} />}
                            </td>
                            <td><StatusChip status={t.status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}

              <p className="sw-sub mt-3 max-w-[75ch]">
                Draft time counts towards work in progress. It was worked whether or not a manager has got round to
                approving it, and leaving it out would make the balance sheet depend on how fast the approvals queue
                moves. Writing time off removes it from the asset and keeps it on the record, with the reason, because
                the pattern of what a firm cannot bill is worth more than the entries it deletes.
              </p>
              <p className="sw-sub mt-2 max-w-[75ch]">
                Marking time invoiced is how billable work leaves the asset the ordinary way. Only approved billable
                time can be marked — approval is what somebody other than the person who wrote the time does to it
                before a client sees it — and the invoice is named so the charge can be traced back to the hours
                behind it. Time that has already been charged is corrected with a credit note, not by editing the
                timesheet.
              </p>
            </>
          )}
        </>
      )}

      {tab === "utilisation" && (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <label className="flex items-center gap-1.5">
              <span className="sw-label">From</span>
              <input type="date" className="sw-input" style={{ width: "10rem" }} value={from}
                onChange={(e) => setFrom(e.target.value)} aria-label="Utilisation from" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">To</span>
              <input type="date" className="sw-input" style={{ width: "10rem" }} value={to}
                onChange={(e) => setTo(e.target.value)} aria-label="Utilisation to" />
            </label>
          </div>

          {util.error && <ErrorNote>{util.error}</ErrorNote>}
          {util.loading && !util.data && <Loading />}

          {util.data && (util.data.people.length === 0 ? (
            <Empty>No time recorded between {util.data.from} and {util.data.to}.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Utilisation and recovery by person</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "9rem" }}>Who</th>
                      <th className="sw-num" style={{ width: "6rem" }}>Recorded</th>
                      <th className="sw-num" style={{ width: "6rem" }}>Billable</th>
                      <th className="sw-num" style={{ width: "6rem" }}>Utilisation</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Chargeable</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Invoiced</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Written off</th>
                      <th className="sw-num" style={{ width: "6rem" }}>Recovery</th>
                    </tr>
                  </thead>
                  <tbody data-testid="utilisation-rows">
                    {util.data.people.map((p) => (
                      <tr key={p.employeeCode}>
                        <td className="sw-code">{p.employeeCode}</td>
                        <td className="sw-num">{hoursOf(p.minutes)}</td>
                        <td className="sw-num">{hoursOf(p.billableMinutes)}</td>
                        <td className="sw-num">{pct(p.utilisationBps)}</td>
                        <td className="sw-num"><Figure minor={p.chargeableMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={p.invoicedMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={p.writtenOffMinor} colour={false} /></td>
                        <td className="sw-num">{pct(p.recoveryBps)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <th className="sw-num">{hoursOf(util.data.totals.minutes)}</th>
                      <th className="sw-num">{hoursOf(util.data.totals.billableMinutes)}</th>
                      <th className="sw-num">
                        {pct(util.data.totals.minutes === 0
                          ? null
                          : Math.round((util.data.totals.billableMinutes * 10000) / util.data.totals.minutes))}
                      </th>
                      <th className="sw-num"><Figure minor={util.data.totals.chargeableMinor} colour={false} /></th>
                      <th className="sw-num"><Figure minor={util.data.totals.invoicedMinor} colour={false} /></th>
                      <th className="sw-num"><Figure minor={util.data.totals.writtenOffMinor} colour={false} /></th>
                      <th className="sw-num" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>
          ))}

          <p className="sw-sub mt-3 max-w-[75ch]">
            Utilisation is billable time as a share of time recorded; recovery is what was invoiced as a share of what
            the time was worth at the rate. Neither is shown as nought where nothing was recorded — a rate against no
            time is a question with no answer, and printing 0% for it would be a lie a partner might act on.
          </p>
        </>
      )}
    </>
  );
}

function NewTime({ busy, onRecord }: {
  busy: boolean;
  onRecord: (e: {
    employeeCode: string; projectCode?: string; workedOn: string; minutes: number;
    rateMinor: string; costRateMinor?: string; description: string; billable: boolean;
  }) => void;
}) {
  const [employee, setEmployee] = React.useState("");
  const [project, setProject] = React.useState("");
  const [workedOn, setWorkedOn] = React.useState(today);
  const [hours, setHours] = React.useState("");
  const [minutes, setMinutes] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [cost, setCost] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [billable, setBillable] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

  const total = (Number(hours) || 0) * 60 + (Number(minutes) || 0);

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Time worked</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="sw-label">Who</span>
          <input className="sw-input mt-1" value={employee} onChange={(e) => setEmployee(e.target.value)} placeholder="EMP-1" />
        </label>
        <label className="block">
          <span className="sw-label">Project</span>
          <input className="sw-input mt-1" value={project} onChange={(e) => setProject(e.target.value)} placeholder="optional" />
        </label>
        <label className="block">
          <span className="sw-label">Worked on</span>
          <input type="date" className="sw-input mt-1" value={workedOn} onChange={(e) => setWorkedOn(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="sw-label">Hours</span>
            <input className="sw-input sw-num mt-1" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="0" />
          </label>
          <label className="block">
            <span className="sw-label">Minutes</span>
            <input className="sw-input sw-num mt-1" value={minutes} onChange={(e) => setMinutes(e.target.value)} placeholder="0" />
          </label>
        </div>
        <label className="block">
          <span className="sw-label">Charge-out, per hour</span>
          <input className="sw-input sw-num mt-1" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0.00" />
        </label>
        <label className="block">
          <span className="sw-label">Cost, per hour</span>
          <input className="sw-input sw-num mt-1" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="optional" />
          <span className="sw-sub">Left empty, the time is carried at nothing.</span>
        </label>
        <label className="block sm:col-span-2">
          <span className="sw-label">What was done</span>
          <input className="sw-input mt-1" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>

      <label className="mt-3 flex items-center gap-2">
        <input type="checkbox" className="sw-check" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
        <span>Billable — it belongs in work in progress and can be invoiced.</span>
      </label>

      {total > 0 && <p className="sw-sub mt-2">{hoursOf(total)} recorded as {total} minutes.</p>}
      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <div className="mt-3">
        <button type="button" className="sw-btn sw-btn-primary" disabled={busy} data-testid="save-time"
          onClick={() => {
            if (!employee.trim()) { setErr("Time belongs to somebody. Give the employee code."); return; }
            if (!description.trim()) { setErr("Say what was done — the description is what makes a write-off arguable."); return; }
            if (total <= 0) { setErr("Give the time worked, in hours and minutes."); return; }
            const r = parseAmount(rate, "AED");
            if (r === null || r < 0n) { setErr("The charge-out rate has to be an amount I can read."); return; }
            let c: bigint | null = null;
            if (cost.trim()) {
              c = parseAmount(cost, "AED");
              if (c === null || c < 0n) { setErr("The cost rate has to be an amount I can read."); return; }
            }
            setErr(null);
            onRecord({
              employeeCode: employee.trim(),
              projectCode: project.trim() || undefined,
              workedOn,
              minutes: total,
              rateMinor: r.toString(),
              costRateMinor: c === null ? undefined : c.toString(),
              description: description.trim(),
              billable,
            });
          }}>
          {busy ? "Recording…" : "Record the time"}
        </button>
      </div>
    </Panel>
  );
}
