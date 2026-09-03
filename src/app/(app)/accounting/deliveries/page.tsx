"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";

interface NoteLine {
  lineNo: number; sku: string | null; description: string;
  quantityMilli: string; costMinor: string | null;
}
interface Note {
  number: string; orderNumber: string | null; customerName: string;
  deliveredOn: string; status: string; carrier: string | null; trackingRef: string | null;
  signedBy: string | null; signedOn: string | null;
  lineCount: number; quantityMilli: string; costMinor: string;
  lines: NoteLine[];
}
interface Register {
  from: string; to: string;
  notes: Note[];
  summary: {
    total: number; draft: number; dispatched: number; delivered: number;
    unsigned: string[];
  };
}
interface UnbilledRow {
  number: string; deliveredOn: string; customerName: string; orderNumber: string;
  sku: string | null; description: string;
  quantityMilli: string; uninvoicedMilli: string;
  costMinor: string | null; valueMinor: string;
}
interface Unbilled {
  asOf: string;
  rows: UnbilledRow[];
  totals: { lines: number; valueMinor: string; costMinor: string; marginMinor: string };
  note: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const monthsBack = (n: number) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
};

/** Thousandths as a number somebody would write. */
function qty(milli: string): string {
  const neg = milli.startsWith("-");
  const s = (neg ? milli.slice(1) : milli).padStart(4, "0");
  const body = `${s.slice(0, -3)}.${s.slice(-3)}`.replace(/\.?0+$/, "");
  return `${neg ? "-" : ""}${body || "0"}`;
}

export default function DeliveriesPage() {
  const entityId = useEntityId();
  const [from, setFrom] = React.useState(() => monthsBack(3));
  const [to, setTo] = React.useState(today);
  const [status, setStatus] = React.useState("");
  const [tab, setTab] = React.useState<"register" | "unbilled">("register");
  const [open, setOpen] = React.useState<string | null>(null);

  const q = new URLSearchParams({ entityId: entityId ?? "", from, to });
  if (status) q.set("status", status);
  const { data, error, loading, reload } = useLedgerQuery<Register>(
    entityId ? `/api/ledger/deliveries?${q.toString()}` : null,
    [from, to, status],
  );

  const unbilled = useLedgerQuery<Unbilled>(
    entityId && tab === "unbilled" ? `/api/ledger/deliveries?entityId=${entityId}&view=unbilled&asOf=${to}` : null,
    [tab, to],
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/deliveries", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      reload();
      if (tab === "unbilled") unbilled.reload();
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
        title="Delivery notes"
        sub={
          "Between an order and an invoice there is a lorry. Dispatching moves cost out of inventory and nothing " +
          "else — the revenue stays on the invoice, because conflating the two is what produces a ledger where the " +
          "stock is gone and nobody was ever billed. Goods delivered and not yet invoiced are the report this " +
          "screen exists for."
        }
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">From</span>
              <input type="date" className="sw-input" style={{ width: "10rem" }} value={from}
                onChange={(e) => setFrom(e.target.value)} aria-label="Deliveries from" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">To</span>
              <input type="date" className="sw-input" style={{ width: "10rem" }} value={to}
                onChange={(e) => setTo(e.target.value)} aria-label="Deliveries to" />
            </label>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="delivery-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      <nav className="sw-tabs mb-4" aria-label="What to show">
        <button type="button" className="sw-tab" aria-current={tab === "register" ? "page" : undefined}
          onClick={() => setTab("register")}>Register</button>
        <button type="button" className="sw-tab" aria-current={tab === "unbilled" ? "page" : undefined}
          onClick={() => setTab("unbilled")}>Delivered, not invoiced</button>
      </nav>

      {tab === "register" && (
        <>
          {loading && !data && <Loading />}
          {data && (
            <>
              <Panel className="mb-4 p-4">
                <dl className="grid gap-4 sm:grid-cols-4">
                  <div>
                    <dt className="sw-label">Notes</dt>
                    <dd className="sw-num mt-1 text-lg">{data.summary.total}</dd>
                  </div>
                  <div>
                    <dt className="sw-label">Still drafts</dt>
                    <dd className="sw-num mt-1 text-lg">{data.summary.draft}</dd>
                    <p className="sw-sub mt-0.5">Nothing has left under these, and they still hold the stock.</p>
                  </div>
                  <div>
                    <dt className="sw-label">Gone, unsigned</dt>
                    <dd className="sw-num mt-1 text-lg" data-testid="unsigned-count">{data.summary.dispatched}</dd>
                    <p className="sw-sub mt-0.5">
                      Not a finding — plenty of deliveries are never signed for. It is the list somebody reaches for
                      the day a customer says the goods never arrived.
                    </p>
                  </div>
                  <div>
                    <dt className="sw-label">Signed for</dt>
                    <dd className="sw-num mt-1 text-lg">{data.summary.delivered}</dd>
                  </div>
                </dl>
              </Panel>

              <div className="mb-3">
                <label className="flex items-center gap-1.5">
                  <span className="sw-label">Showing</span>
                  <select className="sw-select" style={{ width: "12rem" }} value={status}
                    onChange={(e) => setStatus(e.target.value)} aria-label="Which notes to show">
                    <option value="">everything</option>
                    <option value="draft">drafts</option>
                    <option value="dispatched">dispatched</option>
                    <option value="delivered">signed for</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                </label>
              </div>

              {data.notes.length === 0 ? (
                <Empty>No delivery note between {data.from} and {data.to}.</Empty>
              ) : (
                <Panel className="overflow-hidden">
                  <div className="sw-scroll">
                    <table className="sw-table">
                      <caption className="sr-only">Delivery notes and what left under each</caption>
                      <thead>
                        <tr>
                          <th style={{ width: "8rem" }}>Note</th>
                          <th style={{ width: "7rem" }}>Delivered</th>
                          <th>Customer</th>
                          <th style={{ width: "7rem" }}>Order</th>
                          <th style={{ width: "8rem" }}>Carrier</th>
                          <th className="sw-num" style={{ width: "6rem" }}>Quantity</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost out</th>
                          <th style={{ width: "7rem" }}>Status</th>
                          <th style={{ width: "12rem" }} />
                        </tr>
                      </thead>
                      <tbody data-testid="delivery-rows">
                        {data.notes.map((n) => (
                          <React.Fragment key={n.number}>
                            <tr>
                              <td className="sw-code">{n.number}</td>
                              <td>{n.deliveredOn}</td>
                              <td className="max-w-0 truncate">
                                {n.customerName}
                                {n.signedBy && <span className="sw-sub"> — signed {n.signedBy}</span>}
                              </td>
                              <td className="sw-code">{n.orderNumber ?? "—"}</td>
                              <td className="sw-sub">{n.carrier ?? "—"}</td>
                              <td className="sw-num">{qty(n.quantityMilli)}</td>
                              <td className="sw-num">
                                {n.status === "draft"
                                  ? <span className="sw-sub">not yet</span>
                                  : <Figure minor={n.costMinor} colour={false} />}
                              </td>
                              <td><StatusChip status={n.status} /></td>
                              <td>
                                {n.status === "draft" && (
                                  <>
                                    <button type="button" className="sw-link-btn" disabled={busy === `dispatch:${n.number}`}
                                      onClick={async () => {
                                        const r = await act(`dispatch:${n.number}`, { action: "dispatch", number: n.number });
                                        if (r) setMsg(String(r.note));
                                      }}>
                                      dispatch
                                    </button>
                                    {" "}
                                    <button type="button" className="sw-link-btn" disabled={busy === `cancel:${n.number}`}
                                      onClick={async () => {
                                        const reason = window.prompt("Why is this note being cancelled?");
                                        if (reason === null) return;
                                        const r = await act(`cancel:${n.number}`, { action: "cancel", number: n.number, reason });
                                        if (r) setMsg(`${n.number} is cancelled. The order has that quantity back.`);
                                      }}>
                                      cancel
                                    </button>
                                  </>
                                )}
                                {n.status === "dispatched" && (
                                  <button type="button" className="sw-link-btn" disabled={busy === `confirm:${n.number}`}
                                    onClick={async () => {
                                      const who = window.prompt("Who signed for it?");
                                      if (!who) return;
                                      const r = await act(`confirm:${n.number}`, { action: "confirm", number: n.number, signedBy: who });
                                      if (r) setMsg(`${n.number} is signed for by ${who}. Nothing moved — a signature is evidence.`);
                                    }}>
                                    signed for
                                  </button>
                                )}
                                {(n.status === "dispatched" || n.status === "delivered") && (
                                  <>
                                    {" "}
                                    <button type="button" className="sw-link-btn" disabled={busy === `return:${n.number}`}
                                      onClick={async () => {
                                        const r = await act(`return:${n.number}`, { action: "return", number: n.number });
                                        if (r) setMsg(String(r.note));
                                      }}>
                                      return all
                                    </button>
                                  </>
                                )}
                                {" "}
                                <button type="button" className="sw-link-btn" aria-expanded={open === n.number}
                                  onClick={() => setOpen(open === n.number ? null : n.number)}>
                                  {open === n.number ? "hide" : "lines"}
                                </button>
                              </td>
                            </tr>
                            {open === n.number && (
                              <tr>
                                <td colSpan={9} style={{ background: "var(--sw-ground)" }}>
                                  <table className="sw-table" style={{ maxWidth: "48rem", margin: "0.5rem" }}>
                                    <caption className="sr-only">What went out under {n.number}</caption>
                                    <thead>
                                      <tr>
                                        <th style={{ width: "3rem" }}>#</th>
                                        <th style={{ width: "8rem" }}>SKU</th>
                                        <th>Description</th>
                                        <th className="sw-num" style={{ width: "6rem" }}>Quantity</th>
                                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {n.lines.map((l) => (
                                        <tr key={l.lineNo}>
                                          <td className="sw-num">{l.lineNo}</td>
                                          <td className="sw-code">{l.sku ?? "—"}</td>
                                          <td>{l.description}</td>
                                          <td className="sw-num">{qty(l.quantityMilli)}</td>
                                          <td className="sw-num">
                                            {l.costMinor === null
                                              ? <span className="sw-sub">no stock</span>
                                              : <Figure minor={l.costMinor} colour={false} />}
                                          </td>
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
                A dispatched note cannot be cancelled: the goods have physically left, and cancelling the paper would
                not bring them back. Returning them puts the stock back at the cost it left at rather than at
                today&rsquo;s average — receiving a return at today&rsquo;s cost would move the margin of a sale that
                has not been made, in whichever direction the last purchase happened to go.
              </p>
            </>
          )}
        </>
      )}

      {tab === "unbilled" && (
        <>
          {unbilled.error && <ErrorNote>{unbilled.error}</ErrorNote>}
          {unbilled.loading && !unbilled.data && <Loading />}
          {unbilled.data && (
            <>
              <Panel className="mb-4 p-4">
                <dl className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <dt className="sw-label">At the order price</dt>
                    <dd className="sw-num mt-1 text-lg" data-testid="unbilled-value">
                      <Figure minor={unbilled.data.totals.valueMinor} colour={false} />
                    </dd>
                  </div>
                  <div>
                    <dt className="sw-label">Cost already out of stock</dt>
                    <dd className="sw-num mt-1 text-lg">
                      <Figure minor={unbilled.data.totals.costMinor} colour={false} />
                    </dd>
                  </div>
                  <div>
                    <dt className="sw-label">Margin the accounts do not show</dt>
                    <dd className="sw-num mt-1 text-lg">
                      <Figure minor={unbilled.data.totals.marginMinor} colour={false} />
                    </dd>
                  </div>
                </dl>
                <p className="sw-sub mt-3 max-w-[75ch]">{unbilled.data.note}</p>
              </Panel>

              {unbilled.data.rows.length === 0 ? (
                <Empty>Everything delivered up to {unbilled.data.asOf} has been invoiced.</Empty>
              ) : (
                <Panel className="overflow-hidden">
                  <div className="sw-scroll">
                    <table className="sw-table">
                      <caption className="sr-only">Delivered and not yet invoiced</caption>
                      <thead>
                        <tr>
                          <th style={{ width: "8rem" }}>Note</th>
                          <th style={{ width: "7rem" }}>Delivered</th>
                          <th>Customer</th>
                          <th style={{ width: "7rem" }}>Order</th>
                          <th style={{ width: "8rem" }}>SKU</th>
                          <th className="sw-num" style={{ width: "6rem" }}>Unbilled</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost</th>
                          <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Value</th>
                        </tr>
                      </thead>
                      <tbody data-testid="unbilled-rows">
                        {unbilled.data.rows.map((r) => (
                          <tr key={`${r.number}:${r.sku}:${r.deliveredOn}`}>
                            <td className="sw-code">{r.number}</td>
                            <td>{r.deliveredOn}</td>
                            <td className="max-w-0 truncate">{r.customerName}</td>
                            <td className="sw-code">{r.orderNumber}</td>
                            <td className="sw-code">{r.sku ?? "—"}</td>
                            <td className="sw-num">{qty(r.uninvoicedMilli)}</td>
                            <td className="sw-num">
                              {r.costMinor === null
                                ? <span className="sw-sub">—</span>
                                : <Figure minor={r.costMinor} colour={false} />}
                            </td>
                            <td className="sw-num"><Figure minor={r.valueMinor} colour={false} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}

              <p className="sw-sub mt-3 max-w-[75ch]">
                Invoiced quantity belongs to the order line rather than to any one note, so it is consumed against the
                notes in the order they were delivered. Anything else would report the oldest delivery as unbilled
                while a later one had already been invoiced, which is the wrong way round for chasing it.
              </p>
            </>
          )}
        </>
      )}
    </>
  );
}
