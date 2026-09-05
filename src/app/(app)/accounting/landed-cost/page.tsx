"use client";

import * as React from "react";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty, StatusChip } from "@/components/ledger/primitives";
import { useAsk } from "@/components/ledger/ask";
import { fmtMinor, parseAmount } from "@/lib/ledger/format";

/* ------------------------------------------------------------------- shapes */

interface Share {
  lineNo: number;
  sku: string;
  basisWeight: string;
  allocatedMinor: string;
}
interface Charge {
  lineNo: number;
  description: string;
  amountMinor: string;
  accountCode: string;
  basis: string;
  basisLabel: string;
  shares: Share[];
}
interface Line {
  lineNo: number;
  sku: string;
  name: string;
  uom: string;
  receiptRef: string;
  quantityMilli: string;
  quantity: string;
  valueMinor: string;
  onHandMilli: string;
  onHand: string;
  soldMilli: string;
  sold: string;
  weightMilli: string | null;
  volumeMilli: string | null;
  allocatedMinor: string;
  inventoryMinor: string;
  cogsMinor: string;
  unitCostBeforeMinor: string;
  unitCostAfterMinor: string;
  unitCostLiftMinor: string;
}
interface VoucherDetail {
  number: string;
  shipmentRef: string;
  voucherDate: string;
  status: string;
  notes: string | null;
  appliedOn: string | null;
  entryId: string | null;
  chargeMinor: string;
  applied: boolean;
  refusal: string | null;
  charges: Charge[];
  lines: Line[];
  totals: { chargeMinor: string; inventoryMinor: string; cogsMinor: string };
}
interface VoucherRow {
  number: string;
  shipmentRef: string;
  voucherDate: string;
  status: string;
  appliedOn: string | null;
  chargeMinor: string;
  inventoryMinor: string;
  cogsMinor: string;
  chargeCount: number;
  lineCount: number;
}
interface Report {
  from: string;
  to: string;
  shipments: {
    shipmentRef: string;
    vouchers: { number: string; voucherDate: string; status: string; chargeMinor: string }[];
    landedMinor: string;
    unallocatedMinor: string;
    inventoryMinor: string;
    cogsMinor: string;
    items: {
      sku: string; receiptRef: string; quantity: string; valueMinor: string; allocatedMinor: string;
      unitCostBeforeMinor: string; unitCostAfterMinor: string; unitCostLiftMinor: string;
    }[];
  }[];
  unapplied: { number: string; shipmentRef: string; voucherDate: string; chargeMinor: string; lineCount: number }[];
  chargeAccounts: { code: string; name: string; balanceMinor: string; landedMinor: string; chargedMinor: string }[];
  totals: { landedMinor: string; unallocatedMinor: string; inventoryMinor: string; cogsMinor: string };
  note: string;
}
interface Measures {
  items: { sku: string; name: string; uom: string; unitWeightMilli: string | null; unitVolumeMilli: string | null }[];
}

/* ------------------------------------------------------------------ helpers */

const today = () => new Date().toISOString().slice(0, 10);
const yearStart = () => `${new Date().getUTCFullYear()}-01-01`;

/** Thousandths as a figure somebody would write: grams, litres, units alike. */
function milli(v: string | null): string {
  if (v === null || v === "") return "";
  const neg = v.startsWith("-");
  const s = (neg ? v.slice(1) : v).padStart(4, "0");
  const body = `${s.slice(0, -3)}.${s.slice(-3)}`.replace(/\.?0+$/, "");
  return `${neg ? "-" : ""}${body || "0"}`;
}

/** What somebody types into a measure box, back into thousandths. */
function parseMilli(text: string): bigint | null {
  const src = text.trim().replace(/,/g, "");
  if (src === "") return null;
  if (!/^\d+(\.\d{1,3})?$/.test(src)) return null;
  const [whole, frac = ""] = src.split(".");
  return BigInt(whole + frac.padEnd(3, "0"));
}

const BASES = [
  { value: "VALUE", label: "value of the goods" },
  { value: "QUANTITY", label: "quantity received" },
  { value: "WEIGHT", label: "shipped weight" },
  { value: "VOLUME", label: "shipped volume" },
];

interface ChargeDraft {
  description: string;
  amount: string;
  accountCode: string;
  basis: string;
}

const EMPTY_CHARGE: ChargeDraft = { description: "", amount: "", accountCode: "5200", basis: "VALUE" };

/* --------------------------------------------------------------------- page */

export default function LandedCostPage() {
  const entityId = useEntityId();
  const ask = useAsk();
  const [tab, setTab] = React.useState<"vouchers" | "report" | "measures">("vouchers");
  const [from, setFrom] = React.useState(yearStart);
  const [to, setTo] = React.useState(today);

  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const list = useLedgerQuery<{ vouchers: VoucherRow[] }>(
    entityId && tab === "vouchers" ? `/api/ledger/landed-cost?entityId=${entityId}&view=vouchers` : null,
    [tab],
  );
  const report = useLedgerQuery<Report>(
    entityId && tab === "report"
      ? `/api/ledger/landed-cost?entityId=${entityId}&from=${from}&to=${to}`
      : null,
    [tab, from, to],
  );
  const measures = useLedgerQuery<Measures>(
    entityId && tab === "measures" ? `/api/ledger/landed-cost?entityId=${entityId}&view=measures` : null,
    [tab],
  );

  const act = async <T,>(label: string, body: Record<string, unknown>): Promise<T | null> => {
    setBusy(label);
    setErr(null);
    setMsg(null);
    try {
      const r = await api<T>("/api/ledger/landed-cost", {
        method: "POST",
        body: JSON.stringify({ entityId, ...body }),
      });
      list.reload();
      if (tab === "report") report.reload();
      if (tab === "measures") measures.reload();
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
        title="Landed cost"
        sub={
          "IAS 2.10 puts freight, insurance, customs duty and handling into the cost of the goods they brought in. " +
          "Expensing them understates stock in the month the container lands and flatters the month it is sold, and " +
          "the error is largest exactly when stock is largest. Each charge follows its own basis — freight by weight " +
          "or volume, duty by value — because one basis for a whole voucher is wrong for at least one of them."
        }
        actions={
          tab === "report" ? (
            <>
              <label className="flex items-center gap-1.5">
                <span className="sw-label">From</span>
                <input type="date" className="sw-input" style={{ width: "10rem" }} value={from}
                  onChange={(e) => setFrom(e.target.value)} aria-label="Report from" />
              </label>
              <label className="flex items-center gap-1.5">
                <span className="sw-label">To</span>
                <input type="date" className="sw-input" style={{ width: "10rem" }} value={to}
                  onChange={(e) => setTo(e.target.value)} aria-label="Report to" />
              </label>
            </>
          ) : undefined
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="landed-cost-result">{msg}</div>}

      <nav className="sw-tabs mb-4" aria-label="What to show">
        <button type="button" className="sw-tab" aria-current={tab === "vouchers" ? "page" : undefined}
          onClick={() => setTab("vouchers")}>Vouchers</button>
        <button type="button" className="sw-tab" aria-current={tab === "report" ? "page" : undefined}
          onClick={() => setTab("report")}>What has been landed</button>
        <button type="button" className="sw-tab" aria-current={tab === "measures" ? "page" : undefined}
          onClick={() => setTab("measures")}>Weights and volumes</button>
      </nav>

      {tab === "vouchers" && (
        <>
          <NewVoucher
            busy={busy === "create"}
            onCreate={async (voucher) => {
              const r = await act<{ voucher: { number: string; lineCount: number } }>("create", { action: "create", voucher });
              if (r) {
                setMsg(
                  `${r.voucher.number} is raised over ${r.voucher.lineCount} ` +
                  `${r.voucher.lineCount === 1 ? "lot" : "lots"} of goods. Nothing has been posted — look at the ` +
                  `allocation, then apply it.`,
                );
                return true;
              }
              return false;
            }}
          />

          {list.error && <ErrorNote>{list.error}</ErrorNote>}
          {list.loading && !list.data && <Loading />}
          {list.data && (list.data.vouchers.length === 0
            ? <Empty>No landed cost voucher has been raised yet.</Empty>
            : (
              <Panel className="overflow-hidden">
                <div className="sw-scroll">
                  <table className="sw-table">
                    <caption className="sr-only">Landed cost vouchers and what each carried onto the goods</caption>
                    <thead>
                      <tr>
                        <th style={{ width: "8rem" }}>Voucher</th>
                        <th style={{ width: "9rem" }}>Shipment</th>
                        <th style={{ width: "7rem" }}>Date</th>
                        <th className="sw-num" style={{ width: "4rem" }}>Lots</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Charges</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Onto stock</th>
                        <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>To cost of sales</th>
                        <th style={{ width: "7rem" }}>Status</th>
                        <th style={{ width: "9rem" }} />
                      </tr>
                    </thead>
                    <tbody data-testid="voucher-rows">
                      {list.data.vouchers.map((v) => (
                        <VoucherRowView
                          key={v.number}
                          row={v}
                          entityId={entityId}
                          busy={busy}
                          onApply={async () => {
                            const r = await act<VoucherDetail>(`apply:${v.number}`, { action: "apply", number: v.number });
                            if (r) {
                              setMsg(
                                `${v.number} is applied. ${r.totals.inventoryMinor === "0" ? "Nothing" : "Cost"} ` +
                                `went onto the shelf and the rest to cost of sales, in one entry.`,
                              );
                            }
                          }}
                          onCancel={async () => {
                            const reason = await ask({
                              title: `Why is ${v.number} being cancelled?`,
                              detail:
                                `${v.number} has not been applied, so the shares it puts against each lot are a working ` +
                                "and not a posting: nothing has been capitalised, no item's unit cost has moved, and the " +
                                `${fmtMinor(v.chargeMinor, "AED", { zero: "zero" })} of charges stays in the accounts the ` +
                                "suppliers' invoices were coded to, still expensed. Cancelling drops the working and " +
                                `takes ${v.number} off the landed-cost report altogether, so those charges stop showing ` +
                                `as unallocated against ${v.shipmentRef} while the charge accounts go on carrying them — ` +
                                "raise a replacement voucher if the cost still belongs on the goods. A cancelled voucher " +
                                "cannot be applied or revived.",
                              reason: {
                                label: "Reason",
                                placeholder: "Freight invoice was for a different container",
                                hint: "Whoever finds this voucher later has only what is written here.",
                              },
                              confirmLabel: "Cancel the voucher",
                              destructive: true,
                            });
                            if (reason === null) return;
                            const r = await act(`cancel:${v.number}`, { action: "cancel", number: v.number, reason });
                            if (r) setMsg(`${v.number} is cancelled. Nothing was posted under it.`);
                          }}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            ))}

          <p className="sw-sub mt-3 max-w-[75ch]">
            Where some of a lot has already been sold, only the part still on the shelf takes the charge. The rest
            goes to cost of sales, because those goods are not inventories any more — they were derecognised when
            they were issued, and IAS 2.34 puts the cost of goods sold in the period the revenue was recognised.
            Loading the whole charge onto what is left would say the remaining units cost more than they did.
          </p>
        </>
      )}

      {tab === "report" && (
        <>
          {report.error && <ErrorNote>{report.error}</ErrorNote>}
          {report.loading && !report.data && <Loading />}
          {report.data && <ReportView data={report.data} />}
        </>
      )}

      {tab === "measures" && (
        <>
          {measures.error && <ErrorNote>{measures.error}</ErrorNote>}
          {measures.loading && !measures.data && <Loading />}
          {measures.data && (
            <MeasureTable
              data={measures.data}
              busy={busy}
              onSave={async (sku, weight, volume) => {
                const r = await act(`measure:${sku}`, {
                  action: "measure", sku,
                  unitWeightMilli: weight === null ? null : weight.toString(),
                  unitVolumeMilli: volume === null ? null : volume.toString(),
                });
                if (r) setMsg(`${sku} is recorded. Every shipment it appears on will use it.`);
              }}
            />
          )}
        </>
      )}
    </>
  );
}

/* -------------------------------------------------------- raising a voucher */

function NewVoucher({
  busy, onCreate,
}: {
  busy: boolean;
  onCreate: (voucher: Record<string, unknown>) => Promise<boolean>;
}) {
  const [open, setOpen] = React.useState(false);
  const [number, setNumber] = React.useState("");
  const [shipmentRef, setShipmentRef] = React.useState("");
  const [voucherDate, setVoucherDate] = React.useState(today);
  const [receipts, setReceipts] = React.useState("");
  const [charges, setCharges] = React.useState<ChargeDraft[]>([{ ...EMPTY_CHARGE }]);

  const parsed = charges.map((c) => parseAmount(c.amount));
  const totalMinor = parsed.reduce((a: bigint, v) => a + (v ?? 0n), 0n);
  const noteList = receipts.split(/[,\n]/).map((r) => r.trim()).filter(Boolean);

  const blocker =
    !number.trim() ? "The voucher needs a number."
      : !shipmentRef.trim() ? "It needs the shipment the charges belong to."
        : noteList.length === 0 ? "It needs the goods received notes the charges are carried onto."
          : charges.some((c) => !c.description.trim()) ? "Every charge needs a description."
            : charges.some((c) => !c.accountCode.trim()) ? "Every charge has to say which account it is sitting in."
              : parsed.some((v) => v === null || v <= 0n) ? "Every charge needs an amount above nothing."
                : null;

  const setCharge = (i: number, patch: Partial<ChargeDraft>) =>
    setCharges((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Panel className="mb-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="sw-label">Raise a voucher</h2>
        <button type="button" className="sw-link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "hide" : "open"}
        </button>
      </div>

      {open && (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="sw-label">Voucher number</span>
              <input className="sw-input mt-1 w-full" value={number} onChange={(e) => setNumber(e.target.value)}
                placeholder="LC-2026-004" aria-label="Voucher number" />
            </label>
            <label className="block">
              <span className="sw-label">Shipment or container</span>
              <input className="sw-input mt-1 w-full" value={shipmentRef} onChange={(e) => setShipmentRef(e.target.value)}
                placeholder="MSKU-449281" aria-label="Shipment or container" />
            </label>
            <label className="block">
              <span className="sw-label">Voucher date</span>
              <input type="date" className="sw-input mt-1 w-full" value={voucherDate}
                onChange={(e) => setVoucherDate(e.target.value)} aria-label="Voucher date" />
            </label>
            <label className="block">
              <span className="sw-label">Goods received notes</span>
              <input className="sw-input mt-1 w-full" value={receipts} onChange={(e) => setReceipts(e.target.value)}
                placeholder="GRN-118, GRN-119" aria-label="Goods received notes" />
            </label>
          </div>
          <p className="sw-sub mt-1">
            The notes are resolved to the stock receipts recorded under them, so the goods on the voucher are the
            same goods that debited account 1200.
          </p>

          <div className="sw-scroll mt-4">
            <table className="sw-table">
              <caption className="sr-only">The charges on this voucher</caption>
              <thead>
                <tr>
                  <th>Charge</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                  <th style={{ width: "8rem" }}>Sitting in</th>
                  <th style={{ width: "13rem" }}>Spread by</th>
                  <th style={{ width: "4rem" }} />
                </tr>
              </thead>
              <tbody data-testid="charge-rows">
                {charges.map((c, i) => (
                  <tr key={i}>
                    <td>
                      <input className="sw-input w-full" value={c.description}
                        onChange={(e) => setCharge(i, { description: e.target.value })}
                        placeholder="Ocean freight" aria-label={`Charge ${i + 1} description`} />
                    </td>
                    <td>
                      <input className="sw-input sw-cell-num w-full" inputMode="decimal" value={c.amount}
                        onChange={(e) => setCharge(i, { amount: e.target.value })}
                        placeholder="4,250.00" aria-label={`Charge ${i + 1} amount`} />
                    </td>
                    <td>
                      <input className="sw-input w-full" value={c.accountCode}
                        onChange={(e) => setCharge(i, { accountCode: e.target.value })}
                        placeholder="5200" aria-label={`Charge ${i + 1} account`} />
                    </td>
                    <td>
                      <select className="sw-select w-full" value={c.basis}
                        onChange={(e) => setCharge(i, { basis: e.target.value })}
                        aria-label={`Charge ${i + 1} basis`}>
                        {BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                      </select>
                    </td>
                    <td>
                      {charges.length > 1 && (
                        <button type="button" className="sw-link-btn"
                          onClick={() => setCharges((rows) => rows.filter((_, j) => j !== i))}
                          aria-label={`Remove charge ${i + 1}`}>
                          remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td className="sw-num"><Figure minor={totalMinor.toString()} colour={false} /></td>
                  <td colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" className="sw-btn sw-btn-sm"
              onClick={() => setCharges((rows) => [...rows, { ...EMPTY_CHARGE }])}>
              Add a charge
            </button>
            <button
              type="button"
              className="sw-btn sw-btn-primary"
              data-testid="raise-voucher"
              aria-disabled={blocker !== null || busy || undefined}
              disabled={blocker !== null || busy}
              onClick={async () => {
                const ok = await onCreate({
                  number: number.trim(),
                  shipmentRef: shipmentRef.trim(),
                  voucherDate,
                  receipts: noteList,
                  charges: charges.map((c, i) => ({
                    description: c.description.trim(),
                    amountMinor: (parsed[i] as bigint).toString(),
                    accountCode: c.accountCode.trim(),
                    basis: c.basis,
                  })),
                });
                if (ok) {
                  setNumber("");
                  setShipmentRef("");
                  setReceipts("");
                  setCharges([{ ...EMPTY_CHARGE }]);
                }
              }}
            >
              {busy ? "Raising…" : "Raise the voucher"}
            </button>
            {blocker && <span className="sw-sub" role="status">{blocker}</span>}
          </div>
        </>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------- one voucher, opened */

function VoucherRowView({
  row, entityId, busy, onApply, onCancel,
}: {
  row: VoucherRow;
  entityId: string;
  busy: string | null;
  onApply: () => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const [open, setOpen] = React.useState(false);
  const detail = useLedgerQuery<VoucherDetail>(
    open ? `/api/ledger/landed-cost?entityId=${entityId}&view=voucher&number=${encodeURIComponent(row.number)}` : null,
    [open, row.status, busy === null],
  );

  return (
    <>
      <tr>
        <td className="sw-code">{row.number}</td>
        <td className="sw-code">{row.shipmentRef}</td>
        <td>{row.voucherDate}</td>
        <td className="sw-num">{row.lineCount}</td>
        <td className="sw-num"><Figure minor={row.chargeMinor} colour={false} /></td>
        <td className="sw-num">
          {row.status === "applied" ? <Figure minor={row.inventoryMinor} colour={false} /> : <span className="sw-sub">not yet</span>}
        </td>
        <td className="sw-num">
          {row.status === "applied" ? <Figure minor={row.cogsMinor} colour={false} /> : <span className="sw-sub">not yet</span>}
        </td>
        <td><StatusChip status={row.status} /></td>
        <td>
          {row.status === "draft" && (
            <>
              <button type="button" className="sw-link-btn" disabled={busy === `apply:${row.number}`} onClick={onApply}>
                apply
              </button>
              {" "}
              <button type="button" className="sw-link-btn" disabled={busy === `cancel:${row.number}`} onClick={onCancel}>
                cancel
              </button>
              {" "}
            </>
          )}
          <button type="button" className="sw-link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "hide" : "allocation"}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={9} style={{ background: "var(--sw-ground)" }}>
            {detail.loading && !detail.data && <Loading />}
            {detail.error && <ErrorNote>{detail.error}</ErrorNote>}
            {detail.data && <Allocation v={detail.data} />}
          </td>
        </tr>
      )}
    </>
  );
}

function Allocation({ v }: { v: VoucherDetail }) {
  return (
    <div className="p-2">
      {v.refusal && <ErrorNote>{v.refusal}</ErrorNote>}

      <div className="sw-scroll">
        <table className="sw-table" style={{ maxWidth: "44rem" }}>
          <caption className="sr-only">The charges on {v.number} and how each is spread</caption>
          <thead>
            <tr>
              <th>Charge</th>
              <th style={{ width: "8rem" }}>Sitting in</th>
              <th style={{ width: "12rem" }}>Spread by</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
            </tr>
          </thead>
          <tbody data-testid="allocation-charges">
            {v.charges.map((c) => (
              <tr key={c.lineNo}>
                <td>{c.description}</td>
                <td className="sw-code">{c.accountCode}</td>
                <td className="sw-sub">{c.basisLabel}</td>
                <td className="sw-num"><Figure minor={c.amountMinor} colour={false} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={3}>Total</th>
              <td className="sw-num"><Figure minor={v.totals.chargeMinor} colour={false} /></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {v.lines.length > 0 && (
        <div className="sw-scroll mt-3">
          <table className="sw-table">
            <caption className="sr-only">What each lot of goods took, and what it did to the unit cost</caption>
            <thead>
              <tr>
                <th style={{ width: "8rem" }}>SKU</th>
                <th style={{ width: "8rem" }}>Note</th>
                <th className="sw-num" style={{ width: "6rem" }}>Received</th>
                <th className="sw-num" style={{ width: "6rem" }}>Still here</th>
                <th className="sw-num" style={{ width: "6rem" }}>Sold</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Allocated</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Onto stock</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>To cost of sales</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit cost before</th>
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit cost after</th>
              </tr>
            </thead>
            <tbody data-testid="allocation-lines">
              {v.lines.map((l) => (
                <tr key={l.lineNo}>
                  <td className="sw-code">{l.sku}</td>
                  <td className="sw-code">{l.receiptRef}</td>
                  <td className="sw-num">{l.quantity}</td>
                  <td className="sw-num">{l.onHand}</td>
                  <td className="sw-num">{l.sold}</td>
                  <td className="sw-num"><Figure minor={l.allocatedMinor} colour={false} /></td>
                  <td className="sw-num"><Figure minor={l.inventoryMinor} colour={false} /></td>
                  <td className="sw-num"><Figure minor={l.cogsMinor} colour={false} /></td>
                  <td className="sw-num"><Figure minor={l.unitCostBeforeMinor} colour={false} /></td>
                  <td className="sw-num"><Figure minor={l.unitCostAfterMinor} colour={false} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={5}>Total</th>
                <td className="sw-num"><Figure minor={v.totals.chargeMinor} colour={false} /></td>
                <td className="sw-num"><Figure minor={v.totals.inventoryMinor} colour={false} /></td>
                <td className="sw-num"><Figure minor={v.totals.cogsMinor} colour={false} /></td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="sw-sub mt-2 max-w-[75ch]">
        {v.applied
          ? "These are the figures that were posted, read back from the voucher. The shelf has moved on since, and " +
            "recomputing them would show figures that never reached the ledger."
          : "Worked against the stock as it stands, so this is what will be posted if the voucher is applied now."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------- report */

function ReportView({ data }: { data: Report }) {
  return (
    <>
      <Panel className="mb-4 p-4">
        <dl className="grid gap-4 sm:grid-cols-4">
          <div>
            <dt className="sw-label">Landed onto goods</dt>
            <dd className="sw-num mt-1 text-lg" data-testid="landed-total">
              <Figure minor={data.totals.landedMinor} colour={false} />
            </dd>
          </div>
          <div>
            <dt className="sw-label">Of it, onto stock still held</dt>
            <dd className="sw-num mt-1 text-lg"><Figure minor={data.totals.inventoryMinor} colour={false} /></dd>
          </div>
          <div>
            <dt className="sw-label">And to cost of sales</dt>
            <dd className="sw-num mt-1 text-lg"><Figure minor={data.totals.cogsMinor} colour={false} /></dd>
            <p className="sw-sub mt-0.5">The share of goods that had already been sold.</p>
          </div>
          <div>
            <dt className="sw-label">Raised but not applied</dt>
            <dd className="sw-num mt-1 text-lg" data-testid="unallocated-total">
              <Figure minor={data.totals.unallocatedMinor} colour={false} />
            </dd>
          </div>
        </dl>
      </Panel>

      {data.shipments.length === 0 ? (
        <Empty>No landed cost voucher between {data.from} and {data.to}.</Empty>
      ) : (
        data.shipments.map((s) => (
          <Panel key={s.shipmentRef} className="mb-4 overflow-hidden">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2">
              <h2 className="sw-code">{s.shipmentRef}</h2>
              <p className="sw-sub">
                {s.vouchers.map((v) => `${v.number} (${v.status})`).join(", ")}
              </p>
            </div>
            <div className="sw-scroll">
              <table className="sw-table">
                <caption className="sr-only">What was landed onto {s.shipmentRef}</caption>
                <thead>
                  <tr>
                    <th style={{ width: "9rem" }}>SKU</th>
                    <th style={{ width: "9rem" }}>Note</th>
                    <th className="sw-num" style={{ width: "6rem" }}>Received</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cost on arrival</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Landed onto it</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit cost before</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Unit cost after</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Lift</th>
                  </tr>
                </thead>
                <tbody data-testid={`shipment-${s.shipmentRef}`}>
                  {s.items.length === 0 ? (
                    <tr><td colSpan={8} className="sw-sub">Nothing has been landed onto this shipment yet.</td></tr>
                  ) : s.items.map((i) => (
                    <tr key={`${i.sku}:${i.receiptRef}`}>
                      <td className="sw-code">{i.sku}</td>
                      <td className="sw-code">{i.receiptRef}</td>
                      <td className="sw-num">{i.quantity}</td>
                      <td className="sw-num"><Figure minor={i.valueMinor} colour={false} /></td>
                      <td className="sw-num"><Figure minor={i.allocatedMinor} colour={false} /></td>
                      <td className="sw-num"><Figure minor={i.unitCostBeforeMinor} colour={false} /></td>
                      <td className="sw-num"><Figure minor={i.unitCostAfterMinor} colour={false} /></td>
                      <td className="sw-num"><Figure minor={i.unitCostLiftMinor} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={4}>Landed</th>
                    <td className="sw-num"><Figure minor={s.landedMinor} colour={false} /></td>
                    <td colSpan={3} className="sw-sub">
                      {s.unallocatedMinor === "0"
                        ? "Nothing left waiting on this shipment."
                        : "Still to be applied on this shipment."}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Panel>
        ))
      )}

      {data.unapplied.length > 0 && (
        <Panel className="mb-4 overflow-hidden">
          <h2 className="sw-label px-3 py-2">Raised, not yet applied</h2>
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">Vouchers raised but not carried onto the goods</caption>
              <thead>
                <tr>
                  <th style={{ width: "9rem" }}>Voucher</th>
                  <th style={{ width: "9rem" }}>Shipment</th>
                  <th style={{ width: "8rem" }}>Date</th>
                  <th className="sw-num" style={{ width: "4rem" }}>Lots</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Charges</th>
                </tr>
              </thead>
              <tbody data-testid="unapplied-rows">
                {data.unapplied.map((u) => (
                  <tr key={u.number}>
                    <td className="sw-code">{u.number}</td>
                    <td className="sw-code">{u.shipmentRef}</td>
                    <td>{u.voucherDate}</td>
                    <td className="sw-num">{u.lineCount}</td>
                    <td className="sw-num"><Figure minor={u.chargeMinor} colour={false} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {data.chargeAccounts.length > 0 && (
        <Panel className="overflow-hidden">
          <h2 className="sw-label px-3 py-2">The accounts the charges sat in</h2>
          <div className="sw-scroll">
            <table className="sw-table">
              <caption className="sr-only">What went through each charge account and how much of it was landed</caption>
              <thead>
                <tr>
                  <th style={{ width: "6rem" }}>Code</th>
                  <th>Account</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Charged in the period</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Landed out of it</th>
                  <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Left in the account</th>
                </tr>
              </thead>
              <tbody data-testid="charge-accounts">
                {data.chargeAccounts.map((a) => (
                  <tr key={a.code}>
                    <td className="sw-code">{a.code}</td>
                    <td>{a.name}</td>
                    <td className="sw-num"><Figure minor={a.chargedMinor} colour={false} /></td>
                    <td className="sw-num"><Figure minor={a.landedMinor} colour={false} /></td>
                    <td className="sw-num"><Figure minor={a.balanceMinor} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="sw-sub px-3 py-2 max-w-[75ch]">{data.note}</p>
        </Panel>
      )}
    </>
  );
}

/* ------------------------------------------------------- weights and volumes */

function MeasureTable({
  data, busy, onSave,
}: {
  data: Measures;
  busy: string | null;
  onSave: (sku: string, weight: bigint | null, volume: bigint | null) => Promise<void>;
}) {
  const [draft, setDraft] = React.useState<Record<string, { w: string; v: string }>>({});

  const value = (sku: string, field: "w" | "v", stored: string | null) =>
    draft[sku]?.[field] ?? milli(stored);

  const set = (sku: string, field: "w" | "v", stored: Measures["items"][number], text: string) =>
    setDraft((d) => ({
      ...d,
      [sku]: {
        w: field === "w" ? text : d[sku]?.w ?? milli(stored.unitWeightMilli),
        v: field === "v" ? text : d[sku]?.v ?? milli(stored.unitVolumeMilli),
      },
    }));

  if (data.items.length === 0) {
    return (
      <Empty>
        No stock item has been set up, so there is nothing to weigh or measure. Add items on the inventory screen
        and they appear here — a freight bill cannot be spread by weight until something has one.
      </Empty>
    );
  }

  return (
    <>
      <Panel className="overflow-hidden">
        <div className="sw-scroll">
          <table className="sw-table">
            <caption className="sr-only">What one unit of each item weighs and how much room it takes</caption>
            <thead>
              <tr>
                <th style={{ width: "9rem" }}>SKU</th>
                <th>Item</th>
                <th style={{ width: "5rem" }}>Unit</th>
                <th className="sw-num" style={{ width: "9rem" }}>Weight (g)</th>
                <th className="sw-num" style={{ width: "9rem" }}>Volume (l)</th>
                <th style={{ width: "6rem" }} />
              </tr>
            </thead>
            <tbody data-testid="measure-rows">
              {data.items.map((i) => {
                const w = value(i.sku, "w", i.unitWeightMilli);
                const v = value(i.sku, "v", i.unitVolumeMilli);
                const bad = (t: string) => t.trim() !== "" && parseMilli(t) === null;
                return (
                  <tr key={i.sku}>
                    <td className="sw-code">{i.sku}</td>
                    <td className="max-w-0 truncate">{i.name}</td>
                    <td className="sw-sub">{i.uom}</td>
                    <td>
                      <input
                        className={`sw-input sw-cell-num w-full ${bad(w) ? "sw-cell-invalid" : ""}`}
                        inputMode="decimal" value={w} placeholder="—"
                        aria-label={`Weight in grams of one ${i.sku}`}
                        onChange={(e) => set(i.sku, "w", i, e.target.value)} />
                    </td>
                    <td>
                      <input
                        className={`sw-input sw-cell-num w-full ${bad(v) ? "sw-cell-invalid" : ""}`}
                        inputMode="decimal" value={v} placeholder="—"
                        aria-label={`Volume in litres of one ${i.sku}`}
                        onChange={(e) => set(i.sku, "v", i, e.target.value)} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="sw-link-btn"
                        disabled={busy === `measure:${i.sku}` || bad(w) || bad(v)}
                        onClick={() => onSave(i.sku, parseMilli(w), parseMilli(v))}
                      >
                        save
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <p className="sw-sub mt-3 max-w-[75ch]">
        A freight bill spread by weight over an item with no weight recorded would give that item a free ride, and
        every other item on the shipment would carry its share. So a missing figure is refused by name rather than
        read as nothing. Both are facts about the item rather than about any one shipment, which is why they are
        recorded once here.
      </p>
    </>
  );
}
