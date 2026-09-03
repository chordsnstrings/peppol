"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { parseAmount } from "@/lib/ledger/format";

interface Item {
  sku: string; name: string; uom: string; status: string;
  quantityMilli: string; quantity: string; valueMinor: string; unitCostMinor: string;
}
interface Valuation {
  items: Item[];
  totals: { valueMinor: string };
  ledger: { valueMinor: string; agrees: boolean };
}
interface Movement {
  id: string; movedOn: string; kind: string; quantity: string;
  valueMinor: string; unitCostMinor: string; balanceQuantity: string;
  balanceValueMinor: string; memo: string | null; entryId: string | null;
}

/** Quantities are thousandths. "1.5" is 1500, and a float would lose the edge cases. */
function toMilli(text: string): bigint | null {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * 1000n + BigInt(frac.padEnd(3, "0"));
}

export default function InventoryPage() {
  const entityId = useEntityId();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const q = useLedgerQuery<Valuation>(entityId ? `/api/ledger/inventory?entityId=${entityId}` : null);
  const history = useLedgerQuery<{ item: { sku: string; name: string; uom: string }; movements: Movement[] }>(
    entityId && selected ? `/api/ledger/inventory?entityId=${entityId}&sku=${encodeURIComponent(selected)}` : null,
    [selected],
  );

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/inventory", {
        method: "POST", body: JSON.stringify({ entityId, ...body }),
      });
      q.reload();
      if (selected) history.reload();
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
        title="Inventory"
        sub="Stock at weighted average cost, with the ledger account it has to agree with. Every movement that changes value posts at the same time — an inventory system whose numbers never reach account 1200 is a spreadsheet."
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="inventory-result">{msg}</div>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !q.data && <Loading />}

      <MoveStock
        items={q.data?.items ?? []}
        busy={busy}
        onAct={async (label, body, describe) => {
          const r = await act(label, body);
          if (r) setMsg(describe(r));
        }}
      />

      {q.data && (
        <>
          <Panel className="mb-4 p-4">
            <div className="sw-label">Valuation against the ledger</div>
            <table className="sw-table mt-3" style={{ maxWidth: "38rem" }}>
              <caption className="sr-only">Stock on hand against account 1200 in the ledger</caption>
              <tbody>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>Stock on hand, per the item list</th>
                  <td className="sw-num" data-testid="stock-register">
                    <Figure minor={q.data.totals.valueMinor} zero="zero" colour={false} />
                  </td>
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                    <Link href="/accounting/accounts/1200" className="sw-link">Account 1200</Link>, per the ledger
                  </th>
                  <td className="sw-num" data-testid="stock-ledger">
                    <Figure minor={q.data.ledger.valueMinor} zero="zero" colour={false} />
                  </td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" style={{ textAlign: "start" }}>
                    <span className={`sw-chip ${q.data.ledger.agrees ? "sw-chip-ok" : "sw-chip-bad"}`}>
                      {q.data.ledger.agrees ? "agrees" : "differs"}
                    </span>
                  </th>
                  <td className="sw-num">
                    {!q.data.ledger.agrees && (
                      <Figure minor={(BigInt(q.data.totals.valueMinor) - BigInt(q.data.ledger.valueMinor)).toString()} zero="zero" />
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
            {!q.data.ledger.agrees && (
              <p className="sw-sub mt-2" style={{ color: "var(--sw-warn)" }}>
                Stock received on a supplier bill is already debited to 1200 by that bill, so a difference here
                usually means a receipt was recorded on both sides. Check the movements before adjusting anything.
              </p>
            )}
          </Panel>

          {q.data.items.length === 0 ? (
            <Empty>No items yet. Add one above, then receive stock against it.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Stock valuation</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "8rem" }}>SKU</th>
                      <th>Item</th>
                      <th className="sw-num" style={{ width: "7rem" }}>On hand</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit cost</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.items.map((i) => (
                      <tr key={i.sku}>
                        <td className="sw-code">
                          <button
                            type="button"
                            className="sw-link sw-link-btn"
                            onClick={() => setSelected(selected === i.sku ? null : i.sku)}
                            aria-expanded={selected === i.sku}
                          >
                            {i.sku}
                          </button>
                        </td>
                        <td className="max-w-0 truncate">{i.name}</td>
                        <td className="sw-num">
                          {i.quantity} <span style={{ color: "var(--sw-fg-muted)" }}>{i.uom}</span>
                        </td>
                        <td className="sw-num"><Figure minor={i.unitCostMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={i.valueMinor} colour={false} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={4} style={{ textAlign: "end" }}>Total stock on hand</th>
                      <td className="sw-num"><Figure minor={q.data.totals.valueMinor} zero="zero" colour={false} /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}

      {selected && history.data && (
        <Panel className="mt-4 overflow-hidden">
          <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
            <span className="sw-label">
              {history.data.item.sku} — how the valuation got here
            </span>
          </div>
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Every movement behind {history.data.item.sku}, oldest first</caption>
              <thead>
                <tr>
                  <th style={{ width: "7rem" }}>Date</th>
                  <th style={{ width: "7rem" }}>Movement</th>
                  <th>Note</th>
                  <th className="sw-num" style={{ width: "6rem" }}>Quantity</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Value</th>
                  <th className="sw-num" style={{ width: "6rem" }}>On hand</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit cost after</th>
                </tr>
              </thead>
              <tbody>
                {history.data.movements.map((m) => (
                  <tr key={m.id}>
                    <td>{m.movedOn}</td>
                    <td style={{ color: "var(--sw-fg-muted)" }}>{m.kind.toLowerCase().replace("_", " ")}</td>
                    <td className="max-w-0 truncate">{m.memo ?? <span className="sw-zero">–</span>}</td>
                    <td className="sw-num">{m.quantity}</td>
                    <td className="sw-num"><Figure minor={m.valueMinor} /></td>
                    <td className="sw-num">{m.balanceQuantity}</td>
                    <td className="sw-num"><Figure minor={m.unitCostMinor} colour={false} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}

function MoveStock({ items, busy, onAct }: {
  items: Item[];
  busy: string | null;
  onAct: (label: string, body: Record<string, unknown>, describe: (r: Record<string, unknown>) => string) => void;
}) {
  const [tab, setTab] = React.useState<"receive" | "issue" | "count" | "add">("receive");
  const [f, setF] = React.useState({
    sku: "", name: "", uom: "EA",
    movedOn: new Date().toISOString().slice(0, 10),
    qty: "", cost: "", counted: "", memo: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const qty = toMilli(f.qty);
  const counted = toMilli(f.counted);
  const cost = parseAmount(f.cost);

  const blocker =
    tab === "add"
      ? !f.sku.trim() ? "Give the item a SKU." : !f.name.trim() ? "Give the item a name." : null
      : !f.sku ? "Choose an item." :
        tab === "count"
          ? counted === null ? "How many were counted? Up to three decimal places." : null
          : qty === null || qty <= 0n ? "How many? Up to three decimal places." :
            tab === "receive" && (cost === null || cost < 0n) ? "What did the whole receipt cost?" : null;

  const submit = () => {
    if (blocker) return;
    if (tab === "add") {
      onAct("add", { action: "add", sku: f.sku.trim(), name: f.name.trim(), uom: f.uom },
        () => `Added ${f.sku.trim()} to the item list.`);
      return;
    }
    if (tab === "receive") {
      onAct("receive", {
        action: "receive", sku: f.sku, movedOn: f.movedOn,
        quantityMilli: (qty as bigint).toString(), valueMinor: (cost as bigint).toString(), memo: f.memo || undefined,
      }, (r) => `Received ${f.qty}. Now holding ${Number(r.balanceQtyMilli) / 1000} at an average unit cost.`);
      return;
    }
    if (tab === "issue") {
      onAct("issue", {
        action: "issue", sku: f.sku, movedOn: f.movedOn,
        quantityMilli: (qty as bigint).toString(), memo: f.memo || undefined,
      }, (r) => `Issued ${f.qty}, costing ${(-Number(r.valueMinor) / 100).toFixed(2)} at the weighted average.`);
      return;
    }
    onAct("count", {
      action: "count", sku: f.sku, movedOn: f.movedOn,
      countedMilli: (counted as bigint).toString(), memo: f.memo || undefined,
    }, (r) => `Adjusted to ${f.counted}. The difference of ${Number(r.quantityMilli) / 1000} was booked to stock variance.`);
  };

  const TABS = [
    { key: "receive", label: "Receive" },
    { key: "issue", label: "Issue" },
    { key: "count", label: "Stock count" },
    { key: "add", label: "New item" },
  ] as const;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-tabs" style={{ marginTop: "-0.25rem" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className="sw-tab"
            aria-current={tab === t.key ? "page" : undefined}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tab === "add" ? (
          <>
            <Field label="SKU"><input className="sw-input" value={f.sku} onChange={(e) => set("sku", e.target.value)} placeholder="WIDGET-01" /></Field>
            <Field label="Name"><input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)} /></Field>
            <Field label="Unit">
              <select className="sw-select" value={f.uom} onChange={(e) => set("uom", e.target.value)}>
                {["EA", "KG", "M", "L", "BOX", "HR"].map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
          </>
        ) : (
          <>
            <Field label="Item">
              <select className="sw-select" value={f.sku} onChange={(e) => set("sku", e.target.value)} aria-label="Item">
                <option value="">Choose…</option>
                {items.map((i) => <option key={i.sku} value={i.sku}>{i.sku} — {i.name}</option>)}
              </select>
            </Field>
            <Field label="Date"><input type="date" className="sw-input" value={f.movedOn} onChange={(e) => set("movedOn", e.target.value)} /></Field>
            {tab === "count" ? (
              <Field label="Counted"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.counted} onChange={(e) => set("counted", e.target.value)} placeholder="148" /></Field>
            ) : (
              <Field label="Quantity"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.qty} onChange={(e) => set("qty", e.target.value)} placeholder="100" /></Field>
            )}
            {tab === "receive" && (
              <Field label="Total cost"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.cost} onChange={(e) => set("cost", e.target.value)} placeholder="5,000.00" /></Field>
            )}
            {tab !== "receive" && (
              <Field label="Note"><input className="sw-input" value={f.memo} onChange={(e) => set("memo", e.target.value)} placeholder={tab === "count" ? "Quarterly count" : "Sold to customer"} /></Field>
            )}
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          onClick={submit}
          aria-disabled={blocker !== null || busy !== null || undefined}
          disabled={blocker !== null || busy !== null}
          data-testid="inventory-submit"
        >
          {busy ? "Working…" : tab === "add" ? "Add item" : tab === "receive" ? "Receive" : tab === "issue" ? "Issue" : "Adjust to count"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="inventory-blocker">{blocker}</span>}
        {tab === "issue" && !blocker && (
          <span className="sw-sub">Issued at the weighted average cost, not at what it sold for.</span>
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
