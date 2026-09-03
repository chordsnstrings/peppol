"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { parseAmount } from "@/lib/ledger/format";

interface Item {
  sku: string; name: string; uom: string; status: string; costMethod: string;
  quantityMilli: string; quantity: string;
  costMinor: string; unitCostMinor: string;
  /** Nil means nobody has assessed it — a different fact from an assessment of nothing. */
  nrvMinor: string | null;
  nrvTotalMinor: string | null;
  writeDownMinor: string; carryingMinor: string; valueMinor: string;
  /** Nil where the valuation is drawn at a past date: what is left of a layer is today's figure. */
  openLayers: number | null;
}
interface Valuation {
  asOf: string | null;
  items: Item[];
  totals: { costMinor: string; writeDownMinor: string; carryingMinor: string; valueMinor: string };
  ledger: { valueMinor: string; differenceMinor: string; agrees: boolean };
}
interface Movement {
  id: string; movedOn: string; kind: string; quantity: string;
  valueMinor: string; unitCostMinor: string; balanceQuantity: string;
  balanceValueMinor: string; reference: string | null; memo: string | null; entryId: string | null;
}
interface Layer {
  seq: number; receivedOn: string; quantity: string; remaining: string;
  remainingMilli: string; unitCostMinor: string; remainingValueMinor: string; exhausted: boolean;
}
interface Assessment {
  entryId: string; on: string; reference: string; kind: string; memo: string | null; valueMinor: string;
}
interface History {
  item: {
    sku: string; name: string; uom: string; costMethod: string; quantity: string;
    costMinor: string; nrvMinor: string | null; nrvTotalMinor: string | null;
    writeDownMinor: string; carryingMinor: string;
  };
  layers: Layer[];
  assessments: Assessment[];
  movements: Movement[];
}

const isFifo = (m: string) => m === "FIFO";
const methodLabel = (m: string) => (isFifo(m) ? "FIFO" : "average");

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
  const history = useLedgerQuery<History>(
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

  const heldTotal = q.data ? BigInt(q.data.totals.writeDownMinor) : 0n;

  return (
    <>
      <PageHead
        title="Inventory"
        sub="Stock at weighted average cost or first-in-first-out, carried at the lower of cost and net realisable value, with the ledger account it has to agree with. Every movement that changes value posts at the same time — an inventory system whose numbers never reach account 1200 is a spreadsheet."
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
              <caption className="sr-only">
                Stock on hand at cost, the write-down held against it, and the carrying amount against account 1200
              </caption>
              <tbody>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>Stock on hand, at cost</th>
                  <td className="sw-num" data-testid="stock-cost">
                    <Figure minor={q.data.totals.costMinor} zero="zero" colour={false} />
                  </td>
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                    Written down to net realisable value{" "}
                    <span className="sw-sub">(IAS 2.9)</span>
                  </th>
                  <td className="sw-num" data-testid="stock-writedown">
                    <Figure minor={heldTotal === 0n ? "0" : (-heldTotal).toString()} zero="dash" />
                  </td>
                </tr>
                <tr>
                  <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>Carrying amount, per the item list</th>
                  <td className="sw-num" data-testid="stock-register">
                    <Figure minor={q.data.totals.carryingMinor} zero="zero" colour={false} />
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
                  <td className="sw-num" data-testid="stock-difference">
                    {q.data.ledger.agrees
                      ? <span className="sw-zero">–</span>
                      : <Figure minor={q.data.ledger.differenceMinor} zero="zero" />}
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
                  <caption className="sr-only">
                    Stock valuation: cost, net realisable value where it has been assessed, and the lower of the two
                  </caption>
                  <thead>
                    <tr>
                      <th style={{ width: "8rem" }}>SKU</th>
                      <th>Item</th>
                      <th style={{ width: "6rem" }}>Costed on</th>
                      <th className="sw-num" style={{ width: "7rem" }}>On hand</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit cost</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net realisable</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Write-down</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Carrying amount</th>
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
                        <td>
                          <span className={`sw-chip ${isFifo(i.costMethod) ? "sw-chip-accent" : ""}`}>
                            {methodLabel(i.costMethod)}
                          </span>
                          {isFifo(i.costMethod) && (i.openLayers ?? 0) > 0 && (
                            <span className="sw-sub" style={{ marginInlineStart: "0.4rem" }}>
                              {i.openLayers} layer{i.openLayers === 1 ? "" : "s"}
                            </span>
                          )}
                        </td>
                        <td className="sw-num">
                          {i.quantity} <span style={{ color: "var(--sw-fg-muted)" }}>{i.uom}</span>
                        </td>
                        <td className="sw-num"><Figure minor={i.unitCostMinor} colour={false} /></td>
                        <td className="sw-num"><Figure minor={i.costMinor} colour={false} /></td>
                        <td className="sw-num">
                          {/* Never assessed and assessed at nothing are different
                              facts, so they read differently. */}
                          {i.nrvTotalMinor === null
                            ? <span className="sw-zero" title="Not assessed">not assessed</span>
                            : <Figure minor={i.nrvTotalMinor} zero="zero" colour={false} />}
                        </td>
                        <td className="sw-num">
                          <Figure minor={i.writeDownMinor === "0" ? "0" : `-${i.writeDownMinor}`} zero="dash" />
                        </td>
                        <td className="sw-num"><Figure minor={i.carryingMinor} zero="zero" colour={false} /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row" colSpan={5} style={{ textAlign: "end" }}>Total</th>
                      <td className="sw-num"><Figure minor={q.data.totals.costMinor} zero="zero" colour={false} /></td>
                      <td className="sw-num"><span className="sw-zero">–</span></td>
                      <td className="sw-num">
                        <Figure minor={heldTotal === 0n ? "0" : (-heldTotal).toString()} zero="dash" />
                      </td>
                      <td className="sw-num"><Figure minor={q.data.totals.carryingMinor} zero="zero" colour={false} /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>
          )}
        </>
      )}

      {selected && history.data && (
        <ItemRecord data={history.data} />
      )}
    </>
  );
}

/**
 * What one item is made of: its layers where it is costed first-in-first-out,
 * the assessments that wrote it down, and every movement behind the valuation.
 *
 * The layers are shown rather than summarised because they are the record — a
 * FIFO cost of sale that nobody can check against the receipts it came from is
 * an assertion, not a figure.
 */
function ItemRecord({ data }: { data: History }) {
  const { item } = data;
  return (
    <>
      {isFifo(item.costMethod) && (
        <Panel className="mt-4 overflow-hidden">
          <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
            <span className="sw-label">{item.sku} — cost layers, oldest first</span>
          </div>
          {data.layers.length === 0 ? (
            <div className="p-3"><Empty>No receipts yet, so there are no layers to draw from.</Empty></div>
          ) : (
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">
                  Every receipt behind {item.sku}, in the order the goods arrived, with what is left of each
                </caption>
                <thead>
                  <tr>
                    <th style={{ width: "4rem" }}>Layer</th>
                    <th style={{ width: "8rem" }}>Received</th>
                    <th className="sw-num" style={{ width: "7rem" }}>Received</th>
                    <th className="sw-num" style={{ width: "7rem" }}>Left</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit cost</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Value left</th>
                    <th style={{ width: "7rem" }}>State</th>
                  </tr>
                </thead>
                <tbody>
                  {data.layers.map((l) => (
                    <tr key={l.seq}>
                      <td className="sw-code">{l.seq}</td>
                      <td>{l.receivedOn}</td>
                      <td className="sw-num">{l.quantity}</td>
                      <td className="sw-num">{l.remaining}</td>
                      <td className="sw-num"><Figure minor={l.unitCostMinor} colour={false} /></td>
                      <td className="sw-num"><Figure minor={l.remainingValueMinor} zero="zero" colour={false} /></td>
                      <td>
                        <span className={`sw-chip ${l.exhausted ? "" : "sw-chip-ok"}`}>
                          {l.exhausted ? "used up" : "open"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={5} style={{ textAlign: "end" }}>Cost of stock on hand</th>
                    <td className="sw-num"><Figure minor={item.costMinor} zero="zero" colour={false} /></td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Panel>
      )}

      <Panel className="mt-4 overflow-hidden">
        <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
          <span className="sw-label">{item.sku} — net realisable value</span>
        </div>
        <div className="p-3">
          <p className="sw-sub mb-3 max-w-[62ch]">
            {item.nrvMinor === null
              ? "Nobody has assessed this item. It stands at cost, which is not the same as having been looked at and found sound (IAS 2.9)."
              : `Assessed at ${" "}`}
            {item.nrvMinor !== null && (
              <>
                <Figure minor={item.nrvMinor} zero="zero" colour={false} /> a {item.uom.toLowerCase()}
                {item.writeDownMinor === "0"
                  ? " — above cost, so nothing is written down. IAS 2.9 is a ceiling, never a revaluation upwards."
                  : " — below cost, so the difference is held against the stock and reversed if it recovers (IAS 2.33), never above cost."}
              </>
            )}
          </p>
          <table className="sw-table" style={{ maxWidth: "34rem" }}>
            <caption className="sr-only">Cost, net realisable value and carrying amount for {item.sku}</caption>
            <tbody>
              <tr>
                <th scope="row" style={{ fontWeight: 400 }}>Cost of {item.quantity} {item.uom}</th>
                <td className="sw-num"><Figure minor={item.costMinor} zero="zero" colour={false} /></td>
              </tr>
              <tr>
                <th scope="row" style={{ fontWeight: 400 }}>Net realisable value</th>
                <td className="sw-num">
                  {item.nrvTotalMinor === null
                    ? <span className="sw-zero">not assessed</span>
                    : <Figure minor={item.nrvTotalMinor} zero="zero" colour={false} />}
                </td>
              </tr>
              <tr>
                <th scope="row" style={{ fontWeight: 400 }}>Write-down held</th>
                <td className="sw-num">
                  <Figure minor={item.writeDownMinor === "0" ? "0" : `-${item.writeDownMinor}`} zero="dash" />
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Carrying amount</th>
                <td className="sw-num"><Figure minor={item.carryingMinor} zero="zero" colour={false} /></td>
              </tr>
            </tfoot>
          </table>

          {data.assessments.length > 0 && (
            <div className="sw-scroll mt-3">
              <table className="sw-table">
                <caption className="sr-only">Every write-down and reversal posted against {item.sku}</caption>
                <thead>
                  <tr>
                    <th style={{ width: "7rem" }}>Date</th>
                    <th style={{ width: "9rem" }}>Entry</th>
                    <th>Note</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Effect on stock</th>
                  </tr>
                </thead>
                <tbody>
                  {data.assessments.map((a) => (
                    <tr key={a.entryId}>
                      <td>{a.on}</td>
                      <td className="sw-code">
                        <Link href={`/accounting/journals/${a.entryId}`} className="sw-link sw-link-btn">{a.reference}</Link>
                      </td>
                      <td className="max-w-0 truncate">{a.memo ?? <span className="sw-zero">–</span>}</td>
                      <td className="sw-num"><Figure minor={a.valueMinor} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>

      <Panel className="mt-4 overflow-hidden">
        <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
          <span className="sw-label">{item.sku} — how the valuation got here</span>
        </div>
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">Every movement behind {item.sku}, oldest first</caption>
            <thead>
              <tr>
                <th style={{ width: "7rem" }}>Date</th>
                <th style={{ width: "7rem" }}>Movement</th>
                <th style={{ width: "8rem" }}>Reference</th>
                <th>Note</th>
                <th className="sw-num" style={{ width: "6rem" }}>Quantity</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Value</th>
                <th className="sw-num" style={{ width: "6rem" }}>On hand</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
                  {isFifo(item.costMethod) ? "Unit cost borne" : "Unit cost after"}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.movements.map((m) => (
                <tr key={m.id}>
                  <td>{m.movedOn}</td>
                  <td style={{ color: "var(--sw-fg-muted)" }}>{m.kind.toLowerCase().replace("_", " ")}</td>
                  <td className="sw-code">{m.reference ?? <span className="sw-zero">–</span>}</td>
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
        {isFifo(item.costMethod) && (
          <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
            An issue spanning layers bore several prices at once, so the last column is the average it actually bore —
            not a price anybody paid.
          </p>
        )}
      </Panel>
    </>
  );
}

function MoveStock({ items, busy, onAct }: {
  items: Item[];
  busy: string | null;
  onAct: (label: string, body: Record<string, unknown>, describe: (r: Record<string, unknown>) => string) => void;
}) {
  const [tab, setTab] = React.useState<"receive" | "issue" | "count" | "value" | "add" | "method">("receive");
  const [f, setF] = React.useState({
    sku: "", name: "", uom: "EA", costMethod: "WEIGHTED_AVERAGE",
    movedOn: new Date().toISOString().slice(0, 10),
    qty: "", cost: "", counted: "", nrv: "", reference: "", memo: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const qty = toMilli(f.qty);
  const counted = toMilli(f.counted);
  const cost = parseAmount(f.cost);
  const nrv = parseAmount(f.nrv);
  const chosen = items.find((i) => i.sku === f.sku);

  const blocker =
    tab === "add"
      ? !f.sku.trim() ? "Give the item a SKU." : !f.name.trim() ? "Give the item a name." : null
      : !f.sku ? "Choose an item." :
        tab === "method"
          ? chosen && chosen.costMethod === f.costMethod ? `${f.sku} is already costed that way.` : null
          : tab === "value"
            ? f.nrv.trim() === "" ? "What is it worth, per unit? Nothing assessed is not the same as assessed at nothing." :
              nrv === null || nrv < 0n ? "Net realisable value cannot be negative." : null
            : tab === "count"
              ? counted === null ? "How many were counted? Up to three decimal places." : null
              : qty === null || qty <= 0n ? "How many? Up to three decimal places." :
                tab === "receive" && (cost === null || cost < 0n) ? "What did the whole receipt cost?" : null;

  const submit = () => {
    if (blocker) return;
    const ref = f.reference.trim() || undefined;
    if (tab === "add") {
      onAct("add", { action: "add", sku: f.sku.trim(), name: f.name.trim(), uom: f.uom, costMethod: f.costMethod },
        () => `Added ${f.sku.trim()} to the item list, costed on ${methodLabel(f.costMethod)}.`);
      return;
    }
    if (tab === "method") {
      onAct("method", { action: "method", sku: f.sku, costMethod: f.costMethod },
        () => `${f.sku} is now costed on ${methodLabel(f.costMethod)}.`);
      return;
    }
    if (tab === "value") {
      onAct("nrv", {
        action: "nrv", sku: f.sku, movedOn: f.movedOn, nrvMinor: (nrv as bigint).toString(), memo: f.memo || undefined,
      }, (r) => String(r.writeDownMinor) === "0"
        ? `${f.sku} is worth more than it cost, so nothing was written down. It stays at ${fmtWire(r.costMinor)}.`
        : `${f.sku} written down to ${fmtWire(r.carryingMinor)}, with ${fmtWire(r.writeDownMinor)} held against cost.`);
      return;
    }
    if (tab === "receive") {
      onAct("receive", {
        action: "receive", sku: f.sku, movedOn: f.movedOn,
        quantityMilli: (qty as bigint).toString(), valueMinor: (cost as bigint).toString(),
        reference: ref, memo: f.memo || undefined,
      }, (r) => r.replayed
        ? `${f.reference} was already received against ${f.sku}. Nothing was recorded twice.`
        : `Received ${f.qty}. Now holding ${Number(r.balanceQtyMilli) / 1000}.`);
      return;
    }
    if (tab === "issue") {
      onAct("issue", {
        action: "issue", sku: f.sku, movedOn: f.movedOn,
        quantityMilli: (qty as bigint).toString(), reference: ref, memo: f.memo || undefined,
      }, (r) => r.replayed
        ? `${f.reference} was already issued against ${f.sku}. Nothing was recorded twice.`
        : `Issued ${f.qty}, costing ${fmtWire(String(-BigInt(String(r.valueMinor))))} at ${chosen && isFifo(chosen.costMethod) ? "the oldest layers first" : "the weighted average"}.`);
      return;
    }
    onAct("count", {
      action: "count", sku: f.sku, movedOn: f.movedOn,
      countedMilli: (counted as bigint).toString(), reference: ref, memo: f.memo || undefined,
    }, (r) => `Adjusted to ${f.counted}. The difference of ${Number(r.quantityMilli) / 1000} was booked to stock variance.`);
  };

  const TABS = [
    { key: "receive", label: "Receive" },
    { key: "issue", label: "Issue" },
    { key: "count", label: "Stock count" },
    { key: "value", label: "Net realisable value" },
    { key: "add", label: "New item" },
    { key: "method", label: "Cost method" },
  ] as const;

  const ACTION_LABEL: Record<typeof tab, string> = {
    receive: "Receive", issue: "Issue", count: "Adjust to count",
    value: "Record assessment", add: "Add item", method: "Change method",
  };

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
            <MethodField value={f.costMethod} onChange={(v) => set("costMethod", v)} />
          </>
        ) : (
          <>
            <Field label="Item">
              <select className="sw-select" value={f.sku} onChange={(e) => set("sku", e.target.value)} aria-label="Item">
                <option value="">Choose…</option>
                {items.map((i) => <option key={i.sku} value={i.sku}>{i.sku} — {i.name} ({methodLabel(i.costMethod)})</option>)}
              </select>
            </Field>
            {tab === "method" ? (
              <MethodField value={f.costMethod} onChange={(v) => set("costMethod", v)} />
            ) : (
              <Field label={tab === "value" ? "Assessed on" : "Date"}>
                <input type="date" className="sw-input" value={f.movedOn} onChange={(e) => set("movedOn", e.target.value)} />
              </Field>
            )}
            {tab === "count" && (
              <Field label="Counted"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.counted} onChange={(e) => set("counted", e.target.value)} placeholder="148" /></Field>
            )}
            {(tab === "receive" || tab === "issue") && (
              <Field label="Quantity"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.qty} onChange={(e) => set("qty", e.target.value)} placeholder="100" /></Field>
            )}
            {tab === "receive" && (
              <Field label="Total cost"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.cost} onChange={(e) => set("cost", e.target.value)} placeholder="5,000.00" /></Field>
            )}
            {tab === "value" && (
              <Field label={`Net realisable value, per ${chosen?.uom.toLowerCase() ?? "unit"}`}>
                <input className="sw-input sw-cell-num" inputMode="decimal" value={f.nrv} onChange={(e) => set("nrv", e.target.value)} placeholder="8.00" />
              </Field>
            )}
            {(tab === "receive" || tab === "issue" || tab === "count") && (
              <Field label="Reference">
                <input className="sw-input" value={f.reference} onChange={(e) => set("reference", e.target.value)}
                  placeholder={tab === "receive" ? "GRN-1001" : tab === "issue" ? "DN-2001" : "COUNT-Q2"} />
              </Field>
            )}
            {tab !== "receive" && tab !== "method" && (
              <Field label="Note">
                <input className="sw-input" value={f.memo} onChange={(e) => set("memo", e.target.value)}
                  placeholder={tab === "count" ? "Quarterly count" : tab === "value" ? "Slow-moving, marked down" : "Sold to customer"} />
              </Field>
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
          {busy ? "Working…" : ACTION_LABEL[tab]}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="inventory-blocker">{blocker}</span>}
        {!blocker && tab === "issue" && (
          <span className="sw-sub">
            Issued at {chosen && isFifo(chosen.costMethod) ? "the cost of the oldest layers" : "the weighted average cost"}, not at what it sold for.
          </span>
        )}
        {!blocker && (tab === "receive" || tab === "count") && (
          <span className="sw-sub">A reference makes this safe to send twice — the same document records one movement.</span>
        )}
        {!blocker && tab === "value" && (
          <span className="sw-sub">
            Carried at the lower of cost and this (IAS 2.9). A recovery reverses the write-down but never lifts it above cost (IAS 2.33).
          </span>
        )}
        {!blocker && tab === "method" && chosen && chosen.quantityMilli !== "0" && (
          <span className="sw-sub" style={{ color: "var(--sw-warn)" }}>
            {chosen.sku} holds {chosen.quantity} {chosen.uom}. The method can only change at nil stock.
          </span>
        )}
      </div>
    </Panel>
  );
}

function MethodField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Costed on">
      <select className="sw-select" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Cost method">
        <option value="WEIGHTED_AVERAGE">Weighted average</option>
        <option value="FIFO">First in, first out</option>
      </select>
    </Field>
  );
}

/** A wire figure (minor units as a string) as prose, for a status message. */
function fmtWire(v: unknown): string {
  const minor = BigInt(String(v ?? "0"));
  const neg = minor < 0n;
  const abs = (neg ? -minor : minor).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${abs.slice(0, -2)}.${abs.slice(-2)}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
