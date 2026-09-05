"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";
import { parseAmount } from "@/lib/ledger/format";
import { TAX_PROFILE_LIST } from "@/lib/domain/tax";

/* ------------------------------------------------------------------- wire --- */

interface OrderRow {
  id: string; number: string; kind: "QUOTE" | "ORDER";
  customerCode: string | null; customerName: string;
  issuedOn: string; validUntil: string | null; currency: string; status: string;
  lineCount: number;
  netMinor: string; vatMinor: string; grossMinor: string; remainingNetMinor: string;
  lapsed: boolean;
}
interface ListResponse {
  orders: OrderRow[];
  totals: { netMinor: string; vatMinor: string; grossMinor: string; remainingNetMinor: string };
}

interface TaxSubtotal { taxCode: string; label: string; ratePercent: number; netMinor: string; vatMinor: string }
interface Totals { netMinor: string; vatMinor: string; grossMinor: string; taxes: TaxSubtotal[] }

interface DetailLine {
  id: string; lineNo: number; description: string; sku: string | null; accountCode: string | null;
  quantityMilli: string; unitPriceMinor: string; discountBps: number; taxCode: string; ratePercent: number;
  netMinor: string; invoicedMilli: string; invoicedNetMinor: string;
  remainingMilli: string; remainingNetMinor: string;
}
interface Detail {
  id: string; number: string; kind: "QUOTE" | "ORDER";
  customerCode: string | null; customerName: string; customerTrn: string | null;
  issuedOn: string; validUntil: string | null; currency: string; status: string; notes: string | null;
  lines: DetailLine[];
  totals: Totals; invoiced: Totals; remaining: Totals;
  lapsed: boolean;
}

interface InvoiceResult {
  number: string; status: string;
  totals: Totals;
  lines: { orderLineId: string; lineNo: number; description: string; invoicedNowMilli: string; remainingMilli: string }[];
}

interface ExpireResult { asOf: string; expired: number; quotes: { number: string; customerName: string }[] }

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

/** A discount as it is typed — "12.5" percent — into the basis points stored. */
function toBps(text: string): number | null {
  const t = text.trim();
  if (!t) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

const pct = (b: number) => `${(b / 100).toFixed(b % 100 === 0 ? 0 : 2)}%`;
const today = () => new Date().toISOString().slice(0, 10);

const TABS = [
  { key: "", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "sent", label: "Sent" },
  { key: "accepted", label: "Accepted" },
  { key: "part_invoiced", label: "Part invoiced" },
  { key: "invoiced", label: "Invoiced" },
  { key: "expired", label: "Expired" },
  { key: "declined", label: "Declined" },
  { key: "cancelled", label: "Cancelled" },
] as const;

/* ------------------------------------------------------------------- page --- */

export default function SalesOrdersPage() {
  const entityId = useEntityId();
  const [status, setStatus] = React.useState<string>("");
  const [kind, setKind] = React.useState<"" | "QUOTE" | "ORDER">("");
  const [customerCode, setCustomerCode] = React.useState("");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [drafting, setDrafting] = React.useState(false);

  const query = new URLSearchParams({ entityId: entityId ?? "" });
  if (status) query.set("status", status);
  if (kind) query.set("kind", kind);
  if (customerCode.trim()) query.set("customerCode", customerCode.trim());

  const list = useLedgerQuery<ListResponse>(entityId ? `/api/ledger/sales-orders?${query}` : null);
  const detail = useLedgerQuery<Detail>(
    selected && entityId
      ? `/api/ledger/sales-orders?orderId=${encodeURIComponent(selected)}&entityId=${encodeURIComponent(entityId)}`
      : null,
    [selected],
  );

  const act = async <T,>(key: string, body: Record<string, unknown>): Promise<T | null> => {
    setBusy(key); setErr(null); setMsg(null);
    try {
      const r = await api<T>("/api/ledger/sales-orders", {
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
  const lapsed = orders.filter((o) => o.lapsed).length;

  return (
    <>
      <PageHead
        title="Quotations and sales orders"
        sub="What has been offered, and what has been agreed. Neither posts anything: a quote is an offer and an order is a promise, and the entry is made when the invoice is raised. What is kept here is how much of each line has been billed, so an order can say what is left and cannot be billed for it twice."
        actions={
          <>
            <button
              type="button"
              className="sw-btn"
              disabled={busy !== null}
              aria-disabled={busy !== null || undefined}
              onClick={async () => {
                const r = await act<ExpireResult>("expire", { action: "expire", asOf: today() });
                if (!r) return;
                setMsg(
                  r.expired === 0
                    ? `Nothing has lapsed as at ${r.asOf}. Every quote still on offer is still inside its validity.`
                    : `${r.expired} quotation${r.expired === 1 ? "" : "s"} past validity marked expired: ${r.quotes.map((q) => q.number).join(", ")}.`,
                );
              }}
              data-testid="expire-quotes"
            >
              Expire lapsed quotes{lapsed > 0 ? ` (${lapsed})` : ""}
            </button>
            <button type="button" className="sw-btn sw-btn-primary" onClick={() => setDrafting((v) => !v)} data-testid="new-quote">
              {drafting ? "Cancel" : "New quotation"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="sales-orders-result">{msg}</div>}
      {list.error && <ErrorNote>{list.error}</ErrorNote>}
      {list.loading && !list.data && <Loading />}

      {drafting && (
        <NewDocument
          busy={busy !== null}
          onCreate={async (order) => {
            const r = await act<{ order: { id: string; number: string; kind: string } }>("create", { action: "create", order });
            if (!r) return;
            setDrafting(false);
            setSelected(r.order.id);
            setMsg(`${r.order.number} raised as a draft ${r.order.kind === "QUOTE" ? "quotation" : "sales order"}. Nothing has been posted — send it when the customer is to see it.`);
          }}
        />
      )}

      <Panel className="mb-4 p-3">
        <div className="sw-tabs" style={{ marginTop: "-0.25rem" }} role="group" aria-label="Filter by status">
          {TABS.map((t) => (
            <button
              key={t.key || "all"}
              type="button"
              className="sw-tab"
              aria-current={status === t.key ? "page" : undefined}
              onClick={() => setStatus(t.key)}
              data-testid={`tab-${t.key || "all"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Document">
            <select className="sw-select sw-select-sm" value={kind} onChange={(e) => setKind(e.target.value as "" | "QUOTE" | "ORDER")}>
              <option value="">Quotations and orders</option>
              <option value="QUOTE">Quotations only</option>
              <option value="ORDER">Orders only</option>
            </select>
          </Field>
          <Field label="Customer code">
            <input
              className="sw-input sw-input-sm"
              value={customerCode}
              onChange={(e) => setCustomerCode(e.target.value)}
              placeholder="ACME"
            />
          </Field>
          <p className="sw-sub" role="status" aria-live="polite" data-testid="sales-orders-count">
            {list.data
              ? `${orders.length} document${orders.length === 1 ? "" : "s"}${status ? ` in ${status.replace(/_/g, " ")}` : ""}.`
              : "Loading…"}
          </p>
        </div>
      </Panel>

      {list.data && (orders.length === 0 ? (
        <Empty>Nothing here yet. Raise a quotation, send it, and convert it once the customer says yes.</Empty>
      ) : (
        <Panel className="overflow-hidden">
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Every quotation and sales order, what it is worth and what is still to be invoiced</caption>
              <thead>
                <tr>
                  <th style={{ width: "8rem" }}>Document</th>
                  <th style={{ width: "5rem" }}>Kind</th>
                  <th>Customer</th>
                  <th style={{ width: "7rem" }}>Issued</th>
                  <th style={{ width: "7rem" }}>Valid until</th>
                  <th style={{ width: "8rem" }}>Status</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>VAT</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Gross</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>To invoice</th>
                  <th style={{ width: "13rem" }}><span className="sr-only">Actions</span></th>
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
                    <td><span className="sw-chip">{o.kind === "QUOTE" ? "quote" : "order"}</span></td>
                    <td className="max-w-0 truncate">
                      {o.customerName}
                      {o.customerCode && <span className="sw-sub"> · {o.customerCode}</span>}
                    </td>
                    <td>{o.issuedOn}</td>
                    <td>
                      {o.validUntil ?? <span className="sw-zero">–</span>}
                      {o.lapsed && <span className="sw-chip sw-chip-warn" style={{ marginInlineStart: "0.35rem" }}>lapsed</span>}
                    </td>
                    <td><StatusChip status={o.status} /></td>
                    <td className="sw-num"><Figure minor={o.netMinor} currency={o.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={o.vatMinor} currency={o.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={o.grossMinor} currency={o.currency} colour={false} /></td>
                    <td className="sw-num"><Figure minor={o.remainingNetMinor} currency={o.currency} colour={false} /></td>
                    <td>
                      <RowActions
                        order={o}
                        busy={busy !== null}
                        onSelect={() => setSelected(o.id)}
                        act={act}
                        onDone={setMsg}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={6} style={{ textAlign: "end" }}>Totals across the documents listed</th>
                  <td className="sw-num"><Figure minor={list.data.totals.netMinor} zero="zero" colour={false} /></td>
                  <td className="sw-num"><Figure minor={list.data.totals.vatMinor} zero="zero" colour={false} /></td>
                  <td className="sw-num" data-testid="list-gross"><Figure minor={list.data.totals.grossMinor} zero="zero" colour={false} /></td>
                  <td className="sw-num" data-testid="list-remaining"><Figure minor={list.data.totals.remainingNetMinor} zero="zero" colour={false} /></td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      ))}

      {selected && detail.error && <ErrorNote>{detail.error}</ErrorNote>}
      {selected && open && (
        <DetailPanel
          open={open}
          busy={busy !== null}
          act={act}
          onDone={setMsg}
        />
      )}
    </>
  );
}

/* --------------------------------------------------------------- the row --- */

function RowActions({ order, busy, onSelect, act, onDone }: {
  order: OrderRow;
  busy: boolean;
  onSelect: () => void;
  act: <T,>(key: string, body: Record<string, unknown>) => Promise<T | null>;
  onDone: (m: string) => void;
}) {
  const ask = useAsk();
  const guard = { disabled: busy, "aria-disabled": busy || undefined } as const;
  return (
    <div className="flex flex-wrap gap-1">
      {order.status === "draft" && (
        <button
          type="button" className="sw-btn sw-btn-sm sw-btn-primary" {...guard}
          onClick={async () => {
            const r = await act<{ order: { number: string } }>(`${order.id}:send`, { action: "send", orderId: order.id });
            if (r) onDone(`${r.order.number} sent to ${order.customerName}. Still no entry — an offer is not a transaction.`);
          }}
        >
          Send
        </button>
      )}
      {order.status === "sent" && (
        <>
          <button
            type="button" className="sw-btn sw-btn-sm sw-btn-primary" {...guard}
            onClick={async () => {
              const r = await act<{ order: { number: string } }>(`${order.id}:accept`, { action: "accept", orderId: order.id, acceptedOn: today() });
              if (r) onDone(`${r.order.number} accepted.${order.kind === "QUOTE" ? " Convert it into an order to invoice against it." : ""}`);
            }}
          >
            Accept
          </button>
          <button
            type="button" className="sw-btn sw-btn-sm" {...guard}
            onClick={async () => {
              const reason = await ask({
                title: `Why did ${order.number} not go ahead?`,
                detail:
                  "The document stays exactly as the customer saw it. Nothing is posted — a quotation the " +
                  "customer turned down never reached the books.",
                reason: {
                  label: "Reason",
                  placeholder: "Went to another supplier on price",
                  hint: "This is what the next person sees when they ask why this one did not close.",
                },
                confirmLabel: "Mark declined",
              });
              if (reason === null) return;
              const r = await act<{ order: { number: string } }>(`${order.id}:decline`, { action: "decline", orderId: order.id, reason });
              if (r) onDone(`${r.order.number} marked declined.`);
            }}
          >
            Decline
          </button>
        </>
      )}
      {order.status === "accepted" && order.kind === "QUOTE" && (
        <button
          type="button" className="sw-btn sw-btn-sm sw-btn-primary" {...guard}
          onClick={async () => {
            const r = await act<{ order: { number: string } }>(`${order.id}:convert`, { action: "convert", orderId: order.id });
            if (r) onDone(`${order.number} carried onto ${r.order.number}. The quotation stays exactly as the customer accepted it.`);
          }}
        >
          Convert to order
        </button>
      )}
      {order.kind === "ORDER" && (order.status === "accepted" || order.status === "part_invoiced") && (
        <button type="button" className="sw-btn sw-btn-sm" onClick={onSelect}>Invoice</button>
      )}
      {["draft", "sent", "accepted"].includes(order.status) && (
        <button
          type="button" className="sw-btn sw-btn-sm" {...guard}
          onClick={async () => {
            const reason = await ask({
              title: `Why is ${order.number} being withdrawn?`,
              detail:
                "Cancelling stops the document going any further. Anything already invoiced from it stays " +
                "invoiced — the invoice is its own document and the customer is holding it.",
              reason: {
                label: "Reason",
                placeholder: "Customer withdrew the order",
                hint: "Whoever finds this document later has only what is written here.",
              },
              confirmLabel: "Cancel the document",
              destructive: true,
            });
            if (reason === null) return;
            const r = await act<{ order: { number: string } }>(`${order.id}:cancel`, { action: "cancel", orderId: order.id, reason });
            if (r) onDone(`${r.order.number} cancelled.`);
          }}
        >
          Cancel
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- the detail --- */

function DetailPanel({ open, busy, act, onDone }: {
  open: Detail;
  busy: boolean;
  act: <T,>(key: string, body: Record<string, unknown>) => Promise<T | null>;
  onDone: (m: string) => void;
}) {
  const billable = open.kind === "ORDER" && (open.status === "accepted" || open.status === "part_invoiced");
  return (
    <Panel className="mt-4 overflow-hidden">
      <div
        className="border-b px-3 py-2 flex flex-wrap items-center justify-between gap-2"
        style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}
      >
        <span className="sw-label">
          {open.number} — {open.customerName}
          {open.customerTrn && <span className="sw-sub"> · TRN {open.customerTrn}</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className="sw-chip">{open.kind === "QUOTE" ? "quote" : "order"}</span>
          <StatusChip status={open.status} />
        </span>
      </div>

      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">
            The lines of {open.number}: what was quoted, what has been invoiced and what is left
          </caption>
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>#</th>
              <th>Description</th>
              <th style={{ width: "7rem" }}>SKU</th>
              <th className="sw-num" style={{ width: "5.5rem" }}>Quantity</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit price</th>
              <th className="sw-num" style={{ width: "5rem" }}>Discount</th>
              <th style={{ width: "7rem" }}>Tax</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
              <th className="sw-num" style={{ width: "5.5rem" }}>Invoiced</th>
              <th className="sw-num" style={{ width: "5.5rem" }}>Left</th>
            </tr>
          </thead>
          <tbody>
            {open.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.lineNo}</td>
                <td className="max-w-0 truncate">{l.description}</td>
                <td className="sw-code">{l.sku ?? <span className="sw-zero">–</span>}</td>
                <td className="sw-num">{fromMilli(l.quantityMilli)}</td>
                <td className="sw-num"><Figure minor={l.unitPriceMinor} currency={open.currency} colour={false} /></td>
                <td className="sw-num">{l.discountBps === 0 ? <span className="sw-zero">–</span> : pct(l.discountBps)}</td>
                <td className="sw-code">{l.taxCode} <span className="sw-sub">{l.ratePercent}%</span></td>
                <td className="sw-num"><Figure minor={l.netMinor} currency={open.currency} colour={false} /></td>
                <td className="sw-num">{fromMilli(l.invoicedMilli)}</td>
                <td className="sw-num">{fromMilli(l.remainingMilli)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={7} style={{ textAlign: "end" }}>Net of discount</th>
              <td className="sw-num" data-testid="detail-net"><Figure minor={open.totals.netMinor} zero="zero" colour={false} /></td>
              <td className="sw-num" colSpan={2} />
            </tr>
            {open.totals.taxes.map((t) => (
              <tr key={t.taxCode}>
                <th scope="row" colSpan={7} style={{ textAlign: "end", fontWeight: 400 }}>
                  {t.label} on <Figure minor={t.netMinor} currency={open.currency} zero="zero" colour={false} />
                </th>
                <td className="sw-num"><Figure minor={t.vatMinor} currency={open.currency} zero="zero" colour={false} /></td>
                <td className="sw-num" colSpan={2} />
              </tr>
            ))}
            <tr>
              <th scope="row" colSpan={7} style={{ textAlign: "end" }}>Gross</th>
              <td className="sw-num" data-testid="detail-gross"><Figure minor={open.totals.grossMinor} zero="zero" colour={false} /></td>
              <td className="sw-num" colSpan={2} />
            </tr>
            <tr>
              <th scope="row" colSpan={7} style={{ textAlign: "end", fontWeight: 400 }}>Still to invoice, net</th>
              <td className="sw-num" data-testid="detail-remaining"><Figure minor={open.remaining.netMinor} zero="zero" colour={false} /></td>
              <td className="sw-num" colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>

      {open.notes && (
        <p className="sw-sub p-3" style={{ borderTop: "1px solid var(--sw-line)", whiteSpace: "pre-line" }}>{open.notes}</p>
      )}

      <div className="p-4" style={{ borderTop: "1px solid var(--sw-line)" }}>
        {billable
          ? <InvoiceForm order={open} busy={busy} act={act} onDone={onDone} />
          : (
            <p className="sw-sub max-w-[78ch]">
              {open.kind === "QUOTE"
                ? "A quotation is not invoiced. Once the customer accepts it, convert it into an order — the quotation then stays exactly as they agreed it, and the order carries the lines forward."
                : `Nothing can be invoiced against ${open.number} while it is ${open.status.replace(/_/g, " ")}.`}
            </p>
          )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------- invoicing --- */

function InvoiceForm({ order, busy, act, onDone }: {
  order: Detail;
  busy: boolean;
  act: <T,>(key: string, body: Record<string, unknown>) => Promise<T | null>;
  onDone: (m: string) => void;
}) {
  const outstanding = order.lines.filter((l) => BigInt(l.remainingMilli) > 0n);
  const [qtys, setQtys] = React.useState<Record<string, string>>({});

  const keyed = outstanding
    .map((l) => ({ line: l, qty: toMilli(qtys[l.id] ?? "") }))
    .filter((r) => r.qty !== null && r.qty > 0n);

  const over = outstanding.find((l) => {
    const q = toMilli(qtys[l.id] ?? "");
    return q !== null && q > BigInt(l.remainingMilli);
  });

  const blocker =
    over ? `Line ${over.lineNo} only has ${fromMilli(over.remainingMilli)} left to invoice.` :
    keyed.length === 0 ? "How much is being invoiced? Fill in at least one line, or invoice everything outstanding." :
    null;

  const send = async (lines?: { orderLineId: string; quantityMilli: string }[]) => {
    const r = await act<InvoiceResult>("invoice", { action: "invoice", orderId: order.id, invoiceLines: lines });
    if (!r) return;
    setQtys({});
    onDone(
      `${r.number} is now ${r.status.replace(/_/g, " ")}. ` +
        `This instalment is ${r.lines.map((l) => `${fromMilli(l.invoicedNowMilli)} of line ${l.lineNo}`).join(", ")}. ` +
        `Nothing has been posted — raise the tax invoice itself in receivables.`,
    );
  };

  return (
    <>
      <p className="sw-sub max-w-[80ch]">
        Recording what has been billed, not billing it. The entry for the sale is made when the tax invoice is
        raised in receivables; what is kept here is quantity, so this order can say what is left and cannot be
        billed for the same goods twice.
      </p>

      <div className="sw-scroll mt-3">
        <table className="sw-table sw-grid">
          <caption className="sr-only">How much of each outstanding line is being invoiced</caption>
          <thead>
            <tr>
              <th style={{ width: "3rem" }}>#</th>
              <th>Description</th>
              <th className="sw-num" style={{ width: "6rem" }}>Left</th>
              <th className="sw-num" style={{ width: "8rem" }}>Invoicing</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
            </tr>
          </thead>
          <tbody>
            {outstanding.map((l) => {
              const q = toMilli(qtys[l.id] ?? "");
              const bad = q !== null && q > BigInt(l.remainingMilli);
              const net = q !== null && q > 0n && !bad
                ? (BigInt(l.remainingNetMinor) * q) / BigInt(l.remainingMilli)
                : 0n;
              return (
                <tr key={l.id}>
                  <td style={{ padding: "0 0.625rem" }}>{l.lineNo}</td>
                  <td className="max-w-0 truncate" style={{ padding: "0 0.625rem" }}>{l.description}</td>
                  <td className="sw-num" style={{ padding: "0 0.625rem" }}>{fromMilli(l.remainingMilli)}</td>
                  <td>
                    <input
                      className={`sw-cell sw-cell-num ${bad ? "sw-cell-invalid" : ""}`}
                      inputMode="decimal"
                      value={qtys[l.id] ?? ""}
                      aria-label={`Quantity of line ${l.lineNo}, ${l.description}, to invoice — ${fromMilli(l.remainingMilli)} left`}
                      aria-invalid={bad || undefined}
                      onChange={(e) => setQtys((x) => ({ ...x, [l.id]: e.target.value }))}
                      placeholder={fromMilli(l.remainingMilli)}
                    />
                  </td>
                  <td className="sw-num" style={{ padding: "0 0.625rem" }}>
                    <Figure minor={net} currency={order.currency} colour={false} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="invoice-submit"
          onClick={() => {
            if (blocker) return;
            void send(keyed.map((r) => ({ orderLineId: r.line.id, quantityMilli: (r.qty as bigint).toString() })));
          }}
        >
          {busy ? "Working…" : "Record what has been invoiced"}
        </button>
        <button
          type="button"
          className="sw-btn"
          disabled={busy}
          aria-disabled={busy || undefined}
          onClick={() => void send(undefined)}
          data-testid="invoice-all"
        >
          Invoice everything outstanding
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="invoice-blocker">{blocker}</span>}
      </div>
    </>
  );
}

/* ---------------------------------------------------------- the new one --- */

function NewDocument({ busy, onCreate }: {
  busy: boolean;
  onCreate: (order: Record<string, unknown>) => void;
}) {
  const [f, setF] = React.useState({
    kind: "QUOTE" as "QUOTE" | "ORDER",
    number: "", customerName: "", customerCode: "", customerTrn: "",
    issuedOn: today(), validUntil: "",
    description: "", sku: "", qty: "", price: "", discount: "", taxCode: "STANDARD_5", account: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const qty = toMilli(f.qty);
  const price = parseAmount(f.price);
  const discount = toBps(f.discount);

  const blocker =
    !f.customerName.trim() ? "Who is it for?" :
    !f.description.trim() ? "What is being offered?" :
    qty === null || qty <= 0n ? "How many? Up to three decimal places." :
    price === null || price < 0n ? "What is the unit price?" :
    discount === null || discount > 10_000 ? "A discount runs from nothing to the whole of the line." :
    f.validUntil && f.validUntil < f.issuedOn ? "It cannot stop being valid before it is issued." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">A new quotation or order, with its first line</div>
      <p className="sw-sub mt-1 max-w-[74ch]">
        It starts as a draft, and raising it posts nothing. Leave the number blank and it takes the next in this
        entity&rsquo;s own sequence — quotations and orders are numbered separately, so no two documents share a number.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Document">
          <select className="sw-select" value={f.kind} onChange={(e) => set("kind", e.target.value)}>
            <option value="QUOTE">Quotation</option>
            <option value="ORDER">Sales order</option>
          </select>
        </Field>
        <Field label="Number (optional)">
          <input className="sw-input" value={f.number} onChange={(e) => set("number", e.target.value)} placeholder="next in sequence" />
        </Field>
        <Field label="Customer"><input className="sw-input" value={f.customerName} onChange={(e) => set("customerName", e.target.value)} placeholder="Marri Trading LLC" /></Field>
        <Field label="Customer code"><input className="sw-input" value={f.customerCode} onChange={(e) => set("customerCode", e.target.value)} placeholder="MARRI" /></Field>
        <Field label="Customer TRN"><input className="sw-input" value={f.customerTrn} onChange={(e) => set("customerTrn", e.target.value)} placeholder="100123456789003" /></Field>
        <Field label="Issued on"><input type="date" className="sw-input" value={f.issuedOn} onChange={(e) => set("issuedOn", e.target.value)} /></Field>
        <Field label="Valid until"><input type="date" className="sw-input" value={f.validUntil} onChange={(e) => set("validUntil", e.target.value)} /></Field>
        <Field label="Description"><input className="sw-input" value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Site survey" /></Field>
        <Field label="SKU"><input className="sw-input" value={f.sku} onChange={(e) => set("sku", e.target.value)} placeholder="SURVEY" /></Field>
        <Field label="Quantity"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.qty} onChange={(e) => set("qty", e.target.value)} placeholder="10" /></Field>
        <Field label="Unit price"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.price} onChange={(e) => set("price", e.target.value)} placeholder="1,250.00" /></Field>
        <Field label="Discount %"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.discount} onChange={(e) => set("discount", e.target.value)} placeholder="10" /></Field>
        <Field label="Tax treatment">
          <select className="sw-select" value={f.taxCode} onChange={(e) => set("taxCode", e.target.value)}>
            {TAX_PROFILE_LIST.map((p) => (
              <option key={p.code} value={p.code}>{p.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Revenue account"><input className="sw-input" value={f.account} onChange={(e) => set("account", e.target.value)} placeholder="4000" /></Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          disabled={blocker !== null || busy}
          aria-disabled={blocker !== null || busy || undefined}
          data-testid="quote-submit"
          onClick={() => {
            if (blocker) return;
            onCreate({
              number: f.number.trim() || undefined,
              kind: f.kind,
              customerName: f.customerName.trim(),
              customerCode: f.customerCode.trim() || undefined,
              customerTrn: f.customerTrn.trim() || undefined,
              issuedOn: f.issuedOn,
              validUntil: f.validUntil || undefined,
              lines: [{
                description: f.description.trim(),
                sku: f.sku.trim() || undefined,
                quantityMilli: (qty as bigint).toString(),
                unitPriceMinor: (price as bigint).toString(),
                discountBps: discount as number,
                taxCode: f.taxCode,
                accountCode: f.account.trim() || undefined,
              }],
            });
          }}
        >
          {busy ? "Working…" : "Raise it"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="quote-blocker">{blocker}</span>}
        {!blocker && <span className="sw-sub">Nothing will be posted. An offer is not a transaction.</span>}
      </div>
    </Panel>
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
