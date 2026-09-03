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

interface Location {
  code: string; name: string; nameAr: string | null; address: string | null;
  isDefault: boolean; status: string;
}
interface LocationLine {
  sku: string; name: string; uom: string; quantityMilli: string; quantity: string; valueMinor: string;
}
interface LocationStock {
  /** Nil on the one row that is not a location: stock nobody placed. */
  code: string | null; name: string; isDefault: boolean; status: string; assigned: boolean;
  lines: LocationLine[]; itemCount: number; valueMinor: string;
}
interface LocationTie {
  sku: string; name: string; uom: string;
  quantityMilli: string; quantity: string;
  locatedMilli: string; unassignedMilli: string; costMinor: string;
  differenceMilli: string; agrees: boolean;
}
interface Batch {
  sku: string; name: string; uom: string; code: string; kind: string; status: string;
  location: string | null; receivedOn: string; expiresOn: string | null;
  /** Nil where the goods do not go off — a different fact from an expiry not yet reached. */
  daysToExpiry: number | null;
  expired: boolean; quantityMilli: string; quantity: string; valueMinor: string;
}
interface BatchTie {
  sku: string; name: string; uom: string;
  itemMilli: string; itemQuantity: string;
  batchMilli: string; batchQuantity: string; batchCount: number;
  differenceMilli: string; difference: string; agrees: boolean;
}
interface Expiring {
  sku: string; name: string; uom: string; code: string; kind: string; status: string;
  expiresOn: string | null; daysToExpiry: number | null;
  quantityMilli: string; quantity: string; valueMinor: string;
}
interface OnOrder {
  number: string; supplierName: string; expectedOn: string | null; outstandingMilli: string;
}
interface Reorder {
  sku: string; name: string; uom: string;
  quantityMilli: string; quantity: string;
  reorderLevelMilli: string; reorderLevel: string;
  onOrderMilli: string; onOrder: string;
  shortfallMilli: string; shortfall: string;
  atLevel: boolean; covered: boolean; orders: OnOrder[];
}
interface Stocking {
  locations: Location[];
  byLocation: {
    asOf: string | null;
    locations: LocationStock[];
    items: LocationTie[];
    totals: { valueMinor: string; registerCostMinor: string; differenceMinor: string; agrees: boolean };
  };
  batches: Batch[];
  reconciliation: { items: BatchTie[]; tracked: number; differenceMilli: string; agrees: boolean };
  expiring: {
    asOf: string; withinDays: number; horizon: string;
    expired: Expiring[]; expiring: Expiring[];
    totals: { expiredValueMinor: string; expiringValueMinor: string; expiredCount: number; expiringCount: number };
  };
  reorder: {
    items: Reorder[];
    monitored: number;
    unmonitored: { sku: string; name: string; uom: string; quantityMilli: string; quantity: string }[];
    totals: { below: number; covered: number; unmonitored: number };
  };
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
  /** How far ahead the expiry panel looks, in days. */
  const [horizonDays, setHorizonDays] = React.useState(30);

  const q = useLedgerQuery<Valuation>(entityId ? `/api/ledger/inventory?entityId=${entityId}` : null);
  const stocking = useLedgerQuery<Stocking>(
    entityId ? `/api/ledger/inventory?entityId=${entityId}&view=stocking&within=${horizonDays}` : null,
    [horizonDays],
  );
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
      stocking.reload();
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
        sub="Stock at weighted average cost or first-in-first-out, carried at the lower of cost and net realisable value, with the ledger account it has to agree with, and with where the goods are, which batch they came from and when they go off. Every movement that changes value posts at the same time — an inventory system whose numbers never reach account 1200 is a spreadsheet. A transfer between locations is the one movement that changes nothing but the address, so it posts nothing at all."
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="inventory-result">{msg}</div>}
      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && !q.data && <Loading />}

      <MoveStock
        items={q.data?.items ?? []}
        locations={stocking.data?.locations ?? []}
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

      {stocking.error && <ErrorNote>{stocking.error}</ErrorNote>}
      {stocking.data && (
        <>
          <ByLocation data={stocking.data.byLocation} />
          <BatchRegister batches={stocking.data.batches} tie={stocking.data.reconciliation} />
          <Expiry
            data={stocking.data.expiring}
            days={horizonDays}
            onDays={setHorizonDays}
            busy={busy}
            onSweep={async (action) => {
              const r = await act("sweep", {
                action: "sweep", movedOn: new Date().toISOString().slice(0, 10), sweepAction: action,
              });
              if (!r) return;
              const swept = (r.swept as unknown[] | undefined)?.length ?? 0;
              const totals = r.totals as { valueMinor?: string } | undefined;
              setMsg(
                swept === 0
                  ? "Nothing had gone off, so nothing was swept."
                  : action === "quarantine"
                    ? `${swept} batch${swept === 1 ? "" : "es"} put into quarantine. Nothing was posted — quarantine is a decision about sale, not about value.`
                    : `${swept} batch${swept === 1 ? "" : "es"} written off, ${fmtWire(totals?.valueMinor)} through stock variance.`,
              );
            }}
          />
          <BelowLevel data={stocking.data.reorder} />
        </>
      )}

      {selected && history.data && (
        <ItemRecord data={history.data} />
      )}
    </>
  );
}

/**
 * Stock by location, against the item it came off.
 *
 * A location holds a quantity, never a cost of its own — the item is the
 * authority on value — so the value column is the item's own cost apportioned
 * across the places the goods are sitting. Stock that moved before anybody
 * opened a location is shown as its own row rather than dropped, because
 * dropping it is exactly what would make the total stop tying.
 */
function ByLocation({ data }: { data: Stocking["byLocation"] }) {
  const gaps = data.items.filter((i) => !i.agrees);
  return (
    <Panel className="mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">Where the stock is</span>
        <span className={`sw-chip ${data.totals.agrees ? "sw-chip-ok" : "sw-chip-bad"}`}>
          {data.totals.agrees ? "ties to the item list" : "does not tie"}
        </span>
      </div>
      {data.locations.every((l) => l.lines.length === 0) ? (
        <div className="p-3"><Empty>No stock has been placed anywhere yet.</Empty></div>
      ) : (
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">
              Every location and what it holds, with the item&rsquo;s own cost apportioned across them
            </caption>
            <thead>
              <tr>
                <th style={{ width: "9rem" }}>Location</th>
                <th style={{ width: "8rem" }}>SKU</th>
                <th>Item</th>
                <th className="sw-num" style={{ width: "7rem" }}>On hand</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost held</th>
              </tr>
            </thead>
            <tbody>
              {data.locations.flatMap((l) =>
                l.lines.length === 0
                  ? []
                  : l.lines.map((line, n) => (
                      <tr key={`${l.code ?? "none"}-${line.sku}`}>
                        <td className="sw-code">
                          {n > 0 ? (
                            <span className="sw-zero">&#8942;</span>
                          ) : l.code === null ? (
                            <span title="Recorded before anybody said where it was">not assigned</span>
                          ) : (
                            <>
                              {l.code}
                              {l.isDefault && <span className="sw-sub" style={{ marginInlineStart: "0.4rem" }}>default</span>}
                            </>
                          )}
                        </td>
                        <td className="sw-code">{line.sku}</td>
                        <td className="max-w-0 truncate">{line.name}</td>
                        <td className="sw-num">
                          {line.quantity} <span style={{ color: "var(--sw-fg-muted)" }}>{line.uom}</span>
                        </td>
                        <td className="sw-num"><Figure minor={line.valueMinor} zero="zero" colour={false} /></td>
                      </tr>
                    )),
              )}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={4} style={{ textAlign: "end" }}>Cost across every location</th>
                <td className="sw-num"><Figure minor={data.totals.valueMinor} zero="zero" colour={false} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {gaps.length > 0 && (
        <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)", color: "var(--sw-warn)" }}>
          {gaps.map((g) => `${g.sku} is out by ${g.differenceMilli}`).join("; ")}. The item&rsquo;s own quantity and
          the sum of where its goods are should be the same number.
        </p>
      )}
    </Panel>
  );
}

/**
 * The batch register, and the tie back to the item.
 *
 * The tie is the whole reason the register is worth keeping: a list of labels
 * that has never been checked against the item it describes sends a recall to
 * the wrong shelves.
 */
function BatchRegister({ batches, tie }: { batches: Batch[]; tie: Stocking["reconciliation"] }) {
  return (
    <Panel className="mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">Batches and serial numbers</span>
        {tie.tracked > 0 && (
          <span className={`sw-chip ${tie.agrees ? "sw-chip-ok" : "sw-chip-bad"}`}>
            {tie.agrees ? "batches tie to the item" : "batches do not tie"}
          </span>
        )}
      </div>
      {batches.length === 0 ? (
        <div className="p-3">
          <Empty>No batches yet. Name one on a receipt and the item becomes tracked from then on.</Empty>
        </div>
      ) : (
        <>
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Every batch and serial number on record, soonest to expire first</caption>
              <thead>
                <tr>
                  <th style={{ width: "8rem" }}>SKU</th>
                  <th style={{ width: "9rem" }}>Batch</th>
                  <th style={{ width: "5rem" }}>Kind</th>
                  <th style={{ width: "7rem" }}>Location</th>
                  <th style={{ width: "7rem" }}>Received</th>
                  <th style={{ width: "9rem" }}>Expires</th>
                  <th className="sw-num" style={{ width: "7rem" }}>On hand</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost held</th>
                  <th style={{ width: "7rem" }}>State</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={`${b.sku}-${b.code}`}>
                    <td className="sw-code">{b.sku}</td>
                    <td className="sw-code">{b.code}</td>
                    <td style={{ color: "var(--sw-fg-muted)" }}>{b.kind === "SERIAL" ? "serial" : "batch"}</td>
                    <td className="sw-code">{b.location ?? <span className="sw-zero">–</span>}</td>
                    <td>{b.receivedOn}</td>
                    <td>
                      {/* Goods that do not go off and goods whose date has not
                          come round are different facts, and read differently. */}
                      {b.expiresOn === null ? (
                        <span className="sw-zero">does not expire</span>
                      ) : (
                        <>
                          {b.expiresOn}
                          <span className="sw-sub" style={{ marginInlineStart: "0.4rem" }}>{daysLabel(b.daysToExpiry)}</span>
                        </>
                      )}
                    </td>
                    <td className="sw-num">
                      {b.quantity} <span style={{ color: "var(--sw-fg-muted)" }}>{b.uom}</span>
                    </td>
                    <td className="sw-num"><Figure minor={b.valueMinor} zero="zero" colour={false} /></td>
                    <td><span className={`sw-chip ${BATCH_TONE[b.status] ?? ""}`}>{b.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {tie.items.length > 0 && (
            <div className="sw-scroll" style={{ borderTop: "1px solid var(--sw-line-strong)" }}>
              <table className="sw-table">
                <caption className="sr-only">
                  Each tracked item&rsquo;s own quantity beside the sum of its batches
                </caption>
                <thead>
                  <tr>
                    <th style={{ width: "8rem" }}>SKU</th>
                    <th>Item</th>
                    <th className="sw-num" style={{ width: "5rem" }}>Batches</th>
                    <th className="sw-num" style={{ width: "7rem" }}>Per the item</th>
                    <th className="sw-num" style={{ width: "7rem" }}>Per the batches</th>
                    <th className="sw-num" style={{ width: "7rem" }}>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {tie.items.map((r) => (
                    <tr key={r.sku}>
                      <td className="sw-code">{r.sku}</td>
                      <td className="max-w-0 truncate">{r.name}</td>
                      <td className="sw-num">{r.batchCount}</td>
                      <td className="sw-num">{r.itemQuantity}</td>
                      <td className="sw-num">{r.batchQuantity}</td>
                      <td className="sw-num">
                        {r.agrees ? <span className="sw-zero">–</span> : <span className="sw-num-neg">{r.difference}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

const BATCH_TONE: Record<string, string> = {
  active: "sw-chip-ok",
  quarantined: "sw-chip-warn",
  expired: "sw-chip-bad",
  consumed: "",
};

const daysLabel = (days: number | null) =>
  days === null ? "" : days < 0 ? `${-days} day${days === -1 ? "" : "s"} ago` : days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}`;

/**
 * What is about to go off, and what already has.
 *
 * Reported apart because they call for different acts: expiring stock is a
 * selling problem, and expired stock is an accounting one. Quarantine takes
 * goods off sale and says nothing about value; a write-off says the decision is
 * made and posts it, because stock that has gone off is worth nothing and
 * carrying it at cost overstates the balance sheet.
 */
function Expiry({ data, days, onDays, onSweep, busy }: {
  data: Stocking["expiring"];
  days: number;
  onDays: (d: number) => void;
  onSweep: (action: "quarantine" | "write_off") => void;
  busy: string | null;
}) {
  const rows = (list: Expiring[], gone: boolean) =>
    list.map((b) => (
      <tr key={`${b.sku}-${b.code}`}>
        <td className="sw-code">{b.sku}</td>
        <td className="sw-code">{b.code}</td>
        <td>{b.expiresOn}</td>
        <td style={{ color: gone ? "var(--sw-warn)" : "var(--sw-fg-muted)" }}>{daysLabel(b.daysToExpiry)}</td>
        <td className="sw-num">{b.quantity} <span style={{ color: "var(--sw-fg-muted)" }}>{b.uom}</span></td>
        <td className="sw-num"><Figure minor={b.valueMinor} zero="zero" colour={false} /></td>
      </tr>
    ));

  return (
    <Panel className="mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2"
        style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">Expiry</span>
        <label className="flex items-center gap-2">
          <span className="sw-label">Looking ahead</span>
          <select
            className="sw-select sw-select-sm"
            value={days}
            onChange={(e) => onDays(Number(e.target.value))}
            aria-label="How many days ahead to look for expiring stock"
          >
            {[0, 7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>{d === 0 ? "only what has gone off" : `${d} days`}</option>
            ))}
          </select>
        </label>
      </div>

      {data.expired.length === 0 && data.expiring.length === 0 ? (
        <div className="p-3">
          <Empty>Nothing expires within {data.withinDays} days, and nothing has gone off.</Empty>
        </div>
      ) : (
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">
              Batches that have expired, and batches expiring on or before {data.horizon}
            </caption>
            <thead>
              <tr>
                <th style={{ width: "8rem" }}>SKU</th>
                <th style={{ width: "9rem" }}>Batch</th>
                <th style={{ width: "7rem" }}>Expires</th>
                <th style={{ width: "9rem" }}>When</th>
                <th className="sw-num" style={{ width: "7rem" }}>On hand</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost held</th>
              </tr>
            </thead>
            {data.expired.length > 0 && (
              <tbody>
                <tr>
                  <th scope="rowgroup" colSpan={6} style={{ textAlign: "start", color: "var(--sw-warn)" }}>
                    Gone off — worth nothing, and still carried at cost
                  </th>
                </tr>
                {rows(data.expired, true)}
              </tbody>
            )}
            {data.expiring.length > 0 && (
              <tbody>
                <tr>
                  <th scope="rowgroup" colSpan={6} style={{ textAlign: "start" }}>
                    Going off by {data.horizon}
                  </th>
                </tr>
                {rows(data.expiring, false)}
              </tbody>
            )}
            <tfoot>
              <tr>
                <th scope="row" colSpan={5} style={{ textAlign: "end" }}>Cost of stock already gone off</th>
                <td className="sw-num"><Figure minor={data.totals.expiredValueMinor} zero="zero" colour={false} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
        <button
          type="button"
          className="sw-btn"
          onClick={() => onSweep("quarantine")}
          aria-disabled={busy !== null || data.totals.expiredCount === 0 || undefined}
          disabled={busy !== null || data.totals.expiredCount === 0}
        >
          Quarantine what has gone off
        </button>
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          onClick={() => onSweep("write_off")}
          aria-disabled={busy !== null || data.totals.expiredCount === 0 || undefined}
          disabled={busy !== null || data.totals.expiredCount === 0}
          data-testid="inventory-sweep"
        >
          Write it off
        </button>
        <span className="sw-sub">
          Quarantine takes goods off sale and posts nothing. A write-off goes to stock variance, because a business
          that cannot see what it threw away cannot stop throwing it away.
        </span>
      </div>
    </Panel>
  );
}

/**
 * What needs ordering.
 *
 * A nil level and a level of nothing are different facts and stay different
 * here: an item nobody has set a level for is listed separately rather than
 * left out, because unwatched is not the same as fine. An order already placed
 * never removes an item from the list — goods on a lorry are not goods on a
 * shelf — it only says somebody has acted.
 */
function BelowLevel({ data }: { data: Stocking["reorder"] }) {
  return (
    <Panel className="mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">Below its reorder level</span>
        <span className="sw-sub">
          {data.monitored} item{data.monitored === 1 ? "" : "s"} watched, {data.totals.unmonitored} with no level set
        </span>
      </div>
      {data.items.length === 0 ? (
        <div className="p-3"><Empty>Nothing is at or under its reorder level.</Empty></div>
      ) : (
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">
              Items at or under their reorder level, with what is already on order against them
            </caption>
            <thead>
              <tr>
                <th style={{ width: "8rem" }}>SKU</th>
                <th>Item</th>
                <th className="sw-num" style={{ width: "7rem" }}>On hand</th>
                <th className="sw-num" style={{ width: "7rem" }}>Level</th>
                <th className="sw-num" style={{ width: "7rem" }}>Short by</th>
                <th className="sw-num" style={{ width: "7rem" }}>On order</th>
                <th style={{ width: "14rem" }}>Against</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.sku}>
                  <td className="sw-code">{r.sku}</td>
                  <td className="max-w-0 truncate">{r.name}</td>
                  <td className="sw-num">{r.quantity} <span style={{ color: "var(--sw-fg-muted)" }}>{r.uom}</span></td>
                  <td className="sw-num">{r.reorderLevel}</td>
                  <td className="sw-num">
                    {r.atLevel ? <span className="sw-zero" title="Exactly at the level, which is still below it">at level</span> : r.shortfall}
                  </td>
                  <td className="sw-num">
                    {r.onOrderMilli === "0" ? <span className="sw-zero">–</span> : r.onOrder}
                  </td>
                  <td>
                    {r.orders.length === 0 ? (
                      <span className="sw-chip sw-chip-bad">nothing ordered</span>
                    ) : (
                      <>
                        <span className={`sw-chip ${r.covered ? "sw-chip-warn" : "sw-chip-bad"}`}>
                          {r.covered ? "on order" : "not enough on order"}
                        </span>
                        <span className="sw-sub" style={{ marginInlineStart: "0.4rem" }}>
                          {r.orders.map((o) => o.number).join(", ")}
                        </span>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.unmonitored.length > 0 && (
        <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
          Nobody has set a level for {data.unmonitored.map((u) => u.sku).join(", ")}. That is not the same as those
          items being fine — a level of nothing is a real answer, and it means tell me the moment they run out.
        </p>
      )}
    </Panel>
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

type Tab = "receive" | "issue" | "transfer" | "count" | "value" | "level" | "add" | "location" | "method";

function MoveStock({ items, locations, busy, onAct }: {
  items: Item[];
  locations: Location[];
  busy: string | null;
  onAct: (label: string, body: Record<string, unknown>, describe: (r: Record<string, unknown>) => string) => void;
}) {
  const [tab, setTab] = React.useState<Tab>("receive");
  const [f, setF] = React.useState({
    sku: "", name: "", uom: "EA", costMethod: "WEIGHTED_AVERAGE",
    movedOn: new Date().toISOString().slice(0, 10),
    qty: "", cost: "", counted: "", nrv: "", reference: "", memo: "",
    location: "", toLocation: "", batch: "", batchKind: "BATCH", expiresOn: "",
    code: "", locationName: "", isDefault: "no",
    /** "set" or "none" — an empty box must not be read as a level of nothing. */
    levelMode: "set", level: "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const qty = toMilli(f.qty);
  const counted = toMilli(f.counted);
  const level = toMilli(f.level);
  const cost = parseAmount(f.cost);
  const nrv = parseAmount(f.nrv);
  const chosen = items.find((i) => i.sku === f.sku);
  const open = locations.filter((l) => l.status === "active");
  const known = locations.find((l) => l.code === f.code.trim().toUpperCase());

  const blocker =
    tab === "add"
      ? !f.sku.trim() ? "Give the item a SKU." : !f.name.trim() ? "Give the item a name." : null
      : tab === "location"
        ? !f.code.trim() ? "Give the location a code — that is what a movement names." :
          !known && !f.locationName.trim() ? "Give the location a name." : null
        : !f.sku ? "Choose an item." :
          tab === "method"
            ? chosen && chosen.costMethod === f.costMethod ? `${f.sku} is already costed that way.` : null
            : tab === "level"
              ? f.levelMode === "none" ? null :
                level === null ? "How many, before it needs ordering? Nothing is a real answer — it means tell me the moment it runs out." : null
              : tab === "value"
                ? f.nrv.trim() === "" ? "What is it worth, per unit? Nothing assessed is not the same as assessed at nothing." :
                  nrv === null || nrv < 0n ? "Net realisable value cannot be negative." : null
                : tab === "count"
                  ? counted === null ? "How many were counted? Up to three decimal places." : null
                  : tab === "transfer"
                    ? !f.location || !f.toLocation ? "Say where the goods left and where they went." :
                      f.location === f.toLocation ? "Stock that has not moved is not a transfer." :
                      qty === null || qty <= 0n ? "How many? Up to three decimal places." : null
                    : qty === null || qty <= 0n ? "How many? Up to three decimal places." :
                      tab === "receive" && (cost === null || cost < 0n) ? "What did the whole receipt cost?" : null;

  const closeLocation = () =>
    onAct("close-location", { action: "close-location", code: f.code.trim().toUpperCase() },
      () => `${f.code.trim().toUpperCase()} is closed. Nothing can move through it now.`);

  const submit = () => {
    if (blocker) return;
    const ref = f.reference.trim() || undefined;
    const where = f.location || undefined;
    const lot = f.batch.trim() || undefined;
    if (tab === "add") {
      onAct("add", { action: "add", sku: f.sku.trim(), name: f.name.trim(), uom: f.uom, costMethod: f.costMethod },
        () => `Added ${f.sku.trim()} to the item list, costed on ${methodLabel(f.costMethod)}.`);
      return;
    }
    if (tab === "location") {
      const code = f.code.trim().toUpperCase();
      onAct(known ? "update-location" : "add-location", {
        action: known ? "update-location" : "add-location",
        code, name: f.locationName.trim() || known?.name, isDefault: f.isDefault === "yes",
      }, () => known
        ? `${code} updated${f.isDefault === "yes" ? ", and stock now lands there when nobody says" : ""}.`
        : `${code} opened${f.isDefault === "yes" ? ", and stock now lands there when nobody says" : ""}.`);
      return;
    }
    if (tab === "method") {
      onAct("method", { action: "method", sku: f.sku, costMethod: f.costMethod },
        () => `${f.sku} is now costed on ${methodLabel(f.costMethod)}.`);
      return;
    }
    if (tab === "level") {
      onAct("reorder", {
        action: "reorder", sku: f.sku,
        reorderLevelMilli: f.levelMode === "none" ? null : (level as bigint).toString(),
      }, (r) => r.reorderLevelMilli === null
        ? `Nobody is watching ${f.sku} now. That is not the same as it being fine.`
        : `${f.sku} is watched at ${f.level}. At or under that, it is reported as needing ordering.`);
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
        location: where, batch: lot, batchKind: lot ? f.batchKind : undefined,
        expiresOn: lot && f.expiresOn ? f.expiresOn : undefined,
      }, (r) => r.replayed
        ? `${f.reference} was already received against ${f.sku}. Nothing was recorded twice.`
        : `Received ${f.qty}. Now holding ${Number(r.balanceQtyMilli) / 1000}.`);
      return;
    }
    if (tab === "issue") {
      onAct("issue", {
        action: "issue", sku: f.sku, movedOn: f.movedOn,
        quantityMilli: (qty as bigint).toString(), reference: ref, memo: f.memo || undefined,
        location: where, batch: lot,
      }, (r) => r.replayed
        ? `${f.reference} was already issued against ${f.sku}. Nothing was recorded twice.`
        : `Issued ${f.qty}, costing ${fmtWire(String(-BigInt(String(r.valueMinor))))} at ${chosen && isFifo(chosen.costMethod) ? "the oldest layers first" : "the weighted average"}.`);
      return;
    }
    if (tab === "transfer") {
      onAct("transfer", {
        action: "transfer", sku: f.sku, movedOn: f.movedOn,
        from: f.location, to: f.toLocation, quantityMilli: (qty as bigint).toString(),
        batch: lot, reference: ref, memo: f.memo || undefined,
      }, (r) => r.replayed
        ? `${f.reference} was already transferred. Nothing was recorded twice.`
        : `Moved ${f.qty} from ${f.location} to ${f.toLocation}. Nothing posted — the goods never left the business.`);
      return;
    }
    onAct("count", {
      action: "count", sku: f.sku, movedOn: f.movedOn,
      countedMilli: (counted as bigint).toString(), reference: ref, memo: f.memo || undefined,
      location: where, batch: lot,
    }, (r) => `Adjusted to ${f.counted}. The difference of ${Number(r.quantityMilli) / 1000} was booked to stock variance.`);
  };

  const TABS = [
    { key: "receive", label: "Receive" },
    { key: "issue", label: "Issue" },
    { key: "transfer", label: "Transfer" },
    { key: "count", label: "Stock count" },
    { key: "value", label: "Net realisable value" },
    { key: "level", label: "Reorder level" },
    { key: "add", label: "New item" },
    { key: "location", label: "Locations" },
    { key: "method", label: "Cost method" },
  ] as const;

  const ACTION_LABEL: Record<Tab, string> = {
    receive: "Receive", issue: "Issue", transfer: "Transfer", count: "Adjust to count",
    value: "Record assessment", level: "Set level", add: "Add item",
    location: known ? "Update location" : "Open location", method: "Change method",
  };

  const movesStock = tab === "receive" || tab === "issue" || tab === "count";

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
        ) : tab === "location" ? (
          <>
            <Field label="Code">
              <input className="sw-input sw-code" value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="MAIN" list="sw-location-codes" />
            </Field>
            <datalist id="sw-location-codes">
              {locations.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </datalist>
            <Field label="Name">
              <input className="sw-input" value={f.locationName} onChange={(e) => set("locationName", e.target.value)}
                placeholder={known?.name ?? "Main warehouse"} />
            </Field>
            <Field label="Stock lands here when nobody says">
              <select className="sw-select" value={f.isDefault} onChange={(e) => set("isDefault", e.target.value)} aria-label="Make this the default location">
                <option value="no">Leave the default alone</option>
                <option value="yes">Make it the default</option>
              </select>
            </Field>
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
            ) : tab === "level" ? (
              <Field label="Watched">
                <select className="sw-select" value={f.levelMode} onChange={(e) => set("levelMode", e.target.value)} aria-label="Whether this item has a reorder level">
                  <option value="set">Watched at a level</option>
                  <option value="none">Nobody is watching it</option>
                </select>
              </Field>
            ) : (
              <Field label={tab === "value" ? "Assessed on" : "Date"}>
                <input type="date" className="sw-input" value={f.movedOn} onChange={(e) => set("movedOn", e.target.value)} />
              </Field>
            )}
            {tab === "level" && f.levelMode === "set" && (
              <Field label={`Reorder at, in ${chosen?.uom.toLowerCase() ?? "units"}`}>
                <input className="sw-input sw-cell-num" inputMode="decimal" value={f.level} onChange={(e) => set("level", e.target.value)} placeholder="50" />
              </Field>
            )}
            {tab === "count" && (
              <Field label="Counted"><input className="sw-input sw-cell-num" inputMode="decimal" value={f.counted} onChange={(e) => set("counted", e.target.value)} placeholder="148" /></Field>
            )}
            {(tab === "receive" || tab === "issue" || tab === "transfer") && (
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
            {(movesStock || tab === "transfer") && open.length > 0 && (
              <Field label={tab === "transfer" ? "Left from" : "Location"}>
                <select className="sw-select" value={f.location} onChange={(e) => set("location", e.target.value)}
                  aria-label={tab === "transfer" ? "Location the goods left" : "Location"}>
                  <option value="">{tab === "transfer" ? "Choose…" : "Wherever it usually goes"}</option>
                  {open.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
                </select>
              </Field>
            )}
            {tab === "transfer" && (
              <Field label="Arrived at">
                <select className="sw-select" value={f.toLocation} onChange={(e) => set("toLocation", e.target.value)} aria-label="Location the goods arrived at">
                  <option value="">Choose…</option>
                  {open.map((l) => <option key={l.code} value={l.code}>{l.code} — {l.name}</option>)}
                </select>
              </Field>
            )}
            {(movesStock || tab === "transfer") && (
              <Field label={tab === "receive" ? "Batch or serial" : "Which batch"}>
                <input className="sw-input sw-code" value={f.batch} onChange={(e) => set("batch", e.target.value)} placeholder="L-2401" />
              </Field>
            )}
            {tab === "receive" && f.batch.trim() !== "" && (
              <>
                <Field label="Kind">
                  <select className="sw-select" value={f.batchKind} onChange={(e) => set("batchKind", e.target.value)} aria-label="Batch or serial number">
                    <option value="BATCH">Batch</option>
                    <option value="SERIAL">Serial number — one unit</option>
                  </select>
                </Field>
                <Field label="Expires on">
                  <input type="date" className="sw-input" value={f.expiresOn} onChange={(e) => set("expiresOn", e.target.value)} />
                </Field>
              </>
            )}
            {(movesStock || tab === "transfer") && (
              <Field label="Reference">
                <input className="sw-input" value={f.reference} onChange={(e) => set("reference", e.target.value)}
                  placeholder={tab === "receive" ? "GRN-1001" : tab === "issue" ? "DN-2001" : tab === "transfer" ? "TN-3001" : "COUNT-Q2"} />
              </Field>
            )}
            {tab !== "receive" && tab !== "method" && tab !== "level" && (
              <Field label="Note">
                <input className="sw-input" value={f.memo} onChange={(e) => set("memo", e.target.value)}
                  placeholder={tab === "count" ? "Quarterly count" : tab === "value" ? "Slow-moving, marked down" : tab === "transfer" ? "Restocking the shop floor" : "Sold to customer"} />
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
        {tab === "location" && known && known.status === "active" && (
          <button
            type="button"
            className="sw-btn"
            onClick={closeLocation}
            aria-disabled={busy !== null || undefined}
            disabled={busy !== null}
            data-testid="inventory-close-location"
          >
            Close {known.code}
          </button>
        )}
        {blocker && <span className="sw-sub" role="status" data-testid="inventory-blocker">{blocker}</span>}
        {!blocker && tab === "issue" && (
          <span className="sw-sub">
            Issued at {chosen && isFifo(chosen.costMethod) ? "the cost of the oldest layers" : "the weighted average cost"}, not at what it sold for.
            Where the item is tracked by batch, say which batch left — a guess is a recall nobody can trace.
          </span>
        )}
        {!blocker && tab === "transfer" && (
          <span className="sw-sub">
            A transfer posts nothing. The goods have not left the business, so no cost has moved and account 1200 stays
            exactly where it was.
          </span>
        )}
        {!blocker && (tab === "receive" || tab === "count") && (
          <span className="sw-sub">A reference makes this safe to send twice — the same document records one movement.</span>
        )}
        {!blocker && tab === "level" && (
          <span className="sw-sub">
            No level and a level of nothing are different facts. Nobody watching is not the same as fine; a level of
            nothing means tell me the moment it runs out.
          </span>
        )}
        {!blocker && tab === "location" && known && (
          <span className="sw-sub">
            {known.code} is {known.status}. A location can only be closed once it is empty — stock somewhere nobody can
            reach is still on the balance sheet.
          </span>
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
