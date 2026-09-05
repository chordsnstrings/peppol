import { prisma } from "@/lib/server/prisma";
import { EMIRATES } from "@/lib/domain/peppol";
import { LedgerError } from "./post";
import { filingFor, getRegistration, taxPeriodFor } from "./tax-periods";
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
    .filter((l) => l.account.code === "2100")
    .reduce((a, l) => a + -l.functionalAmountMinor, 0n);
  const ledgerInput = lines
    .filter((l) => l.account.code === "1350")
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
  };
}

type TaggedLine = { taxCode: string | null; functionalAmountMinor: bigint };
const byCode = (lines: TaggedLine[], code: string, credit: boolean) =>
  lines.filter((l) => l.taxCode === code).reduce((a, l) => a + (credit ? -l.functionalAmountMinor : l.functionalAmountMinor), 0n);

/** Whether a line's tax belongs in an Adjustment column rather than a VAT one. */
const isAdjustment = (l: { entry: { sourceType: string | null } }) =>
  l.entry.sourceType !== null && ADJUSTMENT_SOURCE_TYPES.has(l.entry.sourceType);

const rcOutputVat = (l: TaggedLine[]) => byCode(l, "RC_OUTPUT_VAT", true);
const chargedInputVat = (l: TaggedLine[]) => byCode(l, "INPUT_VAT", false);
const rcInputVat = (l: TaggedLine[]) => byCode(l, "RC_INPUT_VAT", false);
