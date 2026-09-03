"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { parseAmount } from "@/lib/ledger/format";

interface Recent { scheduledOn: string; number: string; totalMinor: string; invoiceId: string }
interface Row {
  code: string; customerName: string; frequency: string; status: string;
  startsOn: string; endsOn: string | null; nextOn: string; overdue: boolean;
  perInvoiceMinor: string; issuedCount: number; billedMinor: string; recent: Recent[];
}
interface Register {
  asOf: string;
  subscriptions: Row[];
  summary: { activeCount: number; overdueCount: number; annualisedMinor: string };
}

const today = () => new Date().toISOString().slice(0, 10);

const FREQUENCY: Record<string, string> = {
  WEEKLY: "every week", MONTHLY: "every month", QUARTERLY: "every quarter", ANNUAL: "every year",
};

export default function SubscriptionsPage() {
  const entityId = useEntityId();
  const [asOf, setAsOf] = React.useState(today);
  const { data, error, loading, reload } = useLedgerQuery<Register>(
    entityId ? `/api/ledger/subscriptions?entityId=${entityId}&asOf=${asOf}` : null,
    [asOf],
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/subscriptions", {
        method: "POST", body: JSON.stringify({ entityId, asOf, ...body }),
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

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Subscriptions"
        sub={
          "An invoice that recurs on its own schedule. A template is not an invoice — it is the instruction for " +
          "making one, and each invoice it raises is a separate document with its own number and its own life. " +
          "One invoice per scheduled period is held by the database rather than by a check, so a run that was " +
          "interrupted can simply be run again."
        }
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">As at</span>
              <input type="date" className="sw-input" style={{ width: "10rem" }} value={asOf}
                onChange={(e) => setAsOf(e.target.value)} aria-label="Date to raise up to" />
            </label>
            <button type="button" className="sw-btn sw-btn-primary" data-testid="issue-all"
              disabled={busy === "issueAll"}
              onClick={async () => {
                const r = await act("issueAll", { action: "issueAll" });
                if (!r) return;
                const n = Number(r.invoicesRaised);
                setMsg(n === 0 ? `Nothing was due as at ${asOf}.` : `Raised ${n} invoice${n === 1 ? "" : "s"} as at ${asOf}.`);
              }}>
              {busy === "issueAll" ? "Raising…" : "Raise what is due"}
            </button>
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)} data-testid="toggle-add-subscription">
              {adding ? "Cancel" : "New subscription"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="subscription-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <NewSubscription
          busy={busy === "create"}
          onCreate={async (subscription) => {
            const r = await act("create", { action: "create", subscription });
            if (r) { setAdding(false); setMsg(`Recorded ${subscription.code}. Nothing is raised until the run.`); }
          }}
        />
      )}

      {loading && !data && <Loading />}

      {data && (
        <>
          <Panel className="mb-4 p-4">
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="sw-label">Active</dt>
                <dd className="sw-num mt-1 text-lg">{data.summary.activeCount}</dd>
              </div>
              <div>
                <dt className="sw-label">Due to be raised</dt>
                <dd className="sw-num mt-1 text-lg" data-testid="subscriptions-overdue">{data.summary.overdueCount}</dd>
              </div>
              <div>
                <dt className="sw-label">Billed in a year at today&rsquo;s prices</dt>
                <dd className="sw-num mt-1 text-lg"><Figure minor={data.summary.annualisedMinor} colour={false} /></dd>
                <p className="sw-sub mt-0.5">
                  What the book is worth over a year. No statement carries it — the statements say what was billed,
                  not what will be.
                </p>
              </div>
            </dl>
          </Panel>

          {data.subscriptions.length === 0 ? (
            <Empty>No subscriptions yet.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Subscriptions and what each has raised</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "8rem" }}>Code</th>
                      <th>Customer</th>
                      <th style={{ width: "8rem" }}>Recurs</th>
                      <th style={{ width: "7rem" }}>Next due</th>
                      <th style={{ width: "6rem" }}>Status</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Each</th>
                      <th className="sw-num" style={{ width: "5rem" }}>Raised</th>
                      <th style={{ width: "10rem" }} />
                    </tr>
                  </thead>
                  <tbody data-testid="subscription-rows">
                    {data.subscriptions.map((s) => (
                      <React.Fragment key={s.code}>
                        <tr>
                          <td className="sw-code">{s.code}</td>
                          <td className="max-w-0 truncate">{s.customerName}</td>
                          <td className="sw-sub">{FREQUENCY[s.frequency] ?? s.frequency}</td>
                          <td>
                            {s.nextOn}
                            {s.overdue && <span className="sw-chip sw-chip-bad ml-1.5">due</span>}
                          </td>
                          <td><StatusChip status={s.status} /></td>
                          <td className="sw-num"><Figure minor={s.perInvoiceMinor} colour={false} /></td>
                          <td className="sw-num">{s.issuedCount}</td>
                          <td>
                            {s.status === "active" && (
                              <>
                                <button type="button" className="sw-link-btn" disabled={busy === `issue:${s.code}`}
                                  onClick={async () => {
                                    const r = await act(`issue:${s.code}`, { action: "issue", code: s.code });
                                    if (!r) return;
                                    const n = (r.raised as unknown[]).length;
                                    setMsg(n === 0
                                      ? `${s.code} has nothing due as at ${asOf}.`
                                      : `${s.code}: raised ${n} invoice${n === 1 ? "" : "s"}, next due ${r.nextOn}.`);
                                  }}>
                                  raise
                                </button>
                                {" "}
                                <button type="button" className="sw-link-btn" disabled={busy === `pause:${s.code}`}
                                  onClick={async () => {
                                    const r = await act(`pause:${s.code}`, { action: "pause", code: s.code });
                                    if (r) setMsg(`${s.code} is paused. The periods it misses will not be caught up.`);
                                  }}>
                                  pause
                                </button>
                              </>
                            )}
                            {s.status === "paused" && (
                              <button type="button" className="sw-link-btn" disabled={busy === `resume:${s.code}`}
                                onClick={async () => {
                                  const r = await act(`resume:${s.code}`, { action: "resume", code: s.code });
                                  if (r) setMsg(String(r.note));
                                }}>
                                resume
                              </button>
                            )}
                            {s.recent.length > 0 && (
                              <>
                                {" "}
                                <button type="button" className="sw-link-btn" aria-expanded={open === s.code}
                                  onClick={() => setOpen(open === s.code ? null : s.code)}>
                                  {open === s.code ? "hide" : "history"}
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                        {open === s.code && (
                          <tr>
                            <td colSpan={8} style={{ background: "var(--sw-ground)" }}>
                              <table className="sw-table" style={{ maxWidth: "44rem", margin: "0.5rem" }}>
                                <caption className="sr-only">What {s.code} has raised</caption>
                                <thead>
                                  <tr>
                                    <th style={{ width: "8rem" }}>For</th>
                                    <th>Invoice</th>
                                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {s.recent.map((r) => (
                                    <tr key={r.scheduledOn}>
                                      <td>{r.scheduledOn}</td>
                                      <td>
                                        <Link href={`/invoices/${encodeURIComponent(r.invoiceId)}`} className="sw-link-btn">
                                          {r.number}
                                        </Link>
                                      </td>
                                      <td className="sw-num"><Figure minor={r.totalMinor} colour={false} /></td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <p className="sw-sub mt-3 max-w-[75ch]">
            Pausing does not defer the periods it covers — a pause is a decision not to charge, and catching up on
            resuming would send one customer several invoices on one day. Whether an invoice raised in advance is
            revenue of the day it was raised is a separate question, and it is answered on the revenue recognition
            screen rather than assumed here.
          </p>
        </>
      )}
    </>
  );
}

interface DraftLine { description: string; quantity: string; price: string; taxCode: string }

function NewSubscription({ busy, onCreate }: {
  busy: boolean;
  onCreate: (s: {
    code: string; customerName: string; customerTrn?: string; frequency: string;
    startsOn: string; endsOn?: string; paymentTerms: number;
    lines: { description: string; quantityMilli: string; unitPriceMinor: string; taxCode: string }[];
  }) => void;
}) {
  const [code, setCode] = React.useState("");
  const [customer, setCustomer] = React.useState("");
  const [trn, setTrn] = React.useState("");
  const [frequency, setFrequency] = React.useState("MONTHLY");
  const [startsOn, setStartsOn] = React.useState(today);
  const [endsOn, setEndsOn] = React.useState("");
  const [terms, setTerms] = React.useState("30");
  const [rows, setRows] = React.useState<DraftLine[]>([{ description: "", quantity: "1", price: "", taxCode: "STANDARD_5" }]);
  const [err, setErr] = React.useState<string | null>(null);

  const set = (i: number, patch: Partial<DraftLine>) =>
    setRows((rs) => rs.map((r, j) => (i === j ? { ...r, ...patch } : r)));

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">A new subscription</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="sw-label">Code</span>
          <input className="sw-input mt-1" value={code} onChange={(e) => setCode(e.target.value)} placeholder="SUB-1" />
        </label>
        <label className="block">
          <span className="sw-label">Customer</span>
          <input className="sw-input mt-1" value={customer} onChange={(e) => setCustomer(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Customer TRN</span>
          <input className="sw-input mt-1" value={trn} onChange={(e) => setTrn(e.target.value)} placeholder="optional" />
        </label>
        <label className="block">
          <span className="sw-label">Recurs</span>
          <select className="sw-select mt-1" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            <option value="WEEKLY">every week</option>
            <option value="MONTHLY">every month</option>
            <option value="QUARTERLY">every quarter</option>
            <option value="ANNUAL">every year</option>
          </select>
        </label>
        <label className="block">
          <span className="sw-label">Starts</span>
          <input type="date" className="sw-input mt-1" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Ends</span>
          <input type="date" className="sw-input mt-1" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Payment terms, days</span>
          <input className="sw-input sw-num mt-1" value={terms} onChange={(e) => setTerms(e.target.value)} />
        </label>
      </div>

      <div className="sw-label mt-4">What it bills</div>
      <table className="sw-table mt-2" style={{ maxWidth: "54rem" }}>
        <caption className="sr-only">The lines each invoice will carry</caption>
        <thead>
          <tr>
            <th style={{ width: "3rem" }}>#</th>
            <th>Description</th>
            <th className="sw-num" style={{ width: "7rem" }}>Quantity</th>
            <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit price</th>
            <th style={{ width: "11rem" }}>Tax</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="sw-num">{i + 1}</td>
              <td>
                <input className="sw-input" style={{ width: "100%" }} value={r.description}
                  onChange={(e) => set(i, { description: e.target.value })}
                  aria-label={`Line ${i + 1} description`} />
              </td>
              <td>
                <input className="sw-input sw-num" style={{ width: "100%" }} value={r.quantity}
                  onChange={(e) => set(i, { quantity: e.target.value })}
                  aria-label={`Line ${i + 1} quantity`} />
              </td>
              <td>
                <input className="sw-input sw-num" style={{ width: "100%" }} value={r.price} placeholder="0.00"
                  onChange={(e) => set(i, { price: e.target.value })}
                  aria-label={`Line ${i + 1} unit price`} />
              </td>
              <td>
                <select className="sw-select" value={r.taxCode} onChange={(e) => set(i, { taxCode: e.target.value })}
                  aria-label={`Line ${i + 1} tax treatment`}>
                  <option value="STANDARD_5">Standard, 5%</option>
                  <option value="ZERO_EXPORT">Zero rated — export</option>
                  <option value="ZERO_OTHER">Zero rated — other</option>
                  <option value="EXEMPT">Exempt</option>
                  <option value="REVERSE_CHARGE">Reverse charge</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button type="button" className="sw-btn sw-btn-sm mt-2"
        onClick={() => setRows((rs) => [...rs, { description: "", quantity: "1", price: "", taxCode: "STANDARD_5" }])}>
        Add a line
      </button>

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <div className="mt-3">
        <button type="button" className="sw-btn sw-btn-primary" disabled={busy} data-testid="save-subscription"
          onClick={() => {
            if (!code.trim() || !customer.trim()) { setErr("A subscription needs a code and the customer it bills."); return; }
            const lines = rows
              .filter((r) => r.description.trim() && r.price.trim())
              .map((r) => {
                const qty = Number(r.quantity);
                const price = parseAmount(r.price, "AED");
                return { r, qty, price };
              });
            if (!lines.length) { setErr("A subscription needs at least one line, with a price."); return; }
            if (lines.some((l) => !Number.isFinite(l.qty) || l.qty <= 0)) { setErr("Every quantity has to be a number above nil."); return; }
            if (lines.some((l) => l.price === null || l.price < 0n)) { setErr("Every price has to be an amount I can read."); return; }
            setErr(null);
            onCreate({
              code: code.trim(), customerName: customer.trim(),
              customerTrn: trn.trim() || undefined,
              frequency, startsOn, endsOn: endsOn || undefined,
              paymentTerms: Number(terms) || 0,
              lines: lines.map(({ r, qty, price }) => ({
                description: r.description.trim(),
                quantityMilli: String(Math.round(qty * 1000)),
                unitPriceMinor: (price as bigint).toString(),
                taxCode: r.taxCode,
              })),
            });
          }}>
          {busy ? "Saving…" : "Record the subscription"}
        </button>
      </div>
    </Panel>
  );
}
