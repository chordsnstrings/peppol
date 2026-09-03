"use client";

import * as React from "react";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

interface Line {
  on: string; amountMinor: string; label: string; source: string;
  firmness: "committed" | "expected" | "estimated"; ref: string | null; shiftedDays?: number;
}
interface Bucket {
  from: string; to: string;
  inMinor: string; outMinor: string; netMinor: string; closingMinor: string;
  lines: Line[];
}
interface Forecast {
  from: string; to: string; bucket: "week" | "month"; basis: "due" | "behaviour";
  currency: string; openingMinor: string; buckets: Bucket[]; closingMinor: string;
  shortfallOn: string | null; shortfallMinor: string | null;
  gaps: { source: string; reason: string }[];
}
interface Payload {
  forecast: Forecast;
  position: { asOf: string; totalMinor: string; accounts: { code: string; name: string; balanceMinor: string }[] };
}

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** What each word means, said once, where the reader meets it. */
const FIRMNESS: Record<Line["firmness"], string> = {
  committed: "already agreed — a payment run waiting to be released",
  expected: "an invoice on its terms; whether it is paid on time is not certain",
  estimated: "not raised yet — a recurring charge or a tax that will fall due",
};

const SOURCE_LABEL: Record<string, string> = {
  ar: "Customer receipts",
  ap: "Supplier bills",
  payment_run: "Payment run",
  recurring: "Recurring",
  vat: "VAT",
};

export default function ForecastPage() {
  const entityId = useEntityId();
  const [from, setFrom] = React.useState(today);
  const [to, setTo] = React.useState(() => plusDays(90));
  const [bucket, setBucket] = React.useState<"week" | "month">("week");
  const [basis, setBasis] = React.useState<"due" | "behaviour">("due");
  const [openBucket, setOpenBucket] = React.useState<string | null>(null);

  const url = entityId
    ? `/api/ledger/forecast?entityId=${entityId}&from=${from}&to=${to}&bucket=${bucket}&basis=${basis}`
    : null;
  const { data, error, loading } = useLedgerQuery<Payload>(url);

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const f = data?.forecast;

  return (
    <>
      <PageHead
        title="Cash flow forecast"
        sub={
          "The cash flow statement says where the money went. This says where it is going — which is the question a " +
          "business actually loses sleep over. Everything here is a projection, and every line says how firm it is: " +
          "money already agreed, an invoice on its terms, or a charge that has not been raised yet."
        }
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">From</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={from}
                onChange={(e) => setFrom(e.target.value)} aria-label="Forecast from" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">To</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={to}
                onChange={(e) => setTo(e.target.value)} aria-label="Forecast to" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">By</span>
              <select className="sw-select" style={{ width: "7rem" }} value={bucket}
                onChange={(e) => setBucket(e.target.value as "week" | "month")} aria-label="Bucket size">
                <option value="week">week</option>
                <option value="month">month</option>
              </select>
            </label>
          </>
        }
      />

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && !data && <Loading />}

      {data && f && (
        <>
          <Panel className="mb-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="sw-label">Cash today</div>
                <div className="sw-num mt-1 text-2xl" data-testid="cash-now">
                  <Figure minor={data.position.totalMinor} colour={false} />
                </div>
                <ul className="mt-2 space-y-0.5">
                  {data.position.accounts.map((a) => (
                    <li key={a.code} className="sw-sub">
                      <span className="sw-code">{a.code}</span> {a.name} —{" "}
                      <span className="sw-num"><Figure minor={a.balanceMinor} colour={false} /></span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="sw-label">Projected at {f.to}</div>
                <div className="sw-num mt-1 text-2xl" data-testid="cash-projected">
                  <Figure minor={f.closingMinor} />
                </div>
                {f.shortfallOn ? (
                  <p className="sw-sub mt-2 max-w-[34ch]" style={{ color: "var(--sw-neg)" }} data-testid="shortfall">
                    On this projection the cash runs out in the week to {f.shortfallOn}, short by{" "}
                    <span className="sw-num"><Figure minor={(f.shortfallMinor ?? "0").replace("-", "")} colour={false} /></span>.
                  </p>
                ) : (
                  <p className="sw-sub mt-2 max-w-[34ch]">The projection stays above nothing throughout.</p>
                )}
              </div>
              <div>
                <div className="sw-label">Basis</div>
                <div className="mt-1 flex gap-1">
                  <button type="button" className="sw-btn sw-btn-sm" aria-pressed={basis === "due"}
                    onClick={() => setBasis("due")}>On terms</button>
                  <button type="button" className="sw-btn sw-btn-sm" aria-pressed={basis === "behaviour"}
                    onClick={() => setBasis("behaviour")} data-testid="basis-behaviour">On past behaviour</button>
                </div>
                <p className="sw-sub mt-2 max-w-[34ch]">
                  Terms say when an invoice falls due. Past behaviour says when this customer has actually paid, every
                  time before. Forecasting on terms alone is forecasting on a promise nobody has kept.
                </p>
              </div>
            </div>
          </Panel>

          {f.gaps.length > 0 && (
            <Panel className="mb-4 p-3">
              <div className="sw-label">Not projected</div>
              <ul className="mt-1.5 space-y-0.5" data-testid="forecast-gaps">
                {f.gaps.map((g) => (
                  <li key={g.source} className="sw-sub">
                    <span className="sw-code">{SOURCE_LABEL[g.source] ?? g.source}</span> — {g.reason}
                  </li>
                ))}
              </ul>
              <p className="sw-sub mt-2 max-w-[70ch]">
                These are missing from the figures above rather than counted as nil. A forecast that quietly drops a
                source reads as a smaller problem than it is.
              </p>
            </Panel>
          )}

          {f.buckets.every((b) => b.lines.length === 0) ? (
            <Empty>Nothing is expected to move between {f.from} and {f.to}.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <div className="sw-scroll">
                <table className="sw-table">
                  <caption className="sr-only">Projected cash movements by {f.bucket}</caption>
                  <thead>
                    <tr>
                      <th style={{ width: "13rem" }}>{f.bucket === "week" ? "Week to" : "Month to"}</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>In</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Out</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Net</th>
                      <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Cash after</th>
                      <th style={{ width: "5rem" }} />
                    </tr>
                  </thead>
                  <tbody data-testid="forecast-rows">
                    {f.buckets.map((b) => (
                      <React.Fragment key={b.from}>
                        <tr>
                          <th scope="row" style={{ textAlign: "start", fontWeight: 400 }}>
                            {b.to} <span className="sw-sub">from {b.from}</span>
                          </th>
                          <td className="sw-num"><Figure minor={b.inMinor} colour={false} zero="dash" /></td>
                          <td className="sw-num"><Figure minor={(b.outMinor || "0").replace("-", "")} colour={false} zero="dash" /></td>
                          <td className="sw-num"><Figure minor={b.netMinor} zero="dash" /></td>
                          <td className="sw-num"><Figure minor={b.closingMinor} /></td>
                          <td>
                            {b.lines.length > 0 && (
                              <button type="button" className="sw-link-btn"
                                aria-expanded={openBucket === b.from}
                                onClick={() => setOpenBucket(openBucket === b.from ? null : b.from)}>
                                {openBucket === b.from ? "Hide" : `${b.lines.length}`}
                              </button>
                            )}
                          </td>
                        </tr>
                        {openBucket === b.from && (
                          <tr>
                            <td colSpan={6} style={{ background: "var(--sw-ground)" }}>
                              <table className="sw-table" style={{ maxWidth: "52rem", margin: "0.5rem" }}>
                                <caption className="sr-only">What makes up the week to {b.to}</caption>
                                <thead>
                                  <tr>
                                    <th style={{ width: "7rem" }}>Date</th>
                                    <th>What</th>
                                    <th style={{ width: "9rem" }}>Where from</th>
                                    <th style={{ width: "8rem" }}>How firm</th>
                                    <th className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {b.lines.map((l, i) => (
                                    <tr key={`${l.ref ?? l.label}-${i}`}>
                                      <td>{l.on}</td>
                                      <td className="max-w-0 truncate">
                                        {l.label}
                                        {l.shiftedDays !== undefined && (
                                          <span className="sw-sub">
                                            {" "}— moved {l.shiftedDays > 0 ? `${l.shiftedDays} days later` : `${-l.shiftedDays} days earlier`} on past behaviour
                                          </span>
                                        )}
                                      </td>
                                      <td className="sw-sub">{SOURCE_LABEL[l.source] ?? l.source}</td>
                                      <td>
                                        <span className="sw-chip" title={FIRMNESS[l.firmness]}>{l.firmness}</span>
                                      </td>
                                      <td className="sw-num"><Figure minor={l.amountMinor} /></td>
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
                  <tfoot>
                    <tr>
                      <th scope="row" style={{ textAlign: "start" }}>Opening cash</th>
                      <td colSpan={3} />
                      <td className="sw-num"><Figure minor={f.openingMinor} /></td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </Panel>
          )}

          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            {(Object.keys(FIRMNESS) as Line["firmness"][]).map((k) => (
              <div key={k}>
                <dt><span className="sw-chip">{k}</span></dt>
                <dd className="sw-sub mt-1">{FIRMNESS[k]}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </>
  );
}
