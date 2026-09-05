"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";
import { parseAmount } from "@/lib/ledger/format";

interface ListRow {
  code: string; name: string; currency: string; kind: string;
  isDefault: boolean; validFrom: string; validTo: string | null;
  inForce: boolean; notes: string | null;
  priceCount: number; livePriceCount: number; partyCount: number;
}
interface PriceRow {
  id: string; listCode: string; currency: string; itemCode: string;
  minQuantityMilli: string; unitPriceMinor: string; discountBps: number;
  validFrom: string; validTo: string | null; inForce: boolean;
}
interface PartyRow { partyKey: string; listCode: string; kind: string }
interface Register {
  on: string;
  truncated: boolean;
  listed: number;
  lists: ListRow[];
  prices: PriceRow[];
  parties: PartyRow[];
  findings: string[];
}

interface VarianceRow {
  itemCode: string; quantityMilli: string; chargedMinor: string;
  listMinor: string | null; varianceMinor: string; varianceBps: number | null; why: string;
}
interface Variance {
  lines: VarianceRow[];
  totals: {
    pricedLines: number; unpricedLines: number;
    chargedMinor: string; listMinor: string; varianceMinor: string; varianceBps: number | null;
  };
}

interface Quote {
  itemCode: string; found: boolean; unitPriceMinor: string; discountBps: number;
  quantityMilli: string; netMinor: string; currency: string;
  source: {
    listCode: string; listName: string; entryId: string; minQuantityMilli: string;
    validFrom: string; validTo: string | null; assigned: boolean;
  } | null;
  defaultUnitPriceMinor: string | null;
  why: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/** The day before a date, which is where a price being superseded has to end. */
const dayBefore = (iso: string) => new Date(new Date(`${iso}T00:00:00.000Z`).getTime() - 86_400_000)
  .toISOString().slice(0, 10);

/** A quantity as it is typed — "1.5" — into the thousandths that are stored. */
function toMilli(text: string): bigint | null {
  const t = text.trim();
  if (!t) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole) * 1000n + BigInt(frac.padEnd(3, "0"));
}

/** Thousandths as a quantity somebody would write. */
const qty = (milli: string) => {
  const n = Number(milli) / 1000;
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "");
};

const bps = (v: number) => `${(v / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

export default function PricingPage() {
  const entityId = useEntityId();
  const [on, setOn] = React.useState(today);
  const [listCode, setListCode] = React.useState("");

  const q = new URLSearchParams({ entityId: entityId ?? "", on });
  if (listCode) q.set("listCode", listCode);
  const { data, error, loading, reload } = useLedgerQuery<Register>(
    entityId ? `/api/ledger/pricing?${q.toString()}` : null,
    [on, listCode],
  );

  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [quote, setQuote] = React.useState<Quote | null>(null);
  const [variance, setVariance] = React.useState<Variance | null>(null);

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label); setErr(null); setMsg(null);
    try {
      const r = await api<Record<string, unknown>>("/api/ledger/pricing", {
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

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Price lists"
        sub={
          "A price typed onto a document by hand is a number with no provenance. Six months later nobody can say " +
          "whether it was the agreed price, a quantity break, or somebody being generous on a Friday — and a " +
          "discount never recorded as a discount cannot be reported on. A list makes the price a fact about the " +
          "arrangement, and makes a departure from it visible as a departure."
        }
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">As at</span>
              <input type="date" className="sw-input" style={{ width: "10rem" }} value={on}
                onChange={(e) => setOn(e.target.value)} aria-label="Date to price on" />
            </label>
            <button type="button" className="sw-btn" onClick={() => setAdding((a) => !a)} data-testid="toggle-add-list">
              {adding ? "Cancel" : "New price list"}
            </button>
          </>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="pricing-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}

      {adding && (
        <NewList
          busy={busy === "createList"}
          onCreate={async (list) => {
            const r = await act("createList", { action: "createList", list });
            if (r) { setAdding(false); setMsg(`Recorded ${list.code}. It prices nothing until prices are put on it.`); }
          }}
        />
      )}

      {loading && !data && <Loading />}

      {data && (
        <>
          {data.findings.length > 0 && (
            <Panel className="mb-4 p-4">
              <div className="sw-label">What is wrong with the set</div>
              <ul className="mt-2 space-y-1" data-testid="pricing-findings">
                {data.findings.map((f) => (
                  <li key={f} className="sw-sub" style={{ color: "var(--sw-warn)" }}>{f}</li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel className="mb-4 overflow-hidden">
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">The price lists and what each covers</caption>
                <thead>
                  <tr>
                    <th style={{ width: "9rem" }}>List</th>
                    <th>Name</th>
                    <th style={{ width: "5rem" }}>Sells</th>
                    <th style={{ width: "5rem" }}>In</th>
                    <th style={{ width: "13rem" }}>In force</th>
                    <th className="sw-num" style={{ width: "6rem" }}>Prices</th>
                    <th className="sw-num" style={{ width: "6rem" }}>Parties</th>
                    <th style={{ width: "16rem" }} />
                  </tr>
                </thead>
                <tbody data-testid="price-list-rows">
                  {data.lists.length === 0 && (
                    <tr><td colSpan={8} className="sw-sub">No price list has been set up.</td></tr>
                  )}
                  {data.lists.map((l) => (
                    <tr key={l.code}>
                      <td className="sw-code">
                        {l.code}
                        {l.isDefault && <span className="sw-chip ml-1.5">default</span>}
                      </td>
                      <td className="max-w-0 truncate">{l.name}</td>
                      <td className="sw-sub">{l.kind === "BUY" ? "buying" : "selling"}</td>
                      <td className="sw-code">{l.currency}</td>
                      <td className="sw-sub">
                        {l.validFrom} to {l.validTo ?? "further notice"}
                        {!l.inForce && <span className="sw-chip sw-chip-bad ml-1.5">not on {data.on}</span>}
                      </td>
                      <td className="sw-num">
                        {l.livePriceCount}
                        {l.priceCount !== l.livePriceCount && (
                          <span className="sw-sub"> of {l.priceCount}</span>
                        )}
                      </td>
                      <td className="sw-num">{l.partyCount}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <button type="button" className="sw-link-btn"
                            onClick={() => setListCode(listCode === l.code ? "" : l.code)}
                            aria-pressed={listCode === l.code}>
                            {listCode === l.code ? "all" : "prices"}
                          </button>
                          {l.validTo === null ? (
                            <CloseList
                              list={l}
                              suggested={dayBefore(on) < l.validFrom ? l.validFrom : dayBefore(on)}
                              busy={busy === `closeList:${l.code}`}
                              onClose={async (validTo) => {
                                const r = await act(`closeList:${l.code}`, {
                                  action: "closeList", listCode: l.code, validTo,
                                });
                                if (r) {
                                  setMsg(
                                    `${l.code} now runs to ${validTo}. Its prices are still on file and still ` +
                                    `explain the documents raised under them; they simply stop pricing anything ` +
                                    `from the day after.`,
                                  );
                                }
                              }}
                            />
                          ) : (
                            <span className="sw-sub">ended {l.validTo}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <WhatDoesItCost
            busy={busy === "quote"}
            onQuote={async (body) => {
              const r = await act("quote", { action: "quote", ...body });
              if (r) setQuote((r.quotes as Quote[])[0]);
            }}
            quote={quote}
            on={on}
          />

          <Panel className="mb-4 overflow-hidden">
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">
                  {listCode ? `Prices on ${listCode}` : "Every price on every list"}
                </caption>
                <thead>
                  <tr>
                    <th style={{ width: "8rem" }}>List</th>
                    <th>Item</th>
                    <th className="sw-num" style={{ width: "7rem" }}>From</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit price</th>
                    <th className="sw-num" style={{ width: "6rem" }}>Off</th>
                    <th style={{ width: "13rem" }}>Applies</th>
                    <th style={{ width: "15rem" }}>Close it on</th>
                  </tr>
                </thead>
                <tbody data-testid="price-rows">
                  {data.prices.length === 0 && (
                    <tr><td colSpan={7} className="sw-sub">No prices yet.</td></tr>
                  )}
                  {data.prices.map((p) => (
                    <tr key={p.id} style={p.inForce ? undefined : { opacity: 0.55 }}>
                      <td className="sw-code">{p.listCode}</td>
                      <td className="sw-code">{p.itemCode}</td>
                      <td className="sw-num">{p.minQuantityMilli === "0" ? "any" : qty(p.minQuantityMilli)}</td>
                      <td className="sw-num"><Figure minor={p.unitPriceMinor} colour={false} /></td>
                      <td className="sw-num">{p.discountBps ? bps(p.discountBps) : "—"}</td>
                      <td className="sw-sub">
                        {p.validFrom} to {p.validTo ?? "further notice"}
                        {!p.inForce && <span className="sw-chip ml-1.5">closed</span>}
                      </td>
                      <td>
                        {p.validTo === null ? (
                          <ClosePrice
                            price={p}
                            suggested={dayBefore(on) < p.validFrom ? p.validFrom : dayBefore(on)}
                            busy={busy === `close:${p.id}`}
                            onClose={async (validTo) => {
                              const r = await act(`close:${p.id}`, {
                                action: "closePrice", entryId: p.id, validTo,
                              });
                              if (r) {
                                setMsg(
                                  `${p.itemCode} on ${p.listCode} now runs to ${validTo}. A price from the day after ` +
                                  `will go on without tripping the overlap.`,
                                );
                              }
                            }}
                          />
                        ) : (
                          <span className="sw-sub">already closed</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          {data.parties.length > 0 && (
            <Panel className="mb-4 overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Who is priced from which list</caption>
                  <thead>
                    <tr>
                      <th>Party</th>
                      <th style={{ width: "9rem" }}>List</th>
                      <th style={{ width: "6rem" }}>For</th>
                      <th style={{ width: "6rem" }} />
                    </tr>
                  </thead>
                  <tbody data-testid="party-rows">
                    {data.parties.map((p) => (
                      <tr key={`${p.partyKey}:${p.listCode}`}>
                        <td className="sw-code">{p.partyKey}</td>
                        <td className="sw-code">{p.listCode}</td>
                        <td className="sw-sub">{p.kind === "BUY" ? "buying" : "selling"}</td>
                        <td>
                          <button type="button" className="sw-link-btn"
                            disabled={busy === `unassign:${p.partyKey}`}
                            onClick={async () => {
                              const r = await act(`unassign:${p.partyKey}`, {
                                action: "unassign", partyKey: p.partyKey, listCode: p.listCode,
                              });
                              if (r) setMsg(`${p.partyKey} is priced from the default list again.`);
                            }}>
                            remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {data.truncated && (
            <p className="sw-sub mb-4 max-w-[75ch]" role="status" data-testid="pricing-truncated">
              The first {data.listed} prices are listed, by item code. Narrow to one list to see all of its own —
              the counts in the table above are whole counts either way.
            </p>
          )}

          <PriceVariance
            busy={busy === "variance"}
            on={on}
            result={variance}
            onMeasure={async (body) => {
              const r = await act("variance", { action: "variance", ...body });
              setVariance(r ? (r as unknown as Variance) : null);
            }}
          />

          <AddPrice
            lists={data.lists}
            busy={busy === "setPrices"}
            onAdd={async (body) => {
              const r = await act("setPrices", { action: "setPrices", ...body });
              if (r) setMsg(`Put ${r.added} price${Number(r.added) === 1 ? "" : "s"} on ${r.listCode}.`);
            }}
            onAssign={async (partyKey, code) => {
              const r = await act("assign", { action: "assign", partyKey, listCode: code });
              if (r) setMsg(`${partyKey} is now priced from ${code}.`);
            }}
          />

          <p className="sw-sub mt-3 max-w-[75ch]">
            A list in one currency is never converted into a document&rsquo;s. Which rate — the day&rsquo;s, the
            month&rsquo;s, the one written into the contract? Any answer chosen here would put an exchange difference
            inside the selling price, where nobody would find it. The list says it is in the wrong currency and stops.
          </p>
          <p className="sw-sub mt-2 max-w-[75ch]">
            Nor does a list set prices on documents. Resolution is a read: an invoice, an order and a subscription
            each keep their own price, because a price agreed on the day the order was taken does not change because
            the list did. What the list gives them is a default and, afterwards, something to measure them against.
          </p>
        </>
      )}
    </>
  );
}

function WhatDoesItCost({ busy, onQuote, quote, on }: {
  busy: boolean;
  onQuote: (b: { lines: { itemCode: string; quantityMilli: string }[]; partyKey?: string; on: string; currency: string; kind: string }) => void;
  quote: Quote | null;
  on: string;
}) {
  const [item, setItem] = React.useState("");
  const [quantity, setQuantity] = React.useState("1");
  const [party, setParty] = React.useState("");
  const [currency, setCurrency] = React.useState("AED");
  const [kind, setKind] = React.useState("SELL");

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">What does this cost?</div>
      <p className="sw-sub mt-1 max-w-[75ch]">
        The answer comes with its derivation — which list, which quantity break, which row. A price with its
        reasoning is arguable; a price on its own can only be accepted or disputed.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-5">
        <label className="block">
          <span className="sw-label">Item</span>
          <input className="sw-input mt-1" value={item} onChange={(e) => setItem(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Quantity</span>
          <input className="sw-input sw-num mt-1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Party</span>
          <input className="sw-input mt-1" value={party} onChange={(e) => setParty(e.target.value)} placeholder="optional" />
        </label>
        <label className="block">
          <span className="sw-label">Currency</span>
          <input className="sw-input sw-code mt-1" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label className="block">
          <span className="sw-label">For</span>
          <select className="sw-select mt-1" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="SELL">selling</option>
            <option value="BUY">buying</option>
          </select>
        </label>
      </div>

      <button type="button" className="sw-btn sw-btn-primary mt-3" disabled={busy || !item.trim()}
        data-testid="ask-price"
        onClick={() => onQuote({
          lines: [{ itemCode: item.trim(), quantityMilli: String(Math.round((Number(quantity) || 1) * 1000)) }],
          partyKey: party.trim() || undefined,
          on, currency, kind,
        })}>
        {busy ? "Pricing…" : "Ask the list"}
      </button>

      {quote && (
        <div className="sw-note mt-3" role="status" data-testid="quote-result">
          {quote.found ? (
            <>
              <div>
                <strong className="sw-num"><Figure minor={quote.unitPriceMinor} colour={false} /></strong>{" "}
                {quote.currency} each, {qty(quote.quantityMilli)} making{" "}
                <strong className="sw-num"><Figure minor={quote.netMinor} colour={false} /></strong>.
              </div>
              <div className="sw-sub mt-1">{quote.why}</div>
              {quote.source && (
                <div className="sw-sub">
                  Priced from {quote.source.validFrom} to {quote.source.validTo ?? "further notice"}.
                </div>
              )}
              {quote.source?.assigned && quote.defaultUnitPriceMinor && (
                <div className="sw-sub">
                  The default list would have charged{" "}
                  <Figure minor={quote.defaultUnitPriceMinor} colour={false} /> each.
                </div>
              )}
            </>
          ) : (
            <div>{quote.why}</div>
          )}
        </div>
      )}
    </Panel>
  );
}

function NewList({ busy, onCreate }: {
  busy: boolean;
  onCreate: (l: {
    code: string; name: string; currency: string; kind: string;
    isDefault: boolean; validFrom: string; validTo?: string; notes?: string;
    supersedeDefault?: boolean;
  }) => void;
}) {
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("");
  const [currency, setCurrency] = React.useState("AED");
  const [kind, setKind] = React.useState("SELL");
  const [isDefault, setIsDefault] = React.useState(false);
  const [supersede, setSupersede] = React.useState(false);
  const [validFrom, setValidFrom] = React.useState(today);
  const [validTo, setValidTo] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">A new price list</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <label className="block">
          <span className="sw-label">Code</span>
          <input className="sw-input sw-code mt-1" value={code} placeholder="TRADE"
            onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </label>
        <label className="block sm:col-span-2">
          <span className="sw-label">Name</span>
          <input className="sw-input mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Currency</span>
          <input className="sw-input sw-code mt-1" value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label className="block">
          <span className="sw-label">For</span>
          <select className="sw-select mt-1" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="SELL">selling</option>
            <option value="BUY">buying</option>
          </select>
        </label>
        <label className="block">
          <span className="sw-label">In force from</span>
          <input type="date" className="sw-input mt-1" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Until</span>
          <input type="date" className="sw-input mt-1" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Note</span>
          <input className="sw-input mt-1" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
        </label>
      </div>

      <label className="mt-3 flex items-center gap-2">
        <input type="checkbox" className="sw-check" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        <span>
          The default — used for any party with no list of its own. Only one can be in force at a time, because two
          would make that sentence a question with two answers.
        </span>
      </label>

      {isDefault && (
        <label className="mt-2 flex items-center gap-2">
          <input type="checkbox" className="sw-check" checked={supersede} data-testid="supersede-default"
            onChange={(e) => setSupersede(e.target.checked)} />
          <span>
            This one replaces the default in force, so close that one the day before this starts. Without it the
            database refuses the second default and the changeover cannot be entered at all — and closing the old
            list first would leave a day on which nothing is priced.
          </span>
        </label>
      )}

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <div className="mt-3">
        <button type="button" className="sw-btn sw-btn-primary" disabled={busy} data-testid="save-list"
          onClick={() => {
            if (!code.trim() || !name.trim()) { setErr("A list needs a code and a name somebody will recognise."); return; }
            setErr(null);
            onCreate({
              code: code.trim(), name: name.trim(), currency, kind, isDefault, validFrom,
              validTo: validTo || undefined, notes: notes.trim() || undefined,
              supersedeDefault: isDefault && supersede ? true : undefined,
            });
          }}>
          {busy ? "Saving…" : "Record the list"}
        </button>
      </div>
    </Panel>
  );
}

function AddPrice({ lists, busy, onAdd, onAssign }: {
  lists: ListRow[];
  busy: boolean;
  onAdd: (b: { listCode: string; prices: { itemCode: string; unitPriceMinor: string; minQuantityMilli: string; discountBps: number; validFrom: string }[] }) => void;
  onAssign: (partyKey: string, listCode: string) => void;
}) {
  const [listCode, setListCode] = React.useState(lists[0]?.code ?? "");
  const [item, setItem] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [from, setFrom] = React.useState("0");
  const [discount, setDiscount] = React.useState("0");
  const [validFrom, setValidFrom] = React.useState(today);
  const [party, setParty] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);

  if (!lists.length) return null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">Put a price on a list</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-6">
        <label className="block">
          <span className="sw-label">List</span>
          <select className="sw-select mt-1" value={listCode} onChange={(e) => setListCode(e.target.value)}
            aria-label="Which list to price on">
            {lists.map((l) => <option key={l.code} value={l.code}>{l.code}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="sw-label">Item</span>
          <input className="sw-input mt-1" value={item} onChange={(e) => setItem(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Unit price</span>
          <input className="sw-input sw-num mt-1" value={price} placeholder="0.00"
            onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">From quantity</span>
          <input className="sw-input sw-num mt-1" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span className="sw-sub">Nought is the base price.</span>
        </label>
        <label className="block">
          <span className="sw-label">Off, per cent</span>
          <input className="sw-input sw-num mt-1" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">From</span>
          <input type="date" className="sw-input mt-1" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
        </label>
      </div>

      {err && <div className="sw-error mt-2" role="alert">{err}</div>}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <button type="button" className="sw-btn sw-btn-primary" disabled={busy} data-testid="save-price"
          onClick={() => {
            const p = parseAmount(price, "AED");
            if (!item.trim()) { setErr("Which item?"); return; }
            if (p === null || p < 0n) { setErr("The price has to be an amount I can read."); return; }
            const d = Number(discount);
            if (!Number.isFinite(d) || d < 0 || d > 100) { setErr("The discount has to be between nought and a hundred."); return; }
            setErr(null);
            onAdd({
              listCode,
              prices: [{
                itemCode: item.trim(),
                unitPriceMinor: p.toString(),
                minQuantityMilli: String(Math.round((Number(from) || 0) * 1000)),
                discountBps: Math.round(d * 100),
                validFrom,
              }],
            });
          }}>
          {busy ? "Saving…" : "Put it on the list"}
        </button>

        <div className="flex items-end gap-2">
          <label className="block">
            <span className="sw-label">Price this party from {listCode}</span>
            <input className="sw-input mt-1" value={party} onChange={(e) => setParty(e.target.value)}
              placeholder="customer code or name" />
          </label>
          <button type="button" className="sw-btn" disabled={!party.trim()} data-testid="assign-list"
            onClick={() => onAssign(party.trim(), listCode)}>
            Assign
          </button>
        </div>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------- closing a price */

/**
 * A price is ended, never overwritten.
 *
 * The exclusion constraint refuses a second price for the same item and break
 * over the same days, so a price rise is two acts: close the old row to the
 * day before the new one starts, then put the new one on. The date offered is
 * the day before the date the screen is priced at, which is the ordinary case
 * — a rise taking effect today — and it can be changed to anything on or
 * after the day the price started.
 */
function ClosePrice({ price, suggested, busy, onClose }: {
  price: PriceRow;
  suggested: string;
  busy: boolean;
  onClose: (validTo: string) => void;
}) {
  const [validTo, setValidTo] = React.useState(suggested);
  const tooEarly = validTo !== "" && validTo < price.validFrom;

  return (
    <div className="flex items-center gap-2">
      <input type="date" className={`sw-input sw-input-sm ${tooEarly ? "sw-cell-invalid" : ""}`}
        style={{ width: "9rem" }} value={validTo}
        aria-label={`Last day ${price.itemCode} on ${price.listCode} applies`}
        onChange={(e) => setValidTo(e.target.value)} />
      <button type="button" className="sw-btn sw-btn-sm" disabled={busy || !validTo || tooEarly}
        onClick={() => onClose(validTo)}>
        {busy ? "Closing…" : "close"}
      </button>
    </div>
  );
}

/**
 * Ending a list outright.
 *
 * A list could be superseded — put a successor in and the old one closes to the
 * day before — and there was no way to simply stop one. A promotional list
 * withdrawn at the end of a month with nothing to replace it left two choices:
 * leave it in force, or delete it and lose the prices that explain last week's
 * quotes. Neither is what the person wanted.
 *
 * The date offered is the day before the date the screen is priced at, which is
 * the ordinary case, and it cannot be moved before the day the list began — a
 * list that ended before it started never priced anything, and what is wanted
 * there is to withdraw it rather than to close it.
 */
function CloseList({ list, suggested, busy, onClose }: {
  list: ListRow;
  suggested: string;
  busy: boolean;
  onClose: (validTo: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [validTo, setValidTo] = React.useState(suggested);
  const tooEarly = validTo !== "" && validTo < list.validFrom;

  if (!open) {
    return (
      <button type="button" className="sw-link-btn" onClick={() => setOpen(true)}
        aria-label={`End the price list ${list.code}`}>
        end
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <input type="date" className={`sw-input sw-input-sm ${tooEarly ? "sw-cell-invalid" : ""}`}
        style={{ width: "9rem" }} value={validTo}
        aria-label={`Last day ${list.code} applies`}
        onChange={(e) => setValidTo(e.target.value)} />
      <button type="button" className="sw-btn sw-btn-sm" disabled={busy || !validTo || tooEarly}
        onClick={() => onClose(validTo)}>
        {busy ? "Ending…" : "end it"}
      </button>
      <button type="button" className="sw-link-btn" onClick={() => setOpen(false)}>cancel</button>
    </span>
  );
}

/* ------------------------------------------------------------- the variance */

/**
 * What was charged against what the list says.
 *
 * The comparison is typed rather than swept, because what was charged lives on
 * a document and a document can be right to depart from the list — a haggle, a
 * goodwill line, a price agreed before the list changed. The report says how
 * far the departure went; whether it was justified is a conversation.
 */
function PriceVariance({ busy, on, result, onMeasure }: {
  busy: boolean;
  on: string;
  result: Variance | null;
  onMeasure: (b: {
    partyKey?: string; on: string; currency: string; kind: string;
    lines: { itemCode: string; quantityMilli: string; chargedMinor: string }[];
  }) => void;
}) {
  const [rows, setRows] = React.useState([{ item: "", quantity: "1", charged: "" }]);
  const [party, setParty] = React.useState("");
  const [currency, setCurrency] = React.useState("AED");
  const [kind, setKind] = React.useState("SELL");

  const set = (i: number, field: "item" | "quantity" | "charged", text: string) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, [field]: text } : x)));

  const parsed = rows.map((r) => ({
    item: r.item.trim(),
    quantityMilli: toMilli(r.quantity),
    chargedMinor: r.charged.trim() === "" ? null : parseAmount(r.charged, currency),
  }));
  const usable = parsed.filter((p) => p.item !== "" && p.quantityMilli !== null && p.chargedMinor !== null);

  const blocker =
    parsed.some((p) => p.item !== "" && p.quantityMilli === null)
      ? "A quantity reads in units, up to three decimal places." :
    parsed.some((p) => p.item !== "" && p.chargedMinor === null)
      ? "What was actually charged for the line, as an amount." :
    usable.length === 0 ? "Name an item, a quantity and what was charged." :
    null;

  return (
    <Panel className="mb-4 p-4">
      <div className="sw-label">What was charged against what the list says</div>
      <p className="sw-sub mt-1 max-w-[78ch]">
        A discount nobody recorded as a discount is invisible in the accounts: it shows up months later as revenue
        that was lower than expected, with no way of telling which customer or which salesperson it went to.
        Measuring a document against the list turns that into a number. A line the list does not price has no
        variance — it is not nought per cent off, it is a price nobody has an opinion about, so it is counted
        separately rather than buried in a column of zeroes.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="sw-label">Party</span>
          <input className="sw-input mt-1" value={party} placeholder="optional"
            onChange={(e) => setParty(e.target.value)} />
        </label>
        <label className="block">
          <span className="sw-label">Currency</span>
          <input className="sw-input sw-code mt-1" value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label className="block">
          <span className="sw-label">For</span>
          <select className="sw-select mt-1" value={kind} onChange={(e) => setKind(e.target.value)}
            aria-label="Which side of the trade to measure">
            <option value="SELL">selling</option>
            <option value="BUY">buying</option>
          </select>
        </label>
      </div>

      <div className="sw-scroll mt-3">
        <table className="sw-table sw-grid" style={{ maxWidth: "52rem" }}>
          <caption className="sr-only">The lines to measure against the list</caption>
          <thead>
            <tr>
              <th style={{ width: "12rem" }}>Item</th>
              <th className="sw-num" style={{ width: "8rem" }}>Quantity</th>
              <th className="sw-num" style={{ width: "10rem" }}>Charged</th>
              <th style={{ width: "5rem" }} />
            </tr>
          </thead>
          <tbody data-testid="variance-input-rows">
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input className="sw-input sw-code w-full" value={r.item} placeholder="WIDGET"
                    aria-label={`Item on line ${i + 1}`}
                    onChange={(e) => set(i, "item", e.target.value)} />
                </td>
                <td>
                  <input className={`sw-input sw-cell-num w-full ${r.quantity.trim() !== "" && toMilli(r.quantity) === null ? "sw-cell-invalid" : ""}`}
                    inputMode="decimal" value={r.quantity}
                    aria-label={`Quantity on line ${i + 1}`}
                    onChange={(e) => set(i, "quantity", e.target.value)} />
                </td>
                <td>
                  <input className={`sw-input sw-cell-num w-full ${r.charged.trim() !== "" && parseAmount(r.charged, currency) === null ? "sw-cell-invalid" : ""}`}
                    inputMode="decimal" value={r.charged} placeholder="0.00"
                    aria-label={`Charged on line ${i + 1}`}
                    onChange={(e) => set(i, "charged", e.target.value)} />
                </td>
                <td>
                  {rows.length > 1 && (
                    <button type="button" className="sw-link-btn"
                      onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                      remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className="sw-btn sw-btn-sm"
          onClick={() => setRows((r) => [...r, { item: "", quantity: "1", charged: "" }])}>
          Another line
        </button>
        <button type="button" className="sw-btn sw-btn-primary" data-testid="measure-variance"
          disabled={busy || blocker !== null}
          aria-disabled={busy || blocker !== null || undefined}
          onClick={() => {
            if (blocker) return;
            onMeasure({
              partyKey: party.trim() || undefined,
              on, currency, kind,
              lines: usable.map((p) => ({
                itemCode: p.item,
                quantityMilli: (p.quantityMilli as bigint).toString(),
                chargedMinor: (p.chargedMinor as bigint).toString(),
              })),
            });
          }}>
          {busy ? "Measuring…" : "Measure it"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid="variance-blocker">{blocker}</span>}
      </div>

      {result && (
        <div className="sw-scroll mt-3">
          <table className="sw-table">
            <caption className="sr-only">Charged against the list, line by line</caption>
            <thead>
              <tr>
                <th style={{ width: "12rem" }}>Item</th>
                <th className="sw-num" style={{ width: "7rem" }}>Quantity</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Charged</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>The list</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Variance</th>
                <th className="sw-num" style={{ width: "6rem" }}>Off</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody data-testid="variance-rows">
              {result.lines.map((l, i) => (
                <tr key={`${l.itemCode}:${i}`}>
                  <td className="sw-code">{l.itemCode}</td>
                  <td className="sw-num">{qty(l.quantityMilli)}</td>
                  <td className="sw-num"><Figure minor={l.chargedMinor} currency={currency} colour={false} /></td>
                  <td className="sw-num">
                    {l.listMinor === null
                      ? <span className="sw-sub">not priced</span>
                      : <Figure minor={l.listMinor} currency={currency} colour={false} />}
                  </td>
                  <td className="sw-num">
                    {l.listMinor === null
                      ? <span className="sw-zero">–</span>
                      : <Figure minor={l.varianceMinor} currency={currency} zero="zero" />}
                  </td>
                  <td className="sw-num">{l.varianceBps === null ? "—" : bps(l.varianceBps)}</td>
                  <td className="sw-sub">{l.why}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>
                  Priced lines
                  <span className="sw-sub"> — {result.totals.pricedLines} measured, {result.totals.unpricedLines} the
                  list has no opinion about</span>
                </td>
                <td className="sw-num" data-testid="variance-charged">
                  <Figure minor={result.totals.chargedMinor} currency={currency} zero="zero" colour={false} />
                </td>
                <td className="sw-num">
                  <Figure minor={result.totals.listMinor} currency={currency} zero="zero" colour={false} />
                </td>
                <td className="sw-num" data-testid="variance-total">
                  <Figure minor={result.totals.varianceMinor} currency={currency} zero="zero" />
                </td>
                <td className="sw-num">{result.totals.varianceBps === null ? "—" : bps(result.totals.varianceBps)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Panel>
  );
}
