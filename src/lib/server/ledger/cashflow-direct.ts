import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { cashFlowStatement, CASH_CODES } from "./cashflow";

/**
 * The cash flow statement by the direct method.
 *
 * IAS 7.18 permits either method; IAS 7.19 encourages this one, because
 * "receipts from customers" is a figure a reader can act on and "profit
 * adjusted for depreciation and the movement in receivables" is a figure a
 * reader has to unpick. The indirect statement in `cashflow.ts` stays — IAS
 * 7.20 asks for the reconciliation of profit to operating cash flow whichever
 * method is presented, and that reconciliation *is* the indirect statement, so
 * this module presents it alongside rather than replacing it.
 *
 * How it works, and the one place it can be wrong.
 *
 * Every movement on a cash account is a real receipt or payment. What that
 * movement was *for* is not on the cash line — it is on the other lines of the
 * same journal entry. So each cash line is attributed to the contra accounts
 * of its own entry, in proportion to their amounts.
 *
 * The proportion is where the method can mislead, and it is worth being exact
 * about when. An entry with one cash line and one contra line is unambiguous.
 * An entry with one cash line and several contra lines — a payment run
 * settling six bills, a receipt clearing an invoice and a credit note — is
 * apportioned, and the apportionment is arithmetic rather than fact. It is
 * right whenever the contra lines are all of the same character, which for a
 * payment run or a receipt they are. It is a guess when they are not: a single
 * journal that pays a supplier and buys a machine in one entry would split the
 * cash between operating and investing by amount, which happens to be correct,
 * but a journal mixing a payment with a rounding adjustment would attribute a
 * little of the rounding's character to the payment.
 *
 * Rather than hide that, `mixedEntries` counts the entries where it happened
 * and `unattributedMinor` carries the cash that could not be attributed at all
 * — an entry with no non-cash line, which is a transfer between two cash
 * accounts and belongs in neither section. Both are reported.
 *
 * The statement is proved the same way the indirect one is: the sum of every
 * attributed flow must equal the movement on the cash accounts read straight
 * from the ledger. Anything else is left visible as a difference, never
 * absorbed into a balancing line.
 */

const CASH = new Set(CASH_CODES);

/** What a receipt or payment was for. Ordered as IAS 7.18(a) lists them. */
export type DirectLine =
  | "receipts_from_customers"
  | "payments_to_suppliers"
  | "payments_to_employees"
  | "vat_paid"
  | "tax_paid"
  | "interest_paid"
  | "interest_received"
  | "other_operating"
  | "investing"
  | "financing"
  | "unattributed";

const LABELS: Record<DirectLine, string> = {
  receipts_from_customers: "Cash received from customers",
  payments_to_suppliers: "Cash paid to suppliers",
  payments_to_employees: "Cash paid to and on behalf of employees",
  vat_paid: "VAT paid to the FTA, net",
  tax_paid: "Corporate tax paid",
  interest_paid: "Interest paid",
  interest_received: "Interest received",
  other_operating: "Other operating receipts and payments",
  investing: "Investing",
  financing: "Financing",
  unattributed: "Not attributed",
};

/**
 * Which line a contra account puts the cash on.
 *
 * Prefixes rather than an exhaustive list, because the chart grows and a map
 * that has to be extended every time is a map that goes stale silently — the
 * indirect statement already has an exhaustive classification and a test that
 * fails when the chart outgrows it, and duplicating that here would mean two
 * lists to keep in step. The `code` lookup wins over the prefix, so an account
 * that is an exception can still be named.
 */
const BY_CODE: Record<string, DirectLine> = {
  "1100": "receipts_from_customers",   // trade receivables
  "1150": "receipts_from_customers",   // allowance against them
  "2000": "payments_to_suppliers",     // trade payables
  "2050": "payments_to_suppliers",     // accrued expenses
  "2060": "payments_to_suppliers",     // cheques issued
  "1060": "receipts_from_customers",   // cheques in hand
  "2100": "vat_paid",
  "1350": "vat_paid",
  "1360": "vat_paid",
  "2110": "vat_paid",
  "2120": "tax_paid",                  // corporate tax payable
  "6900": "tax_paid",                  // corporate tax charge
  "1320": "tax_paid",
  "2130": "tax_paid",
  "6700": "interest_paid",
  "4950": "other_operating",           // FX gain
  "6800": "other_operating",           // FX loss
};

const BY_PREFIX: { prefix: string; line: DirectLine }[] = [
  { prefix: "15", line: "investing" },  // property, plant and equipment
  { prefix: "16", line: "investing" },
  { prefix: "17", line: "investing" },
  { prefix: "18", line: "investing" },
  { prefix: "30", line: "financing" },  // share capital and reserves
  { prefix: "31", line: "financing" },
  { prefix: "32", line: "financing" },
  { prefix: "33", line: "financing" },
  { prefix: "34", line: "financing" },
  { prefix: "23", line: "financing" },  // borrowings
  { prefix: "24", line: "financing" },
  { prefix: "51", line: "payments_to_employees" },
  { prefix: "60", line: "payments_to_employees" },
  { prefix: "22", line: "payments_to_employees" },
  { prefix: "14", line: "payments_to_employees" },  // employee advances
  { prefix: "4", line: "receipts_from_customers" }, // revenue taken straight to cash
  { prefix: "5", line: "payments_to_suppliers" },
  { prefix: "6", line: "payments_to_suppliers" },
  { prefix: "12", line: "payments_to_suppliers" },  // inventory bought for cash
  { prefix: "13", line: "payments_to_suppliers" },
];

export function lineFor(code: string): DirectLine {
  const named = BY_CODE[code];
  if (named) return named;
  // Longest prefix wins, so 1350 beats 13 and 1500 beats 15 through BY_CODE.
  const hits = BY_PREFIX.filter((p) => code.startsWith(p.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return hits[0]?.line ?? "other_operating";
}

const OPERATING: DirectLine[] = [
  "receipts_from_customers", "payments_to_suppliers", "payments_to_employees",
  "vat_paid", "tax_paid", "interest_paid", "interest_received", "other_operating",
];

export interface DirectCashFlow {
  from: string;
  to: string;
  currency: string;
  operating: { line: DirectLine; label: string; amountMinor: bigint }[];
  netOperatingMinor: bigint;
  investingMinor: bigint;
  financingMinor: bigint;
  unattributedMinor: bigint;
  netCashMovementMinor: bigint;
  /** The same period's movement on the cash accounts, read from the ledger. */
  cashMovementPerLedgerMinor: bigint;
  reconciles: boolean;
  differenceMinor: bigint;
  /** IAS 7.20: profit reconciled to operating cash flow. The indirect statement. */
  reconciliation: {
    netOperatingIndirectMinor: bigint;
    agreesWithDirect: boolean;
    differenceMinor: bigint;
  };
  /** Entries whose cash had to be split across contra lines of differing character. */
  mixedEntries: number;
  warnings: string[];
}

/**
 * Cash flows by the direct method for a period.
 *
 * Movements are signed as they are in the ledger: a receipt is positive
 * (cash debited), a payment negative. Presenting payments as positive figures
 * under a "payments" heading is a convention this deliberately does not adopt
 * — the statement adds up, and it adds up because the signs are real.
 */
export async function directCashFlow(opts: {
  orgId: string; entityId: string; from: string; to: string; bookCode?: string;
}): Promise<DirectCashFlow> {
  const from = new Date(`${opts.from.slice(0, 10)}T00:00:00.000Z`);
  const to = new Date(`${opts.to.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new LedgerError("A cash flow statement needs two dates it can read.");
  }
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: opts.bookCode ?? "PRIMARY" },
  });
  if (!book) throw new LedgerError("No ledger has been opened for this entity.");

  // Reversals count. Filtering to "posted" alone would take a reversing entry
  // out while leaving the entry it reversed in, and move every figure below by
  // the full amount, in the wrong direction.
  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      entry: {
        orgId: opts.orgId, entityId: opts.entityId,
        status: { in: ["posted", "reversed"] },
        entryDate: { gte: from, lte: to },
      },
    },
    include: { account: { select: { code: true } }, entry: { select: { id: true } } },
  });

  const byEntry = new Map<string, { cash: bigint; contra: { code: string; amount: bigint }[] }>();
  for (const l of lines) {
    const g = byEntry.get(l.entryId) ?? { cash: 0n, contra: [] };
    if (CASH.has(l.account.code)) g.cash += l.txnAmountMinor;
    else g.contra.push({ code: l.account.code, amount: l.txnAmountMinor });
    byEntry.set(l.entryId, g);
  }

  const totals = new Map<DirectLine, bigint>();
  const bump = (line: DirectLine, amount: bigint) =>
    totals.set(line, (totals.get(line) ?? 0n) + amount);

  let mixedEntries = 0;
  let cashMovement = 0n;

  for (const [, g] of byEntry) {
    if (g.cash === 0n) continue;   // no cash moved; the indirect statement's business
    cashMovement += g.cash;

    if (!g.contra.length) {
      // Cash to cash. A transfer from the current account to the deposit
      // account is not a flow at all, and its two legs already net to nil in
      // the movement above — but an entry whose cash legs do NOT net is cash
      // that came from nowhere, and that is worth saying rather than burying.
      if (g.cash !== 0n) bump("unattributed", g.cash);
      continue;
    }

    // Weight by magnitude, not by signed amount: an entry containing both a
    // debit and a credit contra line would otherwise have a denominator
    // smaller than either, and one line's share would exceed the whole.
    const weights = g.contra.map((c) => (c.amount < 0n ? -c.amount : c.amount));
    const total = weights.reduce((a, w) => a + w, 0n);
    if (total === 0n) { bump("unattributed", g.cash); continue; }

    const kinds = new Set(g.contra.map((c) => lineFor(c.code)));
    if (kinds.size > 1) mixedEntries += 1;

    // Largest remainder, so the parts add back to the cash line exactly. A
    // statement that does not foot because of rounding is a statement nobody
    // trusts about anything else either.
    const exact = g.contra.map((c, i) => ({ line: lineFor(c.code), num: g.cash * weights[i] }));
    const floors = exact.map((e) => e.num / total);
    let allocated = floors.reduce((a, f) => a + f, 0n);
    const order = exact
      .map((e, i) => ({ i, rem: e.num - floors[i] * total }))
      .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : 0));
    const step = g.cash >= 0n ? 1n : -1n;
    let k = 0;
    while (allocated !== g.cash && k < order.length * 2) {
      floors[order[k % order.length].i] += step;
      allocated += step;
      k += 1;
    }
    exact.forEach((e, i) => bump(e.line, floors[i]));
  }

  const operating = OPERATING.map((line) => ({
    line, label: LABELS[line], amountMinor: totals.get(line) ?? 0n,
  })).filter((r) => r.amountMinor !== 0n);

  const netOperating = operating.reduce((a, r) => a + r.amountMinor, 0n);
  const investing = totals.get("investing") ?? 0n;
  const financing = totals.get("financing") ?? 0n;
  const unattributed = totals.get("unattributed") ?? 0n;
  const net = netOperating + investing + financing + unattributed;

  const indirect = await cashFlowStatement({
    orgId: opts.orgId, entityId: opts.entityId, from: opts.from, to: opts.to,
  });
  const indirectOperating = BigInt(indirect.operating.totalMinor);

  const warnings: string[] = [];
  if (net !== cashMovement) {
    warnings.push(
      `The statement accounts for ${net} of cash and the ledger moved ${cashMovement}. ` +
      `The difference is shown rather than absorbed.`,
    );
  }
  if (unattributed !== 0n) {
    warnings.push(
      `${unattributed} of cash moved on entries with no non-cash line. That is a transfer between cash ` +
      `accounts, which belongs in no section — unless the two legs do not net, in which case it is a finding.`,
    );
  }
  if (mixedEntries > 0) {
    warnings.push(
      `${mixedEntries} ${mixedEntries === 1 ? "entry" : "entries"} had their cash split across contra lines of ` +
      `differing character. The split is by amount, which is arithmetic rather than fact — it is right where the ` +
      `lines are alike, as they are on a payment run, and approximate where they are not.`,
    );
  }
  if (netOperating !== indirectOperating) {
    warnings.push(
      `Operating cash flow is ${netOperating} by the direct method and ${indirectOperating} by the indirect one. ` +
      `IAS 7.20 asks for both to be presented and they have to agree; they do not.`,
    );
  }
  for (const w of indirect.warnings) warnings.push(`From the indirect statement: ${w}`);

  return {
    from: opts.from, to: opts.to,
    currency: book.functionalCurrency,
    operating,
    netOperatingMinor: netOperating,
    investingMinor: investing,
    financingMinor: financing,
    unattributedMinor: unattributed,
    netCashMovementMinor: net,
    cashMovementPerLedgerMinor: cashMovement,
    reconciles: net === cashMovement,
    differenceMinor: net - cashMovement,
    reconciliation: {
      netOperatingIndirectMinor: indirectOperating,
      agreesWithDirect: netOperating === indirectOperating,
      differenceMinor: netOperating - indirectOperating,
    },
    mixedEntries,
    warnings,
  };
}
