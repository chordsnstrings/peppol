import { createHash } from "node:crypto";
import { prisma } from "@/lib/server/prisma";
import { exponentOf } from "@/lib/ledger/format";
import { LedgerError, post, type PostLine } from "./post";
import { balances } from "./statements";
import { csvRow, parseCsv } from "./csv";

/**
 * Getting the books out, and getting somebody else's books in.
 *
 * A business owns its accounting records. It has to be able to hand them to an
 * auditor, carry them to another product, or simply keep a copy, without asking
 * anyone's permission and without a project — and it has to be able to bring in
 * what it kept in whatever it used before. Those two halves live together here
 * because they are the same promise read in opposite directions.
 *
 * Three decisions shape the export:
 *
 *  - **Every amount is a string of minor units.** 2^53 minor units is about
 *    ninety trillion fils, and a group consolidation reaches it. A number in
 *    JSON is a double; a double past that point silently rounds. An export that
 *    loses a fil is worse than no export, because it will be believed.
 *
 *  - **CSV and JSON are two renderings of one thing.** The tables are built
 *    once, as columns and rows of strings, and then written either as one file
 *    per table or as a single document. The digest is taken over the tables
 *    rather than over the bytes, so the same books produce the same digest in
 *    either format — which is what lets one export be checked against another.
 *
 *  - **Every export carries a manifest, and the manifest can be checked.** What
 *    was exported, over what range, how many rows of each table, the totals that
 *    have to survive the round trip, and a digest. `verifyExport` re-reads that
 *    manifest out of the files themselves and re-derives the totals from the
 *    rows, so a bundle that lost its tail on the way to a disk says so. An
 *    export nobody can check is an export nobody should trust.
 *
 * ---------------------------------------------------------------------------
 * WHAT A TRIAL-BALANCE MIGRATION DOES NOT BRING WITH IT
 *
 * `importTrialBalance` carries another system's closing trial balance in as
 * this system's opening position. That is a complete and correct statement of
 * where the business stands, and it is *all* it is. It does not bring:
 *
 *  - The transaction history behind those balances. The receivables figure
 *    arrives as one number; the invoices that make it up stay in the old
 *    system, and so does every report that reads them — sales by customer,
 *    margin by month, anything comparative. Keep the old system readable for as
 *    long as the records have to be kept (five years in the UAE, longer for
 *    real estate), because this is the copy that answers "why".
 *
 *  - The open items making up the receivables and payables control accounts.
 *    1100 and 2000 arrive as totals, so nothing is aged and no invoice can be
 *    matched to a receipt. Statements and remittance advices will be wrong
 *    until the individual open invoices and bills are raised.
 *
 *  - The fixed-asset register. The net book value arrives on 1500 and 1590;
 *    the assets, their lives and their remaining depreciation do not, so no
 *    depreciation run can be posted until the register is loaded.
 *
 * Which is why the order matters, and why it is stated on the screen rather
 * than left for somebody to discover: open the books (fiscal year, periods,
 * chart of accounts), then load the registers (counterparties with their open
 * invoices and bills, fixed assets, leases, inventory), and only then bring in
 * the trial balance. Done in that order the registers reconcile to the control
 * accounts on day one. Done the other way round, the opening entry posts totals
 * into control accounts that the registers then post into a second time, and
 * the books are double-counted before anybody has traded.
 */

export const EXPORT_FORMAT_VERSION = "ledger-export-1";

export type ExportFormat = "csv" | "json";

/** One table of the export: columns and rows, every cell already a string. */
export interface ExportTable {
  key: string;
  label: string;
  columns: string[];
  rows: string[][];
  /** What this table is and is not, in one sentence a reader can act on. */
  note: string;
}

export interface ExportTableSummary {
  key: string;
  label: string;
  rowCount: number;
  columns: string[];
  note: string;
}

/** A balance on the trial balance the export has to reproduce. */
export interface ExportTrialBalanceRow {
  code: string;
  name: string;
  debitMinor: string;
  creditMinor: string;
  /** Signed, debit-positive, as the ledger holds it. */
  balanceMinor: string;
}

export interface ExportManifest {
  formatVersion: string;
  format: ExportFormat;
  entityId: string;
  currency: string;
  /** Null means "from the beginning of the books". */
  from: string | null;
  to: string;
  generatedAt: string;
  tables: ExportTableSummary[];
  /**
   * The figures that must survive the round trip. Anything that reads this
   * export back can re-derive all of them from the rows and compare.
   */
  totals: {
    entryCount: number;
    lineCount: number;
    totalDebitMinor: string;
    totalCreditMinor: string;
    trialBalanceAsOf: string;
    trialBalance: ExportTrialBalanceRow[];
    trialBalanceDebitMinor: string;
    trialBalanceCreditMinor: string;
    trialBalanceDifferenceMinor: string;
    trialBalanceBalanced: boolean;
  };
  digestAlgorithm: "sha256";
  /** Over the tables, not over the bytes — see the note at the top. */
  digest: string;
}

export interface ExportFile {
  key: string;
  name: string;
  contentType: string;
  content: string;
  /** Data rows, not counting the header. Nil for the manifest. */
  rowCount: number | null;
}

export interface LedgerExportBundle {
  entityId: string;
  format: ExportFormat;
  from: string | null;
  to: string;
  currency: string;
  generatedAt: string;
  /** What a downloaded set of files should be called on disk. */
  baseName: string;
  manifest: ExportManifest;
  files: ExportFile[];
  /** Anything that would make this export misread if it were relied on as it stands. */
  warnings: string[];
}

/* ------------------------------------------------------------------- CSV io */

/*
 * The writer and the reader come from one place. They used to be restated
 * here because `faf.ts` kept its own copies private — three modules carrying
 * three implementations of the same quoting rule, which is a bug waiting for
 * the first description containing a comma. Reading a file back with a
 * different parser also proves nothing; reading it back with the same one
 * proves the parser agrees with itself, which is what the round trip is for.
 *
 * The export writes CRLF because a spreadsheet on Windows is where these files
 * are opened; the reader ignores carriage returns either way.
 */
const csvText = (columns: string[], rows: string[][]) =>
  [csvRow(columns), ...rows.map(csvRow)].join("\r\n") + "\r\n";

/* ------------------------------------------------------------------ helpers */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const isoOrEmpty = (d: Date | null | undefined) => (d ? iso(d) : "");
const str = (v: string | null | undefined) => v ?? "";
const bool = (v: boolean) => (v ? "true" : "false");
const num = (v: bigint | number | null | undefined) => (v === null || v === undefined ? "" : v.toString());

/** Minor units as a plain decimal, for a sentence a person reads. */
function money(minor: bigint, currency: string): string {
  const exp = exponentOf(currency);
  const neg = minor < 0n;
  const abs = (neg ? -minor : minor).toString().padStart(exp + 1, "0");
  const body = exp === 0 ? abs : `${abs.slice(0, -exp)}.${abs.slice(-exp)}`;
  return neg ? `-${body}` : body;
}

/**
 * The digest input: the tables, in a form that survives being written as CSV
 * and read back. Unit separators are used between cells and records rather than
 * commas or newlines so the digest does not depend on the quoting rules of the
 * format the tables happen to be written in.
 */
const US = "\u001f";
const RS = "\u001e";
const GS = "\u001d";

function digestOf(tables: { key: string; columns: string[]; rows: string[][] }[]): string {
  const body = [...tables]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((t) => [t.key, t.columns.join(US), ...t.rows.map((r) => r.join(US))].join(RS))
    .join(GS);
  return createHash("sha256").update(body).digest("hex");
}

/* -------------------------------------------------------------- the export */

export async function exportLedger(opts: {
  orgId: string;
  entityId: string;
  /** Inclusive ISO dates. Omitting `from` exports from the beginning of the books. */
  from?: string | null;
  to?: string | null;
  format: ExportFormat;
  /** Stamped into the manifest; defaults to now. Tests pin it. */
  generatedAt?: Date | string;
}): Promise<LedgerExportBundle> {
  if (opts.format !== "csv" && opts.format !== "json") {
    throw new LedgerError(`"${String(opts.format)}" is not an export format. Ask for csv or json.`);
  }

  const from = opts.from ? new Date(opts.from) : null;
  const to = opts.to ? new Date(opts.to) : new Date();
  if (from && Number.isNaN(from.getTime())) throw new LedgerError(`"${opts.from}" is not a date.`);
  if (Number.isNaN(to.getTime())) throw new LedgerError(`"${opts.to}" is not a date.`);
  if (from && to < from) {
    throw new LedgerError("The export period ends before it starts. Check the dates and try again.");
  }

  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
  });
  if (!book) throw new LedgerError("No ledger has been opened for this entity, so there is nothing to export.");
  const currency = book.functionalCurrency;

  const fromIso = from ? iso(from) : null;
  const toIso = iso(to);
  const generatedAt = opts.generatedAt ? new Date(opts.generatedAt) : new Date();
  const warnings: string[] = [];

  /* ---- the chart ---------------------------------------------------------- */

  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { code: "asc" },
  });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const chart: ExportTable = {
    key: "accounts",
    label: "Chart of accounts",
    note: "Every account in this entity's chart, headings included. The parent column carries the code, not an internal id, so the tree survives being loaded somewhere else.",
    columns: [
      "code", "name", "nameAr", "type", "subtype", "parentCode",
      "isPostable", "isControl", "currency", "requiresDimension", "status",
    ],
    rows: accounts.map((a) => [
      a.code, a.name, str(a.nameAr), a.type, str(a.subtype),
      str(a.parentId ? accountById.get(a.parentId)?.code ?? "" : ""),
      bool(a.isPostable), bool(a.isControl), str(a.currency), str(a.requiresDimension), a.status,
    ]),
  };

  /* ---- the fiscal calendar ------------------------------------------------ */

  const years = await prisma.fiscalYear.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { startsOn: "asc" },
  });
  const periods = await prisma.accountingPeriod.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: [{ startsOn: "asc" }, { seq: "asc" }],
  });
  const yearById = new Map(years.map((y) => [y.id, y]));
  const periodById = new Map(periods.map((p) => [p.id, p]));

  const fiscalYears: ExportTable = {
    key: "fiscal_years",
    label: "Fiscal years",
    note: "The years the books are kept in. Carried whole rather than clipped to the export range, because a period is what says whether an entry could be posted at all.",
    columns: ["label", "startsOn", "endsOn", "status"],
    rows: years.map((y) => [y.label, iso(y.startsOn), iso(y.endsOn), y.status]),
  };

  const periodTable: ExportTable = {
    key: "periods",
    label: "Accounting periods",
    note: "Every period and its close status. An adjustment period deliberately overlaps the last trading month of its year, which is why the flag is a column rather than something to infer from the dates.",
    columns: ["fiscalYear", "seq", "label", "startsOn", "endsOn", "status", "isAdjustment", "closedAt"],
    rows: periods.map((p) => [
      str(yearById.get(p.fiscalYearId)?.label), String(p.seq), p.label,
      iso(p.startsOn), iso(p.endsOn), p.status, bool(p.isAdjustment),
      p.closedAt ? p.closedAt.toISOString() : "",
    ]),
  };

  /* ---- the journals ------------------------------------------------------- */

  // Reversed entries travel with posted ones. A reversal is a separate entry
  // that offsets the original; both happened, and an export that shows only the
  // surviving half is an export that has been tidied.
  const dateWhere = from || to ? { entryDate: { ...(from ? { gte: from } : {}), lte: to } } : {};
  const entries = await prisma.journalEntry.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId, bookId: book.id,
      status: { in: ["posted", "reversed"] },
      ...dateWhere,
    },
    orderBy: [{ entryDate: "asc" }, { series: "asc" }, { number: "asc" }],
  });
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const ref = (e: { series: string; number: string }) => `${e.series}-${e.number}`;

  const entryTable: ExportTable = {
    key: "entries",
    label: "Journal entries",
    note: "Posted and reversed entries in the range. A reversed entry and the entry that reversed it are both here: both happened, and an export showing only the surviving half has been tidied.",
    columns: [
      "reference", "series", "number", "entryDate", "dueDate", "status", "memo",
      "source", "sourceType", "sourceId", "externalKey", "settlesId", "reversalOf",
      "actorType", "actorId", "period", "book", "postedAt",
    ],
    rows: entries.map((e) => [
      ref(e), e.series, e.number, iso(e.entryDate), isoOrEmpty(e.dueDate), e.status, str(e.memo),
      e.source, str(e.sourceType), str(e.sourceId), str(e.externalKey), str(e.settlesId),
      e.reversalOfId ? str(entryById.get(e.reversalOfId) ? ref(entryById.get(e.reversalOfId)!) : e.reversalOfId) : "",
      e.actorType, str(e.actorId), str(periodById.get(e.periodId)?.label), book.code,
      e.postedAt ? e.postedAt.toISOString() : "",
    ]),
  };

  const lines = entries.length
    ? await prisma.journalLine.findMany({
        where: { orgId: opts.orgId, entryId: { in: entries.map((e) => e.id) } },
        include: {
          account: { select: { code: true, name: true } },
          dimensions: { include: { value: { include: { dimension: true } } } },
        },
      })
    : [];

  // Deterministic order: an export regenerated tomorrow over the same range has
  // to be the same export, or two extracts cannot be diffed against each other
  // and the digest means nothing.
  const seqOf = (n: string) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
  lines.sort((a, b) => {
    const ea = entryById.get(a.entryId)!;
    const eb = entryById.get(b.entryId)!;
    return (
      ea.entryDate.getTime() - eb.entryDate.getTime() ||
      ea.series.localeCompare(eb.series) ||
      seqOf(ea.number) - seqOf(eb.number) ||
      ea.id.localeCompare(eb.id) ||
      a.lineNo - b.lineNo
    );
  });

  let totalDebit = 0n;
  let totalCredit = 0n;
  const lineTable: ExportTable = {
    key: "lines",
    label: "Journal lines",
    note: "One row per posting, in functional and transaction currency, with its tax treatment and its dimensions. Amounts are whole minor units as strings — never a decimal, never a number.",
    columns: [
      "entryReference", "entryDate", "lineNo", "accountCode", "accountName",
      "debitMinor", "creditMinor", "txnCurrency", "txnAmountMinor", "fxRate",
      "functionalCurrency", "functionalAmountMinor", "taxCode", "taxEmirate",
      "settlesId", "memo", "dimensions",
    ],
    rows: lines.map((l) => {
      const e = entryById.get(l.entryId)!;
      const fn = l.functionalAmountMinor;
      if (fn > 0n) totalDebit += fn; else totalCredit += -fn;
      return [
        ref(e), iso(e.entryDate), String(l.lineNo), l.account.code, l.account.name,
        fn > 0n ? fn.toString() : "0", fn < 0n ? (-fn).toString() : "0",
        l.txnCurrency, l.txnAmountMinor.toString(), l.fxRate.toString(),
        l.functionalCurrency, fn.toString(), str(l.taxCode), str(l.taxEmirate),
        str(l.settlesId), str(l.memo),
        // `DIM=VALUE` pairs, sorted, so a line's analysis reads without a join
        // and the digest does not depend on the order the rows came back in.
        l.dimensions
          .map((d) => `${d.value.dimension.code}=${d.value.code}`)
          .sort()
          .join(";"),
      ];
    }),
  };

  /* ---- the subledger registers -------------------------------------------- */

  // The registers are running records, not period extracts: an asset carries the
  // depreciation posted to date and an inventory item carries the cost of the
  // stock it holds now, neither of which can be rewound to an earlier date
  // without replaying every movement. They are therefore exported as they stand
  // rather than as at `to`, and the warning below says so when the two differ.
  const [assets, leases, inventory, counterparties] = await Promise.all([
    prisma.fixedAsset.findMany({ where: { orgId: opts.orgId, entityId: opts.entityId }, orderBy: { code: "asc" } }),
    prisma.lease.findMany({ where: { orgId: opts.orgId, entityId: opts.entityId }, orderBy: { code: "asc" } }),
    prisma.inventoryItem.findMany({ where: { orgId: opts.orgId, entityId: opts.entityId }, orderBy: { sku: "asc" } }),
    prisma.counterparty.findMany({ where: { orgId: opts.orgId, entityId: opts.entityId }, orderBy: { code: "asc" } }),
  ]);

  const assetTable: ExportTable = {
    key: "fixed_assets",
    label: "Fixed asset register",
    note: "The register as it stands, with depreciation posted to date. It is a running record and cannot be rewound to the export's end date without replaying every charge.",
    columns: [
      "code", "name", "nameAr", "category", "acquiredOn", "costMinor", "residualMinor",
      "method", "usefulLifeMonths", "ratePercent", "assetAccount", "accumAccount",
      "expenseAccount", "accumulatedMinor", "depreciatedTo", "status", "disposedOn", "proceedsMinor",
    ],
    rows: assets.map((a) => [
      a.code, a.name, str(a.nameAr), a.category, iso(a.acquiredOn),
      a.costMinor.toString(), a.residualMinor.toString(), a.method, String(a.usefulLifeMonths),
      a.ratePercent ? a.ratePercent.toString() : "", a.assetAccount, a.accumAccount, a.expenseAccount,
      a.accumulatedMinor.toString(), str(a.depreciatedTo), a.status,
      isoOrEmpty(a.disposedOn), num(a.proceedsMinor),
    ]),
  };

  const leaseTable: ExportTable = {
    key: "leases",
    label: "Lease register",
    note: "IFRS 16 leases with the right-of-use asset and the liability as they stand. The discount rate is in basis points because a lease measured with a rounded rate does not unwind to nil.",
    columns: [
      "code", "name", "lessor", "startsOn", "endsOn", "paymentMinor", "frequency",
      "discountRateBps", "initialLiabilityMinor", "initialRouMinor", "liabilityMinor",
      "accumRouDepMinor", "chargedTo", "status",
    ],
    rows: leases.map((l) => [
      l.code, l.name, str(l.lessor), iso(l.startsOn), iso(l.endsOn),
      l.paymentMinor.toString(), l.frequency, String(l.discountRateBps),
      l.initialLiabilityMinor.toString(), l.initialRouMinor.toString(),
      l.liabilityMinor.toString(), l.accumRouDepMinor.toString(), str(l.chargedTo), l.status,
    ]),
  };

  const inventoryTable: ExportTable = {
    key: "inventory",
    label: "Inventory register",
    note: "Quantity in thousandths and the value it is carried at. Cost method travels with the item because IAS 2.25 makes it a decision per class of stock, not a global setting.",
    columns: [
      "sku", "name", "nameAr", "uom", "costMethod", "nrvMinor", "quantityMilli",
      "valueMinor", "stockAccount", "cogsAccount", "varianceAccount", "status",
    ],
    rows: inventory.map((i) => [
      i.sku, i.name, str(i.nameAr), i.uom, i.costMethod, num(i.nrvMinor),
      i.quantityMilli.toString(), i.valueMinor.toString(),
      i.stockAccount, i.cogsAccount, i.varianceAccount, i.status,
    ]),
  };

  const counterpartyTable: ExportTable = {
    key: "counterparties",
    label: "Counterparties",
    note: "Customers and suppliers with their terms, TRN and credit limit. A nil credit limit means none was set, which is a different fact from a limit of nothing.",
    columns: [
      "code", "name", "nameAr", "kind", "trn", "email", "phone", "paymentTerms",
      "creditLimitMinor", "onHold", "holdReason", "currency", "status",
    ],
    rows: counterparties.map((c) => [
      c.code, c.name, str(c.nameAr), c.kind, str(c.trn), str(c.email), str(c.phone),
      String(c.paymentTerms), num(c.creditLimitMinor), bool(c.onHold), str(c.holdReason),
      c.currency, c.status,
    ]),
  };

  const tables: ExportTable[] = [
    chart, fiscalYears, periodTable, entryTable, lineTable,
    assetTable, leaseTable, inventoryTable, counterpartyTable,
  ];

  /* ---- the trial balance the export has to reproduce ---------------------- */

  // Inception to date at `to`, not merely over the export range: a trial balance
  // covering only part of the books is not a trial balance, and this is the
  // figure anybody reading the export will check it against first.
  const tb = await balances({ orgId: opts.orgId, entityId: opts.entityId, to });
  let tbDebit = 0n;
  let tbCredit = 0n;
  const trialBalance: ExportTrialBalanceRow[] = tb.rows
    .filter((r) => r.balance !== 0n)
    .map((r) => {
      if (r.balance > 0n) tbDebit += r.balance; else tbCredit += -r.balance;
      return {
        code: r.code,
        name: r.name,
        debitMinor: r.balance > 0n ? r.balance.toString() : "0",
        creditMinor: r.balance < 0n ? (-r.balance).toString() : "0",
        balanceMinor: r.balance.toString(),
      };
    });

  /* ---- the manifest ------------------------------------------------------- */

  const manifest: ExportManifest = {
    formatVersion: EXPORT_FORMAT_VERSION,
    format: opts.format,
    entityId: opts.entityId,
    currency,
    from: fromIso,
    to: toIso,
    generatedAt: generatedAt.toISOString(),
    tables: tables.map((t) => ({
      key: t.key, label: t.label, rowCount: t.rows.length, columns: t.columns, note: t.note,
    })),
    totals: {
      entryCount: entries.length,
      lineCount: lines.length,
      totalDebitMinor: totalDebit.toString(),
      totalCreditMinor: totalCredit.toString(),
      trialBalanceAsOf: toIso,
      trialBalance,
      trialBalanceDebitMinor: tbDebit.toString(),
      trialBalanceCreditMinor: tbCredit.toString(),
      trialBalanceDifferenceMinor: (tbDebit - tbCredit).toString(),
      trialBalanceBalanced: tbDebit === tbCredit,
    },
    digestAlgorithm: "sha256",
    digest: digestOf(tables),
  };

  /* ---- the files ---------------------------------------------------------- */

  const baseName = `ledger-${opts.entityId}-${fromIso ?? "start"}-to-${toIso}`;
  const files: ExportFile[] =
    opts.format === "csv"
      ? [
          {
            key: "manifest",
            name: "manifest.json",
            contentType: "application/json; charset=utf-8",
            content: JSON.stringify(manifest, null, 2),
            rowCount: null,
          },
          ...tables.map((t) => ({
            key: t.key,
            name: `${t.key}.csv`,
            contentType: "text/csv; charset=utf-8",
            content: csvText(t.columns, t.rows),
            rowCount: t.rows.length,
          })),
        ]
      : [
          {
            key: "document",
            name: `${baseName}.json`,
            contentType: "application/json; charset=utf-8",
            content: JSON.stringify(
              {
                manifest,
                tables: tables.map((t) => ({
                  key: t.key, label: t.label, note: t.note, columns: t.columns, rows: t.rows,
                })),
              },
              null,
              2,
            ),
            rowCount: tables.reduce((a, t) => a + t.rows.length, 0),
          },
        ];

  /* ---- what would make this export misread -------------------------------- */

  if (!manifest.totals.trialBalanceBalanced) {
    warnings.push(
      `The trial balance at ${toIso} does not balance: it is out by ${money(tbDebit - tbCredit, currency)} ${currency}. ` +
        `The database enforces balance at posting time, so this is a ledger defect rather than an export defect — ` +
        `report it rather than handing this export to anybody.`,
    );
  }
  if (totalDebit !== totalCredit) {
    warnings.push(
      `The journal lines in this range do not net to nil: debits ${money(totalDebit, currency)} against credits ` +
        `${money(totalCredit, currency)}. A range can legitimately cut across an entry only if the entry itself is ` +
        `unbalanced, which cannot happen — check the range and report this.`,
    );
  }
  if (iso(generatedAt) > toIso) {
    warnings.push(
      `The registers — fixed assets, leases, inventory, counterparties — are exported as they stand today, not as ` +
        `they stood on ${toIso}. They are running records: an asset carries the depreciation posted to date and an ` +
        `inventory item the cost of the stock it holds now, and neither can be rewound without replaying every ` +
        `movement. Read them alongside the journals rather than as at the end date.`,
    );
  }
  const drafts = await prisma.journalEntry.count({
    where: {
      orgId: opts.orgId, entityId: opts.entityId, status: "draft",
      ...(from || to ? { entryDate: { ...(from ? { gte: from } : {}), lte: to } } : {}),
    },
  });
  if (drafts) {
    warnings.push(
      `${drafts} draft entr${drafts === 1 ? "y is" : "ies are"} dated inside this range and ` +
        `${drafts === 1 ? "is" : "are"} not in this export, because a draft is not in the books. Post or delete ` +
        `${drafts === 1 ? "it" : "them"} before treating this as a complete extract.`,
    );
  }

  return {
    entityId: opts.entityId,
    format: opts.format,
    from: fromIso,
    to: toIso,
    currency,
    generatedAt: generatedAt.toISOString(),
    baseName,
    manifest,
    files,
    warnings,
  };
}

/* ------------------------------------------------------------ verification */

export interface ExportCheck {
  key: string;
  label: string;
  expected: string;
  actual: string;
  agrees: boolean;
  /** What to look at when it does not agree. */
  note: string;
}

export interface ExportVerification {
  intact: boolean;
  /** What the manifest inside the bundle claims. */
  digest: string;
  /** What the rows in the bundle actually hash to. */
  recomputedDigest: string;
  checks: ExportCheck[];
  /** Anything that stopped the bundle being read at all. */
  problems: string[];
}

/**
 * Re-read a bundle's manifest against the bundle, and say whether it is intact.
 *
 * Everything below is derived from `bundle.files` — the artefact — rather than
 * from the objects that produced it. A digest checked against the variables it
 * was computed from proves nothing; a digest checked against the file proves the
 * file arrived whole. That is the difference between an export somebody can rely
 * on and an export that merely claims to be reliable.
 */
export function verifyExport(bundle: {
  format: ExportFormat;
  manifest?: ExportManifest;
  files: { key: string; name: string; content: string }[];
}): ExportVerification {
  const problems: string[] = [];
  const checks: ExportCheck[] = [];
  const fail = (message: string): ExportVerification => {
    problems.push(message);
    return { intact: false, digest: "", recomputedDigest: "", checks, problems };
  };

  let manifest: ExportManifest;
  let tables: { key: string; columns: string[]; rows: string[][] }[];

  if (bundle.format === "json") {
    const doc = bundle.files.find((f) => f.key === "document");
    if (!doc) return fail("This bundle carries no JSON document, so there is nothing to check.");
    let parsed: { manifest?: ExportManifest; tables?: { key: string; columns: string[]; rows: string[][] }[] };
    try {
      parsed = JSON.parse(doc.content) as typeof parsed;
    } catch {
      return fail(
        `${doc.name} is not readable JSON. The most likely cause is a file that was cut short in transit — ` +
          `download it again rather than trusting what arrived.`,
      );
    }
    if (!parsed.manifest || !Array.isArray(parsed.tables)) {
      return fail(`${doc.name} carries no manifest and tables, so it is not a ledger export.`);
    }
    manifest = parsed.manifest;
    tables = parsed.tables;
  } else {
    const file = bundle.files.find((f) => f.key === "manifest");
    if (!file) return fail("This bundle carries no manifest.json, so there is nothing to check it against.");
    try {
      manifest = JSON.parse(file.content) as ExportManifest;
    } catch {
      return fail(
        `manifest.json is not readable JSON. The most likely cause is a file that was cut short in transit — ` +
          `download the set again rather than trusting what arrived.`,
      );
    }
    if (!Array.isArray(manifest.tables)) return fail("manifest.json carries no table list, so it is not a ledger export.");
    tables = [];
    for (const t of manifest.tables) {
      const f = bundle.files.find((x) => x.key === t.key);
      if (!f) {
        problems.push(`The manifest lists ${t.label} (${t.key}.csv) and the bundle does not contain it.`);
        continue;
      }
      const parsed = parseCsv(f.content);
      const [header = [], ...rows] = parsed;
      // A short final row is a truncated file, not a table with fewer columns.
      // Padding it keeps the digest honest about what actually arrived.
      const width = header.length;
      tables.push({ key: t.key, columns: header, rows: rows.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r)) });
    }
  }

  const recomputed = digestOf(tables);
  const check = (key: string, label: string, expected: string, actual: string, note: string) => {
    checks.push({ key, label, expected, actual, agrees: expected === actual, note });
  };

  check(
    "digest", "Digest over the exported tables", str(manifest.digest), recomputed,
    "The manifest's digest against the rows the bundle actually contains. A difference means the bundle was changed or cut short after it was written.",
  );

  if (bundle.manifest) {
    check(
      "manifest_digest", "Manifest in the bundle against the manifest on the summary",
      str(bundle.manifest.digest), str(manifest.digest),
      "The digest recorded in the file against the one this bundle was described by. They differ only if the two came from different exports.",
    );
  }

  for (const t of manifest.tables ?? []) {
    const found = tables.find((x) => x.key === t.key);
    check(
      `rows_${t.key}`, `${t.label} — row count`, String(t.rowCount), String(found ? found.rows.length : "missing"),
      "The manifest's row count for this table against the rows the bundle carries.",
    );
    check(
      `columns_${t.key}`, `${t.label} — columns`, (t.columns ?? []).join(","), (found?.columns ?? []).join(","),
      "The columns the manifest names against the header the file carries. A difference here means the file is not the table the manifest describes.",
    );
  }

  // The totals, re-derived from the rows rather than believed.
  const lineTable = tables.find((t) => t.key === "lines");
  const sumColumn = (t: typeof lineTable, column: string): bigint => {
    if (!t) return 0n;
    const i = t.columns.indexOf(column);
    if (i < 0) return 0n;
    let total = 0n;
    for (const r of t.rows) {
      const cell = (r[i] ?? "").trim();
      if (!/^-?\d+$/.test(cell || "0")) continue;
      total += BigInt(cell || "0");
    }
    return total;
  };
  check(
    "total_debit", "Total debits", str(manifest.totals?.totalDebitMinor), sumColumn(lineTable, "debitMinor").toString(),
    "The manifest's total debit against the debit column of the exported journal lines.",
  );
  check(
    "total_credit", "Total credits", str(manifest.totals?.totalCreditMinor), sumColumn(lineTable, "creditMinor").toString(),
    "The manifest's total credit against the credit column of the exported journal lines.",
  );
  check(
    "line_count", "Journal line count", String(manifest.totals?.lineCount ?? ""), String(lineTable ? lineTable.rows.length : "missing"),
    "The manifest's line count against the rows in the journal-lines table.",
  );

  const tbRows = manifest.totals?.trialBalance ?? [];
  const tbDebit = tbRows.reduce((a, r) => a + BigInt(r.debitMinor || "0"), 0n);
  const tbCredit = tbRows.reduce((a, r) => a + BigInt(r.creditMinor || "0"), 0n);
  check(
    "trial_balance_debit", "Trial balance — debits", str(manifest.totals?.trialBalanceDebitMinor), tbDebit.toString(),
    "The stated trial-balance debit total against its own rows.",
  );
  check(
    "trial_balance_credit", "Trial balance — credits", str(manifest.totals?.trialBalanceCreditMinor), tbCredit.toString(),
    "The stated trial-balance credit total against its own rows.",
  );
  check(
    "trial_balance_balanced", "Trial balance balances", tbDebit.toString(), tbCredit.toString(),
    "Debits against credits at the export's end date. A trial balance that does not balance is a ledger defect, not an export one.",
  );

  return {
    intact: problems.length === 0 && checks.every((c) => c.agrees),
    digest: str(manifest.digest),
    recomputedDigest: recomputed,
    checks,
    problems,
  };
}

/* ------------------------------------------------------------- the import */

/** What a trial-balance migration leaves behind. Shown on screen, not buried. */
export const TRIAL_BALANCE_DOES_NOT_CARRY = [
  "The transaction history behind the balances. Receivables arrive as one number; the invoices that make it up stay in the old system, along with every report that reads them. Keep the old system readable for as long as the records must be kept — it is the copy that answers “why”.",
  "The open items behind the receivables and payables control accounts. 1100 and 2000 arrive as totals, so nothing is aged and no invoice can be matched to a receipt until the individual open invoices and bills are raised.",
  "The fixed-asset register. The net book value arrives on 1500 and 1590; the assets, their lives and their remaining depreciation do not, so no depreciation run can be posted until the register is loaded.",
];

/** The order that avoids double-counting. Also stated in the module comment. */
export const MIGRATION_ORDER = [
  "Open the books: the fiscal year, its periods, and the chart of accounts the old balances will land on.",
  "Load the registers: counterparties with their open invoices and bills, fixed assets, leases and inventory.",
  "Then bring in the trial balance, dated the day before the first period you will trade in.",
];

export interface TrialBalanceRowInput {
  accountCode: string;
  /** Supply one of these, in whole minor units. */
  debitMinor?: number | bigint | string;
  creditMinor?: number | bigint | string;
}

export interface TrialBalanceImportRow {
  accountCode: string;
  accountName: string | null;
  debitMinor: string;
  creditMinor: string;
  exists: boolean;
  postable: boolean;
  problem: string | null;
}

/**
 * What an import would do, and what it did. One shape for both, because a
 * preview that does not have the shape of the thing it previews is a preview
 * of something else.
 */
export interface TrialBalanceImport {
  entityId: string;
  asOf: string;
  currency: string;
  rows: TrialBalanceImportRow[];
  totalDebitMinor: string;
  totalCreditMinor: string;
  differenceMinor: string;
  balanced: boolean;
  /** Every account named on the trial balance that this chart does not have. */
  unknownAccounts: string[];
  /** Everything that would stop this being posted, in sentences, all at once. */
  blockers: string[];
  linesToPost: number;
  doesNotCarry: string[];
  order: string[];
  alreadyImported: boolean;
  reference: string | null;
  entryId: string | null;
  /** False on a preview, true once the entry exists. */
  applied: boolean;
}

const minorOf = (v: number | bigint | string | undefined, code: string): bigint => {
  if (v === undefined || v === null || v === "") return 0n;
  if (typeof v === "number" && !Number.isInteger(v)) {
    throw new LedgerError(`The amount on ${code} must be in whole minor units, got ${v}.`);
  }
  if (typeof v === "string" && !/^-?\d+$/.test(v.trim())) {
    throw new LedgerError(`"${v}" on ${code} is not a whole number of minor units.`);
  }
  return BigInt(typeof v === "string" ? v.trim() : v);
};

/**
 * The idempotency key is the one `opening.ts` uses, deliberately.
 *
 * An opening position is a fact about an entity on a date, not about the screen
 * it was typed into. Sharing the key means the two doors into it cannot both be
 * walked through — a business that imported its balances under Opening balances
 * and then migrated a trial balance for the same date gets the second attempt
 * refused as already imported, rather than an opening position posted twice.
 */
const openingKey = (entityId: string, asOf: string) => `opening:${entityId}:${asOf}`;

async function plan(opts: {
  orgId: string;
  entityId: string;
  asOf: string;
  rows: TrialBalanceRowInput[];
}): Promise<TrialBalanceImport> {
  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
  });
  if (!book) {
    throw new LedgerError(
      "Open the books for this entity before migrating a trial balance into them. A trial balance needs a fiscal " +
        "year, a period covering the date it is dated, and a chart of accounts to land on.",
    );
  }
  const currency = book.functionalCurrency;

  const existing = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey: openingKey(opts.entityId, opts.asOf) },
    select: { id: true, series: true, number: true },
  });

  const codes = opts.rows.map((r) => r.accountCode.trim());
  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: codes } },
  });
  const byCode = new Map(accounts.map((a) => [a.code, a]));

  const blockers: string[] = [];
  const unknown: string[] = [];
  const notPostable: string[] = [];
  const archived: string[] = [];
  const duplicated: string[] = [];
  const seen = new Set<string>();
  let totalDebit = 0n;
  let totalCredit = 0n;
  let linesToPost = 0;

  const rows: TrialBalanceImportRow[] = opts.rows.map((r) => {
    const code = r.accountCode.trim();
    const debit = minorOf(r.debitMinor, code);
    const credit = minorOf(r.creditMinor, code);
    const account = byCode.get(code);
    let problem: string | null = null;

    if (seen.has(code)) {
      duplicated.push(code);
      problem = `${code} appears more than once. Two opening balances for one account is not a balance — combine the rows in the source.`;
    }
    seen.add(code);

    if (debit < 0n || credit < 0n) {
      problem ??= `${code} carries a negative amount. Put it on the other side rather than negating it.`;
    }
    if (debit !== 0n && credit !== 0n) {
      problem ??= `${code} carries both a debit and a credit. One account holds one balance.`;
    }
    if (!account) {
      unknown.push(code);
      problem ??= `${code} is not in this entity's chart of accounts.`;
    } else if (!account.isPostable) {
      notPostable.push(`${code} ${account.name}`);
      problem ??= `${code} ${account.name} is a heading. Headings roll up their children and cannot hold a balance of their own.`;
    } else if (account.status !== "active") {
      archived.push(`${code} ${account.name}`);
      problem ??= `${code} ${account.name} is archived.`;
    }

    totalDebit += debit;
    totalCredit += credit;
    if (debit !== 0n || credit !== 0n) linesToPost++;

    return {
      accountCode: code,
      accountName: account?.name ?? null,
      debitMinor: debit.toString(),
      creditMinor: credit.toString(),
      exists: Boolean(account),
      postable: account ? account.isPostable && account.status === "active" : false,
      problem,
    };
  });

  if (rows.length === 0) blockers.push("There are no balances to bring in.");

  if (duplicated.length) {
    blockers.push(
      `${duplicated.length === 1 ? "This account appears" : "These accounts appear"} more than once on the trial ` +
        `balance: ${[...new Set(duplicated)].join(", ")}. Combine the rows in the source before importing.`,
    );
  }

  // Named all at once, not one refusal per attempt. A migration that reports a
  // single unknown code per run turns a fifteen-minute job into an afternoon,
  // and the person doing it stops reading the messages by the fourth round.
  if (unknown.length) {
    const list = [...new Set(unknown)];
    blockers.push(
      `${list.length === 1 ? "This account is" : `These ${list.length} accounts are`} not in this entity's chart of ` +
        `accounts: ${list.join(", ")}. A trial balance cannot be brought in against accounts that do not exist — ` +
        `add them to the chart, or map the old codes onto codes that are already there, and import again. ` +
        `Nothing has been posted.`,
    );
  }
  if (notPostable.length) {
    blockers.push(
      `${[...new Set(notPostable)].join(", ")} ${notPostable.length === 1 ? "is a heading" : "are headings"}. ` +
        `Headings roll up their children and cannot hold a balance of their own — move the balance onto a postable account.`,
    );
  }
  if (archived.length) {
    blockers.push(
      `${[...new Set(archived)].join(", ")} ${archived.length === 1 ? "is archived" : "are archived"}, so nothing ` +
        `can be posted to ${archived.length === 1 ? "it" : "them"}. Reactivate ${archived.length === 1 ? "it" : "them"} or move the balance.`,
    );
  }

  const difference = totalDebit - totalCredit;
  if (difference !== 0n) {
    const short = difference > 0n ? "Credits" : "Debits";
    blockers.push(
      `The trial balance does not balance: ${short.toLowerCase()} are short by ` +
        `${money(difference > 0n ? difference : -difference, currency)} ${currency} ` +
        `(debits ${money(totalDebit, currency)}, credits ${money(totalCredit, currency)}). ` +
        `Nothing has been posted. The difference is in the source, not here — a system that posts the gap to a ` +
        `suspense account gives you books that balance and are wrong, and the error then becomes very hard to find ` +
        `because nothing looks broken.`,
    );
  }

  if (rows.length > 0 && linesToPost < 2) {
    blockers.push(
      "A trial balance needs at least two accounts carrying a balance. A single entry with one line is not a journal.",
    );
  }

  const date = new Date(opts.asOf);
  if (Number.isNaN(date.getTime())) {
    blockers.push(`"${opts.asOf}" is not a date.`);
  } else {
    const period = await prisma.accountingPeriod.findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, startsOn: { lte: date }, endsOn: { gte: date } },
      orderBy: [{ isAdjustment: "asc" }, { seq: "asc" }],
    });
    if (!period) {
      blockers.push(
        `No accounting period covers ${opts.asOf}. An opening position is usually dated the day before the first ` +
          `period you will trade in, so open the fiscal year containing that date first.`,
      );
    } else if (period.status !== "open") {
      blockers.push(`${period.label} is ${period.status.replace(/_/g, " ")}, so nothing can be posted into it.`);
    }
  }

  return {
    entityId: opts.entityId,
    asOf: opts.asOf,
    currency,
    rows,
    totalDebitMinor: totalDebit.toString(),
    totalCreditMinor: totalCredit.toString(),
    differenceMinor: difference.toString(),
    balanced: difference === 0n,
    unknownAccounts: [...new Set(unknown)],
    // An import that has already happened has nothing left to block: the second
    // attempt does nothing at all, which is the point of it being idempotent.
    blockers: existing ? [] : blockers,
    linesToPost,
    doesNotCarry: TRIAL_BALANCE_DOES_NOT_CARRY,
    order: MIGRATION_ORDER,
    alreadyImported: Boolean(existing),
    reference: existing ? `${existing.series}-${existing.number}` : null,
    entryId: existing ? existing.id : null,
    applied: Boolean(existing),
  };
}

/**
 * What the import would do, before it does it.
 *
 * A migration is the least reversible thing a business does with new software —
 * the entry can be reversed, the customer's confidence cannot — so this is not a
 * courtesy. Every problem is reported at once rather than one per attempt.
 */
export async function previewImport(opts: {
  orgId: string;
  entityId: string;
  asOf: string;
  rows: TrialBalanceRowInput[];
}): Promise<TrialBalanceImport> {
  return plan(opts);
}

/**
 * Bring another system's closing trial balance in as this system's opening
 * position, as a single balanced entry through `post()`.
 *
 * It posts with `source: "opening"` rather than "manual" for the reason
 * `opening.ts` does: 1100, 2000, 1200, 1350 and 2100 refuse a manual journal
 * because they belong to their subledgers, and a migrating business really does
 * have receivables and payables on the day it arrives. Refusing a migration its
 * own control-account balances would make the product unusable by anyone who has
 * been trading.
 */
export async function importTrialBalance(opts: {
  orgId: string;
  entityId: string;
  /** The balances are as at the close of this date. */
  asOf: string;
  rows: TrialBalanceRowInput[];
  actorId?: string;
}): Promise<TrialBalanceImport> {
  const planned = await plan(opts);
  if (planned.alreadyImported) return planned;
  if (planned.blockers.length) throw new LedgerError(planned.blockers.join(" "));

  const lines: PostLine[] = opts.rows
    .map((r) => {
      const code = r.accountCode.trim();
      const debit = minorOf(r.debitMinor, code);
      const credit = minorOf(r.creditMinor, code);
      // A nil balance carries no information, and post() refuses one anyway.
      if (debit === 0n && credit === 0n) return null;
      return {
        account: code,
        ...(debit !== 0n ? { debit } : { credit }),
        memo: "Opening balance migrated from a previous system",
      } as PostLine;
    })
    .filter((l): l is PostLine => l !== null);

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: opts.asOf,
    memo: `Opening position migrated from a previous system as at ${opts.asOf}`,
    source: "opening",
    sourceType: "OPENING_BALANCE",
    sourceId: opts.asOf,
    externalKey: openingKey(opts.entityId, opts.asOf),
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "OB",
    lines,
  });

  return {
    ...planned,
    blockers: [],
    alreadyImported: false,
    reference: `${entry.series}-${entry.number}`,
    entryId: entry.id,
    applied: true,
  };
}
