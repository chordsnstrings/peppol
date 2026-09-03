import { LedgerError } from "./post";
import { profitAndLoss, balanceSheet, type StatementLine } from "./statements";
import { receivablesAgeing } from "./ar";
import { payablesAgeing } from "./ap";

/**
 * The ratios a business is actually run on, computed from the statements
 * rather than from a second pass over the journal.
 *
 * Two decisions carry this module.
 *
 * The first is that every ratio is an integer. A margin that has been through a
 * floating-point number disagrees with itself at the fourth decimal place, and
 * an accountant who sees 39.999999% where they expected 40% stops trusting the
 * screen — reasonably, because they cannot tell that error from a real one. So
 * everything here is a BigInt scaled by 10,000: basis points for a ratio, and
 * ten-thousandths of a day for a day count, on the same scale so one rule
 * covers the whole set.
 *
 * The second is that a ratio with a zero denominator is null, never zero and
 * never Infinity. "This business has no debt" and "this ratio cannot be
 * calculated" are different facts about a company, and a screen that renders
 * both as 0.00 has destroyed the difference. Every ratio therefore carries an
 * interpretation, and the interpretation of a null says which denominator was
 * missing and why that stops the calculation.
 *
 * The figures come from `profitAndLoss` and `balanceSheet` — the same two
 * statements the accounts screen shows — and from the ageing reports for the
 * collection and payment periods. Nothing is re-derived from journal lines
 * here, so a ratio on this page cannot disagree with the statement it came
 * from.
 */

export type KpiUnit = "PERCENT" | "TIMES" | "DAYS" | "MONEY";

export interface Kpi {
  key: string;
  label: string;
  unit: KpiUnit;
  /**
   * The value, scaled by 10,000: basis points for PERCENT and TIMES, and
   * ten-thousandths of a day for DAYS. Null when the denominator is zero —
   * see `interpretation` for which one and why.
   */
  valueBps: bigint | null;
  /** Minor units, for the figures that are an amount rather than a ratio. */
  amountMinor: string | null;
  /** The formula in words, so the number can be checked rather than believed. */
  basis: string;
  /** What went into it, named and in minor units. */
  inputs: { label: string; amountMinor: string }[];
  /** A plain sentence. Never empty — including when the ratio cannot be computed. */
  interpretation: string;
  /** False when a zero denominator stopped the calculation. */
  computable: boolean;
}

export interface FinancialKpis {
  entityId: string;
  from: string;
  to: string;
  currency: string;
  /** Days in the period, inclusive of both ends — the multiplier in DSO and DPO. */
  days: number;
  kpis: Kpi[];
  /** Current assets less current liabilities: the cash cushion, in minor units. */
  workingCapitalMinor: string;
  /** Anything that makes a ratio here mean less than it appears to. */
  warnings: string[];
}

/**
 * Which accounts are current.
 *
 * The seeded UAE chart puts current assets in 1000-1499 and non-current in
 * 1500-1999, current liabilities in 2000-2499 and non-current above. A chart
 * that has been extended by hand may not follow that, so anything unmatched is
 * left out of the ratio and named in a warning rather than silently counted as
 * current — a current ratio that quietly includes a long-term loan is worse
 * than one that says it could not classify an account.
 */
const CURRENT_ASSET = /^1[0-4]/;
const NON_CURRENT_ASSET = /^1[5-9]/;
const CURRENT_LIABILITY = /^2[0-4]/;
const NON_CURRENT_LIABILITY = /^2[5-9]/;

const INVENTORY = "1200";
const PREPAYMENTS = "1300";

/** A ×10,000 figure rendered with two decimals, exactly — no float on the path. */
function twoDp(v: bigint, scale: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const hundredths = (abs * 100n + scale / 2n) / scale;
  const s = hundredths.toString().padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** Basis points as a percentage: 4,000 bps reads as "40.00%". */
export const asPercent = (bps: bigint) => `${twoDp(bps, 100n)}%`;
/** A ×10,000 figure as a plain multiple or day count: 25,000 reads as "2.50". */
export const asTimes = (bps: bigint) => twoDp(bps, 10_000n);

/** Minor units in a sentence: grouped, signed, no accounting parentheses. */
function money(minor: bigint, currency: string): string {
  const neg = minor < 0n;
  const abs = (neg ? -minor : minor).toString().padStart(3, "0");
  const whole = abs.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${currency} ${whole}.${abs.slice(-2)}`;
}

/**
 * Integer ratio, scaled, rounded half away from zero. Null denominators never
 * become zero.
 *
 * This used to truncate, and statements.ts has always rounded. On identical
 * figures the same gross margin therefore came out 6667 on the Statements
 * screen and 6666 on Insights, and two screens disagreeing about one number by
 * a hundredth of a per cent is the kind of thing that makes somebody distrust
 * both of them. Rounding is the one that is right: 66.665% is nearer 66.67%
 * than 66.66%, and truncation biases every ratio in the product downwards.
 *
 * BigInt division truncates towards zero, so the half has to be added to the
 * magnitude and the sign put back — adding it to a negative numerator would
 * round towards zero, not away from it.
 */
const bpsOf = (numerator: bigint, denominator: bigint, scale = 10_000n): bigint | null => {
  if (denominator === 0n) return null;
  const n = numerator * scale;
  const d = denominator < 0n ? -denominator : denominator;
  const signed = denominator < 0n ? -n : n;
  const half = d / 2n;
  return signed >= 0n ? (signed + half) / d : -((-signed + half) / d);
};

function sumWhere(lines: StatementLine[], re: RegExp): bigint {
  return lines.filter((l) => re.test(l.code)).reduce((a, l) => a + BigInt(l.presentedMinor), 0n);
}
const lineFor = (lines: StatementLine[], code: string): bigint =>
  lines.filter((l) => l.code === code).reduce((a, l) => a + BigInt(l.presentedMinor), 0n);

export async function financialKpis(opts: {
  orgId: string;
  entityId: string;
  /** Inclusive ISO dates. */
  from: string;
  to: string;
}): Promise<FinancialKpis> {
  const from = new Date(opts.from);
  const to = new Date(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new LedgerError("Financial ratios need a valid start and end date for the period.");
  }
  if (to < from) throw new LedgerError("The period ends before it starts. Check the dates and try again.");

  // Inclusive of both ends: a January-to-January month is 31 days, not 30.
  const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const daysBig = BigInt(days);

  // The day before the period opened. Turnover ratios compare a flow measured
  // over a period against a stock measured at a point, so the stock has to be
  // an average of the two ends or a growing business reports a turnover it
  // never achieved.
  const openingDate = new Date(from.getTime() - 86_400_000);

  const [pl, bs, opening, ar, ap] = await Promise.all([
    profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from: opts.from, to: opts.to }),
    balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: opts.to }),
    balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: openingDate.toISOString().slice(0, 10) }),
    receivablesAgeing({ orgId: opts.orgId, entityId: opts.entityId, asOf: to }),
    payablesAgeing({ orgId: opts.orgId, entityId: opts.entityId, asOf: to }),
  ]);

  const currency = pl.currency;
  const warnings: string[] = [];

  const revenue = BigInt(pl.revenue.totalMinor);
  const costOfSales = BigInt(pl.costOfSales.totalMinor);
  const grossProfit = BigInt(pl.grossProfitMinor);
  const netProfit = BigInt(pl.netProfitMinor);

  const currentAssets = sumWhere(bs.assets.lines, CURRENT_ASSET);
  const currentLiabilities = sumWhere(bs.liabilities.lines, CURRENT_LIABILITY);
  const inventory = lineFor(bs.assets.lines, INVENTORY);
  const prepayments = lineFor(bs.assets.lines, PREPAYMENTS);
  const openingInventory = lineFor(opening.assets.lines, INVENTORY);
  const totalLiabilities = BigInt(bs.liabilities.totalMinor);
  const equity = BigInt(bs.equity.totalMinor);
  const openingEquity = BigInt(opening.equity.totalMinor);

  const unclassified = [
    ...bs.assets.lines.filter((l) => !CURRENT_ASSET.test(l.code) && !NON_CURRENT_ASSET.test(l.code)),
    ...bs.liabilities.lines.filter((l) => !CURRENT_LIABILITY.test(l.code) && !NON_CURRENT_LIABILITY.test(l.code)),
  ];
  if (unclassified.length) {
    warnings.push(
      `${unclassified.length} account${unclassified.length === 1 ? "" : "s"} could not be classified as current or ` +
        `non-current from ${unclassified.length === 1 ? "its code" : "their codes"} ` +
        `(${unclassified.slice(0, 4).map((l) => `${l.code} ${l.name}`).join(", ")}` +
        `${unclassified.length > 4 ? ", …" : ""}), so ${unclassified.length === 1 ? "it is" : "they are"} outside the ` +
        `current and quick ratios. Renumber ${unclassified.length === 1 ? "it" : "them"} into the standard ranges — ` +
        `current assets 1000-1499, current liabilities 2000-2499 — or read those two ratios with this in mind.`,
    );
  }
  if (!bs.balanced) {
    warnings.push(
      `The balance sheet these ratios are built on does not balance: assets are out by ` +
        `${money(BigInt(bs.differenceMinor), currency)}. Every ratio below inherits that error. ` +
        `Fix the books before reading them.`,
    );
  }

  // Averages, taken over the period's two ends.
  const averageInventory = (openingInventory + inventory) / 2n;
  const averageEquity = (openingEquity + equity) / 2n;

  const arOutstanding = BigInt(ar.totalMinor);
  const apOutstanding = BigInt(ap.totalMinor);
  const workingCapital = currentAssets - currentLiabilities;

  const kpis: Kpi[] = [];
  const add = (k: Kpi) => { kpis.push(k); return k; };

  /* ---------------------------------------------------------- margins ---- */

  const grossMarginBps = bpsOf(grossProfit, revenue);
  add({
    key: "gross_margin",
    label: "Gross margin",
    unit: "PERCENT",
    valueBps: grossMarginBps,
    amountMinor: null,
    basis: "Gross profit ÷ revenue",
    inputs: [
      { label: "Gross profit", amountMinor: grossProfit.toString() },
      { label: "Revenue", amountMinor: revenue.toString() },
    ],
    computable: grossMarginBps !== null,
    interpretation:
      grossMarginBps === null
        ? "Gross margin cannot be calculated because there was no revenue in this period. That is not a margin of zero — there is simply nothing to take a proportion of."
        : `Gross margin is ${asPercent(grossMarginBps)}: of every dirham of revenue, ${asPercent(grossMarginBps)} is left after the direct cost of what was sold, before any overhead.`,
  });

  const netMarginBps = bpsOf(netProfit, revenue);
  add({
    key: "net_margin",
    label: "Net margin",
    unit: "PERCENT",
    valueBps: netMarginBps,
    amountMinor: null,
    basis: "Net profit ÷ revenue",
    inputs: [
      { label: "Net profit", amountMinor: netProfit.toString() },
      { label: "Revenue", amountMinor: revenue.toString() },
    ],
    computable: netMarginBps !== null,
    interpretation:
      netMarginBps === null
        ? "Net margin cannot be calculated because there was no revenue in this period. A business with costs and no sales has a loss, not a margin."
        : netProfit < 0n
          ? `Net margin is ${asPercent(netMarginBps)}: the period ran at a loss of ${money(-netProfit, currency)} after every cost.`
          : `Net margin is ${asPercent(netMarginBps)}: ${asPercent(netMarginBps)} of revenue survived every cost of running the business.`,
  });

  /* ------------------------------------------------------- liquidity ----- */

  const currentRatioBps = bpsOf(currentAssets, currentLiabilities);
  add({
    key: "current_ratio",
    label: "Current ratio",
    unit: "TIMES",
    valueBps: currentRatioBps,
    amountMinor: null,
    basis: "Current assets ÷ current liabilities",
    inputs: [
      { label: "Current assets", amountMinor: currentAssets.toString() },
      { label: "Current liabilities", amountMinor: currentLiabilities.toString() },
    ],
    computable: currentRatioBps !== null,
    interpretation:
      currentRatioBps === null
        ? "The current ratio cannot be calculated because there are no current liabilities at this date. Nothing is owed within the year, which is a strong position rather than a missing number — but it is not a ratio."
        : `The business holds ${asTimes(currentRatioBps)} dirhams of current assets for every dirham falling due within the year. ` +
          (currentRatioBps < 10_000n
            ? "Below 1.00 means short-term obligations exceed the assets available to meet them."
            : "Above 1.00 means short-term obligations are covered by assets that turn into cash within the year."),
  });

  // Quick assets exclude what cannot be turned into cash quickly: stock has to
  // be sold first, and a prepayment has already been spent.
  const quickAssets = currentAssets - inventory - prepayments;
  const quickRatioBps = bpsOf(quickAssets, currentLiabilities);
  add({
    key: "quick_ratio",
    label: "Quick ratio",
    unit: "TIMES",
    valueBps: quickRatioBps,
    amountMinor: null,
    basis: "(Current assets − inventory − prepayments) ÷ current liabilities",
    inputs: [
      { label: "Quick assets", amountMinor: quickAssets.toString() },
      { label: "Inventory excluded", amountMinor: inventory.toString() },
      { label: "Prepayments excluded", amountMinor: prepayments.toString() },
      { label: "Current liabilities", amountMinor: currentLiabilities.toString() },
    ],
    computable: quickRatioBps !== null,
    interpretation:
      quickRatioBps === null
        ? "The quick ratio cannot be calculated because there are no current liabilities at this date — there is no obligation to test the liquid assets against."
        : `Excluding stock and prepayments, the business holds ${asTimes(quickRatioBps)} dirhams of readily liquid assets per dirham of short-term debt. This is the current ratio without the assumption that inventory can be sold in time.`,
  });

  add({
    key: "working_capital",
    label: "Working capital",
    unit: "MONEY",
    valueBps: null,
    amountMinor: workingCapital.toString(),
    basis: "Current assets − current liabilities",
    inputs: [
      { label: "Current assets", amountMinor: currentAssets.toString() },
      { label: "Current liabilities", amountMinor: currentLiabilities.toString() },
    ],
    computable: true,
    interpretation:
      workingCapital >= 0n
        ? `${money(workingCapital, currency)} of current assets remains after every liability falling due within the year is settled. This is the cushion the business runs on.`
        : `Current liabilities exceed current assets by ${money(-workingCapital, currency)}. The next year's obligations are larger than the assets available to meet them, which has to be funded from somewhere.`,
  });

  /* --------------------------------------------------------- gearing ----- */

  const debtToEquityBps = bpsOf(totalLiabilities, equity);
  add({
    key: "debt_to_equity",
    label: "Debt to equity",
    unit: "TIMES",
    valueBps: debtToEquityBps,
    amountMinor: null,
    // Total liabilities rather than borrowings alone: the chart cannot reliably
    // separate interest-bearing debt from trade credit, and reporting the
    // narrower ratio from a broad number would understate gearing.
    basis: "Total liabilities ÷ total equity (all liabilities, not borrowings alone)",
    inputs: [
      { label: "Total liabilities", amountMinor: totalLiabilities.toString() },
      { label: "Total equity", amountMinor: equity.toString() },
    ],
    computable: debtToEquityBps !== null,
    interpretation:
      debtToEquityBps === null
        ? "Debt to equity cannot be calculated because equity is zero at this date. With no owners' stake there is nothing to measure the liabilities against — which is itself worth explaining."
        : equity < 0n
          ? `Equity is negative (${money(equity, currency)}), so this ratio has no useful reading: liabilities exceed everything the business owns. The figure to act on is the deficit, not the multiple.`
          : `For every dirham the owners have in the business, ${asTimes(debtToEquityBps)} dirhams are owed to others. This counts all liabilities, trade payables included, not just borrowings.`,
  });

  const roeBps = bpsOf(netProfit, averageEquity);
  add({
    key: "return_on_equity",
    label: "Return on equity",
    unit: "PERCENT",
    valueBps: roeBps,
    amountMinor: null,
    basis: "Net profit ÷ average equity over the period",
    inputs: [
      { label: "Net profit", amountMinor: netProfit.toString() },
      { label: "Equity at the start", amountMinor: openingEquity.toString() },
      { label: "Equity at the end", amountMinor: equity.toString() },
      { label: "Average equity", amountMinor: averageEquity.toString() },
    ],
    computable: roeBps !== null,
    interpretation:
      roeBps === null
        ? "Return on equity cannot be calculated because average equity over the period is zero. A return needs something to be a return on."
        : averageEquity < 0n
          ? `Average equity over the period was negative (${money(averageEquity, currency)}), so this percentage cannot be read as a return. Restore positive equity before using this ratio.`
          : `The business earned ${asPercent(roeBps)} on the owners' average stake of ${money(averageEquity, currency)} over this period. Compare it against what that money would earn elsewhere.`,
  });

  /* --------------------------------------------------- working capital --- */

  // Days sales outstanding: the receivables actually open at the period end,
  // taken from the ageing report rather than from the control account, so this
  // agrees with the collections screen a bookkeeper is looking at.
  const dsoBps = bpsOf(arOutstanding * daysBig, revenue);
  add({
    key: "days_sales_outstanding",
    label: "Days sales outstanding",
    unit: "DAYS",
    valueBps: dsoBps,
    amountMinor: null,
    basis: `Open receivables ÷ revenue × ${days} days in the period`,
    inputs: [
      { label: "Receivables outstanding", amountMinor: arOutstanding.toString() },
      { label: "Revenue", amountMinor: revenue.toString() },
    ],
    computable: dsoBps !== null,
    interpretation:
      dsoBps === null
        ? "Days sales outstanding cannot be calculated because there was no revenue in this period. Without sales there is no daily rate to divide the receivables by."
        : `Customers take about ${asTimes(dsoBps)} days to pay. Read it against the terms on your invoices: a figure well above them is cash sitting in someone else's account.`,
  });

  // Days payable outstanding. Purchases are approximated by cost of sales —
  // the ledger does not separate a period's purchases from what was consumed
  // out of stock, and saying so is better than presenting the approximation as
  // a measurement.
  const dpoBps = bpsOf(apOutstanding * daysBig, costOfSales);
  add({
    key: "days_payable_outstanding",
    label: "Days payable outstanding",
    unit: "DAYS",
    valueBps: dpoBps,
    amountMinor: null,
    basis: `Open payables ÷ cost of sales × ${days} days in the period (cost of sales stands in for purchases)`,
    inputs: [
      { label: "Payables outstanding", amountMinor: apOutstanding.toString() },
      { label: "Cost of sales", amountMinor: costOfSales.toString() },
    ],
    computable: dpoBps !== null,
    interpretation:
      dpoBps === null
        ? "Days payable outstanding cannot be calculated because there was no cost of sales in this period. There is no purchasing rate to measure the payables against."
        : `The business takes about ${asTimes(dpoBps)} days to pay its suppliers. This uses cost of sales in place of purchases, which is close for a trading business and rough for one that holds stock for a long time.`,
  });

  const inventoryTurnoverBps = bpsOf(costOfSales, averageInventory);
  add({
    key: "inventory_turnover",
    label: "Inventory turnover",
    unit: "TIMES",
    valueBps: inventoryTurnoverBps,
    amountMinor: null,
    basis: "Cost of sales ÷ average inventory over the period",
    inputs: [
      { label: "Cost of sales", amountMinor: costOfSales.toString() },
      { label: "Inventory at the start", amountMinor: openingInventory.toString() },
      { label: "Inventory at the end", amountMinor: inventory.toString() },
      { label: "Average inventory", amountMinor: averageInventory.toString() },
    ],
    computable: inventoryTurnoverBps !== null,
    interpretation:
      inventoryTurnoverBps === null
        ? "Inventory turnover cannot be calculated because average inventory over the period is zero. A business that holds no stock does not have a turnover figure — that is different from stock that never moves."
        : `Stock turned over ${asTimes(inventoryTurnoverBps)} times in this period of ${days} days. A low figure is cash tied up on the shelf; a very high one can mean stock-outs.`,
  });

  const daysInventoryBps = bpsOf(averageInventory * daysBig, costOfSales);
  add({
    key: "days_inventory",
    label: "Days inventory",
    unit: "DAYS",
    valueBps: daysInventoryBps,
    amountMinor: null,
    basis: `Average inventory ÷ cost of sales × ${days} days in the period`,
    inputs: [
      { label: "Average inventory", amountMinor: averageInventory.toString() },
      { label: "Cost of sales", amountMinor: costOfSales.toString() },
    ],
    computable: daysInventoryBps !== null,
    interpretation:
      daysInventoryBps === null
        ? "Days inventory cannot be calculated because nothing was charged to cost of sales in this period. With no cost of sales there is no consumption rate to divide the stock by."
        : `Stock sits for about ${asTimes(daysInventoryBps)} days before it is sold. Together with days sales outstanding and days payable outstanding, this is how long the business's cash is locked up in a single trading cycle.`,
  });

  return {
    entityId: opts.entityId,
    from: opts.from,
    to: opts.to,
    currency,
    days,
    kpis,
    workingCapitalMinor: workingCapital.toString(),
    warnings,
  };
}
