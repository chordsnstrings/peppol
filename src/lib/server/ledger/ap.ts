import { prisma } from "@/lib/server/prisma";
import { post, LedgerError, type PostLine } from "./post";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

/**
 * The accounts-payable subledger — the buyer side.
 *
 * This half is the one everyone skips, and it is the half the law actually
 * compels: under MD 243/2025 a taxable person must receive and process
 * electronic invoices, not merely issue them. A business that can send but not
 * receive is only half compliant, and it is also the half where the money
 * leaks — a duplicated supplier invoice is a payment made twice.
 *
 * The shape of a purchase entry:
 *
 *   Dr  6xxx  Expense (or 1200 Inventory)   net
 *   Dr  1350  VAT input (recoverable)       the tax you can reclaim
 *     Cr  2000  Trade payables                gross (what you owe)
 *
 * Reverse charge is different, and getting it wrong is the commonest UAE VAT
 * error. On an imported service the supplier charges no VAT; the buyer accounts
 * for both sides itself, so the same amount is booked as output tax *and* as
 * recoverable input tax. It is cash-neutral when fully recoverable, and it must
 * still appear on both boxes of the return — omitting it is an understatement
 * of output tax even though nothing was ever paid across.
 */

/** Where a purchase lands, absent a supplier- or product-level override. */
const EXPENSE_BY_PROFILE: Record<TaxProfileCode, string> = {
  STANDARD_5: "6900",
  ZERO_EXPORT: "6900",
  ZERO_OTHER: "6900",
  EXEMPT: "6900",
  OUT_OF_SCOPE: "6900",
  REVERSE_CHARGE: "6250",   // typically imported professional services
  DESIGNATED_ZONE: "6900",
  MARGIN_SCHEME: "6900",
};

const AP_CONTROL = "2000";
const VAT_INPUT = "1350";
const VAT_OUTPUT = "2100";
const INVENTORY = "1200";
const FX_GAIN = "4950";
const FX_LOSS = "6800";

function minor(v: number | undefined, what: string): bigint {
  const n = v ?? 0;
  if (!Number.isInteger(n)) throw new LedgerError(`${what} must be in whole minor units, got ${n}.`);
  return BigInt(n);
}

/** Reverse charge means the buyer self-accounts; no VAT was on the supplier's bill. */
const isReverseCharge = (l: InvoiceLine) => l.taxProfileCode === "REVERSE_CHARGE";

function expenseByAccount(lines: InvoiceLine[], accountFor?: (l: InvoiceLine) => string | undefined) {
  const out = new Map<string, { net: bigint; taxCode: TaxProfileCode }>();
  for (const l of lines) {
    const account = accountFor?.(l) ?? EXPENSE_BY_PROFILE[l.taxProfileCode] ?? "6900";
    const net = minor(l.lineNetMinor, `Line ${l.lineNo} net`);
    const prev = out.get(account);
    // A caller can code two differently-taxed lines to one account. The first
    // treatment wins the tag, and the reverse-charge total is computed from the
    // document rather than from these buckets, so the return stays right.
    out.set(account, prev ? { net: prev.net + net, taxCode: prev.taxCode } : { net, taxCode: l.taxProfileCode });
  }
  return out;
}

export interface PostBillResult {
  entryId: string;
  reference: string;
  alreadyPosted: boolean;
  /** Self-accounted VAT on this bill, if any — it belongs on both return boxes. */
  reverseChargeMinor: string;
}

/**
 * Post a supplier bill or supplier credit note.
 *
 * `accountFor` lets a caller route a line to inventory or a specific expense
 * account (from a product record, a supplier default, or a coding rule). The
 * default routes everything to other operating expenses, which is honest: a
 * bill nobody has coded is not evidence about which cost centre it belongs to.
 */
export async function postBill(opts: {
  orgId: string;
  bill: Invoice;
  /** Route a line to its real account — inventory, or a specific expense. */
  accountFor?: (line: InvoiceLine) => string | undefined;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<PostBillResult> {
  const { bill, orgId } = opts;

  if (bill.direction !== "INBOUND") {
    throw new LedgerError("Only a purchase invoice posts through the payables subledger.");
  }

  const externalKey = `bill:${bill.id}`;
  const existing = await prisma.journalEntry.findFirst({
    where: { orgId, externalKey },
    select: { id: true, series: true, number: true },
  });
  if (existing) {
    return {
      entryId: existing.id, reference: `${existing.series}-${existing.number}`,
      alreadyPosted: true, reverseChargeMinor: "0",
    };
  }

  const isCredit = bill.docType === "TAX_CREDIT_NOTE";
  const sign = isCredit ? -1n : 1n;

  const gross = minor(bill.totals.payableMinor, "Bill total") * sign;
  // Split the tax: what the supplier charged (reclaimable input) against what
  // we have to self-account for (both sides, no cash).
  const chargedVat =
    minor(bill.lines.filter((l) => !isReverseCharge(l)).reduce((a, l) => a + (l.lineVatMinor ?? 0), 0), "VAT") * sign;
  const reverseChargeNet =
    minor(bill.lines.filter(isReverseCharge).reduce((a, l) => a + l.lineNetMinor, 0), "Reverse-charge net") * sign;

  const expenses = expenseByAccount(bill.lines, opts.accountFor);
  const netTotal = [...expenses.values()].reduce((a, e) => a + e.net, 0n) * sign;

  if (netTotal + chargedVat !== gross) {
    throw new LedgerError(
      `Bill ${bill.number} does not add up: lines total ${netTotal + chargedVat} but the payable amount is ${gross}. ` +
        `Check the document before posting it.`,
    );
  }

  const currency = bill.currency || "AED";
  const fxRate = currency === "AED" ? undefined : Number(bill.fx?.rateToAED ?? 0);
  if (fxRate !== undefined && !(fxRate > 0)) {
    throw new LedgerError(
      `Bill ${bill.number} is in ${currency} but carries no exchange rate to AED. ` +
        `Set the rate before posting it.`,
    );
  }
  const fx = fxRate === undefined ? {} : { currency, fxRate };

  const lines: PostLine[] = [];
  for (const [account, e] of expenses) {
    const amount = e.net * sign;
    if (amount === 0n) continue;
    lines.push({
      account, ...(amount > 0n ? { debit: amount } : { credit: -amount }), ...fx,
      taxCode: e.taxCode,
    });
  }

  if (chargedVat !== 0n) {
    lines.push({
      account: VAT_INPUT,
      ...(chargedVat > 0n ? { debit: chargedVat } : { credit: -chargedVat }),
      ...fx,
      memo: "Recoverable input VAT",
      taxCode: "INPUT_VAT",
    });
  }

  lines.push({
    account: AP_CONTROL,
    ...(gross > 0n ? { credit: gross } : { debit: -gross }),
    ...fx,
    memo: `${bill.seller?.nameEn ?? "Supplier"} — ${bill.number}`,
  });

  // Reverse charge: both sides at the standard rate, netting to nothing in
  // cash but appearing on both boxes of the VAT return. Booked in the
  // functional currency because it is a tax computation, not a supplier balance.
  const rcVat = (reverseChargeNet * 5n) / 100n;
  if (rcVat !== 0n) {
    lines.push({
      account: VAT_OUTPUT,
      ...(rcVat > 0n ? { credit: rcVat } : { debit: -rcVat }),
      memo: "Reverse charge — output side",
      taxCode: "RC_OUTPUT_VAT",
    });
    lines.push({
      account: VAT_INPUT,
      ...(rcVat > 0n ? { debit: rcVat } : { credit: -rcVat }),
      memo: "Reverse charge — recoverable side",
      taxCode: "RC_INPUT_VAT",
    });
  }

  const entry = await post({
    orgId,
    entityId: bill.entityId,
    entryDate: bill.issueDate,
    memo: `${isCredit ? "Supplier credit" : "Bill"} ${bill.number} — ${bill.seller?.nameEn ?? "supplier"}`,
    source: "bill",
    sourceType: bill.docType,
    sourceId: bill.id,
    externalKey,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "PI",
    lines,
  });

  return {
    entryId: entry.id, reference: `${entry.series}-${entry.number}`,
    alreadyPosted: false, reverseChargeMinor: rcVat.toString(),
  };
}

/**
 * Pay a supplier.
 *
 *   Dr  2000  Trade payables    what we no longer owe
 *     Cr  1010  Bank              what left the account
 */
export async function postSupplierPayment(opts: {
  orgId: string;
  entityId: string;
  billId: string;
  billNumber: string;
  paymentId: string;
  paidOn: Date | string;
  /** What actually left the bank, in the functional currency. */
  bankAmountMinor: number | bigint;
  /** What the payable carried this settlement at, in the functional currency. */
  clearedAmountMinor?: number | bigint;
  bankAccount?: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<{ entryId: string; reference: string; alreadyPosted: boolean }> {
  const externalKey = `supplier-payment:${opts.paymentId}`;
  const existing = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey },
    select: { id: true, series: true, number: true },
  });
  if (existing) return { entryId: existing.id, reference: `${existing.series}-${existing.number}`, alreadyPosted: true };

  const bank = BigInt(opts.bankAmountMinor);
  const cleared = opts.clearedAmountMinor === undefined ? bank : BigInt(opts.clearedAmountMinor);
  if (bank <= 0n) throw new LedgerError("A supplier payment has to be a positive amount.");

  const lines: PostLine[] = [
    { account: AP_CONTROL, debit: cleared, memo: `Settles ${opts.billNumber}` },
    { account: opts.bankAccount ?? "1010", credit: bank, memo: `Payment for ${opts.billNumber}` },
  ];

  // Paying less than the payable carried is a gain; paying more is a loss.
  const diff = cleared - bank;
  if (diff > 0n) lines.push({ account: FX_GAIN, credit: diff, memo: "Realised exchange difference" });
  if (diff < 0n) lines.push({ account: FX_LOSS, debit: -diff, memo: "Realised exchange difference" });

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: opts.paidOn,
    memo: `Payment — ${opts.billNumber}`,
    source: "payment",
    sourceType: "SUPPLIER_PAYMENT",
    sourceId: opts.paymentId,
    settlesId: opts.billId,
    externalKey,
    actorType: opts.actorType ?? "INTEGRATION",
    actorId: opts.actorId,
    series: "CP",
    lines,
  });

  return { entryId: entry.id, reference: `${entry.series}-${entry.number}`, alreadyPosted: false };
}

/** Payables ageing — the same open-item netting as receivables, other way up. */
export async function payablesAgeing(opts: { orgId: string; entityId: string; asOf?: Date }) {
  const asOf = opts.asOf ?? new Date();
  const account = await prisma.account.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: AP_CONTROL },
  });
  if (!account) throw new LedgerError("The payables control account does not exist for this entity.");

  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: account.id,
      entry: { orgId: opts.orgId, status: { in: ["posted", "reversed"] }, entryDate: { lte: asOf } },
    },
    include: {
      entry: { select: { entryDate: true, sourceId: true, settlesId: true, sourceType: true, memo: true, source: true } },
    },
    orderBy: { entry: { entryDate: "asc" } },
  });

  const byDoc = new Map<string, { memo: string; date: Date; outstanding: bigint; opened: boolean }>();
  for (const l of lines) {
    const key = l.entry.settlesId ?? l.entry.sourceId ?? l.id;
    const opensItem = l.entry.source === "bill";
    const prev = byDoc.get(key);
    if (prev) {
      prev.outstanding += l.functionalAmountMinor;
      if (opensItem && !prev.opened) { prev.memo = l.entry.memo ?? prev.memo; prev.date = l.entry.entryDate; prev.opened = true; }
    } else {
      byDoc.set(key, { memo: l.entry.memo ?? "", date: l.entry.entryDate, outstanding: l.functionalAmountMinor, opened: opensItem });
    }
  }

  const buckets = { current: 0n, d30: 0n, d60: 0n, d90: 0n, d90plus: 0n };
  const open: { sourceId: string; memo: string; date: string; outstandingMinor: string; daysOld: number }[] = [];
  for (const [sourceId, row] of byDoc) {
    if (row.outstanding === 0n) continue;
    const days = Math.floor((asOf.getTime() - row.date.getTime()) / 86_400_000);
    const bucket = days <= 30 ? "current" : days <= 60 ? "d30" : days <= 90 ? "d60" : days <= 120 ? "d90" : "d90plus";
    // Payables sit on the credit side, so the ledger holds them negative.
    // The report shows what is owed as a positive figure.
    buckets[bucket] += -row.outstanding;
    open.push({ sourceId, memo: row.memo, date: row.date.toISOString().slice(0, 10), outstandingMinor: (-row.outstanding).toString(), daysOld: days });
  }

  open.sort((a, b) => b.daysOld - a.daysOld);
  return {
    asOf: asOf.toISOString().slice(0, 10),
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.toString()])),
    totalMinor: Object.values(buckets).reduce((a, b) => a + b, 0n).toString(),
    open,
  };
}

export { INVENTORY as INVENTORY_ACCOUNT };
