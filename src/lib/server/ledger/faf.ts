import { prisma } from "@/lib/server/prisma";
import { getRecord } from "@/lib/server/store";
import { exponentOf } from "@/lib/ledger/format";
import { LedgerError } from "./post";
import { profitAndLoss } from "./statements";
import type { Entity, Invoice } from "@/lib/domain/types";
import { csvField, csvRow, parseCsv } from "./csv";

/**
 * The FTA Audit File (FAF), produced from the general ledger.
 *
 * A taxable person's accounting software has to be able to hand the Federal
 * Tax Authority a machine-readable extract of the period under review, on
 * request and without a project. That is what this produces: one CSV carrying
 * a company record, the purchases, the supplies, and the general ledger behind
 * both, each section closed by a footer stating its record count and totals.
 *
 * The design decision is the same one the VAT return makes. Every figure comes
 * from the journal lines — the same rows the trial balance and the VAT 201 are
 * built from — rather than from a second walk over the invoice documents. Two
 * routes to one number is two numbers, and "why does your audit file not match
 * your ledger" is a question with no good answer. The documents are consulted
 * for one thing only: the counterparty's name and TRN, which the ledger does
 * not hold and the file must carry.
 *
 * Because the file and the books share a source, the file can check itself.
 * The footers are re-read out of the generated CSV and checked against the rows
 * above them, and the section totals are checked against the ledger a second
 * way. `reconciles` and the differences are returned rather than asserted
 * quietly, so a discrepancy is on the screen before anyone downloads the file
 * rather than discovered by an auditor afterwards.
 *
 * This produces a file. It does not submit anything — handing the file to the
 * FTA is an act a human takes, on a file they have looked at.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS IS CERTAIN AND WHERE IT IS NOT — please read before relying on it.
 *
 * Confident: the file is a CSV; it has four blocks in this order — company
 * information, purchases, supplies, general ledger; each transactional block
 * ends with a footer carrying that block's totals and a record count; amounts
 * are in AED and each block also has room for a foreign-currency amount, its
 * currency code and the rate used.
 *
 * NOT confident, and every one of these should be checked against the current
 * FTA specification before this file is sent to anybody:
 *
 *  - The record-type letters. "C" for company, "P" for purchase, "S" for
 *    supply, "L" for the ledger and "F" for a footer follow the IRAS Audit File
 *    (Singapore), on which the UAE FAF is closely modelled. The letters used
 *    here are that convention, not a quotation from the FTA's document.
 *  - The exact column names, their order, and how many there are in each
 *    block. What is emitted below is a best understanding, ordered the way the
 *    IAF orders them. Field names appear in `columns` on each section so a
 *    reviewer can compare them against the specification side by side.
 *  - Whether the file carries a header row naming the columns. None is emitted
 *    here, because a positional parser reading a header row as data is a worse
 *    failure than a human reading a file without one; the names travel in the
 *    structured summary instead.
 *  - The date format. ISO (YYYY-MM-DD) is used; the FTA template may want
 *    DD/MM/YYYY.
 *  - Whether the company block wants tax-agent and tax-agency identifiers
 *    (name, TAN, TAAN). Columns are emitted for them and left empty, because
 *    this product does not model an appointed tax agent — an empty column that
 *    is named is honest, an omitted one is silent.
 *  - Whether the general-ledger block's balance column means a running balance
 *    per account or a cumulative file balance. The per-account running balance
 *    is emitted, which is the reading that is reproducible from the rows.
 *
 * Deliberately not attempted: import declaration ("permit") numbers, which the
 * ledger does not hold; reimbursed expense claims, which post input tax without
 * a supplier bill and are warned about rather than guessed at; and the
 * document-level line detail of an invoice, which the ledger does not keep —
 * see the note on `supplyRows`.
 */

/** Chart codes the file's own arithmetic depends on. */
const VAT_OUTPUT = "2100";
const VAT_INPUT = "1350";
const INVENTORY = "1200";

/** The record-type letters. See the caveat above — this is the IAF convention. */
const REC_COMPANY = "C";
const REC_PURCHASE = "P";
const REC_SUPPLY = "S";
const REC_LEDGER = "L";
const REC_FOOTER = "F";

/** The version of the layout emitted here, not a version of the FTA's spec. */
export const FAF_LAYOUT_VERSION = "FAF-1.0-draft";

export interface FafSection {
  key: "company" | "purchase" | "supply" | "ledger";
  label: string;
  /** The letter every row of this section starts with. */
  recordType: string;
  /** Field names in the order they are written. Compare against the FTA spec. */
  columns: string[];
  /** Data rows, not counting the footer. */
  recordCount: number;
  /** What this section's footer claims, in the order the footer states it. */
  footer: { label: string; value: string }[];
  /**
   * The footer read back out of the generated CSV and checked against the rows
   * above it. A footer nobody checked is a footer nobody should believe.
   */
  footerAgreesWithRows: boolean;
}

export interface FafCheck {
  key: string;
  label: string;
  unit: "MONEY" | "COUNT";
  /** What the file says. */
  perFile: string;
  /** What the ledger says, summed a different way. */
  perLedger: string;
  difference: string;
  agrees: boolean;
  /** What to look at when it does not agree. */
  note: string;
}

export interface FtaAuditFile {
  entityId: string;
  periodFrom: string;
  periodTo: string;
  currency: string;
  generatedAt: string;
  layoutVersion: string;
  company: {
    legalName: string;
    legalNameAr: string | null;
    trn: string;
    tradeLicenceNo: string | null;
    emirate: string | null;
    country: string | null;
    vatRegistered: boolean;
  };
  /** The file itself. */
  csv: string;
  /** Every row of the file, so it can be looked at before it is downloaded. */
  preview: string[];
  /** Total rows in the CSV, footers included. */
  rowCount: number;
  sections: FafSection[];
  checks: FafCheck[];
  /** True only when every footer and every check agrees. */
  reconciles: boolean;
  /** The sum of the absolute money differences across the checks, in minor units. */
  differenceMinor: string;
  /** Anything that would make this file wrong if it were handed over as it stands. */
  warnings: string[];
}

/* ------------------------------------------------------------------- CSV io */

/** RFC 4180 quoting. A supplier called `Al Marri, Sons & Co "Trading"` must survive. */


/** Minor units as the plain decimal the file carries: no grouping, no parentheses. */
function decimal(minor: bigint, currency: string): string {
  const exp = exponentOf(currency);
  const neg = minor < 0n;
  const abs = (neg ? -minor : minor).toString().padStart(exp + 1, "0");
  const body = exp === 0 ? abs : `${abs.slice(0, -exp)}.${abs.slice(-exp)}`;
  return neg ? `-${body}` : body;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/* ------------------------------------------------------------- the file */

export async function ftaAuditFile(opts: {
  orgId: string;
  entityId: string;
  /** Inclusive ISO dates — the period the FTA has asked about. */
  from: string;
  to: string;
  /** Stamped into the company record; defaults to now. Tests pin it. */
  generatedAt?: Date | string;
}): Promise<FtaAuditFile> {
  const from = new Date(opts.from);
  const to = new Date(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new LedgerError("An audit file needs a valid start and end date for the period being audited.");
  }
  if (to < from) throw new LedgerError("The audit period ends before it starts. Check the dates and try again.");

  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
  });
  if (!book) throw new LedgerError("No ledger has been opened for this entity, so there is nothing to extract.");
  const currency = book.functionalCurrency;

  /* ---- the company record, and the refusal ------------------------------- */

  const entity = await getRecord<Entity>(opts.orgId, "entities", opts.entityId);

  // The company block is the first thing the FTA reads and the TRN is how the
  // file is attached to a taxable person. A file that arrives without one is
  // rejected, and a rejected file costs the business the deadline it was
  // answering — so this refuses to produce one rather than producing a file
  // that will be thrown away.
  const missing: string[] = [];
  if (!entity) {
    throw new LedgerError(
      `There is no entity record for ${opts.entityId}, so an FTA Audit File cannot carry the taxable person's ` +
        `Tax Registration Number (TRN) or legal name. Create the entity under Settings → Entity details, ` +
        `then generate the file again.`,
    );
  }
  const trn = (entity.trn ?? "").trim();
  const legalName = (entity.legalNameEn ?? "").trim();
  if (!trn) missing.push("a Tax Registration Number (TRN)");
  if (!legalName) missing.push("a legal name");
  if (missing.length) {
    throw new LedgerError(
      `This entity is missing ${missing.join(" and ")}, and the FTA Audit File's company record has to carry ` +
        `${missing.length === 1 ? "it" : "them"}. The FTA rejects a file it cannot attach to a taxable person, ` +
        `which wastes the request you are answering. Add ${missing.join(" and ")} under Settings → Entity details ` +
        `and generate the file again.`,
    );
  }

  const warnings: string[] = [];
  // A UAE TRN is fifteen digits. This is a warning rather than a refusal
  // because the number on file may be right and the format check wrong; the
  // file is still produced, and the reader is told to look.
  if (!/^\d{15}$/.test(trn)) {
    warnings.push(
      `The TRN on this entity, "${trn}", is not fifteen digits, which is what a UAE TRN is. ` +
        `The FTA will not match the file to a taxable person if it is wrong. Check it before sending the file.`,
    );
  }
  if (entity.vatRegistered === false) {
    warnings.push(
      `This entity is marked as not VAT-registered, yet it carries a TRN and this file reports supplies and ` +
        `input tax. Either the registration flag or the TRN is out of date — reconcile them before sending it.`,
    );
  }

  /* ---- the ledger the whole file is built from --------------------------- */

  // Reversed entries are included alongside posted ones. A reversal is a
  // separate entry that offsets the original; both happened, and an audit file
  // that shows only the surviving half is a file that has been tidied. The
  // balance cache counts both, so the reconciliation below compares like with
  // like.
  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      entry: {
        entityId: opts.entityId,
        bookId: book.id,
        status: { in: ["posted", "reversed"] },
        entryDate: { gte: from, lte: to },
      },
    },
    include: {
      account: { select: { code: true, name: true, type: true } },
      entry: {
        select: {
          id: true, series: true, number: true, entryDate: true, memo: true,
          source: true, sourceType: true, sourceId: true, status: true, periodId: true,
        },
      },
    },
  });

  type Row = (typeof lines)[number];

  // Deterministic order: a file regenerated tomorrow for the same period must
  // be the same file, or a reviewer cannot diff two extracts against each other.
  const seq = (n: string) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
  lines.sort(
    (a, b) =>
      a.entry.entryDate.getTime() - b.entry.entryDate.getTime() ||
      a.entry.series.localeCompare(b.entry.series) ||
      seq(a.entry.number) - seq(b.entry.number) ||
      a.entry.id.localeCompare(b.entry.id) ||
      a.lineNo - b.lineNo,
  );

  /* ---- counterparties, from the documents -------------------------------- */

  // The only thing taken from outside the ledger. The journal knows an entry
  // came from invoice `x`; it does not know that invoice `x` was to Al Marri
  // Trading, TRN 100…003, and the FAF has a column for exactly that.
  const docIds = [
    ...new Set(
      lines
        .filter((l) => (l.entry.source === "invoice" || l.entry.source === "bill") && l.entry.sourceId)
        .map((l) => l.entry.sourceId as string),
    ),
  ];
  const docs = docIds.length
    ? await prisma.record.findMany({ where: { orgId: opts.orgId, store: "invoices", id: { in: docIds } } })
    : [];
  const counterparty = new Map<string, { name: string; trn: string; number: string }>();
  for (const d of docs) {
    let inv: Invoice | undefined;
    try { inv = JSON.parse(d.data) as Invoice; } catch { inv = undefined; }
    if (!inv) continue;
    // A sales document's counterparty is the buyer; a purchase document's is
    // the seller. Getting this the wrong way round would print our own TRN in
    // the customer column of every supply.
    const party = inv.direction === "OUTBOUND" ? inv.buyer : inv.seller;
    counterparty.set(d.id, {
      name: (party?.nameEn ?? "").trim(),
      trn: (party?.trn ?? "").trim(),
      number: (inv.number ?? "").trim(),
    });
  }

  const ref = (l: Row) => `${l.entry.series}-${l.entry.number}`;
  const partyFor = (l: Row) => (l.entry.sourceId ? counterparty.get(l.entry.sourceId) : undefined);
  const docNumber = (l: Row) => partyFor(l)?.number || ref(l);
  const fcCurrency = (l: Row) => (l.txnCurrency === currency ? "" : l.txnCurrency);
  const fcAmount = (l: Row, signedMinor: bigint) =>
    l.txnCurrency === currency ? "" : decimal(signedMinor, l.txnCurrency);
  const fxRate = (l: Row) => (l.txnCurrency === currency ? "" : l.fxRate.toString());

  /* ---- supplies ---------------------------------------------------------- */

  /**
   * One row per revenue posting on a sales document.
   *
   * The FAF's supply block is document-line shaped, and the ledger is not: an
   * invoice with forty items posts three or four journal lines, merged by
   * revenue account, because the books record what happened to the business
   * rather than a copy of the document. So a row here is a posting, not an
   * invoice line, and the line number is the journal line's. That is a real
   * departure from the specification's intent and it is written down rather
   * than hidden.
   *
   * Only entries raised through the sales subledger appear. Revenue reached by
   * a hand-written journal has no invoice number, no customer and no TRN, so it
   * cannot be represented as a supply — and its absence is precisely what the
   * supply-versus-revenue check below is for.
   */
  const supplyEntries = new Map<string, Row[]>();
  for (const l of lines) {
    if (l.entry.source !== "invoice") continue;
    const g = supplyEntries.get(l.entry.id);
    if (g) g.push(l); else supplyEntries.set(l.entry.id, [l]);
  }

  const supplyRows: string[][] = [];
  let supplyValue = 0n;
  let supplyVat = 0n;
  const noCounterparty: string[] = [];

  for (const group of supplyEntries.values()) {
    // Revenue sits on the credit side; the file reports supplies positive.
    const revenue = group.filter((l) => l.account.type === "INCOME");
    if (!revenue.length) continue;
    // Self-accounted reverse-charge output tax is raised on a purchase, never
    // on a supply, so it is excluded here even though it lands on 2100.
    const vat = group
      .filter((l) => l.account.code === VAT_OUTPUT && l.taxCode !== "RC_OUTPUT_VAT")
      .reduce((a, l) => a + -l.functionalAmountMinor, 0n);
    const net = revenue.reduce((a, l) => a + -l.functionalAmountMinor, 0n);

    const first = revenue[0];
    const party = partyFor(first);
    if (!party?.name) noCounterparty.push(`${ref(first)} on ${iso(first.entry.entryDate)}`);

    for (let i = 0; i < revenue.length; i++) {
      const l = revenue[i];
      const lineNet = -l.functionalAmountMinor;
      // The document's tax sits on one journal line for the whole invoice, so
      // it is apportioned across the revenue postings by value, with the
      // rounding remainder on the last one. The apportionment is derived here,
      // not carried on the document, and the section total is exact either way.
      const share = net === 0n ? 0n : (vat * lineNet) / net;
      const allocated = i === revenue.length - 1
        ? vat - revenue.slice(0, -1).reduce((a, r) => a + (net === 0n ? 0n : (vat * -r.functionalAmountMinor) / net), 0n)
        : share;
      supplyRows.push([
        REC_SUPPLY,
        party?.name ?? "",
        party?.trn ?? "",
        iso(l.entry.entryDate),
        docNumber(l),
        String(l.lineNo),
        l.memo ?? l.entry.memo ?? l.account.name,
        decimal(lineNet, currency),
        decimal(allocated, currency),
        fcCurrency(l),
        fcAmount(l, -l.txnAmountMinor),
        "",
        l.taxCode ?? "",
        fxRate(l),
      ]);
      supplyValue += lineNet;
      supplyVat += allocated;
    }
  }

  /* ---- purchases --------------------------------------------------------- */

  const purchaseEntries = new Map<string, Row[]>();
  for (const l of lines) {
    if (l.entry.source !== "bill") continue;
    const g = purchaseEntries.get(l.entry.id);
    if (g) g.push(l); else purchaseEntries.set(l.entry.id, [l]);
  }

  const purchaseRows: string[][] = [];
  let purchaseValue = 0n;
  let purchaseVat = 0n;

  for (const group of purchaseEntries.values()) {
    // Stock bought for resale is a purchase for the file even though it lands
    // on the balance sheet, which is the same treatment the VAT return gives it.
    const cost = group.filter((l) => l.account.type === "EXPENSE" || l.account.code === INVENTORY);
    if (!cost.length) continue;
    // Only tax the supplier actually charged. The reverse-charge pair is
    // self-accounted: no tax was on the supplier's bill, so reporting it as
    // input tax on a purchase row would double-count it against 1350.
    const vat = group
      .filter((l) => l.account.code === VAT_INPUT && l.taxCode !== "RC_INPUT_VAT")
      .reduce((a, l) => a + l.functionalAmountMinor, 0n);
    const net = cost.reduce((a, l) => a + l.functionalAmountMinor, 0n);

    const first = cost[0];
    const party = partyFor(first);
    if (!party?.name) noCounterparty.push(`${ref(first)} on ${iso(first.entry.entryDate)}`);

    for (let i = 0; i < cost.length; i++) {
      const l = cost[i];
      const lineNet = l.functionalAmountMinor;
      const share = net === 0n ? 0n : (vat * lineNet) / net;
      const allocated = i === cost.length - 1
        ? vat - cost.slice(0, -1).reduce((a, r) => a + (net === 0n ? 0n : (vat * r.functionalAmountMinor) / net), 0n)
        : share;
      purchaseRows.push([
        REC_PURCHASE,
        party?.name ?? "",
        party?.trn ?? "",
        iso(l.entry.entryDate),
        docNumber(l),
        // Import declaration ("permit") number. The ledger does not hold one,
        // so the column is present and empty rather than filled with a guess.
        "",
        String(l.lineNo),
        l.memo ?? l.entry.memo ?? l.account.name,
        decimal(lineNet, currency),
        decimal(allocated, currency),
        fcCurrency(l),
        fcAmount(l, l.txnAmountMinor),
        "",
        l.taxCode ?? "",
        fxRate(l),
      ]);
      purchaseValue += lineNet;
      purchaseVat += allocated;
    }
  }

  /* ---- the general ledger ------------------------------------------------ */

  const ledgerRows: string[][] = [];
  let totalDebit = 0n;
  let totalCredit = 0n;
  const running = new Map<string, bigint>();

  for (const l of lines) {
    const amount = l.functionalAmountMinor;
    const bal = (running.get(l.account.code) ?? 0n) + amount;
    running.set(l.account.code, bal);
    if (amount > 0n) totalDebit += amount; else totalCredit += -amount;
    ledgerRows.push([
      REC_LEDGER,
      iso(l.entry.entryDate),
      l.account.code,
      l.account.name,
      l.memo ?? l.entry.memo ?? "",
      // "Name of journal" in the IAF sense: what raised the entry.
      l.entry.source,
      ref(l),
      l.entry.sourceType ?? "",
      l.entry.sourceId ?? "",
      amount > 0n ? decimal(amount, currency) : "",
      amount < 0n ? decimal(-amount, currency) : "",
      decimal(bal, currency),
      l.entry.status,
    ]);
  }

  /* ---- assemble ---------------------------------------------------------- */

  const generatedAt = opts.generatedAt ? new Date(opts.generatedAt) : new Date();
  const companyColumns = [
    "Record type", "Company name", "Company name (Arabic)", "Taxable person TRN",
    "Trade licence number", "Emirate", "Country", "Period start", "Period end",
    "File creation date", "Product version", "FAF layout version",
    "Tax agency name", "Tax agent name", "Tax agent approval number",
  ];
  const companyRow = [
    REC_COMPANY,
    legalName,
    entity.legalNameAr ?? "",
    trn,
    entity.tradeLicenseNo ?? "",
    entity.address?.emirate ?? "",
    entity.address?.country ?? "",
    opts.from,
    opts.to,
    iso(generatedAt),
    "ARKS Accounting",
    FAF_LAYOUT_VERSION,
    // Not modelled by this product. Named and empty beats silently absent.
    "", "", "",
  ];

  const purchaseFooter = [REC_FOOTER, decimal(purchaseValue, currency), decimal(purchaseVat, currency), String(purchaseRows.length)];
  const supplyFooter = [REC_FOOTER, decimal(supplyValue, currency), decimal(supplyVat, currency), String(supplyRows.length)];
  const ledgerFooter = [REC_FOOTER, decimal(totalDebit, currency), decimal(totalCredit, currency), String(ledgerRows.length)];

  const all: string[][] = [
    companyRow,
    ...purchaseRows, purchaseFooter,
    ...supplyRows, supplyFooter,
    ...ledgerRows, ledgerFooter,
  ];
  const csv = all.map(csvRow).join("\r\n") + "\r\n";

  /* ---- the file checks itself -------------------------------------------- */

  // Read back what was actually written. Everything below is computed from the
  // parsed file, not from the variables that produced it.
  const parsed = parseCsv(csv);
  const sumCol = (rows: string[][], type: string, col: number) =>
    rows.filter((r) => r[0] === type).reduce((a, r) => a + BigInt((r[col] || "0").replace(".", "")), 0n);
  const countOf = (type: string) => parsed.filter((r) => r[0] === type).length;
  const footers = parsed.filter((r) => r[0] === REC_FOOTER);

  const footerAgrees = (footer: string[] | undefined, type: string, valueCol: number, vatCol: number) => {
    if (!footer) return false;
    const rows = parsed.filter((r) => r[0] === type);
    const claimedValue = footer[1] ?? "";
    const claimedVat = footer[2] ?? "";
    const claimedCount = footer[3] ?? "";
    const value = rows.reduce((a, r) => a + BigInt((r[valueCol] || "0").replace(".", "")), 0n);
    const vat = rows.reduce((a, r) => a + BigInt((r[vatCol] || "0").replace(".", "")), 0n);
    return (
      claimedValue === decimal(value, currency) &&
      claimedVat === decimal(vat, currency) &&
      claimedCount === String(rows.length)
    );
  };

  // Ledger footer: debits and credits are separate columns, so it is checked
  // against the two columns rather than against a value/tax pair.
  const ledgerFooterAgrees = (() => {
    const f = footers[2];
    if (!f) return false;
    const rows = parsed.filter((r) => r[0] === REC_LEDGER);
    const d = sumCol(rows, REC_LEDGER, 9);
    const c = sumCol(rows, REC_LEDGER, 10);
    return f[1] === decimal(d, currency) && f[2] === decimal(c, currency) && f[3] === String(rows.length);
  })();

  const sections: FafSection[] = [
    {
      key: "company",
      label: "Company information",
      recordType: REC_COMPANY,
      columns: companyColumns,
      recordCount: countOf(REC_COMPANY),
      footer: [],
      // The company block is a single record and carries no footer of its own;
      // it agrees when exactly one such record was written.
      footerAgreesWithRows: countOf(REC_COMPANY) === 1,
    },
    {
      key: "purchase",
      label: "Purchases (supplier invoices)",
      recordType: REC_PURCHASE,
      columns: [
        "Record type", "Supplier name", "Supplier TRN", "Invoice date", "Invoice number",
        "Import declaration number", "Line number", "Description", "Purchase value (AED)",
        "Input VAT (AED)", "Foreign currency", "Foreign currency value", "Foreign currency VAT",
        "Tax code", "Exchange rate",
      ],
      recordCount: purchaseRows.length,
      footer: [
        { label: "Total purchase value", value: decimal(purchaseValue, currency) },
        { label: "Total input VAT", value: decimal(purchaseVat, currency) },
        { label: "Transaction count", value: String(purchaseRows.length) },
      ],
      footerAgreesWithRows: footerAgrees(footers[0], REC_PURCHASE, 8, 9),
    },
    {
      key: "supply",
      label: "Supplies (sales invoices)",
      recordType: REC_SUPPLY,
      columns: [
        "Record type", "Customer name", "Customer TRN", "Invoice date", "Invoice number",
        "Line number", "Description", "Supply value (AED)", "Output VAT (AED)",
        "Foreign currency", "Foreign currency value", "Foreign currency VAT", "Tax code", "Exchange rate",
      ],
      recordCount: supplyRows.length,
      footer: [
        { label: "Total supply value", value: decimal(supplyValue, currency) },
        { label: "Total output VAT", value: decimal(supplyVat, currency) },
        { label: "Transaction count", value: String(supplyRows.length) },
      ],
      footerAgreesWithRows: footerAgrees(footers[1], REC_SUPPLY, 7, 8),
    },
    {
      key: "ledger",
      label: "General ledger",
      recordType: REC_LEDGER,
      columns: [
        "Record type", "Transaction date", "Account code", "Account name", "Description",
        "Source", "Transaction reference", "Source document type", "Source document id",
        "Debit (AED)", "Credit (AED)", "Balance (AED)", "Entry status",
      ],
      recordCount: ledgerRows.length,
      footer: [
        { label: "Total debit", value: decimal(totalDebit, currency) },
        { label: "Total credit", value: decimal(totalCredit, currency) },
        { label: "Transaction count", value: String(ledgerRows.length) },
      ],
      footerAgreesWithRows: ledgerFooterAgrees,
    },
  ];

  /* ---- and checks itself against the ledger ------------------------------ */

  // The same rows summed a second way, straight off the source. A mismatch here
  // is not an arithmetic error — the file was built from these rows — it is a
  // gap between what the file can represent and what the books contain, which
  // is exactly the thing worth knowing before the file is sent.
  const ledgerDebit = lines.filter((l) => l.functionalAmountMinor > 0n).reduce((a, l) => a + l.functionalAmountMinor, 0n);
  const ledgerCredit = lines.filter((l) => l.functionalAmountMinor < 0n).reduce((a, l) => a + -l.functionalAmountMinor, 0n);

  const pl = await profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from: opts.from, to: opts.to });
  const revenue = BigInt(pl.revenue.totalMinor);

  const ledgerOutputVat = lines
    .filter((l) => l.account.code === VAT_OUTPUT && l.taxCode !== "RC_OUTPUT_VAT")
    .reduce((a, l) => a + -l.functionalAmountMinor, 0n);
  const ledgerInputVat = lines
    .filter((l) => l.account.code === VAT_INPUT && l.taxCode !== "RC_INPUT_VAT")
    .reduce((a, l) => a + l.functionalAmountMinor, 0n);

  const fileLedgerRows = BigInt(parsed.filter((r) => r[0] === REC_LEDGER).length);
  const fileDebit = sumCol(parsed, REC_LEDGER, 9);
  const fileCredit = sumCol(parsed, REC_LEDGER, 10);
  const fileSupply = sumCol(parsed, REC_SUPPLY, 7);
  const fileSupplyVat = sumCol(parsed, REC_SUPPLY, 8);
  const filePurchaseVat = sumCol(parsed, REC_PURCHASE, 9);

  const check = (
    key: string, label: string, unit: "MONEY" | "COUNT",
    file: bigint, ledger: bigint, note: string,
  ): FafCheck => ({
    key, label, unit,
    perFile: unit === "MONEY" ? decimal(file, currency) : file.toString(),
    perLedger: unit === "MONEY" ? decimal(ledger, currency) : ledger.toString(),
    difference: unit === "MONEY" ? decimal(file - ledger, currency) : (file - ledger).toString(),
    agrees: file === ledger,
    note,
  });

  const checks: FafCheck[] = [
    check("ledger_rows", "General ledger rows against the journal", "COUNT",
      fileLedgerRows, BigInt(lines.length),
      "Every posted and reversed journal line in the period has to appear once in the general ledger section."),
    check("ledger_debit", "General ledger debits", "MONEY", fileDebit, ledgerDebit,
      "The footer's total debit against the debit side of the journal lines it was built from."),
    check("ledger_credit", "General ledger credits", "MONEY", fileCredit, ledgerCredit,
      "The footer's total credit against the credit side of the journal lines it was built from."),
    check("supply_value", "Supplies against revenue", "MONEY", fileSupply, revenue,
      "Revenue reached by a hand-written journal has no invoice number or customer, so it cannot appear as a supply. A difference here is revenue the file does not report."),
    check("supply_vat", "Output tax against account 2100", "MONEY", fileSupplyVat, ledgerOutputVat,
      "Output tax in the supply section against the VAT output control account, excluding self-accounted reverse charge."),
    check("purchase_vat", "Input tax against account 1350", "MONEY", filePurchaseVat, ledgerInputVat,
      "Input tax in the purchase section against the VAT input control account, excluding self-accounted reverse charge. Reimbursed expense claims post here without a supplier bill and will show as a difference."),
  ];

  const footersAgree = sections.every((s) => s.footerAgreesWithRows);
  const reconciles = footersAgree && checks.every((c) => c.agrees);
  const differenceMinor = checks
    .filter((c) => c.unit === "MONEY")
    .reduce((a, c) => {
      const d = BigInt(c.difference.replace(".", "").replace("-", ""));
      return a + d;
    }, 0n);

  /* ---- warnings ---------------------------------------------------------- */

  if (!footersAgree) {
    warnings.push(
      `A section footer does not agree with the rows above it in the generated file. This is a defect in the ` +
        `export itself rather than in your books — do not send this file, and report it.`,
    );
  }
  for (const c of checks) {
    if (c.agrees) continue;
    warnings.push(`${c.label}: the file says ${c.perFile} and the ledger says ${c.perLedger}. ${c.note}`);
  }

  /**
   * Postings with no tax treatment.
   *
   * Every revenue posting counts, wherever it came from: revenue reached by a
   * hand-written journal carries no tax code, is invisible to the VAT return,
   * and is exactly the understatement an audit looks for. Costs are only
   * counted when they sit on a supplier bill — payroll, depreciation and rent
   * paid by standing order legitimately carry no tax code, and warning about
   * them every month would train the reader to ignore the warning that matters.
   */
  const untagged = [
    ...lines
      .filter((l) => l.account.type === "INCOME" && !l.taxCode)
      .map((l) => `${l.account.code} on ${ref(l)} (${iso(l.entry.entryDate)})`),
    ...lines
      .filter((l) => l.entry.source === "bill" && !l.taxCode && (l.account.type === "EXPENSE" || l.account.code === INVENTORY))
      .map((l) => `${l.account.code} on ${ref(l)} (${iso(l.entry.entryDate)})`),
  ];
  if (untagged.length) {
    warnings.push(
      `${untagged.length} posting${untagged.length === 1 ? "" : "s"} in this period carry no tax treatment ` +
        `(${untagged.slice(0, 3).join(", ")}${untagged.length > 3 ? ", …" : ""}). ` +
        `The tax code column is empty for them, the FTA cannot tell how the supply was treated, and revenue posted ` +
        `this way is missing from the VAT return as well. Raise the underlying document and code it.`,
    );
  }

  if (noCounterparty.length) {
    const sample = [...new Set(noCounterparty)].slice(0, 3).join(", ");
    warnings.push(
      `${noCounterparty.length} document${noCounterparty.length === 1 ? "" : "s"} in this file name no counterparty ` +
        `(${sample}${noCounterparty.length > 3 ? ", …" : ""}). The supplier and customer name columns will be empty, ` +
        `and a supply or purchase the FTA cannot attribute to anybody is the first thing an audit asks about. ` +
        `The source document was most likely deleted after it was posted.`,
    );
  }

  // Missing counterparty TRNs are reported separately and softly: a retail sale
  // to an unregistered consumer legitimately has no TRN, so this is a count to
  // look at rather than a fault.
  const rowsMissingTrn =
    supplyRows.filter((r) => !r[2]).length + purchaseRows.filter((r) => !r[2]).length;
  if (rowsMissingTrn) {
    warnings.push(
      `${rowsMissingTrn} supply or purchase row${rowsMissingTrn === 1 ? "" : "s"} carry no counterparty TRN. ` +
        `That is expected for sales to unregistered consumers, but input tax is only recoverable against an ` +
        `invoice showing the supplier's TRN, so check the purchase rows before relying on them.`,
    );
  }

  // Periods that do not balance. The database enforces this at posting time, so
  // this should never fire — which is exactly why it is worth stating in an
  // artefact that goes to a regulator.
  const byPeriod = new Map<string, bigint>();
  for (const l of lines) byPeriod.set(l.entry.periodId, (byPeriod.get(l.entry.periodId) ?? 0n) + l.functionalAmountMinor);
  const unbalanced = [...byPeriod.entries()].filter(([, v]) => v !== 0n);
  if (unbalanced.length) {
    const labels = await prisma.accountingPeriod.findMany({
      where: { id: { in: unbalanced.map(([id]) => id) } },
      select: { id: true, label: true },
    });
    const named = unbalanced
      .map(([id, v]) => `${labels.find((p) => p.id === id)?.label ?? id} (out by ${decimal(v, currency)})`)
      .join(", ");
    warnings.push(
      `The postings in this file do not balance within ${unbalanced.length === 1 ? "one period" : `${unbalanced.length} periods`}: ${named}. ` +
        `An audit file whose debits and credits differ will be rejected, and a period that does not balance is a ` +
        `ledger defect — report it rather than sending this file.`,
    );
  }

  // Input tax that did not come through a supplier bill is absent from the
  // purchase section by construction. Naming the source is more useful than a
  // bare difference on the check above.
  const strayInputVat = lines
    .filter((l) => l.account.code === VAT_INPUT && l.taxCode !== "RC_INPUT_VAT" && l.entry.source !== "bill")
    .reduce((a, l) => a + l.functionalAmountMinor, 0n);
  if (strayInputVat !== 0n) {
    warnings.push(
      `${decimal(strayInputVat, currency)} of input tax in this period was not posted from a supplier bill, ` +
        `so it has no purchase row in this file. Reimbursed expense claims post input tax this way. ` +
        `The purchase section is incomplete by that amount.`,
    );
  }

  const drafts = await prisma.journalEntry.count({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: "draft", entryDate: { gte: from, lte: to } },
  });
  if (drafts) {
    warnings.push(
      `${drafts} draft entr${drafts === 1 ? "y is" : "ies are"} dated inside this period and ${drafts === 1 ? "is" : "are"} not in this file, ` +
        `because a draft is not in the books. Post ${drafts === 1 ? "it" : "them"} or delete ${drafts === 1 ? "it" : "them"} before the period is audited.`,
    );
  }

  return {
    entityId: opts.entityId,
    periodFrom: opts.from,
    periodTo: opts.to,
    currency,
    generatedAt: generatedAt.toISOString(),
    layoutVersion: FAF_LAYOUT_VERSION,
    company: {
      legalName,
      legalNameAr: entity.legalNameAr ?? null,
      trn,
      tradeLicenceNo: entity.tradeLicenseNo ?? null,
      emirate: entity.address?.emirate ?? null,
      country: entity.address?.country ?? null,
      vatRegistered: Boolean(entity.vatRegistered),
    },
    csv,
    preview: all.slice(0, 12).map(csvRow),
    rowCount: all.length,
    sections,
    checks,
    reconciles,
    differenceMinor: differenceMinor.toString(),
    warnings,
  };
}
