"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { parseAmount, toInput } from "@/lib/ledger/format";

interface Lease {
  code: string; name: string; lessor: string | null;
  startsOn: string; endsOn: string; termMonths: number; frequency: string;
  paymentMinor: string; annualRateBps: number; periodRateBps: number;
  initialLiabilityMinor: string; liabilityMinor: string;
  initialRouMinor: string; accumRouDepMinor: string; rouCarryingMinor: string;
  chargedTo: string | null; status: string;
  exempt: boolean; exemptionReason: string | null; exemptionNote: string | null;
}
interface Register {
  leases: Lease[];
  totals: { liabilityMinor: string; rouCarryingMinor: string; initialRouMinor: string; accumRouDepMinor: string };
  ledger: { liabilityMinor: string; rouMinor: string; liabilityAgrees: boolean; rouAgrees: boolean };
  exemptions: { code: string; name: string; reason: string; note: string; annualRentMinor: string }[];
}
interface Schedule {
  leaseCode: string; name: string; status: string; activated: boolean;
  exempt: boolean; exemptionReason: string | null;
  periods: number; annualRateBps: number; periodRateBps: number;
  initialLiabilityMinor: string; initialRouMinor: string;
  rows: {
    periodNo: number; period: string;
    openingLiabilityMinor: string; interestMinor: string; paymentMinor: string;
    closingLiabilityMinor: string; rouDepreciationMinor: string; closingRouMinor: string;
  }[];
  totals: { interestMinor: string; paymentsMinor: string; depreciationMinor: string };
  note: string | null;
}

const thisMonth = () => new Date().toISOString().slice(0, 7);
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

export default function LeasesPage() {
  const entityId = useEntityId();
  const { data, error, loading, reload } = useLedgerQuery<Register>(
    entityId ? `/api/ledger/leases?entityId=${entityId}` : null,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [period, setPeriod] = React.useState(thisMonth);
  const [adding, setAdding] = React.useState(false);
  const [skipped, setSkipped] = React.useState<{ code: string; reason: string }[]>([]);
  const [openCode, setOpenCode] = React.useState<string | null>(null);
  const [exemptChoice, setExemptChoice] = React.useState<Record<string, string>>({});

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/leases", {
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

  const runMonth = async () => {
    const r = await act("run", { action: "run", period });
    if (!r) return;
    const n = Number(r.leasesCharged);
    const s = (r.skipped as { code: string; reason: string }[]) ?? [];
    setSkipped(s);
    setMsg(
      n === 0
        ? `Nothing to charge in ${period}.` + (s.length ? ` ${s.length} lease${s.length === 1 ? " was" : "s were"} skipped — see below.` : "")
        : `Charged ${n} lease${n === 1 ? "" : "s"} for ${period} as ${r.reference}.` + (s.length ? ` ${s.length} skipped.` : ""),
    );
  };

  const commence = async (code: string) => {
    const choice = exemptChoice[code] ?? "";
    const r = await act(`activate:${code}`, { action: "activate", leaseCode: code, exempt: choice });
    if (!r) return;
    setMsg(
      r.exempt
        ? `${code} commenced under the ${String(r.exemptionReason).toLowerCase().replace("_", "-")} exemption. Nothing goes on the balance sheet; the payments go to rent.`
        : `${code} commenced as ${r.reference} — a right-of-use asset and a lease liability of ${toInput(String(r.initialLiabilityMinor))}.`,
    );
  };

  const pay = async (code: string) => {
    const r = await act(`pay:${code}`, { action: "pay", leaseCode: code, period });
    if (!r) return;
    setMsg(
      r.alreadyRecorded
        ? `${code} was already paid for ${period} — nothing posted (${r.reference}).`
        : `Paid ${code} for ${period} as ${r.reference}. ${toInput(String(r.liabilityMinor))} of liability remains.`,
    );
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Leases"
        sub={
          "IFRS 16 puts almost every lease on the balance sheet. Each month the liability unwinds interest and the " +
          "right-of-use asset depreciates — two separate charges. The payment settles the liability and is not an " +
          "expense. Total lease cost is therefore front-loaded against the old straight-line rent, and in no single " +
          "year do the two come to the same figure."
        }
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
                aria-label="Month to charge"
              />
            </label>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              onClick={runMonth}
              aria-disabled={busy === "run" || undefined}
              disabled={busy === "run"}
              data-testid="run-lease-period"
            >
              {busy === "run" ? "Running…" : "Charge the month"}
            </button>
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)} data-testid="toggle-add-lease">
              {adding ? "Cancel" : "Add lease"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="lease-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <AddLease
          busy={busy === "add"}
          onAdd={async (lease) => {
            const r = await act("add", { action: "add", lease });
            if (r) { setAdding(false); setMsg(`Recorded ${lease.code} ${lease.name}. Nothing is in the ledger until it commences.`); }
          }}
        />
      )}

      {skipped.length > 0 && (
        <Panel className="mb-4 p-3">
          <div className="sw-label">Skipped</div>
          <ul className="mt-1.5 space-y-0.5" data-testid="lease-skipped">
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
            <div className="sw-label">Register against the ledger</div>
            <table className="sw-table mt-3" style={{ maxWidth: "44rem" }}>
              <caption className="sr-only">The lease register against accounts 2600 and 1700</caption>
              <thead>
                <tr>
                  <th />
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Register</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Ledger</th>
                  <th style={{ width: "7rem" }} />
                </tr>
              </thead>
              <tbody>
                <Compare label="Lease liabilities" account="2600" a={data.totals.liabilityMinor} b={data.ledger.liabilityMinor} ok={data.ledger.liabilityAgrees} />
                <Compare label="Right-of-use assets" account="1700" a={data.totals.rouCarryingMinor} b={data.ledger.rouMinor} ok={data.ledger.rouAgrees} />
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" style={{ textAlign: "start" }}>Net position</th>
                  <td className="sw-num" data-testid="register-net">
                    <Figure minor={(BigInt(data.totals.rouCarryingMinor) - BigInt(data.totals.liabilityMinor)).toString()} zero="zero" />
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
            <p className="sw-sub mt-2 max-w-[70ch]">
              The two sides start equal and drift apart: the asset depreciates evenly while the liability unwinds
              and is paid down. Only leases that have commenced and were not exempted are compared — a draft has
              not been recognised, and an exempt lease never will be.
            </p>
            {(!data.ledger.liabilityAgrees || !data.ledger.rouAgrees) && (
              <p className="sw-sub mt-2" style={{ color: "var(--sw-neg)" }}>
                The register and the ledger disagree. That is a finding, not a display problem — a lease was
                probably commenced without its journal posting, or 2600 and 1700 were posted to by hand.
              </p>
            )}
          </Panel>

          {data.exemptions.length > 0 && (
            <Panel className="mb-4 p-4">
              <div className="sw-label">Off balance sheet</div>
              <table className="sw-table mt-3" style={{ maxWidth: "48rem" }}>
                <caption className="sr-only">Leases carried off balance sheet under the IFRS 16 recognition exemptions</caption>
                <thead>
                  <tr>
                    <th style={{ width: "7rem" }}>Code</th>
                    <th>Lease</th>
                    <th>Exemption</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Rent a year</th>
                  </tr>
                </thead>
                <tbody data-testid="lease-exemptions">
                  {data.exemptions.map((x) => (
                    <tr key={x.code}>
                      <td className="sw-code">{x.code}</td>
                      <td className="max-w-0 truncate">{x.name}</td>
                      <td className="sw-sub">{x.note}</td>
                      <td className="sw-num"><Figure minor={x.annualRentMinor} colour={false} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="sw-sub mt-2 max-w-[70ch]">
                These leases leave no trace in 2600 or 1700, so this is the only place they can be seen. IFRS 16.60
                asks for the expense to be disclosed for exactly that reason — an exemption nobody can see is an
                exemption nobody can audit.
              </p>
            </Panel>
          )}

          {data.leases.length === 0 ? (
            <Empty>No leases on the register yet.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Lease register</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "6rem" }}>Code</th>
                      <th>Lease</th>
                      <th className="hidden md:table-cell" style={{ width: "11rem" }}>Term</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Payment</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Liability</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Right-of-use</th>
                      <th style={{ width: "7rem" }}>Status</th>
                      <th style={{ width: "14rem" }} />
                    </tr>
                  </thead>
                  <tbody>
                    {data.leases.map((l) => (
                      <tr key={l.code}>
                        <td className="sw-code">{l.code}</td>
                        <td className="max-w-0 truncate">
                          {l.name}
                          {l.lessor && <span className="sw-sub"> · {l.lessor}</span>}
                        </td>
                        <td className="hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>
                          {l.startsOn} → {l.endsOn}
                          <span className="block text-[0.6875rem]">
                            {l.termMonths}m · {pct(l.annualRateBps)} a year
                          </span>
                        </td>
                        <td className="sw-num"><Figure minor={l.paymentMinor} colour={false} /></td>
                        <td className="sw-num">
                          {l.exempt ? <span className="sw-sub">off balance sheet</span> : <Figure minor={l.liabilityMinor} colour={false} />}
                        </td>
                        <td className="sw-num">
                          {l.exempt ? <span className="sw-sub">–</span> : <Figure minor={l.rouCarryingMinor} colour={false} />}
                          {!l.exempt && l.chargedTo && (
                            <span className="block text-[0.6875rem]" style={{ color: "var(--sw-fg-muted)" }}>to {l.chargedTo}</span>
                          )}
                        </td>
                        <td>
                          <StatusChip status={l.status} />
                          {l.exempt && <span className="sw-chip sw-chip-warn ml-1">exempt</span>}
                        </td>
                        <td>
                          <div className="flex flex-wrap items-center gap-1.5">
                            {l.status === "draft" ? (
                              <>
                                <select
                                  className="sw-select sw-select-sm"
                                  value={exemptChoice[l.code] ?? ""}
                                  onChange={(e) => setExemptChoice((x) => ({ ...x, [l.code]: e.target.value }))}
                                  aria-label={`Recognition exemption for ${l.code}`}
                                >
                                  <option value="">Capitalise</option>
                                  <option value="SHORT_TERM">Short term</option>
                                  <option value="LOW_VALUE">Low value</option>
                                </select>
                                <button
                                  type="button"
                                  className="sw-btn sw-btn-sm sw-btn-primary"
                                  onClick={() => commence(l.code)}
                                  aria-disabled={busy === `activate:${l.code}` || undefined}
                                  disabled={busy === `activate:${l.code}`}
                                  data-testid={`commence-${l.code}`}
                                >
                                  Commence
                                </button>
                              </>
                            ) : (
                              <>
                                {!l.exempt && l.status === "active" && (
                                  <button
                                    type="button"
                                    className="sw-btn sw-btn-sm"
                                    onClick={() => pay(l.code)}
                                    aria-disabled={busy === `pay:${l.code}` || undefined}
                                    disabled={busy === `pay:${l.code}`}
                                    title={`Record the ${period} payment against the liability`}
                                    data-testid={`pay-${l.code}`}
                                  >
                                    Pay {period}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="sw-btn sw-btn-sm"
                                  onClick={() => setOpenCode(openCode === l.code ? null : l.code)}
                                  data-testid={`schedule-${l.code}`}
                                >
                                  {openCode === l.code ? "Hide" : "Schedule"}
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
                Interest accrues over the month and the payment falls due at the end of it, so charge the month
                before recording its payment.{" "}
                <Link href="/accounting/accounts/2600" className="sw-link">Open lease liabilities</Link>.
              </p>
            </Panel>
          )}

          {openCode && <SchedulePanel entityId={entityId} leaseCode={openCode} />}
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

function SchedulePanel({ entityId, leaseCode }: { entityId: string; leaseCode: string }) {
  const { data, error, loading } = useLedgerQuery<Schedule>(
    `/api/ledger/leases?entityId=${entityId}&leaseCode=${encodeURIComponent(leaseCode)}`,
  );

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (loading || !data) return <Loading label={`Building the schedule for ${leaseCode}…`} />;

  return (
    <Panel className="mt-4 overflow-hidden">
      <div className="p-4 pb-0">
        <div className="sw-label">
          {data.leaseCode} — amortisation
          <span className="sw-sub">
            {" "}· {data.periods} months at {pct(data.periodRateBps)} a month ({pct(data.annualRateBps)} a year)
          </span>
        </div>
        {data.note && <p className="sw-sub mt-1 max-w-[70ch]" data-testid="schedule-note">{data.note}</p>}
      </div>

      {data.rows.length === 0 ? (
        <div className="p-4"><Empty>No amortisation table — nothing was recognised.</Empty></div>
      ) : (
        <>
          <div className="sw-scroll mt-3">
            <table className="sw-table">
              <caption className="sr-only">Lease amortisation table for {data.leaseCode}</caption>
              <thead>
                <tr>
                  <th style={{ width: "3rem" }}>#</th>
                  <th style={{ width: "6rem" }}>Month</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Opening</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Interest</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Payment</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Closing</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Depreciation</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Right-of-use</th>
                </tr>
              </thead>
              <tbody data-testid="schedule-rows">
                {data.rows.map((r) => (
                  <tr key={r.periodNo}>
                    <td className="sw-sub">{r.periodNo}</td>
                    <td>{r.period}</td>
                    <td className="sw-num"><Figure minor={r.openingLiabilityMinor} zero="zero" colour={false} /></td>
                    <td className="sw-num"><Figure minor={r.interestMinor} zero="zero" colour={false} /></td>
                    <td className="sw-num"><Figure minor={r.paymentMinor} colour={false} /></td>
                    <td className="sw-num"><Figure minor={r.closingLiabilityMinor} zero="zero" colour={false} /></td>
                    <td className="sw-num"><Figure minor={r.rouDepreciationMinor} zero="zero" colour={false} /></td>
                    <td className="sw-num"><Figure minor={r.closingRouMinor} zero="zero" colour={false} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3} style={{ textAlign: "start" }}>Over the term</th>
                  <td className="sw-num" data-testid="schedule-total-interest">
                    <Figure minor={data.totals.interestMinor} zero="zero" colour={false} />
                  </td>
                  <td className="sw-num"><Figure minor={data.totals.paymentsMinor} colour={false} /></td>
                  <td className="sw-num" data-testid="schedule-final-liability">
                    <Figure minor={data.rows[data.rows.length - 1].closingLiabilityMinor} zero="zero" colour={false} />
                  </td>
                  <td className="sw-num"><Figure minor={data.totals.depreciationMinor} zero="zero" colour={false} /></td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            The interest shrinks every month because the liability does; the depreciation does not move. Total cost
            is the two added together, which is heaviest in month one and lightest in the last. The closing
            liability is exactly nil — the last month absorbs whatever the discounting rounded away, because a fil
            of lease liability left on the balance sheet for ever is worse than a fil of interest in one month.
          </p>
        </>
      )}
    </Panel>
  );
}

function AddLease({ busy, onAdd }: {
  busy: boolean;
  onAdd: (l: {
    code: string; name: string; lessor?: string;
    startsOn: string; endsOn: string; paymentMinor: string; discountRateBps: number;
  }) => void;
}) {
  const [f, setF] = React.useState({
    code: "", name: "", lessor: "",
    startsOn: new Date().toISOString().slice(0, 10),
    endsOn: "", payment: "", rate: "6",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const payment = parseAmount(f.payment);
  const ratePct = Number(f.rate);
  const bps = Number.isFinite(ratePct) ? Math.round(ratePct * 100) : NaN;
  const months =
    f.endsOn && f.startsOn
      ? (Number(f.endsOn.slice(0, 4)) * 12 + Number(f.endsOn.slice(5, 7))) -
        (Number(f.startsOn.slice(0, 4)) * 12 + Number(f.startsOn.slice(5, 7))) + 1
      : 0;

  const blocker =
    !f.code.trim() ? "Give the lease a code." :
    !f.name.trim() ? "Give the lease a name." :
    !f.endsOn ? "When does the lease end?" :
    f.endsOn <= f.startsOn ? "A lease has to end after it starts." :
    payment === null || payment <= 0n ? "What is the payment each month?" :
    !Number.isInteger(bps) || bps < 0 || bps > 10000 ? "The borrowing rate is between 0% and 100%." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Add a lease</div>
      <p className="sw-sub mt-1 max-w-[70ch]">
        This records the contract only. Nothing reaches the ledger until the lease commences — that is when the
        present value is measured, the exemption is elected, and the right-of-use asset and liability go in.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Code"><input className="sw-input" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="LS-001" /></Field>
        <Field label="Name"><input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Warehouse, Al Quoz" /></Field>
        <Field label="Lessor"><input className="sw-input" value={f.lessor} onChange={(e) => set("lessor", e.target.value)} placeholder="Optional" /></Field>
        <Field label="Payment a month"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.payment} onChange={(e) => set("payment", e.target.value)} placeholder="5,000.00" /></Field>
        <Field label="Commences"><input type="date" className="sw-input" value={f.startsOn} onChange={(e) => set("startsOn", e.target.value)} /></Field>
        <Field label="Expires"><input type="date" className="sw-input" value={f.endsOn} onChange={(e) => set("endsOn", e.target.value)} /></Field>
        <Field label="Borrowing rate (% a year)"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.rate} onChange={(e) => set("rate", e.target.value)} placeholder="6" /></Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid="save-lease"
          onClick={() => onAdd({
            code: f.code.trim(), name: f.name.trim(),
            ...(f.lessor.trim() ? { lessor: f.lessor.trim() } : {}),
            startsOn: f.startsOn, endsOn: f.endsOn,
            paymentMinor: (payment as bigint).toString(), discountRateBps: bps,
          })}
        >
          {busy ? "Saving…" : "Add to register"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="lease-blocker">{blocker}</span>}
        {!blocker && payment !== null && months > 0 && (
          <span className="sw-sub">
            {months} months, {toInput(payment * BigInt(months))} in total before discounting.
            {months <= 12 && " Short enough for the short-term exemption, if you want it."}
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
