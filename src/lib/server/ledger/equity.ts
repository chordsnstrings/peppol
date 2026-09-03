import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { LedgerError } from "./post";
import { balanceSheet, type BalanceSheet } from "./statements";
import { assetRegister } from "./assets";
import { leaseRegister } from "./leases";
import { receivablesAgeing } from "./ar";
import { payablesAgeing } from "./ap";
import { corporateTaxComputation } from "./corptax";

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
const RETAINED_EARNINGS = "3900";

/**
 * Synthesised by `balanceSheet()` from the income and expense accounts, never
 * posted. It is the profit row of this statement, so it is not a column.
 */
const CURRENT_YEAR_EARNINGS = "3950";

const EQUITY_COLUMNS = [SHARE_CAPITAL, SHAREHOLDER_CURRENT, STATUTORY_RESERVE, RETAINED_EARNINGS];

/** Cash and cash equivalents, as the cash flow statement defines them. */
const CASH_CODES = ["1000", "1010", "1020", "1050"];

/** Cost of property, plant and equipment, and the contra account against it. */
const PPE_COST_CODES = ["1500", "1600"];
const ACCUM_DEPRECIATION = "1590";

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

export interface PpeNote extends NoteBase {
  key: "property_plant_and_equipment";
  costAccounts: string[];
  accumulatedDepreciationAccount: string;
  cost: {
    openingMinor: string;
    additionsMinor: string;
    disposalsMinor: string;
    closingMinor: string;
    perBalanceSheetMinor: string;
    agrees: boolean;
  };
  accumulatedDepreciation: {
    openingMinor: string;
    chargeMinor: string;
    releasedOnDisposalMinor: string;
    closingMinor: string;
    perBalanceSheetMinor: string;
    agrees: boolean;
  };
  netBookValue: { openingMinor: string; closingMinor: string };
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
  bands: AgeingBand[];
  /** The ageing report's own total. */
  totalPerAgeingMinor: string;
  /** The control account on the balance sheet, stated on its natural side. */
  totalPerLedgerMinor: string;
  agrees: boolean;
  differenceMinor: string;
  openItems: number;
  oldestDays: number | null;
}

export interface ReceivablesPayablesNote extends NoteBase {
  key: "trade_receivables_and_payables";
  receivables: AgeingDisclosure;
  payables: AgeingDisclosure;
  /** Held on 1150; a contra-asset, so it is shown as a positive deduction. */
  allowanceForDoubtfulDebtsMinor: string;
  netReceivablesMinor: string;
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
  account: { code: string; name: string; nameAr: string | null };
  openingMinor: string;
  closingMinor: string;
  movements: { key: string; label: string; amountMinor: string }[];
  postings: number;
  /** What relatedness the ledger cannot see, and a preparer must supply. */
  requiresInput: string[];
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

export interface RequiresInputNote extends NoteBase {
  key: "events_after_the_reporting_period" | "commitments_and_contingencies";
  state: "requires_input";
  /** Exactly what a preparer has to answer, one question at a time. */
  requires: { key: string; question: string; basis: string }[];
}

export type Note =
  | PolicyNote
  | PpeNote
  | LeaseNote
  | ReceivablesPayablesNote
  | RevenueNote
  | RelatedPartyNote
  | TaxNote
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
      select: { code: true, name: true, nameAr: true },
    }),
  ]);

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
    if (CASH_CODES.includes(l.code)) shape.touchesCash = true;
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
  };
}

/* --------------------------------------- the statement of changes in equity */

const ROW_ORDER: EquityRowKey[] = [
  // IAS 1.106(b) puts a retrospective restatement immediately under the
  // brought-forward figure, because everything below it is measured against
  // the restated position rather than the original one.
  "prior_period_adjustment",
  "profit_for_period",
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
  share_capital: "Capital issued or reduced on the share capital account.",
  capital_introduced:
    "Value put into the business by the shareholder through the current account, including expenses of the " +
    "business the shareholder settled personally.",
  reserve_transfer:
    "An appropriation out of retained earnings into the statutory reserve. It moves value between two columns, " +
    "so it adds to nil across the row.",
  transfer_within_equity:
    "An entry whose every line is an equity account, so it changes the composition of equity without changing " +
    "its total. A dividend credited to the shareholder's current account rather than paid is the usual case.",
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

/** The ageing bands as `ar.ts` and `ap.ts` cut them, spelled out for the note. */
const AGEING_BANDS: { key: string; label: string }[] = [
  { key: "current", label: "Not more than 30 days" },
  { key: "d31_60", label: "31 to 60 days" },
  { key: "d61_90", label: "61 to 90 days" },
  { key: "d91_120", label: "91 to 120 days" },
  { key: "over120", label: "More than 120 days" },
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
    // The methods and lives are the ones the register actually holds, not a
    // sentence about what an entity of this kind usually does.
    policies.push({
      key: "property_plant_and_equipment",
      label: "Property, plant and equipment",
      policy:
        "Property, plant and equipment is stated at cost less accumulated depreciation. Depreciation is charged " +
        "monthly over the useful life recorded for each asset, and a change in an estimate is applied " +
        "prospectively; prior periods are not restated.",
      basis: "IAS 16.30, IAS 16.73(a)-(b), IAS 8.36",
      evidence: `${registerAssets} asset${registerAssets === 1 ? "" : "s"} on the fixed asset register.`,
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
    policies.push({
      key: "trade_receivables",
      label: "Trade receivables",
      policy: has([DOUBTFUL_DEBT_ALLOWANCE])
        ? "Trade receivables are stated at the amount invoiced less an allowance for amounts considered doubtful."
        : "Trade receivables are stated at the amount invoiced. No allowance for doubtful debts has been recognised.",
      basis: "IFRS 9.5.5.15",
      evidence: has([DOUBTFUL_DEBT_ALLOWANCE])
        ? "An allowance is carried on account 1150."
        : "Account 1150 carries nothing, so no allowance is claimed.",
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

function ppeNote(ctx: Context, n: number, register: Awaited<ReturnType<typeof assetRegister>>): PpeNote {
  const cost = ctx.lines.filter((l) => PPE_COST_CODES.includes(l.code));
  const accum = ctx.lines.filter((l) => l.code === ACCUM_DEPRECIATION);

  const additions = cost.filter((l) => l.amount > 0n).reduce((a, l) => a + l.amount, 0n);
  const disposals = -cost.filter((l) => l.amount < 0n).reduce((a, l) => a + l.amount, 0n);
  const costOpening = sumOf(ctx.openingBs, PPE_COST_CODES);
  const costClosing = costOpening + additions - disposals;
  const costPerSheet = sumOf(ctx.closingBs, PPE_COST_CODES);

  // The charge is taken from the movement on 1590 rather than from the
  // depreciation expense account, because 6600 also carries the depreciation
  // of right-of-use assets, which credits 1700 and belongs in the leases note.
  const charge = -accum.filter((l) => l.amount < 0n).reduce((a, l) => a + l.amount, 0n);
  const released = accum.filter((l) => l.amount > 0n).reduce((a, l) => a + l.amount, 0n);
  const accumOpening = -balanceOf(ctx.openingBs, ACCUM_DEPRECIATION);
  const accumClosing = accumOpening + charge - released;
  const accumPerSheet = -balanceOf(ctx.closingBs, ACCUM_DEPRECIATION);

  const active = register.assets.filter((a) => a.status === "active");
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
        `${ACCUM_DEPRECIATION} in ${ctx.year.label}. The register is a second record of the same assets and is ` +
        `shown beside the ledger so the two can be compared; it is stated as it now stands rather than as at ` +
        `${ctx.to}.`
      : `The entity holds no property, plant or equipment. Accounts ${PPE_COST_CODES.join(", ")} and ` +
        `${ACCUM_DEPRECIATION} are nil at both ends of the year and the register is empty.`,
    costAccounts: PPE_COST_CODES,
    accumulatedDepreciationAccount: ACCUM_DEPRECIATION,
    cost: {
      openingMinor: costOpening.toString(),
      additionsMinor: additions.toString(),
      disposalsMinor: disposals.toString(),
      closingMinor: costClosing.toString(),
      perBalanceSheetMinor: costPerSheet.toString(),
      agrees: costClosing === costPerSheet,
    },
    accumulatedDepreciation: {
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
    .filter((l) => CASH_CODES.includes(l.code) && leaseEntry(l))
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
  };

  const anything = arLedger !== 0n || apLedger !== 0n || ar.open.length > 0 || ap.open.length > 0;

  return {
    number: n,
    key: "trade_receivables_and_payables",
    title: "Trade receivables and trade payables",
    basis: "IFRS 7.35, IFRS 7.39, IAS 1.61",
    state: anything ? "present" : "empty",
    statement: anything
      ? `Both ageings are built by netting each document down to what is still open on it, from the control ` +
        `accounts themselves. The band totals are shown against the control account balance at ${ctx.to}: if the ` +
        `two differ, the ageing has lost a document, and the difference says by how much.`
      : `Nothing is owed to the entity and nothing is owed by it at ${ctx.to}. Accounts ${TRADE_RECEIVABLES} and ` +
        `${TRADE_PAYABLES} are both nil and neither ageing carries an open item.`,
    receivables,
    payables,
    allowanceForDoubtfulDebtsMinor: allowance.toString(),
    netReceivablesMinor: (arLedger - allowance).toString(),
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

function relatedPartyNote(ctx: Context, n: number, statement: StatementOfChangesInEquity): RelatedPartyNote {
  /*
   * A ledger cannot know which parties are related.
   *
   * Relatedness under IAS 24 is a fact about people and control — a director's
   * spouse, an entity under common control, a member of key management — and
   * none of that is written down anywhere in a chart of accounts or a journal
   * line. A counterparty name is a string; it does not say whether the person
   * behind it is the owner's brother. So this note does not attempt to detect
   * related parties, because a detector would be wrong in the direction that
   * matters: it would produce a confident, incomplete list, and a reader would
   * take the silence about everyone else as a statement that there is nobody
   * else.
   *
   * The shareholder current account is the exception, and the only one. It is
   * related by construction: the account exists precisely to record what the
   * owner has put in and taken out, so every balance on it is a related party
   * balance whatever the ledger knows about anybody's name.
   */
  const opening = BigInt(statement.opening.cells[SHAREHOLDER_CURRENT] ?? "0");
  const closing = BigInt(statement.closing.cells[SHAREHOLDER_CURRENT] ?? "0");
  const movements = statement.movements
    .map((r) => ({ key: r.key, label: r.label, amountMinor: r.cells[SHAREHOLDER_CURRENT] ?? "0" }))
    .filter((m) => m.amountMinor !== "0");
  const postings = ctx.lines.filter((l) => l.code === SHAREHOLDER_CURRENT).length;

  const anything = opening !== 0n || closing !== 0n || postings > 0;

  return {
    number: n,
    key: "related_parties",
    title: "Related party balances and transactions",
    basis: "IAS 24.18, IAS 24.17",
    state: anything ? "present" : "requires_input",
    statement: anything
      ? "The shareholder current account is a related party balance by construction — it exists to record what " +
        "the owner has put into the business and taken out of it. Every other related party relationship is a " +
        "fact about people rather than about postings, and no ledger can see it, so this note is complete only " +
        "once a preparer has answered the questions below."
      : "The shareholder current account is nil and never moved in the year. That is not the same as there " +
        "being no related party transactions: relationships under IAS 24 are facts about people and control, " +
        "which no ledger holds. This note cannot be completed from the accounts alone.",
    account: {
      code: SHAREHOLDER_CURRENT,
      name: ctx.accountNames.get(SHAREHOLDER_CURRENT)?.name ?? "Shareholder current account",
      nameAr: ctx.accountNames.get(SHAREHOLDER_CURRENT)?.nameAr ?? null,
    },
    openingMinor: opening.toString(),
    closingMinor: closing.toString(),
    movements,
    postings,
    requiresInput: [
      "The identity of the entity's related parties, and the nature of each relationship (IAS 24.13, IAS 24.18).",
      "Compensation of key management personnel, in total and by category (IAS 24.17).",
      "Transactions with related parties other than the shareholder, and the terms on which they were made (IAS 24.18(b)).",
      "Whether the entity is controlled by another party, and the identity of the ultimate controlling party (IAS 24.13).",
    ],
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
 * The two notes a ledger can never write.
 *
 * Both are about things that are NOT in the accounts — an event after the
 * reporting date, an obligation not yet recognised — so there is no derivation
 * that could produce them and no honest way to leave them out. An absent note
 * would read as "nothing to disclose", which is a representation only a
 * preparer can make. So they are returned in full, marked as needing an
 * answer, with the questions written out.
 */
function requiresInputNotes(n: number, to: string): RequiresInputNote[] {
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
          question: "Is there any litigation, claim or assessment outstanding, and what is the possible obligation?",
          basis: "IAS 37.86",
        },
        {
          key: "contingent_assets",
          question: "Is there any contingent asset whose inflow of benefits is probable?",
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
  const [assets, leases, ar, ap] = await Promise.all([
    assetRegister({ orgId: ctx.orgId, entityId: ctx.entityId }),
    leaseRegister({ orgId: ctx.orgId, entityId: ctx.entityId }),
    receivablesAgeing({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.year.endsOn }),
    payablesAgeing({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.year.endsOn }),
  ]);

  const notes: Note[] = [];
  notes.push(accountingPolicies(ctx, 1, assets.assets.length, leases.leases.length));
  notes.push(ppeNote(ctx, 2, assets));
  notes.push(leaseNote(ctx, 3, leases));
  notes.push(receivablesPayablesNote(ctx, 4, ar, ap));
  notes.push(revenueNote(ctx, 5));
  notes.push(relatedPartyNote(ctx, 6, statement));
  notes.push(await taxNote(ctx, 7, BigInt(statement.profitForThePeriodMinor)));
  notes.push(...requiresInputNotes(8, ctx.to));
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
