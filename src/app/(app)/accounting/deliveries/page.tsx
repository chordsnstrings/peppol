"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";

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
  truncated: boolean;
  listed: number;
  notes: Note[];
  summary: {
    total: number; draft: number; dispatched: number; delivered: number; cancelled: number;
    unsigned: string[];
  };
}

interface OrderRow { id: string; number: string; customerName: string; status: string; kind: string }
interface OrderList { orders: OrderRow[] }

interface OutstandingLine {
  orderLineId: string; lineNo: number; sku: string | null; description: string;
  orderedMilli: string; deliveredMilli: string; outstandingMilli: string;
}
interface Outstanding {
  orderId: string; number: string; customerName: string; lines: OutstandingLine[];
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

/** A quantity as it is typed — "1.5" — into the thousandths that are stored. */
function toMilli(text: string): bigint | null {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * 1000n + BigInt(frac.padEnd(3, "0"));
}

/** Thousandths as a number somebody would write. */
function qty(milli: string): string {
  const neg = milli.startsWith("-");
  const s = (neg ? milli.slice(1) : milli).padStart(4, "0");
  const body = `${s.slice(0, -3)}.${s.slice(-3)}`.replace(/\.?0+$/, "");
  return `${neg ? "-" : ""}${body || "0"}`;
}

export default function DeliveriesPage() {
  const entityId = useEntityId();
  const ask = useAsk();
  const [from, setFrom] = React.useState(() => monthsBack(3));
  const [to, setTo] = React.useState(today);
  const [status, setStatus] = React.useState("");
  const [tab, setTab] = React.useState<"register" | "unbilled">("register");
  const [open, setOpen] = React.useState<string | null>(null);
  const [raising, setRaising] = React.useState(false);

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
            <button type="button" className="sw-btn" data-testid="toggle-new-note"
              onClick={() => setRaising((v) => !v)}>
              {raising ? "Cancel" : "Raise a delivery note"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="delivery-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {raising && (
        <NewNote
          entityId={entityId}
          busy={busy === "create"}
          onCreate={async (note) => {
            const r = await act("create", { action: "create", note });
            if (r) {
              setRaising(false);
              setMsg(
                `${note.number} is raised as a draft. Nothing has left inventory yet — dispatching it is what ` +
                `moves the cost out.`,
              );
            }
          }}
        />
      )}

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
                <dl className="grid gap-4 sm:grid-cols-5">
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
                  <div>
                    <dt className="sw-label">Cancelled</dt>
                    <dd className="sw-num mt-1 text-lg">{data.summary.cancelled}</dd>
                    <p className="sw-sub mt-0.5">
                      Only a draft can be cancelled. Once the goods have gone the document is a return.
                    </p>
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

              {data.truncated && (
                <p className="sw-sub mb-3 max-w-[75ch]" role="status" data-testid="delivery-truncated">
                  The newest {data.listed} of {data.summary.total} notes in the period are listed. The counts above
                  are over the whole period — narrow the dates to see the rest.
                </p>
              )}

              {data.notes.length === 0 ? (
                <Empty>
                  No delivery note between {data.from} and {data.to}. Raise one from an accepted sales order and its
                  outstanding lines come with it.
                </Empty>
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
                                        const reason = await ask({
                                          title: `Why is ${n.number} being cancelled?`,
                                          detail:
                                            `${n.number} is still a draft, so nothing has left inventory under it — there is no ` +
                                            "stock movement to reverse and no cost to put back. Nothing can have been invoiced " +
                                            "from it either, because only a dispatched note reaches the delivered-not-invoiced " +
                                            "report. " +
                                            (n.orderNumber
                                              ? `The quantity on it stops being committed and goes back to what ${n.orderNumber} still has to deliver. `
                                              : "") +
                                            "The reason is kept on the note, and a cancelled note cannot be dispatched.",
                                          reason: {
                                            label: "Reason",
                                            placeholder: "Raised against the wrong order",
                                            hint: "Whoever finds this note later has only what is written here.",
                                          },
                                          confirmLabel: "Cancel the note",
                                          destructive: true,
                                        });
                                        if (reason === null) return;
                                        const r = await act(`cancel:${n.number}`, { action: "cancel", number: n.number, reason });
                                        if (r) setMsg(
                                          n.orderNumber
                                            ? `${n.number} is cancelled. ${n.orderNumber} has that quantity back.`
                                            : `${n.number} is cancelled. Nothing had left under it.`,
                                        );
                                      }}>
                                      cancel
                                    </button>
                                  </>
                                )}
                                {n.status === "dispatched" && (
                                  <button type="button" className="sw-link-btn" disabled={busy === `confirm:${n.number}`}
                                    onClick={async () => {
                                      const who = await ask({
                                        title: `Who signed for ${n.number}?`,
                                        detail:
                                          `The name goes on the note as the proof that ${n.customerName} took the goods, and ` +
                                          `takes ${n.number} off the list of dispatched notes nobody ever signed for — the list ` +
                                          "somebody reaches for the day a customer says the delivery never arrived. Nothing " +
                                          "moves: the cost left inventory when the note was dispatched, and a signature is " +
                                          "evidence, not a posting.",
                                        reason: {
                                          label: "Signed by",
                                          placeholder: "R. Nair, storeman",
                                          minLength: 2,
                                          single: true,
                                          hint: "The name as it was written on the note. A surname on its own is fine.",
                                        },
                                        confirmLabel: "Record the signature",
                                      });
                                      if (who === null) return;
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

/* ------------------------------------------------------------- a new note */

/**
 * A delivery note is raised here rather than on the order screen because a
 * lorry does not always carry one order's worth: a note can be raised against
 * an order, which brings that order's outstanding lines with it, or against
 * nothing at all, which is what a sample, a replacement or a hand-delivery is.
 *
 * It is raised as a draft and posts nothing. Dispatching is what moves cost
 * out of inventory, and it is a separate act by somebody who has watched the
 * goods go.
 */
function NewNote({ entityId, busy, onCreate }: {
  entityId: string;
  busy: boolean;
  onCreate: (note: {
    number: string; orderId?: string; customerName?: string; deliveredOn: string;
    carrier?: string; trackingRef?: string; notes?: string;
    lines: { orderLineId?: string; sku?: string; description: string; quantityMilli: string }[];
  }) => void;
}) {
  const [number, setNumber] = React.useState("");
  const [orderId, setOrderId] = React.useState("");
  const [customerName, setCustomerName] = React.useState("");
  const [deliveredOn, setDeliveredOn] = React.useState(today);
  const [carrier, setCarrier] = React.useState("");
  const [trackingRef, setTrackingRef] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [qtys, setQtys] = React.useState<Record<string, string>>({});
  const [direct, setDirect] = React.useState([{ sku: "", description: "", quantity: "" }]);

  const orders = useLedgerQuery<OrderList>(
    `/api/ledger/sales-orders?entityId=${entityId}&kind=ORDER`, [entityId],
  );
  const outstanding = useLedgerQuery<Outstanding>(
    orderId ? `/api/ledger/deliveries?entityId=${entityId}&view=order&orderId=${orderId}` : null,
    [orderId],
  );

  // Only an order the customer has agreed to can have goods sent against it.
  const deliverable = (orders.data?.orders ?? []).filter(
    (o) => o.status === "accepted" || o.status === "part_invoiced",
  );

  // Picking an order fills the note in from it: the whole of what is still to
  // go, which is what a lorry usually carries, and the customer's name, which
  // is not a thing anybody should have to retype.
  const loaded = outstanding.data;
  React.useEffect(() => {
    if (!loaded) return;
    const next: Record<string, string> = {};
    for (const l of loaded.lines) {
      next[l.orderLineId] = BigInt(l.outstandingMilli) > 0n ? qty(l.outstandingMilli) : "";
    }
    setQtys(next);
    setCustomerName(loaded.customerName);
  }, [loaded]);

  const orderLines = (loaded?.lines ?? []).map((l) => ({
    line: l,
    typed: qtys[l.orderLineId] ?? "",
    milli: toMilli(qtys[l.orderLineId] ?? ""),
  }));
  const badOrderQty = orderLines.some((r) => r.typed.trim() !== "" && r.milli === null);
  const overDelivered = orderLines.find((r) => r.milli !== null && r.milli > BigInt(r.line.outstandingMilli));

  const directRows = direct.map((r) => ({ ...r, milli: toMilli(r.quantity) }));
  const badDirectQty = directRows.some((r) => r.quantity.trim() !== "" && r.milli === null);

  const lines = orderId
    ? orderLines
        .filter((r) => r.milli !== null && r.milli > 0n)
        .map((r) => ({
          orderLineId: r.line.orderLineId,
          sku: r.line.sku ?? undefined,
          description: r.line.description,
          quantityMilli: (r.milli as bigint).toString(),
        }))
    : directRows
        .filter((r) => r.milli !== null && r.milli > 0n)
        .map((r) => ({
          sku: r.sku.trim() || undefined,
          description: r.description.trim() || r.sku.trim() || "Goods",
          quantityMilli: (r.milli as bigint).toString(),
        }));

  const blocker =
    !number.trim() ? "A delivery note needs a number." :
    badOrderQty || badDirectQty ? "A quantity reads in units, up to three decimal places." :
    overDelivered
      ? `Line ${overDelivered.line.lineNo} has ${qty(overDelivered.line.outstandingMilli)} still to go. ` +
        "Change the order if the customer wants more."
      : lines.length === 0 ? "Nothing on the note has a quantity." :
    !orderId && !customerName.trim() ? "A delivery note has to say who it went to." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">A new delivery note</div>
      <p className="sw-sub mt-1 max-w-[78ch]">
        It is raised as a draft and posts nothing. Dispatching it is what moves the cost out of inventory — the
        revenue stays on the invoice, which is raised on the sales order screen by somebody who has looked at it.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="sw-label">Note number</span>
          <input className="sw-input sw-code mt-1" value={number} placeholder="DN-1"
            onChange={(e) => setNumber(e.target.value)} />
        </label>
        <label className="block lg:col-span-2">
          <span className="sw-label">Against order</span>
          <select className="sw-select mt-1" value={orderId} data-testid="note-order"
            onChange={(e) => { setOrderId(e.target.value); if (!e.target.value) setQtys({}); }}>
            <option value="">nothing — a direct delivery</option>
            {deliverable.map((o) => (
              <option key={o.id} value={o.id}>{o.number} — {o.customerName}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="sw-label">Delivered on</span>
          <input type="date" className="sw-input mt-1" value={deliveredOn}
            onChange={(e) => setDeliveredOn(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Customer</span>
          <input className="sw-input mt-1" value={customerName} placeholder="Marri Trading LLC"
            onChange={(e) => setCustomerName(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Carrier</span>
          <input className="sw-input mt-1" value={carrier} placeholder="optional"
            onChange={(e) => setCarrier(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Tracking</span>
          <input className="sw-input mt-1" value={trackingRef} placeholder="optional"
            onChange={(e) => setTrackingRef(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Note</span>
          <input className="sw-input mt-1" value={notes} placeholder="optional"
            onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>

      {orders.error && <div className="sw-error mt-3" role="alert">{orders.error}</div>}
      {orderId && outstanding.error && <div className="sw-error mt-3" role="alert">{outstanding.error}</div>}

      {orderId && outstanding.loading && !loaded && <Loading label="Reading what that order still owes…" />}

      {orderId && loaded && (
        <div className="sw-scroll mt-3">
          <table className="sw-table sw-grid">
            <caption className="sr-only">What {loaded.number} still has to go, and how much is going now</caption>
            <thead>
              <tr>
                <th style={{ width: "3rem" }}>#</th>
                <th style={{ width: "8rem" }}>SKU</th>
                <th>Description</th>
                <th className="sw-num" style={{ width: "6rem" }}>Ordered</th>
                <th className="sw-num" style={{ width: "6rem" }}>Gone</th>
                <th className="sw-num" style={{ width: "6rem" }}>Still to go</th>
                <th className="sw-num" style={{ width: "8rem" }}>Going now</th>
              </tr>
            </thead>
            <tbody data-testid="note-order-lines">
              {loaded.lines.map((l) => {
                const typed = qtys[l.orderLineId] ?? "";
                const parsed = toMilli(typed);
                const bad = typed.trim() !== "" &&
                  (parsed === null || parsed > BigInt(l.outstandingMilli));
                return (
                  <tr key={l.orderLineId}>
                    <td className="sw-num">{l.lineNo}</td>
                    <td className="sw-code">{l.sku ?? "—"}</td>
                    <td className="max-w-0 truncate">{l.description}</td>
                    <td className="sw-num">{qty(l.orderedMilli)}</td>
                    <td className="sw-num">{qty(l.deliveredMilli)}</td>
                    <td className="sw-num">{qty(l.outstandingMilli)}</td>
                    <td>
                      <input
                        className={`sw-input sw-cell-num w-full ${bad ? "sw-cell-invalid" : ""}`}
                        inputMode="decimal" value={typed} placeholder="0"
                        aria-label={`Quantity of line ${l.lineNo} going now`}
                        onChange={(e) => setQtys((x) => ({ ...x, [l.orderLineId]: e.target.value }))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!orderId && (
        <div className="sw-scroll mt-3">
          <table className="sw-table sw-grid" style={{ maxWidth: "48rem" }}>
            <caption className="sr-only">What is on the note</caption>
            <thead>
              <tr>
                <th style={{ width: "10rem" }}>SKU</th>
                <th>Description</th>
                <th className="sw-num" style={{ width: "8rem" }}>Quantity</th>
                <th style={{ width: "5rem" }} />
              </tr>
            </thead>
            <tbody data-testid="note-direct-lines">
              {direct.map((r, i) => (
                <tr key={i}>
                  <td>
                    <input className="sw-input sw-code w-full" value={r.sku} placeholder="WIDGET"
                      aria-label={`SKU of line ${i + 1}`}
                      onChange={(e) => setDirect((d) => d.map((x, j) => j === i ? { ...x, sku: e.target.value } : x))} />
                  </td>
                  <td>
                    <input className="sw-input w-full" value={r.description} placeholder="Widget"
                      aria-label={`Description of line ${i + 1}`}
                      onChange={(e) => setDirect((d) => d.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
                  </td>
                  <td>
                    <input
                      className={`sw-input sw-cell-num w-full ${r.quantity.trim() !== "" && toMilli(r.quantity) === null ? "sw-cell-invalid" : ""}`}
                      inputMode="decimal" value={r.quantity} placeholder="0"
                      aria-label={`Quantity of line ${i + 1}`}
                      onChange={(e) => setDirect((d) => d.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} />
                  </td>
                  <td>
                    {direct.length > 1 && (
                      <button type="button" className="sw-link-btn"
                        onClick={() => setDirect((d) => d.filter((_, j) => j !== i))}>
                        remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!orderId && (
        <button type="button" className="sw-btn sw-btn-sm mt-2"
          onClick={() => setDirect((d) => [...d, { sku: "", description: "", quantity: "" }])}>
          Another line
        </button>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="sw-btn sw-btn-primary" data-testid="save-note"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          onClick={() => {
            if (blocker) return;
            onCreate({
              number: number.trim(),
              orderId: orderId || undefined,
              customerName: customerName.trim() || undefined,
              deliveredOn,
              carrier: carrier.trim() || undefined,
              trackingRef: trackingRef.trim() || undefined,
              notes: notes.trim() || undefined,
              lines,
            });
          }}>
          {busy ? "Raising…" : "Raise the note"}
        </button>
        {blocker
          ? <span className="sw-sub" role="status" data-testid="note-blocker">{blocker}</span>
          : <span className="sw-sub">Nothing is posted. A note is a document until it is dispatched.</span>}
      </div>
    </Panel>
  );
}
