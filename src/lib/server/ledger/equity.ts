import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { LedgerError } from "./post";
import { balanceSheet, type BalanceSheet } from "./statements";
import { assetRegister } from "./assets";
import { leaseRegister } from "./leases";
import { receivablesAgeing } from "./ar";
import { payablesAgeing } from "./ap";
import { corporateTaxComputation } from "./corptax";
import { cashCodesFrom } from "./cash";
import { revaluationRegister } from "./asset-revaluation";
import { provisionNote, type ProvisionNoteResult } from "./provisions";
import { deferredTaxNote, type DeferredTaxNoteResult } from "./deferred-tax";
import { relatedPartyNote as relatedPartyDisclosure, type RelatedPartyNoteData } from "./related-parties";
import { allowanceView, ALLOWANCE_SOURCE_TYPE } from "./allowance";

/**
 * The statement of changes in equity (IAS 1.106), and the notes.
 *
 * A set of financial statements is four statements and the notes. The other
 * three are already here; this is the fourth, and the notes that make the other
 * three readable.
 *
 * Nothing in this module is stored. Every figure is derived from the ledger at
 * the moment it is asked for, which is the whole argument for building it this
 * way: a note typed into a document is a note that stops agreeing with the
 * accounts the next time anyone posts a journal, and nobody finds out until an
 * auditor does. So there is no schema here, no "notes" table, and no field a
 * preparer can quietly override.
 *
 * The two things the statement has to get right:
 *
 *  1. Profit for the period is NOT a posted balance in retained earnings until
 *     the year is closed. It is derived exactly as `balanceSheet()` derives
 *     current-year earnings — by summing what is left in the income and expense
 *     accounts — plus whatever the closing entry has already carried across.
 *     Those two are mutually exclusive by construction (closing a year brings
 *     income and expense to zero and posts the result to 3900), so adding them
 *     gives the year's result once, whether the year is open, closed, or the
 *     year after an unclosed one.
 *
 *     Reading a FiscalYear row instead would be simpler and wrong in the same
 *     way it was wrong on the balance sheet: it would report a figure the
 *     ledger does not hold, and the two would part company the first time
 *     someone posted an adjustment after the close.
 *
 *  2. The closing equity this statement arrives at must equal the equity
 *     section of `balanceSheet()` at the year end. That is the proof, exactly
 *     as the cash flow statement proves itself against the movement in cash:
 *     the closing balances here are built up from the opening position and the
 *     classified movements, NOT read back off the balance sheet, so if a
 *     movement is missed or an equity account is not one of the columns, the
 *     two figures differ and the statement says so and names the account.
 *     Nothing is plugged.
 *
 * The notes follow one rule that runs through all of them: a note with nothing
 * in it and a note nobody has filled in are different facts. An entity with no
 * leases has an empty leases note; an entity that has never been asked about
 * events after the reporting period has no such note at all, and saying
 * "nothing to disclose" on its behalf would be inventing a representation the
 * preparer never made. `state` carries that distinction, and the screen shows
 * the two differently.
 */

/* ------------------------------------------------------------ the columns */

const SHARE_CAPITAL = "3000";
const SHAREHOLDER_CURRENT = "3100";
const STATUTORY_RESERVE = "3200";
const REVALUATION_SURPLUS = "3300";
const RETAINED_EARNINGS = "3900";

/**
 * Synthesised by `balanceSheet()` from the income and expense accounts, never
 * posted. It is the profit row of this statement, so it is not a column.
 */
const CURRENT_YEAR_EARNINGS = "3950";

/**
 * In balance sheet order, so the statement reads down the equity section.
 *
 * 3300 is here because the product ships a revaluation module that credits it.
 * Leaving it out put every surplus into `unclassified`, whose remedy — "add it
 * to the equity columns" — is not one any user of this software can carry out,
 * and the statement then declared itself unreconciled by exactly the surplus,
 * every year afterwards, whether or not the account had moved.
 */
const EQUITY_COLUMNS = [
  SHARE_CAPITAL,
  SHAREHOLDER_CURRENT,
  STATUTORY_RESERVE,
  REVALUATION_SURPLUS,
  RETAINED_EARNINGS,
];

/** Cost of property, plant and equipment, and the contra account against it. */
const PPE_COST_CODES = ["1500", "1600"];
const ACCUM_DEPRECIATION = "1590";
/**
 * Intangibles, which are not property, plant and equipment and were disclosed
 * as though they were.
 *
 * A capitalised licence went onto the fixed asset register as category IT and
 * therefore onto 1500, amortised through 6600 "Depreciation", and appeared
 * under a note headed "Property, plant and equipment". The arithmetic was
 * right — straight-line over a finite life IS amortisation — and the caption,
 * the accounts and the disclosure were all wrong. IAS 38.118 asks for its own
 * reconciliation, and this is it.
 */
const INTANGIBLE_COST = "1560";
const ACCUM_AMORTISATION = "1570";
const AMORTISATION_EXPENSE = "6610";

/**
 * The source on entries the revaluation module made. It restates cost against
 * accumulated depreciation (IAS 16.35(b)), so its postings look exactly like
 * an addition and a disposal to anything reading the sign of a line alone.
 */
const REVALUATION_SOURCE = "revaluation";

/** Where a write-down beyond an asset's own surplus lands (IAS 36.60). */
const IMPAIRMENT_EXPENSE = "6650";

const ROU_ASSET = "1700";
const LEASE_LIABILITY = "2600";
const LEASE_FINANCE_COST = "6360";
const LEASE_RENT = "6100";

const TRADE_RECEIVABLES = "1100";
const DOUBTFUL_DEBT_ALLOWANCE = "1150";
const TRADE_PAYABLES = "2000";

const CT_EXPENSE = "7000";
const CT_PAYABLE = "2400";

/* ------------------------------------------------------------------ types */

export type EquityRowKey =
  | "opening"
  | "prior_period_adjustment"
  | "profit_for_period"
  | "revaluation"
  | "share_capital"
  | "capital_introduced"
  | "reserve_transfer"
  | "transfer_within_equity"
  | "distributions"
  | "closing";

export interface EquityColumn {
  code: string;
  name: string;
  nameAr: string | null;
}

export interface EquityRow {
  key: EquityRowKey;
  label: string;
  /** A position at a date, or what happened between two of them. */
  kind: "balance" | "movement";
  /**
   * Column code → amount, credit-positive: the side equity naturally sits on.
   * A dividend is therefore negative and renders in parentheses. Every column
   * is present, including the ones that did not move, so the matrix is
   * rectangular and can be added up in either direction.
   */
  cells: Record<string, string>;
  /** Across the row. */
  totalMinor: string;
  /** Whether the figures are posted in the ledger, derived from it, or both. */
  origin: "posted" | "derived" | "mixed";
  /** What this row holds, and why it holds it. */
  note: string;
}

export interface StatementOfChangesInEquity {
  fiscalYear: string;
  from: string;
  to: string;
  currency: string;
  /** The closing entry has been posted, so the year's result is in 3900. */
  closed: boolean;
  columns: EquityColumn[];
  opening: EquityRow;
  movements: EquityRow[];
  closing: EquityRow;
  /** Down the columns: the closing balances, added across. */
  totalByColumnsMinor: string;
  /** Across the rows: every row total, added down. */
  totalByRowsMinor: string;
  /** The matrix adds to the same figure both ways. */
  foots: boolean;
  /** Equity per `balanceSheet()` at the year end — the independent figure. */
  equityPerBalanceSheetMinor: string;
  /** The proof. Not hoped for; computed. */
  reconciles: boolean;
  /** This statement less the balance sheet. Shown, never absorbed. */
  differenceMinor: string;
  /** The year's result, derived the way the balance sheet derives it. */
  profitForThePeriodMinor: string;
  warnings: string[];
}

export type NoteState = "present" | "empty" | "requires_input";

interface NoteBase {
  /** Position in the notes, 1-based, as the statements refer to it. */
  number: number;
  title: string;
  /** The standard that asks for the note. */
  basis: string;
  state: NoteState;
  /** Why the note is in the state it is, in a sentence. */
  statement: string;
}

export interface AccountingPolicy {
  key: string;
  label: string;
  /** The policy itself. */
  policy: string;
  basis: string;
  /** What in this entity's data means the policy is needed at all. */
  evidence: string;
}

export interface PolicyNote extends NoteBase {
  key: "accounting_policies";
  functionalCurrency: string;
  presentationCurrency: string;
  policies: AccountingPolicy[];
}

export interface IntangiblesNote extends NoteBase {
  key: "intangible_assets";
  costAccount: string;
  accumulatedAmortisationAccount: string;
  cost: {
    openingMinor: string;
    additionsMinor: string;
    disposalsMinor: string;
    closingMinor: string;
    perBalanceSheetMinor: string;
    agrees: boolean;
  };
  accumulatedAmortisation: {
    openingMinor: string;
    chargeMinor: string;
    releasedOnDisposalMinor: string;
    closingMinor: string;
    perBalanceSheetMinor: string;
    agrees: boolean;
  };
  netBookValue: { openingMinor: string; closingMinor: string };
  /** IAS 38.118(a): amortisation period, by class. */
  byCategory: {
    category: string;
    count: number;
    costMinor: string;
    accumulatedMinor: string;
    netBookValueMinor: string;
    shortestLifeMonths: number;
    longestLifeMonths: number;
  }[];
  /**
   * What this note cannot say, listed rather than left out. IAS 38 asks for
   * things the ledger does not hold, and a note that quietly omits them reads
   * as a note that had nothing to say.
   */
  notDerivable: string[];
}

export interface PpeNote extends NoteBase {
  key: "property_plant_and_equipment";
  costAccounts: string[];
  accumulatedDepreciationAccount: string;
  cost: {
    openingMinor: string;
    additionsMinor: string;
    disposalsMinor: string;
    /**
     * What the revaluation module did to the cost account: the accumulated
     * depreciation it eliminated against cost, and the uplift or write-down
     * itself. Signed, because a write-down reduces cost.
     */
    revaluationMinor: string;
    closingMinor: string;
    perBalanceSheetMinor: string;
    agrees: boolean;
  };
  accumulatedDepreciation: {
    openingMinor: string;
    chargeMinor: string;
    releasedOnDisposalMinor: string;
    /** IAS 16.35(b): written off against cost when the asset was revalued. */
    eliminatedOnRevaluationMinor: string;
    closingMinor: string;
    perBalanceSheetMinor: string;
    agrees: boolean;
  };
  netBookValue: { openingMinor: string; closingMinor: string };
  /**
   * IAS 16.73(e)(iv)-(vi), taken from the revaluation events rather than
   * re-derived from the postings: the equity and profit halves of each
   * movement are decided by IAS 16.39-40 at the moment it happens, and the
   * ledger lines afterwards cannot be partitioned back into them.
   */
  revaluation: {
    events: number;
    /** (iv) Increases taken to the revaluation surplus. */
    increasesMinor: string;
    /** (iv) Decreases charged against the surplus. Positive: a deduction. */
    decreasesMinor: string;
    /** (v) Impairment losses charged to profit or loss. Positive: a charge. */
    impairmentLossesMinor: string;
    /** (vi) Impairment losses reversed through profit or loss. */
    impairmentReversalsMinor: string;
    /** The four above, netted: the change in carrying amount they caused. */
    netMovementMinor: string;
    /** The same change, from the cost and depreciation accounts themselves. */
    perLedgerMinor: string;
    agrees: boolean;
  };
  register: {
    assets: number;
    costMinor: string;
    accumulatedMinor: string;
    netBookValueMinor: string;
    costAgrees: boolean;
    accumulatedAgrees: boolean;
  };
  byCategory: {
    category: string;
    count: number;
    costMinor: string;
    accumulatedMinor: string;
    netBookValueMinor: string;
  }[];
}

export interface LeaseNote extends NoteBase {
  key: "leases";
  rightOfUseAssets: {
    openingMinor: string;
    additionsMinor: string;
    depreciationMinor: string;
    closingMinor: string;
    perBalanceSheetMinor: string;
    agrees: boolean;
  };
  liabilities: {
    openingMinor: string;
    additionsMinor: string;
    interestMinor: string;
    paymentsMinor: string;
    closingMinor: string;
    perBalanceSheetMinor: string;
    agrees: boolean;
  };
  interestExpenseMinor: string;
  shortTermAndLowValueExpenseMinor: string;
  totalCashOutflowMinor: string;
  /** Undiscounted contractual payments, IFRS 16.58 with IFRS 7.39. */
  maturity: { key: string; label: string; amountMinor: string }[];
  exemptions: { code: string; name: string; reason: string; note: string; annualRentMinor: string }[];
  /** Disclosures IFRS 16.53 asks for that this ledger does not model at all. */
  notDerivable: string[];
  leases: number;
}

export interface AgeingBand {
  key: string;
  label: string;
  amountMinor: string;
}

export interface AgeingDisclosure {
  account: string;
  name: string;
  asOf: string;
  /** By age of the document — how long ago it was raised, not when it falls due. */
  bands: AgeingBand[];
  /** The ageing report's own total. */
  totalPerAgeingMinor: string;
  /** The control account on the balance sheet, stated on its natural side. */
  totalPerLedgerMinor: string;
  agrees: boolean;
  differenceMinor: string;
  openItems: number;
  oldestDays: number | null;
  /**
   * Of the total, what is past its own due date. Nil where no document carries
   * terms — which is not the same as nothing being late, and is why the ageing
   * bands beside it cannot be read as lateness.
   */
  overdueMinor: string;
}

/**
 * IFRS 7.39(a): what is owed, laid out by when it has to be paid.
 *
 * A separate disclosure from the ageing above and not a relabelling of it. The
 * ageing answers "how long has this been on the ledger", which is a credit
 * control question; the maturity answers "what must this business find, and by
 * when", which is the liquidity question IFRS 7.39 asks. They agree in total
 * and in nothing else: a bill raised sixty days ago on ninety-day terms is in
 * the third ageing band and the first maturity band, and it is not overdue.
 */
export interface MaturityDisclosure {
  account: string;
  name: string;
  asOf: string;
  bands: AgeingBand[];
  totalMinor: string;
  /** The first band restated, because it is the figure a reader looks for. */
  pastDueMinor: string;
  /** What no maturity can be stated for, because no terms were recorded. */
  undatedMinor: string;
  undatedItems: number;
}

export interface ReceivablesPayablesNote extends NoteBase {
  key: "trade_receivables_and_payables";
  receivables: AgeingDisclosure;
  payables: AgeingDisclosure;
  /** The same payables, on the contractual maturity IFRS 7.39(a) asks for. */
  payablesMaturity: MaturityDisclosure;
  /** Held on 1150; a contra-asset, so it is shown as a positive deduction. */
  allowanceForDoubtfulDebtsMinor: string;
  netReceivablesMinor: string;
}

/**
 * IFRS 7.35H and 7.35M, which the provision matrix in `allowance.ts` is what
 * makes possible at all.
 *
 * Two disclosures in one note, because they are two halves of one answer. The
 * matrix is the credit risk exposure by grade — for a trade receivable under
 * the simplified approach, IFRS 7.35N lets the grade be the age of the debt —
 * and the reconciliation is the movement in the loss allowance that the matrix
 * produced. Neither is worth much without the other: a matrix with no
 * reconciliation does not say whether it was ever posted, and a reconciliation
 * with no matrix does not say where the number came from.
 */
export interface CreditRiskNote extends NoteBase {
  key: "credit_risk";
  asOf: string;
  allowanceAccount: string;
  /** The loss rates that produced the target below, and where they came from. */
  ratesAreDefault: boolean;
  matrix: {
    band: string;
    label: string;
    grossMinor: string;
    exposureMinor: string;
    rateBps: number;
    ratePercent: string;
    lossMinor: string;
  }[];
  grossReceivablesMinor: string;
  /** What the matrix above measures the lifetime expected credit loss to be. */
  targetMinor: string;
  /** What the ledger actually carries on the allowance account. */
  carriedMinor: string;
  /**
   * Target less carried, and it is called a difference rather than a shortfall
   * on purpose. Where the rates are the product's default it is the gap against
   * an assumed matrix, which is an indication to act on and not a measured
   * under-provision.
   */
  differenceMinor: string;
  /** Whether an allowance was measured and posted at the reporting date itself. */
  measuredAtReportingDate: boolean;
  netReceivablesMinor: string;
  /** IFRS 7.35H: how the loss allowance moved in the year, and why. */
  reconciliation: {
    openingMinor: string;
    chargedMinor: string;
    releasedMinor: string;
    utilisedMinor: string;
    otherMinor: string;
    closingMinor: string;
    perBalanceSheetMinor: string;
    agrees: boolean;
  };
  /** Every matrix posted, with the judgement recorded on the entry that used it. */
  measurements: { reference: string; date: string; movementMinor: string; memo: string }[];
  /** What this note cannot say, listed rather than left out. */
  notDerivable: string[];
}

/**
 * The statutory reserve UAE Commercial Companies Law makes compulsory.
 *
 * Article 103 of Federal Decree-Law 32/2021 requires 10% of the year's net
 * profit to be set aside into a statutory reserve until the reserve reaches
 * half the paid-up capital, at which point the deduction may stop. Account 3200
 * exists, the statement reports the transfer correctly when somebody makes one,
 * and nothing ever asked for one — so an entity could trade profitably for
 * years, never appropriate a fil, and see nothing anywhere saying so.
 */
export interface StatutoryReserveNote extends NoteBase {
  key: "statutory_reserve";
  account: string;
  capitalAccount: string;
  paidUpCapitalMinor: string;
  /** Half the paid-up capital: the point at which the deduction may stop. */
  capMinor: string;
  openingMinor: string;
  /** What was appropriated into the reserve during the year, per the ledger. */
  transferredMinor: string;
  closingMinor: string;
  /** The year's result, as the statement of changes in equity derives it. */
  profitForThePeriodMinor: string;
  /** Ten per cent of it, which is nil where the year made a loss. */
  tenPercentMinor: string;
  /** How much room is left below the cap before the transfer was made. */
  headroomMinor: string;
  /** The lesser of the two above — what Article 103 asks of this year. */
  requiredMinor: string;
  /** Required less transferred, floored at nil. */
  shortfallMinor: string;
  satisfied: boolean;
  capReached: boolean;
}

export interface RevenueNote extends NoteBase {
  key: "revenue";
  byTaxTreatment: { taxCode: string | null; label: string; amountMinor: string; shareBps: number | null }[];
  byAccount: { code: string; name: string; nameAr: string | null; amountMinor: string }[];
  totalMinor: string;
  untaggedMinor: string;
  untaggedLines: number;
  /** Two views of one set of postings; they cannot legitimately differ. */
  agrees: boolean;
}

export interface RelatedPartyNote extends NoteBase {
  key: "related_parties";
  /** The one balance that is related by construction, whoever is declared. */
  account: { code: string; name: string; nameAr: string | null };
  openingMinor: string;
  closingMinor: string;
  movements: { key: string; label: string; amountMinor: string }[];
  postings: number;
  /** Declared under IAS 24.13, with what passed between them in the period. */
  parties: {
    partyKey: string;
    name: string;
    relationship: string;
    relationshipLabel: string;
    startedOn: string;
    endedOn: string | null;
    declaredBy: string;
    declaredOn: string;
    salesMinor: string;
    purchasesMinor: string;
    documents: number;
    notes: string | null;
  }[];
  byRelationship: {
    relationship: string;
    label: string;
    count: number;
    salesMinor: string;
    purchasesMinor: string;
  }[];
  /** IAS 24.17. Five categories, and a total alone is not the disclosure. */
  compensation: {
    rows: { category: string; label: string; amountMinor: string; headcount: number; declaredBy: string }[];
    totalMinor: string;
    missingCategories: { category: string; label: string }[];
    headcount: number | null;
  };
  /** IAS 24.13, which is required whether or not anything passed between them. */
  attestation: {
    present: boolean;
    parentName: string | null;
    ultimateControllingParty: string | null;
    noControllingParty: boolean;
    attestedBy: string | null;
    attestedOn: string | null;
  };
  /** An assessed nil and an unasked question are different facts. */
  completeness: {
    unassessed: string[];
    unassessedCount: number;
    complete: boolean;
    reasons: string[];
  };
  /** What is still unanswered — the register's own grading, not a fixed list. */
  requiresInput: string[];
}

/**
 * The provisions register's own IAS 37.84 note, and the deferred tax
 * register's IAS 12.81(g) one, carried into the pack whole.
 *
 * Both are already built, tested and reconciled against their registers in
 * their own modules. Restating either here would give the pack a second
 * derivation of the same figures, which is the one thing this module exists to
 * prevent, so the results are spread in as they come.
 */
/*
 * Neither of these carries a `requires` list, because everything in both is
 * derived and there is nothing to ask a preparer.
 *
 * They used to carry an always-empty one as a compatibility field: the equity
 * screen mirrors these wire shapes by hand rather than importing them, so a
 * note key it had not been taught fell through to its "requires input" body,
 * which called `.map` on a field that was not there and took the whole notes
 * pack down. That renderer now degrades to the note's own statement instead,
 * so the empty list is no longer load-bearing and is gone.
 */
export interface ProvisionsNote extends NoteBase, Omit<ProvisionNoteResult, "entityId"> {
  key: "provisions";
}

export interface DeferredTaxNote extends NoteBase, Omit<DeferredTaxNoteResult, "entityId"> {
  key: "deferred_tax";
}

export interface TaxNote extends NoteBase {
  key: "corporate_tax";
  /** Charged to profit in the year, closing entries excluded. */
  chargePerLedgerMinor: string;
  payableClosingMinor: string;
  computedChargeMinor: string;
  accountingProfitPerComputationMinor: string;
  profitForThePeriodMinor: string;
  /** The computation reads the profit and loss, which a closed year zeroes. */
  computationReadsClosedYear: boolean;
  taxableIncomeMinor: string;
  effectiveRateBps: string | null;
  /** IAS 12.81(c): tax expense against accounting profit at the statutory rate. */
  reconciliation: { key: string; label: string; basis: string; amountMinor: string }[];
  reconciliationTotalMinor: string;
  foots: boolean;
  adjustments: { key: string; label: string; basis: string; amountMinor: string; origin: string }[];
  smallBusinessRelief: { elected: boolean; applied: boolean; eligible: boolean; reason: string };
  provisionPosted: boolean;
  provisionAgrees: boolean;
  warnings: string[];
}

/** One thing a preparer has to answer, and the paragraph that asks it. */
export interface NoteQuestion {
  key: string;
  question: string;
  basis: string;
}

export interface RequiresInputNote extends NoteBase {
  key: "events_after_the_reporting_period" | "commitments_and_contingencies";
  state: "requires_input";
  /** Exactly what a preparer has to answer, one question at a time. */
  requires: NoteQuestion[];
}

export type Note =
  | PolicyNote
  | PpeNote
  | IntangiblesNote
  | LeaseNote
  | ReceivablesPayablesNote
  | CreditRiskNote
  | RevenueNote
  | RelatedPartyNote
  | ProvisionsNote
  | TaxNote
  | DeferredTaxNote
  | StatutoryReserveNote
  | RequiresInputNote;

export interface FiscalYearRef {
  label: string;
  startsOn: string;
  endsOn: string;
  status: string;
}

export interface EquityAndNotes {
  fiscalYear: string;
  from: string;
  to: string;
  currency: string;
  availableYears: FiscalYearRef[];
  statement: StatementOfChangesInEquity;
  notes: Note[];
}

/* -------------------------------------------------------------- utilities */

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const money = (minor: bigint, currency: string) =>
  fmtMinor(minor, currency, { sign: "minus", zero: "zero" });

/** "2026-03" → an ordinal, so months can be counted between two dates. */
const monthOrdinal = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();

/** 9% of an amount, half-up on the fil, in BigInt — the corporate tax rate. */
function taxAtStatutoryRate(amount: bigint): bigint {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const tax = (abs * 9n + 50n) / 100n;
  return neg ? -tax : tax;
}

/** Balance of one account on a balance sheet, debit-positive, 0 when absent. */
function balanceOf(bs: BalanceSheet, code: string): bigint {
  for (const section of [bs.assets, bs.liabilities, bs.equity]) {
    const line = section.lines.find((l) => l.code === code);
    if (line) return BigInt(line.balanceMinor);
  }
  return 0n;
}

const sumOf = (bs: BalanceSheet, codes: string[]) =>
  codes.reduce((a, c) => a + balanceOf(bs, c), 0n);

/* ---------------------------------------------------------------- context */

/**
 * One read of the year, shared by the statement and every note.
 *
 * The journal lines for the year are read once, in full, rather than once per
 * note. That is not only cheaper: it is what stops two notes telling different
 * stories about the same postings, which is the failure mode this whole module
 * exists to avoid.
 */
type YearLine = {
  code: string;
  name: string;
  nameAr: string | null;
  type: string;
  /** Functional currency, debit-positive, as the ledger holds it. */
  amount: bigint;
  taxCode: string | null;
  entryId: string;
  source: string;
  sourceType: string | null;
  memo: string | null;
  date: Date;
};

type EntryShape = {
  /** Every account code the entry touches. */
  codes: Set<string>;
  /** Nothing but equity accounts — so the entry moves value within equity. */
  allEquity: boolean;
  /** The year-end closing entry. */
  isClose: boolean;
  touchesCash: boolean;
};

interface Context {
  orgId: string;
  entityId: string;
  bookId: string;
  currency: string;
  presentationCurrency: string;
  year: { label: string; startsOn: Date; endsOn: Date; status: string };
  from: string;
  to: string;
  openingBs: BalanceSheet;
  closingBs: BalanceSheet;
  lines: YearLine[];
  entries: Map<string, EntryShape>;
  accountNames: Map<string, { name: string; nameAr: string | null }>;
  /**
   * Cash and cash equivalents, derived from the chart rather than listed here.
   * `cash.ts` says why, and which accounts are excluded whatever subtype
   * anyone puts on them.
   */
  cashCodes: Set<string>;
}

async function context(opts: { orgId: string; entityId: string; fiscalYear: string }): Promise<Context> {
  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
  });
  if (!book) throw new LedgerError("No ledger has been opened for this entity.");

  const year = await prisma.fiscalYear.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, label: opts.fiscalYear },
  });
  if (!year) {
    throw new LedgerError(
      `There is no fiscal year "${opts.fiscalYear}" for this entity. A statement of changes in equity covers a ` +
        `reporting period, and the reporting period is the fiscal year.`,
    );
  }

  const from = isoDay(year.startsOn);
  const to = isoDay(year.endsOn);
  // The opening position is the balance sheet as at the day BEFORE the year
  // opens. Reading it as at the first day would fold that day's postings into
  // the brought-forward figure and lose them from the movements.
  const openingAsOf = isoDay(new Date(year.startsOn.getTime() - 86_400_000));

  const [openingBs, closingBs, rows, accounts] = await Promise.all([
    balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: openingAsOf }),
    balanceSheet({ orgId: opts.orgId, entityId: opts.entityId, asOf: to }),
    prisma.journalLine.findMany({
      where: {
        orgId: opts.orgId,
        entry: {
          entityId: opts.entityId,
          bookId: book.id,
          // A reversed entry's lines are real postings that happened, and the
          // separate reversing entry is what offsets them. Counting only
          // "posted" keeps the reversal and drops the original, which moves
          // every derived figure here by the full amount in the wrong
          // direction — and the balance cache counts both, so the notes would
          // then disagree with the balance sheet they sit under.
          status: { in: ["posted", "reversed"] },
          entryDate: { gte: year.startsOn, lte: year.endsOn },
        },
      },
      include: {
        account: { select: { code: true, name: true, nameAr: true, type: true } },
        entry: { select: { id: true, source: true, sourceType: true, memo: true, entryDate: true } },
      },
    }),
    prisma.account.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId },
      select: { code: true, name: true, nameAr: true, subtype: true },
    }),
  ]);

  const cashCodes = new Set(cashCodesFrom(accounts));

  const lines: YearLine[] = rows.map((l) => ({
    code: l.account.code,
    name: l.account.name,
    nameAr: l.account.nameAr,
    type: l.account.type,
    amount: l.functionalAmountMinor,
    taxCode: l.taxCode,
    entryId: l.entry.id,
    source: l.entry.source,
    sourceType: l.entry.sourceType,
    memo: l.entry.memo,
    date: l.entry.entryDate,
  }));

  const entries = new Map<string, EntryShape>();
  for (const l of lines) {
    const shape = entries.get(l.entryId) ?? {
      codes: new Set<string>(),
      allEquity: true,
      isClose: l.source === "close" || l.sourceType === "YEAR_END",
      touchesCash: false,
    };
    shape.codes.add(l.code);
    if (l.type !== "EQUITY") shape.allEquity = false;
    if (cashCodes.has(l.code)) shape.touchesCash = true;
    entries.set(l.entryId, shape);
  }

  return {
    orgId: opts.orgId,
    entityId: opts.entityId,
    bookId: book.id,
    currency: book.functionalCurrency,
    presentationCurrency: book.presentationCurrency,
    year: { label: year.label, startsOn: year.startsOn, endsOn: year.endsOn, status: year.status },
    from,
    to,
    openingBs,
    closingBs,
    lines,
    entries,
    accountNames: new Map(accounts.map((a) => [a.code, { name: a.name, nameAr: a.nameAr }])),
    cashCodes,
  };
}

/* --------------------------------------- the statement of changes in equity */

const ROW_ORDER: EquityRowKey[] = [
  // IAS 1.106(b) puts a retrospective restatement immediately under the
  // brought-forward figure, because everything below it is measured against
  // the restated position rather than the original one.
  "prior_period_adjustment",
  "profit_for_period",
  // IAS 1.106(d)(ii): what was recognised outside profit sits directly under
  // the profit it did not go through.
  "revaluation",
  "share_capital",
  "capital_introduced",
  "reserve_transfer",
  "transfer_within_equity",
  "distributions",
];

const ROW_LABEL: Record<EquityRowKey, string> = {
  opening: "Balance brought forward",
  prior_period_adjustment: "Prior period adjustments",
  profit_for_period: "Profit for the period",
  revaluation: "Revaluation of property, plant and equipment",
  share_capital: "Share capital issued",
  capital_introduced: "Funds introduced by the shareholder",
  reserve_transfer: "Transfer to the statutory reserve",
  transfer_within_equity: "Other transfers within equity",
  distributions: "Dividends and drawings",
  closing: "Balance carried forward",
};

const ROW_NOTE: Record<EquityRowKey, string> = {
  opening:
    "Equity as at the day before the year opened, including any result of an earlier year that had not been closed.",
  prior_period_adjustment:
    "A movement on retained earnings that is not a distribution and not the year-end close. The ledger cannot " +
    "distinguish a correction of an earlier year from a dividend accrued rather than paid, so each of these is " +
    "named in the warnings for a preparer to confirm.",
  profit_for_period:
    "The result for the year. Until the year is closed it is not posted anywhere — it is what is left in the " +
    "income and expense accounts — and once it is closed it is the credit the closing entry made to retained " +
    "earnings. Never both.",
  revaluation:
    "The surplus arising on revaluing an asset, less any fall charged back against a surplus the same asset " +
    "already carried (IAS 16.39-.40). It is recognised outside profit or loss, so it is a row of its own and not " +
    "part of the result above. A fall beyond the surplus that asset carries is charged to profit and appears in " +
    "the profit row instead, never here.",
  share_capital: "Capital issued or reduced on the share capital account.",
  capital_introduced:
    "Value put into the business by the shareholder through the current account, including expenses of the " +
    "business the shareholder settled personally.",
  reserve_transfer:
    "An appropriation out of retained earnings into the statutory reserve. It moves value between two columns, " +
    "so it adds to nil across the row.",
  transfer_within_equity:
    "An entry whose every line is an equity account, so it changes the composition of equity without changing " +
    "its total. A dividend credited to the shareholder's current account rather than paid is one case; the " +
    "realisation of a revaluation surplus into retained earnings as the asset is used or sold (IAS 16.41) is the " +
    "other, and both add to nil across the row.",
  distributions: "Value taken out of the business by the owner, whether as a dividend or as drawings.",
  closing:
    "The opening position plus every movement above it — built up from the rows, not read back off the balance " +
    "sheet, so that the two can be compared.",
};

/** Which movement row an equity posting belongs to. */
function classify(line: YearLine, entry: EntryShape): EquityRowKey {
  // The close is the one entry that carries a whole year's trading into
  // equity, so it is the profit row whatever else it touches.
  if (entry.isClose) return "profit_for_period";
  if (entry.allEquity) {
    return entry.codes.has(STATUTORY_RESERVE) ? "reserve_transfer" : "transfer_within_equity";
  }
  if (line.code === SHARE_CAPITAL) return "share_capital";
  if (line.code === STATUTORY_RESERVE) return "reserve_transfer";
  // A surplus arising touches the asset and the expense accounts too, so the
  // entry is not all-equity and has already fallen past the branch above. The
  // transfer out under IAS 16.41 is all-equity and never reaches here, which
  // is what keeps the two apart: one changes the size of equity, the other
  // only its composition.
  if (line.code === REVALUATION_SURPLUS) return "revaluation";
  // The current account runs both ways: a credit is value the shareholder put
  // in, a debit is value they took out.
  if (line.code === SHAREHOLDER_CURRENT) return line.amount > 0n ? "distributions" : "capital_introduced";
  // A debit to retained earnings settled in cash is a dividend. Anything else
  // on retained earnings outside the close cannot be told apart from a
  // restatement by looking at the postings, so it is reported as one and
  // warned about rather than guessed at.
  if (line.code === RETAINED_EARNINGS) {
    return line.amount > 0n && entry.touchesCash ? "distributions" : "prior_period_adjustment";
  }
  return "transfer_within_equity";
}

function buildStatement(ctx: Context): StatementOfChangesInEquity {
  const currency = ctx.currency;
  const warnings: string[] = [];

  const columns: EquityColumn[] = EQUITY_COLUMNS.map((code) => ({
    code,
    name: ctx.accountNames.get(code)?.name ?? code,
    nameAr: ctx.accountNames.get(code)?.nameAr ?? null,
  }));

  const zeroCells = () => Object.fromEntries(EQUITY_COLUMNS.map((c) => [c, 0n])) as Record<string, bigint>;

  /* -- opening ----------------------------------------------------------- */

  // Credit-positive throughout: equity's natural side, so capital reads
  // positive and a dividend reads negative.
  const openingUnclosed = BigInt(ctx.openingBs.currentYearEarningsMinor);
  const opening = zeroCells();
  for (const code of EQUITY_COLUMNS) opening[code] = -balanceOf(ctx.openingBs, code);
  // An earlier year that was never closed leaves its result outside 3900. It
  // is equity at the opening date all the same, so it belongs in the brought
  // forward figure — otherwise this statement's opening position would not be
  // the previous balance sheet's closing one.
  opening[RETAINED_EARNINGS] += openingUnclosed;

  /* -- movements --------------------------------------------------------- */

  const movementCells = new Map<EquityRowKey, Record<string, bigint>>(
    ROW_ORDER.map((k) => [k, zeroCells()]),
  );
  const unclassified = new Map<string, { name: string; amount: bigint }>();
  const restatements: { entryId: string; memo: string | null; date: Date; amount: bigint }[] = [];
  let postedClose = 0n;

  for (const line of ctx.lines) {
    if (line.type !== "EQUITY") continue;
    // 3950 is not postable, but a chart that has been edited by hand could
    // still carry a posting against it, and it must not be double counted
    // against the derived profit row.
    if (line.code === CURRENT_YEAR_EARNINGS) continue;
    if (!EQUITY_COLUMNS.includes(line.code)) {
      const prev = unclassified.get(line.code);
      if (prev) prev.amount += line.amount;
      else unclassified.set(line.code, { name: line.name, amount: line.amount });
      continue;
    }
    const entry = ctx.entries.get(line.entryId)!;
    const key = classify(line, entry);
    movementCells.get(key)![line.code] += -line.amount;
    if (entry.isClose) postedClose += -line.amount;
    if (key === "prior_period_adjustment") {
      restatements.push({ entryId: line.entryId, memo: line.memo, date: line.date, amount: -line.amount });
    }
  }

  // The half of the year's result that has not been closed. Together with the
  // closing entry's credit above, this is the year's profit exactly once —
  // closing a year brings income and expense to zero, so an amount can be in
  // one of these or the other, never in both.
  const closingUnclosed = BigInt(ctx.closingBs.currentYearEarningsMinor);
  const derivedProfit = closingUnclosed - openingUnclosed;
  movementCells.get("profit_for_period")![RETAINED_EARNINGS] += derivedProfit;

  const profitForThePeriod = EQUITY_COLUMNS.reduce(
    (a, c) => a + movementCells.get("profit_for_period")![c],
    0n,
  );

  const rowOf = (key: EquityRowKey, cells: Record<string, bigint>, kind: "balance" | "movement", origin: EquityRow["origin"]): EquityRow => {
    const total = EQUITY_COLUMNS.reduce((a, c) => a + cells[c], 0n);
    return {
      key,
      label:
        key === "profit_for_period" && total < 0n ? "Loss for the period" : ROW_LABEL[key],
      kind,
      cells: Object.fromEntries(EQUITY_COLUMNS.map((c) => [c, cells[c].toString()])),
      totalMinor: total.toString(),
      origin,
      note: ROW_NOTE[key],
    };
  };

  const openingRow = rowOf("opening", opening, "balance", openingUnclosed === 0n ? "posted" : "mixed");

  const movements: EquityRow[] = [];
  for (const key of ROW_ORDER) {
    const cells = movementCells.get(key)!;
    const nonZero = EQUITY_COLUMNS.some((c) => cells[c] !== 0n);
    // The profit row is always shown. A year that made nothing made nothing,
    // and a statement of changes in equity that omits the line entirely reads
    // as though the question was never asked.
    if (!nonZero && key !== "profit_for_period") continue;
    const origin: EquityRow["origin"] =
      key !== "profit_for_period"
        ? "posted"
        : postedClose !== 0n && derivedProfit !== 0n
          ? "mixed"
          : postedClose !== 0n
            ? "posted"
            : "derived";
    movements.push(rowOf(key, cells, "movement", origin));
  }

  /* -- closing, built up from the rows ----------------------------------- */

  const closing = zeroCells();
  for (const code of EQUITY_COLUMNS) {
    closing[code] = opening[code] + ROW_ORDER.reduce((a, k) => a + movementCells.get(k)![code], 0n);
  }
  const closingRow = rowOf("closing", closing, "balance", "derived");

  const totalByColumns = EQUITY_COLUMNS.reduce((a, c) => a + closing[c], 0n);
  const totalByRows =
    BigInt(openingRow.totalMinor) + movements.reduce((a, r) => a + BigInt(r.totalMinor), 0n);

  const equityPerBalanceSheet = BigInt(ctx.closingBs.equity.totalMinor);
  const difference = totalByColumns - equityPerBalanceSheet;

  /* -- warnings ----------------------------------------------------------- */

  for (const [code, row] of unclassified) {
    warnings.push(
      `Equity account ${code} ${row.name} moved by ${money(-row.amount, currency)} in ${ctx.year.label} and is not ` +
        `one of the columns of this statement, so it is missing from it. Add it to the equity columns — until ` +
        `then the statement cannot reconcile to the balance sheet, and the difference below is this account.`,
    );
  }

  // An equity account that carries a balance but never moved is invisible to
  // the loop above, and is just as capable of breaking the reconciliation.
  for (const line of ctx.closingBs.equity.lines) {
    if (line.code === CURRENT_YEAR_EARNINGS) continue;
    if (EQUITY_COLUMNS.includes(line.code)) continue;
    if (unclassified.has(line.code)) continue;
    warnings.push(
      `Equity account ${line.code} ${line.name} carries ${money(-BigInt(line.balanceMinor), currency)} at ` +
        `${ctx.to} and is not one of the columns of this statement. It is on the balance sheet and not here.`,
    );
  }

  for (const r of restatements) {
    warnings.push(
      `${isoDay(r.date)}: ${money(r.amount, currency)} on ${RETAINED_EARNINGS} retained earnings ` +
        `${r.memo ? `(${r.memo}) ` : ""}has been shown as a prior period adjustment. The ledger cannot tell a ` +
        `correction of an earlier year from a dividend that was declared but not paid in cash, so confirm which ` +
        `it is — IAS 1.106(b) and IAS 1.107 present them on different lines.`,
    );
  }

  // Each column's closing figure, built from the rows, against the same
  // account on the balance sheet. This is the reconciliation account by
  // account rather than in total, so a pair of errors that cancel is still
  // found.
  for (const code of EQUITY_COLUMNS) {
    const perSheet = -balanceOf(ctx.closingBs, code) + (code === RETAINED_EARNINGS ? closingUnclosed : 0n);
    if (closing[code] !== perSheet) {
      warnings.push(
        `Column ${code} ${ctx.accountNames.get(code)?.name ?? ""} closes at ${money(closing[code], currency)} on ` +
          `this statement but at ${money(perSheet, currency)} on the balance sheet, a difference of ` +
          `${money(closing[code] - perSheet, currency)}. A movement on this account has been missed.`,
      );
    }
  }

  if (difference !== 0n) {
    warnings.push(
      `This statement does not reconcile. Equity closes at ${money(totalByColumns, currency)} here and at ` +
        `${money(equityPerBalanceSheet, currency)} on the balance sheet at ${ctx.to}, a difference of ` +
        `${money(difference, currency)}. The difference is shown rather than absorbed into a balancing line: it ` +
        `means a movement in equity has been left out, and a balancing line would hide the one thing worth fixing.`,
    );
  }

  if (totalByColumns !== totalByRows) {
    warnings.push(
      `The matrix does not add up the same way twice: down the columns it totals ` +
        `${money(totalByColumns, currency)} and across the rows ${money(totalByRows, currency)}. Please report ` +
        `this — it is a defect in the statement, not in the data.`,
    );
  }

  return {
    fiscalYear: ctx.year.label,
    from: ctx.from,
    to: ctx.to,
    currency,
    closed: postedClose !== 0n,
    columns,
    opening: openingRow,
    movements,
    closing: closingRow,
    totalByColumnsMinor: totalByColumns.toString(),
    totalByRowsMinor: totalByRows.toString(),
    foots: totalByColumns === totalByRows,
    equityPerBalanceSheetMinor: equityPerBalanceSheet.toString(),
    reconciles: difference === 0n,
    differenceMinor: difference.toString(),
    profitForThePeriodMinor: profitForThePeriod.toString(),
    warnings,
  };
}

/* ------------------------------------------------------------------ notes */

const TAX_TREATMENT_LABEL: Record<string, string> = {
  STANDARD_5: "Standard rated, 5%",
  ZERO_EXPORT: "Zero rated — exports",
  ZERO_OTHER: "Zero rated — other",
  EXEMPT: "Exempt",
  REVERSE_CHARGE: "Reverse charge — the recipient accounts for the tax",
  DESIGNATED_ZONE: "Designated zone",
  OUT_OF_SCOPE: "Outside the scope of VAT",
  MARGIN_SCHEME: "Margin scheme",
};

/**
 * The ageing bands as `ar.ts` and `ap.ts` cut them, spelled out for the note.
 *
 * Every label says "old", and that is a correction rather than a flourish.
 * These bands are measured from the day the document was raised, and they used
 * to be captioned "Not more than 30 days", "31 to 60 days" and so on under a
 * heading citing IFRS 7.39 — which is a maturity analysis, measured forwards to
 * the day the money falls due. A reader had no way to tell the two apart, and
 * the two say opposite things about a business on long terms. The maturity
 * ladder is now its own table, cut on the due date, with its own labels.
 */
const AGEING_BANDS: { key: string; label: string }[] = [
  { key: "current", label: "Not more than 30 days old" },
  { key: "d31_60", label: "31 to 60 days old" },
  { key: "d61_90", label: "61 to 90 days old" },
  { key: "d91_120", label: "91 to 120 days old" },
  { key: "over120", label: "More than 120 days old" },
];

function accountingPolicies(ctx: Context, n: number, registerAssets: number, registerLeases: number): PolicyNote {
  const policies: AccountingPolicy[] = [];
  const has = (codes: string[]) =>
    ctx.lines.some((l) => codes.includes(l.code) && l.amount !== 0n) ||
    codes.some((c) => balanceOf(ctx.closingBs, c) !== 0n);

  policies.push({
    key: "basis_of_preparation",
    label: "Basis of preparation",
    policy:
      "These financial statements are prepared on the accrual basis of accounting and under the historical cost " +
      "convention, from a double-entry ledger in which every entry is required to balance before it can be " +
      "posted. Each statement and each note below is derived from that ledger rather than kept alongside it.",
    basis: "IAS 1.25, IAS 1.27, IAS 1.117(a)",
    evidence: `${ctx.lines.length} journal lines posted in ${ctx.year.label}.`,
  });

  policies.push({
    key: "functional_currency",
    label: "Functional and presentation currency",
    policy:
      `The functional currency is ${ctx.currency} and these statements are presented in ` +
      `${ctx.presentationCurrency}. Amounts are held and reported in minor units as whole numbers, so no figure ` +
      `in these statements has been through a rounding of a decimal fraction.`,
    basis: "IAS 21.9, IAS 21.17, IAS 1.51(d)",
    evidence: `Primary ledger functional currency ${ctx.currency}.`,
  });

  const revenueLines = ctx.lines.filter((l) => l.type === "INCOME" && l.source !== "close");
  if (revenueLines.length) {
    policies.push({
      key: "revenue",
      label: "Revenue",
      policy:
        "Revenue is recognised when control of the goods or services passes to the customer, at the transaction " +
        "price allocated to that performance obligation, and is stated net of value added tax and of credit notes.",
      basis: "IFRS 15.31, IFRS 15.47",
      evidence: `${revenueLines.length} postings to income accounts in ${ctx.year.label}.`,
    });
  }

  if (registerAssets > 0 || has([...PPE_COST_CODES, ACCUM_DEPRECIATION])) {
    // The measurement basis is read off the ledger, not assumed. An entity
    // that has credited 3300 is on the revaluation model, and a note claiming
    // the cost model for it states a policy the accounts contradict — IAS 16.29
    // makes the two a choice, and IAS 1.117(a) asks which was made.
    const revalued = has([REVALUATION_SURPLUS]);
    const impaired = has([IMPAIRMENT_EXPENSE]);
    const impairment =
      " An asset is written down to its recoverable amount where that is lower than its carrying amount, and a " +
      "write-down is reversed only up to what the carrying amount would have been had it never been made.";
    policies.push({
      key: "property_plant_and_equipment",
      label: "Property, plant and equipment",
      policy:
        (revalued
          ? "Property, plant and equipment is stated at a revalued amount, being fair value at the date of the " +
            "valuation less subsequent accumulated depreciation. An increase is recognised in the revaluation " +
            "surplus in equity except to the extent it reverses a decrease previously charged to profit; a " +
            "decrease is charged against any surplus that asset already carries and thereafter to profit. On " +
            "revaluation the accumulated depreciation is eliminated against the gross carrying amount, and " +
            "depreciation from then on is charged on the revalued amount over the remaining life. A change in " +
            "an estimate is applied prospectively; prior periods are not restated."
          : "Property, plant and equipment is stated at cost less accumulated depreciation. Depreciation is " +
            "charged monthly over the useful life recorded for each asset, and a change in an estimate is " +
            "applied prospectively; prior periods are not restated.") + (impaired ? impairment : ""),
      basis: revalued
        ? "IAS 16.31, IAS 16.35(b), IAS 16.39-.40, IAS 16.73(a)-(b), IAS 8.36" + (impaired ? ", IAS 36.59, IAS 36.117" : "")
        : "IAS 16.30, IAS 16.73(a)-(b), IAS 8.36" + (impaired ? ", IAS 36.59, IAS 36.117" : ""),
      evidence:
        `${registerAssets} asset${registerAssets === 1 ? "" : "s"} on the fixed asset register` +
        (revalued ? `, and a revaluation surplus on account ${REVALUATION_SURPLUS}` : "") +
        (impaired ? `, with impairment charged to account ${IMPAIRMENT_EXPENSE}` : "") +
        ".",
    });
  }

  if (has([INTANGIBLE_COST, ACCUM_AMORTISATION, AMORTISATION_EXPENSE])) {
    // Stated only where there is something to state. An entity holding no
    // intangibles does not need a policy about them, and a policy note padded
    // with paragraphs that apply to nothing is a note nobody reads to the end.
    policies.push({
      key: "intangible_assets",
      label: "Intangible assets",
      policy:
        "Intangible assets are stated at cost less accumulated amortisation. Amortisation is charged on a " +
        "straight-line basis over the useful life recorded for each asset, from the month it is available for " +
        "use, and is presented separately from depreciation. The revaluation model is not applied: IAS 38.75 " +
        "permits it only where an active market exists for the asset, and none exists for the software and " +
        "licences held here. A change in an estimate is applied prospectively; prior periods are not restated.",
      basis: "IAS 38.74, IAS 38.97, IAS 38.118(a)-(b), IAS 8.36",
      evidence:
        `Movements on accounts ${INTANGIBLE_COST} and ${ACCUM_AMORTISATION}, with amortisation charged to ` +
        `${AMORTISATION_EXPENSE}.`,
    });
  }

  if (registerLeases > 0 || has([ROU_ASSET, LEASE_LIABILITY])) {
    policies.push({
      key: "leases",
      label: "Leases",
      policy:
        "At the commencement of a lease the entity recognises a lease liability at the present value of the " +
        "payments not yet made, discounted at the incremental borrowing rate, and a right-of-use asset at the " +
        "same amount. The liability unwinds at the effective interest rate and the right-of-use asset is " +
        "depreciated straight-line over the lease term. Short-term and low-value leases are expensed as incurred.",
      basis: "IFRS 16.22-.24, IFRS 16.26, IFRS 16.31-.32, IFRS 16.5-.6",
      evidence: `${registerLeases} lease${registerLeases === 1 ? "" : "s"} on the lease register.`,
    });
  }

  if (has(["1200"])) {
    policies.push({
      key: "inventory",
      label: "Inventory",
      policy: "Inventory is stated at the lower of cost and net realisable value.",
      basis: "IAS 2.9, IAS 2.36(a)",
      evidence: "Inventory account 1200 carries a balance or moved in the year.",
    });
  }

  if (has([TRADE_RECEIVABLES])) {
    /*
     * The nil case is a departure, and it now says so.
     *
     * This policy used to read "Trade receivables are stated at the amount
     * invoiced. No allowance for doubtful debts has been recognised" under a
     * basis of IFRS 9.5.5.15 — which is the paragraph that makes a lifetime
     * expected credit loss allowance compulsory on a trade receivable. Citing
     * the rule that forbids what the sentence describes reads as compliance to
     * everyone except the auditor who looks the paragraph up. There is no
     * materiality get-out to hide behind either: whether the loss is material
     * is a judgement about the amount, not a reason the measurement was never
     * made.
     */
    const carried = has([DOUBTFUL_DEBT_ALLOWANCE]);
    policies.push({
      key: "trade_receivables",
      label: "Trade receivables",
      policy: carried
        ? "Trade receivables are stated at the amount invoiced less a loss allowance measured at lifetime " +
          "expected credit losses. The entity applies the simplified approach, which requires that measurement " +
          "for a trade receivable from the day it is recognised, and the allowance is computed on a provision " +
          "matrix of loss rates applied to the receivables in each ageing band."
        : "Trade receivables are stated at the amount invoiced, with no loss allowance deducted. IFRS 9.5.5.15 " +
          "requires a trade receivable to be carried at the amount invoiced less a lifetime expected credit loss " +
          "allowance; none has been measured or recognised, so the receivables in these accounts are stated gross " +
          "and no expected credit loss has been charged against the result for the year.",
      basis: "IFRS 9.5.5.15, IFRS 9.B5.5.35",
      evidence: carried
        ? `An allowance is carried on account ${DOUBTFUL_DEBT_ALLOWANCE}, and the matrix behind it is in the ` +
          `credit risk note.`
        : `Account ${DOUBTFUL_DEBT_ALLOWANCE} has neither a balance nor a movement in ${ctx.year.label}.`,
    });
  }

  if (has(["2250", "6050"])) {
    policies.push({
      key: "employee_benefits",
      label: "Employee benefits",
      policy:
        "End-of-service benefits are provided for over the period of service in accordance with the UAE Labour Law.",
      basis: "IAS 19.11, IAS 19.155",
      evidence: "An end-of-service provision is carried on account 2250.",
    });
  }

  if (has(["4950", "6800"]) || ctx.lines.some((l) => l.type === "ASSET" && l.code === "1100" && l.source === "fx")) {
    policies.push({
      key: "foreign_currency",
      label: "Foreign currency",
      policy:
        "Transactions in a currency other than the functional currency are translated at the rate on the date of " +
        "the transaction, and monetary balances are retranslated at the rate at the reporting date. The " +
        "difference is recognised in profit or loss.",
      basis: "IAS 21.21, IAS 21.23(a), IAS 21.28",
      evidence: "Exchange differences are carried on accounts 4950 and 6800.",
    });
  }

  if (has([CT_EXPENSE, CT_PAYABLE])) {
    policies.push({
      key: "income_tax",
      label: "Corporate tax",
      policy:
        "Corporate tax is provided at the rates enacted by Federal Decree-Law 47/2022, being nil on the first " +
        "AED 375,000 of taxable income and 9% on the excess. Deferred tax is not recognised except where the " +
        "ledger carries a deferred tax balance.",
      basis: "IAS 12.46, FDL 47/2022 Article 3",
      evidence: "Corporate tax is carried on accounts 7000 and 2400.",
    });
  }

  if (has(["2100", "1350"])) {
    policies.push({
      key: "value_added_tax",
      label: "Value added tax",
      policy:
        "Revenue and expenses are recognised net of value added tax. Tax charged on supplies and tax recoverable " +
        "on purchases are carried as liabilities and assets until settled with the Federal Tax Authority.",
      basis: "IAS 1.99, Federal Decree-Law 8/2017",
      evidence: "Output and input tax are carried on accounts 2100 and 1350.",
    });
  }

  return {
    number: n,
    key: "accounting_policies",
    title: "Basis of preparation and accounting policies",
    basis: "IAS 1.112(a), IAS 1.117",
    state: "present",
    statement:
      `${policies.length} policies are stated, and only those. A policy is included when this entity's ledger ` +
      `shows the thing it is a policy about; nothing is claimed for a measurement basis the entity does not use.`,
    functionalCurrency: ctx.currency,
    presentationCurrency: ctx.presentationCurrency,
    policies,
  };
}

/** The revaluation events this year, as `revaluationRegister` records them. */
type RevaluationEvents = {
  count: number;
  increases: bigint;
  decreases: bigint;
  impairmentLosses: bigint;
  impairmentReversals: bigint;
};

function revaluationEventsIn(
  ctx: Context,
  register: Awaited<ReturnType<typeof revaluationRegister>>,
): RevaluationEvents {
  const out: RevaluationEvents = {
    count: 0, increases: 0n, decreases: 0n, impairmentLosses: 0n, impairmentReversals: 0n,
  };
  for (const asset of register.assets) {
    for (const e of asset.events) {
      if (e.on < ctx.from || e.on > ctx.to) continue;
      out.count += 1;
      // The split was decided by IAS 16.39-40 when the event happened and is
      // stored on it. Re-deriving it from the postings is not possible: the
      // surplus and the impairment reach different accounts but a single
      // event can feed both, and the asset's own history is what decided how
      // much went where.
      if (e.toSurplusMinor > 0n) out.increases += e.toSurplusMinor;
      else out.decreases += -e.toSurplusMinor;
      if (e.toProfitMinor < 0n) out.impairmentLosses += -e.toProfitMinor;
      else out.impairmentReversals += e.toProfitMinor;
    }
  }
  return out;
}

/**
 * IAS 38.118: the movement on intangible assets, and the classes behind it.
 *
 * Its own note because an intangible is its own thing. It went onto the fixed
 * asset register as category IT, onto 1500 with the plant, amortised through
 * 6600 "Depreciation", and appeared under a heading that said property, plant
 * and equipment. Straight-line over a finite life IS amortisation, so nothing
 * was arithmetically wrong — the caption, the accounts and the disclosure were,
 * and that is a year-end problem rather than a monthly one, which is exactly
 * the kind nobody notices until an auditor does.
 *
 * There is no revaluation partition here, unlike the PPE note. IAS 38.75
 * permits the revaluation model only where an active market exists for the
 * asset, which for software and licences it does not, so nothing in this
 * product revalues an intangible and a partition would be a column that is
 * always nil.
 *
 * What it cannot say is said rather than left out — an indefinite life, and
 * internally generated assets, both of which need a judgement no accounting
 * record holds.
 */
function intangiblesNote(
  ctx: Context,
  n: number,
  register: Awaited<ReturnType<typeof assetRegister>>,
): IntangiblesNote {
  const cost = ctx.lines.filter((l) => l.code === INTANGIBLE_COST);
  const accum = ctx.lines.filter((l) => l.code === ACCUM_AMORTISATION);

  const additions = cost.filter((l) => l.amount > 0n).reduce((a, l) => a + l.amount, 0n);
  const disposals = -cost.filter((l) => l.amount < 0n).reduce((a, l) => a + l.amount, 0n);
  const costOpening = balanceOf(ctx.openingBs, INTANGIBLE_COST);
  const costClosing = costOpening + additions - disposals;
  const costPerSheet = balanceOf(ctx.closingBs, INTANGIBLE_COST);

  const charge = -accum.filter((l) => l.amount < 0n).reduce((a, l) => a + l.amount, 0n);
  const released = accum.filter((l) => l.amount > 0n).reduce((a, l) => a + l.amount, 0n);
  const accumOpening = -balanceOf(ctx.openingBs, ACCUM_AMORTISATION);
  const accumClosing = accumOpening + charge - released;
  const accumPerSheet = -balanceOf(ctx.closingBs, ACCUM_AMORTISATION);

  // The register's own view of the same assets, by class. Amortisation period
  // is IAS 38.118(a) and is a range rather than a single figure, because a
  // class holds assets bought in different years on different terms.
  const mine = register.assets.filter((a) => a.status === "active" && a.assetAccount === INTANGIBLE_COST);
  const classes = new Map<string, { count: number; cost: bigint; accumulated: bigint; lives: number[] }>();
  for (const a of mine) {
    const row = classes.get(a.category) ?? { count: 0, cost: 0n, accumulated: 0n, lives: [] };
    row.count += 1;
    row.cost += BigInt(a.costMinor);
    row.accumulated += BigInt(a.accumulatedMinor);
    row.lives.push(a.usefulLifeMonths);
    classes.set(a.category, row);
  }

  const anything = costOpening !== 0n || costClosing !== 0n || additions !== 0n || mine.length > 0;

  return {
    number: n,
    key: "intangible_assets",
    title: "Intangible assets",
    basis: "IAS 38.118(a), IAS 38.118(c)-(e)",
    state: anything ? "present" : "empty",
    statement: anything
      ? `Cost and accumulated amortisation are the movements on accounts ${INTANGIBLE_COST} and ` +
        `${ACCUM_AMORTISATION} in ${ctx.year.label}. Amortisation is charged to ${AMORTISATION_EXPENSE} and is ` +
        `kept apart from depreciation, because an intangible is not property, plant and equipment and IAS 38.118 ` +
        `asks for its own reconciliation. Every asset here has a finite life; the register has no path for an ` +
        `indefinite one, which is not amortised at all under IAS 38.107.`
      : `The entity holds no intangible assets. Accounts ${INTANGIBLE_COST} and ${ACCUM_AMORTISATION} are nil at ` +
        `both ends of the year and no asset on the register is registered against them. That is a fact about ` +
        `these books rather than a statement that the entity has nothing capitalisable.`,
    costAccount: INTANGIBLE_COST,
    accumulatedAmortisationAccount: ACCUM_AMORTISATION,
    cost: {
      openingMinor: costOpening.toString(),
      additionsMinor: additions.toString(),
      disposalsMinor: disposals.toString(),
      closingMinor: costClosing.toString(),
      perBalanceSheetMinor: costPerSheet.toString(),
      agrees: costClosing === costPerSheet,
    },
    accumulatedAmortisation: {
      openingMinor: accumOpening.toString(),
      chargeMinor: charge.toString(),
      releasedOnDisposalMinor: released.toString(),
      closingMinor: accumClosing.toString(),
      perBalanceSheetMinor: accumPerSheet.toString(),
      agrees: accumClosing === accumPerSheet,
    },
    netBookValue: {
      openingMinor: (costOpening - accumOpening).toString(),
      closingMinor: (costClosing - accumClosing).toString(),
    },
    byCategory: [...classes.entries()]
      .map(([category, c]) => ({
        category,
        count: c.count,
        costMinor: c.cost.toString(),
        accumulatedMinor: c.accumulated.toString(),
        netBookValueMinor: (c.cost - c.accumulated).toString(),
        shortestLifeMonths: Math.min(...c.lives),
        longestLifeMonths: Math.max(...c.lives),
      }))
      .sort((a, b) => a.category.localeCompare(b.category)),
    notDerivable: anything
      ? [
          "IAS 38.118(a) asks whether each class has a finite or an indefinite life. Every asset on this " +
            "register has a finite one, because the register requires a useful life in months — an entity that " +
            "holds an indefinite-life intangible is not disclosing it from here.",
          "IAS 38.118(e)(i) separates additions made internally from those acquired. The ledger records what an " +
            "asset cost and not how it was come by, so additions above are the total of both.",
        ]
      : [],
  };
}

function ppeNote(
  ctx: Context,
  n: number,
  register: Awaited<ReturnType<typeof assetRegister>>,
  revaluations: RevaluationEvents,
): PpeNote {
  /*
   * Partitioned by source, exactly as `leaseNote` partitions 6360 and 6100.
   *
   * The revaluation module restates cost against accumulated depreciation —
   * Dr 1590, Cr 1500, the IAS 16.35(b) elimination — and then moves cost by
   * the uplift or the write-down. Classifying by the sign of the line alone
   * therefore reported the whole accumulated depreciation as a disposal of
   * cost and as depreciation released on it, and the uplift as an addition:
   * two transactions the entity never entered into. `cost.agrees` could not
   * catch it, because both halves of that check are built from the same lines.
   */
  const revaluationLine = (l: YearLine) => l.source === REVALUATION_SOURCE;
  const cost = ctx.lines.filter((l) => PPE_COST_CODES.includes(l.code));
  const accum = ctx.lines.filter((l) => l.code === ACCUM_DEPRECIATION);
  const ordinaryCost = cost.filter((l) => !revaluationLine(l));
  const ordinaryAccum = accum.filter((l) => !revaluationLine(l));

  const additions = ordinaryCost.filter((l) => l.amount > 0n).reduce((a, l) => a + l.amount, 0n);
  const disposals = -ordinaryCost.filter((l) => l.amount < 0n).reduce((a, l) => a + l.amount, 0n);
  // Signed: the elimination is a credit to cost and the write-down is another,
  // while an uplift is a debit. Netting them is right, because together they
  // are what the revaluation did to the cost account.
  const revaluationCost = cost.filter(revaluationLine).reduce((a, l) => a + l.amount, 0n);
  const costOpening = sumOf(ctx.openingBs, PPE_COST_CODES);
  const costClosing = costOpening + additions - disposals + revaluationCost;
  const costPerSheet = sumOf(ctx.closingBs, PPE_COST_CODES);

  // The charge is taken from the movement on 1590 rather than from the
  // depreciation expense account, because 6600 also carries the depreciation
  // of right-of-use assets, which credits 1700 and belongs in the leases note.
  const charge = -ordinaryAccum.filter((l) => l.amount < 0n).reduce((a, l) => a + l.amount, 0n);
  const released = ordinaryAccum.filter((l) => l.amount > 0n).reduce((a, l) => a + l.amount, 0n);
  const eliminated = accum.filter(revaluationLine).reduce((a, l) => a + l.amount, 0n);
  const accumOpening = -balanceOf(ctx.openingBs, ACCUM_DEPRECIATION);
  const accumClosing = accumOpening + charge - released - eliminated;
  const accumPerSheet = -balanceOf(ctx.closingBs, ACCUM_DEPRECIATION);

  // Two records of one thing again: the carrying amount the revaluation
  // postings moved, and the movement the register says each event was for.
  const revaluationPerLedger = revaluationCost + eliminated;
  const revaluationNet =
    revaluations.increases - revaluations.decreases - revaluations.impairmentLosses + revaluations.impairmentReversals;

  // Intangibles are on the same register and belong in their own note. Without
  // this the class table below would list a software licence under property,
  // plant and equipment while the movement above — read from 1500 and 1600 —
  // correctly did not include it, so the note would disagree with itself.
  const active = register.assets.filter(
    (a) => a.status === "active" && PPE_COST_CODES.includes(a.assetAccount),
  );
  const categories = new Map<string, { count: number; cost: bigint; accumulated: bigint }>();
  for (const a of active) {
    const row = categories.get(a.category) ?? { count: 0, cost: 0n, accumulated: 0n };
    row.count += 1;
    row.cost += BigInt(a.costMinor);
    row.accumulated += BigInt(a.accumulatedMinor);
    categories.set(a.category, row);
  }

  const anything =
    costOpening !== 0n || costClosing !== 0n || additions !== 0n || disposals !== 0n || active.length > 0;

  return {
    number: n,
    key: "property_plant_and_equipment",
    title: "Property, plant and equipment",
    basis: "IAS 16.73(d)-(e)",
    state: anything ? "present" : "empty",
    statement: anything
      ? `Cost and accumulated depreciation are the movements on accounts ${PPE_COST_CODES.join(", ")} and ` +
        `${ACCUM_DEPRECIATION} in ${ctx.year.label}, split by what made each one: a revaluation restates cost ` +
        `against accumulated depreciation, which is neither an addition nor a disposal and is shown as neither. ` +
        `The register is a second record of the same assets and is shown beside the ledger so the two can be ` +
        `compared; it is stated as it now stands rather than as at ${ctx.to}.`
      : `The entity holds no property, plant or equipment. Accounts ${PPE_COST_CODES.join(", ")} and ` +
        `${ACCUM_DEPRECIATION} are nil at both ends of the year and the register is empty.`,
    costAccounts: PPE_COST_CODES,
    accumulatedDepreciationAccount: ACCUM_DEPRECIATION,
    cost: {
      openingMinor: costOpening.toString(),
      additionsMinor: additions.toString(),
      disposalsMinor: disposals.toString(),
      revaluationMinor: revaluationCost.toString(),
      closingMinor: costClosing.toString(),
      perBalanceSheetMinor: costPerSheet.toString(),
      agrees: costClosing === costPerSheet,
    },
    accumulatedDepreciation: {
      openingMinor: accumOpening.toString(),
      chargeMinor: charge.toString(),
      releasedOnDisposalMinor: released.toString(),
      eliminatedOnRevaluationMinor: eliminated.toString(),
      closingMinor: accumClosing.toString(),
      perBalanceSheetMinor: accumPerSheet.toString(),
      agrees: accumClosing === accumPerSheet,
    },
    netBookValue: {
      openingMinor: (costOpening - accumOpening).toString(),
      closingMinor: (costClosing - accumClosing).toString(),
    },
    revaluation: {
      events: revaluations.count,
      increasesMinor: revaluations.increases.toString(),
      decreasesMinor: revaluations.decreases.toString(),
      impairmentLossesMinor: revaluations.impairmentLosses.toString(),
      impairmentReversalsMinor: revaluations.impairmentReversals.toString(),
      netMovementMinor: revaluationNet.toString(),
      perLedgerMinor: revaluationPerLedger.toString(),
      agrees: revaluationNet === revaluationPerLedger,
    },
    register: {
      assets: active.length,
      costMinor: register.totals.costMinor,
      accumulatedMinor: register.totals.accumulatedMinor,
      netBookValueMinor: register.totals.netBookValueMinor,
      costAgrees: register.ledger.costAgrees,
      accumulatedAgrees: register.ledger.accumulatedAgrees,
    },
    byCategory: [...categories.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([category, r]) => ({
        category,
        count: r.count,
        costMinor: r.cost.toString(),
        accumulatedMinor: r.accumulated.toString(),
        netBookValueMinor: (r.cost - r.accumulated).toString(),
      })),
  };
}

function leaseNote(ctx: Context, n: number, register: Awaited<ReturnType<typeof leaseRegister>>): LeaseNote {
  const leaseEntry = (l: YearLine) => l.source === "lease";
  const rou = ctx.lines.filter((l) => l.code === ROU_ASSET);
  const liability = ctx.lines.filter((l) => l.code === LEASE_LIABILITY);

  const rouAdditions = rou.filter((l) => l.amount > 0n).reduce((a, l) => a + l.amount, 0n);
  const rouDepreciation = -rou.filter((l) => l.amount < 0n).reduce((a, l) => a + l.amount, 0n);
  const rouOpening = balanceOf(ctx.openingBs, ROU_ASSET);
  const rouClosing = rouOpening + rouAdditions - rouDepreciation;
  const rouPerSheet = balanceOf(ctx.closingBs, ROU_ASSET);

  // The liability grows by the interest that unwinds into it and falls by the
  // payments made against it. Those are two different things and separating
  // them is the point of IFRS 16.53(b) and .53(g).
  const liabilityAdditions = -liability
    .filter((l) => l.sourceType === "LEASE_INCEPTION")
    .reduce((a, l) => a + l.amount, 0n);
  const liabilityInterest = -liability
    .filter((l) => l.sourceType === "LEASE_RUN")
    .reduce((a, l) => a + l.amount, 0n);
  const payments = liability.filter((l) => l.amount > 0n).reduce((a, l) => a + l.amount, 0n);
  const liabilityOpening = -balanceOf(ctx.openingBs, LEASE_LIABILITY);
  const liabilityClosing = liabilityOpening + liabilityAdditions + liabilityInterest - payments;
  const liabilityPerSheet = -balanceOf(ctx.closingBs, LEASE_LIABILITY);

  // 6360 also serves loan interest and 6100 also serves ordinary rent, so both
  // are restricted to postings the lease module made.
  const interestExpense = ctx.lines
    .filter((l) => l.code === LEASE_FINANCE_COST && leaseEntry(l))
    .reduce((a, l) => a + l.amount, 0n);
  const exemptRent = ctx.lines
    .filter((l) => l.code === LEASE_RENT && leaseEntry(l))
    .reduce((a, l) => a + l.amount, 0n);
  const cashOutflow = -ctx.lines
    .filter((l) => ctx.cashCodes.has(l.code) && leaseEntry(l))
    .reduce((a, l) => a + l.amount, 0n);

  // The undiscounted payments still to be made, from the year end. Discounted
  // figures are already on the balance sheet; IFRS 7.39 wants the contractual
  // ones, which is what a reader can compare against a lease agreement.
  const endOrdinal = monthOrdinal(ctx.year.endsOn);
  const bands = { within1: 0n, from1to5: 0n, beyond5: 0n };
  for (const l of register.leases) {
    if (l.exempt || l.status === "draft") continue;
    const remaining = Math.max(0, monthOrdinal(new Date(l.endsOn)) - endOrdinal);
    const payment = BigInt(l.paymentMinor);
    bands.within1 += BigInt(Math.min(remaining, 12)) * payment;
    bands.from1to5 += BigInt(Math.min(Math.max(remaining - 12, 0), 48)) * payment;
    bands.beyond5 += BigInt(Math.max(remaining - 60, 0)) * payment;
  }

  const anything = register.leases.length > 0 || rouOpening !== 0n || liabilityOpening !== 0n;

  return {
    number: n,
    key: "leases",
    title: "Leases",
    basis: "IFRS 16.53, IFRS 16.58, IFRS 16.60",
    state: anything ? "present" : "empty",
    statement: anything
      ? `The entity is a lessee under ${register.leases.length} lease${register.leases.length === 1 ? "" : "s"}. ` +
        `Depreciation of right-of-use assets and interest on lease liabilities are separate charges and are ` +
        `shown separately; together they are front-loaded and do not equal the rent they replaced in any single ` +
        `year.`
      : "The entity is not a lessee under any lease, and no right-of-use asset or lease liability is recognised.",
    rightOfUseAssets: {
      openingMinor: rouOpening.toString(),
      additionsMinor: rouAdditions.toString(),
      depreciationMinor: rouDepreciation.toString(),
      closingMinor: rouClosing.toString(),
      perBalanceSheetMinor: rouPerSheet.toString(),
      agrees: rouClosing === rouPerSheet,
    },
    liabilities: {
      openingMinor: liabilityOpening.toString(),
      additionsMinor: liabilityAdditions.toString(),
      interestMinor: liabilityInterest.toString(),
      paymentsMinor: payments.toString(),
      closingMinor: liabilityClosing.toString(),
      perBalanceSheetMinor: liabilityPerSheet.toString(),
      agrees: liabilityClosing === liabilityPerSheet,
    },
    interestExpenseMinor: interestExpense.toString(),
    shortTermAndLowValueExpenseMinor: exemptRent.toString(),
    totalCashOutflowMinor: cashOutflow.toString(),
    maturity: [
      { key: "within_1_year", label: "Not later than one year", amountMinor: bands.within1.toString() },
      { key: "1_to_5_years", label: "Later than one year and not later than five", amountMinor: bands.from1to5.toString() },
      { key: "over_5_years", label: "Later than five years", amountMinor: bands.beyond5.toString() },
    ],
    exemptions: register.exemptions.map((e) => ({
      code: e.code,
      name: e.name,
      reason: e.reason,
      note: e.note,
      annualRentMinor: e.annualRentMinor,
    })),
    notDerivable: [
      "Variable lease payments not included in the measurement of the liability (IFRS 16.53(e)) — the ledger does not model them.",
      "Income from subleasing right-of-use assets (IFRS 16.53(f)) — the entity is recorded only as a lessee.",
      "Gains and losses on sale and leaseback transactions (IFRS 16.53(i)) — not modelled.",
    ],
    leases: register.leases.length,
  };
}

function receivablesPayablesNote(
  ctx: Context,
  n: number,
  ar: Awaited<ReturnType<typeof receivablesAgeing>>,
  ap: Awaited<ReturnType<typeof payablesAgeing>>,
): ReceivablesPayablesNote {
  const band = (buckets: Record<string, string>): AgeingBand[] =>
    AGEING_BANDS.map((b) => ({ key: b.key, label: b.label, amountMinor: buckets[b.key] ?? "0" }));

  const arLedger = balanceOf(ctx.closingBs, TRADE_RECEIVABLES);
  const apLedger = -balanceOf(ctx.closingBs, TRADE_PAYABLES);
  const allowance = -balanceOf(ctx.closingBs, DOUBTFUL_DEBT_ALLOWANCE);

  const receivables: AgeingDisclosure = {
    account: TRADE_RECEIVABLES,
    name: ctx.accountNames.get(TRADE_RECEIVABLES)?.name ?? "Trade receivables",
    asOf: ar.asOf,
    bands: band(ar.buckets),
    totalPerAgeingMinor: ar.totalMinor,
    totalPerLedgerMinor: arLedger.toString(),
    agrees: BigInt(ar.totalMinor) === arLedger,
    differenceMinor: (BigInt(ar.totalMinor) - arLedger).toString(),
    openItems: ar.open.length,
    oldestDays: ar.open.length ? ar.open[0].daysOld : null,
    overdueMinor: ar.overdueMinor,
  };

  const payables: AgeingDisclosure = {
    account: TRADE_PAYABLES,
    name: ctx.accountNames.get(TRADE_PAYABLES)?.name ?? "Trade payables",
    asOf: ap.asOf,
    bands: band(ap.buckets),
    totalPerAgeingMinor: ap.totalMinor,
    totalPerLedgerMinor: apLedger.toString(),
    agrees: BigInt(ap.totalMinor) === apLedger,
    differenceMinor: (BigInt(ap.totalMinor) - apLedger).toString(),
    openItems: ap.open.length,
    oldestDays: ap.open.length ? ap.open[0].daysOld : null,
    overdueMinor: ap.overdueMinor,
  };

  // Cut on the due date rather than the document date, which is the whole
  // difference between a liquidity disclosure and a credit-control one. The
  // subledger builds it in the same pass as the ageing and from the same netted
  // open items, so the two tables come to the same total by construction.
  const payablesMaturity: MaturityDisclosure = {
    account: TRADE_PAYABLES,
    name: ctx.accountNames.get(TRADE_PAYABLES)?.name ?? "Trade payables",
    asOf: ap.maturity.asOf,
    bands: ap.maturity.bands,
    totalMinor: ap.maturity.totalMinor,
    pastDueMinor: ap.maturity.pastDueMinor,
    undatedMinor: ap.maturity.undatedMinor,
    undatedItems: ap.maturity.undatedItems,
  };

  const anything = arLedger !== 0n || apLedger !== 0n || ar.open.length > 0 || ap.open.length > 0;
  const undated = BigInt(payablesMaturity.undatedMinor) !== 0n;

  return {
    number: n,
    key: "trade_receivables_and_payables",
    title: "Trade receivables and trade payables",
    basis: "IFRS 7.35, IFRS 7.39, IAS 1.61",
    state: anything ? "present" : "empty",
    statement: anything
      ? `Both ageings are built by netting each document down to what is still open on it, from the control ` +
        `accounts themselves. The band totals are shown against the control account balance at ${ctx.to}: if the ` +
        `two differ, the ageing has lost a document, and the difference says by how much. The ageings measure how ` +
        `long ago each document was raised; the maturity table measures how long there is left to pay, which is a ` +
        `different question and the one IFRS 7.39 asks.` +
        (undated
          ? ` ${payablesMaturity.undatedItems} payable${payablesMaturity.undatedItems === 1 ? "" : "s"} carr` +
            `${payablesMaturity.undatedItems === 1 ? "ies" : "y"} no payment terms, so no maturity can be stated ` +
            `for ${payablesMaturity.undatedItems === 1 ? "it" : "them"} and ${payablesMaturity.undatedItems === 1 ? "it is" : "they are"} ` +
            `shown apart rather than assumed to be payable on demand.`
          : "")
      : `Nothing is owed to the entity and nothing is owed by it at ${ctx.to}. Accounts ${TRADE_RECEIVABLES} and ` +
        `${TRADE_PAYABLES} are both nil and neither ageing carries an open item.`,
    receivables,
    payables,
    payablesMaturity,
    allowanceForDoubtfulDebtsMinor: allowance.toString(),
    netReceivablesMinor: (arLedger - allowance).toString(),
  };
}

/**
 * IFRS 7.35H and 7.35M — the credit risk note the provision matrix makes
 * possible.
 *
 * The matrix is recomputed at the reporting date rather than read off the last
 * posting, so the note says whether the allowance the ledger carries is still
 * the allowance the matrix asks for. That comparison is the disclosure's whole
 * value: an allowance measured once and never revisited is the failure this
 * note exists to make visible, and reporting only the posted figure would hide
 * exactly that.
 */
function creditRiskNote(
  ctx: Context,
  n: number,
  view: Awaited<ReturnType<typeof allowanceView>>,
): CreditRiskNote {
  const allowanceLines = ctx.lines.filter((l) => l.code === DOUBTFUL_DEBT_ALLOWANCE);
  const opening = -balanceOf(ctx.openingBs, DOUBTFUL_DEBT_ALLOWANCE);
  const perSheet = -balanceOf(ctx.closingBs, DOUBTFUL_DEBT_ALLOWANCE);

  // Signs, once, so the rest reads as English. The allowance is a contra-asset,
  // so a credit raises it and a debit consumes it; the ledger holds a credit
  // negative, hence the negation.
  const measured = allowanceLines.filter((l) => l.sourceType === ALLOWANCE_SOURCE_TYPE);
  const charged = -measured.filter((l) => l.amount < 0n).reduce((a, l) => a + l.amount, 0n);
  const released = measured.filter((l) => l.amount > 0n).reduce((a, l) => a + l.amount, 0n);
  // A debt written off against the allowance consumes it: the expense was taken
  // when the allowance was raised, so this is not a second charge and must not
  // read as one. IFRS 7.35I asks for it as its own line for that reason.
  const utilised = allowanceLines
    .filter((l) => l.source === "write_off")
    .reduce((a, l) => a + l.amount, 0n);
  // Anything else that reached 1150 — a hand-keyed journal, an opening balance.
  // It is shown rather than absorbed, because a reconciliation that plugs is
  // not a reconciliation.
  const other = allowanceLines
    .filter((l) => l.sourceType !== ALLOWANCE_SOURCE_TYPE && l.source !== "write_off")
    .reduce((a, l) => a - l.amount, 0n);
  const closing = opening + charged - released - utilised + other;

  const target = BigInt(view.targetMinor);
  const carried = BigInt(view.carriedMinor);
  const gross = BigInt(view.grossReceivablesMinor);
  const anything = gross !== 0n || carried !== 0n || allowanceLines.length > 0;
  const measuredAtReportingDate = view.postedEntryId !== null;

  return {
    number: n,
    key: "credit_risk",
    title: "Credit risk and the allowance for doubtful debts",
    basis: "IFRS 9.5.5.15, IFRS 9.B5.5.35, IFRS 7.35H, IFRS 7.35M, IFRS 7.35N",
    state: anything ? "present" : "empty",
    statement: anything
      ? `Trade receivables are measured at lifetime expected credit losses under the simplified approach, on a ` +
        `provision matrix of loss rates by age of the debt. The matrix below is recomputed at ${ctx.to} ` +
        (view.ratesSupplied
          ? `on the loss rates the preparer set`
          : `on the product's default loss rates — which are a starting point and not a measurement of this ` +
            `entity's own collection history, and IFRS 9.B5.5.35 asks for the latter`) +
        `, and set against what account ${DOUBTFUL_DEBT_ALLOWANCE} actually carries: ` +
        (target === carried
          ? `the two agree.`
          : `they differ by ${money(target - carried, ctx.currency)}. Read that as an indication to remeasure ` +
            `rather than as a measured under-provision, because the rates each allowance was actually posted on ` +
            `are recorded on its own entry and listed below.`) +
        (measuredAtReportingDate
          ? ` The allowance was measured at the reporting date.`
          : ` No allowance was measured at ${ctx.to} itself, so what the ledger carries was last set on an ` +
            `earlier ageing.`)
      : `The entity carries no trade receivables at ${ctx.to} and no allowance for doubtful debts, so there is no ` +
        `credit risk on trade receivables to disclose.`,
    asOf: view.asOf,
    allowanceAccount: DOUBTFUL_DEBT_ALLOWANCE,
    ratesAreDefault: !view.ratesSupplied,
    matrix: view.matrix.map((r) => ({
      band: r.band,
      label: r.label,
      grossMinor: r.grossMinor,
      exposureMinor: r.exposureMinor,
      rateBps: r.rateBps,
      ratePercent: r.ratePercent,
      lossMinor: r.lossMinor,
    })),
    grossReceivablesMinor: view.grossReceivablesMinor,
    targetMinor: view.targetMinor,
    carriedMinor: view.carriedMinor,
    differenceMinor: (target - carried).toString(),
    measuredAtReportingDate,
    netReceivablesMinor: view.netReceivablesMinor,
    reconciliation: {
      openingMinor: opening.toString(),
      chargedMinor: charged.toString(),
      releasedMinor: released.toString(),
      utilisedMinor: utilised.toString(),
      otherMinor: other.toString(),
      closingMinor: closing.toString(),
      perBalanceSheetMinor: perSheet.toString(),
      agrees: closing === perSheet,
    },
    measurements: view.history
      .filter((m) => m.date >= ctx.from && m.date <= ctx.to)
      .map((m) => ({ reference: m.reference, date: m.date, movementMinor: m.movementMinor, memo: m.memo })),
    notDerivable: [
      "Collateral and other credit enhancements held (IFRS 7.35K(b)) — the ledger records no security over a trade receivable.",
      "Concentrations of credit risk by counterparty or by geography (IFRS 7.34(c)) — the matrix grades by age of the debt alone.",
      "Forward-looking adjustments to the loss rates (IFRS 9.5.5.17(c)) — the rates are entered as a judgement, and the ledger holds no macroeconomic input to derive one from.",
    ],
  };
}

/**
 * The statutory reserve Article 103 of Federal Decree-Law 32/2021 requires.
 *
 * Ten per cent of the year's net profit goes to a statutory reserve until the
 * reserve reaches half the paid-up capital. This computes what that comes to
 * and sets it against what the ledger shows was actually appropriated, because
 * account 3200 was seeded and the statement reported a transfer correctly the
 * moment somebody made one — and nothing ever asked for one.
 *
 * Two honest limits, stated in the note rather than glossed. The profit here is
 * the accounting profit these statements report, and Article 103 says "net
 * profits" without defining it for this purpose; and a company's own articles
 * may require more than the statutory ten per cent. Neither is knowable from a
 * ledger, so both are said out loud.
 */
function statutoryReserveNote(
  ctx: Context,
  n: number,
  statement: StatementOfChangesInEquity,
): StatutoryReserveNote {
  const paidUpCapital = -balanceOf(ctx.closingBs, SHARE_CAPITAL);
  const cap = (paidUpCapital + 1n) / 2n;
  const opening = -balanceOf(ctx.openingBs, STATUTORY_RESERVE);
  const closing = -balanceOf(ctx.closingBs, STATUTORY_RESERVE);
  const transferred = closing - opening;

  const profit = BigInt(statement.profitForThePeriodMinor);
  // A loss is not a profit to deduct a tenth of, and Article 103 has nothing to
  // say about one. Rounded up on the fil, so a deduction is never a fil short of
  // the tenth the article asks for.
  const tenPercent = profit > 0n ? (profit + 9n) / 10n : 0n;
  // Measured before this year's transfer, because the question the article asks
  // is how much room there was to fill.
  const headroom = cap - opening > 0n ? cap - opening : 0n;
  const required = tenPercent < headroom ? tenPercent : headroom;
  const shortfall = required - transferred > 0n ? required - transferred : 0n;

  const anything = paidUpCapital !== 0n || closing !== 0n || profit !== 0n;

  return {
    number: n,
    key: "statutory_reserve",
    title: "Statutory reserve",
    basis: "Federal Decree-Law 32/2021 Article 103, IAS 1.79(b)",
    state: anything ? "present" : "empty",
    statement: anything
      ? (closing >= cap && cap > 0n
          ? `The statutory reserve stands at ${money(closing, ctx.currency)}, which is at least half the paid-up ` +
            `capital of ${money(paidUpCapital, ctx.currency)}. Article 103 permits the annual deduction to stop.`
          : shortfall === 0n
            ? `Article 103 requires ${money(required, ctx.currency)} of this year's profit to be appropriated to ` +
              `the statutory reserve, and ${money(transferred, ctx.currency)} was. Nothing is outstanding.`
            : `Article 103 requires ${money(required, ctx.currency)} of this year's profit to be appropriated to ` +
              `the statutory reserve. ${transferred === 0n ? "No transfer has been made" : `${money(transferred, ctx.currency)} was transferred`}, ` +
              `so ${money(shortfall, ctx.currency)} is still to be appropriated. It is a movement within equity ` +
              `and changes neither the total of equity nor the result for the year.`) +
        ` The percentage is applied to the result these statements report; Article 103 says "net profits" without ` +
        `defining the term for this purpose, and a company's own articles may require more than the statutory ` +
        `tenth. Neither can be read off a ledger.`
      : `The entity has no paid-up capital, no statutory reserve and no result for ${ctx.year.label}, so Article ` +
        `103 asks nothing of it this year.`,
    account: STATUTORY_RESERVE,
    capitalAccount: SHARE_CAPITAL,
    paidUpCapitalMinor: paidUpCapital.toString(),
    capMinor: cap.toString(),
    openingMinor: opening.toString(),
    transferredMinor: transferred.toString(),
    closingMinor: closing.toString(),
    profitForThePeriodMinor: profit.toString(),
    tenPercentMinor: tenPercent.toString(),
    headroomMinor: headroom.toString(),
    requiredMinor: required.toString(),
    shortfallMinor: shortfall.toString(),
    satisfied: shortfall === 0n,
    capReached: cap > 0n && closing >= cap,
  };
}

function revenueNote(ctx: Context, n: number): RevenueNote {
  // The closing entry brings every income account to zero. Its lines are real
  // postings to income accounts, so leaving them in would disaggregate a
  // closed year's revenue to nil — the note would say the entity sold nothing
  // in a year it traded.
  const income = ctx.lines.filter((l) => l.type === "INCOME" && l.source !== "close");

  const byTax = new Map<string, bigint>();
  const byAccount = new Map<string, { name: string; nameAr: string | null; amount: bigint }>();
  let untagged = 0n;
  let untaggedLines = 0;

  for (const l of income) {
    // Income sits on the credit side, so the presented figure is negated.
    const amount = -l.amount;
    const key = l.taxCode ?? "";
    byTax.set(key, (byTax.get(key) ?? 0n) + amount);
    const acc = byAccount.get(l.code) ?? { name: l.name, nameAr: l.nameAr, amount: 0n };
    acc.amount += amount;
    byAccount.set(l.code, acc);
    if (!l.taxCode) {
      untagged += amount;
      untaggedLines += 1;
    }
  }

  const total = [...byTax.values()].reduce((a, v) => a + v, 0n);
  const accountTotal = [...byAccount.values()].reduce((a, v) => a + v.amount, 0n);

  return {
    number: n,
    key: "revenue",
    title: "Revenue",
    basis: "IFRS 15.114, IFRS 15.B89",
    state: income.length ? "present" : "empty",
    statement: income.length
      ? `Revenue is disaggregated two ways over the same ${income.length} postings: by the tax treatment each ` +
        `sale was raised under, and by the account it was booked to. Both are read from the ledger lines, so ` +
        `neither can disagree with the profit and loss or with the VAT return, which are read from the same ones.`
      : `No revenue was recognised in ${ctx.year.label}.`,
    byTaxTreatment: [...byTax.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([code, amount]) => ({
        taxCode: code === "" ? null : code,
        label: code === "" ? "Not tagged with a tax treatment" : TAX_TREATMENT_LABEL[code] ?? code,
        amountMinor: amount.toString(),
        // Basis points, by integer division — a share held as a float is a
        // share that does not add to 100.
        shareBps: total === 0n ? null : Number((amount * 10_000n) / total),
      })),
    byAccount: [...byAccount.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([code, a]) => ({ code, name: a.name, nameAr: a.nameAr, amountMinor: a.amount.toString() })),
    totalMinor: total.toString(),
    untaggedMinor: untagged.toString(),
    untaggedLines,
    agrees: total === accountTotal,
  };
}

function relatedPartyNote(
  ctx: Context,
  n: number,
  statement: StatementOfChangesInEquity,
  data: RelatedPartyNoteData,
): RelatedPartyNote {
  /*
   * A ledger cannot know which parties are related, and this note does not
   * guess.
   *
   * Relatedness under IAS 24 is a fact about people and control — a director's
   * spouse, an entity under common control, a member of key management — and
   * none of that is written in a chart of accounts or a journal line. A
   * detector would be wrong in the direction that matters: it would produce a
   * confident, incomplete list, and a reader would take the silence about
   * everyone else as a statement that there is nobody else.
   *
   * So the parties come from `related-parties.ts`, where somebody declared
   * them and the declaration is signed and dated. That module also reads what
   * passed between the entity and each of them, holds the IAS 24.17
   * compensation by category and the IAS 24.13 attestation, and grades its own
   * completeness — which is why this note now asks only for what that grading
   * says is still missing, rather than asking the same four questions of every
   * entity forever, including the ones that have already answered them.
   *
   * The shareholder current account stays, and stays first. It is related by
   * construction: the account exists precisely to record what the owner has
   * put in and taken out, so every balance on it is a related party balance
   * whatever anybody has declared.
   */
  const opening = BigInt(statement.opening.cells[SHAREHOLDER_CURRENT] ?? "0");
  const closing = BigInt(statement.closing.cells[SHAREHOLDER_CURRENT] ?? "0");
  const movements = statement.movements
    .map((r) => ({ key: r.key, label: r.label, amountMinor: r.cells[SHAREHOLDER_CURRENT] ?? "0" }))
    .filter((m) => m.amountMinor !== "0");
  const postings = ctx.lines.filter((l) => l.code === SHAREHOLDER_CURRENT).length;

  const declared = data.parties.length;
  const onTheAccount = opening !== 0n || closing !== 0n || postings > 0;
  // A note that is empty because somebody assessed the counterparties and
  // found nothing is a different document from one that is empty because
  // nobody was asked. `complete` is the register saying which of the two
  // this is.
  const anything = onTheAccount || declared > 0 || data.compensation.rows.length > 0 || data.attestation.present;

  const total = BigInt(data.compensation.totalMinor);

  return {
    number: n,
    key: "related_parties",
    title: "Related party balances and transactions",
    basis: "IAS 24.13, IAS 24.17, IAS 24.18",
    state: anything || data.completeness.complete ? "present" : "requires_input",
    statement: anything
      ? `${declared === 0 ? "No party has been declared related" : `${declared} related ${declared === 1 ? "party is" : "parties are"} declared`} ` +
        `for ${ctx.year.label}, and the shareholder current account is a related party balance by construction — ` +
        `it exists to record what the owner has put into the business and taken out of it. ` +
        (data.completeness.complete
          ? `Every counterparty has been assessed, compensation is given by category and the controlling party ` +
            `is attested, so this note is complete.`
          : `${data.completeness.reasons.length} thing${data.completeness.reasons.length === 1 ? " is" : "s are"} ` +
            `still outstanding, listed below.`)
      : "Nobody has been asked. The shareholder current account is nil and never moved, no party has been " +
        "declared either related or unrelated, and no attestation has been made. That is not the same as there " +
        "being no related party transactions: relationships under IAS 24 are facts about people and control, " +
        "which no ledger holds.",
    account: {
      code: SHAREHOLDER_CURRENT,
      name: ctx.accountNames.get(SHAREHOLDER_CURRENT)?.name ?? "Shareholder current account",
      nameAr: ctx.accountNames.get(SHAREHOLDER_CURRENT)?.nameAr ?? null,
    },
    openingMinor: opening.toString(),
    closingMinor: closing.toString(),
    movements,
    postings,
    parties: data.parties.map((p) => ({
      partyKey: p.partyKey,
      name: p.name,
      relationship: p.relationship,
      relationshipLabel: p.relationshipLabel,
      startedOn: p.startedOn,
      endedOn: p.endedOn,
      declaredBy: p.declaredBy,
      declaredOn: p.declaredOn,
      salesMinor: p.salesMinor.toString(),
      purchasesMinor: p.purchasesMinor.toString(),
      documents: p.documents,
      notes: p.notes,
    })),
    byRelationship: data.byRelationship.map((g) => ({
      relationship: g.relationship,
      label: g.label,
      count: g.count,
      salesMinor: g.salesMinor.toString(),
      purchasesMinor: g.purchasesMinor.toString(),
    })),
    compensation: {
      rows: data.compensation.rows.map((r) => ({
        category: r.category,
        label: r.label,
        amountMinor: r.amountMinor.toString(),
        headcount: r.headcount,
        declaredBy: r.declaredBy,
      })),
      totalMinor: total.toString(),
      missingCategories: data.compensation.missingCategories,
      headcount: data.compensation.headcount,
    },
    attestation: data.attestation,
    completeness: data.completeness,
    // The register's own grading, not a fixed list. An entity that has
    // answered a question is not asked it again, which is the difference
    // between a note that can be finished and one that cannot.
    requiresInput: data.completeness.reasons,
  };
}

async function taxNote(ctx: Context, n: number, profitForThePeriod: bigint): Promise<TaxNote> {
  const computation = await corporateTaxComputation({
    orgId: ctx.orgId,
    entityId: ctx.entityId,
    from: ctx.from,
    to: ctx.to,
  });

  const accountingProfit = BigInt(computation.accountingProfitMinor);
  const taxableBeforeRelief = BigInt(computation.taxableIncomeBeforeReliefMinor);
  const taxable = BigInt(computation.taxableIncomeMinor);
  const charge = BigInt(computation.taxPayableMinor);

  /*
   * IAS 12.81(c) asks for a numerical reconciliation between the tax charge and
   * accounting profit at the statutory rate. Each row is a tax amount, not an
   * income amount, and the rows are built so that they sum to the charge
   * exactly — the last one is what the bands and any relief did, and it is
   * derived as the residual rather than recomputed, so the reconciliation
   * cannot foot to anything but the charge itself.
   */
  const atStatutory = taxAtStatutoryRate(accountingProfit);
  const adjustmentEffect = taxAtStatutoryRate(taxableBeforeRelief) - atStatutory;
  const reliefEffect = computation.smallBusinessRelief.applied
    ? taxAtStatutoryRate(taxable) - taxAtStatutoryRate(taxableBeforeRelief)
    : 0n;
  const bandEffect = charge - atStatutory - adjustmentEffect - reliefEffect;

  const reconciliation = [
    {
      key: "at_statutory_rate",
      label: "Tax on the accounting profit at 9%",
      basis: "FDL 47/2022 Article 3(1)(b)",
      amountMinor: atStatutory.toString(),
    },
    {
      key: "adjustments",
      label: "Effect of adjustments to taxable income",
      basis: "FDL 47/2022 Articles 20, 28, 30, 32, 33",
      amountMinor: adjustmentEffect.toString(),
    },
    ...(reliefEffect === 0n
      ? []
      : [
          {
            key: "small_business_relief",
            label: "Effect of the Small Business Relief election",
            basis: "FDL 47/2022 Article 21, Ministerial Decision 73/2023",
            amountMinor: reliefEffect.toString(),
          },
        ]),
    {
      key: "zero_band",
      label: "Effect of the 0% band on the first AED 375,000, and of any taxable loss",
      basis: "FDL 47/2022 Article 3(1)(a)",
      amountMinor: bandEffect.toString(),
    },
  ];
  const reconciliationTotal = reconciliation.reduce((a, r) => a + BigInt(r.amountMinor), 0n);

  // What the books actually carry, which is a different question from what the
  // computation says they should. Closing entries are excluded: the close
  // brings 7000 to zero and would otherwise report a year's tax as nil.
  const chargePerLedger = ctx.lines
    .filter((l) => l.code === CT_EXPENSE && l.source !== "close")
    .reduce((a, l) => a + l.amount, 0n);
  const payableClosing = -balanceOf(ctx.closingBs, CT_PAYABLE);

  // The tax computation starts from `profitAndLoss()`, and this statement
  // builds the year's result from the movement in equity. They are two routes
  // to the same number, so a disagreement is a finding — it means one of them
  // is reading something the other is not, and the tax charge is drawn from
  // whichever is wrong.
  //
  // Until recently this fired on every closed year, because the closing entry
  // zeroed every income and expense account inside the window the computation
  // reads. That is now taken back out in `profitAndLoss()` itself, so anything
  // this catches from here on is a real difference rather than an artefact.
  const readsClosedYear = accountingProfit !== profitForThePeriod;

  const warnings = [...computation.warnings];
  if (readsClosedYear) {
    warnings.push(
      `The computation reads accounting profit of ${money(accountingProfit, ctx.currency)} but the year's result ` +
        `per this statement is ${money(profitForThePeriod, ctx.currency)}. The two are drawn from the same ledger ` +
        `by different routes, so they should agree; check what has been posted to equity directly, and read the ` +
        `charge already posted to ${CT_EXPENSE} below before relying on the computation.`,
    );
  }

  return {
    number: n,
    key: "corporate_tax",
    title: "Corporate tax",
    basis: "IAS 12.79, IAS 12.81(c), FDL 47/2022",
    state: charge !== 0n || chargePerLedger !== 0n || payableClosing !== 0n ? "present" : "empty",
    statement:
      charge !== 0n || chargePerLedger !== 0n || payableClosing !== 0n
        ? `The charge is reconciled to the accounting profit at the statutory rate. Every row is a tax amount and ` +
          `they add to the charge exactly; nothing is left over.`
        : `No corporate tax arises for ${ctx.year.label} and none is provided in the books.`,
    chargePerLedgerMinor: chargePerLedger.toString(),
    payableClosingMinor: payableClosing.toString(),
    computedChargeMinor: charge.toString(),
    accountingProfitPerComputationMinor: accountingProfit.toString(),
    profitForThePeriodMinor: profitForThePeriod.toString(),
    computationReadsClosedYear: readsClosedYear,
    taxableIncomeMinor: taxable.toString(),
    effectiveRateBps: computation.effectiveRateBps === null ? null : computation.effectiveRateBps.toString(),
    reconciliation,
    reconciliationTotalMinor: reconciliationTotal.toString(),
    foots: reconciliationTotal === charge,
    adjustments: computation.adjustments.map((a) => ({
      key: a.key,
      label: a.label,
      basis: a.basis,
      amountMinor: a.amountMinor,
      origin: a.origin,
    })),
    smallBusinessRelief: {
      elected: computation.smallBusinessRelief.elected,
      applied: computation.smallBusinessRelief.applied,
      eligible: computation.smallBusinessRelief.eligible,
      reason: computation.smallBusinessRelief.reason,
    },
    provisionPosted: computation.provision.posted,
    provisionAgrees: computation.provision.matches,
    warnings,
  };
}

/**
 * The provisions register's IAS 37.84 movement table, carried in whole.
 *
 * It was already built, already reconciled against the register, and already
 * tested — and the notes pack did not call it, so a set of accounts with a
 * warranty provision disclosed the provision on the balance sheet and said
 * nothing about it in the notes. Nothing is recomputed here; the figures are
 * the register's own, so the note and the provisions screen cannot disagree.
 */
function provisionsNote(n: number, result: ProvisionNoteResult): ProvisionsNote {
  const { entityId: _entityId, ...body } = result;
  const anything =
    body.rows.length > 0 || body.contingentLiabilities.length > 0 || body.contingentAssets.length > 0;

  return {
    number: n,
    key: "provisions",
    title: "Provisions, contingent liabilities and contingent assets",
    basis: "IAS 37.84, IAS 37.85, IAS 37.86, IAS 37.89",
    state: anything ? "present" : "empty",
    statement: anything
      ? `The movement in each class of provision over ${body.periodLabel}, from the register. The five columns ` +
        `are signed against the carrying amount, so opening plus additions, amounts used, amounts reversed and ` +
        `the unwinding of the discount is the closing balance exactly. Contingencies are listed under the same ` +
        `date and are never added into those totals — IAS 37.27 keeps them off the balance sheet.`
      : `No provision is carried at ${body.asOf} and no contingency is disclosed. The register is empty, which ` +
        `is a fact about the accounts rather than a representation that nothing could arise.`,
    ...body,
  };
}

/**
 * The deferred tax register's IAS 12.81(g) disclosure, likewise.
 *
 * It sits after the corporate tax note because it is the second half of the
 * same subject: the tax note reconciles the charge for the year, this one says
 * what is carried on the balance sheet for differences that have not reversed
 * yet, and the IAS 12.81(e) amounts nobody has recognised at all.
 */
function deferredTaxPackNote(n: number, result: DeferredTaxNoteResult): DeferredTaxNote {
  const { entityId: _entityId, ...body } = result;
  const anything = body.rows.length > 0 || body.totals.closingNetMinor !== "0";

  return {
    number: n,
    key: "deferred_tax",
    title: "Deferred tax",
    basis: "IAS 12.81(e), IAS 12.81(g), IAS 12.82",
    state: anything ? "present" : "empty",
    statement: anything
      ? `Deferred tax by type of temporary difference at ${body.asOf}` +
        `${body.previousAsOf ? ` against ${body.previousAsOf}` : ", with no earlier measurement to compare it to"}` +
        `, and the movement between them. Amounts on which no deferred tax asset is recognised are shown beside ` +
        `each type rather than left out, because a deductible difference that has been judged unusable is a ` +
        `disclosure in its own right.`
      : `No temporary difference is recorded at ${body.asOf}, so no deferred tax is recognised. The register is ` +
        `empty rather than nil by measurement.`,
    ...body,
  };
}

/**
 * The two notes a ledger can never write.
 *
 * Both are about things that are NOT in the accounts — an event after the
 * reporting date, an obligation not yet recognised — so there is no derivation
 * that could produce them and no honest way to leave them out. An absent note
 * would read as "nothing to disclose", which is a representation only a
 * preparer can make. So they are returned in full, marked as needing an
 * answer, with the questions written out.
 */
function requiresInputNotes(
  n: number,
  to: string,
  provisions: { contingentLiabilities: number; contingentAssets: number; number: number },
): RequiresInputNote[] {
  // The provisions register already holds contingencies, so asking for them
  // again as though the question had never been put would invite a preparer
  // either to repeat them or to assume they were covered. The question stays —
  // a register holding some contingencies is not a register holding all of
  // them — but it now says what is already disclosed and where.
  const held = (count: number) =>
    count === 0
      ? ""
      : ` ${count} ${count === 1 ? "is" : "are"} already on the provisions register and disclosed in note ` +
        `${provisions.number}; this asks about anything the register does not hold.`;

  return [
    {
      number: n,
      key: "events_after_the_reporting_period",
      title: "Events after the reporting period",
      basis: "IAS 10.19, IAS 10.21, IAS 10.17",
      state: "requires_input",
      statement:
        `Nothing here can be derived. The ledger records what happened up to ${to}; this note is about what has ` +
        `happened since, and about whether any of it changes the figures above. An empty note would say "there ` +
        `were none", which is a statement only the preparer can make.`,
      requires: [
        {
          key: "adjusting_events",
          question: `Has anything come to light since ${to} that provides evidence of a condition that already existed at that date — a customer's insolvency, a court decision, a stock valuation?`,
          basis: "IAS 10.8, IAS 10.9",
        },
        {
          key: "non_adjusting_events",
          question: `Has anything material happened since ${to} that arose after it — a major acquisition or disposal, a fire, a dividend declared, a change in tax rates?`,
          basis: "IAS 10.10, IAS 10.21, IAS 10.22",
        },
        {
          key: "going_concern",
          question: "Is there any intention or necessity to liquidate the entity or to cease trading?",
          basis: "IAS 10.14, IAS 1.25",
        },
        {
          key: "authorisation_date",
          question: "On what date were these financial statements authorised for issue, and by whom?",
          basis: "IAS 10.17",
        },
      ],
    },
    {
      number: n + 1,
      key: "commitments_and_contingencies",
      title: "Commitments and contingencies",
      basis: "IAS 37.86, IAS 37.89, IAS 16.74(c), IFRS 16.59(b)",
      state: "requires_input",
      statement:
        "Nothing here can be derived either. A commitment is by definition an obligation that has not yet been " +
        "recognised, so it leaves no trace in the ledger — which is exactly why the standard asks for it to be " +
        "disclosed. Lease commitments already recognised are in the leases note; everything below is not.",
      requires: [
        {
          key: "capital_commitments",
          question: "What capital expenditure has been contracted for but not provided in these accounts?",
          basis: "IAS 16.74(c)",
        },
        {
          key: "guarantees",
          question: "Has the entity given any guarantee, indemnity or letter of support, and for how much?",
          basis: "IAS 37.86, IFRS 7.B10",
        },
        {
          key: "contingent_liabilities",
          question:
            "Is there any litigation, claim or assessment outstanding, and what is the possible obligation?" +
            held(provisions.contingentLiabilities),
          basis: "IAS 37.86",
        },
        {
          key: "contingent_assets",
          question:
            "Is there any contingent asset whose inflow of benefits is probable?" +
            held(provisions.contingentAssets),
          basis: "IAS 37.89",
        },
        {
          key: "lease_commitments",
          question: "Are there leases committed to but not yet commenced, or short-term lease commitments differing from the current charge?",
          basis: "IFRS 16.59(b)(ii), IFRS 16.55",
        },
      ],
    },
  ];
}

/* ------------------------------------------------------------------- entry */

async function buildNotes(ctx: Context, statement: StatementOfChangesInEquity): Promise<Note[]> {
  const [assets, revaluations, leases, ar, ap, allowance, provisions, deferredTax, relatedParties] = await Promise.all([
    assetRegister({ orgId: ctx.orgId, entityId: ctx.entityId }),
    revaluationRegister({ orgId: ctx.orgId, entityId: ctx.entityId }),
    leaseRegister({ orgId: ctx.orgId, entityId: ctx.entityId }),
    receivablesAgeing({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.year.endsOn }),
    payablesAgeing({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.year.endsOn }),
    // No rates are passed, so the matrix in the note is the product's default
    // one. The pack has nowhere to take a preparer's rates from — they are
    // entered on the allowance screen and recorded on the entry they produced
    // — and the note says which of the two it used rather than implying the
    // figure is this entity's measured loss experience.
    allowanceView({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.year.endsOn }),
    provisionNote({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.to }),
    deferredTaxNote({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.to }),
    relatedPartyDisclosure({
      orgId: ctx.orgId,
      entityId: ctx.entityId,
      // The period a compensation figure or an attestation was declared for is
      // the fiscal year, which is also the period this whole pack covers.
      period: ctx.year.label,
      from: ctx.from,
      to: ctx.to,
    }),
  ]);

  const notes: Note[] = [];
  notes.push(accountingPolicies(ctx, 1, assets.assets.length, leases.leases.length));
  notes.push(ppeNote(ctx, 2, assets, revaluationEventsIn(ctx, revaluations)));
  notes.push(intangiblesNote(ctx, 3, assets));
  notes.push(leaseNote(ctx, 4, leases));
  notes.push(receivablesPayablesNote(ctx, 5, ar, ap));
  // Directly after the receivables it measures, because a reader who has just
  // seen the gross ageing is the reader asking how much of it will arrive.
  notes.push(creditRiskNote(ctx, 6, allowance));
  notes.push(revenueNote(ctx, 7));
  notes.push(relatedPartyNote(ctx, 8, statement, relatedParties));
  const provisionsNoteNumber = 9;
  notes.push(provisionsNote(provisionsNoteNumber, provisions));
  notes.push(await taxNote(ctx, 10, BigInt(statement.profitForThePeriodMinor)));
  notes.push(deferredTaxPackNote(11, deferredTax));
  notes.push(statutoryReserveNote(ctx, 12, statement));
  notes.push(...requiresInputNotes(13, ctx.to, {
    contingentLiabilities: provisions.contingentLiabilities.length,
    contingentAssets: provisions.contingentAssets.length,
    number: provisionsNoteNumber,
  }));
  return notes;
}

/** The fiscal years this entity's ledger holds, newest first. */
export async function fiscalYearsFor(opts: { orgId: string; entityId: string }): Promise<FiscalYearRef[]> {
  const years = await prisma.fiscalYear.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { startsOn: "desc" },
    select: { label: true, startsOn: true, endsOn: true, status: true },
  });
  return years.map((y) => ({
    label: y.label,
    startsOn: isoDay(y.startsOn),
    endsOn: isoDay(y.endsOn),
    status: y.status,
  }));
}

/** The statement of changes in equity for one fiscal year. */
export async function changesInEquity(opts: {
  orgId: string;
  entityId: string;
  fiscalYear: string;
}): Promise<StatementOfChangesInEquity> {
  return buildStatement(await context(opts));
}

/** The notes to the financial statements for one fiscal year. */
export async function notesToTheAccounts(opts: {
  orgId: string;
  entityId: string;
  fiscalYear: string;
}): Promise<Note[]> {
  const ctx = await context(opts);
  return buildNotes(ctx, buildStatement(ctx));
}

/**
 * Both together, from one read of the year — which is why they are produced by
 * one call rather than by two that could each read a different ledger.
 */
export async function equityAndNotes(opts: {
  orgId: string;
  entityId: string;
  /** Fiscal year label. Absent means the most recent year the ledger holds. */
  fiscalYear?: string;
}): Promise<EquityAndNotes> {
  const availableYears = await fiscalYearsFor(opts);
  if (availableYears.length === 0) {
    throw new LedgerError(
      "No fiscal year has been opened for this entity, so there is no reporting period to draw a statement of " +
        "changes in equity for.",
    );
  }
  const label = opts.fiscalYear ?? availableYears[0].label;
  const ctx = await context({ orgId: opts.orgId, entityId: opts.entityId, fiscalYear: label });
  const statement = buildStatement(ctx);
  const notes = await buildNotes(ctx, statement);

  return {
    fiscalYear: ctx.year.label,
    from: ctx.from,
    to: ctx.to,
    currency: ctx.currency,
    availableYears,
    statement,
    notes,
  };
}
