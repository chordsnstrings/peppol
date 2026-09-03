import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { LedgerError } from "./post";
import { balanceSheet, profitAndLoss } from "./statements";

/**
 * The cash flow statement (IAS 7), by the indirect method.
 *
 * A cash flow statement is not a fourth set of numbers. It is the bridge
 * between two balance sheets: every dirham of movement on the cash accounts is
 * the mirror image of a movement somewhere else in the books. So this is built
 * from the opening balance sheet, the closing balance sheet and the profit and
 * loss for the period between them — the same `balanceSheet()` and
 * `profitAndLoss()` the statements screen reads, not a second derivation that
 * could disagree with them.
 *
 * That construction is what makes the self-check meaningful. Because both
 * balance sheets balance, the movements on every account must sum to zero, so:
 *
 *     movement in cash = profit for the period − Σ movement on every other
 *                                                  balance sheet account
 *
 * Each of those other movements is contributed to a section with its sign
 * flipped: an increase in an asset (a debit) is cash laid out, an increase in a
 * liability (a credit) is cash retained. Classify all of them and the three
 * sections must equal the movement on the cash accounts exactly. Miss one and
 * they will not — by precisely the movement that was missed.
 *
 * So the reconciliation is not decoration. It is a test of the classification,
 * and when it fails the statement says so and names the account, because the
 * alternative — a "net other movements" plug — turns a fixable coding gap into
 * a number nobody can explain. Nothing here ever balances itself.
 *
 * IAS 7.18(b) permits the indirect method; IAS 7.20 sets out the adjustments
 * (non-cash items, items whose cash effect is investing or financing, and
 * movements in working capital), which is the order the operating section runs.
 *
 * Two adjustments a hand-written indirect statement carries are deliberately
 * absent, because on this construction they would double count:
 *
 *  - Unrealised foreign exchange. Revaluing a foreign receivable posts a gain
 *    to 4950 and the same amount to 1100; the gain raises profit and the
 *    movement in 1100 takes it straight back out, so the adjustment IAS 7.20(b)
 *    asks for has already happened. Adding a second one would remove it twice.
 *    (Revaluing cash itself is a different matter — IAS 7.28 reports that
 *    separately from the three activities. It is left in operating here, which
 *    still reconciles; a fourth section would be the correct refinement.)
 *
 *  - Impairment. There is no impairment account in this chart. Its nearest
 *    equivalents — the allowance for doubtful debts and the end-of-service
 *    provision — are non-cash charges and are classified as such below, and
 *    they are added back by the same mechanism as depreciation.
 *
 * Depreciation is the exception that does need naming, because a disposal moves
 * accumulated depreciation without charging anything, so the movement on 1590
 * and the charge in the period are two different figures.
 */

/** Cash and cash equivalents (IAS 7.6-.9). Savings sits here for an SMB: it is
 *  short-term, highly liquid and held to meet commitments, not to invest. */
const CASH_CODES = ["1000", "1010", "1020", "1050"];

/** Fixed asset accounts whose gross movement is an investing flow. */
const FIXED_ASSET_CODES = ["1500", "1600", "1700"];

/** Contra-asset carrying the depreciation charged against those assets. */
const ACCUM_DEP_CODE = "1590";

/** Where a disposal's gain or loss lands in this chart (see `disposeAsset`). */
const DISPOSAL_RESULT_CODES = ["4900", "6900"];

/** The depreciation charge for the period, as the profit and loss reports it. */
const DEPRECIATION_CODE = "6600";

/**
 * Profit so far this fiscal year is synthesised by `balanceSheet()`, not posted.
 * The operating section starts from the profit and loss for the period instead,
 * so this line is taken out of the movements to avoid counting it twice.
 */
const CURRENT_EARNINGS_CODE = "3950";

type Bucket = "operating_noncash" | "operating_working_capital" | "investing" | "financing";

/**
 * Which activity each balance sheet account's movement belongs to.
 *
 * Every postable account in the UAE chart that is not cash appears here. An
 * account that does not is reported as a warning rather than quietly dropped —
 * an unclassified movement is the single commonest reason a cash flow statement
 * does not reconcile, and it is invisible unless the report names it.
 */
const CLASSIFICATION: Record<string, Bucket> = {
  // Non-cash charges taken against profit. IAS 7.20(b).
  "1150": "operating_noncash", // allowance for doubtful debts
  "2250": "operating_noncash", // end-of-service benefits provision

  // Working capital. IAS 7.20(c).
  "1100": "operating_working_capital", // trade receivables
  "1200": "operating_working_capital", // inventory
  "1250": "operating_working_capital", // goods received not invoiced
  "1300": "operating_working_capital", // prepaid expenses
  "1350": "operating_working_capital", // VAT input
  "1360": "operating_working_capital", // VAT receivable from FTA
  "1400": "operating_working_capital", // employee advances
  "2000": "operating_working_capital", // trade payables
  "2050": "operating_working_capital", // accrued expenses
  "2100": "operating_working_capital", // VAT output
  "2110": "operating_working_capital", // VAT payable to FTA
  "2200": "operating_working_capital", // salaries payable
  "2300": "operating_working_capital", // customer deposits and advances
  "2400": "operating_working_capital", // corporate tax payable

  // Investing. IAS 7.16.
  "1500": "investing", // property, plant and equipment
  [ACCUM_DEP_CODE]: "investing", // accumulated depreciation — see below
  "1600": "investing", // capital work in progress
  "1700": "investing", // right-of-use assets

  // Financing. IAS 7.17. Dividends and drawings reach the books through
  // retained earnings or the shareholder current account; both are financing.
  "2500": "financing", // long-term loans
  "2600": "financing", // lease liabilities
  "3000": "financing", // share capital
  "3100": "financing", // shareholder current account
  "3200": "financing", // statutory reserve
  "3900": "financing", // retained earnings
};

export interface CashFlowLine {
  /** The account the movement came from, or null for a derived line. */
  code: string | null;
  label: string;
  /**
   * Signed on the reader's terms, not the ledger's: positive is cash coming in,
   * negative is cash going out. The UI shows a negative in parentheses.
   */
  amountMinor: string;
  /** Said in words as well as in a sign, because a sign alone is easy to misread. */
  direction: "source" | "use" | "none";
  /** The underlying ledger movement, debit-positive, where the line has one. */
  movementMinor: string | null;
  /** Why this line has the sign it has. */
  note: string | null;
}

export interface CashFlowSection {
  key: "operating" | "investing" | "financing";
  label: string;
  lines: CashFlowLine[];
  totalMinor: string;
}

export interface CashFlowStatement {
  from: string;
  to: string;
  currency: string;
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  /** Operating + investing + financing, as this statement classifies them. */
  netCashMovementMinor: string;
  /** The same period's movement on the cash accounts, read from the ledger. */
  cashMovementPerLedgerMinor: string;
  /** The whole point: the classification accounts for every dirham of cash. */
  reconciles: boolean;
  /** Statement less ledger. Left visible; never absorbed into a balancing line. */
  differenceMinor: string;
  openingCashMinor: string;
  closingCashMinor: string;
  cashAccounts: {
    code: string;
    name: string;
    openingMinor: string;
    closingMinor: string;
    movementMinor: string;
  }[];
  /** Anything that makes this statement wrong or incomplete as it stands. */
  warnings: string[];
}

type Movement = {
  code: string;
  name: string;
  /** Balance at the day before the period opened, debit-positive. */
  opening: bigint;
  /** Balance at the period end, debit-positive. */
  closing: bigint;
  /** closing − opening, debit-positive. */
  movement: bigint;
  /** Which side of the balance sheet it sits on, for the wording of the note. */
  side: "asset" | "liability" | "equity";
};

const direction = (amount: bigint): CashFlowLine["direction"] =>
  amount > 0n ? "source" : amount < 0n ? "use" : "none";

const money = (minor: bigint, currency: string) => fmtMinor(minor, currency, { sign: "minus", zero: "zero" });

export async function cashFlowStatement(opts: {
  orgId: string;
  entityId: string;
  /** Inclusive ISO dates, the same period the profit and loss is drawn for. */
  from: string;
  to: string;
}): Promise<CashFlowStatement> {
  const from = new Date(opts.from);
  const to = new Date(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new LedgerError("A cash flow statement needs a valid start and end date.");
  }
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
  });
  if (!book) throw new LedgerError("No ledger has been opened for this entity.");

  // The opening position is the balance sheet as at the day *before* the period
  // starts. Reading it as at `from` would include the first day's postings on
  // both sides and understate every movement by a day's trading.
  const openingAsOf = new Date(from.getTime() - 86_400_000).toISOString().slice(0, 10);

  const [pl, closingBs, openingBs, disposalLines] = await Promise.all([
    profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from: opts.from, to: opts.to }),
    balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: opts.to }),
    balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: openingAsOf }),
    // A gain or loss on disposal is recognised in the same entry that takes the
    // asset out of the books, so the entry itself identifies it. Matching on
    // account code alone would sweep up every other posting to 4900 and 6900,
    // which are general-purpose accounts.
    prisma.journalLine.findMany({
      where: {
        orgId: opts.orgId,
        account: { code: { in: DISPOSAL_RESULT_CODES } },
        entry: {
          entityId: opts.entityId,
          bookId: book.id,
          status: { in: ["posted", "reversed"] },
          entryDate: { gte: from, lte: to },
          lines: {
            some: {
              account: { code: { in: FIXED_ASSET_CODES } },
              functionalAmountMinor: { lt: 0n },
            },
          },
        },
      },
      select: { functionalAmountMinor: true },
    }),
  ]);

  const currency = closingBs.currency;
  const warnings: string[] = [];

  /* ---------------------------------------------------- movements by account */

  const movements = new Map<string, Movement>();
  const collect = (
    bs: { assets: { lines: { code: string; name: string; balanceMinor: string }[] }; liabilities: { lines: { code: string; name: string; balanceMinor: string }[] }; equity: { lines: { code: string; name: string; balanceMinor: string }[] } },
    which: "opening" | "closing",
  ) => {
    for (const [side, section] of [["asset", bs.assets], ["liability", bs.liabilities], ["equity", bs.equity]] as const) {
      for (const l of section.lines) {
        // 3950 is synthesised from the profit and loss, not posted. The
        // operating section starts from that same profit directly.
        if (l.code === CURRENT_EARNINGS_CODE) continue;
        const m = movements.get(l.code) ?? {
          code: l.code, name: l.name, opening: 0n, closing: 0n, movement: 0n, side,
        };
        m[which] = BigInt(l.balanceMinor);
        movements.set(l.code, m);
      }
    }
  };
  collect(openingBs, "opening");
  collect(closingBs, "closing");
  for (const m of movements.values()) m.movement = m.closing - m.opening;

  /* --------------------------------------------------------- cash and its move */

  const cashAccounts = CASH_CODES.map((code) => movements.get(code))
    .filter((m): m is Movement => m !== undefined)
    .map((m) => ({
      code: m.code,
      name: m.name,
      openingMinor: m.opening.toString(),
      closingMinor: m.closing.toString(),
      movementMinor: m.movement.toString(),
    }));

  const openingCash = CASH_CODES.reduce((a, c) => a + (movements.get(c)?.opening ?? 0n), 0n);
  const closingCash = CASH_CODES.reduce((a, c) => a + (movements.get(c)?.closing ?? 0n), 0n);
  const cashMovementPerLedger = closingCash - openingCash;

  /* ------------------------------------------------------------ the sections */

  const netProfit = BigInt(pl.netProfitMinor);

  // The depreciation charged in the period, taken from the profit and loss it
  // was charged against rather than from the movement on 1590 — the two differ
  // whenever an asset is disposed of, because a disposal releases accumulated
  // depreciation without charging anything.
  const depLine = pl.expenses.lines.find((l) => l.code === DEPRECIATION_CODE);
  const depreciation = depLine ? BigInt(depLine.presentedMinor) : 0n;

  // Net gain (positive) or loss (negative) on disposals. Income sits on the
  // credit side and expense on the debit side, so negating the ledger sum gives
  // a gain as positive for both.
  const disposalResult = -disposalLines.reduce((a, l) => a + l.functionalAmountMinor, 0n);

  const bucketed = new Map<Bucket, Movement[]>([
    ["operating_noncash", []], ["operating_working_capital", []], ["investing", []], ["financing", []],
  ]);
  const unclassified: Movement[] = [];

  for (const m of movements.values()) {
    if (CASH_CODES.includes(m.code)) continue;
    if (m.movement === 0n) continue; // nothing moved, nothing to say
    const bucket = CLASSIFICATION[m.code];
    if (!bucket) { unclassified.push(m); continue; }
    bucketed.get(bucket)!.push(m);
  }

  const byCode = (a: Movement, b: Movement) => a.code.localeCompare(b.code, undefined, { numeric: true });

  /**
   * A balance sheet movement's effect on cash is its ledger movement negated.
   * An asset that grew absorbed cash; a liability that grew retained it. This
   * one flip is where a cash flow statement is most often wrong, so the wording
   * of the note is generated from the direction rather than written by hand.
   */
  const movementLine = (m: Movement): CashFlowLine => {
    const amount = -m.movement;
    const grew = m.side === "asset" ? m.movement > 0n : m.movement < 0n;
    const size = money(m.movement < 0n ? -m.movement : m.movement, currency);
    const note =
      m.side === "asset"
        ? grew
          ? `${m.name} rose by ${size}. Cash the business has laid out or earned but not yet collected, so it is a use of cash.`
          : `${m.name} fell by ${size}. The asset turned back into cash, so it is a source.`
        : grew
          ? `${m.name} rose by ${size}. Value received without paying for it yet, so it is a source of cash.`
          : `${m.name} fell by ${size}. It was settled, so it is a use of cash.`;
    return {
      code: m.code,
      label: m.name,
      amountMinor: amount.toString(),
      direction: direction(amount),
      movementMinor: m.movement.toString(),
      note,
    };
  };

  /* -- operating ----------------------------------------------------------- */

  const operatingLines: CashFlowLine[] = [
    {
      code: null,
      label: netProfit >= 0n ? "Profit for the period" : "Loss for the period",
      amountMinor: netProfit.toString(),
      direction: direction(netProfit),
      movementMinor: null,
      note: "The starting point of the indirect method: the result for the period before any adjustment for cash.",
    },
  ];

  if (depreciation !== 0n) {
    operatingLines.push({
      code: DEPRECIATION_CODE,
      label: "Depreciation",
      amountMinor: depreciation.toString(),
      direction: direction(depreciation),
      movementMinor: null,
      note: "Charged against profit but no cash left the business, so it is added back (IAS 7.20(b)).",
    });
  }

  if (disposalResult !== 0n) {
    operatingLines.push({
      code: null,
      label: disposalResult > 0n ? "Gain on disposal of fixed assets" : "Loss on disposal of fixed assets",
      amountMinor: (-disposalResult).toString(),
      direction: direction(-disposalResult),
      movementMinor: null,
      note:
        "The cash from a disposal is the proceeds, and those are an investing flow (IAS 7.16(b)). " +
        "The gain or loss is taken out of operating here and shown against investing instead — a transfer " +
        "between sections, so it changes neither the total nor the reconciliation.",
    });
  }

  for (const m of bucketed.get("operating_noncash")!.sort(byCode)) operatingLines.push(movementLine(m));
  for (const m of bucketed.get("operating_working_capital")!.sort(byCode)) operatingLines.push(movementLine(m));

  /* -- investing ----------------------------------------------------------- */

  const investingLines: CashFlowLine[] = [];
  for (const m of bucketed.get("investing")!.sort(byCode)) {
    if (m.code === ACCUM_DEP_CODE) {
      // The movement on accumulated depreciation is the period's charge plus
      // whatever a disposal released. The charge is already added back under
      // operating, so only the remainder belongs here. In a period with no
      // disposals this nets to nil and the line does not appear at all — which
      // is the point: depreciation is not an investing flow.
      const amount = -m.movement - depreciation;
      if (amount === 0n) continue;
      investingLines.push({
        code: m.code,
        label: "Accumulated depreciation released on disposal",
        amountMinor: amount.toString(),
        direction: direction(amount),
        movementMinor: m.movement.toString(),
        note:
          `Accumulated depreciation moved by ${money(m.movement, currency)}, of which ` +
          `${money(depreciation, currency)} is the charge for the period shown under operating activities.`,
      });
      continue;
    }
    investingLines.push(movementLine(m));
  }
  if (disposalResult !== 0n) {
    investingLines.push({
      code: null,
      label: disposalResult > 0n ? "Gain on disposal, reclassified from operating" : "Loss on disposal, reclassified from operating",
      amountMinor: disposalResult.toString(),
      direction: direction(disposalResult),
      movementMinor: null,
      note: "The other half of the transfer out of operating activities, so that investing shows the whole proceeds.",
    });
  }

  /* -- financing ----------------------------------------------------------- */

  const financingLines = bucketed.get("financing")!.sort(byCode).map(movementLine);

  const total = (lines: CashFlowLine[]) => lines.reduce((a, l) => a + BigInt(l.amountMinor), 0n);

  const operating: CashFlowSection = {
    key: "operating", label: "Operating activities", lines: operatingLines, totalMinor: total(operatingLines).toString(),
  };
  const investing: CashFlowSection = {
    key: "investing", label: "Investing activities", lines: investingLines, totalMinor: total(investingLines).toString(),
  };
  const financing: CashFlowSection = {
    key: "financing", label: "Financing activities", lines: financingLines, totalMinor: total(financingLines).toString(),
  };

  const netCashMovement =
    BigInt(operating.totalMinor) + BigInt(investing.totalMinor) + BigInt(financing.totalMinor);
  const difference = netCashMovement - cashMovementPerLedger;
  const reconciles = difference === 0n;

  /* ------------------------------------------------------------- warnings */

  for (const m of unclassified) {
    warnings.push(
      `Account ${m.code} ${m.name} moved by ${money(m.movement, currency)} in this period and is not classified ` +
        `into an operating, investing or financing activity, so it is missing from this statement. ` +
        `Add it to the cash flow classification — or, if it is a bank or cash account, to the list of cash ` +
        `and cash equivalents.`,
    );
  }

  // The operating section starts from the period's profit, which stands in for
  // the movement on current year earnings. If the two disagree the substitution
  // is unsound — most often because the period straddles a year end, where the
  // close moves the year's result into retained earnings.
  const earningsMovement =
    BigInt(closingBs.currentYearEarningsMinor) - BigInt(openingBs.currentYearEarningsMinor);
  if (earningsMovement !== netProfit) {
    warnings.push(
      `Profit for the period is ${money(netProfit, currency)} but current year earnings moved by ` +
        `${money(earningsMovement, currency)}. This period most likely crosses a fiscal year end, where the ` +
        `close carries the year's result into retained earnings. Draw the statement within one fiscal year.`,
    );
  }

  if (!reconciles) {
    warnings.push(
      `This statement does not reconcile. The three sections total ${money(netCashMovement, currency)} but cash ` +
        `and cash equivalents moved by ${money(cashMovementPerLedger, currency)}, a difference of ` +
        `${money(difference, currency)}. The difference is shown rather than absorbed into a balancing figure: ` +
        `it means a movement has been left unclassified or put in the wrong section, and a balancing figure ` +
        `would hide exactly the thing worth fixing.`,
    );
  }

  return {
    from: opts.from,
    to: opts.to,
    currency,
    operating,
    investing,
    financing,
    netCashMovementMinor: netCashMovement.toString(),
    cashMovementPerLedgerMinor: cashMovementPerLedger.toString(),
    reconciles,
    differenceMinor: difference.toString(),
    openingCashMinor: openingCash.toString(),
    closingCashMinor: closingCash.toString(),
    cashAccounts,
    warnings,
  };
}
