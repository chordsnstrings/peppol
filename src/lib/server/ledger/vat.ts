import { prisma } from "@/lib/server/prisma";
import { EMIRATES } from "@/lib/domain/peppol";
import { LedgerError } from "./post";
import { filingFor, getRegistration, taxPeriodFor, ASSUMED_RULE } from "./tax-periods";
import { MARGIN_TAX_MEMO } from "./ar";

/**
 * The FTA VAT 201 return, computed from the general ledger.
 *
 * The important design decision here is that the return is derived from the
 * same journal lines as the trial balance, grouped by the tax treatment each
 * line was raised under. The alternative — walking the invoices a second time —
 * produces a number that can disagree with the books, and "why does your return
 * not match your ledger" is the first question an FTA audit asks.
 *
 * Because both come from one source, the return can check itself: the output
 * tax it reports must equal the movement on account 2100, and the input tax
 * must equal the movement on 1350. Those reconciliations are returned alongside
 * the figures rather than asserted quietly, so a discrepancy is visible on the
 * screen rather than discovered by an auditor.
 *
 * This computes the return. It does not file it — filing is an act a human
 * takes, on figures they have looked at.
 */

/** VAT 201 box numbers, as the FTA labels them. */
export interface VatBox {
  box: string;
  label: string;
  /** The net value of supplies or expenses in the box. */
  amountMinor: string;
  /** The VAT on them, where the box carries one. */
  vatMinor: string | null;
  /**
   * The FTA's separate "Adjustment" column, where the box has one.
   *
   * An adjustment is tax that belongs to the period without a supply behind it
   * in the period — the capital assets scheme is the case this product posts.
   * It has its own column on the form precisely because putting it in the VAT
   * column would show tax against a net value nobody supplied.
   *
   * `null` means this product does not report an adjustment column for the box.
   * That is not the same as the FTA's form not having one: see the note on
   * `BOXES_WITH_AN_ADJUSTMENT_COLUMN` below.
   */
  adjustmentMinor: string | null;
}

/** A treatment that belongs on no box of the return, with the reason. */
export interface OutsideTheReturn {
  taxCode: string;
  label: string;
  amountMinor: string;
  note: string;
}

/**
 * The tax period this return covers, where the entity's registration is
 * recorded and therefore known.
 *
 * A return is filed for a tax period, not for a span of dates somebody chose.
 * Until the registration existed the product could only take the caller's word
 * for the dates, so a business on the FTA's February stagger was handed a
 * calendar quarter and a deadline a month late by every screen that asked. This
 * says which period the figures are actually for, and whether the dates asked
 * for were that period.
 */
export interface TaxPeriodOnReturn {
  label: string;
  from: string;
  to: string;
  /** Article 64 of the Executive Regulation: the 28th day after the period ends. */
  dueOn: string;
  /** False where the caller asked for dates that are not this registration's period. */
  matchesRequest: boolean;
  /** When a filing has been recorded against the period. Null is "not recorded", not "not filed". */
  filedOn: string | null;
}

export interface VatReturn {
  entityId: string;
  periodFrom: string;
  periodTo: string;
  currency: string;
  /**
   * Null where no registration is recorded — which is every entity that
   * existed before registrations did. The figures are then exactly the dates
   * the caller asked for, and the return says nothing it cannot know.
   */
  taxPeriod: TaxPeriodOnReturn | null;
  sales: VatBox[];
  expenses: VatBox[];
  /**
   * Supplies that reached the books with a treatment that belongs on no box.
   * Reported rather than dropped: a figure the return does not carry is still a
   * figure somebody has to be able to see, and the alternative — folding it
   * into the nearest box — is how box 4 came to be overstated.
   */
  outsideTheReturn: OutsideTheReturn[];
  totalOutputVatMinor: string;
  totalInputVatMinor: string;
  /** Positive: payable to the FTA. Negative: reclaimable from them. */
  netVatMinor: string;
  payable: boolean;
  /** Proof the return agrees with the books it came from. */
  reconciliation: {
    outputVatPerLedgerMinor: string;
    inputVatPerLedgerMinor: string;
    outputMatches: boolean;
    inputMatches: boolean;
  };
  /** Anything that would make this return wrong if filed as it stands. */
  warnings: string[];
  /**
   * Corrections in this period to returns already filed (Tax Procedures Law
   * Article 10). The population, never a verdict — see `voluntaryDisclosure`.
   */
  voluntaryDisclosure: VoluntaryDisclosure;
}

/** One reversal in this period of an entry that belongs to a filed return. */
export interface FiledPeriodCorrection {
  /** The reversing entry, as it appears in the ledger. */
  reference: string;
  entryDate: string;
  /** The entry it reversed, and the period that entry belongs to. */
  originalReference: string;
  originalDate: string;
  originalPeriodLabel: string;
  /** When that period's return was filed, where a filing is recorded. */
  filedOn: string | null;
  outputVatMinor: string;
  inputVatMinor: string;
  /** The effect on the tax due for the ORIGINAL period. Positive: more was due. */
  netMinor: string;
}

export interface VoluntaryDisclosure {
  /** AED 10,000 — Article 10(1) of Federal Decree-Law 28/2022. */
  thresholdMinor: string;
  /** True where the books are not kept in AED, so the threshold is not directly comparable. */
  currencyDiffers: boolean;
  corrections: FiledPeriodCorrection[];
  /** Article 10 measures the error PER RETURN, so the corrections are grouped by the period they belong to. */
  byPeriod: {
    label: string;
    filedOn: string | null;
    netMinor: string;
    overThreshold: boolean;
    corrections: number;
  }[];
  largestMinor: string;
  note: string;
}

/**
 * Box 1 of the VAT 201 is seven rows, not one.
 *
 * The form splits standard-rated supplies between the seven emirates because
 * the tax collected on them is distributed between the emirates on that basis —
 * the split is not presentational, it decides where the money ends up. So the
 * return carries the seven rows the form carries, in the order the form lists
 * them, and each is a box in its own right.
 *
 * The codes are the ones an address carries (`EMIRATES` in `domain/peppol.ts`),
 * which is what `JournalLine.taxEmirate` is stamped with when an invoice posts.
 */
const EMIRATE_BOXES: { box: string; code: string }[] = [
  { box: "1a", code: "AZ" },
  { box: "1b", code: "DU" },
  { box: "1c", code: "SH" },
  { box: "1d", code: "AJ" },
  { box: "1e", code: "UQ" },
  { box: "1f", code: "RK" },
  { box: "1g", code: "FU" },
];

/**
 * The row for standard-rated supplies whose emirate the ledger does not hold.
 *
 * There is no such box on the FTA's form, and that is the point: the figure has
 * to go on one of the seven before the return can be filed, and nothing here
 * knows which. Spreading it across the emirates in proportion to the rest would
 * be arithmetic presented as a decision, and it would move real money between
 * real emirates. So it is shown, named, and left for somebody to attribute.
 */
const UNATTRIBUTED_BOX = "1x";

const EMIRATE_NAMES = new Map(EMIRATES.map((e) => [e.code, e.name]));
/** The full name as well as the code, because a hand-keyed address carries either. */
const EMIRATE_CODE_BY_NAME = new Map(EMIRATES.map((e) => [e.name.toUpperCase(), e.code]));

/**
 * Which of the seven a line's stamped emirate is, or null for the unattributed
 * row. An unrecognised value is not silently made into one of the seven — it is
 * reported, because a typo that lands in Ajman is a typo that sends Ajman
 * money.
 */
function emirateOf(raw: string | null, unrecognised: Set<string>): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const upper = value.toUpperCase();
  if (EMIRATE_NAMES.has(upper)) return upper;
  const byName = EMIRATE_CODE_BY_NAME.get(upper);
  if (byName) return byName;
  unrecognised.add(value);
  return null;
}

/** Sales treatments that belong in each box of the return. */
const SALES_BOXES: { box: string; label: string; codes: string[] }[] = [
  { box: "3", label: "Supplies subject to the reverse charge provisions", codes: ["REVERSE_CHARGE"] },
  // Zero rated, and only zero rated. A zero-rated supply is IN the scope of UAE
  // VAT at a rate of nothing; an out-of-scope supply is not in the scope at all.
  // The FTA reads box 4 as the first of those, so anything out of scope in it is
  // an overstatement of the taxable supplies the business declares it made.
  { box: "4", label: "Zero rated supplies", codes: ["ZERO_EXPORT", "ZERO_OTHER"] },
  { box: "5", label: "Exempt supplies", codes: ["EXEMPT"] },
];

/**
 * Boxes this product reports an Adjustment column for.
 *
 * Box 9 is here because this product posts an adjustment into it: a capital
 * asset adjustment (Executive Regulation Articles 57-58, posted by
 * `vat-schemes.ts`) is input tax on 1350 with no expense of its own, and its own
 * comment says the FTA expects it "inside the input tax boxes rather than beside
 * them". Carrying it in box 9's VAT column would show recoverable tax against a
 * net value of expenses nobody incurred this period; it has a column of its own
 * on the form for exactly that reason.
 *
 * The real VAT 201 carries an Adjustment column on more boxes than this one.
 * Which ones cannot be established from anything in this codebase — no module,
 * comment or test here states the form's layout — and this product posts no
 * adjustment into any other box, so none is invented. A box not listed here
 * reports `adjustmentMinor: null`, which says "not reported", not "nil".
 */
const BOXES_WITH_AN_ADJUSTMENT_COLUMN = new Set(["9"]);

/**
 * Entries whose tax lines are adjustments rather than tax on a supply of the
 * period. `vat-schemes.ts` stamps one of these on every capital asset posting
 * it makes — the yearly interval assessment and the catch-up on disposal — and
 * that stamp is what lets an adjustment be told apart here without the return
 * being taught anything about capital assets.
 *
 * A source type not on this list is treated as tax on a supply. That is the
 * safe way round: it puts an unrecognised posting in the column beside its own
 * net value rather than into a column that claims it has no supply behind it.
 */
const ADJUSTMENT_SOURCE_TYPES = new Set(["CAPITAL_ASSET_ADJUSTMENT", "CAPITAL_ASSET_DISPOSAL"]);

/**
 * Treatments that reach the ledger but belong on no box of the VAT 201, and the
 * reason each one does not.
 *
 * DESIGNATED_ZONE stays a single code covering the supply of goods, and a
 * designated-zone supply of services is coded to the standard rate like any
 * other standard-rated supply. The alternative — a second profile, say
 * DESIGNATED_ZONE_SERVICES, sitting in box 1 — was rejected because
 * `designatedZoneTreatment()` in `vat-schemes.ts` already resolves a services
 * supply in a zone to the STANDARD_5 profile. Adding a second code for the same
 * treatment would give the same supply two spellings, and a bookkeeper who
 * picked the zone-flavoured one would be back where this started: a
 * standard-rated supply sitting under a code the eye reads as a zone relief.
 * One code, one meaning, and the goods/services question answered by the person
 * who knows it rather than by a rate table that cannot.
 */
const OUTSIDE_THE_BOXES: { code: string; label: string; note: string }[] = [
  {
    code: "DESIGNATED_ZONE",
    label: "Supplies of goods in or between designated zones",
    note:
      "Article 51 of Federal Decree-Law 8/2017 and Article 51 of the Executive Regulation treat a designated zone " +
      "as outside the State for GOODS, so a supply of goods there is outside the scope of UAE VAT and belongs on " +
      "no box of the return — not box 4, which is for zero-rated supplies, and those are in scope at a rate of " +
      "nothing. Services are the other way round: the place of supply of services in a designated zone is inside " +
      "the State, so a designated-zone supply of SERVICES is standard rated and must be coded to the standard rate " +
      "to reach box 1. Nothing in a tax code says whether a supply is of goods or of services, so this figure is " +
      "reported here rather than guessed into a box. Check that no services are sitting in it.",
  },
  {
    code: "OUT_OF_SCOPE",
    label: "Out-of-scope supplies",
    note:
      "Outside UAE VAT altogether, so on no box of the return. The value is shown so that revenue in the books can " +
      "be tied to the return without a residue nobody can account for.",
  },
];

/**
 * Boxes 6 and 7 — goods imported into the UAE, and adjustments to them.
 *
 * Article 48 of Federal Decree-Law 8/2017 puts the tax on an import of goods on
 * the importer rather than on the overseas seller: the importer declares the
 * output tax itself and recovers the same amount as input tax, so it is
 * cash-neutral where the input tax is recoverable in full. On the form box 6
 * carries the value of the goods and the tax on them, box 7 carries the
 * adjustments to what box 6 said, and the recovery is claimed in box 10 with
 * the rest of the reverse-charge input tax.
 *
 * The FTA pre-populates box 6 from the customs declarations filed against the
 * importer's TRN and does not let it be edited — box 7 is the only channel for
 * a correction to it, which is why the two are separate boxes here rather than
 * one figure. Coding an import as an ordinary reverse charge instead would
 * double-count against that pre-populated figure; coding it as an ordinary
 * expense leaves box 6 with no matching recovery. Neither could be patched by
 * hand afterwards, because 2100 and 1350 refuse a manual journal.
 *
 * These are the tax codes an import posting carries. They are distinct from the
 * reverse-charge pair on purpose: the two mechanisms are the same arithmetic
 * and different boxes, and a shared code could not be told apart afterwards.
 */
const IMPORT_OUTPUT_TAX_CODE = "IMPORT_OUTPUT_VAT";
const IMPORT_INPUT_TAX_CODE = "IMPORT_INPUT_VAT";
/** The treatment stamped on the goods themselves, as `IMPORT_GOODS` in `domain/tax.ts`. */
const IMPORT_GOODS_CODE = "IMPORT_GOODS";

/**
 * An entry stamped with this restates an earlier import rather than reporting a
 * new one, so its figures belong in box 7 and not in box 6 — box 6 is the
 * customs figure and is not editable.
 */
const IMPORT_ADJUSTMENT_SOURCE_TYPE = "IMPORT_ADJUSTMENT";

const OUTPUT_TAX_CODES = ["OUTPUT_VAT", "RC_OUTPUT_VAT", IMPORT_OUTPUT_TAX_CODE];
const INPUT_TAX_CODES = ["INPUT_VAT", "RC_INPUT_VAT", IMPORT_INPUT_TAX_CODE];

export async function vatReturn(opts: {
  orgId: string;
  entityId: string;
  /** Inclusive, ISO dates. A UAE return period is a month or a quarter. */
  from: string;
  to: string;
}): Promise<VatReturn> {
  let from = new Date(opts.from);
  let to = new Date(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new LedgerError("A return needs a valid start and end date.");
  }
  if (to < from) throw new LedgerError("The return period ends before it starts.");

  /*
   * The registration's own period wins over the caller's dates.
   *
   * A return covers a tax period the FTA assigned, and the dates a screen or a
   * reminder happens to pass are at best a guess at it. Where the registration
   * is recorded, the period containing the requested start date is the period
   * computed — so a quarterly registrant on the February stagger gets
   * December-to-February rather than the calendar quarter three callers used to
   * assume, and the deadline that goes with it. Where no registration is
   * recorded — every entity that existed before they did — the caller's dates
   * are used exactly as given and the return claims nothing about periods.
   */
  const registration = await getRegistration({ orgId: opts.orgId, entityId: opts.entityId, regime: "VAT" });
  let taxPeriod: TaxPeriodOnReturn | null = null;
  if (registration) {
    const period = taxPeriodFor(registration, opts.from);
    const matchesRequest = period.from === opts.from.slice(0, 10) && period.to === opts.to.slice(0, 10);
    if (!matchesRequest) {
      from = new Date(period.from);
      to = new Date(period.to);
    }
    const filing = await filingFor({
      orgId: opts.orgId,
      entityId: opts.entityId,
      regime: "VAT",
      periodLabel: period.label,
    });
    taxPeriod = { ...period, matchesRequest, filedOn: filing?.filedOn ?? null };
  }
  const periodFrom = taxPeriod ? taxPeriod.from : opts.from;
  const periodTo = taxPeriod ? taxPeriod.to : opts.to;

  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
  });
  if (!book) throw new LedgerError("No ledger has been opened for this entity.");

  /*
   * The lines the return can possibly report, and no others.
   *
   * This used to read every line posted in the quarter and discard most of
   * them: the loop below acts on a line's tax code, and the bank, receivables
   * and payables sides of every invoice and every receipt carry none. On a
   * ledger of any size that is a whole quarter dragged through the connection
   * to be thrown away — while `@@index([orgId, taxCode])` sat unused, put on
   * the table for exactly this read.
   *
   * Three kinds of line are kept, and each is one the return would be wrong
   * without:
   *
   *  - anything carrying a tax code, which is every figure on every box;
   *  - revenue carrying none, because a supply with no treatment is missing
   *    from the return and the warning that says so is counted from these;
   *  - anything on 2100 or 1350, because the reconciliation below is only
   *    worth having if it can see a posting on the control accounts that
   *    carries no tax code at all. Narrowing to coded lines alone would make
   *    output tax and account 2100 agree by construction, which is the one
   *    thing that check exists to disprove.
   *
   * An expense with no tax code is genuinely outside the return — the loop
   * skips it — so it is the one thing not read.
   */
  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      entry: {
        entityId: opts.entityId,
        // A reversed entry's lines are real postings and the reversing entry
        // offsets them. Counting only "posted" drops the original and keeps
        // the reversal, which leaves NEGATIVE output tax on the return — an
        // understatement that reads as a legitimate credit.
        status: { in: ["posted", "reversed"] },
        entryDate: { gte: from, lte: to },
      },
      OR: [
        { taxCode: { not: null } },
        { account: { type: "INCOME" } },
        { account: { code: { in: [VAT_OUTPUT_ACCOUNT, VAT_INPUT_ACCOUNT] } } },
      ],
    },
    include: {
      account: { select: { code: true, type: true } },
      // `sourceType` is what separates an adjustment from tax on a supply. It
      // is on the entry rather than the line because it is a fact about why the
      // whole posting was made.
      entry: { select: { source: true, sourceType: true, entryDate: true, memo: true } },
    },
  });

  // Group by treatment. Revenue sits on the credit side and expenses on the
  // debit side, so both are reported as positive amounts on the return.
  const salesByCode = new Map<string, bigint>();
  const expensesByCode = new Map<string, bigint>();
  /** Standard-rated supplies and their tax, split the way box 1 is split. */
  const standardRatedByEmirate = new Map<string, bigint>();
  const outputVatByEmirate = new Map<string, bigint>();
  let unattributedSupplies = 0n;
  let unattributedOutputVat = 0n;
  const unrecognisedEmirates = new Set<string>();
  /** The part of the imported goods that restates an earlier import — box 7. */
  let importAdjustmentNet = 0n;
  let outputVat = 0n;
  let inputVat = 0n;
  /**
   * Output tax the business owes out of its own margin rather than tax it
   * charged a customer.
   *
   * Both sit on 2100 under OUTPUT_VAT, because on the return they are the same
   * liability — so the line's memo is what tells them apart, and `ar.ts` writes
   * it from a constant this reads. It is counted only to answer one question:
   * whether the margin supplies below have had their tax worked out at all.
   */
  let marginOutputVat = 0n;
  const untagged: string[] = [];

  for (const l of lines) {
    const code = l.taxCode;
    const amount = l.functionalAmountMinor;

    if (code && OUTPUT_TAX_CODES.includes(code)) {
      outputVat += -amount;
      if (l.memo === MARGIN_TAX_MEMO) marginOutputVat += -amount;
      // Only the tax on ordinary standard-rated sales is split by emirate. The
      // reverse-charge and import output tax belong to boxes of their own,
      // which the form does not split.
      if (code === "OUTPUT_VAT") {
        const emirate = emirateOf(l.taxEmirate, unrecognisedEmirates);
        if (emirate) outputVatByEmirate.set(emirate, (outputVatByEmirate.get(emirate) ?? 0n) + -amount);
        else unattributedOutputVat += -amount;
      }
      continue;
    }
    if (code && INPUT_TAX_CODES.includes(code)) { inputVat += amount; continue; }

    if (l.account.type === "INCOME") {
      if (!code) { untagged.push(`${l.account.code} on ${l.entry.entryDate.toISOString().slice(0, 10)}`); continue; }
      salesByCode.set(code, (salesByCode.get(code) ?? 0n) + -amount);
      if (code === "STANDARD_5") {
        const emirate = emirateOf(l.taxEmirate, unrecognisedEmirates);
        if (emirate) {
          standardRatedByEmirate.set(emirate, (standardRatedByEmirate.get(emirate) ?? 0n) + -amount);
        } else {
          unattributedSupplies += -amount;
        }
      }
    } else if (l.account.type === "EXPENSE" || l.account.code === "1200") {
      // Stock bought for resale is an input for VAT even though it lands on the
      // balance sheet, so inventory purchases belong in box 9 with the rest.
      if (!code) continue; // an uncoded expense is simply outside the return
      expensesByCode.set(code, (expensesByCode.get(code) ?? 0n) + amount);
      if (code === IMPORT_GOODS_CODE && l.entry.sourceType === IMPORT_ADJUSTMENT_SOURCE_TYPE) {
        importAdjustmentNet += amount;
      }
    }
  }

  const sum = (codes: string[], m: Map<string, bigint>) =>
    codes.reduce((a, c) => a + (m.get(c) ?? 0n), 0n);

  // Input tax split the way the form splits it: tax charged on this period's
  // expenses in the VAT column, and tax adjusted for a period long closed in the
  // Adjustment column beside it. The two still add to the same total — this
  // changes where the figure is written, not what it is.
  const capitalAssetAdjustment = chargedInputVat(lines.filter(isAdjustment));
  const inputVatOnExpenses = chargedInputVat(lines.filter((l) => !isAdjustment(l)));

  /*
   * Imports, split into the box that is pre-populated and the box that
   * corrects it. The FTA fills box 6 from the customs declarations against the
   * importer's TRN, so a restatement of an earlier import cannot go there and
   * has to go in box 7 — which is exactly what the source type on the entry
   * says the posting was.
   */
  const importAdjustmentLines = lines.filter(
    (l) => l.entry.sourceType === IMPORT_ADJUSTMENT_SOURCE_TYPE,
  );
  const importGoodsLines = lines.filter(
    (l) => l.entry.sourceType !== IMPORT_ADJUSTMENT_SOURCE_TYPE,
  );
  const importNetTotal = expensesByCode.get(IMPORT_GOODS_CODE) ?? 0n;
  const importNet = importNetTotal - importAdjustmentNet;
  const importOutputVat = byCode(importGoodsLines, IMPORT_OUTPUT_TAX_CODE, true);
  const importAdjustmentOutputVat = byCode(importAdjustmentLines, IMPORT_OUTPUT_TAX_CODE, true);
  const importInputVat = byCode(lines, IMPORT_INPUT_TAX_CODE, false);

  // Reverse-charge supplies carry their own tax; standard-rated sales carry the
  // output tax the invoice charged, split between the emirates the way the form
  // splits it.
  const emirateRows: VatBox[] = EMIRATE_BOXES.map((e) => ({
    box: e.box,
    label: `Standard rated supplies in ${EMIRATE_NAMES.get(e.code) ?? e.code}`,
    amountMinor: (standardRatedByEmirate.get(e.code) ?? 0n).toString(),
    vatMinor: (outputVatByEmirate.get(e.code) ?? 0n).toString(),
    adjustmentMinor: null,
  }));

  const sales: VatBox[] = [
    ...emirateRows,
    {
      box: UNATTRIBUTED_BOX,
      label: "Standard rated supplies with no emirate recorded",
      amountMinor: unattributedSupplies.toString(),
      vatMinor: unattributedOutputVat.toString(),
      adjustmentMinor: null,
    },
    ...SALES_BOXES.map((b) => ({
      box: b.box,
      label: b.label,
      amountMinor: sum(b.codes, salesByCode).toString(),
      // Only boxes that carry tax report a VAT figure; a zero-rated box
      // reporting "0.00" reads as a computation, an empty one as a fact.
      vatMinor: b.box === "3" ? rcOutputVat(lines).toString() : null,
      adjustmentMinor: BOXES_WITH_AN_ADJUSTMENT_COLUMN.has(b.box) ? "0" : null,
    })),
    {
      box: "6",
      label: "Goods imported into the UAE",
      amountMinor: importNet.toString(),
      vatMinor: importOutputVat.toString(),
      adjustmentMinor: null,
    },
    {
      box: "7",
      label: "Adjustments to goods imported into the UAE",
      amountMinor: importAdjustmentNet.toString(),
      vatMinor: importAdjustmentOutputVat.toString(),
      adjustmentMinor: null,
    },
  ];

  const expenses: VatBox[] = [
    {
      box: "9",
      label: "Standard rated expenses",
      amountMinor: (expensesByCode.get("STANDARD_5") ?? 0n).toString(),
      vatMinor: inputVatOnExpenses.toString(),
      adjustmentMinor: capitalAssetAdjustment.toString(),
    },
    {
      box: "10",
      label: "Supplies subject to the reverse charge provisions",
      // The imported goods appear here as well as in boxes 6 and 7, and that
      // is not a double count: boxes 6 and 7 are the output side of the same
      // transaction and this is where the FTA's own guidance has the importer
      // claim the input tax back. Reverse-charge services work the same way
      // across boxes 3 and 10.
      amountMinor: ((expensesByCode.get("REVERSE_CHARGE") ?? 0n) + importNetTotal).toString(),
      vatMinor: (rcInputVat(lines) + importInputVat).toString(),
      adjustmentMinor: null,
    },
  ];

  const outsideTheReturn: OutsideTheReturn[] = OUTSIDE_THE_BOXES.map((o) => ({
    taxCode: o.code,
    label: o.label,
    amountMinor: (salesByCode.get(o.code) ?? 0n).toString(),
    note: o.note,
  }));

  // Reconcile against the control accounts. These are the same lines, summed a
  // different way, so a mismatch means a coding gap rather than an arithmetic
  // error — and it is worth surfacing either way.
  const ledgerOutput = lines
    .filter((l) => l.account.code === VAT_OUTPUT_ACCOUNT)
    .reduce((a, l) => a + -l.functionalAmountMinor, 0n);
  const ledgerInput = lines
    .filter((l) => l.account.code === VAT_INPUT_ACCOUNT)
    .reduce((a, l) => a + l.functionalAmountMinor, 0n);

  const net = outputVat - inputVat;
  const warnings: string[] = [];
  if (untagged.length) {
    warnings.push(
      `${untagged.length} revenue posting${untagged.length === 1 ? "" : "s"} carry no tax treatment and are missing ` +
        `from this return (${untagged.slice(0, 3).join(", ")}${untagged.length > 3 ? ", …" : ""}). ` +
        `They were most likely posted as manual journals rather than through an invoice.`,
    );
  }
  if (outputVat !== ledgerOutput) {
    warnings.push(
      `Output tax on this return (${outputVat}) does not match account 2100 (${ledgerOutput}). ` +
        `Do not file until this is explained.`,
    );
  }
  if (inputVat !== ledgerInput) {
    warnings.push(
      `Input tax on this return (${inputVat}) does not match account 1350 (${ledgerInput}). ` +
        `Do not file until this is explained.`,
    );
  }
  // A margin-scheme supply IS a taxable supply and belongs in box 1, but the
  // tax on it is 5/105 of the margin (Article 29 of Federal Decree-Law 8/2017,
  // Article 43 of the Executive Regulation) and the invoice states no tax, so
  // nothing reaches account 2100 when it posts. The return can see the supply
  // and cannot see the margin — the purchase price of the goods is on the
  // document, not in the ledger — so it says so rather than reporting a nil.
  const marginScheme = salesByCode.get("MARGIN_SCHEME") ?? 0n;
  if (marginScheme !== 0n && marginOutputVat === 0n) {
    // Conditioned on the tax actually being absent. The purchase price can now
    // be entered on the line, and where it has been, `postInvoice` works the
    // tax out and posts it out of revenue — so warning on the presence of
    // margin supplies alone would cry wolf on every correctly handled period,
    // which is how a return's warnings stop being read.
    warnings.push(
      `${marginScheme} of supplies are coded to the profit margin scheme and no tax on the margin has been ` +
        `posted. Tax under the scheme is 5/105 of the margin on each item (Article 29 of Federal Decree-Law ` +
        `8/2017, Article 43 of the Executive Regulation). It is worked out from what the goods cost, which is ` +
        `entered on the invoice line — a line with no purchase price against it produces no tax, and none was ` +
        `posted. Add it to those lines and repost before you file.`,
    );
  }
  // Box 1 is distributed between the emirates because the tax on it is, so a
  // figure with no emirate against it is a figure that cannot be filed. Said
  // plainly rather than spread across the seven rows in proportion to the
  // rest: that would be arithmetic presented as a decision, and it would move
  // real money between real emirates.
  if (unattributedSupplies !== 0n || unattributedOutputVat !== 0n) {
    warnings.push(
      `${unattributedSupplies} of standard-rated supplies, bearing ${unattributedOutputVat} of output tax, carry ` +
        `no emirate and are on none of the seven rows of box 1. The VAT 201 splits box 1 between the emirates ` +
        `because the tax is distributed between them on that basis, so this has to be attributed to one of them ` +
        `before the return is filed. It has not been spread across the others. The emirate is taken from the ` +
        `selling establishment's address when an invoice posts — set it in the entity's settings and supplies ` +
        `raised from then on carry it.`,
    );
  }
  if (unrecognisedEmirates.size) {
    warnings.push(
      `${[...unrecognisedEmirates].sort().join(", ")} ${unrecognisedEmirates.size === 1 ? "is not an emirate" : "are not emirates"} ` +
        `this ledger recognises, so the supplies carrying ${unrecognisedEmirates.size === 1 ? "it" : "them"} are ` +
        `in the unattributed row rather than in one of the seven. Use the two-letter codes: ` +
        `${EMIRATE_BOXES.map((e) => e.code).join(", ")}.`,
    );
  }
  // Goods coded as an import with no self-accounted tax behind them. Under
  // Article 48 the importer owes the output tax whether or not anybody posted
  // it, and box 6 with a value and no tax is a box the FTA's pre-populated
  // figure will contradict.
  if (importNetTotal !== 0n && importOutputVat + importAdjustmentOutputVat === 0n) {
    warnings.push(
      `${importNetTotal} of goods are coded as imported into the UAE and no import tax has been accounted for ` +
        `on them. Article 48 of Federal Decree-Law 8/2017 puts that tax on the importer, and box 6 is ` +
        `pre-populated by the FTA from the customs declarations against your TRN — so a box 6 with a value and ` +
        `no tax will not agree with theirs.`,
    );
  }
  if (taxPeriod && !taxPeriod.matchesRequest) {
    warnings.push(
      `${opts.from} to ${opts.to} is not a tax period of this registration, so this return covers ` +
        `${taxPeriod.label} — ${taxPeriod.from} to ${taxPeriod.to} — which is the period the FTA assigned. ` +
        `It falls due on ${taxPeriod.dueOn}, the 28th day after it ended (Article 64 of the Executive Regulation).`,
    );
  }

  const voluntaryDisclosure = await correctionsToFiledPeriods({
    orgId: opts.orgId,
    entityId: opts.entityId,
    from,
    to,
    currency: book.functionalCurrency,
  });
  if (voluntaryDisclosure.byPeriod.some((p) => p.overThreshold)) {
    const over = voluntaryDisclosure.byPeriod.filter((p) => p.overThreshold);
    warnings.push(
      `Entries belonging to ${over.length === 1 ? "a return" : `${over.length} returns`} already filed ` +
        `(${over.map((p) => p.label).join(", ")}) were reversed in this period, moving the tax due for ` +
        `${over.length === 1 ? "it" : "them"} by more than ${VOLUNTARY_DISCLOSURE_THRESHOLD_AED_MINOR / 100_000n} ` +
        `thousand dirhams. Article 10 of Federal Decree-Law 28/2022 requires a voluntary disclosure within 20 ` +
        `business days of becoming aware of an error above AED 10,000 in a filed return, and a correction is not ` +
        `made by putting it through the current return. This is the population, not a verdict: the ledger cannot ` +
        `tell an error from a legitimate credit note under Articles 61 and 62, and it does not know when anybody ` +
        `became aware of anything. Look at each one.`,
    );
  }

  return {
    entityId: opts.entityId,
    periodFrom,
    periodTo,
    currency: book.functionalCurrency,
    taxPeriod,
    sales,
    expenses,
    outsideTheReturn,
    totalOutputVatMinor: outputVat.toString(),
    totalInputVatMinor: inputVat.toString(),
    netVatMinor: net.toString(),
    payable: net >= 0n,
    reconciliation: {
      outputVatPerLedgerMinor: ledgerOutput.toString(),
      inputVatPerLedgerMinor: ledgerInput.toString(),
      outputMatches: outputVat === ledgerOutput,
      inputMatches: inputVat === ledgerInput,
    },
    warnings,
    voluntaryDisclosure,
  };
}

/** AED 10,000, in fils. Article 10(1) of Federal Decree-Law 28/2022. */
export const VOLUNTARY_DISCLOSURE_THRESHOLD_AED_MINOR = 1_000_000n;

/**
 * Corrections made in this period to returns that have already been filed.
 *
 * `reverse()` refuses a closed period, so a correction to a filed quarter
 * necessarily lands in an open one and flows into the CURRENT return as
 * ordinary movement. Nothing measured its size, compared it to the Article 10
 * threshold, or said that a correction to a filed return is a voluntary
 * disclosure rather than a line on the next one. The tax was quietly moved from
 * the period it belonged to into the period somebody noticed, which is exactly
 * what Article 10 exists to stop.
 *
 * Three decisions, all of which matter.
 *
 * WHAT COUNTS AS FILED. A recorded filing, first: `tax-periods.ts` holds the
 * date each return went, and that is a fact rather than an inference. Where no
 * filing is recorded the period lock is the proxy — the same proxy `attention.ts`
 * runs its 28-day statutory clock off, so the "we cannot know what was filed"
 * defence does not apply to one and not the other. A period that is neither
 * filed nor closed is not treated as filed, because a correction to a return
 * nobody has sent is just bookkeeping.
 *
 * WHAT COUNTS AS THE ERROR. Article 10 measures per RETURN, not in aggregate,
 * so the corrections are grouped by the period the ORIGINAL entry belongs to
 * and each group is tested on its own. Two errors of six thousand in different
 * quarters are two errors under the threshold; the same two in one quarter are
 * one above it.
 *
 * WHAT THIS WILL NOT SAY. Whether a reversal is an error. The ledger cannot
 * tell a mistake from a legitimate credit note under Articles 61 and 62, and it
 * cannot know when anybody became aware of anything, so it cannot start the
 * 20-business-day clock. It reports the population and names the test. A
 * product that guessed here would be wrong in the direction that costs somebody
 * a penalty.
 */
export async function correctionsToFiledPeriods(opts: {
  orgId: string;
  entityId: string;
  from: Date;
  to: Date;
  currency: string;
}): Promise<VoluntaryDisclosure> {
  const currencyDiffers = opts.currency !== "AED";
  const empty: VoluntaryDisclosure = {
    thresholdMinor: VOLUNTARY_DISCLOSURE_THRESHOLD_AED_MINOR.toString(),
    currencyDiffers,
    corrections: [],
    byPeriod: [],
    largestMinor: "0",
    note:
      "No entry belonging to a filed return was reversed in this period, so nothing here calls for a voluntary " +
      "disclosure under Article 10.",
  };

  // Reversals posted in this period that touch the VAT accounts. A reversal is
  // identified by the link the ledger already keeps, not by its memo.
  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      account: { code: { in: [VAT_OUTPUT_ACCOUNT, VAT_INPUT_ACCOUNT] }, entityId: opts.entityId },
      entry: {
        entityId: opts.entityId,
        status: { in: ["posted", "reversed"] },
        entryDate: { gte: opts.from, lte: opts.to },
        reversalOfId: { not: null },
      },
    },
    include: {
      account: { select: { code: true } },
      entry: { select: { id: true, series: true, number: true, entryDate: true, reversalOfId: true } },
    },
  });
  if (lines.length === 0) return empty;

  const originalIds = [...new Set(lines.map((l) => l.entry.reversalOfId).filter((v): v is string => v !== null))];
  const originals = await prisma.journalEntry.findMany({
    where: { id: { in: originalIds } },
    select: { id: true, series: true, number: true, entryDate: true, periodId: true },
  });
  const originalById = new Map(originals.map((o) => [o.id, o]));

  const periods = await prisma.accountingPeriod.findMany({
    where: { id: { in: [...new Set(originals.map((o) => o.periodId))] } },
    select: { id: true, label: true, status: true },
  });
  const periodById = new Map(periods.map((p) => [p.id, p]));

  const registration = await getRegistration({ orgId: opts.orgId, entityId: opts.entityId, regime: "VAT" });
  const rule = registration
    ? { frequency: registration.frequency, firstPeriodEndMonth: registration.firstPeriodEndMonth }
    : ASSUMED_RULE;

  /** One row per reversing entry, with its two VAT sides netted. */
  const byEntry = new Map<string, { output: bigint; input: bigint; entry: (typeof lines)[number]["entry"] }>();
  for (const l of lines) {
    const g = byEntry.get(l.entry.id) ?? { output: 0n, input: 0n, entry: l.entry };
    if (l.account.code === VAT_OUTPUT_ACCOUNT) g.output += -l.functionalAmountMinor;
    else g.input += l.functionalAmountMinor;
    byEntry.set(l.entry.id, g);
  }

  const filedOnCache = new Map<string, string | null>();
  const corrections: FiledPeriodCorrection[] = [];

  for (const g of byEntry.values()) {
    const original = g.entry.reversalOfId ? originalById.get(g.entry.reversalOfId) : undefined;
    if (!original) continue;

    // The tax period the ORIGINAL belongs to, on this registration's stagger.
    const taxPeriod = taxPeriodFor(rule, original.entryDate);

    let filedOn = filedOnCache.get(taxPeriod.label);
    if (filedOn === undefined) {
      const filing = await filingFor({
        orgId: opts.orgId, entityId: opts.entityId, regime: "VAT", periodLabel: taxPeriod.label,
      });
      filedOn = filing?.filedOn ?? null;
      filedOnCache.set(taxPeriod.label, filedOn);
    }

    // Filed, or closed behind itself — the same proxy the attention list uses.
    const locked = periodById.get(original.periodId)?.status;
    const treatAsFiled = filedOn !== null || locked === "hard_closed" || locked === "soft_closed";
    if (!treatAsFiled) continue;

    corrections.push({
      reference: `${g.entry.series}-${g.entry.number}`,
      entryDate: g.entry.entryDate.toISOString().slice(0, 10),
      originalReference: `${original.series}-${original.number}`,
      originalDate: original.entryDate.toISOString().slice(0, 10),
      originalPeriodLabel: taxPeriod.label,
      filedOn,
      outputVatMinor: g.output.toString(),
      inputVatMinor: g.input.toString(),
      // The tax due for the original period moves by output less input, the
      // same arithmetic the return itself uses.
      netMinor: (g.output - g.input).toString(),
    });
  }

  if (corrections.length === 0) return empty;

  const grouped = new Map<string, { filedOn: string | null; net: bigint; count: number }>();
  for (const c of corrections) {
    const g = grouped.get(c.originalPeriodLabel) ?? { filedOn: c.filedOn, net: 0n, count: 0 };
    g.net += BigInt(c.netMinor);
    g.count += 1;
    grouped.set(c.originalPeriodLabel, g);
  }

  const byPeriod = [...grouped.entries()]
    .map(([label, g]) => {
      const size = g.net < 0n ? -g.net : g.net;
      return {
        label,
        filedOn: g.filedOn,
        netMinor: g.net.toString(),
        // Size, not sign. Tax overpaid by twelve thousand is as much a
        // correction to a filed return as tax underpaid by it.
        overThreshold: size > VOLUNTARY_DISCLOSURE_THRESHOLD_AED_MINOR,
        corrections: g.count,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const largest = byPeriod.reduce((m, p) => {
    const size = BigInt(p.netMinor) < 0n ? -BigInt(p.netMinor) : BigInt(p.netMinor);
    return size > m ? size : m;
  }, 0n);

  return {
    thresholdMinor: VOLUNTARY_DISCLOSURE_THRESHOLD_AED_MINOR.toString(),
    currencyDiffers,
    corrections: corrections.sort((a, b) => a.originalDate.localeCompare(b.originalDate)),
    byPeriod,
    largestMinor: largest.toString(),
    note:
      `${corrections.length} ${corrections.length === 1 ? "entry" : "entries"} belonging to ` +
      `${byPeriod.length === 1 ? "a return" : `${byPeriod.length} returns`} already filed ` +
      `${corrections.length === 1 ? "was" : "were"} reversed in this period. Article 10 of Federal Decree-Law ` +
      `28/2022 asks for a voluntary disclosure within 20 business days of becoming aware of an error above ` +
      `AED 10,000 in a filed return; below that the correction goes on the next return. Which of these is an ` +
      `error and which is a credit note under Articles 61 or 62 is not something the ledger can tell, and it does ` +
      `not know when anybody became aware of anything — so this is the list to look at, not an answer.` +
      (currencyDiffers
        ? ` These books are kept in ${opts.currency}; the threshold is AED 10,000 and the figures below are not ` +
          `directly comparable to it.`
        : ""),
  };
}

const VAT_OUTPUT_ACCOUNT = "2100";
const VAT_INPUT_ACCOUNT = "1350";

type TaggedLine = { taxCode: string | null; functionalAmountMinor: bigint };
const byCode = (lines: TaggedLine[], code: string, credit: boolean) =>
  lines.filter((l) => l.taxCode === code).reduce((a, l) => a + (credit ? -l.functionalAmountMinor : l.functionalAmountMinor), 0n);

/** Whether a line's tax belongs in an Adjustment column rather than a VAT one. */
const isAdjustment = (l: { entry: { sourceType: string | null } }) =>
  l.entry.sourceType !== null && ADJUSTMENT_SOURCE_TYPES.has(l.entry.sourceType);

const rcOutputVat = (l: TaggedLine[]) => byCode(l, "RC_OUTPUT_VAT", true);
const chargedInputVat = (l: TaggedLine[]) => byCode(l, "INPUT_VAT", false);
const rcInputVat = (l: TaggedLine[]) => byCode(l, "RC_INPUT_VAT", false);


/* ------------------------------------------- the registration threshold --- */

/**
 * How close the business is to having to register for VAT, and whether it has
 * already passed the point where it had to.
 *
 * Article 13 of Federal Decree-Law 8/2017 makes registration compulsory once
 * the value of the supplies listed in Article 19 HAS EXCEEDED the mandatory
 * threshold over the previous 12 months, or where the business expects to
 * exceed it in the next 30 days. Three things follow from the way that is
 * written, and each of them shapes what is computed here.
 *
 * IT IS A ROLLING WINDOW, not a financial year and not a tax period. Every
 * other figure in this module is cut to a period the FTA assigned; this one is
 * measured over the twelve months ending on the day it is asked about, which is
 * why it cannot be read off a return. A business whose trade is seasonal can be
 * under the threshold in each of four quarters and well over it across some
 * twelve consecutive months.
 *
 * IT IS EVERY WINDOW, not only today's. The obligation is triggered on the day
 * a twelve-month window first exceeds the threshold, and a quiet year
 * afterwards does not undo it — that is what deregistration is for (Article 21),
 * and deregistering is a different application with different conditions. So
 * the ledger is walked forward over `REGISTRATION_LOOKBACK_YEARS` and the
 * first crossing is reported, whether or not the current window is above it.
 * Reporting only today's window would tell a business that had a large year and
 * a small one that nothing was required of it, which is the reassuring answer
 * and the wrong one.
 *
 * IT IS ABOUT SUPPLIES, not revenue. What counts:
 *
 *  - Taxable supplies made: standard rated, zero rated, the domestic reverse
 *    charge and the profit margin scheme. A zero-rated supply is a taxable
 *    supply at a rate of nothing and counts in full.
 *  - Concerned goods and services received — imports the business accounts for
 *    itself — which Article 19(2) puts towards the same threshold. A business
 *    that buys services from abroad can be required to register on those alone.
 *
 * And what does not, each of which is said to the reader rather than quietly
 * folded in:
 *
 *  - Exempt and out-of-scope supplies, which are not taxable supplies.
 *  - Supplies of goods in a designated zone, which Article 51 puts outside the
 *    State altogether.
 *  - The value of a supply of capital assets, which Article 20 excludes from
 *    the calculation. Nothing in the ledger tells the sale of a van from the
 *    sale of a week's stock, so where a capital asset has been sold through the
 *    revenue accounts this figure is overstated by it.
 *  - Supplies of an acquired business, and supplies of related parties where
 *    the FTA treats the separation as artificial. Neither is in these books.
 */

/** Article 3 of the Executive Regulation: the mandatory threshold, AED 375,000 in fils. */
export const MANDATORY_REGISTRATION_THRESHOLD_MINOR = 37_500_000n;

/** And the voluntary threshold, AED 187,500. Registration is a choice above it. */
export const VOLUNTARY_REGISTRATION_THRESHOLD_MINOR = 18_750_000n;

/**
 * The days there are to apply once the threshold has been crossed.
 *
 * The obligation is to register and the application is how it is discharged:
 * crossing the threshold in March is not something that can be put right by
 * applying in the autumn.
 */
export const REGISTRATION_APPLICATION_DAYS = 30;

/**
 * Treatments that are a taxable supply MADE by the business.
 *
 * `EXEMPT`, `OUT_OF_SCOPE` and `DESIGNATED_ZONE` are absent on purpose — see
 * the note above, and `OUTSIDE_THE_BOXES`, which keeps the last two off the
 * return for the same reason they are kept out of this.
 */
const TAXABLE_SUPPLY_CODES = ["STANDARD_5", "ZERO_EXPORT", "ZERO_OTHER", "REVERSE_CHARGE", "MARGIN_SCHEME"];

/**
 * ...and treatments that are goods or services RECEIVED which the business
 * accounts for itself. They are told from the supplies above by the side of the
 * ledger they land on, because `REVERSE_CHARGE` is the same code on both.
 */
const CONCERNED_SUPPLY_CODES = ["REVERSE_CHARGE", IMPORT_GOODS_CODE];

/**
 * How far back a crossing is looked for. Two years, so a business that crossed
 * during a good year and has been quiet since is still told — and bounded,
 * because this is read on a dashboard and a business that crossed before that
 * has a registration question far older than a nag list can help with.
 */
export const REGISTRATION_LOOKBACK_YEARS = 2;

export type RegistrationStanding =
  /** A registration is recorded and in force, so the threshold is not a live question. */
  | "registered"
  /**
   * Registration is required: some twelve-month window inside the lookback
   * exceeded the threshold, whether or not the current one still does.
   */
  | "over_mandatory"
  /** Within a tenth of it and never over it. Nothing is required, and one month could change that. */
  | "approaching_mandatory"
  /** Over the voluntary threshold and under the mandatory one: registering is a choice. */
  | "over_voluntary"
  | "below";

export interface RegistrationThreshold {
  entityId: string;
  /** The twelve months the current figure covers, both ends inclusive. */
  from: string;
  to: string;
  currency: string;
  /** True where a registration is recorded and has not been given up. */
  registered: boolean;
  trn: string | null;
  /**
   * The supplies in the current twelve months, and the goods and services
   * received in them, both net of credit notes and both as positive values.
   *
   * Null for a registered entity: the ledger is not read at all in that case,
   * because the threshold decides whether to register and that question has
   * been answered. Null is "not measured", which is a different statement from
   * a nil and is kept apart from one.
   */
  suppliesMinor: string | null;
  concernedMinor: string | null;
  /** The two added: the figure Article 19 tests against the threshold. */
  totalMinor: string | null;
  mandatoryMinor: string;
  voluntaryMinor: string;
  standing: RegistrationStanding;
  /**
   * The earliest day inside the lookback on which the twelve months ending
   * there exceeded the mandatory threshold. Null where no window did.
   *
   * It is the earliest day VISIBLE HERE rather than necessarily the day it
   * happened: a ledger that begins after the crossing, or a crossing older than
   * `REGISTRATION_LOOKBACK_YEARS`, cannot be shown a day it does not hold.
   */
  crossedOn: string | null;
  /** What the twelve months to `crossedOn` came to. Null where nothing crossed. */
  crossedTotalMinor: string | null;
  /** Thirty days after `crossedOn`, which is when the application had to be in. */
  applyBy: string | null;
  /**
   * True where the books are not kept in AED. The thresholds are dirham
   * figures, so the comparison is then not like for like and says so.
   */
  currencyDiffers: boolean;
}

/**
 * Midnight UTC on a day, so a window is a window rather than a moment.
 *
 * A date that is not one comes back as one that is not either, rather than
 * throwing here — the caller below turns it into a sentence somebody can read.
 */
const dayOf = (v: Date | string): Date => {
  const on = typeof v === "string" ? v : Number.isNaN(v.getTime()) ? "" : v.toISOString();
  return new Date(`${on.slice(0, 10)}T00:00:00.000Z`);
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The first day of the twelve months ending on `to`, both ends inclusive. */
const twelveMonthsTo = (to: Date) =>
  new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), to.getUTCDate() + 1));

export async function registrationThreshold(opts: {
  orgId: string;
  entityId: string;
  /** Defaults to today. Passing it makes the answer reproducible. */
  asOf?: Date | string;
}): Promise<RegistrationThreshold> {
  const to = dayOf(opts.asOf ?? new Date());
  if (Number.isNaN(to.getTime())) {
    throw new LedgerError("The registration threshold needs a valid date to be read as at.");
  }
  const from = twelveMonthsTo(to);

  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  if (!book) throw new LedgerError("No ledger has been opened for this entity.");

  const registration = await getRegistration({ orgId: opts.orgId, entityId: opts.entityId, regime: "VAT" });
  // A registration given up is not a registration in force. Deregistering does
  // not put a business outside the threshold — it puts it back on the near side
  // of it — so the watch applies again from the day it took effect.
  const registered =
    registration !== null && (registration.deregisteredOn === null || registration.deregisteredOn > isoDay(to));

  const answer = {
    entityId: opts.entityId,
    from: isoDay(from),
    to: isoDay(to),
    currency: book.functionalCurrency,
    registered,
    trn: registration?.trn ?? null,
    mandatoryMinor: MANDATORY_REGISTRATION_THRESHOLD_MINOR.toString(),
    voluntaryMinor: VOLUNTARY_REGISTRATION_THRESHOLD_MINOR.toString(),
    currencyDiffers: book.functionalCurrency !== "AED",
  };

  if (registered) {
    return {
      ...answer,
      suppliesMinor: null,
      concernedMinor: null,
      totalMinor: null,
      standing: "registered",
      crossedOn: null,
      crossedTotalMinor: null,
      applyBy: null,
    };
  }

  const earliest = new Date(
    Date.UTC(to.getUTCFullYear() - REGISTRATION_LOOKBACK_YEARS, to.getUTCMonth(), to.getUTCDate() + 1),
  );
  const rows = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      entry: {
        entityId: opts.entityId,
        // Both halves of a reversed pair, exactly as the return reads them: the
        // original was a supply and the reversal takes it back, and counting
        // one without the other leaves a cancelled supply on the threshold.
        status: { in: ["posted", "reversed"] },
        entryDate: { gte: earliest, lte: to },
      },
      // Two shapes of line, told apart by the side of the ledger they are on.
      // `@@index([orgId, taxCode])` is what makes this a read of the supplies
      // rather than a read of the ledger.
      OR: [
        { taxCode: { in: TAXABLE_SUPPLY_CODES }, account: { type: "INCOME" } },
        { taxCode: { in: CONCERNED_SUPPLY_CODES }, account: { type: { not: "INCOME" } } },
      ],
    },
    select: {
      functionalAmountMinor: true,
      account: { select: { type: true } },
      entry: { select: { entryDate: true } },
    },
  });

  // Revenue is a credit and a cost is a debit, and the threshold is a value of
  // supplies rather than a movement, so both are counted as positive amounts.
  let supplies = 0n;
  let concerned = 0n;
  const byDay = new Map<string, bigint>();
  for (const r of rows) {
    const made = r.account.type === "INCOME";
    const value = made ? -r.functionalAmountMinor : r.functionalAmountMinor;
    const on = r.entry.entryDate;
    if (on >= from) {
      if (made) supplies += value;
      else concerned += value;
    }
    const key = isoDay(on);
    byDay.set(key, (byDay.get(key) ?? 0n) + value);
  }
  const total = supplies + concerned;
  const crossing = firstCrossing(byDay);

  const standing: RegistrationStanding =
    crossing !== null
      ? "over_mandatory"
      : total * 10n >= MANDATORY_REGISTRATION_THRESHOLD_MINOR * 9n
        ? "approaching_mandatory"
        : total > VOLUNTARY_REGISTRATION_THRESHOLD_MINOR
          ? "over_voluntary"
          : "below";

  return {
    ...answer,
    suppliesMinor: supplies.toString(),
    concernedMinor: concerned.toString(),
    totalMinor: total.toString(),
    standing,
    crossedOn: crossing?.on ?? null,
    crossedTotalMinor: crossing === null ? null : crossing.total.toString(),
    applyBy:
      crossing === null
        ? null
        : isoDay(new Date(dayOf(crossing.on).getTime() + REGISTRATION_APPLICATION_DAYS * 86_400_000)),
  };
}

/**
 * The first day on which the twelve months ending there went over the
 * threshold, walking the days that carry a supply.
 *
 * Only those days need testing. The window moves with the day it is measured
 * on, so the total it holds rises only when something is supplied and otherwise
 * falls as old supplies drop out of the back of it — which means a crossing can
 * only happen on a day something was supplied.
 */
function firstCrossing(byDay: Map<string, bigint>): { on: string; total: bigint } | null {
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Two pointers over one list: `head` is the day being tested and `tail` drops
  // the supplies that have fallen out of the twelve months behind it.
  let running = 0n;
  let tail = 0;
  for (let head = 0; head < days.length; head++) {
    running += days[head][1];
    const opens = isoDay(twelveMonthsTo(dayOf(days[head][0])));
    while (tail <= head && days[tail][0] < opens) {
      running -= days[tail][1];
      tail++;
    }
    if (running > MANDATORY_REGISTRATION_THRESHOLD_MINOR) return { on: days[head][0], total: running };
  }
  return null;
}
