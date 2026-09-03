"use client";

import * as React from "react";
import Link from "next/link";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";

interface Box { box: string; label: string; amountMinor: string; vatMinor: string | null; adjustmentMinor: string | null }
interface Outside { taxCode: string; label: string; amountMinor: string; note: string }
interface Ret {
  periodFrom: string; periodTo: string; currency: string;
  sales: Box[]; expenses: Box[];
  outsideTheReturn: Outside[];
  totalOutputVatMinor: string; totalInputVatMinor: string; netVatMinor: string; payable: boolean;
  reconciliation: { outputVatPerLedgerMinor: string; inputVatPerLedgerMinor: string; outputMatches: boolean; inputMatches: boolean };
  warnings: string[];
}

/** Quarters as the FTA runs them, plus the current month for monthly filers. */
function periodsFor(year: number) {
  const q = [
    { label: `${year} Q1`, from: `${year}-01-01`, to: `${year}-03-31` },
    { label: `${year} Q2`, from: `${year}-04-01`, to: `${year}-06-30` },
    { label: `${year} Q3`, from: `${year}-07-01`, to: `${year}-09-30` },
    { label: `${year} Q4`, from: `${year}-10-01`, to: `${year}-12-31` },
  ];
  const m = Array.from({ length: 12 }, (_, i) => {
    const mm = String(i + 1).padStart(2, "0");
    const last = new Date(Date.UTC(year, i + 1, 0)).getUTCDate();
    return { label: `${year}-${mm}`, from: `${year}-${mm}-01`, to: `${year}-${mm}-${last}` };
  });
  return [...q, ...m];
}

export default function VatReturnPage() {
  const entityId = useEntityId();
  const year = new Date().getUTCFullYear();
  const periods = React.useMemo(() => periodsFor(year), [year]);
  const [sel, setSel] = React.useState(() => {
    const q = Math.floor(new Date().getUTCMonth() / 3);
    return periodsFor(new Date().getUTCFullYear())[q].label;
  });
  const period = periods.find((p) => p.label === sel) ?? periods[0];

  const { data, error, loading } = useLedgerQuery<Ret>(
    entityId ? `/api/ledger/vat?entityId=${entityId}&from=${period.from}&to=${period.to}` : null,
  );

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="VAT return"
        sub="The VAT 201 boxes, computed from the same journal lines as the trial balance rather than from a second pass over the invoices — so the return and the books cannot disagree. Review it, then file with the FTA."
        actions={
          <label className="flex items-center gap-2">
            <span className="sw-label">Period</span>
            <select className="sw-select" style={{ width: "9rem" }} value={sel} onChange={(e) => setSel(e.target.value)}>
              <optgroup label="Quarters">
                {periods.slice(0, 4).map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
              </optgroup>
              <optgroup label="Months">
                {periods.slice(4).map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
              </optgroup>
            </select>
          </label>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading />}

      {data && (
        <>
          {data.warnings.map((w, i) => (
            <div key={i} className="sw-error mb-3" role="alert" data-testid="vat-warning">{w}</div>
          ))}

          <div className="grid gap-4 lg:grid-cols-2">
            <BoxTable title="VAT on sales and all other outputs" rows={data.sales} currency={data.currency} />
            <BoxTable title="VAT on expenses and all other inputs" rows={data.expenses} currency={data.currency} />
          </div>

          <OutsideTheReturn rows={data.outsideTheReturn} currency={data.currency} />

          <Panel className="mt-4 p-4">
            <div className="sw-label">Net VAT due</div>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <Stat label="Box 12 — total output tax" value={<Figure minor={data.totalOutputVatMinor} currency={data.currency} zero="zero" colour={false} />} />
              <Stat label="Box 13 — total input tax" value={<Figure minor={data.totalInputVatMinor} currency={data.currency} zero="zero" colour={false} />} />
              <Stat
                label={data.payable ? "Box 14 — payable to the FTA" : "Box 14 — reclaimable from the FTA"}
                value={<Figure minor={data.netVatMinor} currency={data.currency} zero="zero" />}
              />
            </div>
            <p className="sw-sub mt-3">
              {data.payable
                ? "This is what you owe for the period."
                : "Input tax exceeded output tax, so this period is a reclaim rather than a payment."}
            </p>
          </Panel>

          <Panel className="mt-4 p-4">
            <div className="sw-label">Reconciliation to the ledger</div>
            <p className="sw-sub mt-1.5 max-w-[70ch]">
              These are the same figures summed a second way, straight off the control accounts. They have to agree —
              if they ever do not, the return is wrong and should not be filed.
            </p>
            <table className="sw-table mt-3" style={{ maxWidth: "34rem" }}>
              <caption className="sr-only">The return against the VAT control accounts in the ledger</caption>
              <tbody>
                <Recon
                  label="Output tax"
                  account="2100"
                  ret={data.totalOutputVatMinor}
                  ledger={data.reconciliation.outputVatPerLedgerMinor}
                  ok={data.reconciliation.outputMatches}
                  currency={data.currency}
                />
                <Recon
                  label="Input tax"
                  account="1350"
                  ret={data.totalInputVatMinor}
                  ledger={data.reconciliation.inputVatPerLedgerMinor}
                  ok={data.reconciliation.inputMatches}
                  currency={data.currency}
                />
              </tbody>
            </table>
          </Panel>

          <p className="sw-sub mt-3">
            Period {data.periodFrom} to {data.periodTo}. This computes the return; filing it is a
            separate act, taken on figures you have looked at.
          </p>
        </>
      )}
    </>
  );
}

function BoxTable({ title, rows, currency }: { title: string; rows: Box[]; currency: string }) {
  // The Adjustment column appears only where a box on this side of the form has
  // one. An empty fourth column on the sales table would read as "no
  // adjustments" when what it means is "not reported here".
  const hasAdjustments = rows.some((b) => b.adjustmentMinor !== null);
  return (
    <Panel className="overflow-hidden">
      <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
        <span className="sw-label">{title}</span>
      </div>
      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              <th style={{ width: "3.5rem" }}>Box</th>
              <th>Description</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
              <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>VAT</th>
              {hasAdjustments && (
                <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Adjustment</th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.box}>
                <td className="sw-code">{b.box}</td>
                <td>{b.label}</td>
                <td className="sw-num"><Figure minor={b.amountMinor} currency={currency} colour={false} /></td>
                <td className="sw-num">
                  {b.vatMinor === null
                    ? <span className="sw-zero" title="This box carries no VAT">–</span>
                    : <Figure minor={b.vatMinor} currency={currency} colour={false} />}
                </td>
                {hasAdjustments && (
                  <td className="sw-num" data-testid={`vat-adjustment-${b.box}`}>
                    {b.adjustmentMinor === null
                      ? <span className="sw-zero" title="No adjustment column is reported for this box">–</span>
                      : <Figure minor={b.adjustmentMinor} currency={currency} colour={false} />}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasAdjustments && (
        <p className="sw-sub border-t px-3 py-2" style={{ borderColor: "var(--sw-line)" }}>
          An adjustment is tax that belongs to this period without a supply of this period behind it — a capital
          asset adjustment under Articles 57 and 58 of the Executive Regulation. It has its own column so that it is
          never shown as tax on expenses nobody incurred. It is already inside the totals below.
        </p>
      )}
    </Panel>
  );
}

/**
 * Supplies that reached the books under a treatment no box of the VAT 201
 * carries. Shown rather than dropped: a figure that is on none of the boxes is
 * still a figure somebody has to be able to find, and the panel is where the
 * revenue in the books ties back to the revenue on the return.
 */
function OutsideTheReturn({ rows, currency }: { rows: Outside[]; currency: string }) {
  const shown = rows.filter((r) => BigInt(r.amountMinor) !== 0n);
  if (!shown.length) return null;
  return (
    <Panel className="mt-4 p-4">
      <div className="sw-label">Outside the return</div>
      <p className="sw-sub mt-1.5 max-w-[70ch]">
        These supplies are on the books for the period and on none of the boxes above. They are not zero rated —
        a zero-rated supply is inside the scope of UAE VAT at a rate of nothing, and these are outside it
        altogether.
      </p>
      <table className="sw-table mt-3">
        <caption className="sr-only">Supplies that belong on no box of the return</caption>
        <tbody>
          {shown.map((r) => (
            <tr key={r.taxCode} data-testid={`vat-outside-${r.taxCode}`}>
              <td>
                {r.label}
                <p className="sw-sub mt-1 max-w-[70ch]">{r.note}</p>
              </td>
              <td className="sw-num" style={{ width: "var(--sw-col-amount)", verticalAlign: "top" }}>
                <Figure minor={r.amountMinor} currency={currency} colour={false} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

function Recon({ label, account, ret, ledger, ok, currency }: {
  label: string; account: string; ret: string; ledger: string; ok: boolean; currency: string;
}) {
  return (
    <tr>
      <td>{label}</td>
      <td className="sw-num"><Figure minor={ret} currency={currency} zero="zero" colour={false} /></td>
      <td className="sw-code" style={{ textAlign: "center" }}>vs</td>
      <td className="sw-num"><Figure minor={ledger} currency={currency} zero="zero" colour={false} /></td>
      <td>
        <Link href={`/accounting/accounts/${account}`} className="sw-link">{account}</Link>{" "}
        <span className={`sw-chip ${ok ? "sw-chip-ok" : "sw-chip-bad"}`}>{ok ? "agrees" : "differs"}</span>
      </td>
    </tr>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="sw-label">{label}</div>
      <div className="mt-0.5 text-[1.0625rem] font-semibold tabular-nums">{value}</div>
    </div>
  );
}
