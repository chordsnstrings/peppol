import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";

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

export interface VatReturn {
  entityId: string;
  periodFrom: string;
  periodTo: string;
  currency: string;
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

/** Sales treatments that belong in each box of the return. */
const SALES_BOXES: { box: string; label: string; codes: string[] }[] = [
  { box: "1", label: "Standard rated supplies", codes: ["STANDARD_5"] },
  { box: "3", label: "Supplies subject to the reverse charge provisions", codes: ["REVERSE_CHARGE"] },
  // Zero rated, and only zero rated. A zero-rated supply is IN the scope of UAE
  // VAT at a rate of nothing; an out-of-scope supply is not in the scope at all.
  // The FTA reads box 4 as the first of those, so anything out of scope in it is
  // an overstatement of the taxable supplies the business declares it made.
  { box: "4", label: "Zero rated supplies", codes: ["ZERO_EXPORT", "ZERO_OTHER"] },
  { box: "5", label: "Exempt supplies", codes: ["EXEMPT"] },
];

const EXPENSE_BOXES: { box: string; label: string; codes: string[] }[] = [
  { box: "9", label: "Standard rated expenses", codes: ["STANDARD_5"] },
  { box: "10", label: "Supplies subject to the reverse charge provisions", codes: ["REVERSE_CHARGE"] },
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

const OUTPUT_TAX_CODES = ["OUTPUT_VAT", "RC_OUTPUT_VAT"];
const INPUT_TAX_CODES = ["INPUT_VAT", "RC_INPUT_VAT"];

export async function vatReturn(opts: {
  orgId: string;
  entityId: string;
  /** Inclusive, ISO dates. A UAE return period is a month or a quarter. */
  from: string;
  to: string;
}): Promise<VatReturn> {
  const from = new Date(opts.from);
  const to = new Date(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new LedgerError("A return needs a valid start and end date.");
  }
  if (to < from) throw new LedgerError("The return period ends before it starts.");

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
  let outputVat = 0n;
  let inputVat = 0n;
  const untagged: string[] = [];

  for (const l of lines) {
    const code = l.taxCode;
    const amount = l.functionalAmountMinor;

    if (code && OUTPUT_TAX_CODES.includes(code)) { outputVat += -amount; continue; }
    if (code && INPUT_TAX_CODES.includes(code)) { inputVat += amount; continue; }

    if (l.account.type === "INCOME") {
      if (!code) { untagged.push(`${l.account.code} on ${l.entry.entryDate.toISOString().slice(0, 10)}`); continue; }
      salesByCode.set(code, (salesByCode.get(code) ?? 0n) + -amount);
    } else if (l.account.type === "EXPENSE" || l.account.code === "1200") {
      // Stock bought for resale is an input for VAT even though it lands on the
      // balance sheet, so inventory purchases belong in box 9 with the rest.
      if (!code) continue; // an uncoded expense is simply outside the return
      expensesByCode.set(code, (expensesByCode.get(code) ?? 0n) + amount);
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

  // Reverse-charge supplies carry their own tax; standard-rated sales carry the
  // output tax the invoice charged.
  const sales: VatBox[] = SALES_BOXES.map((b) => {
    const amount = sum(b.codes, salesByCode);
    return {
      box: b.box, label: b.label, amountMinor: amount.toString(),
      // Only boxes that carry tax report a VAT figure; a zero-rated box
      // reporting "0.00" reads as a computation, an empty one as a fact.
      vatMinor: b.box === "1" ? outputVatOnSales(lines).toString() : b.box === "3" ? rcOutputVat(lines).toString() : null,
      adjustmentMinor: BOXES_WITH_AN_ADJUSTMENT_COLUMN.has(b.box) ? "0" : null,
    };
  });

  const expenses: VatBox[] = EXPENSE_BOXES.map((b) => {
    const amount = sum(b.codes, expensesByCode);
    return {
      box: b.box, label: b.label, amountMinor: amount.toString(),
      vatMinor: b.box === "9" ? inputVatOnExpenses.toString() : rcInputVat(lines).toString(),
      adjustmentMinor: !BOXES_WITH_AN_ADJUSTMENT_COLUMN.has(b.box)
        ? null
        : b.box === "9"
          ? capitalAssetAdjustment.toString()
          : "0",
    };
  });

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
  if (marginScheme !== 0n) {
    warnings.push(
      `${marginScheme} of supplies are coded to the profit margin scheme and carry no output tax in the ledger. ` +
        `Tax under the scheme is 5/105 of the margin on each item (Article 29 of Federal Decree-Law 8/2017, ` +
        `Article 43 of the Executive Regulation), and the invoice shows no tax, so nothing was posted to 2100. ` +
        `Work out the tax on each margin, post it, and check box 1 before you file.`,
    );
  }

  return {
    entityId: opts.entityId,
    periodFrom: opts.from,
    periodTo: opts.to,
    currency: book.functionalCurrency,
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

const outputVatOnSales = (l: TaggedLine[]) => byCode(l, "OUTPUT_VAT", true);
const rcOutputVat = (l: TaggedLine[]) => byCode(l, "RC_OUTPUT_VAT", true);
const chargedInputVat = (l: TaggedLine[]) => byCode(l, "INPUT_VAT", false);
const rcInputVat = (l: TaggedLine[]) => byCode(l, "RC_INPUT_VAT", false);
