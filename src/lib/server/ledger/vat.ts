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
}

export interface VatReturn {
  entityId: string;
  periodFrom: string;
  periodTo: string;
  currency: string;
  sales: VatBox[];
  expenses: VatBox[];
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
  { box: "4", label: "Zero rated supplies", codes: ["ZERO_EXPORT", "ZERO_OTHER", "DESIGNATED_ZONE"] },
  { box: "5", label: "Exempt supplies", codes: ["EXEMPT"] },
];

const EXPENSE_BOXES: { box: string; label: string; codes: string[] }[] = [
  { box: "9", label: "Standard rated expenses", codes: ["STANDARD_5"] },
  { box: "10", label: "Supplies subject to the reverse charge provisions", codes: ["REVERSE_CHARGE"] },
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
      entry: { select: { source: true, entryDate: true, memo: true } },
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

  // Reverse-charge supplies carry their own tax; standard-rated sales carry the
  // output tax the invoice charged.
  const sales: VatBox[] = SALES_BOXES.map((b) => {
    const amount = sum(b.codes, salesByCode);
    return {
      box: b.box, label: b.label, amountMinor: amount.toString(),
      // Only boxes that carry tax report a VAT figure; a zero-rated box
      // reporting "0.00" reads as a computation, an empty one as a fact.
      vatMinor: b.box === "1" ? outputVatOnSales(lines).toString() : b.box === "3" ? rcOutputVat(lines).toString() : null,
    };
  });

  const expenses: VatBox[] = EXPENSE_BOXES.map((b) => {
    const amount = sum(b.codes, expensesByCode);
    return {
      box: b.box, label: b.label, amountMinor: amount.toString(),
      vatMinor: b.box === "9" ? chargedInputVat(lines).toString() : rcInputVat(lines).toString(),
    };
  });

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

  return {
    entityId: opts.entityId,
    periodFrom: opts.from,
    periodTo: opts.to,
    currency: book.functionalCurrency,
    sales,
    expenses,
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

const outputVatOnSales = (l: TaggedLine[]) => byCode(l, "OUTPUT_VAT", true);
const rcOutputVat = (l: TaggedLine[]) => byCode(l, "RC_OUTPUT_VAT", true);
const chargedInputVat = (l: TaggedLine[]) => byCode(l, "INPUT_VAT", false);
const rcInputVat = (l: TaggedLine[]) => byCode(l, "RC_INPUT_VAT", false);
