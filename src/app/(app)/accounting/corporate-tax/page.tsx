"use client";

import * as React from "react";
import Link from "next/link";
import { api, ApiError, useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading } from "@/components/ledger/primitives";

interface Adjustment {
  key: string;
  label: string;
  basis: string;
  amountMinor: string;
  origin: "derived" | "supplied" | "none";
  accounts: string[];
  note: string;
}

interface Computation {
  periodFrom: string;
  periodTo: string;
  currency: string;
  accountingProfitMinor: string;
  adjustments: Adjustment[];
  totalAddBacksMinor: string;
  totalDeductionsMinor: string;
  taxableIncomeBeforeReliefMinor: string;
  taxableIncomeMinor: string;
  smallBusinessRelief: {
    elected: boolean;
    applied: boolean;
    eligible: boolean;
    revenueMinor: string;
    thresholdMinor: string;
    priorPeriods: { label: string; revenueMinor: string; exceeds: boolean }[];
    reason: string;
  };
  interestLimitation: {
    netInterestExpenditureMinor: string;
    adjustedEbitdaMinor: string;
    thirtyPercentOfEbitdaMinor: string;
    deMinimisMinor: string;
    capMinor: string;
    capBasis: "de-minimis" | "ebitda";
    disallowedMinor: string;
    supplied: boolean;
  };
  zeroBandMinor: string;
  taxedBandMinor: string;
  taxPayableMinor: string;
  /** BigInt basis points, serialised as a string. */
  effectiveRateBps: string | null;
  provision: {
    expenseAccount: string;
    payableAccount: string;
    expensePerLedgerMinor: string;
    payableMovementPerLedgerMinor: string;
    posted: boolean;
    matches: boolean;
    differenceMinor: string;
  };
  warnings: string[];
}

/** The figures the chart of accounts cannot produce on its own. */
const SUPPLIED: { field: string; label: string; hint: string }[] = [
  { field: "finesAndPenaltiesMinor", label: "Fines and penalties", hint: "Inside 6300 — not deductible (Art. 33)" },
  { field: "entertainmentMinor", label: "Entertainment spend", hint: "Narrows the 50% add-back taken from 6400" },
  { field: "nonQualifyingDonationsMinor", label: "Non-qualifying donations", hint: "Not deductible (Art. 33)" },
  { field: "exemptIncomeMinor", label: "Exempt income", hint: "Dividends and participations (Art. 22-23)" },
  { field: "netInterestExpenditureMinor", label: "Net interest expenditure", hint: "For the Art. 30 cap" },
];

const ORIGIN_TONE: Record<Adjustment["origin"], string> = {
  derived: "sw-chip-ok",
  supplied: "sw-chip-warn",
  none: "",
};

/** Minor units from a decimal the user types. Blank stays blank — not zero. */
function toMinor(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  return `${whole}${frac.padEnd(2, "0")}`.replace(/^0+(?=\d)/, "");
}

export default function CorporateTaxPage() {
  const entityId = useEntityId();
  const thisYear = new Date().getUTCFullYear();
  const [year, setYear] = React.useState(() => String(thisYear));
  const [elect, setElect] = React.useState(false);
  const [figures, setFigures] = React.useState<Record<string, string>>({});
  const [applied, setApplied] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const query = React.useMemo(() => {
    const p = new URLSearchParams({ entityId: entityId ?? "", from: `${year}-01-01`, to: `${year}-12-31` });
    if (elect) p.set("smallBusinessRelief", "true");
    for (const [k, v] of Object.entries(applied)) if (v) p.set(k, v);
    return p.toString();
  }, [entityId, year, elect, applied]);

  const { data, error, loading, reload } = useLedgerQuery<Computation>(
    entityId ? `/api/ledger/corptax?${query}` : null,
    [query],
  );

  const provision = async () => {
    if (!data) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api<{ reference: string; amountMinor: string; expenseAccount: string; alreadyPosted: boolean; warnings: string[] }>(
        "/api/ledger/corptax",
        { method: "POST", body: JSON.stringify({ entityId, fiscalYear: year, amountMinor: data.taxPayableMinor }) },
      );
      setMsg(
        r.alreadyPosted
          ? `${year} was already provided for as ${r.reference}. Nothing was posted.`
          : `Posted ${r.reference} — Dr ${r.expenseAccount}, Cr ${data.provision.payableAccount}.` +
            (r.warnings.length ? ` ${r.warnings.join(" ")}` : ""),
      );
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  if (!entityId) return <Loading label="Choosing an entity…" />;

  return (
    <>
      <PageHead
        title="Corporate tax"
        sub="Federal Decree-Law 47/2022: nil on the first AED 375,000 of taxable income, 9% above it. The computation starts at the accounting profit shown by these books and adjusts it, so the tax and the accounts cannot tell different stories."
        actions={
          <label className="flex items-center gap-2">
            <span className="sw-label">Tax period</span>
            <select
              className="sw-select"
              style={{ width: "7rem" }}
              value={year}
              onChange={(e) => setYear(e.target.value)}
              data-testid="ct-year"
            >
              {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
        }
      />

      {err && <ErrorNote>{err}</ErrorNote>}
      {msg && <div className="sw-note mb-3" role="status" data-testid="ct-provision-result">{msg}</div>}
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {data && (
        <>
          {data.warnings.map((w, i) => (
            <div key={i} className="sw-error mb-3" role="alert" data-testid="ct-warning">{w}</div>
          ))}

          <Panel className="overflow-hidden">
            <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
              <span className="sw-label">Accounting profit to taxable income</span>
            </div>
            <div className="sw-scroll">
              <table className="sw-table" data-testid="ct-computation">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th style={{ width: "7rem" }}>Figure</th>
                    <th>Basis and how it was arrived at</th>
                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Accounting profit for the period</td>
                    <td><span className="sw-chip sw-chip-ok">from the ledger</span></td>
                    <td className="sw-sub">
                      Article 20 — the taxable income of a period starts at the accounting income shown by the
                      financial statements. Taken from{" "}
                      <Link href="/accounting/statements" className="sw-link">the profit and loss</Link>, not recomputed.
                    </td>
                    <td className="sw-num" data-testid="ct-accounting-profit">
                      <Figure minor={data.accountingProfitMinor} currency={data.currency} zero="zero" />
                    </td>
                  </tr>
                  {data.adjustments.map((a) => (
                    <tr key={a.key} data-testid={`ct-adj-${a.key}`}>
                      <td>{a.label}</td>
                      <td>
                        <span className={`sw-chip ${ORIGIN_TONE[a.origin]}`}>
                          {a.origin === "derived" ? "derived" : a.origin === "supplied" ? "you supplied" : "none"}
                        </span>
                      </td>
                      <td className="sw-sub">
                        {a.basis}{" "}
                        <span style={{ display: "block" }}>
                          {a.note}
                          {a.accounts.map((c) => (
                            <span key={c}>
                              {" "}
                              <Link href={`/accounting/accounts/${c}`} className="sw-link">{c}</Link>
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="sw-num">
                        <Figure minor={a.amountMinor} currency={data.currency} zero="dash" />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3}><strong>Taxable income</strong></td>
                    <td className="sw-num" data-testid="ct-taxable-income">
                      <strong><Figure minor={data.taxableIncomeMinor} currency={data.currency} zero="zero" /></strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Panel className="p-4">
              <div className="sw-label">Tax payable</div>
              <table className="sw-table mt-3">
                <tbody>
                  <tr>
                    <td>First AED 375,000 at 0%</td>
                    <td className="sw-num" data-testid="ct-zero-band">
                      <Figure minor={data.zeroBandMinor} currency={data.currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                  <tr>
                    <td>Excess at 9%</td>
                    <td className="sw-num" data-testid="ct-taxed-band">
                      <Figure minor={data.taxedBandMinor} currency={data.currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                  <tr>
                    <td><strong>Corporate tax</strong></td>
                    <td className="sw-num" data-testid="ct-tax-payable">
                      <strong><Figure minor={data.taxPayableMinor} currency={data.currency} zero="zero" /></strong>
                    </td>
                  </tr>
                  <tr>
                    <td>Effective rate on taxable income</td>
                    <td className="sw-num" data-testid="ct-effective-rate">
                      {data.effectiveRateBps === null
                        ? <span className="sw-zero" title="No taxable income to take a rate of">–</span>
                        : `${(Number(data.effectiveRateBps) / 100).toFixed(2)}%`}
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="sw-sub mt-3">
                Computed in basis points as whole numbers. A rate that has been through a floating-point number is a
                rate that disagrees with itself at the fourth decimal.
              </p>
            </Panel>

            <Panel className="p-4">
              <div className="sw-label">Small Business Relief — an election</div>
              <p className="sw-sub mt-1.5">
                Ministerial Decision 73/2023 lets a resident person with revenue at or below AED 3,000,000, in this
                period and every previous one, elect to be treated as having no taxable income. It is a claim made in
                the return, never an automatic result, so nothing here applies it until you ask.
              </p>
              <label className="mt-3 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={elect}
                  onChange={(e) => setElect(e.target.checked)}
                  data-testid="ct-elect-sbr"
                />
                <span>Elect Small Business Relief for {year}</span>
              </label>
              <table className="sw-table mt-3">
                <tbody>
                  <tr>
                    <td>Revenue this period</td>
                    <td className="sw-num" data-testid="ct-sbr-revenue">
                      <Figure minor={data.smallBusinessRelief.revenueMinor} currency={data.currency} zero="zero" colour={false} />
                    </td>
                  </tr>
                  <tr>
                    <td>Threshold</td>
                    <td className="sw-num">
                      <Figure minor={data.smallBusinessRelief.thresholdMinor} currency={data.currency} colour={false} />
                    </td>
                  </tr>
                  {data.smallBusinessRelief.priorPeriods.map((p) => (
                    <tr key={p.label}>
                      <td>
                        Revenue in {p.label}{" "}
                        <span className={`sw-chip ${p.exceeds ? "sw-chip-bad" : "sw-chip-ok"}`}>
                          {p.exceeds ? "over" : "under"}
                        </span>
                      </td>
                      <td className="sw-num">
                        <Figure minor={p.revenueMinor} currency={data.currency} zero="zero" colour={false} />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>Status</td>
                    <td>
                      <span className={`sw-chip ${data.smallBusinessRelief.applied ? "sw-chip-ok" : data.smallBusinessRelief.eligible ? "sw-chip-warn" : "sw-chip-bad"}`} data-testid="ct-sbr-status">
                        {data.smallBusinessRelief.applied ? "applied" : data.smallBusinessRelief.eligible ? "available" : "not available"}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="sw-sub mt-3" data-testid="ct-sbr-reason">{data.smallBusinessRelief.reason}</p>
            </Panel>
          </div>

          <Panel className="mt-4 p-4">
            <div className="sw-label">Adjustments this ledger cannot derive</div>
            <p className="sw-sub mt-1.5 max-w-[70ch]">
              A chart of accounts cannot tell a fine from a licence fee, or entertaining a customer from flying to
              see one. Anything entered here is marked <em>you supplied</em> in the computation above and never
              presented as though the books had produced it. Amounts in {data.currency}.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {SUPPLIED.map((f) => (
                <label key={f.field} className="block">
                  <span className="sw-label">{f.label}</span>
                  <input
                    className="sw-input mt-1 w-full"
                    inputMode="decimal"
                    placeholder="—"
                    value={figures[f.field] ?? ""}
                    onChange={(e) => setFigures((s) => ({ ...s, [f.field]: e.target.value }))}
                    data-testid={`ct-input-${f.field}`}
                  />
                  <span className="sw-sub">{f.hint}</span>
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                className="sw-btn"
                data-testid="ct-apply-figures"
                onClick={() => {
                  const next: Record<string, string> = {};
                  for (const f of SUPPLIED) {
                    const m = toMinor(figures[f.field] ?? "");
                    if (m !== null) next[f.field] = m;
                  }
                  setApplied(next);
                }}
              >
                Recompute with these figures
              </button>
              {Object.keys(applied).length > 0 && (
                <button type="button" className="sw-btn" onClick={() => { setFigures({}); setApplied({}); }}>
                  Clear
                </button>
              )}
            </div>
          </Panel>

          <Panel className="mt-4 p-4">
            <div className="sw-label">Interest deduction limitation</div>
            <p className="sw-sub mt-1.5 max-w-[70ch]">
              Article 30 caps deductible net interest at the greater of 30% of adjusted EBITDA and AED 12,000,000
              (Ministerial Decision 126/2023). The cap in force this period is the{" "}
              {data.interestLimitation.capBasis === "ebitda" ? "EBITDA test" : "AED 12,000,000 de minimis"}.
            </p>
            <table className="sw-table mt-3" style={{ maxWidth: "34rem" }}>
              <tbody>
                <tr>
                  <td>Net interest expenditure {data.interestLimitation.supplied ? "(you supplied)" : "(none supplied)"}</td>
                  <td className="sw-num">
                    <Figure minor={data.interestLimitation.netInterestExpenditureMinor} currency={data.currency} zero="zero" colour={false} />
                  </td>
                </tr>
                <tr>
                  <td>Adjusted EBITDA</td>
                  <td className="sw-num">
                    <Figure minor={data.interestLimitation.adjustedEbitdaMinor} currency={data.currency} zero="zero" colour={false} />
                  </td>
                </tr>
                <tr>
                  <td>30% of adjusted EBITDA</td>
                  <td className="sw-num">
                    <Figure minor={data.interestLimitation.thirtyPercentOfEbitdaMinor} currency={data.currency} zero="zero" colour={false} />
                  </td>
                </tr>
                <tr>
                  <td>Cap applied</td>
                  <td className="sw-num" data-testid="ct-interest-cap">
                    <Figure minor={data.interestLimitation.capMinor} currency={data.currency} zero="zero" colour={false} />
                  </td>
                </tr>
                <tr>
                  <td>Disallowed and added back</td>
                  <td className="sw-num" data-testid="ct-interest-disallowed">
                    <Figure minor={data.interestLimitation.disallowedMinor} currency={data.currency} zero="zero" />
                  </td>
                </tr>
              </tbody>
            </table>
          </Panel>

          <Panel className="mt-4 p-4">
            <div className="sw-label">The provision, against the books</div>
            <p className="sw-sub mt-1.5 max-w-[70ch]">
              The charge computed above against what the ledger already carries — the same figures summed a second
              way. They have to agree, and if they do not, that is visible here rather than at a year-end review.
            </p>
            <table className="sw-table mt-3" style={{ maxWidth: "40rem" }}>
              <tbody>
                <tr>
                  <td>Computed corporate tax</td>
                  <td className="sw-num"><Figure minor={data.taxPayableMinor} currency={data.currency} zero="zero" colour={false} /></td>
                  <td className="sw-code" style={{ textAlign: "center" }}>vs</td>
                  <td className="sw-num"><Figure minor={data.provision.expensePerLedgerMinor} currency={data.currency} zero="zero" colour={false} /></td>
                  <td>
                    <Link href={`/accounting/accounts/${data.provision.expenseAccount}`} className="sw-link">
                      {data.provision.expenseAccount}
                    </Link>{" "}
                    <span className={`sw-chip ${data.provision.matches ? "sw-chip-ok" : "sw-chip-bad"}`} data-testid="ct-provision-status">
                      {data.provision.matches ? "agrees" : data.provision.posted ? "differs" : "not provided for"}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td>Liability recognised</td>
                  <td className="sw-num"><Figure minor={data.taxPayableMinor} currency={data.currency} zero="zero" colour={false} /></td>
                  <td className="sw-code" style={{ textAlign: "center" }}>vs</td>
                  <td className="sw-num"><Figure minor={data.provision.payableMovementPerLedgerMinor} currency={data.currency} zero="zero" colour={false} /></td>
                  <td>
                    <Link href={`/accounting/accounts/${data.provision.payableAccount}`} className="sw-link">
                      {data.provision.payableAccount}
                    </Link>
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                className="sw-btn"
                disabled={busy || BigInt(data.taxPayableMinor) <= 0n || data.provision.posted}
                onClick={provision}
                data-testid="ct-post-provision"
              >
                {busy ? "Posting…" : `Post the ${year} provision`}
              </button>
              <span className="sw-sub">
                Dr {data.provision.expenseAccount} corporate tax expense, Cr {data.provision.payableAccount} corporate
                tax payable, in the year&rsquo;s adjustment period. Posting twice does nothing the second time.
              </span>
            </div>
          </Panel>

          <p className="sw-sub mt-3" data-testid="ct-not-filed">
            Tax period {data.periodFrom} to {data.periodTo}. This computes the corporate tax; it does not file it.
            The return goes to the FTA through EmaraTax, as an act a human takes on figures they have looked at.
            Free zone status, tax groups, transfer pricing and loss carry-forward are not modelled here.
          </p>
        </>
      )}
    </>
  );
}
