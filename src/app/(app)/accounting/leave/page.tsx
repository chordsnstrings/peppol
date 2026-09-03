"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";

/**
 * Annual leave and the untaken-leave provision.
 *
 * The page is a register and its reconciliation, because that is what the
 * subject is: the balances per employee, what they are worth at each person's
 * own wage, and the single figure on 2260 the total has to agree with. The
 * comparison is not tucked away at the bottom — a register nobody checks
 * against the ledger is a spreadsheet with extra steps.
 *
 * A negative leave balance is shown as a negative. Leave taken in advance is a
 * real state of affairs and it reads in parentheses like any other credit,
 * rather than being flattened to nil for the comfort of the column.
 */

interface Balance {
  code: string; name: string;
  joinedOn: string; leftOn: string | null; status: string;
  leaveDaysPerYear: number; asOf: string; serviceDays: number;
  earnedTenth: number; takenTenth: number; encashedTenth: number;
  unpaidTenth: number; otherTenth: number; balanceTenth: number;
  basicMinor: string; housingMinor: string; leavePayBaseMinor: string;
  dailyRateMinor: string; valueMinor: string;
  provisionMinor: string; provisionTenth: number;
}
interface RecordRow {
  id: string; code: string; name: string;
  kind: string; kindLabel: string;
  startsOn: string; endsOn: string;
  daysTenth: number; days: string; paid: boolean;
  consumesBalance: boolean; note: string | null;
}
interface Register {
  asOf: string;
  employees: Balance[];
  totals: {
    provisionTenth: number; provisionDays: string; provisionMinor: string;
    netTenth: number; netDays: string; netMinor: string;
    advanceTenth: number; advanceDays: string; advanceMinor: string;
  };
  lastProvision: { period: string; balanceMinor: string; chargeMinor: string; daysTenth: number; entryId: string | null } | null;
  ledger: { account: string; balanceMinor: string; differenceMinor: string; agrees: boolean };
  records: RecordRow[];
}

const KINDS: { value: string; label: string; note: string }[] = [
  { value: "ANNUAL", label: "Annual leave", note: "Comes off the balance. Calendar days, weekends and holidays included." },
  { value: "SICK", label: "Sick leave", note: "Article 31 makes this a separate entitlement. It does not reduce annual leave." },
  { value: "UNPAID", label: "Unpaid leave", note: "Earns no annual leave: the days come out of service before the entitlement is worked out." },
  { value: "MATERNITY", label: "Maternity leave", note: "Article 30. Separate, and not deducted from annual leave." },
  { value: "PARENTAL", label: "Parental leave", note: "Article 32. Separate, and not deducted from annual leave." },
  { value: "HAJJ", label: "Hajj leave", note: "A separate unpaid grant, once in the employment." },
  { value: "COMPASSIONATE", label: "Compassionate leave", note: "Article 33. Separate, and not deducted from annual leave." },
];

/** Tenths of a day, by string surgery. Negatives in parentheses, as figures are. */
function dayText(tenth: number): string {
  const neg = tenth < 0;
  const abs = neg ? -tenth : tenth;
  const body = `${Math.trunc(abs / 10)}.${abs % 10}`;
  return neg ? `(${body})` : body;
}

/** Days, coloured like a figure: negative is a real negative, never nil. */
function Days({ tenth, colour = true }: { tenth: number; colour?: boolean }) {
  const cls = tenth === 0 ? "sw-zero" : !colour ? "" : tenth < 0 ? "sw-num-neg" : "";
  return <span className={cls}>{tenth === 0 ? "–" : dayText(tenth)}</span>;
}

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

export default function LeavePage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(today);
  const [period, setPeriod] = React.useState(thisMonth);
  const { data, error, loading, reload } = useLedgerQuery<Register>(
    entityId ? `/api/ledger/leave?entityId=${entityId}&asOf=${asOf}` : null,
    [asOf],
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const act = async <T,>(label: string, body: Record<string, unknown>): Promise<T | null> => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<T>("/api/ledger/leave", {
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

  const runProvision = async () => {
    const r = await act<{ message: string }>("provision", { action: "provision", period });
    if (r) setMsg(r.message);
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const employees = data?.employees ?? [];
  const active = employees.filter((e) => e.status === "active");

  return (
    <>
      <PageHead
        title="Annual leave"
        sub="What every employee has earned under Article 29, what they have taken, and the liability for the rest. Untaken leave is provided for month by month at each person's own wage, because Article 29 pays it out at the wage in force when they leave."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Balances at</span>
              <input
                type="date"
                className="sw-input"
                style={{ width: "9.5rem" }}
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                aria-label="Draw the leave balances at this date"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Provide for</span>
              <input
                type="month"
                className="sw-input"
                style={{ width: "9rem" }}
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                aria-label="The month to provide for"
              />
            </label>
            <button
              type="button" className="sw-btn sw-btn-primary" onClick={runProvision}
              disabled={busy === "provision"} aria-disabled={busy === "provision" || undefined}
              data-testid="run-leave-provision"
            >
              {busy === "provision" ? "Providing…" : "Provide"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="leave-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {loading && !data && <Loading />}

      {data && (
        <>
          <Panel className="mb-4 p-4">
            <div className="sw-label">The register against {data.ledger.account}</div>
            <table className="sw-table mt-3" style={{ maxWidth: "50rem" }}>
              <caption className="sr-only">
                Untaken leave per the register against the balance on account {data.ledger.account}
              </caption>
              <thead>
                <tr>
                  <th />
                  <th className="sw-num" style={{ width: "6rem" }}>Days</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Value</th>
                  <th style={{ width: "9rem" }} />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                    Untaken leave at {data.asOf}, per the register
                  </th>
                  <td className="sw-num"><Days tenth={data.totals.provisionTenth} colour={false} /></td>
                  <td className="sw-num" data-testid="leave-register-total">
                    <Figure minor={data.totals.provisionMinor} zero="zero" colour={false} />
                  </td>
                  <td />
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                    Provided for on {data.ledger.account}
                  </th>
                  <td className="sw-num">
                    {data.lastProvision ? <Days tenth={data.lastProvision.daysTenth} colour={false} /> : <span className="sw-zero">–</span>}
                  </td>
                  <td className="sw-num" data-testid="leave-ledger-total">
                    <Figure minor={data.ledger.balanceMinor} zero="zero" colour={false} />
                  </td>
                  <td>
                    <Link href={`/accounting/accounts/${data.ledger.account}`} className="sw-link">
                      {data.ledger.account}
                    </Link>{" "}
                    <span className={`sw-chip ${data.ledger.agrees ? "sw-chip-ok" : "sw-chip-warn"}`}>
                      {data.ledger.agrees ? "agrees" : "differs"}
                    </span>
                  </td>
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>Difference</th>
                  <td />
                  <td className="sw-num" data-testid="leave-difference">
                    <Figure minor={data.ledger.differenceMinor} zero="zero" />
                  </td>
                  <td />
                </tr>
                {data.totals.advanceTenth !== 0 && (
                  <tr>
                    <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                      Taken in advance of being earned, not netted off
                    </th>
                    <td className="sw-num"><Days tenth={data.totals.advanceTenth} /></td>
                    <td className="sw-num"><Figure minor={data.totals.advanceMinor} zero="zero" /></td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
            <p className="sw-sub mt-2 max-w-[78ch]">
              {data.ledger.agrees
                ? `The register and ${data.ledger.account} agree at ${data.asOf}.`
                : `Leave goes on being earned every day and the ledger only moves when a month is provided for, so a difference between period ends is ordinary. At a period end that has been provided for, it should be nil.`}{" "}
              Days taken in advance are floored at nil per employee rather than netted against everyone else&rsquo;s
              balance: what one person owes the employer is a debt from that person, not a smaller liability to the rest.
              {data.lastProvision && (
                <> Last provided for {data.lastProvision.period}, charging{" "}
                  <Figure minor={data.lastProvision.chargeMinor} zero="zero" colour={false} /> to profit.</>
              )}
            </p>
          </Panel>

          <RecordLeave
            employees={active}
            busy={busy === "record" || busy === "encash"}
            onRecord={async (body) => {
              const r = await act<{ message: string }>("record", { action: "record", ...body });
              if (r) setMsg(r.message);
            }}
            onEncash={async (body) => {
              const r = await act<{ message: string }>("encash", { action: "encash", ...body });
              if (r) setMsg(r.message);
            }}
          />

          {employees.length === 0 ? (
            <Empty>Nobody is on the payroll for this entity yet. Add employees on the payroll page.</Empty>
          ) : (
            <Panel className="mb-4 overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Leave balances at {data.asOf}</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "6rem" }}>Code</th>
                      <th>Employee</th>
                      <th className="hidden lg:table-cell" style={{ width: "7rem" }}>Joined</th>
                      <th className="sw-num hidden md:table-cell" style={{ width: "5rem" }}>Per year</th>
                      <th className="sw-num" style={{ width: "5.5rem" }}>Earned</th>
                      <th className="sw-num" style={{ width: "5.5rem" }}>Taken</th>
                      <th className="sw-num hidden md:table-cell" style={{ width: "5.5rem" }}>Paid out</th>
                      <th className="sw-num hidden lg:table-cell" style={{ width: "5.5rem" }}>Unpaid</th>
                      <th className="sw-num" style={{ width: "5.5rem" }}>Balance</th>
                      <th className="sw-num hidden md:table-cell" style={{ width: "var(--sw-col-amount)" }}>Day rate</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Value</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Provision</th>
                      <th style={{ width: "5.5rem" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((e) => (
                      <tr key={e.code}>
                        <td className="sw-code">{e.code}</td>
                        <td className="max-w-0 truncate">{e.name}</td>
                        <td className="hidden lg:table-cell">{e.joinedOn}</td>
                        <td className="sw-num hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>
                          {e.leaveDaysPerYear}
                        </td>
                        <td className="sw-num"><Days tenth={e.earnedTenth} colour={false} /></td>
                        <td className="sw-num"><Days tenth={e.takenTenth} colour={false} /></td>
                        <td className="sw-num hidden md:table-cell"><Days tenth={e.encashedTenth} colour={false} /></td>
                        <td className="sw-num hidden lg:table-cell"><Days tenth={e.unpaidTenth} colour={false} /></td>
                        <td className="sw-num" data-testid={`leave-balance-${e.code}`}><Days tenth={e.balanceTenth} /></td>
                        <td className="sw-num hidden md:table-cell"><Figure minor={e.dailyRateMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={e.valueMinor} /></td>
                        <td className="sw-num">
                          {e.status === "active"
                            ? <Figure minor={e.provisionMinor} zero="zero" colour={false} />
                            : <span className="sw-zero">–</span>}
                        </td>
                        <td><StatusChip status={e.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={8} style={{ textAlign: "start" }}>
                        At {data.asOf}, {active.length} employed
                      </th>
                      <td className="sw-num"><Days tenth={data.totals.netTenth} /></td>
                      <td className="hidden md:table-cell" />
                      <td className="sw-num"><Figure minor={data.totals.netMinor} zero="zero" /></td>
                      <td className="sw-num" data-testid="leave-provision-total">
                        <Figure minor={data.totals.provisionMinor} zero="zero" colour={false} />
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
                Earned is Article 29: thirty calendar days a year once a year of service is complete, two working
                days a month between six months and a year, and nothing at all below six. A day is valued at basic
                plus housing over thirty; transport and other allowances reimburse a cost that is not incurred while
                on leave and stay out, as they stay out of the{" "}
                <Link href="/accounting/payroll" className="sw-link">gratuity</Link>.
              </p>
            </Panel>
          )}

          <Panel className="overflow-hidden">
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">Leave records</caption>
                <thead>
                  <tr>
                    <th style={{ width: "6rem" }}>Code</th>
                    <th style={{ width: "12rem" }}>Employee</th>
                    <th>Kind</th>
                    <th style={{ width: "7rem" }}>From</th>
                    <th style={{ width: "7rem" }}>To</th>
                    <th className="sw-num" style={{ width: "5.5rem" }}>Days</th>
                    <th className="hidden md:table-cell" style={{ width: "9rem" }}>Balance</th>
                    <th className="hidden lg:table-cell">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {data.records.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="sw-sub">No leave has been recorded for this entity yet.</td>
                    </tr>
                  ) : (
                    data.records.map((r) => (
                      <tr key={r.id}>
                        <td className="sw-code">{r.code}</td>
                        <td className="max-w-0 truncate">{r.name}</td>
                        <td>
                          {r.kindLabel}
                          {!r.paid && <span className="sw-chip ml-1.5">unpaid</span>}
                        </td>
                        <td>{r.startsOn}</td>
                        <td>{r.endsOn}</td>
                        <td className="sw-num"><Days tenth={r.daysTenth} colour={false} /></td>
                        <td className="hidden md:table-cell" style={{ color: "var(--sw-fg-muted)" }}>
                          {r.consumesBalance ? "comes off it" : r.kind === "UNPAID" ? "shortens service" : "separate"}
                        </td>
                        <td className="hidden lg:table-cell max-w-0 truncate" style={{ color: "var(--sw-fg-muted)" }}>
                          {r.note ?? ""}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </>
  );
}

function RecordLeave({ employees, busy, onRecord, onEncash }: {
  employees: Balance[];
  busy: boolean;
  onRecord: (b: { code: string; kind: string; startsOn: string; endsOn: string; daysTenth?: number; note?: string }) => void;
  onEncash: (b: { code: string; daysTenth: number; on: string; note?: string }) => void;
}) {
  const [f, setF] = React.useState({
    code: "", kind: "ANNUAL", startsOn: today(), endsOn: today(), days: "", note: "",
  });
  const [e, setE] = React.useState({ code: "", days: "", on: today(), note: "" });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const setEnc = (k: keyof typeof e, v: string) => setE((x) => ({ ...x, [k]: v }));

  const kind = KINDS.find((k) => k.value === f.kind) ?? KINDS[0];

  /** Days typed as a decimal become tenths without ever being a float. */
  const tenths = (text: string): number | null => {
    const s = text.trim();
    if (s === "") return null;
    const m = /^(\d+)(?:\.(\d))?$/.exec(s);
    if (!m) return NaN;
    return Number(m[1]) * 10 + Number(m[2] ?? 0);
  };

  const span = (() => {
    const from = Date.parse(`${f.startsOn}T00:00:00.000Z`);
    const to = Date.parse(`${f.endsOn}T00:00:00.000Z`);
    if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
    return Math.round((to - from) / 86_400_000) + 1;
  })();

  const typed = tenths(f.days);
  const recordBlocker =
    !f.code ? "Choose an employee." :
    span === null ? "Leave cannot end before it starts." :
    typed !== null && (Number.isNaN(typed) || typed <= 0) ? "Days are written as 5 or 4.5." :
    typed !== null && typed > span * 10 ? `${f.days} days will not fit in ${span} day${span === 1 ? "" : "s"}.` :
    null;

  const encashTyped = tenths(e.days);
  const balance = employees.find((x) => x.code === e.code);
  const encashBlocker =
    !e.code ? "Choose an employee." :
    encashTyped === null || Number.isNaN(encashTyped) || encashTyped <= 0 ? "Days are written as 5 or 4.5." :
    balance && encashTyped > balance.balanceTenth
      ? `${balance.name} has ${dayText(balance.balanceTenth)} days; leave that has not been earned cannot be paid out.`
      : null;

  return (
    <div className="mb-4 grid gap-4 lg:grid-cols-2">
      <Panel className="p-4">
        <div className="sw-label">Record leave</div>
        <p className="sw-sub mt-1 max-w-[62ch]">{kind.note}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Employee">
            <select className="sw-select" value={f.code} onChange={(x) => set("code", x.target.value)} data-testid="leave-employee">
              <option value="">Choose…</option>
              {employees.map((x) => (
                <option key={x.code} value={x.code}>{x.code} — {x.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Kind">
            <select className="sw-select" value={f.kind} onChange={(x) => set("kind", x.target.value)} data-testid="leave-kind">
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </Field>
          <Field label="First day">
            <input type="date" className="sw-input" value={f.startsOn} onChange={(x) => set("startsOn", x.target.value)} />
          </Field>
          <Field label="Last day">
            <input type="date" className="sw-input" value={f.endsOn} onChange={(x) => set("endsOn", x.target.value)} />
          </Field>
          <Field label={`Days${span === null ? "" : ` — ${span} calendar by default`}`}>
            <input
              className="sw-input sw-cell-num" inputMode="decimal" value={f.days}
              onChange={(x) => set("days", x.target.value)}
              placeholder={span === null ? "5" : String(span)}
              aria-describedby="leave-days-help"
            />
          </Field>
          <Field label="Note">
            <input className="sw-input" value={f.note} onChange={(x) => set("note", x.target.value)} placeholder="Optional" />
          </Field>
        </div>
        <p className="sw-sub mt-2 max-w-[62ch]" id="leave-days-help">
          Left empty, the calendar days from the first to the last inclusive are counted. Article 29 grants calendar
          days, so a weekend inside a period of leave is part of it. Type a number to record halves or working days.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button" className="sw-btn sw-btn-primary"
            disabled={recordBlocker !== null || busy}
            aria-disabled={recordBlocker !== null || busy || undefined}
            data-testid="save-leave"
            onClick={() => onRecord({
              code: f.code, kind: f.kind, startsOn: f.startsOn, endsOn: f.endsOn,
              ...(typed !== null && !Number.isNaN(typed) ? { daysTenth: typed } : {}),
              ...(f.note.trim() ? { note: f.note.trim() } : {}),
            })}
          >
            {busy ? "Saving…" : "Record"}
          </button>
          {recordBlocker && <span className="sw-sub" role="status" data-testid="leave-blocker">{recordBlocker}</span>}
        </div>
      </Panel>

      <Panel className="p-4">
        <div className="sw-label">Pay untaken leave out</div>
        <p className="sw-sub mt-1 max-w-[62ch]">
          Days bought back at basic plus housing over thirty. It debits 2260 and credits the bank: the cost was
          charged to profit when the days were earned, so paying them out settles the provision rather than
          incurring the cost again.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Employee">
            <select className="sw-select" value={e.code} onChange={(x) => setEnc("code", x.target.value)} data-testid="encash-employee">
              <option value="">Choose…</option>
              {employees.map((x) => (
                <option key={x.code} value={x.code}>{x.code} — {x.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input type="date" className="sw-input" value={e.on} onChange={(x) => setEnc("on", x.target.value)} />
          </Field>
          <Field label={balance ? `Days — ${dayText(balance.balanceTenth)} available` : "Days"}>
            <input
              className="sw-input sw-cell-num" inputMode="decimal" value={e.days}
              onChange={(x) => setEnc("days", x.target.value)} placeholder="5"
            />
          </Field>
          <Field label="Note">
            <input className="sw-input" value={e.note} onChange={(x) => setEnc("note", x.target.value)} placeholder="Optional" />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button" className="sw-btn"
            disabled={encashBlocker !== null || busy}
            aria-disabled={encashBlocker !== null || busy || undefined}
            data-testid="encash-leave"
            onClick={() => onEncash({
              code: e.code, daysTenth: encashTyped as number, on: e.on,
              ...(e.note.trim() ? { note: e.note.trim() } : {}),
            })}
          >
            {busy ? "Paying…" : "Pay out"}
          </button>
          {encashBlocker && <span className="sw-sub" role="status" data-testid="encash-blocker">{encashBlocker}</span>}
        </div>
      </Panel>
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
