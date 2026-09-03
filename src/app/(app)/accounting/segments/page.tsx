"use client";

import * as React from "react";
import Link from "next/link";
import { useEntityId, useLedgerQuery } from "@/components/ledger/use-ledger";
import { Figure, PageHead, Panel, ErrorNote, Loading, Empty } from "@/components/ledger/primitives";

/**
 * Segment reporting (IFRS 8) on screen.
 *
 * The shape of the page is the shape of the standard: the matrix first, the
 * reportable-segment test beside it so a reader can see why a segment has a
 * column of its own, and the reconciliation stated underneath in words. The
 * "Not allocated" column is drawn in every table, at nil as readily as at a
 * million, because a segment note whose columns do not add to the business is
 * a note that misleads in the direction its reader would like to believe.
 */

interface Column { key: string; label: string; isUnallocated: boolean; isOther: boolean; reportable: boolean }
interface Test {
  revenueShareBps: string | null; revenuePasses: boolean;
  resultShareBps: string | null; resultPasses: boolean;
  assetsShareBps: string | null; assetsPasses: boolean;
  quantitativeThresholdMet: boolean; promotedForCoverage: boolean; reportable: boolean; basis: string;
}
interface SegmentRow {
  key: string; label: string; isUnallocated: boolean;
  revenueMinor: string; costOfSalesMinor: string; grossProfitMinor: string;
  expensesMinor: string; resultMinor: string; assetsMinor: string; liabilitiesMinor: string;
  test: Test;
}
interface MeasureRow {
  key: string; label: string; isSubtotal: boolean;
  byColumn: Record<string, string>; totalMinor: string;
}
interface Thresholds {
  combinedRevenueMinor: string; combinedProfitMinor: string; combinedLossMinor: string;
  resultBasisMinor: string; combinedAssetsMinor: string;
  reportableRevenueMinor: string; entityRevenueMinor: string; revenueCoverageBps: string | null;
  seventyFivePercentMet: boolean; seventyFivePercentApplicable: boolean; promoted: string[];
}
interface Report {
  from: string; to: string; currency: string; dimensionCode: string; dimensionName: string;
  columns: Column[]; measures: MeasureRow[]; segments: SegmentRow[]; thresholds: Thresholds;
  reconciles: boolean; differenceMinor: string;
  reconciliation: {
    controlRevenueMinor: string; controlCostOfSalesMinor: string;
    controlExpensesMinor: string; controlNetProfitMinor: string;
    differencesMinor: { revenue: string; costOfSales: string; expenses: string; result: string };
  };
  warnings: string[];
}
interface BalanceLine {
  code: string; name: string; nameAr: string | null;
  presentedMinor: Record<string, string>; balanceMinor: Record<string, string>; totalPresentedMinor: string;
}
interface BalanceSection {
  key: string; label: string; lines: BalanceLine[];
  totalMinor: Record<string, string>; grandTotalMinor: string;
  controlMinor: string; differenceMinor: string;
}
interface SegBalanceSheet {
  asOf: string; currency: string; dimensionCode: string; dimensionName: string;
  columns: Column[]; assets: BalanceSection; liabilities: BalanceSection;
  reconciles: boolean; differenceMinor: string;
  unallocatedAssetShareBps: string | null; warnings: string[];
}
interface TrendPeriod {
  label: string; from: string; to: string;
  revenueMinor: Record<string, string>; resultMinor: Record<string, string>;
  reconciles: boolean; differenceMinor: string;
}
interface TrendSeries {
  key: string; label: string; isUnallocated: boolean;
  firstRevenueMinor: string; lastRevenueMinor: string; revenueChangeMinor: string;
  revenueChangeBps: string | null;
  firstResultMinor: string; lastResultMinor: string; resultChangeMinor: string;
  shrinking: boolean;
}
interface Trend {
  dimensionCode: string; dimensionName: string; currency: string; from: string; to: string;
  columns: Column[]; periods: TrendPeriod[]; series: TrendSeries[];
  reconciles: boolean; unreconciledPeriods: string[];
}
interface Dimension { code: string; name: string; values: { code: string; name: string }[] }

function ytd() {
  const now = new Date();
  return { from: `${now.getUTCFullYear()}-01-01`, to: now.toISOString().slice(0, 10) };
}

/** The ledger keeps basis points; a reader wants a percentage. Both, exactly. */
const pct = (bps: string | null) => (bps === null ? "—" : `${(Number(bps) / 100).toFixed(2)}%`);

const MONTH_CHOICES = [3, 6, 12, 24];

export default function SegmentsPage() {
  const entityId = useEntityId();
  const [range, setRange] = React.useState(ytd);
  const [dimension, setDimension] = React.useState("");
  const [months, setMonths] = React.useState(12);

  const q = useLedgerQuery<{ dimensions: Dimension[]; report?: Report; balanceSheet?: SegBalanceSheet; trend?: Trend }>(
    entityId
      ? `/api/ledger/segments?entityId=${entityId}` +
        (dimension
          ? `&dimension=${encodeURIComponent(dimension)}&from=${range.from}&to=${range.to}&months=${months}`
          : "")
      : null,
  );

  const dimensions = q.data?.dimensions ?? [];
  React.useEffect(() => {
    if (dimension || !dimensions.length) return;
    setDimension(dimensions[0].code);
  }, [dimensions, dimension]);

  if (!entityId) return <Loading label="Choosing an entity…" />;

  const report = q.data?.report;
  const bs = q.data?.balanceSheet;
  const trend = q.data?.trend;

  return (
    <>
      <PageHead
        title="Segments"
        sub="The IFRS 8 note, built from the dimension the ledger already records on its lines. Segments below the 10% thresholds are combined into Other segments; postings carrying no value at all stand in their own column, always, because a segment note whose columns do not add to the business is worse than none."
        actions={
          <>
            <label className="flex items-center gap-1.5">
              <span className="sw-label">Segment by</span>
              <select className="sw-select" style={{ width: "11rem" }} value={dimension}
                onChange={(e) => setDimension(e.target.value)}>
                {dimensions.map((d) => <option key={d.code} value={d.code}>{d.name}</option>)}
              </select>
            </label>
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
              <span className="sw-label">Trend</span>
              <select className="sw-select" style={{ width: "7.5rem" }} value={months}
                onChange={(e) => setMonths(Number(e.target.value))}>
                {MONTH_CHOICES.map((m) => <option key={m} value={m}>{m} months</option>)}
              </select>
            </label>
          </>
        }
      />

      {q.error && <ErrorNote>{q.error}</ErrorNote>}
      {q.loading && <Loading />}
      {!q.loading && !q.error && dimensions.length === 0 && (
        <Empty>
          No dimensions have been defined yet, so there is nothing to report segments on — every posting would be
          Not allocated. Create one on the{" "}
          <Link href="/accounting/dimensions" className="sw-link">cost centres</Link> screen and tag postings with it.
        </Empty>
      )}

      {report && (
        <div className="grid gap-4">
          {!report.reconciles && (
            <ErrorNote>
              These segment columns add up to{" "}
              <Figure minor={report.measures.find((m) => m.key === "result")!.totalMinor} currency={report.currency} zero="zero" />{" "}
              but the <Link href="/accounting/statements" className="sw-link">profit and loss</Link> for the same
              period is{" "}
              <Figure minor={report.reconciliation.controlNetProfitMinor} currency={report.currency} zero="zero" />.
              That is a defect in this report, not a rounding difference. Do not file a segment note from it, and
              please report it rather than adjusting a column to fit.
            </ErrorNote>
          )}
          {report.warnings.map((w, i) => (
            <div key={`w${i}`} className="sw-note" role="status" data-testid="segment-warning">{w}</div>
          ))}

          <Matrix report={report} />
          <Reconciliation report={report} />
          <ThresholdTable report={report} />
          {trend && <TrendPanel trend={trend} currency={report.currency} />}
          {bs && <BalanceSheetPanel bs={bs} />}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ matrix */

/**
 * Segments across, the profit and loss down. The unallocated column is toned
 * and ruled off rather than merely present, so it reads as the residual it is
 * and not as one more segment among the others.
 */
function Matrix({ report }: { report: Report }) {
  return (
    <Panel className="overflow-hidden">
      <Head>
        {report.dimensionName} — segment result, {report.from} to {report.to}
      </Head>
      <div className="sw-scroll">
        <table className="sw-table" data-testid="segment-matrix">
          <caption className="sr-only">
            Revenue, cost of sales, gross profit, operating expenses and result by {report.dimensionName} from{" "}
            {report.from} to {report.to}, in {report.currency}, with a column for postings carrying no value and a
            total that equals the entity&apos;s profit and loss.
          </caption>
          <thead>
            <tr>
              <th scope="col" style={{ minWidth: "13rem" }}>Measure</th>
              {report.columns.map((c) => (
                <th key={c.key} scope="col" className="sw-num"
                  style={{ width: "var(--sw-col-amount)", ...tone(c) }}
                  data-testid={c.isUnallocated ? "unallocated-column" : undefined}>
                  {c.label}
                  {c.isUnallocated && <div><span className="sw-chip sw-chip-warn">no value</span></div>}
                  {c.isOther && <div><span className="sw-chip">IFRS 8.16</span></div>}
                </th>
              ))}
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Entity</th>
            </tr>
          </thead>
          <tbody>
            {report.measures.map((m) => (
              <tr key={m.key}>
                <th scope="row" style={m.isSubtotal ? SUBTOTAL : undefined}>{m.label}</th>
                {report.columns.map((c) => (
                  <td key={c.key} className="sw-num" style={{ ...tone(c), ...(m.isSubtotal ? SUBTOTAL : {}) }}
                    data-testid={m.key === "result" && c.isUnallocated ? "unallocated-result" : undefined}>
                    <Figure minor={m.byColumn[c.key]} currency={report.currency} zero="zero" />
                  </td>
                ))}
                <td className="sw-num" style={m.isSubtotal ? SUBTOTAL : undefined}
                  data-testid={m.key === "result" ? "entity-result" : undefined}>
                  <Figure minor={m.totalMinor} currency={report.currency} zero="zero" />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Reportable</th>
              {report.columns.map((c) => (
                <td key={c.key} className="sw-num" style={tone(c)}>
                  <span className={`sw-chip ${c.reportable ? "sw-chip-ok" : ""}`}>
                    {c.reportable ? "yes" : c.isUnallocated ? "not a segment" : "combined"}
                  </span>
                </td>
              ))}
              <td className="sw-num sw-sub">IFRS 8.13</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------- reconciliation */

/**
 * IFRS 8.28 in words, under the matrix it is about. Stated whether it passes or
 * fails: a reader has to be able to tell "checked and right" from "not checked",
 * and a check that only speaks up when it fails cannot do that.
 */
function Reconciliation({ report }: { report: Report }) {
  const result = report.measures.find((m) => m.key === "result")!;
  return (
    <Panel>
      <p className="sw-sub px-3 py-2" role="status" aria-live="polite" data-testid="reconciliation">
        {report.reconciles ? (
          <>
            Every column, Not allocated included, adds back to{" "}
            <Figure minor={result.totalMinor} currency={report.currency} zero="zero" /> — the same result as the{" "}
            <Link href="/accounting/statements" className="sw-link">profit and loss</Link> for this period, which is
            read from the balance cache rather than from these lines. Revenue, cost of sales and operating expenses
            each reconcile the same way, as IFRS 8.28 requires.
          </>
        ) : (
          <span style={{ color: "var(--sw-neg)" }}>
            The columns add to <Figure minor={result.totalMinor} currency={report.currency} zero="zero" /> against a
            profit and loss of{" "}
            <Figure minor={report.reconciliation.controlNetProfitMinor} currency={report.currency} zero="zero" />, a
            difference of <Figure minor={report.differenceMinor} currency={report.currency} zero="zero" />. This
            report is not fit to be read until that is explained.
          </span>
        )}
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------- reportable segments */

/** The three quantitative thresholds, per segment, with the inputs shown. */
function ThresholdTable({ report }: { report: Report }) {
  const t = report.thresholds;
  return (
    <Panel className="overflow-hidden">
      <Head>Reportable segments — the IFRS 8.13 thresholds</Head>
      <div className="sw-scroll">
        <table className="sw-table" data-testid="threshold-table">
          <caption className="sr-only">
            Each segment&apos;s revenue, result and assets as a share of the combined segment totals. A segment is
            reportable when any one of the three reaches 10 per cent.
          </caption>
          <thead>
            <tr>
              <th scope="col" style={{ minWidth: "11rem" }}>Segment</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Revenue</th>
              <th scope="col" className="sw-num" style={{ width: "6rem" }}>Share</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Result</th>
              <th scope="col" className="sw-num" style={{ width: "6rem" }}>Share</th>
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Assets</th>
              <th scope="col" className="sw-num" style={{ width: "6rem" }}>Share</th>
              <th scope="col" style={{ minWidth: "8rem" }}>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {report.segments.map((s) => (
              <tr key={s.key} style={s.isUnallocated ? { background: "var(--sw-surface-2)" } : undefined}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  {s.label}
                  {s.isUnallocated && <span className="sw-chip sw-chip-warn ms-2">no value</span>}
                </th>
                <td className="sw-num"><Figure minor={s.revenueMinor} currency={report.currency} /></td>
                <Share bps={s.test.revenueShareBps} passes={s.test.revenuePasses} />
                <td className="sw-num"><Figure minor={s.resultMinor} currency={report.currency} zero="zero" /></td>
                <Share bps={s.test.resultShareBps} passes={s.test.resultPasses} />
                <td className="sw-num"><Figure minor={s.assetsMinor} currency={report.currency} /></td>
                <Share bps={s.test.assetsShareBps} passes={s.test.assetsPasses} />
                <td title={s.test.basis}>
                  {s.isUnallocated ? (
                    <span className="sw-chip">not a segment</span>
                  ) : s.test.promotedForCoverage ? (
                    <span className="sw-chip sw-chip-accent">IFRS 8.15</span>
                  ) : s.test.reportable ? (
                    <span className="sw-chip sw-chip-ok">reportable</span>
                  ) : (
                    <span className="sw-chip">combined</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Combined segments</th>
              <td className="sw-num"><Figure minor={t.combinedRevenueMinor} currency={report.currency} colour={false} /></td>
              <td className="sw-num sw-sub">10% bar</td>
              <td className="sw-num" title="The greater, in absolute amount, of combined profit and combined loss">
                <Figure minor={t.resultBasisMinor} currency={report.currency} colour={false} />
              </td>
              <td className="sw-num sw-sub">10% bar</td>
              <td className="sw-num"><Figure minor={t.combinedAssetsMinor} currency={report.currency} colour={false} /></td>
              <td className="sw-num sw-sub">10% bar</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} data-testid="coverage">
        {t.seventyFivePercentApplicable ? (
          <>
            The reportable segments carry{" "}
            <Figure minor={t.reportableRevenueMinor} currency={report.currency} colour={false} /> of the entity&apos;s{" "}
            <Figure minor={t.entityRevenueMinor} currency={report.currency} colour={false} /> revenue —{" "}
            <span title={`${t.revenueCoverageBps ?? "0"} basis points`}>{pct(t.revenueCoverageBps)}</span>.{" "}
            {t.seventyFivePercentMet
              ? "IFRS 8.15 asks for at least 75%, and that is met."
              : "IFRS 8.15 asks for at least 75%, and it is not met: the shortfall is revenue carrying no segment, which no promotion can close."}
            {t.promoted.length > 0 && (
              <> {t.promoted.join(", ")} {t.promoted.length === 1 ? "was" : "were"} reported separately for that
                reason alone, having failed all three thresholds above.</>
            )}
          </>
        ) : (
          <>There is no revenue in this period, so the 75% coverage test in IFRS 8.15 has no denominator and is not
            applied. That is different from failing it.</>
        )}{" "}
        The result bar is a share of the greater, in absolute amount, of the combined profit of the segments in
        profit and the combined loss of those in loss (IFRS 8.13(b)) — netting the two would let a profit and a loss
        of the same size cancel and leave nothing reportable.
      </p>
    </Panel>
  );
}

function Share({ bps, passes }: { bps: string | null; passes: boolean }) {
  return (
    <td className="sw-num" title={bps === null ? "No denominator" : `${bps} basis points`}>
      <span className={passes ? "" : "sw-zero"}>{pct(bps)}</span>
      {passes && <span className="sw-chip sw-chip-ok ms-1">10%+</span>}
    </td>
  );
}

/* ------------------------------------------------------------------- trend */

/** Month by month, with nothing aggregated: a segment shrinking quietly is the point. */
function TrendPanel({ trend, currency }: { trend: Trend; currency: string }) {
  return (
    <Panel className="overflow-hidden">
      <Head>Month by month — {trend.from} to {trend.to}</Head>
      <div className="sw-scroll">
        <table className="sw-table" data-testid="segment-trend">
          <caption className="sr-only">
            Revenue and result for each {trend.dimensionName} value, month by month. Nothing is aggregated here: a
            segment combined into Other segments in the months it was shrinking would be invisible.
          </caption>
          <thead>
            <tr>
              <th scope="col" style={{ minWidth: "11rem" }}>Segment</th>
              {trend.periods.map((p) => (
                <th key={p.label} scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>
                  {p.label}
                  {!p.reconciles && <div><span className="sw-chip sw-chip-bad">out</span></div>}
                </th>
              ))}
              <th scope="col" className="sw-num" style={{ width: "7rem" }}>Change</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={trend.periods.length + 2} style={{ background: "var(--sw-surface-2)", height: "1.75rem" }}>
                <span className="sw-label">Revenue</span>
              </td>
            </tr>
            {trend.series.map((s) => (
              <tr key={`r-${s.key}`} style={s.isUnallocated ? { background: "var(--sw-surface-2)" } : undefined}>
                <th scope="row" style={{ fontWeight: 400 }}>
                  {s.label}
                  {s.isUnallocated && <span className="sw-chip sw-chip-warn ms-2">no value</span>}
                </th>
                {trend.periods.map((p) => (
                  <td key={p.label} className="sw-num">
                    <Figure minor={p.revenueMinor[s.key]} currency={currency} />
                  </td>
                ))}
                <td className="sw-num" title={s.revenueChangeBps === null ? "No revenue to compare with" : `${s.revenueChangeBps} basis points`}>
                  <Figure minor={s.revenueChangeMinor} currency={currency} />
                  {s.shrinking && <span className="sw-chip sw-chip-warn ms-1">down</span>}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={trend.periods.length + 2} style={{ background: "var(--sw-surface-2)", height: "1.75rem" }}>
                <span className="sw-label">Segment result</span>
              </td>
            </tr>
            {trend.series.map((s) => (
              <tr key={`p-${s.key}`} style={s.isUnallocated ? { background: "var(--sw-surface-2)" } : undefined}>
                <th scope="row" style={{ fontWeight: 400 }}>{s.label}</th>
                {trend.periods.map((p) => (
                  <td key={p.label} className="sw-num">
                    <Figure minor={p.resultMinor[s.key]} currency={currency} zero="zero" />
                  </td>
                ))}
                <td className="sw-num"><Figure minor={s.resultChangeMinor} currency={currency} zero="zero" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} role="status" aria-live="polite">
        {trend.reconciles
          ? "Every month here reconciles to that month's profit and loss on its own, so one bad month cannot hide inside a year that happens to tie."
          : `These months do not reconcile to their own profit and loss: ${trend.unreconciledPeriods.join(", ")}. Read nothing into the shape of this table until that is explained.`}
      </p>
    </Panel>
  );
}

/* ----------------------------------------------------------- balance sheet */

function BalanceSheetPanel({ bs }: { bs: SegBalanceSheet }) {
  return (
    <Panel className="overflow-hidden">
      <Head>Segment assets and liabilities at {bs.asOf}</Head>
      <div className="sw-scroll">
        <table className="sw-table" data-testid="segment-balance-sheet">
          <caption className="sr-only">
            Assets and liabilities by {bs.dimensionName} at {bs.asOf}, in {bs.currency}, with a column for postings
            carrying no value.
          </caption>
          <thead>
            <tr>
              <th scope="col" style={{ width: "5rem" }}>Code</th>
              <th scope="col" style={{ minWidth: "12rem" }}>Account</th>
              {bs.columns.map((c) => (
                <th key={c.key} scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)", ...tone(c) }}>
                  {c.label}
                </th>
              ))}
              <th scope="col" className="sw-num" style={{ width: "var(--sw-col-amount)" }}>Total</th>
            </tr>
          </thead>
          <BalanceRows section={bs.assets} columns={bs.columns} currency={bs.currency} />
          <BalanceRows section={bs.liabilities} columns={bs.columns} currency={bs.currency} />
        </table>
      </div>
      <p className="sw-sub px-3 py-2" style={{ borderTop: "1px solid var(--sw-line)" }} role="status" aria-live="polite"
        data-testid="balance-reconciliation">
        {bs.reconciles
          ? `Assets and liabilities each add back across every column to the balance sheet at ${bs.asOf} (IFRS 8.28).`
          : `Segment assets and liabilities are out by ${bs.differenceMinor} minor units against the balance sheet at ${bs.asOf}. That is a defect in this report.`}{" "}
        {bs.unallocatedAssetShareBps !== null && (
          <>{pct(bs.unallocatedAssetShareBps)} of assets carry no {bs.dimensionCode} value. </>
        )}
        That is the ordinary state of a ledger rather than a fault: the segment goes on the cost, and the bank
        account, the receivable and the accrual on the other side of the entry are shared balances nobody tags.
        Requiring {bs.dimensionCode} on those accounts is what changes it — until then, read the assets threshold in
        IFRS 8.13(c) as weak evidence.
      </p>
      {bs.warnings.map((w, i) => (
        <p key={`bw${i}`} className="sw-sub px-3 pb-2" role="status">{w}</p>
      ))}
    </Panel>
  );
}

function BalanceRows({ section, columns, currency }: { section: BalanceSection; columns: Column[]; currency: string }) {
  const span = columns.length + 3;
  return (
    <tbody>
      <tr>
        <td colSpan={span} style={{ background: "var(--sw-surface-2)", height: "1.75rem" }}>
          <span className="sw-label">{section.label}</span>
        </td>
      </tr>
      {section.lines.length === 0 && (
        <tr><td colSpan={span} className="sw-sub" style={{ paddingInlineStart: "1.5rem" }}>Nothing at this date</td></tr>
      )}
      {section.lines.map((l) => (
        <tr key={l.code}>
          <td className="sw-code">{l.code}</td>
          <td>{l.name}</td>
          {columns.map((c) => (
            <td key={c.key} className="sw-num" style={tone(c)}>
              <Figure minor={l.presentedMinor[c.key]} currency={currency} />
            </td>
          ))}
          <td className="sw-num"><Figure minor={l.totalPresentedMinor} currency={currency} /></td>
        </tr>
      ))}
      <tr>
        <th scope="row" colSpan={2} style={{ textAlign: "end", fontWeight: 600 }}>
          Total {section.label.toLowerCase()}
        </th>
        {columns.map((c) => (
          <td key={c.key} className="sw-num" style={{ fontWeight: 600, ...tone(c) }}>
            <Figure minor={section.totalMinor[c.key]} currency={currency} zero="zero" colour={false} />
          </td>
        ))}
        <td className="sw-num" style={{ fontWeight: 600 }}>
          <Figure minor={section.grandTotalMinor} currency={currency} zero="zero" colour={false} />
        </td>
      </tr>
    </tbody>
  );
}

/* ------------------------------------------------------------------ chrome */

const SUBTOTAL: React.CSSProperties = { fontWeight: 600, borderTop: "1px solid var(--sw-line-strong)" };

/**
 * The residual is toned and ruled off; the IFRS 8.16 aggregate is only ruled.
 * Neither carries meaning in colour alone — both say what they are in words, in
 * the header and again in the chip beneath it.
 */
const tone = (c: Column): React.CSSProperties =>
  c.isUnallocated
    ? { background: "var(--sw-surface-2)", borderInlineStart: "1px solid var(--sw-line-strong)" }
    : c.isOther
      ? { borderInlineStart: "1px solid var(--sw-line)" }
      : {};

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b px-3 py-2" style={{ borderColor: "var(--sw-line)", background: "var(--sw-surface-2)" }}>
      <span className="sw-label">{children}</span>
    </div>
  );
}
