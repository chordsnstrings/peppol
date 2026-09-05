import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { LedgerError, post } from "./post";
import { profitAndLoss, type ProfitAndLoss } from "./statements";

/**
 * UAE corporate tax, computed from the general ledger.
 *
 * Federal Decree-Law 47/2022 applies to tax periods commencing on or after
 * 1 June 2023. Article 20 starts the computation at accounting income — the
 * profit shown by the financial statements — and adjusts it. So this module
 * starts where `profitAndLoss()` finishes rather than re-deriving profit from
 * the journal a second way: two routes to the same figure is two figures, and
 * "why does your tax computation not match your accounts" is the first
 * question an FTA audit asks.
 *
 * Every adjustment is named, carries the article or decision that requires it,
 * and says whether it was DERIVED from the chart of accounts or SUPPLIED by the
 * caller. That distinction is the whole design. The UAE SMB chart of accounts
 * cannot tell a fine from a licence fee, or entertaining a customer from flying
 * to see one — both sit in one account. Presenting a caller's estimate as if
 * the ledger had produced it is how a computation acquires an authority it has
 * not earned, so the origin travels with the number and is shown on screen.
 *
 * Where the chart can only bound an adjustment rather than determine it, the
 * bound is taken and a warning names the account. Nothing is quietly excluded.
 *
 * This computes the tax. It does not file it — the return is filed through
 * EmaraTax, by a human, on figures they have looked at.
 *
 * Deliberately out of scope, and warned about where they could bite: Qualifying
 * Free Zone Persons (Article 18), tax loss carry-forward and the 75% offset cap
 * (Article 37), transfer pricing adjustments (Articles 34-36), the specific
 * interest limitation on related-party loans (Article 31), and tax groups.
 */

/**
 * Where this module is certain and where it is not.
 *
 * Firm: the AED 375,000 nil band and the 9% rate (Article 3 with Cabinet
 * Decision 116/2022); the 50% entertainment restriction (Article 32); the
 * AED 3,000,000 Small Business Relief ceiling and its 31 December 2026 end
 * (Ministerial Decision 73/2023); the 30%-of-EBITDA interest cap with an
 * AED 12,000,000 de minimis (Article 30 with Ministerial Decision 126/2023).
 *
 * Less firm, and worth checking against the published text at review rather
 * than trusting from here: the clause numbers cited within Article 33's list of
 * non-deductible expenditure, and the exact composition of "adjusted EBITDA" —
 * Ministerial Decision 126/2023 also strips out interest on historical debt and
 * certain other items, which this does not attempt. The EBITDA figure below is
 * therefore an approximation, and the interest cap it produces should be
 * reviewed before it is relied on for a highly geared entity.
 */

/** Article 3(1)(a) with Cabinet Decision 116/2022: nil on the first AED 375,000. */
export const ZERO_BAND_MINOR = 37_500_000n;
/** Article 3(1)(b): 9% on taxable income above the band. */
export const CT_RATE_PERCENT = 9n;
/** Ministerial Decision 73/2023, Article 2: the Small Business Relief revenue ceiling. */
export const SBR_REVENUE_THRESHOLD_MINOR = 300_000_000n;
/** Ministerial Decision 73/2023, Article 2: the relief is not available after this. */
export const SBR_FINAL_PERIOD_END = "2026-12-31";
/** Ministerial Decision 126/2023: the de minimis below which the interest cap does not bite. */
export const INTEREST_DE_MINIMIS_MINOR = 1_200_000_000n;
/** Article 30(1): the cap is 30% of adjusted EBITDA where that exceeds the de minimis. */
export const INTEREST_EBITDA_PERCENT = 30n;
/** The regime applies to tax periods commencing on or after this date. */
export const REGIME_START = "2023-06-01";

const ACC_GOVERNMENT_FEES = "6300";
const ACC_TRAVEL_AND_ENTERTAINMENT = "6400";
const ACC_DEPRECIATION = "6600";
const ACC_OTHER_OPEX = "6900";
const ACC_OTHER_INCOME = "4900";
const ACC_CT_EXPENSE = "7000";
const ACC_CT_EXPENSE_FALLBACKS = ["7000", "6950", "6900"];
const ACC_CT_PAYABLE = "2400";

/** Amounts cross the API as decimal strings; BigInt is the internal form. */
export type MinorInput = bigint | number | string;

/**
 * Where an adjustment's figure came from.
 *
 *  - `derived`  — computed from named accounts in this entity's chart.
 *  - `supplied` — given by the caller. The ledger cannot see it.
 *  - `none`     — the adjustment does not arise this period.
 */
export type AdjustmentOrigin = "derived" | "supplied" | "none";

export interface TaxAdjustment {
  key: string;
  label: string;
  /** The article or ministerial decision that requires it, in one line. */
  basis: string;
  /** Signed: positive adds to taxable income, negative deducts from it. */
  amountMinor: string;
  origin: AdjustmentOrigin;
  /** Accounts the derived figure was taken from, so it can be traced. */
  accounts: string[];
  /** What was actually done, in a sentence a reviewer can check. */
  note: string;
}

export interface SmallBusinessRelief {
  /** What the caller asked for. The relief is an election; it is never automatic. */
  elected: boolean;
  /** Whether the election took effect. */
  applied: boolean;
  eligible: boolean;
  revenueMinor: string;
  thresholdMinor: string;
  /** Earlier fiscal years in this ledger, which must also be under the threshold. */
  priorPeriods: { label: string; revenueMinor: string; exceeds: boolean }[];
  /** Full sentence: why it was applied, or why it was not. */
  reason: string;
}

export interface InterestLimitation {
  netInterestExpenditureMinor: string;
  /** Taxable income before the cap, plus net interest and depreciation. */
  adjustedEbitdaMinor: string;
  thirtyPercentOfEbitdaMinor: string;
  deMinimisMinor: string;
  capMinor: string;
  capBasis: "de-minimis" | "ebitda";
  disallowedMinor: string;
  supplied: boolean;
}

export interface CorporateTaxComputation {
  entityId: string;
  periodFrom: string;
  periodTo: string;
  currency: string;
  /** Article 20: the starting point, straight off the profit and loss. */
  accountingProfitMinor: string;
  adjustments: TaxAdjustment[];
  totalAddBacksMinor: string;
  totalDeductionsMinor: string;
  /** Before any Small Business Relief election is taken into account. */
  taxableIncomeBeforeReliefMinor: string;
  taxableIncomeMinor: string;
  smallBusinessRelief: SmallBusinessRelief;
  interestLimitation: InterestLimitation;
  /** The slice taxed at 0% — Article 3(1)(a). */
  zeroBandMinor: string;
  /** The slice taxed at 9% — Article 3(1)(b). */
  taxedBandMinor: string;
  taxPayableMinor: string;
  /**
   * Tax over taxable income, in basis points. A BigInt, computed by integer
   * division: a rate that has been through a float is a rate that disagrees
   * with itself at the fourth decimal, and nobody trusts that. Null when there
   * is no taxable income to take a rate of.
   */
  effectiveRateBps: bigint | null;
  /** What the books already carry for this period against what was computed. */
  provision: {
    expenseAccount: string;
    payableAccount: string;
    expensePerLedgerMinor: string;
    payableMovementPerLedgerMinor: string;
    posted: boolean;
    matches: boolean;
    differenceMinor: string;
  };
  /** Anything that would make this computation wrong if relied on as it stands. */
  warnings: string[];
}

export interface SuppliedFigures {
  /** Fines and penalties inside the expenses — Article 33(2). */
  finesAndPenaltiesMinor?: MinorInput;
  /** Entertainment SPEND, not the disallowance. Half of it is added back. */
  entertainmentMinor?: MinorInput;
  /** Donations to a recipient that is not a Qualifying Public Benefit Entity. */
  nonQualifyingDonationsMinor?: MinorInput;
  /** Dividends and other income exempted by Articles 22-23. */
  exemptIncomeMinor?: MinorInput;
  /** Interest expenditure less interest income, for the Article 30 cap. */
  netInterestExpenditureMinor?: MinorInput;
}

/* ------------------------------------------------------------- computation */

export async function corporateTaxComputation(opts: {
  orgId: string;
  entityId: string;
  /** Inclusive ISO dates. A tax period is normally the financial year. */
  from: string;
  to: string;
  adjustments?: SuppliedFigures;
  /**
   * Small Business Relief is an ELECTION made in the return (Article 21 with
   * Ministerial Decision 73/2023). It is never the automatic consequence of
   * being small, so it is an explicit opt-in here and the output says whether
   * it was elected, whether it was available, and what it did.
   */
  smallBusinessRelief?: boolean;
}): Promise<CorporateTaxComputation> {
  const from = new Date(opts.from);
  const to = new Date(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new LedgerError("A corporate tax computation needs a valid start and end date for the tax period.");
  }
  if (to < from) throw new LedgerError("The tax period ends before it starts. Check the dates and try again.");

  const supplied = opts.adjustments ?? {};
  const warnings: string[] = [];

  const pl = await profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from: opts.from, to: opts.to });
  // Every figure quoted below is one of this book's own, so it is read in this
  // book's currency.
  const plain = plainIn(pl.currency);
  const accountingProfit = BigInt(pl.netProfitMinor);
  // Revenue for the Small Business Relief test. This is the statements' revenue
  // total, which is net of the credit notes in 4800 — Ministerial Decision
  // 73/2023 speaks of gross revenue, so an entity sitting on the threshold with
  // heavy returns should have the figure looked at rather than taken from here.
  const revenue = BigInt(pl.revenue.totalMinor);

  if (opts.from < REGIME_START) {
    warnings.push(
      `This period starts on ${opts.from}, before corporate tax took effect on ${REGIME_START}. ` +
        `Federal Decree-Law 47/2022 applies to tax periods commencing on or after that date, so a period ` +
        `beginning earlier is outside the regime and this computation is illustrative only.`,
    );
  }

  /* ---- the adjustments, in the order the computation takes them ---------- */

  const adjustments: TaxAdjustment[] = [];

  // Article 33(2). The chart's 6300 mixes trade licence fees and municipality
  // charges (deductible) with traffic and FTA penalties (not), so nothing is
  // added back on the strength of the account alone — that would overstate tax
  // on every entity that renews a licence. The account is named in a warning
  // instead, which is the honest version of "we could not tell".
  const fines = readSupplied(supplied.finesAndPenaltiesMinor, "finesAndPenaltiesMinor", pl.currency);
  const governmentFees = fromStatement(pl, ACC_GOVERNMENT_FEES);
  adjustments.push({
    key: "fines_and_penalties",
    label: "Fines and penalties",
    basis: "FDL 47/2022 Article 33(2) — fines and penalties are not deductible, other than compensation for damages or breach of contract.",
    amountMinor: fines.value.toString(),
    origin: fines.supplied ? "supplied" : "none",
    accounts: [],
    note: fines.supplied
      ? `Supplied by the preparer, not derived from the ledger. Account ${ACC_GOVERNMENT_FEES} carries ` +
        `${plain(governmentFees)} in total, which also includes deductible licence and government fees.`
      : `Nothing added back. Account ${ACC_GOVERNMENT_FEES} cannot distinguish a penalty from a licence fee, ` +
        `so no figure is derived from it.`,
  });
  if (!fines.supplied && governmentFees !== 0n) {
    warnings.push(
      `Account ${ACC_GOVERNMENT_FEES} (government fees and licences) carries ${plain(governmentFees)} and no fines ` +
        `figure was supplied, so nothing has been added back under Article 33(2). If any of it is a fine or ` +
        `penalty, supply that amount — the chart cannot tell the two apart.`,
    );
  }

  // Article 32: entertainment expenditure is 50% deductible. 6400 is "Travel
  // and entertainment", so deriving from it disallows half the airfares too.
  // The derived figure is therefore an upper bound, taken because leaving the
  // adjustment out entirely would understate tax, and flagged so the preparer
  // can narrow it with the real split.
  const entertainmentSupplied = readSupplied(supplied.entertainmentMinor, "entertainmentMinor", pl.currency);
  const travelAndEntertainment = fromStatement(pl, ACC_TRAVEL_AND_ENTERTAINMENT);
  const entertainmentSpend = entertainmentSupplied.supplied ? entertainmentSupplied.value : travelAndEntertainment;
  // Half of an odd number of fils rounds up, against the taxpayer, because the
  // deduction is what is capped at 50% and the fil has to land somewhere.
  const entertainmentAddBack = (entertainmentSpend + 1n) / 2n;
  adjustments.push({
    key: "entertainment",
    label: "Entertainment expenditure — 50% disallowed",
    basis: "FDL 47/2022 Article 32 — only 50% of expenditure incurred to entertain customers, shareholders, suppliers and other business partners is deductible.",
    amountMinor: entertainmentAddBack.toString(),
    // A supplied zero is still a supplied answer — "we looked, nobody was
    // entertained" is not the same as "the account was empty".
    origin: entertainmentSupplied.supplied ? "supplied" : entertainmentSpend === 0n ? "none" : "derived",
    accounts: entertainmentSupplied.supplied || entertainmentSpend === 0n ? [] : [ACC_TRAVEL_AND_ENTERTAINMENT],
    note: entertainmentSupplied.supplied
      ? `Half of ${plain(entertainmentSpend)} of entertainment supplied by the preparer. Account ` +
        `${ACC_TRAVEL_AND_ENTERTAINMENT} carries ${plain(travelAndEntertainment)} in total.`
      : `Half of account ${ACC_TRAVEL_AND_ENTERTAINMENT} (${plain(travelAndEntertainment)}), which mixes travel with ` +
        `entertainment. Supply the entertainment figure to narrow it.`,
  });
  if (!entertainmentSupplied.supplied && travelAndEntertainment !== 0n) {
    warnings.push(
      `Half of account ${ACC_TRAVEL_AND_ENTERTAINMENT} (travel and entertainment) has been disallowed under ` +
        `Article 32, but that account also holds travel, which is fully deductible. This overstates the add-back ` +
        `unless the account is entertainment only. Supply the entertainment figure to fix it.`,
    );
  }

  // Article 33(1). No account in the UAE SMB chart isolates donations — they
  // land in 6200 marketing or 6900 other expenses — so this one can only be
  // supplied.
  const donations = readSupplied(supplied.nonQualifyingDonationsMinor, "nonQualifyingDonationsMinor", pl.currency);
  adjustments.push({
    key: "non_qualifying_donations",
    label: "Donations to non-qualifying recipients",
    basis: "FDL 47/2022 Article 33(1) — donations, grants and gifts are not deductible unless the recipient is a Qualifying Public Benefit Entity listed by Cabinet decision.",
    amountMinor: donations.value.toString(),
    origin: donations.supplied ? "supplied" : "none",
    accounts: [],
    note: donations.supplied
      ? `Supplied by the preparer, not derived from the ledger. Donations to a listed Qualifying Public Benefit ` +
        `Entity stay deductible and should not be included here.`
      : `Nothing added back. No account in this chart isolates donations; they typically sit inside ` +
        `${ACC_OTHER_OPEX}. Supply the figure if any were made.`,
  });

  // Article 33(6): corporate tax itself is not deductible. This matters here
  // and not only in theory — postTaxProvision() debits an expense account, so
  // running the computation again after posting the provision would otherwise
  // tax a profit that had already been reduced by its own tax.
  const ctExpense = fromStatement(pl, ACC_CT_EXPENSE);
  adjustments.push({
    key: "corporate_tax_expense",
    label: "Corporate tax charged in the accounts",
    basis: "FDL 47/2022 Article 33(6) — corporate tax imposed under the Decree-Law is not itself deductible.",
    amountMinor: ctExpense.toString(),
    origin: ctExpense === 0n ? "none" : "derived",
    accounts: ctExpense === 0n ? [] : [ACC_CT_EXPENSE],
    note: ctExpense === 0n
      ? `No corporate tax has been charged to profit for this period.`
      : `Account ${ACC_CT_EXPENSE} carries ${plain(ctExpense)}, added back so the tax is not computed on a profit ` +
        `already reduced by its own provision.`,
  });

  // Articles 22-23. Dividends from a UAE resident juridical person are exempt,
  // as are qualifying foreign participations. The chart posts them to 4900
  // "Other income" alongside everything else, so this too can only be supplied.
  const exempt = readSupplied(supplied.exemptIncomeMinor, "exemptIncomeMinor", pl.currency);
  const otherIncome = fromStatement(pl, ACC_OTHER_INCOME);
  // Exempt income is a slice of income the books already recorded, not a new
  // number. If it is bigger than all the income there was, something has been
  // entered in the wrong place and the taxable figure would be unsupportable.
  if (exempt.value > revenue) {
    throw new LedgerError(
      `Exempt income of ${plain(exempt.value)} exceeds the entity's total income for the period ` +
        `(${plain(revenue)}). Deducting income the books never recorded would produce a taxable figure ` +
        `nothing supports.`,
    );
  }
  adjustments.push({
    key: "exempt_income",
    label: "Exempt income deducted",
    basis: "FDL 47/2022 Article 22 — dividends and other profit distributions from a UAE resident juridical person are exempt; Article 23 exempts qualifying participations.",
    amountMinor: (-exempt.value).toString(),
    origin: exempt.supplied ? "supplied" : "none",
    accounts: [],
    note: exempt.supplied
      ? `Supplied by the preparer, not derived from the ledger. Account ${ACC_OTHER_INCOME} carries ` +
        `${plain(otherIncome)} of other income in total.`
      : `Nothing deducted. Account ${ACC_OTHER_INCOME} does not separate exempt dividends from taxable other income.`,
  });
  if (!exempt.supplied && otherIncome !== 0n) {
    warnings.push(
      `Account ${ACC_OTHER_INCOME} (other income) carries ${plain(otherIncome)} and no exempt income was supplied, ` +
        `so all of it has been taxed. If any part is a dividend exempt under Article 22, supply it.`,
    );
  }

  // Article 30, the General Interest Deduction Limitation Rule, is applied
  // last because Ministerial Decision 126/2023 defines adjusted EBITDA from
  // TAXABLE income — so every other adjustment has to be in before the cap can
  // be measured.
  const beforeInterest = accountingProfit + adjustments.reduce((a, x) => a + BigInt(x.amountMinor), 0n);
  const netInterest = readSupplied(supplied.netInterestExpenditureMinor, "netInterestExpenditureMinor", pl.currency);
  const depreciation = fromStatement(pl, ACC_DEPRECIATION);
  // Adjusted EBITDA floors at zero (Ministerial Decision 126/2023): a loss-making
  // period does not get a negative allowance.
  const rawEbitda = beforeInterest + netInterest.value + depreciation;
  const adjustedEbitda = rawEbitda < 0n ? 0n : rawEbitda;
  const thirtyPercent = (adjustedEbitda * INTEREST_EBITDA_PERCENT) / 100n;
  const capBasis: "de-minimis" | "ebitda" = thirtyPercent > INTEREST_DE_MINIMIS_MINOR ? "ebitda" : "de-minimis";
  const cap = capBasis === "ebitda" ? thirtyPercent : INTEREST_DE_MINIMIS_MINOR;
  const disallowedInterest = netInterest.value > cap ? netInterest.value - cap : 0n;
  adjustments.push({
    key: "interest_cap",
    label: "Net interest above the deduction cap",
    basis: "FDL 47/2022 Article 30 with Ministerial Decision 126/2023 — net interest expenditure is deductible up to the greater of 30% of adjusted EBITDA and AED 12,000,000.",
    amountMinor: disallowedInterest.toString(),
    origin: netInterest.supplied ? "supplied" : "none",
    accounts: [],
    note: netInterest.supplied
      ? `Net interest of ${plain(netInterest.value)} supplied by the preparer against a cap of ${plain(cap)} ` +
        `(${capBasis === "ebitda" ? "30% of adjusted EBITDA" : "the AED 12,000,000 de minimis"}).`
      : `No net interest expenditure was supplied and this chart has no interest expense account, so the cap ` +
        `has not been applied.`,
  });
  if (disallowedInterest > 0n) {
    warnings.push(
      `${plain(disallowedInterest)} of net interest exceeds the Article 30 cap of ${plain(cap)} and has been added ` +
        `back. Article 30(3) allows the disallowed amount to be carried forward for up to ten tax periods; this ` +
        `computation does not track that carry-forward.`,
    );
  }

  const totalAddBacks = adjustments.reduce((a, x) => (BigInt(x.amountMinor) > 0n ? a + BigInt(x.amountMinor) : a), 0n);
  const totalDeductions = adjustments.reduce((a, x) => (BigInt(x.amountMinor) < 0n ? a - BigInt(x.amountMinor) : a), 0n);
  const taxableBeforeRelief = accountingProfit + totalAddBacks - totalDeductions;

  /* ---- Small Business Relief: an election, never an outcome -------------- */

  const relief = await assessSmallBusinessRelief({
    orgId: opts.orgId,
    entityId: opts.entityId,
    from,
    to: opts.to,
    revenue,
    elected: opts.smallBusinessRelief === true,
    currency: pl.currency,
  });
  if (relief.elected && !relief.eligible) {
    warnings.push(
      `Small Business Relief was elected but is not available: ${relief.reason} Tax has been computed in full.`,
    );
  }
  if (relief.applied) {
    warnings.push(
      `Small Business Relief has been applied because it was elected, so taxable income is treated as nil under ` +
        `Ministerial Decision 73/2023. This computation cannot see whether the entity is a Qualifying Free Zone ` +
        `Person or a member of a multinational group, both of which lose the relief, nor its revenue in periods ` +
        `before this ledger begins.`,
    );
  }
  // Being just under the ceiling is the dangerous place to be: one more invoice
  // and the relief is gone for the whole period, retrospectively.
  if (revenue <= SBR_REVENUE_THRESHOLD_MINOR && revenue * 10n >= SBR_REVENUE_THRESHOLD_MINOR * 9n && revenue > 0n) {
    warnings.push(
      `Revenue of ${plain(revenue)} is within 10% of the AED 3,000,000 Small Business Relief ceiling. Crossing it ` +
        `at any point in the tax period removes the relief for the whole period, not just for the excess.`,
    );
  }

  /* ---- the bands ------------------------------------------------------- */

  const taxableIncome = relief.applied ? 0n : taxableBeforeRelief;
  // A loss is not negative taxable income for the purpose of the bands; it is
  // no taxable income at all.
  const positiveIncome = taxableIncome > 0n ? taxableIncome : 0n;
  const zeroBand = positiveIncome < ZERO_BAND_MINOR ? positiveIncome : ZERO_BAND_MINOR;
  const taxedBand = positiveIncome > ZERO_BAND_MINOR ? positiveIncome - ZERO_BAND_MINOR : 0n;
  // 9% of the excess, half-up on the fil, entirely in BigInt.
  const taxPayable = (taxedBand * CT_RATE_PERCENT + 50n) / 100n;

  if (taxableBeforeRelief < 0n) {
    warnings.push(
      `The period is a taxable loss of ${plain(-taxableBeforeRelief)}, so no corporate tax arises. Article 37 lets ` +
        `the loss be carried forward and set against up to 75% of a later period's taxable income; this ` +
        `computation does not track loss carry-forward, so a later period will not relieve it automatically.`,
    );
  }

  /* ---- what the books already carry ------------------------------------ */

  // The same reconciliation habit as the VAT return: the computed charge is
  // checked against the control accounts it should have reached, and the answer
  // is returned rather than asserted quietly.
  const payableMovement = await payableMovementFor(opts.orgId, opts.entityId, from, to);
  const posted = ctExpense !== 0n || payableMovement !== 0n;
  const provisionMatches = ctExpense === taxPayable && payableMovement === taxPayable;
  if (posted && !provisionMatches) {
    warnings.push(
      `The provision in the books (${plain(ctExpense)} in ${ACC_CT_EXPENSE}, ${plain(payableMovement)} in ` +
        `${ACC_CT_PAYABLE}) does not equal the computed charge of ${plain(taxPayable)}. Reverse the provision and ` +
        `post it again, or explain the difference before relying on either figure.`,
    );
  }
  if (!posted && taxPayable > 0n) {
    warnings.push(
      `Corporate tax of ${plain(taxPayable)} has been computed but no provision has been posted, so the balance ` +
        `sheet does not yet carry the liability.`,
    );
  }

  return {
    entityId: opts.entityId,
    periodFrom: opts.from,
    periodTo: opts.to,
    currency: pl.currency,
    accountingProfitMinor: accountingProfit.toString(),
    adjustments,
    totalAddBacksMinor: totalAddBacks.toString(),
    totalDeductionsMinor: totalDeductions.toString(),
    taxableIncomeBeforeReliefMinor: taxableBeforeRelief.toString(),
    taxableIncomeMinor: taxableIncome.toString(),
    smallBusinessRelief: relief,
    interestLimitation: {
      netInterestExpenditureMinor: netInterest.value.toString(),
      adjustedEbitdaMinor: adjustedEbitda.toString(),
      thirtyPercentOfEbitdaMinor: thirtyPercent.toString(),
      deMinimisMinor: INTEREST_DE_MINIMIS_MINOR.toString(),
      capMinor: cap.toString(),
      capBasis,
      disallowedMinor: disallowedInterest.toString(),
      supplied: netInterest.supplied,
    },
    zeroBandMinor: zeroBand.toString(),
    taxedBandMinor: taxedBand.toString(),
    taxPayableMinor: taxPayable.toString(),
    effectiveRateBps: positiveIncome === 0n ? null : (taxPayable * 10_000n) / positiveIncome,
    provision: {
      expenseAccount: ACC_CT_EXPENSE,
      payableAccount: ACC_CT_PAYABLE,
      expensePerLedgerMinor: ctExpense.toString(),
      payableMovementPerLedgerMinor: payableMovement.toString(),
      posted,
      matches: provisionMatches,
      differenceMinor: (taxPayable - ctExpense).toString(),
    },
    warnings,
  };
}

/* --------------------------------------------------- small business relief */

/**
 * The revenue test, from the ledger.
 *
 * Ministerial Decision 73/2023 requires revenue at or below AED 3,000,000 in
 * the tax period AND in every previous tax period, for periods ending on or
 * before 31 December 2026. Previous periods are tested against the fiscal years
 * this ledger actually holds — which is all it can see, and the reason the
 * result says so in as many words rather than implying a clean bill of health.
 */
async function assessSmallBusinessRelief(opts: {
  orgId: string;
  entityId: string;
  from: Date;
  to: string;
  revenue: bigint;
  elected: boolean;
  /** The book's currency; the AED thresholds below are the law's, not the book's. */
  currency: string;
}): Promise<SmallBusinessRelief> {
  const plain = plainIn(opts.currency);
  const priorYears = await prisma.fiscalYear.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, endsOn: { lt: opts.from } },
    orderBy: { startsOn: "asc" },
  });

  const priorPeriods: SmallBusinessRelief["priorPeriods"] = [];
  for (const y of priorYears) {
    const prior = await profitAndLoss({
      orgId: opts.orgId,
      entityId: opts.entityId,
      from: y.startsOn.toISOString().slice(0, 10),
      to: y.endsOn.toISOString().slice(0, 10),
    });
    const rev = BigInt(prior.revenue.totalMinor);
    priorPeriods.push({
      label: y.label,
      revenueMinor: rev.toString(),
      exceeds: rev > SBR_REVENUE_THRESHOLD_MINOR,
    });
  }

  const breachedPrior = priorPeriods.filter((p) => p.exceeds);
  const tooLate = opts.to > SBR_FINAL_PERIOD_END;
  const overThreshold = opts.revenue > SBR_REVENUE_THRESHOLD_MINOR;

  let eligible = true;
  let reason: string;
  if (tooLate) {
    eligible = false;
    reason =
      `the tax period ends on ${opts.to}, after ${SBR_FINAL_PERIOD_END}, and Ministerial Decision 73/2023 makes ` +
      `the relief available only for tax periods ending on or before that date.`;
  } else if (overThreshold) {
    eligible = false;
    reason =
      `revenue of ${plain(opts.revenue)} exceeds the AED 3,000,000 threshold in Ministerial Decision 73/2023 for ` +
      `this tax period.`;
  } else if (breachedPrior.length) {
    eligible = false;
    reason =
      `revenue exceeded AED 3,000,000 in ${breachedPrior.map((p) => p.label).join(", ")}, and the relief requires ` +
      `every previous tax period to be under the threshold as well.`;
  } else {
    reason =
      `revenue of ${plain(opts.revenue)} is at or below the AED 3,000,000 threshold in this period and in the ` +
      `${priorPeriods.length} previous fiscal year${priorPeriods.length === 1 ? "" : "s"} this ledger holds. ` +
      `Periods before this ledger begins, free zone status and multinational group membership have not been tested.`;
  }

  return {
    elected: opts.elected,
    applied: opts.elected && eligible,
    eligible,
    revenueMinor: opts.revenue.toString(),
    thresholdMinor: SBR_REVENUE_THRESHOLD_MINOR.toString(),
    priorPeriods,
    reason: eligible
      ? opts.elected
        ? `Elected and available: ${reason}`
        : `Available but not elected — the relief only applies if it is claimed in the return. It is available because ${reason}`
      : `Not available: ${reason}`,
  };
}

/* --------------------------------------------------------- the provision */

export interface TaxProvisionResult {
  fiscalYear: string;
  entryId: string;
  reference: string;
  amountMinor: string;
  expenseAccount: string;
  payableAccount: string;
  periodLabel: string;
  /** True when the entry already existed and this call changed nothing. */
  alreadyPosted: boolean;
  warnings: string[];
}

/**
 * Charge the year's corporate tax to profit and recognise the liability:
 * Dr corporate tax expense, Cr 2400 corporate tax payable.
 *
 * Idempotent on `corptax:<entity>:<year>`, because a provision posted twice is
 * a liability recognised twice, and the second one is invisible until someone
 * reconciles the balance sheet. A repeat call returns the original entry.
 */
export async function postTaxProvision(opts: {
  orgId: string;
  entityId: string;
  fiscalYear: string;
  amountMinor: MinorInput;
  actorId?: string;
}): Promise<TaxProvisionResult> {
  const plain = plainIn(await bookCurrency(opts.orgId, opts.entityId));
  const amount = parseMinor(opts.amountMinor, "amountMinor");
  if (amount <= 0n) {
    throw new LedgerError(
      `A corporate tax provision must be a positive amount; ${plain(amount)} was given. A period with no tax needs ` +
        `no entry at all.`,
    );
  }

  const year = await prisma.fiscalYear.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, label: opts.fiscalYear },
    include: { periods: { orderBy: { seq: "asc" } } },
  });
  if (!year) {
    throw new LedgerError(`There is no fiscal year "${opts.fiscalYear}" for this entity. Open it before providing for its tax.`);
  }

  const externalKey = `corptax:${opts.entityId}:${opts.fiscalYear}`;
  const warnings: string[] = [];

  const existing = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey },
    include: { lines: true, period: { select: { label: true } } },
  });
  if (existing) {
    const postedAmount = existing.lines.reduce((a, l) => (l.functionalAmountMinor > 0n ? a + l.functionalAmountMinor : a), 0n);
    if (postedAmount !== amount) {
      warnings.push(
        `A provision of ${plain(postedAmount)} was already posted for ${opts.fiscalYear} as ` +
          `${existing.series}-${existing.number}; the ${plain(amount)} requested now has been ignored. Reverse that ` +
          `entry and post again if the computation has changed — a posted entry is never edited.`,
      );
    }
    return {
      fiscalYear: opts.fiscalYear,
      entryId: existing.id,
      reference: `${existing.series}-${existing.number}`,
      amountMinor: postedAmount.toString(),
      expenseAccount: ACC_CT_EXPENSE,
      payableAccount: ACC_CT_PAYABLE,
      periodLabel: existing.period.label,
      alreadyPosted: true,
      warnings,
    };
  }

  // The chart seeds 7000 with subtype CT_EXPENSE. Older charts may not have it,
  // so fall back through the codes that could plausibly carry the charge and
  // say which one was used rather than failing on a missing account.
  const accounts = await prisma.account.findMany({
    where: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      OR: [{ subtype: "CT_EXPENSE" }, { code: { in: ACC_CT_EXPENSE_FALLBACKS } }],
    },
  });
  const usable = accounts.filter((a) => a.isPostable && a.status === "active" && !a.isControl);
  const expense =
    usable.find((a) => a.subtype === "CT_EXPENSE") ??
    ACC_CT_EXPENSE_FALLBACKS.map((c) => usable.find((a) => a.code === c)).find(Boolean);
  if (!expense) {
    throw new LedgerError(
      `This entity's chart has no corporate tax expense account and no ${ACC_OTHER_OPEX} to fall back on. ` +
        `Add an expense account for the charge before providing for it.`,
    );
  }
  if (expense.subtype !== "CT_EXPENSE") {
    warnings.push(
      `This chart has no dedicated corporate tax expense account, so the charge has been posted to ` +
        `${expense.code} ${expense.name}. Add an account with subtype CT_EXPENSE to keep the tax charge out of ` +
        `operating expenses.`,
    );
  }

  const payable = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: ACC_CT_PAYABLE },
  });
  if (!payable) {
    throw new LedgerError(
      `Account ${ACC_CT_PAYABLE} (corporate tax payable) does not exist in this entity's chart, so the liability ` +
        `has nowhere to go. Seed the standard chart of accounts first.`,
    );
  }

  // The provision belongs in the year's adjustment period for the same reason
  // the closing entry does: it is a year-end adjustment, and putting it in
  // December would make December's own result include the whole year's tax.
  const adjustment = year.periods.find((p) => p.isAdjustment);
  const target = adjustment ?? year.periods[year.periods.length - 1];
  if (!target) {
    throw new LedgerError(`Fiscal year ${opts.fiscalYear} has no periods, so the provision has nowhere to post.`);
  }
  if (target.status !== "open") {
    throw new LedgerError(
      `Period ${target.label} is ${target.status.replace("_", " ")}, so the ${opts.fiscalYear} tax provision cannot ` +
        `be posted into it. Reopen it, post the provision, then close it again.`,
    );
  }
  if (!adjustment) {
    warnings.push(
      `Fiscal year ${opts.fiscalYear} has no adjustment period, so the provision has been posted into ` +
        `${target.label}. That month's own figures now include the whole year's tax charge.`,
    );
  }

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: target.endsOn,
    // Named explicitly: the adjustment period shares its last day with the
    // final trading month, so the date alone cannot distinguish them.
    periodId: target.id,
    memo: `Corporate tax provision for ${opts.fiscalYear}`,
    source: "tax",
    sourceType: "CORPORATE_TAX",
    sourceId: opts.fiscalYear,
    externalKey,
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "CT",
    lines: [
      { account: expense.code, debit: amount, memo: `Corporate tax charge for ${opts.fiscalYear}` },
      { account: ACC_CT_PAYABLE, credit: amount, memo: `Corporate tax payable for ${opts.fiscalYear}` },
    ],
  });

  return {
    fiscalYear: opts.fiscalYear,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    amountMinor: amount.toString(),
    expenseAccount: expense.code,
    payableAccount: ACC_CT_PAYABLE,
    periodLabel: target.label,
    alreadyPosted: false,
    warnings,
  };
}

/* ------------------------------------------------------------------ helpers */

/**
 * An account's movement for the period, taken from the statement rather than
 * from a second pass over the journal — the same principle that keeps the VAT
 * return and the trial balance from disagreeing. `presentedMinor` is already on
 * the account's natural side, so an expense reads positive.
 *
 * Sub-accounts count: a chart that splits 6400 into 6400 and 6401 should still
 * have both disallowed.
 */
function fromStatement(pl: ProfitAndLoss, code: string): bigint {
  const lines = [...pl.revenue.lines, ...pl.costOfSales.lines, ...pl.expenses.lines];
  return lines
    .filter((l) => l.code === code || l.code.startsWith(code))
    .reduce((a, l) => a + BigInt(l.presentedMinor), 0n);
}

/** Credit movement on the corporate tax payable account within the period. */
async function payableMovementFor(orgId: string, entityId: string, from: Date, to: Date): Promise<bigint> {
  const lines = await prisma.journalLine.findMany({
    where: {
      orgId,
      account: { entityId, code: ACC_CT_PAYABLE },
      entry: { entityId, status: { in: ["posted", "reversed"] }, entryDate: { gte: from, lte: to } },
    },
    select: { functionalAmountMinor: true },
  });
  // A liability is held on the credit side; report the movement as positive.
  return lines.reduce((a, l) => a - l.functionalAmountMinor, 0n);
}

function parseMinor(v: MinorInput, field: string): bigint {
  if (typeof v === "number" && !Number.isInteger(v)) {
    throw new LedgerError(`${field} must be a whole number of minor units (fils), got ${v}.`);
  }
  if (typeof v === "string" && !/^-?\d+$/.test(v.trim())) {
    throw new LedgerError(`${field} must be a whole number of minor units (fils), got "${v}".`);
  }
  return BigInt(typeof v === "string" ? v.trim() : v);
}

/**
 * A supplied adjustment figure, with the fact that it was supplied kept
 * alongside it. Zero is a supplied answer too — "we looked, there were no
 * fines" is different from "nobody said" — so the flag comes from whether the
 * caller passed the field, not from whether the value is non-zero.
 */
function readSupplied(
  v: MinorInput | undefined,
  field: string,
  /** The book's currency, so the refusal quotes the figure as the book reads it. */
  currency: string,
): { value: bigint; supplied: boolean } {
  if (v === undefined || v === null) return { value: 0n, supplied: false };
  const value = parseMinor(v, field);
  if (value < 0n) {
    throw new LedgerError(
      `${field} must not be negative; ${plainIn(currency)(value)} was given. Adjustments are entered as positive amounts and ` +
        `the computation applies them in the right direction.`,
    );
  }
  return { value, supplied: true };
}

/**
 * Minor units as a decimal, for messages a human reads, in the currency the
 * figure is actually in.
 *
 * This used to print the letters AED and split the digits two from the right
 * whatever the book was kept in. Both halves were wrong for a book kept
 * elsewhere: the amounts quoted below come off this entity's own profit and
 * loss, and a dinar has three decimals rather than two, so the same helper
 * mislabelled the currency and misplaced its point by a factor of ten at once.
 * `fmtMinor` is the one function that knows each currency's exponent.
 *
 * The thresholds in the Corporate Tax Law are a separate matter: they are
 * dirham figures whatever the book is kept in, and are written as such.
 */
const plainIn = (currency: string) => (minor: bigint): string => {
  const neg = minor < 0n;
  return `${neg ? "-" : ""}${currency} ${fmtMinor(neg ? -minor : minor, currency, { zero: "zero" })}`;
};

/** The book's own currency, for the sentences a computation produces. */
async function bookCurrency(orgId: string, entityId: string): Promise<string> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  return book?.functionalCurrency ?? "AED";
}
