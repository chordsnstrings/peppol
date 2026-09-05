"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";
import { fmtMinor, parseAmount } from "@/lib/ledger/format";

/* ------------------------------------------------------------------- wire --- */

interface OrderRow {
  id: string; number: string; supplierName: string;
  orderedOn: string; expectedOn: string | null; currency: string; status: string;
  lineCount: number; receiptCount: number;
  orderedMinor: string; receivedMinor: string; invoicedMinor: string;
}
interface GrniLine {
  orderLineId: string; lineNo: number; description: string; sku: string | null;
  orderedMilli: string; receivedMilli: string; invoicedMilli: string;
  receivedValueMinor: string; invoicedValueMinor: string; outstandingMinor: string;
}
interface GrniOrder {
  orderId: string; number: string; supplierName: string; status: string;
  oldestReceiptOn: string | null; daysOld: number | null;
  receivedValueMinor: string; invoicedValueMinor: string; outstandingMinor: string;
  lines: GrniLine[];
}
interface Grni {
  asOf: string;
  orders: GrniOrder[];
  totals: { outstandingMinor: string };
  ledger: { account: string; outstandingMinor: string; differenceMinor: string; agrees: boolean };
}
interface ListResponse { orders: OrderRow[]; grni: Grni }

interface DetailLine {
  id: string; lineNo: number; description: string; sku: string | null; accountCode: string | null;
  quantityMilli: string; unitPriceMinor: string; lineValueMinor: string;
  receivedMilli: string; invoicedMilli: string; outstandingMilli: string; grniMinor: string;
}
interface Detail {
  id: string; number: string; supplierName: string; orderedOn: string; expectedOn: string | null;
  currency: string; status: string; notes: string | null;
  lines: DetailLine[];
  receipts: { id: string; number: string; receivedOn: string; entryId: string | null; valueMinor: string }[];
}

type Finding = "quantity_variance" | "price_variance" | "not_received" | "over_invoiced" | "header_variance";
interface MatchLineResult {
  orderLineId: string; lineNo: number; description: string;
  orderedMilli: string; receivedMilli: string; previouslyInvoicedMilli: string; invoicedMilli: string;
  availableMilli: string; orderUnitPriceMinor: string; invoiceUnitPriceMinor: string;
  orderValueMinor: string; invoiceValueMinor: string; grniValueMinor: string;
  quantityVarianceMilli: string; priceVarianceMinor: string; varianceMinor: string;
  findings: Finding[]; matched: boolean; withinTolerance: boolean; reason: string;
}
interface MatchResult {
  orderNumber: string; supplierName: string; lines: MatchLineResult[];
  invoiceTotalMinor: string; vatMinor: string; invoiceNetMinor: string; expectedNetMinor: string;
  grniValueMinor: string; varianceMinor: string; headerVarianceMinor: string;
  findings: Finding[]; matched: boolean; withinTolerance: boolean; summary: string;
}

/* ---------------------------------------------------------------- numbers --- */

/** Quantities are thousandths. "1.5" is 1500, and a float would lose the edges. */
function toMilli(text: string): bigint | null {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * 1000n + BigInt(frac.padEnd(3, "0"));
}

/** Thousandths back out as a human reads them. */
function fromMilli(milli: string | bigint): string {
  const m = BigInt(milli);
  const neg = m < 0n;
  const abs = neg ? -m : m;
  const frac = (abs % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / 1000n}${frac ? "." + frac : ""}`;
}

const today = () => new Date().toISOString().slice(0, 10);

const FINDING_WORDS: Record<Finding, string> = {
  quantity_variance: "quantity",
  price_variance: "price",
  not_received: "never received",
  over_invoiced: "more than ordered",
  header_variance: "invoice total",
};

/* ------------------------------------------------------------------- page --- */

export default function ProcurementPage() {
  const entityId = useEntityId();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<"receive" | "match">("receive");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [drafting, setDrafting] = React.useState(false);
  const ask = useAsk();

  const list = useLedgerQuery<ListResponse>(entityId ? `/api/ledger/procurement?entityId=${entityId}` : null);
  const detail = useLedgerQuery<Detail>(
    selected ? `/api/ledger/procurement?orderId=${encodeURIComponent(selected)}` : null,
    [selected],
  );

  const act = async <T,>(key: string, body: Record<string, unknown>): Promise<T | null> => {
    setBusy(key); setErr(null); setMsg(null);
    try {
      const r = await api<T>("/api/ledger/procurement", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      list.reload();
      if (selected) detail.reload();
      return r;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const orders = list.data?.orders ?? [];
  const open = detail.data;

  return (
    <>
      <PageHead
        title="Purchase orders"
        sub="An order is a commitment, not an entry — raising one posts nothing. What posts is the delivery: between the goods arriving and the invoice arriving the business owes for stock it holds and has not been billed for, and that accrual lives in account 1250."
        actions={
          <button type="button" className="sw-btn" onClick={() => setDrafting((v) => !v)} data-testid="new-order">
            {drafting ? "Cancel" : "New order"}
          </button>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="procurement-result">{msg}</div>}
      {list.error && <ErrorNote>{list.error}</ErrorNote>}
      {list.loading && !list.data && <Loading />}

      {drafting && (
        <NewOrder
          busy={busy !== null}
          onCreate={async (order) => {
            const r = await act<{ order: { id: string; number: string } }>("create", { action: "create", order });
            if (!r) return;
            setDrafting(false);
            setSelected(r.order.id);
            setMsg(`${r.order.number} raised as a draft. Nothing has been posted — issue it when the supplier has been told.`);
          }}
        />
      )}

      {list.data && <GrniPanel grni={list.data.grni} />}

      {list.data && (orders.length === 0 ? (
        <Empty>No purchase orders yet. Raise one, issue it, and record the delivery when it arrives.</Empty>
      ) : (
        <Panel className="overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Every purchase order, what has been delivered and what has been invoiced</caption>
              <thead>
                <tr>
                  <th style={{ width: "9rem" }}>Order</th>
                  <th>Supplier</th>
                  <th style={{ width: "7rem" }}>Ordered</th>
                  <th style={{ width: "8rem" }}>Status</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Ordered</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Received</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Invoiced</th>
                  <th style={{ width: "11rem" }}><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="sw-code">
                      <button
                        type="button"
                        className="sw-link sw-link-btn"
                        onClick={() => setSelected(selected === o.id ? null : o.id)}
                        aria-expanded={selected === o.id}
                      >
                        {o.number}
                      </button>
                    </td>
                    <td className="max-w-0 truncate">{o.supplierName}</td>
                    <td>{o.orderedOn}</td>
                    <td><StatusChip status={o.status} /></td>
                    <td className="sw-num"><Figure minor={o.orderedMinor} colour={false} /></td>
                    <td className="sw-num"><Figure minor={o.receivedMinor} colour={false} /></td>
                    <td className="sw-num"><Figure minor={o.invoicedMinor} colour={false} /></td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {o.status === "draft" && (
                          <button
                            type="button"
                            className="sw-btn sw-btn-sm sw-btn-primary"
                            disabled={busy !== null}
                            aria-disabled={busy !== null || undefined}
                            onClick={async () => {
                              const r = await act<{ order: { number: string } }>(`${o.id}:issue`, { action: "issue", orderId: o.id });
                              if (r) setMsg(`${r.order.number} issued to ${o.supplierName}. Still no entry — an order is a commitment.`);
                            }}
                          >
                            Issue
                          </button>
                        )}
                        {(o.status === "draft" || o.status === "open") && (
                          <button
                            type="button"
                            className="sw-btn sw-btn-sm"
                            disabled={busy !== null}
                            aria-disabled={busy !== null || undefined}
                            onClick={async () => {
                              const reason = await ask({
                                title: `Why is ${o.number} being cancelled?`,
                                detail:
                                  `Nothing has been delivered against ${o.number}, so nothing is posted and nothing ` +
                                  "reverses — the order simply stops committing the business to the supplier. The " +
                                  "reason is kept on the order, and a cancelled order cannot be issued again.",
                                reason: {
                                  label: "Reason",
                                  placeholder: "Ordered twice by mistake",
                                  hint: "Whoever finds this order later has only what is written here.",
                                },
                                confirmLabel: "Cancel the order",
                                destructive: true,
                              });
                              if (reason === null) return;
                              const r = await act<{ order: { number: string } }>(`${o.id}:cancel`, { action: "cancel", orderId: o.id, reason });
                              if (r) setMsg(`${r.order.number} cancelled.`);
                            }}
                          >
                            Cancel
                          </button>
                        )}
                        {(o.status === "open" || o.status === "part_received" || o.status === "received") && (
                          <button
                            type="button"
                            className="sw-btn sw-btn-sm"
                            onClick={() => { setSelected(o.id); setTab(o.status === "received" ? "match" : "receive"); }}
                          >
                            {o.status === "received" ? "Match invoice" : "Receive"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={4} style={{ textAlign: "end" }}>Totals across every order</th>
                  <td className="sw-num"><Figure minor={sum(orders, (o) => o.orderedMinor)} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={sum(orders, (o) => o.receivedMinor)} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={sum(orders, (o) => o.invoicedMinor)} zero="zero" colour={false} /></td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      ))}

      {selected && detail.error && <ErrorNote>{detail.error}</ErrorNote>}
      {selected && open && (
        <Panel className="mt-4 overflow-hidden">
          <div className="border-b px-3 py-2 flex flex-wrap items-center justify-between gap-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
            <span className="sw-label">{open.number} — {open.supplierName}</span>
            <StatusChip status={open.status} />
          </div>

          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">The lines of {open.number}: what was ordered, what has arrived and what has been billed</caption>
              <thead>
                <tr>
                  <th style={{ width: "3rem" }}>#</th>
                  <th>Description</th>
                  <th style={{ width: "7rem" }}>SKU</th>
                  <th className="sw-num" style={{ width: "6rem" }}>Ordered</th>
                  <th className="sw-num" style={{ width: "6rem" }}>Received</th>
                  <th className="sw-num" style={{ width: "6rem" }}>Invoiced</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit price</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>In 1250</th>
                </tr>
              </thead>
              <tbody>
                {open.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.lineNo}</td>
                    <td className="max-w-0 truncate">{l.description}</td>
                    <td className="sw-code">{l.sku ?? <span className="sw-zero">–</span>}</td>
                    <td className="sw-num">{fromMilli(l.quantityMilli)}</td>
                    <td className="sw-num">{fromMilli(l.receivedMilli)}</td>
                    <td className="sw-num">{fromMilli(l.invoicedMilli)}</td>
                    <td className="sw-num"><Figure minor={l.unitPriceMinor} colour={false} /></td>
                    <td className="sw-num"><Figure minor={l.grniMinor} zero="zero" colour={false} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={7} style={{ textAlign: "end" }}>Still accrued in 1250 against this order</th>
                  <td className="sw-num" data-testid="order-grni">
                    <Figure minor={sum(open.lines, (l) => l.grniMinor)} zero="zero" colour={false} />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {open.receipts.length > 0 && (
            <div className="sw-scroll" style={{ borderTop: "1px solid var(--sw-line)" }}>
              <table className="sw-table">
                <caption className="sr-only">Every delivery recorded against {open.number}</caption>
                <thead>
                  <tr>
                    <th style={{ width: "12rem" }}>Delivery note</th>
                    <th style={{ width: "8rem" }}>Received</th>
                    <th>Entry</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Accrued</th>
                  </tr>
                </thead>
                <tbody>
                  {open.receipts.map((r) => (
                    <tr key={r.id}>
                      <td className="sw-code">{r.number}</td>
                      <td>{r.receivedOn}</td>
                      <td>
                        {r.entryId
                          ? <Link href={`/accounting/journals/${encodeURIComponent(r.entryId)}`} className="sw-link">journal entry</Link>
                          : <span className="sw-zero">–</span>}
                      </td>
                      <td className="sw-num"><Figure minor={r.valueMinor} colour={false} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="p-4" style={{ borderTop: "1px solid var(--sw-line)" }}>
            <div className="sw-tabs" style={{ marginTop: "-0.25rem" }}>
              {(["receive", "match"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className="sw-tab"
                  aria-current={tab === t ? "page" : undefined}
                  onClick={() => setTab(t)}
                >
                  {t === "receive" ? "Record a delivery" : "Match an invoice"}
                </button>
              ))}
            </div>

            {tab === "receive"
              ? <ReceiveForm order={open} busy={busy !== null} onReceive={async (body, describe) => {
                  const r = await act<Record<string, unknown>>("receive", { action: "receive", orderId: open.id, ...body });
                  if (r) setMsg(describe(r));
                }} />
              : <MatchForm order={open} busy={busy !== null} act={act} onPosted={setMsg} />}
          </div>
        </Panel>
      )}
    </>
  );
}

function sum<T>(rows: T[], pick: (r: T) => string): string {
  return rows.reduce((a, r) => a + BigInt(pick(r)), 0n).toString();
}

/* ------------------------------------------------------------------- GRNI --- */

/**
 * The reconciliation sits above the orders rather than on a screen of its own.
 * A GRNI balance nobody can explain is where stock losses hide, so the question
 * is put in front of the buyer instead of waiting to be asked.
 */
function GrniPanel({ grni }: { grni: Grni }) {
  const [showing, setShowing] = React.useState(false);
  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Goods received, not yet invoiced</div>
      <table className="sw-table mt-3" style={{ maxWidth: "42rem" }}>
        <caption className="sr-only">Deliveries not yet invoiced, against account 1250 in the ledger</caption>
        <tbody>
          <tr>
            <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>Delivered and unbilled, per the orders</th>
            <td className="sw-num" data-testid="grni-orders">
              <Figure minor={grni.totals.outstandingMinor} zero="zero" colour={false} />
            </td>
          </tr>
          <tr>
            <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
              <Link href={`/accounting/accounts/${grni.ledger.account}`} className="sw-link">Account {grni.ledger.account}</Link>, per the ledger
            </th>
            <td className="sw-num" data-testid="grni-ledger">
              <Figure minor={grni.ledger.outstandingMinor} zero="zero" colour={false} />
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" style={{ textAlign: "start" }}>
              <span className={`sw-chip ${grni.ledger.agrees ? "sw-chip-ok" : "sw-chip-bad"}`} data-testid="grni-agrees">
                {grni.ledger.agrees ? "agrees" : "differs"}
              </span>
            </th>
            <td className="sw-num">
              {!grni.ledger.agrees && <Figure minor={grni.ledger.differenceMinor} zero="zero" />}
            </td>
          </tr>
        </tfoot>
      </table>

      {!grni.ledger.agrees && (
        <p className="sw-sub mt-2" style={{ color: "var(--sw-warn)" }}>
          Account {grni.ledger.account} holds a balance the orders below do not account for. That is either a manual
          journal posted straight into it, or a delivery recorded on one side only. Find it before it ages —
          an unbilled delivery and a delivery that never happened leave the same trace here.
        </p>
      )}

      {grni.orders.length > 0 && (
        <>
          <button
            type="button"
            className="sw-btn sw-btn-sm mt-3"
            onClick={() => setShowing((s) => !s)}
            aria-expanded={showing}
            data-testid="grni-detail-toggle"
          >
            {showing ? "Hide the detail" : `Show what is in it (${grni.orders.length} order${grni.orders.length === 1 ? "" : "s"})`}
          </button>
          {showing && (
            <div className="sw-scroll mt-3">
              <table className="sw-table">
                <caption className="sr-only">Every order with a delivery that has not been invoiced, as at {grni.asOf}</caption>
                <thead>
                  <tr>
                    <th style={{ width: "9rem" }}>Order</th>
                    <th>Supplier</th>
                    <th style={{ width: "8rem" }}>Oldest delivery</th>
                    <th className="sw-num" style={{ width: "5rem" }}>Days</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Received</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Invoiced</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>In 1250</th>
                  </tr>
                </thead>
                <tbody>
                  {grni.orders.map((o) => (
                    <tr key={o.orderId}>
                      <td className="sw-code">{o.number}</td>
                      <td className="max-w-0 truncate">{o.supplierName}</td>
                      <td>{o.oldestReceiptOn ?? <span className="sw-zero">–</span>}</td>
                      <td className="sw-num">{o.daysOld ?? <span className="sw-zero">–</span>}</td>
                      <td className="sw-num"><Figure minor={o.receivedValueMinor} colour={false} /></td>
                      <td className="sw-num"><Figure minor={o.invoicedValueMinor} zero="zero" colour={false} /></td>
                      <td className="sw-num"><Figure minor={o.outstandingMinor} colour={false} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={6} style={{ textAlign: "end" }}>Total delivered and unbilled</th>
                    <td className="sw-num" data-testid="grni-total">
                      <Figure minor={grni.totals.outstandingMinor} zero="zero" colour={false} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------- new order --- */

function NewOrder({ busy, onCreate }: {
  busy: boolean;
  onCreate: (order: Record<string, unknown>) => void;
}) {
  const [f, setF] = React.useState({
    number: "", supplierName: "", orderedOn: today(), expectedOn: "",
    description: "", sku: "", qty: "", price: "", account: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const qty = toMilli(f.qty);
  const price = parseAmount(f.price);

  const blocker =
    !f.number.trim() ? "Give the order a number — the delivery note and the invoice will both quote it." :
    !f.supplierName.trim() ? "Who is it going to?" :
    !f.description.trim() ? "What is being ordered?" :
    qty === null || qty <= 0n ? "How many? Up to three decimal places." :
    price === null || price < 0n ? "What is the unit price?" :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">A new order, with its first line</div>
      <p className="sw-sub mt-1 max-w-[74ch]">
        It starts as a draft, and raising it posts nothing to the ledger. Add any further lines while it is
        still a draft; once it is issued, the supplier is working to it and a further line belongs on a second order.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Order number"><input className="sw-input" value={f.number} onChange={(e) => set("number", e.target.value)} placeholder="PO-2026-014" /></Field>
        <Field label="Supplier"><input className="sw-input" value={f.supplierName} onChange={(e) => set("supplierName", e.target.value)} placeholder="Gulf Steel LLC" /></Field>
        <Field label="Ordered on"><input type="date" className="sw-input" value={f.orderedOn} onChange={(e) => set("orderedOn", e.target.value)} /></Field>
        <Field label="Expected"><input type="date" className="sw-input" value={f.expectedOn} onChange={(e) => set("expectedOn", e.target.value)} /></Field>
        <Field label="Description"><input className="sw-input" value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Steel bar 12mm" /></Field>
        <Field label="SKU (stock lines only)"><input className="sw-input" value={f.sku} onChange={(e) => set("sku", e.target.value)} placeholder="STEEL-12" /></Field>
        <Field label="Quantity"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.qty} onChange={(e) => set("qty", e.target.value)} placeholder="100" /></Field>
        <Field label="Unit price"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.price} onChange={(e) => set("price", e.target.value)} placeholder="100.00" /></Field>
        {!f.sku.trim() && (
          <Field label="Account"><input className="sw-input" value={f.account} onChange={(e) => set("account", e.target.value)} placeholder="6900" /></Field>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="order-submit"
          onClick={() => {
            if (blocker) return;
            onCreate({
              number: f.number.trim(),
              supplierName: f.supplierName.trim(),
              orderedOn: f.orderedOn,
              expectedOn: f.expectedOn || undefined,
              lines: [{
                description: f.description.trim(),
                sku: f.sku.trim() || undefined,
                quantityMilli: (qty as bigint).toString(),
                unitPriceMinor: (price as bigint).toString(),
                accountCode: f.sku.trim() ? undefined : f.account.trim() || undefined,
              }],
            });
          }}
        >
          {busy ? "Working…" : "Raise the order"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="order-blocker">{blocker}</span>}
        {!blocker && <span className="sw-sub">Nothing will be posted. An order is a commitment.</span>}
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------- receipt --- */

function ReceiveForm({ order, busy, onReceive }: {
  order: Detail;
  busy: boolean;
  onReceive: (body: Record<string, unknown>, describe: (r: Record<string, unknown>) => string) => void;
}) {
  const outstanding = order.lines.filter((l) => BigInt(l.outstandingMilli) > 0n);
  const [f, setF] = React.useState({ number: "", receivedOn: today() });
  const [qtys, setQtys] = React.useState<Record<string, string>>({});

  const parsed = outstanding
    .map((l) => ({ line: l, qty: toMilli(qtys[l.id] ?? "") }))
    .filter((r) => r.qty !== null && r.qty > 0n);

  const bad = outstanding.find((l) => {
    const q = toMilli(qtys[l.id] ?? "");
    return q !== null && q > BigInt(l.outstandingMilli);
  });

  const blocker =
    outstanding.length === 0 ? "Every line has already been received in full." :
    bad ? `Line ${bad.lineNo} only has ${fromMilli(bad.outstandingMilli)} still outstanding.` :
    parsed.length === 0 ? "How much arrived? Fill in at least one line." :
    null;

  if (outstanding.length === 0) {
    return <p className="sw-sub mt-3">Every line on {order.number} has been received in full. Match the supplier&rsquo;s invoice against it next.</p>;
  }

  return (
    <>
      <p className="sw-sub mt-3 max-w-[78ch]">
        Valued at the price the order committed to, because that is the only price anyone has agreed yet.
        The delivery debits stock or the line&rsquo;s expense account and credits 1250 — the liability for goods
        the business is holding and has not been billed for.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Delivery note"><input className="sw-input" value={f.number} onChange={(e) => setF((x) => ({ ...x, number: e.target.value }))} placeholder={`${order.number}-GRN${order.receipts.length + 1}`} /></Field>
        <Field label="Received on"><input type="date" className="sw-input" value={f.receivedOn} onChange={(e) => setF((x) => ({ ...x, receivedOn: e.target.value }))} /></Field>
      </div>

      <div className="sw-scroll mt-3">
        <table className="sw-table sw-grid">
          <caption className="sr-only">How much of each outstanding line arrived</caption>
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>#</th>
              <th>Description</th>
              <th className="sw-num" style={{ width: "7rem" }}>Outstanding</th>
              <th className="sw-num" style={{ width: "8rem" }}>Arrived</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Value</th>
            </tr>
          </thead>
          <tbody>
            {outstanding.map((l) => {
              const q = toMilli(qtys[l.id] ?? "");
              const over = q !== null && q > BigInt(l.outstandingMilli);
              return (
                <tr key={l.id}>
                  <td style={{ padding: "0 0.625rem" }}>{l.lineNo}</td>
                  <td className="max-w-0 truncate" style={{ padding: "0 0.625rem" }}>{l.description}</td>
                  <td className="sw-num" style={{ padding: "0 0.625rem" }}>{fromMilli(l.outstandingMilli)}</td>
                  <td>
                    <input
                      className={`sw-cell sw-cell-num ${over ? "sw-cell-invalid" : ""}`}
                      inputMode="decimal"
                      aria-label={`Line ${l.lineNo} quantity received`}
                      aria-invalid={over || undefined}
                      value={qtys[l.id] ?? ""}
                      onChange={(e) => setQtys((x) => ({ ...x, [l.id]: e.target.value }))}
                    />
                  </td>
                  <td className="sw-num" style={{ padding: "0 0.625rem" }}>
                    {q === null || q <= 0n
                      ? <span className="sw-zero">–</span>
                      : <Figure minor={((BigInt(l.unitPriceMinor) * q) / 1000n).toString()} colour={false} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={4} style={{ textAlign: "end" }}>To be accrued in 1250</th>
              <td className="sw-num" data-testid="receipt-value">
                <Figure
                  minor={parsed.reduce((a, r) => a + (BigInt(r.line.unitPriceMinor) * (r.qty as bigint)) / 1000n, 0n).toString()}
                  zero="zero"
                  colour={false}
                />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="receive-submit"
          onClick={() => {
            if (blocker) return;
            onReceive(
              {
                receivedOn: f.receivedOn,
                number: f.number.trim() || undefined,
                receiptLines: parsed.map((r) => ({ orderLineId: r.line.id, quantityMilli: (r.qty as bigint).toString() })),
              },
              (r) => `Delivery ${String(r.number)} recorded as ${String(r.reference)}. ${order.number} is now ${String(r.orderStatus).replace("_", " ")}.`,
            );
            setQtys({});
          }}
        >
          {busy ? "Working…" : "Record the delivery"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="receive-blocker">{blocker}</span>}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ match --- */

function MatchForm({ order, busy, act, onPosted }: {
  order: Detail;
  busy: boolean;
  act: <T,>(key: string, body: Record<string, unknown>) => Promise<T | null>;
  onPosted: (message: string) => void;
}) {
  const billable = order.lines;
  const [f, setF] = React.useState({
    invoiceNumber: "", invoicedOn: today(), total: "", vat: "",
    tolPrice: "", tolQty: "", override: "",
  });
  const [rows, setRows] = React.useState<Record<string, { qty: string; price: string }>>({});
  const [result, setResult] = React.useState<MatchResult | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const row = (l: DetailLine) => rows[l.id] ?? { qty: "", price: "" };
  const lines = billable
    .map((l) => {
      const r = row(l);
      const qtyMilli = toMilli(r.qty);
      const price = r.price.trim() === "" ? BigInt(l.unitPriceMinor) : parseAmount(r.price);
      return { l, qtyMilli, price };
    })
    .filter((x) => x.qtyMilli !== null && x.qtyMilli > 0n && x.price !== null);

  const total = parseAmount(f.total);
  const vat = f.vat.trim() === "" ? 0n : parseAmount(f.vat);

  const blocker =
    lines.length === 0 ? "Which lines is the supplier billing for?" :
    total === null || total <= 0n ? "What does the invoice come to, in total?" :
    vat === null ? "The VAT has to be an amount." :
    null;

  const payload = () => ({
    orderId: order.id,
    invoiceNumber: f.invoiceNumber.trim() || undefined,
    invoiceLines: lines.map((x) => ({
      orderLineId: x.l.id,
      quantityMilli: (x.qtyMilli as bigint).toString(),
      unitPriceMinor: (x.price as bigint).toString(),
    })),
    invoiceTotalMinor: (total as bigint).toString(),
    vatMinor: (vat as bigint).toString(),
    tolerance: {
      unitPriceMinor: (parseAmount(f.tolPrice) ?? 0n).toString(),
      quantityMilli: (toMilli(f.tolQty) ?? 0n).toString(),
    },
  });

  return (
    <>
      <p className="sw-sub mt-3 max-w-[78ch]">
        The three documents, side by side: what was ordered, what actually arrived, and what the supplier is
        asking to be paid for. Two of the three agreeing proves nothing — the case this catches is a line
        billed for goods that were never delivered, which a check against the order alone passes happily.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Invoice number"><input className="sw-input" value={f.invoiceNumber} onChange={(e) => set("invoiceNumber", e.target.value)} placeholder="SI-40122" /></Field>
        <Field label="Invoice date"><input type="date" className="sw-input" value={f.invoicedOn} onChange={(e) => set("invoicedOn", e.target.value)} /></Field>
        <Field label="Invoice total"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.total} onChange={(e) => set("total", e.target.value)} placeholder="10,500.00" /></Field>
        <Field label="Of which VAT"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.vat} onChange={(e) => set("vat", e.target.value)} placeholder="500.00" /></Field>
        <Field label="Price tolerance per unit"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.tolPrice} onChange={(e) => set("tolPrice", e.target.value)} placeholder="0.00" /></Field>
        <Field label="Quantity tolerance"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.tolQty} onChange={(e) => set("tolQty", e.target.value)} placeholder="0" /></Field>
      </div>
      <p className="sw-sub mt-1">
        Both tolerances start at nothing, deliberately. A tolerance nobody chose is a control nobody set.
      </p>

      <div className="sw-scroll mt-3">
        <table className="sw-table sw-grid">
          <caption className="sr-only">What the invoice is billing for, line by line, against the order and the deliveries</caption>
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>#</th>
              <th>Description</th>
              <th className="sw-num" style={{ width: "6rem" }}>Ordered</th>
              <th className="sw-num" style={{ width: "6rem" }}>Received</th>
              <th className="sw-num" style={{ width: "6rem" }}>Billed before</th>
              <th className="sw-num" style={{ width: "7rem" }}>Invoiced</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Invoice price</th>
            </tr>
          </thead>
          <tbody>
            {billable.map((l) => (
              <tr key={l.id}>
                <td style={{ padding: "0 0.625rem" }}>{l.lineNo}</td>
                <td className="max-w-0 truncate" style={{ padding: "0 0.625rem" }}>{l.description}</td>
                <td className="sw-num" style={{ padding: "0 0.625rem" }}>{fromMilli(l.quantityMilli)}</td>
                <td className="sw-num" style={{ padding: "0 0.625rem" }}>{fromMilli(l.receivedMilli)}</td>
                <td className="sw-num" style={{ padding: "0 0.625rem" }}>{fromMilli(l.invoicedMilli)}</td>
                <td>
                  <input
                    className="sw-cell sw-cell-num"
                    inputMode="decimal"
                    aria-label={`Line ${l.lineNo} quantity invoiced`}
                    value={row(l).qty}
                    onChange={(e) => setRows((x) => ({ ...x, [l.id]: { ...row(l), qty: e.target.value } }))}
                  />
                </td>
                <td>
                  <input
                    className="sw-cell sw-cell-num"
                    inputMode="decimal"
                    aria-label={`Line ${l.lineNo} invoiced unit price`}
                    placeholder={fmtMinor(l.unitPriceMinor, order.currency, { zero: "zero" })}
                    value={row(l).price}
                    onChange={(e) => setRows((x) => ({ ...x, [l.id]: { ...row(l), price: e.target.value } }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="match-check"
          onClick={async () => {
            if (blocker) return;
            const r = await act<MatchResult>("match", { action: "match", ...payload() });
            if (r) setResult(r);
          }}
        >
          Check the three documents
        </button>
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="match-post"
          onClick={async () => {
            if (blocker) return;
            const r = await act<{ reference: string; grniClearedMinor: string; varianceMinor: string }>("post", {
              action: "post",
              invoicedOn: f.invoicedOn,
              overrideReason: f.override.trim() || undefined,
              ...payload(),
            });
            if (!r) return;
            setResult(null);
            setRows({});
            onPosted(
              `Invoice posted as ${r.reference}. ${fmtMinor(r.grniClearedMinor, order.currency, { zero: "zero" })} came out of 1250` +
                (r.varianceMinor === "0" ? " and nothing went to variance." : `, and ${fmtMinor(r.varianceMinor, order.currency, { zero: "zero" })} went to the variance account.`),
            );
          }}
        >
          {busy ? "Working…" : "Post the invoice"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="match-blocker">{blocker}</span>}
      </div>

      {result && <MatchReport result={result} />}

      {(result && !result.withinTolerance) && (
        <div className="mt-3">
          <Field label="Override reason — recorded on the journal entry">
            <input
              className="sw-input"
              style={{ maxWidth: "44rem" }}
              value={f.override}
              onChange={(e) => set("override", e.target.value)}
              placeholder="Freight agreed by telephone with the supplier on 3 April"
              data-testid="match-override"
            />
          </Field>
          <p className="sw-sub mt-1 max-w-[74ch]">
            The invoice will not post while the match fails unless a reason is given, and the reason goes onto the
            entry memo where an auditor will find it. An override with no reason is not an override, it is a bypass.
          </p>
        </div>
      )}
    </>
  );
}

function MatchReport({ result }: { result: MatchResult }) {
  return (
    <div className="mt-4" data-testid="match-result">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`sw-chip ${result.matched ? "sw-chip-ok" : result.withinTolerance ? "sw-chip-warn" : "sw-chip-bad"}`}>
          {result.matched ? "matched" : result.withinTolerance ? "within tolerance" : "does not match"}
        </span>
        {result.findings.map((x) => (
          <span key={x} className="sw-chip sw-chip-bad">{FINDING_WORDS[x]}</span>
        ))}
      </div>
      <p className="sw-sub mt-2 max-w-[80ch]">{result.summary}</p>

      <div className="sw-scroll mt-3">
        <table className="sw-table">
          <caption className="sr-only">The three-way comparison, line by line, with the variance on each</caption>
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>#</th>
              <th style={{ minWidth: "10rem" }}>Description</th>
              <th className="sw-num" style={{ width: "5.5rem" }}>Ordered</th>
              <th className="sw-num" style={{ width: "5.5rem" }}>Received</th>
              <th className="sw-num" style={{ width: "5.5rem" }}>Invoiced</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Order price</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Invoice price</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Variance</th>
              <th style={{ minWidth: "22rem" }}>Why</th>
            </tr>
          </thead>
          <tbody>
            {result.lines.map((l) => (
              <tr key={l.orderLineId}>
                <td>{l.lineNo}</td>
                <td className="max-w-0 truncate">{l.description}</td>
                <td className="sw-num">{fromMilli(l.orderedMilli)}</td>
                <td className="sw-num">{fromMilli(l.receivedMilli)}</td>
                <td className="sw-num">{fromMilli(l.invoicedMilli)}</td>
                <td className="sw-num"><Figure minor={l.orderUnitPriceMinor} colour={false} /></td>
                <td className="sw-num"><Figure minor={l.invoiceUnitPriceMinor} colour={false} /></td>
                <td className="sw-num"><Figure minor={l.varianceMinor} zero="zero" /></td>
                <td className="sw-sub">{l.reason}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={7} style={{ textAlign: "end" }}>
                Invoice, less its VAT, against what the deliveries accrued in 1250
              </th>
              <td className="sw-num" data-testid="match-variance"><Figure minor={result.varianceMinor} zero="zero" /></td>
              <td className="sw-sub">
                {result.varianceMinor === "0"
                  ? "Nothing would go to a variance account."
                  : "This is what would be booked to the variance account rather than to stock."}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ field --- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
