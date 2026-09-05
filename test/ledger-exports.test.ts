import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post, reverse } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import {
  exportLedger, verifyExport, previewImport, importTrialBalance,
  type LedgerExportBundle,
  MAX_EXPORT_ENTRIES,
} from "@/lib/server/ledger/exports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-exp";
const ENT = "t-ent-exp";
/** A second tenant holding an entity of the *same id*, for the isolation test. */
const ORG2 = "t-org-exp-other";

/**
 * A balance past 2^53 minor units (9,007,199,254,740,992). A JS number cannot
 * hold this one, which is the whole reason every amount leaves here as a string.
 */
const HUGE = 12_345_678_901_234_567n;

async function wipeOrg(org: string) {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${org}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "DimensionValue" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "Dimension" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryMovement" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryLayer" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryItem" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "FixedAsset" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "Lease" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "Counterparty" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "Record" WHERE "orgId" = '${org}'`),
  ]);
}
const wipe = async () => { await wipeOrg(ORG); await wipeOrg(ORG2); };

/* ------------------------------------------------------------------ helpers */

interface DocTable { key: string; label: string; columns: string[]; rows: string[][] }

/** The tables out of a JSON bundle, read the way an outside reader would. */
function tablesOf(bundle: LedgerExportBundle): Map<string, DocTable> {
  const file = bundle.files.find((f) => f.key === "document");
  if (!file) throw new Error("that bundle is not a JSON document");
  const doc = JSON.parse(file.content) as { tables: DocTable[] };
  return new Map(doc.tables.map((t) => [t.key, t]));
}

const cell = (t: DocTable, row: string[], column: string) => row[t.columns.indexOf(column)];
const column = (t: DocTable, name: string) => t.rows.map((r) => cell(t, r, name));

/** A minimal RFC 4180 reader, so the CSV set is checked as a reader would read it. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Cut a file short, the way a half-finished download or a truncated disk write does. */
function truncate(bundle: LedgerExportBundle, key: string, keep: number): LedgerExportBundle {
  return {
    ...bundle,
    files: bundle.files.map((f) =>
      f.key === key ? { ...f, content: f.content.slice(0, Math.floor(f.content.length * keep)) } : f,
    ),
  };
}

const FULL = { from: "2026-01-01", to: "2026-12-31" };

/** A balanced closing trial balance from the system being left behind. */
const MIGRATION = [
  { accountCode: "1010", debitMinor: "8500000" },
  { accountCode: "1100", debitMinor: "4200000" },  // a control account
  { accountCode: "2000", creditMinor: "5600000" }, // and another
  { accountCode: "3000", creditMinor: "7100000" },
];

d("ledger export and migration", () => {
  let reversedRef = "";
  let reversalRef = "";

  beforeAll(async () => {
    await wipe();

    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2025", startsOn: "2025-01-01" });
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // A dimension, so the lines table has analysis to carry.
    const dim = await db.dimension.create({
      data: { orgId: ORG, code: "COST_CENTRE", name: "Cost centre" },
    });
    await db.dimensionValue.createMany({
      data: [
        { orgId: ORG, dimensionId: dim.id, code: "OPS", name: "Operations" },
        { orgId: ORG, dimensionId: dim.id, code: "ADMIN", name: "Administration" },
      ],
    });

    // Stock introduced as capital. 1200 is a control account, so it is reached
    // through its own subledger source rather than by a manual journal.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-01-15", source: "inventory",
      memo: "Opening stock introduced as capital",
      lines: [{ account: "1200", debit: 1_260_000 }, { account: "3000", credit: 1_260_000 }],
    });

    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-02-10", source: "manual", memo: "February rent",
      lines: [
        { account: "6100", debit: 500_000, dimensions: { COST_CENTRE: "OPS" } },
        { account: "1010", credit: 500_000 },
      ],
    });

    // The balance a JS number cannot hold.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-03-31", source: "manual",
      memo: "Group capital injection",
      lines: [{ account: "1000", debit: HUGE }, { account: "3000", credit: HUGE }],
    });

    // An entry and its reversal. Both belong in an export: both happened.
    const wrong = await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-04-10", source: "manual",
      memo: "Miscoded sundry expense",
      lines: [{ account: "6900", debit: 10_000 }, { account: "1010", credit: 10_000 }],
    });
    reversedRef = `${wrong.series}-${wrong.number}`;
    const back = await reverse({ orgId: ORG, entryId: wrong.id, entryDate: "2026-04-20" });
    reversalRef = `${back.series}-${back.number}`;

    // Outside the narrow range used by the range test.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-11-15", source: "manual", memo: "November insurance",
      lines: [{ account: "6500", debit: 90_000 }, { account: "1010", credit: 90_000 }],
    });

    // A draft, which is not in the books and must not be in the export.
    const period = await db.accountingPeriod.findFirstOrThrow({
      where: { orgId: ORG, entityId: ENT, label: "2026-05" },
    });
    const book = await db.book.findFirstOrThrow({ where: { orgId: ORG, entityId: ENT, code: "PRIMARY" } });
    await db.journalEntry.create({
      data: {
        orgId: ORG, entityId: ENT, bookId: book.id, periodId: period.id,
        series: "GJ", number: "9000", entryDate: new Date("2026-05-05"),
        status: "draft", memo: "Never posted",
      },
    });

    // The registers.
    await db.fixedAsset.create({
      data: {
        orgId: ORG, entityId: ENT, code: "FA-001", name: "Delivery van",
        acquiredOn: new Date("2026-01-05"), costMinor: 12_000_000n, residualMinor: 2_000_000n,
        usefulLifeMonths: 60, accumulatedMinor: 500_000n, depreciatedTo: "2026-03",
      },
    });
    await db.lease.create({
      data: {
        orgId: ORG, entityId: ENT, code: "LSE-001", name: "Warehouse", lessor: "Jebel Ali Free Zone",
        startsOn: new Date("2026-01-01"), endsOn: new Date("2028-12-31"),
        paymentMinor: 1_500_000n, discountRateBps: 550,
        initialLiabilityMinor: 49_000_000n, initialRouMinor: 49_000_000n, liabilityMinor: 46_000_000n,
      },
    });
    await db.inventoryItem.create({
      data: {
        orgId: ORG, entityId: ENT, sku: "SKU-1", name: "Steel bracket",
        quantityMilli: 1_500n, valueMinor: 420_000n,
      },
    });
    // A name carrying the two characters a CSV cannot hold raw.
    await db.counterparty.create({
      data: {
        orgId: ORG, entityId: ENT, code: "CP-001", name: 'Al Marri, Sons & Co "Trading"',
        kind: "CUSTOMER", trn: "100999888700003", paymentTerms: 45, creditLimitMinor: 5_000_000n,
      },
    });

    // The other tenant's books, under an entity with the very same id.
    await openFiscalYear({ orgId: ORG2, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG2, entityId: ENT });
    await post({
      orgId: ORG2, entityId: ENT, entryDate: "2026-02-02", source: "manual",
      memo: "BELONGS TO THE OTHER TENANT",
      lines: [{ account: "1010", debit: 77_700 }, { account: "3000", credit: 77_700 }],
    });
  });

  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------------ the export */

  it("refuses a range too large to build in memory, and says what to do", async () => {
    // The whole export is assembled as one object before it is handed over, so
    // the size is bounded here rather than discovered by the process being
    // killed — which looks to the user exactly like the button not working.
    // The cap is an argument as well as a constant, because how much can be
    // held in memory is a property of where this runs.
    await expect(exportLedger({ orgId: ORG, entityId: ENT, format: "csv", maxEntries: 0 }))
      .rejects.toThrow(/journal entries, and an export is built whole in memory/);
    await expect(exportLedger({ orgId: ORG, entityId: ENT, format: "csv", maxEntries: 0 }))
      .rejects.toThrow(/Give a start date/);
  });

  it("carries the whole range when it is inside the cap", async () => {
    const bundle = await exportLedger({ orgId: ORG, entityId: ENT, format: "csv", maxEntries: MAX_EXPORT_ENTRIES });
    expect(bundle.files.some((f) => f.name.includes("entries"))).toBe(true);
    expect(bundle.manifest.tables.find((t) => t.key === "entries")!.rowCount).toBeGreaterThan(0);
  });


  it("exports the chart, the calendar, the journals and every register as named tables", async () => {
    const b = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "json" });
    const t = tablesOf(b);
    expect([...t.keys()].sort()).toEqual([
      "accounts", "counterparties", "entries", "fiscal_years", "fixed_assets",
      "inventory", "leases", "lines", "periods",
    ]);

    const accounts = await db.account.count({ where: { orgId: ORG, entityId: ENT } });
    expect(t.get("accounts")!.rows).toHaveLength(accounts);
    // Two fiscal years, twelve periods and an adjustment period in each.
    expect(t.get("fiscal_years")!.rows).toHaveLength(2);
    expect(t.get("periods")!.rows).toHaveLength(26);
    expect(t.get("fixed_assets")!.rows).toHaveLength(1);
    expect(t.get("leases")!.rows).toHaveLength(1);
    expect(t.get("inventory")!.rows).toHaveLength(1);
    expect(t.get("counterparties")!.rows).toHaveLength(1);

    // The chart travels with its tree intact, by code rather than by id.
    const chart = t.get("accounts")!;
    const cash = chart.rows.find((r) => cell(chart, r, "code") === "1000")!;
    expect(cell(chart, cash, "parentCode")).toBe("10");
    expect(cell(chart, cash, "isPostable")).toBe("true");
    const receivables = chart.rows.find((r) => cell(chart, r, "code") === "1100")!;
    expect(cell(chart, receivables, "isControl")).toBe("true");
  });

  it("carries a line's dimensions with it, so the analysis survives the move", async () => {
    const t = tablesOf(await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "json" }));
    const lines = t.get("lines")!;
    const rent = lines.rows.find((r) => cell(lines, r, "accountCode") === "6100")!;
    expect(cell(lines, rent, "dimensions")).toBe("COST_CENTRE=OPS");
    expect(cell(lines, rent, "debitMinor")).toBe("500000");
    expect(cell(lines, rent, "creditMinor")).toBe("0");
  });

  it("keeps a reversed entry and the entry that reversed it, both", async () => {
    const t = tablesOf(await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "json" }));
    const entries = t.get("entries")!;
    const original = entries.rows.find((r) => cell(entries, r, "reference") === reversedRef)!;
    const reversal = entries.rows.find((r) => cell(entries, r, "reference") === reversalRef)!;
    expect(cell(entries, original, "status")).toBe("reversed");
    expect(cell(entries, reversal, "status")).toBe("posted");
    expect(cell(entries, reversal, "reversalOf")).toBe(reversedRef);
  });

  it("leaves drafts out, and says so, because a draft is not in the books", async () => {
    const b = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "json" });
    const entries = tablesOf(b).get("entries")!;
    expect(column(entries, "memo")).not.toContain("Never posted");
    expect(b.warnings.some((w) => /draft entr/i.test(w))).toBe(true);
  });

  it("gives the manifest the ledger's own totals", async () => {
    const b = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "json" });

    const lines = await db.journalLine.findMany({
      where: {
        orgId: ORG,
        entry: {
          entityId: ENT, status: { in: ["posted", "reversed"] },
          entryDate: { gte: new Date(FULL.from), lte: new Date(FULL.to) },
        },
      },
      select: { functionalAmountMinor: true },
    });
    const debit = lines.filter((l) => l.functionalAmountMinor > 0n).reduce((a, l) => a + l.functionalAmountMinor, 0n);
    const credit = lines.filter((l) => l.functionalAmountMinor < 0n).reduce((a, l) => a - l.functionalAmountMinor, 0n);

    expect(b.manifest.totals.lineCount).toBe(lines.length);
    expect(b.manifest.totals.totalDebitMinor).toBe(debit.toString());
    expect(b.manifest.totals.totalCreditMinor).toBe(credit.toString());
    // The books balance, so the two sides of the range do too.
    expect(b.manifest.totals.totalDebitMinor).toBe(b.manifest.totals.totalCreditMinor);
    expect(b.manifest.totals.trialBalanceBalanced).toBe(true);
    expect(b.manifest.totals.trialBalanceDifferenceMinor).toBe("0");
    expect(b.manifest.currency).toBe("AED");
    expect(b.manifest.to).toBe("2026-12-31");
  });

  it("reproduces the trial balance the ledger itself holds at the end date", async () => {
    const b = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "json" });
    const tb = new Map(b.manifest.totals.trialBalance.map((r) => [r.code, r]));
    // Cash carries the untouchable balance; stock its opening value.
    expect(tb.get("1000")!.debitMinor).toBe(HUGE.toString());
    expect(tb.get("1200")!.debitMinor).toBe("1260000");
    expect(tb.get("6100")!.debitMinor).toBe("500000");
    // The reversed pair nets to nothing and therefore is not on the trial balance.
    expect(tb.has("6900")).toBe(false);
    // Share capital is a credit balance, held signed as the ledger holds it.
    expect(tb.get("3000")!.creditMinor).toBe((HUGE + 1_260_000n).toString());
    expect(tb.get("3000")!.balanceMinor).toBe((-(HUGE + 1_260_000n)).toString());
  });

  it("verifies an untouched bundle in both formats", async () => {
    for (const format of ["csv", "json"] as const) {
      const b = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format });
      const v = verifyExport(b);
      expect(v.problems).toEqual([]);
      expect(v.intact).toBe(true);
      expect(v.digest).toBe(v.recomputedDigest);
      expect(v.checks.every((c) => c.agrees)).toBe(true);
      expect(v.checks.length).toBeGreaterThan(10);
    }
  });

  it("fails verification on a truncated CSV bundle, and names the digest", async () => {
    const b = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "csv" });
    expect(verifyExport(b).intact).toBe(true);

    const cut = truncate(b, "lines", 0.6);
    const v = verifyExport(cut);
    expect(v.intact).toBe(false);
    expect(v.digest).not.toBe(v.recomputedDigest);
    expect(v.checks.find((c) => c.key === "digest")!.agrees).toBe(false);
    // And the row count it claimed is no longer the row count it carries.
    expect(v.checks.find((c) => c.key === "rows_lines")!.agrees).toBe(false);
    // The totals fail too: a truncated file is short of debits as well as rows.
    expect(v.checks.find((c) => c.key === "total_debit")!.agrees).toBe(false);
  });

  it("fails verification on a truncated JSON document rather than half-reading it", async () => {
    const b = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "json" });
    const v = verifyExport(truncate(b, "document", 0.5));
    expect(v.intact).toBe(false);
    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toMatch(/cut short|not readable JSON/i);
  });

  it("notices a bundle whose manifest was swapped for another export's", async () => {
    const a = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "csv" });
    const b = await exportLedger({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-06-30", format: "csv" });
    const frankenstein = {
      ...a,
      files: a.files.map((f) => (f.key === "manifest" ? b.files.find((x) => x.key === "manifest")! : f)),
    };
    const v = verifyExport(frankenstein);
    expect(v.intact).toBe(false);
    expect(v.checks.find((c) => c.key === "manifest_digest")!.agrees).toBe(false);
  });

  it("carries every amount as a string, losing nothing above 2^53", async () => {
    const b = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "json" });
    const lines = tablesOf(b).get("lines")!;
    const big = lines.rows.find((r) => cell(lines, r, "accountCode") === "1000")!;
    const written = cell(lines, big, "debitMinor");

    expect(typeof written).toBe("string");
    expect(written).toBe("12345678901234567");
    expect(BigInt(written)).toBe(HUGE);
    // The point of the string: the same figure as a JSON number would not come
    // back as itself.
    expect(String(Number(written))).not.toBe(written);
    expect(Number.isSafeInteger(Number(written))).toBe(false);

    // And it stays a string through a real JSON round trip, manifest included.
    const doc = JSON.parse(b.files[0].content) as {
      manifest: { totals: { totalDebitMinor: string; trialBalance: { code: string; debitMinor: string }[] } };
    };
    expect(typeof doc.manifest.totals.totalDebitMinor).toBe("string");
    const cash = doc.manifest.totals.trialBalance.find((r) => r.code === "1000")!;
    expect(typeof cash.debitMinor).toBe("string");
    expect(BigInt(cash.debitMinor)).toBe(HUGE);
    expect(BigInt(doc.manifest.totals.totalDebitMinor) > HUGE).toBe(true);
  });

  it("quotes a name a CSV cannot hold raw, and reads it back unchanged", async () => {
    const b = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "csv" });
    const file = b.files.find((f) => f.key === "counterparties")!;
    expect(file.content).toContain('"Al Marri, Sons & Co ""Trading"""');
    const rows = readCsv(file.content);
    expect(rows[1][1]).toBe('Al Marri, Sons & Co "Trading"');
    // The quoting survives its own verification, which is the only proof that
    // the writer and the reader agree.
    expect(verifyExport(b).intact).toBe(true);
  });

  it("gives the same digest for the same books, in either format", async () => {
    const first = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "csv", generatedAt: "2027-01-01T00:00:00Z" });
    const again = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "csv", generatedAt: "2027-06-01T00:00:00Z" });
    const asJson = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "json" });
    expect(first.manifest.digest).toBe(again.manifest.digest);
    expect(first.manifest.digest).toBe(asJson.manifest.digest);
    expect(first.manifest.digest).toHaveLength(64);
    // A different range is a different export.
    const narrower = await exportLedger({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-06-30", format: "csv" });
    expect(narrower.manifest.digest).not.toBe(first.manifest.digest);
  });

  it("clips the journals to the range and carries the registers whole", async () => {
    const b = await exportLedger({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-06-30", format: "json" });
    const t = tablesOf(b);
    expect(column(t.get("entries")!, "memo")).not.toContain("November insurance");
    expect(column(t.get("entries")!, "memo")).toContain("February rent");
    // A register is a running record and cannot be rewound to the end date, so
    // it is exported as it stands and the export says so.
    expect(t.get("fixed_assets")!.rows).toHaveLength(1);
    expect(b.warnings.some((w) => /registers/i.test(w) && /as they stand/i.test(w))).toBe(true);
  });

  it("names one file per table in CSV and exactly one document in JSON", async () => {
    const csv = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "csv" });
    expect(csv.files.map((f) => f.name)).toContain("manifest.json");
    expect(csv.files.map((f) => f.name)).toContain("lines.csv");
    expect(csv.files.filter((f) => f.name.endsWith(".csv"))).toHaveLength(9);
    expect(csv.baseName).toBe("ledger-t-ent-exp-2026-01-01-to-2026-12-31");

    const json = await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "json" });
    expect(json.files).toHaveLength(1);
    expect(json.files[0].contentType).toMatch(/application\/json/);
  });

  it("refuses a range that ends before it starts, an unknown format and an entity with no books", async () => {
    await expect(exportLedger({ orgId: ORG, entityId: ENT, from: "2026-12-31", to: "2026-01-01", format: "csv" }))
      .rejects.toThrow(/ends before it starts/i);
    await expect(exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "xlsx" as unknown as "csv" }))
      .rejects.toThrow(/not an export format/i);
    await expect(exportLedger({ orgId: ORG, entityId: "t-ent-exp-nobody", ...FULL, format: "csv" }))
      .rejects.toThrow(/No ledger has been opened/i);
  });

  it("exports one tenant's books and never another's, even under the same entity id", async () => {
    const mine = tablesOf(await exportLedger({ orgId: ORG, entityId: ENT, ...FULL, format: "json" }));
    const theirs = tablesOf(await exportLedger({ orgId: ORG2, entityId: ENT, ...FULL, format: "json" }));

    expect(column(mine.get("entries")!, "memo")).not.toContain("BELONGS TO THE OTHER TENANT");
    expect(column(theirs.get("entries")!, "memo")).toEqual(["BELONGS TO THE OTHER TENANT"]);
    expect(theirs.get("entries")!.rows).toHaveLength(1);
    expect(theirs.get("lines")!.rows).toHaveLength(2);
    // The registers are the other tenant's too — which is to say, empty.
    expect(theirs.get("counterparties")!.rows).toHaveLength(0);
    expect(theirs.get("fixed_assets")!.rows).toHaveLength(0);
    expect(theirs.get("fiscal_years")!.rows).toHaveLength(1);

    // A register with nothing in it is a file with a header and no rows, and it
    // still has to verify — an empty table is a fact, not a missing one.
    const empty = await exportLedger({ orgId: ORG2, entityId: ENT, ...FULL, format: "csv" });
    expect(empty.files.find((f) => f.key === "fixed_assets")!.rowCount).toBe(0);
    expect(readCsv(empty.files.find((f) => f.key === "leases")!.content)).toHaveLength(1);
    expect(verifyExport(empty).intact).toBe(true);
  });

  /* ------------------------------------------------------------ the import */

  it("says plainly what a trial balance does not carry, and in what order to do things", async () => {
    const p = await previewImport({ orgId: ORG, entityId: ENT, asOf: "2025-12-31", rows: MIGRATION });
    expect(p.doesNotCarry).toHaveLength(3);
    expect(p.doesNotCarry.join(" ")).toMatch(/transaction history/i);
    expect(p.doesNotCarry.join(" ")).toMatch(/open items/i);
    expect(p.doesNotCarry.join(" ")).toMatch(/fixed-asset register/i);
    expect(p.order).toHaveLength(3);
    expect(p.order[0]).toMatch(/Open the books/i);
    expect(p.order[1]).toMatch(/registers/i);
    expect(p.order[2]).toMatch(/trial balance/i);
  });

  it("refuses a trial balance that does not balance, and names the difference", async () => {
    const wrong = [...MIGRATION.slice(0, 3), { accountCode: "3000", creditMinor: "7075000" }];
    const p = await previewImport({ orgId: ORG, entityId: ENT, asOf: "2025-12-31", rows: wrong });
    expect(p.balanced).toBe(false);
    expect(p.differenceMinor).toBe("25000");
    expect(p.blockers.some((b) => /short by 250\.00 AED/.test(b))).toBe(true);
    expect(p.blockers.some((b) => /suspense account/i.test(b))).toBe(true);

    await expect(importTrialBalance({ orgId: ORG, entityId: ENT, asOf: "2025-12-31", rows: wrong }))
      .rejects.toThrow(/short by 250\.00/);
    await expect(importTrialBalance({ orgId: ORG, entityId: ENT, asOf: "2025-12-31", rows: wrong }))
      .rejects.toThrow(/credits are short/i);
    // Refused means refused: nothing was posted.
    expect(await db.journalEntry.count({ where: { orgId: ORG, externalKey: `opening:${ENT}:2025-12-31` } })).toBe(0);
  });

  it("names every account the chart does not have, all at once", async () => {
    const rows = [
      { accountCode: "9998", debitMinor: "100000" },
      { accountCode: "9999", debitMinor: "50000" },
      { accountCode: "3000", creditMinor: "150000" },
    ];
    const p = await previewImport({ orgId: ORG, entityId: ENT, asOf: "2025-12-31", rows });
    expect(p.unknownAccounts).toEqual(["9998", "9999"]);
    const named = p.blockers.filter((b) => /not in this entity's chart/i.test(b));
    expect(named).toHaveLength(1);
    expect(named[0]).toMatch(/9998/);
    expect(named[0]).toMatch(/9999/);
    expect(named[0]).toMatch(/Nothing has been posted/);

    await expect(importTrialBalance({ orgId: ORG, entityId: ENT, asOf: "2025-12-31", rows }))
      .rejects.toThrow(/9998, 9999/);
  });

  it("refuses a heading, which cannot hold a balance of its own", async () => {
    const rows = [{ accountCode: "1", debitMinor: "100000" }, { accountCode: "3000", creditMinor: "100000" }];
    const p = await previewImport({ orgId: ORG, entityId: ENT, asOf: "2025-12-31", rows });
    expect(p.rows[0].postable).toBe(false);
    expect(p.blockers.some((b) => /heading/i.test(b))).toBe(true);
    await expect(importTrialBalance({ orgId: ORG, entityId: ENT, asOf: "2025-12-31", rows }))
      .rejects.toThrow(/heading/i);
  });

  it("previews exactly what the import then does", async () => {
    const preview = await previewImport({ orgId: ORG, entityId: ENT, asOf: "2025-12-31", rows: MIGRATION });
    expect(preview.applied).toBe(false);
    expect(preview.reference).toBeNull();
    expect(preview.blockers).toEqual([]);
    expect(preview.balanced).toBe(true);
    expect(preview.totalDebitMinor).toBe("12700000");
    expect(preview.totalCreditMinor).toBe("12700000");
    expect(preview.linesToPost).toBe(4);
    expect(preview.rows.map((r) => r.accountName)).toEqual([
      "Bank — current account", "Trade receivables", "Trade payables", "Share capital",
    ]);

    const done = await importTrialBalance({ orgId: ORG, entityId: ENT, asOf: "2025-12-31", rows: MIGRATION });
    expect(done.applied).toBe(true);
    expect(done.reference).toMatch(/^OB-/);
    expect(done.rows).toEqual(preview.rows);
    expect(done.totalDebitMinor).toBe(preview.totalDebitMinor);
    expect(done.totalCreditMinor).toBe(preview.totalCreditMinor);
    expect(done.linesToPost).toBe(preview.linesToPost);
    expect(done.balanced).toBe(preview.balanced);
    expect(done.doesNotCarry).toEqual(preview.doesNotCarry);
  });

  it("posts the migration as one balanced entry through the ledger's own path", async () => {
    const entry = await db.journalEntry.findFirstOrThrow({
      where: { orgId: ORG, externalKey: `opening:${ENT}:2025-12-31` },
      include: { lines: { include: { account: true } } },
    });
    expect(entry.series).toBe("OB");
    expect(entry.status).toBe("posted");
    // Not "manual": the control accounts a migrating business really does have
    // balances on would refuse a manual journal.
    expect(entry.source).toBe("opening");
    expect(entry.sourceType).toBe("OPENING_BALANCE");
    expect(entry.lines).toHaveLength(4);
    expect(entry.lines.reduce((a, l) => a + l.functionalAmountMinor, 0n)).toBe(0n);
    const ar = entry.lines.find((l) => l.account.code === "1100")!;
    expect(ar.functionalAmountMinor).toBe(4_200_000n);
    expect(ar.account.isControl).toBe(true);
  });

  it("is idempotent on the entity and the date, so a retry does not double the position", async () => {
    const before = await db.journalLine.count({ where: { orgId: ORG } });
    const again = await importTrialBalance({ orgId: ORG, entityId: ENT, asOf: "2025-12-31", rows: MIGRATION });
    expect(again.alreadyImported).toBe(true);
    expect(again.applied).toBe(true);
    expect(again.reference).toMatch(/^OB-/);
    expect(again.blockers).toEqual([]);
    expect(await db.journalLine.count({ where: { orgId: ORG } })).toBe(before);
    expect(await db.journalEntry.count({ where: { orgId: ORG, externalKey: `opening:${ENT}:2025-12-31` } })).toBe(1);

    // Even a different (and wrong) trial balance for that date does nothing.
    const different = await importTrialBalance({
      orgId: ORG, entityId: ENT, asOf: "2025-12-31",
      rows: [{ accountCode: "1010", debitMinor: "1" }, { accountCode: "3000", creditMinor: "1" }],
    });
    expect(different.alreadyImported).toBe(true);
    expect(await db.journalLine.count({ where: { orgId: ORG } })).toBe(before);
  });

  it("keeps one tenant's migration out of another's books", async () => {
    await importTrialBalance({ orgId: ORG2, entityId: ENT, asOf: "2026-01-31", rows: MIGRATION });
    const mine = await db.journalEntry.count({ where: { orgId: ORG, externalKey: `opening:${ENT}:2026-01-31` } });
    const theirs = await db.journalEntry.count({ where: { orgId: ORG2, externalKey: `opening:${ENT}:2026-01-31` } });
    expect(mine).toBe(0);
    expect(theirs).toBe(1);
  });

  it("shows the migrated position in the next export, which still verifies", async () => {
    const b = await exportLedger({ orgId: ORG, entityId: ENT, to: "2026-12-31", format: "json" });
    const entries = tablesOf(b).get("entries")!;
    const opening = entries.rows.find((r) => cell(entries, r, "series") === "OB")!;
    expect(cell(entries, opening, "entryDate")).toBe("2025-12-31");
    expect(cell(entries, opening, "externalKey")).toBe(`opening:${ENT}:2025-12-31`);
    expect(cell(entries, opening, "source")).toBe("opening");

    const tb = new Map(b.manifest.totals.trialBalance.map((r) => [r.code, r]));
    expect(tb.get("1100")!.debitMinor).toBe("4200000");
    expect(tb.get("2000")!.creditMinor).toBe("5600000");
    expect(b.manifest.totals.trialBalanceBalanced).toBe(true);
    expect(verifyExport(b).intact).toBe(true);
  });
});
