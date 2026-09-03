"use client";

import * as React from "react";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Empty, Loading } from "@/components/ledger/primitives";

/**
 * Comparatives — two columns and what moved between them.
 *
 * The design rule this page leans on hardest is the one in the stylesheet's
 * header: a value carries colour on numerals only and always with parentheses,
 * a status may colour prose and chrome, and the two never meet. A variance is a
 * value, so the movement column is parenthesised and tinted and nothing else on
 * the row is; the sentence about a missing comparative is a status, so it gets
 * the note rail and no figure gets tinted for it.
 *
 * The common-size proportions are a toggle rather than a second page because
 * they are the same statement read a second way, and a reader comparing two
 * years wants the proportion beside the amount rather than in another tab. The
 * table gets wider; that is what `sw-scroll` is for. Dense is correct here.
 */

interface Movement {
  currentMinor: string;
  priorMinor: string | null;
  movementMinor: string | null;
  movementBps: number | null;
  reason: "no_comparative" | "nil_base" | "negative_base" | null;
}
interface CLine extends Movement { code: string; name: string; nameAr: string | null }
interface CSection extends Movement { key: string; label: string; lines: CLine[] }
interface CFigure extends Movement { key: string; label: string }

interface CPL {
  currency: string;
  against: string;
  current: { from: string; to: string };
  prior: { from: string; to: string } | null;
  comparativeAbsent: boolean;
  absenceReason: string | null;
  revenue: CSection; costOfSales: CSection; expenses: CSection;
  grossProfit: CFigure; netProfit: CFigure;
  grossMargin: { currentBps: number | null; priorBps: number | null; movementBpsPoints: number | null };
}
interface CBS {
  currency: string;
  current: { asOf: string };
  prior: { asOf: string } | null;
  comparativeAbsent: boolean;
  absenceReason: string | null;
  assets: CSection; liabilities: CSection; equity: CSection;
  totalAssets: CFigure; totalLiabilitiesAndEquity: CFigure; currentYearEarnings: CFigure;
  balanced: { current: boolean; prior: boolean | null };
}

interface SizeSection {
  key: string; label: string; totalMinor: string; totalBps: number | null;
  lines: { code: string; name: string; amountMinor: string; bps: number | null }[];
}
interface SizeStatement {
  baseLabel: string; baseMinor: string; computable: boolean; note: string | null;
  sections: SizeSection[];
  memos: { key: string; label: string; amountMinor: string; bps: number | null }[];
}
interface CommonSize { profitAndLoss: SizeStatement; balanceSheet: SizeStatement }

interface RatioTerm { label: string; value: string | null; unit: "MONEY" | "DAYS" }
interface Ratio {
  key: string; label: string; unit: "PERCENT" | "TIMES" | "DAYS";
  valueBps: number | null; op: "divide" | "less";
  numerator: RatioTerm; denominator: RatioTerm; factor: number;
  basis: string; computable: boolean; undefinedReason: string | null; interpretation: string;
}
interface RatioSet { asOf: string; from: string; days: number; currency: string; ratios: Ratio[]; warnings: string[] }

interface TrendMonth {
  month: string; from: string; to: string; partial: boolean;
  revenueMinor: string; grossProfitMinor: string; netProfitMinor: string; cashMinor: string;
  revenueMovementMinor: string | null; revenueMovementBps: number | null;
  revenueMovementReason: Movement["reason"];
}
interface Trend { currency: string; months: TrendMonth[] }

interface Payload {
  profitAndLoss: CPL;
  balanceSheet: CBS;
  commonSize: { current: CommonSize; prior: CommonSize | null };
  ratios: RatioSet;
  trend: Trend;
}

const REASON: Record<NonNullable<Movement["reason"]>, string> = {
  no_comparative: "There is no comparative period to measure against.",
  nil_base: "The prior figure is nil, so there is no base to take a percentage of. That is not a change of nothing per cent.",
  negative_base:
    "The prior figure is negative. A percentage change against a negative base reverses its own meaning — a loss becoming a smaller loss reads as a fall — so none is given. The movement in money is exact.",
};

function thisYear() {
  const now = new Date();
  const y = now.getUTCFullYear();
  return { from: `${y}-01-01`, to: now.toISOString().slice(0, 10) };
}

/**
 * A rate as a percentage. Negative reads in parentheses and in Falu red, like
 * every other value on the page; a rate that could not be computed is an en
 * dash with the reason on it, never a nought.
 */
function Rate({ bps, reason, suffix = "%" }: { bps: number | null; reason?: Movement["reason"]; suffix?: string }) {
  if (bps === null) {
    return (
      <span className="sw-zero" title={reason ? REASON[reason] : "This rate has no base to be a rate of."}>
        –
      </span>
    );
  }
  const neg = bps < 0;
  const body = `${(Math.abs(bps) / 100).toFixed(2)}${suffix}`;
  return <span className={neg ? "sw-num-neg" : ""}>{neg ? `(${body})` : body}</span>;
}

/** A ×10,000 figure as a plain multiple or day count. */
function Scaled({ value, suffix }: { value: number | null; suffix: string }) {
  if (value === null) return <span className="sw-zero">–</span>;
  const neg = value < 0;
  const body = `${(Math.abs(value) / 10_000).toFixed(2)}${suffix}`;
  return <span className={neg ? "sw-num-neg" : ""}>{neg ? `(${body})` : body}</span>;
}

/** Proportions keyed by section and account code, so a row can find its own. */
function sizeIndex(statement: SizeStatement | undefined): Map<string, number | null> {
  const index = new Map<string, number | null>();
  if (!statement) return index;
  for (const s of statement.sections) {
    index.set(`${s.key}:total`, s.totalBps);
    for (const l of s.lines) index.set(`${s.key}:${l.code}`, l.bps);
  }
  for (const m of statement.memos) index.set(`memo:${m.key}`, m.bps);
  return index;
}

export default function ComparativesPage() {
  const entityId = useEntityId();
  const [range, setRange] = React.useState(thisYear);
  const [against, setAgainst] = React.useState<"prior_year" | "prior_period" | "explicit">("prior_year");
  const [explicit, setExplicit] = React.useState({ from: "", to: "" });
  const [sized, setSized] = React.useState(false);

  const explicitReady = against !== "explicit" || Boolean(explicit.from && explicit.to);
  const query =
    entityId && explicitReady
      ? `/api/ledger/comparatives?entityId=${entityId}&from=${range.from}&to=${range.to}&against=${against}` +
        (against === "explicit" ? `&priorFrom=${explicit.from}&priorTo=${explicit.to}` : "")
      : null;
  const { data, error, loading } = useLedgerQuery<Payload>(query);

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const pl = data?.profitAndLoss;
  const bs = data?.balanceSheet;
  const nowSize = data?.commonSize.current;
  const thenSize = data?.commonSize.prior ?? undefined;

  const status = !data
    ? loading
      ? "Reading the ledger."
      : "Nothing loaded yet."
    : pl?.comparativeAbsent
      ? `${range.from} to ${range.to}, with no comparative period.`
      : `${range.from} to ${range.to}, against ${pl?.prior?.from} to ${pl?.prior?.to}.` +
        (sized ? " Common-size proportions shown." : "");

  return (
    <>
      <PageHead
        title="Comparatives"
        sub="The same statement for two periods, side by side, with what moved between them. A set of accounts nobody can compare with anything is a set of accounts nobody can read."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">From</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">To</span>
              <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={range.to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Against</span>
              <select className="sw-select" style={{ width: "10rem" }} value={against}
                onChange={(e) => setAgainst(e.target.value as typeof against)}>
                <option value="prior_year">Prior year</option>
                <option value="prior_period">Prior period</option>
                <option value="explicit">Chosen dates</option>
              </select>
            </label>
            {against === "explicit" && (
              <>
                <label className="flex items-center gap-1.5">
                  <span className="sw-label">Prior from</span>
                  <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={explicit.from}
                    onChange={(e) => setExplicit((x) => ({ ...x, from: e.target.value }))} />
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="sw-label">Prior to</span>
                  <input type="date" className="sw-input" style={{ width: "9.5rem" }} value={explicit.to}
                    onChange={(e) => setExplicit((x) => ({ ...x, to: e.target.value }))} />
                </label>
              </>
            )}
            <button type="button" className="sw-btn" aria-pressed={sized} data-testid="common-size-toggle"
              onClick={() => setSized((v) => !v)}>
              Common size
            </button>
          </>
        }
      />

      <p className="sw-sub mb-3" role="status" aria-live="polite" data-testid="comparatives-status">{status}</p>

      {error && <ErrorNote>{error}</ErrorNote>}
      {loading && <Loading />}
      {!explicitReady && <Empty>Choose both ends of the comparative period.</Empty>}

      {pl?.comparativeAbsent && pl.absenceReason && (
        <div className="mb-3">
          <Empty>
            <strong>No comparative period.</strong> {pl.absenceReason}
          </Empty>
        </div>
      )}

      {pl && bs && (
        <div className="grid gap-4">
          <Panel className="overflow-hidden">
            <Head>
              Profit and loss — {pl.current.from} to {pl.current.to}
              {pl.prior && <> against {pl.prior.from} to {pl.prior.to}</>}
            </Head>
            <div className="sw-scroll">
              <CompareTable
                caption={`Comparative profit and loss for ${pl.current.from} to ${pl.current.to}`}
                currency={pl.currency}
                sections={[pl.revenue, pl.costOfSales, pl.expenses]}
                footers={[pl.grossProfit, pl.netProfit]}
                sized={sized}
                now={sizeIndex(nowSize?.profitAndLoss)}
                then={sizeIndex(thenSize?.profitAndLoss)}
                memoKeys={{ gross_profit: "memo:gross_profit", net_profit: "memo:net_profit" }}
                absent={pl.comparativeAbsent}
                sizeNote={nowSize?.profitAndLoss.note ?? null}
                sizeBase={nowSize?.profitAndLoss.baseLabel ?? "Revenue"}
              />
            </div>
            <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid="margin-note">
              Gross margin <Rate bps={pl.grossMargin.currentBps} /> against{" "}
              <Rate bps={pl.grossMargin.priorBps} reason={pl.comparativeAbsent ? "no_comparative" : undefined} />
              {pl.grossMargin.movementBpsPoints !== null && (
                <>
                  {" "}— a movement of <Rate bps={pl.grossMargin.movementBpsPoints} suffix=" points" />. The change in a
                  margin is a difference in basis points, not a percentage change of a percentage.
                </>
              )}
            </p>
          </Panel>

          <Panel className="overflow-hidden">
            <Head>
              Balance sheet as at {bs.current.asOf}
              {bs.prior && <> against {bs.prior.asOf}</>}
            </Head>
            <div className="sw-scroll">
              <CompareTable
                caption={`Comparative balance sheet as at ${bs.current.asOf}`}
                currency={bs.currency}
                sections={[bs.assets, bs.liabilities, bs.equity]}
                footers={[bs.totalAssets, bs.totalLiabilitiesAndEquity]}
                sized={sized}
                now={sizeIndex(nowSize?.balanceSheet)}
                then={sizeIndex(thenSize?.balanceSheet)}
                memoKeys={{ total_assets: "assets:total", total_liabilities_and_equity: "memo:total_liabilities_and_equity" }}
                absent={bs.comparativeAbsent}
                sizeNote={nowSize?.balanceSheet.note ?? null}
                sizeBase={nowSize?.balanceSheet.baseLabel ?? "Total assets"}
              />
            </div>
            {(!bs.balanced.current || bs.balanced.prior === false) && (
              <div className="px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
                <ErrorNote>
                  {bs.balanced.current ? "The comparative column" : "This sheet"} does not balance. Every posting path is
                  checked by a database constraint, so this indicates a defect — please report it rather than adjusting
                  to fit.
                </ErrorNote>
              </div>
            )}
          </Panel>

          {data && <RatioPanel set={data.ratios} />}
          {data && <TrendPanel trend={data.trend} />}
        </div>
      )}
    </>
  );
}

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------- the two columns -- */

function CompareTable({
  caption, currency, sections, footers, sized, now, then, memoKeys, absent, sizeNote, sizeBase,
}: {
  caption: string;
  currency: string;
  sections: CSection[];
  footers: CFigure[];
  sized: boolean;
  now: Map<string, number | null>;
  then: Map<string, number | null>;
  memoKeys: Record<string, string>;
  absent: boolean;
  sizeNote: string | null;
  sizeBase: string;
}) {
  const cols = sized ? 8 : 6;
  return (
    <table className="sw-table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col" style={{ width: "5rem" }}>Code</th>
          <th scope="col">Account</th>
          <th scope="col" className="sw-num">This period</th>
          {sized && <th scope="col" className="sw-num" title={`As a proportion of ${sizeBase.toLowerCase()}`}>% of base</th>}
          <th scope="col" className="sw-num">Comparative</th>
          {sized && <th scope="col" className="sw-num" title={`As a proportion of ${sizeBase.toLowerCase()}`}>% of base</th>}
          <th scope="col" className="sw-num">Movement</th>
          <th scope="col" className="sw-num">Change</th>
        </tr>
      </thead>

      {sized && sizeNote && (
        <tbody>
          <tr>
            <td colSpan={cols} className="sw-sub">{sizeNote}</td>
          </tr>
        </tbody>
      )}

      {sections.map((section) => (
        <tbody key={section.key}>
          <tr>
            <td colSpan={cols} style={{ background: "var(--sw-surface-2)", height: "1.75rem" }}>
              <span className="sw-label">{section.label}</span>
            </td>
          </tr>
          {section.lines.length === 0 && (
            <tr><td colSpan={cols} className="sw-sub" style={{ paddingInlineStart: "1.5rem" }}>Nothing in either period</td></tr>
          )}
          {section.lines.map((line) => (
            <tr key={line.code}>
              <td className="sw-code">{line.code}</td>
              <td>{line.name}</td>
              <Amounts row={line} currency={currency} sized={sized} absent={absent}
                nowBps={now.get(`${section.key}:${line.code}`) ?? null}
                thenBps={then.get(`${section.key}:${line.code}`) ?? null} />
            </tr>
          ))}
          <tr>
            <th scope="row" colSpan={2} style={{ textAlign: "end", fontWeight: 600 }}>
              Total {section.label.toLowerCase()}
            </th>
            <Amounts row={section} currency={currency} sized={sized} absent={absent} bold
              nowBps={now.get(`${section.key}:total`) ?? null}
              thenBps={then.get(`${section.key}:total`) ?? null} />
          </tr>
        </tbody>
      ))}

      <tfoot>
        {footers.map((f) => (
          <tr key={f.key}>
            <th scope="row" colSpan={2} style={{ textAlign: "end" }}>{f.label}</th>
            <Amounts row={f} currency={currency} sized={sized} absent={absent} testid={f.key}
              nowBps={now.get(memoKeys[f.key] ?? "") ?? null}
              thenBps={then.get(memoKeys[f.key] ?? "") ?? null} />
          </tr>
        ))}
      </tfoot>
    </table>
  );
}

/**
 * The five (or seven) figure cells of a row.
 *
 * An absent comparative renders an en dash rather than a nought in every prior
 * and movement cell. The difference is the whole point: a nought asserts that
 * the business traded nothing, and a dash says nobody knows because there was
 * no period.
 */
function Amounts({
  row, currency, sized, absent, nowBps, thenBps, bold, testid,
}: {
  row: Movement;
  currency: string;
  sized: boolean;
  absent: boolean;
  nowBps: number | null;
  thenBps: number | null;
  bold?: boolean;
  testid?: string;
}) {
  const weight = bold ? { fontWeight: 600 } : undefined;
  return (
    <>
      <td className="sw-num" style={{ ...weight, width: "var(--sw-col-amount)" }} data-testid={testid ? `${testid}-current` : undefined}>
        <Figure minor={row.currentMinor} currency={currency} zero="zero" colour={false} />
      </td>
      {sized && <td className="sw-num" style={weight}><Rate bps={nowBps} /></td>}
      <td className="sw-num" style={{ ...weight, width: "var(--sw-col-amount)" }} data-testid={testid ? `${testid}-prior` : undefined}>
        {row.priorMinor === null
          ? <span className="sw-zero" title={REASON.no_comparative}>–</span>
          : <Figure minor={row.priorMinor} currency={currency} zero="zero" colour={false} />}
      </td>
      {sized && <td className="sw-num" style={weight}>{absent ? <span className="sw-zero">–</span> : <Rate bps={thenBps} />}</td>}
      <td className="sw-num" style={{ ...weight, width: "var(--sw-col-amount)" }} data-testid={testid ? `${testid}-movement` : undefined}>
        {row.movementMinor === null
          ? <span className="sw-zero" title={REASON.no_comparative}>–</span>
          : <Figure minor={row.movementMinor} currency={currency} zero="zero" />}
      </td>
      <td className="sw-num" style={weight}>
        <Rate bps={row.movementBps} reason={row.reason} />
      </td>
    </>
  );
}

/* -------------------------------------------------------------- ratios --- */

function Term({ term }: { term: RatioTerm }) {
  if (term.value === null) return <span className="sw-zero" title="This term is itself undefined.">–</span>;
  if (term.unit === "DAYS") return <Scaled value={Number(term.value)} suffix=" days" />;
  return <Figure minor={term.value} zero="zero" colour={false} />;
}

function RatioValue({ ratio }: { ratio: Ratio }) {
  if (ratio.valueBps === null) return <span className="sw-zero" title={ratio.undefinedReason ?? undefined}>–</span>;
  if (ratio.unit === "PERCENT") return <Rate bps={ratio.valueBps} />;
  return <Scaled value={ratio.valueBps} suffix={ratio.unit === "DAYS" ? " days" : "×"} />;
}

function RatioPanel({ set }: { set: RatioSet }) {
  return (
    <Panel className="overflow-hidden">
      <Head>
        Ratios as at {set.asOf} — flows measured over {set.from} to {set.asOf} ({set.days} days)
      </Head>
      {set.warnings.map((w) => (
        <div key={w} className="px-3 pt-2"><Empty>{w}</Empty></div>
      ))}
      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">Financial ratios as at {set.asOf}, each with the figures it was computed from</caption>
          <thead>
            <tr>
              <th scope="col">Ratio</th>
              <th scope="col" className="sw-num">Value</th>
              <th scope="col">Numerator</th>
              <th scope="col" className="sw-num">Amount</th>
              <th scope="col">Denominator</th>
              <th scope="col" className="sw-num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {set.ratios.map((r) => (
              <React.Fragment key={r.key}>
                <tr>
                  <th scope="row" style={{ fontWeight: 600 }}>
                    {r.label}
                    {!r.computable && <span className="sw-chip sw-chip-warn ms-2">undefined</span>}
                  </th>
                  <td className="sw-num" data-testid={`ratio-${r.key}-value`}><RatioValue ratio={r} /></td>
                  <td>
                    {r.numerator.label}
                    {r.factor !== 1 && <span className="sw-sub"> × {r.factor} days</span>}
                  </td>
                  <td className="sw-num"><Term term={r.numerator} /></td>
                  <td>
                    <span className="sw-sub">{r.op === "divide" ? "÷ " : "− "}</span>
                    {r.denominator.label}
                  </td>
                  <td className="sw-num"><Term term={r.denominator} /></td>
                </tr>
                <tr>
                  <td colSpan={6} className="sw-sub" style={{ paddingBottom: "0.4rem" }}>
                    {r.interpretation}
                  </td>
                </tr>
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* --------------------------------------------------------------- trend --- */

function TrendPanel({ trend }: { trend: Trend }) {
  // The bar is chrome, not a value: it carries no meaning the figure beside it
  // does not already carry, and it is drawn in the accent tint rather than in
  // either of the value colours.
  const peak = trend.months.reduce((a, m) => {
    const v = BigInt(m.revenueMinor);
    return v > a ? v : a;
  }, 1n);

  return (
    <Panel className="overflow-hidden">
      <Head>Month by month</Head>
      <div className="sw-scroll">
        <table className="sw-table">
          <caption className="sr-only">Revenue, gross profit, net profit and cash by month</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col" className="sw-num">Revenue</th>
              <th scope="col" className="sw-num">Change</th>
              <th scope="col" style={{ width: "8rem" }}>Relative</th>
              <th scope="col" className="sw-num">Gross profit</th>
              <th scope="col" className="sw-num">Net profit</th>
              <th scope="col" className="sw-num">Cash at month end</th>
            </tr>
          </thead>
          <tbody>
            {trend.months.map((m) => {
              const share = Number((BigInt(m.revenueMinor) * 100n) / (peak > 0n ? peak : 1n));
              return (
                <tr key={m.month}>
                  <th scope="row" style={{ fontWeight: 400 }}>
                    {m.month}
                    {m.partial && <span className="sw-sub ms-2">to {m.to}</span>}
                  </th>
                  <td className="sw-num" data-testid={`trend-${m.month}-revenue`}>
                    <Figure minor={m.revenueMinor} currency={trend.currency} colour={false} />
                  </td>
                  <td className="sw-num">
                    <Rate bps={m.revenueMovementBps} reason={m.revenueMovementReason} />
                  </td>
                  <td>
                    <div aria-hidden="true" style={{ height: "0.5rem", background: "var(--sw-surface-2)" }}>
                      <div style={{
                        width: `${Math.max(0, Math.min(100, share))}%`,
                        height: "100%",
                        background: "var(--sw-accent-soft)",
                        borderInlineEnd: share > 0 ? "2px solid var(--sw-accent)" : undefined,
                      }} />
                    </div>
                  </td>
                  <td className="sw-num"><Figure minor={m.grossProfitMinor} currency={trend.currency} /></td>
                  <td className="sw-num"><Figure minor={m.netProfitMinor} currency={trend.currency} /></td>
                  <td className="sw-num"><Figure minor={m.cashMinor} currency={trend.currency} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }}>
        Cash sits beside profit on purpose. The two come apart exactly when it matters most — a growing business
        funding its own growth out of working capital is profitable and running out of money at the same time.
      </p>
    </Panel>
  );
}
