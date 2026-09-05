import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { postInvoice } from "@/lib/server/ledger/ar";
import { postBill } from "@/lib/server/ledger/ap";
import { post } from "@/lib/server/ledger/post";
import { ftaAuditFile } from "@/lib/server/ledger/faf";
import { financialKpis, type Kpi } from "@/lib/server/ledger/kpi";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

/**
 * A ratio in basis points, rounded half away from zero — the one rounding the
 * whole product now uses. Reconstructing it with plain BigInt division would
 * truncate, and these assertions would then be pinning the bias rather than
 * the figure.
 */
function bps(numerator: bigint, denominator: bigint): bigint {
  const n = numerator * 10_000n;
  const d = denominator < 0n ? -denominator : denominator;
  const signed = denominator < 0n ? -n : n;
  const half = d / 2n;
  return signed >= 0n ? (signed + half) / d : -((-signed + half) / d);
}

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-faf";
const ENT = "t-ent-faf";
/** A second entity, opened with books but no TRN, for the refusal. */
const ENT_NO_TRN = "t-ent-faf-notrn";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${ORG}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Record" WHERE "orgId" = '${ORG}'`),
  ]);
}

let seq = 0;
const line = (net: number, vat: number, profile: TaxProfileCode = "STANDARD_5"): InvoiceLine => ({
  id: `l${++seq}`, lineNo: seq, description: "Item", qty: 1, unitCode: "C62",
  unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
});

function doc(direction: "OUTBOUND" | "INBOUND", lines: InvoiceLine[], over: Partial<Invoice> = {}): Invoice {
  const net = lines.reduce((a, l) => a + l.lineNetMinor, 0);
  const vat = lines.reduce((a, l) => a + l.lineVatMinor, 0);
  return {
    id: `d-${++seq}`, orgId: ORG, entityId: ENT, direction, docType: "TAX_INVOICE",
    number: `DOC-${seq}`, issueDate: "2026-05-15", supplyDate: "2026-05-15", currency: "AED",
    buyer: { nameEn: "Nakheel Retail LLC", trn: "100999888700003" },
    seller: { nameEn: "Gulf Supplies FZE", trn: "100111222300003", address: { emirate: "DU", country: "AE" } },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED", source: "EDITOR",
    compliance: { taxableEventDate: "2026-05-15", daysRemaining: 14, breached: false },
    createdAt: "2026-05-15T00:00:00Z", updatedAt: "2026-05-15T00:00:00Z",
    ...over,
  } as Invoice;
}

/** Put the document in the tenant store so the file can find its counterparty. */
async function save(inv: Invoice) {
  await db.record.create({
    data: { id: inv.id, orgId: ORG, store: "invoices", entityId: inv.entityId, data: JSON.stringify(inv) },
  });
  return inv;
}

const csvRows = (csv: string) => csv.trimEnd().split("\r\n").map((r) => r.split(","));
const kpi = (r: { kpis: Kpi[] }, key: string): Kpi => r.kpis.find((k) => k.key === key)!;

/**
 * May 2026 is the period every assertion below is hand-computed against.
 *
 *   Revenue          1,400,000  (10,000.00 standard-rated + 4,000.00 exported)
 *   Cost of sales      840,000  → gross profit 560,000, a margin of exactly 40%
 *   Operating costs    200,000  → net profit 360,000
 *   Receivables      1,450,000  Payables 210,000  Inventory 420,000
 *   VAT input           10,000  VAT output 50,000
 *
 * June and July carry the awkward cases so that May stays clean.
 */
const MAY = { from: "2026-05-01", to: "2026-05-31" };

d("FTA Audit File and financial KPIs", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
    await openFiscalYear({ orgId: ORG, entityId: ENT_NO_TRN, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT_NO_TRN });

    await db.record.create({
      data: {
        id: ENT, orgId: ORG, store: "entities", entityId: ENT,
        data: JSON.stringify({
          id: ENT, orgId: ORG, legalNameEn: "Marri Trading LLC", legalNameAr: "مرّي للتجارة ذ.م.م",
          trn: "100123456700003", tradeLicenseNo: "CN-1234567", vatRegistered: true, taxGroup: false,
          address: { emirate: "DU", country: "AE" }, defaultCurrency: "AED",
        }),
      },
    });
    await db.record.create({
      data: {
        id: ENT_NO_TRN, orgId: ORG, store: "entities", entityId: ENT_NO_TRN,
        data: JSON.stringify({
          id: ENT_NO_TRN, orgId: ORG, legalNameEn: "Unregistered Trading LLC",
          vatRegistered: false, taxGroup: false, defaultCurrency: "AED",
        }),
      },
    });

    // Stock on hand before the period opens, introduced as capital. Posted
    // through the inventory source because 1200 is a control account.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-04-30", source: "inventory",
      memo: "Opening stock introduced as capital",
      lines: [{ account: "1200", debit: 1_260_000 }, { account: "3000", credit: 1_260_000 }],
    });

    // A month's trading.
    await postInvoice({ orgId: ORG, invoice: await save(doc("OUTBOUND", [line(1_000_000, 50_000)])) });
    await postInvoice({ orgId: ORG, invoice: await save(doc("OUTBOUND", [line(400_000, 0, "ZERO_EXPORT")])) });
    await postBill({ orgId: ORG, bill: await save(doc("INBOUND", [line(200_000, 10_000)])) });
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-05-20", source: "inventory",
      memo: "Cost of goods sold for the month",
      lines: [{ account: "5000", debit: 840_000 }, { account: "1200", credit: 840_000 }],
    });

    // June: revenue reached by a hand-written journal. No invoice, no customer,
    // no tax code — the case the file has to refuse to hide.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-06-15", source: "manual",
      memo: "Miscellaneous income",
      lines: [{ account: "1010", debit: 30_000 }, { account: "4900", credit: 30_000 }],
    });

    // July: an imported service under reverse charge, on a document that is no
    // longer in the store — self-accounted tax and a missing counterparty.
    await postBill({
      orgId: ORG,
      bill: doc("INBOUND", [line(100_000, 0, "REVERSE_CHARGE")], { issueDate: "2026-07-10", supplyDate: "2026-07-10" }),
    });

    // October: a customer whose registered name contains the two characters a
    // CSV cannot carry raw.
    await postInvoice({
      orgId: ORG,
      invoice: await save(doc("OUTBOUND", [line(500_000, 25_000)], {
        issueDate: "2026-10-08", supplyDate: "2026-10-08",
        buyer: { nameEn: 'Al Marri, Sons & Co "Trading"', trn: "100777666500003" },
      })),
    });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------- the audit file */

  it("refuses to produce a file for an entity with no TRN, and names what is missing", async () => {
    await expect(ftaAuditFile({ orgId: ORG, entityId: ENT_NO_TRN, ...MAY }))
      .rejects.toThrow(/Tax Registration Number/i);
    // Not a generic failure: it says which identifier and where to put it.
    await expect(ftaAuditFile({ orgId: ORG, entityId: ENT_NO_TRN, ...MAY }))
      .rejects.toThrow(/TRN.*Entity details|Entity details/is);
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(ftaAuditFile({ orgId: ORG, entityId: ENT, from: "2026-05-31", to: "2026-05-01" }))
      .rejects.toThrow(/ends before it starts/i);
  });

  it("carries the entity's own details in the company record", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, ...MAY });
    const [company] = csvRows(f.csv);
    expect(company[0]).toBe("C");
    expect(company[1]).toBe("Marri Trading LLC");
    expect(company[3]).toBe("100123456700003");
    expect(company[4]).toBe("CN-1234567");
    expect(company[7]).toBe("2026-05-01");
    expect(company[8]).toBe("2026-05-31");
    expect(f.company.trn).toBe("100123456700003");
  });

  it("puts every journal line in the period into the general ledger section", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, ...MAY });
    const inLedger = await db.journalLine.count({
      where: { orgId: ORG, entry: { entityId: ENT, status: { in: ["posted", "reversed"] }, entryDate: { gte: new Date(MAY.from), lte: new Date(MAY.to) } } },
    });
    const ledger = f.sections.find((s) => s.key === "ledger")!;
    expect(ledger.recordCount).toBe(inLedger);
    expect(csvRows(f.csv).filter((r) => r[0] === "L").length).toBe(inLedger);
    expect(f.checks.find((c) => c.key === "ledger_rows")!.agrees).toBe(true);
  });

  it("carries the debit and credit totals its ledger footer claims", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, ...MAY });
    // 10,500.00 receivable + 4,000.00 receivable + 2,000.00 cost + 100.00 input
    // tax + 8,400.00 cost of sales.
    const ledger = f.sections.find((s) => s.key === "ledger")!;
    expect(ledger.footer[0]).toEqual({ label: "Total debit", value: "25000.00" });
    expect(ledger.footer[1]).toEqual({ label: "Total credit", value: "25000.00" });
    expect(f.checks.find((c) => c.key === "ledger_debit")!.agrees).toBe(true);
    expect(f.checks.find((c) => c.key === "ledger_credit")!.agrees).toBe(true);
  });

  it("checks every footer against the rows of the file it actually wrote", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, ...MAY });
    for (const s of f.sections) expect(s.footerAgreesWithRows).toBe(true);
    // The footers are read back out of the CSV, so the count they claim is the
    // count the file contains.
    const rows = csvRows(f.csv);
    const footers = rows.filter((r) => r[0] === "F");
    expect(footers).toHaveLength(3);
    expect(footers[2][3]).toBe(String(rows.filter((r) => r[0] === "L").length));
    expect(rows).toHaveLength(f.rowCount);
  });

  it("totals the supply section to the revenue in the accounts", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, ...MAY });
    const supply = f.sections.find((s) => s.key === "supply")!;
    expect(supply.recordCount).toBe(2);
    expect(supply.footer[0]).toEqual({ label: "Total supply value", value: "14000.00" });
    expect(supply.footer[1]).toEqual({ label: "Total output VAT", value: "500.00" });
    const check = f.checks.find((c) => c.key === "supply_value")!;
    expect(check.perFile).toBe("14000.00");
    expect(check.perLedger).toBe("14000.00");
    expect(check.agrees).toBe(true);
  });

  it("names the customer and their TRN on every supply row, from the document", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, ...MAY });
    const supplies = csvRows(f.csv).filter((r) => r[0] === "S");
    expect(supplies).toHaveLength(2);
    for (const s of supplies) {
      expect(s[1]).toBe("Nakheel Retail LLC");
      expect(s[2]).toBe("100999888700003");
    }
    // The tax treatment travels with the row: the FTA has to see how the
    // supply was treated, not just what it was worth.
    expect(supplies.map((s) => s[12]).sort()).toEqual(["STANDARD_5", "ZERO_EXPORT"]);
  });

  it("names the supplier and reports only the input tax the supplier charged", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, ...MAY });
    const purchases = csvRows(f.csv).filter((r) => r[0] === "P");
    expect(purchases).toHaveLength(1);
    expect(purchases[0][1]).toBe("Gulf Supplies FZE");
    expect(purchases[0][2]).toBe("100111222300003");
    expect(purchases[0][8]).toBe("2000.00");
    expect(purchases[0][9]).toBe("100.00");
    expect(f.checks.find((c) => c.key === "purchase_vat")!.agrees).toBe(true);
  });

  it("reconciles against the ledger on a healthy period, with nothing to warn about", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, ...MAY });
    expect(f.reconciles).toBe(true);
    expect(f.differenceMinor).toBe("0");
    expect(f.warnings).toEqual([]);
  });

  it("does not report self-accounted reverse-charge tax as input tax on a purchase", async () => {
    // July's bill is an imported service: the supplier charged nothing, and
    // both sides of the tax were raised by us. Reporting it as recoverable
    // input tax on a purchase row would double-count it against 1350.
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, from: "2026-07-01", to: "2026-07-31" });
    const purchases = csvRows(f.csv).filter((r) => r[0] === "P");
    expect(purchases).toHaveLength(1);
    expect(purchases[0][8]).toBe("1000.00");
    expect(purchases[0][9]).toBe("0.00");
    expect(f.checks.find((c) => c.key === "purchase_vat")!.agrees).toBe(true);
    expect(f.reconciles).toBe(true);
  });

  it("warns when a document in the file names no counterparty at all", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, from: "2026-07-01", to: "2026-07-31" });
    expect(f.warnings.some((w) => /name no counterparty|names no counterparty/i.test(w))).toBe(true);
    // A missing counterparty does not make the arithmetic wrong, and the file
    // says so rather than conflating the two.
    expect(f.reconciles).toBe(true);
  });

  it("asks the document store for its counterparties in chunks, never in one list", async () => {
    /*
     * The counterparty lookup used to be a single `id: { in: [...] }` over
     * every sales and purchase document in the period. That is one bind
     * parameter per document, and PostgreSQL's protocol refuses a statement
     * past 65,535 of them — so a multi-year extract, which is exactly the one
     * an auditor asks for, failed outright rather than ran slowly.
     *
     * A unit test cannot raise sixty-five thousand documents to stand on the
     * boundary, so what is checked here is the shape: the ids go over in
     * batches no larger than the chunk, every document is asked for, and none
     * is asked for twice or dropped between batches.
     */
    type Read = { where?: { store?: string; id?: { in?: string[] } } };
    const delegate = prisma.record as unknown as { findMany: (a: Read) => Promise<unknown> };
    const original = delegate.findMany;
    const seen: Read[] = [];
    // Restored by assignment rather than by a spy's own teardown: the Prisma
    // delegate holds its methods as own properties, and a teardown that deletes
    // one leaves every later test without it.
    delegate.findMany = (args: Read) => { seen.push(args); return original.call(prisma.record, args); };
    try {
      const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, ...MAY });
      const asked = seen
        .filter((a) => a?.where?.store === "invoices" && Array.isArray(a.where.id?.in))
        .map((a) => a.where!.id!.in!);

      expect(asked.length).toBeGreaterThan(0);
      for (const batch of asked) expect(batch.length).toBeLessThanOrEqual(5_000);

      const flat = asked.flat();
      expect(new Set(flat).size).toBe(flat.length);

      // And the answer is unchanged: every row still knows whose document it is.
      const rows = csvRows(f.csv).filter((r) => r[0] === "S" || r[0] === "P");
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r[1].length).toBeGreaterThan(0);
    } finally {
      delegate.findMany = original;
    }
  });

  it("fails to reconcile, and says why, when revenue was posted without an invoice", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, from: "2026-06-01", to: "2026-06-30" });
    expect(f.reconciles).toBe(false);
    expect(f.differenceMinor).toBe("30000");
    const check = f.checks.find((c) => c.key === "supply_value")!;
    expect(check.agrees).toBe(false);
    expect(check.perFile).toBe("0.00");
    expect(check.perLedger).toBe("300.00");
    // Two named warnings: the revenue the file cannot represent, and the
    // posting that carries no tax treatment.
    expect(f.warnings.some((w) => /Supplies against revenue/.test(w))).toBe(true);
    const untagged = f.warnings.find((w) => /no tax treatment/i.test(w));
    expect(untagged).toBeTruthy();
    expect(untagged).toMatch(/4900/);
  });

  it("produces a file for a period with no trading that still reconciles", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, from: "2026-09-01", to: "2026-09-30" });
    expect(f.reconciles).toBe(true);
    expect(f.sections.map((s) => s.recordCount)).toEqual([1, 0, 0, 0]);
    // One company record and three footers: an empty file is still a file.
    expect(f.rowCount).toBe(4);
    expect(f.preview).toHaveLength(4);
  });

  it("quotes a counterparty name that would otherwise break the file", async () => {
    const f = await ftaAuditFile({ orgId: ORG, entityId: ENT, from: "2026-10-01", to: "2026-10-31" });
    // A comma inside a field, and a quote inside that. The footers are checked
    // by re-reading the file, so a quoting bug that split one field into two
    // would show up as a footer that no longer matches its rows.
    expect(f.csv).toContain('"Al Marri, Sons & Co ""Trading"""');
    for (const s of f.sections) expect(s.footerAgreesWithRows).toBe(true);
    expect(f.reconciles).toBe(true);
    expect(f.sections.find((s) => s.key === "supply")!.footer[0].value).toBe("5000.00");
  });

  /* ------------------------------------------------------------- the KPIs */

  it("computes gross margin in whole basis points", async () => {
    const r = await financialKpis({ orgId: ORG, entityId: ENT, ...MAY });
    // Gross profit 560,000 over revenue 1,400,000 is exactly 40%.
    expect(kpi(r, "gross_margin").valueBps).toBe(4_000n);
    expect(kpi(r, "gross_margin").interpretation).toMatch(/40\.00%/);
  });

  it("computes net margin from the same profit and loss", async () => {
    const r = await financialKpis({ orgId: ORG, entityId: ENT, ...MAY });
    // 360,000 / 1,400,000 = 25.714…%, truncated to whole basis points.
    expect(kpi(r, "net_margin").valueBps).toBe(2_571n);
  });

  it("computes the current ratio from the current halves of the balance sheet", async () => {
    const r = await financialKpis({ orgId: ORG, entityId: ENT, ...MAY });
    const k = kpi(r, "current_ratio");
    // Current assets 1,880,000 (receivables 1,450,000 + stock 420,000 + input
    // tax 10,000) over current liabilities 260,000 (payables 210,000 + output
    // tax 50,000).
    expect(k.inputs[0].amountMinor).toBe("1880000");
    expect(k.inputs[1].amountMinor).toBe("260000");
    expect(k.valueBps).toBe(bps(1_880_000n, 260_000n));
    expect(k.interpretation).toMatch(/7\.23/);
  });

  it("excludes stock and prepayments from the quick ratio", async () => {
    const r = await financialKpis({ orgId: ORG, entityId: ENT, ...MAY });
    const k = kpi(r, "quick_ratio");
    expect(k.valueBps).toBe(bps(1_880_000n - 420_000n, 260_000n));
    expect(k.valueBps! < kpi(r, "current_ratio").valueBps!).toBe(true);
  });

  it("derives days sales outstanding from the real receivables ageing", async () => {
    const r = await financialKpis({ orgId: ORG, entityId: ENT, ...MAY });
    const k = kpi(r, "days_sales_outstanding");
    expect(r.days).toBe(31);
    expect(k.inputs[0].amountMinor).toBe("1450000");
    // 1,450,000 / 1,400,000 × 31 days = 32.1071… days, held in ten-thousandths
    // and read out to two places.
    expect(k.valueBps).toBe(321_071n);
    expect(k.valueBps).toBe(bps(1_450_000n * 31n, 1_400_000n));
    expect(k.interpretation).toMatch(/32\.11 days/);
  });

  it("derives days payable outstanding from the real payables ageing", async () => {
    const r = await financialKpis({ orgId: ORG, entityId: ENT, ...MAY });
    const k = kpi(r, "days_payable_outstanding");
    // 210,000 / 840,000 × 31 days = 7.75 days exactly.
    expect(k.valueBps).toBe(77_500n);
    expect(k.interpretation).toMatch(/7\.75 days/);
  });

  it("turns inventory over against the average of the period's two ends", async () => {
    const r = await financialKpis({ orgId: ORG, entityId: ENT, ...MAY });
    const k = kpi(r, "inventory_turnover");
    // Opened at 1,260,000, closed at 420,000: an average of 840,000, which is
    // exactly the cost of sales — one turn.
    expect(k.inputs[3].amountMinor).toBe("840000");
    expect(k.valueBps).toBe(10_000n);
    expect(kpi(r, "days_inventory").valueBps).toBe(310_000n);
  });

  it("computes return on equity on average equity, not closing equity", async () => {
    const r = await financialKpis({ orgId: ORG, entityId: ENT, ...MAY });
    const k = kpi(r, "return_on_equity");
    // Equity 1,260,000 at the start and 1,620,000 at the end: an average of
    // 1,440,000, on which 360,000 of profit is exactly 25%.
    expect(k.inputs[3].amountMinor).toBe("1440000");
    expect(k.valueBps).toBe(2_500n);
  });

  it("reports gearing and working capital as figures a reader can act on", async () => {
    const r = await financialKpis({ orgId: ORG, entityId: ENT, ...MAY });
    expect(kpi(r, "debt_to_equity").valueBps).toBe(bps(260_000n, 1_620_000n));
    expect(r.workingCapitalMinor).toBe("1620000");
    expect(kpi(r, "working_capital").amountMinor).toBe("1620000");
    expect(kpi(r, "working_capital").valueBps).toBeNull();
  });

  it("returns null, not zero, for a ratio whose denominator is zero, and says why", async () => {
    // August traded not at all: there is no revenue to take a margin of.
    const r = await financialKpis({ orgId: ORG, entityId: ENT, from: "2026-08-01", to: "2026-08-31" });
    const k = kpi(r, "gross_margin");
    expect(k.valueBps).toBeNull();
    expect(k.computable).toBe(false);
    expect(k.interpretation).toMatch(/no revenue/i);
    // The distinction the whole module exists for.
    expect(k.interpretation).toMatch(/not a margin of zero/i);
    expect(kpi(r, "days_sales_outstanding").valueBps).toBeNull();
    // Days inventory has the same missing denominator: nothing was charged to
    // cost of sales, so there is no consumption rate to divide the stock by.
    expect(kpi(r, "days_inventory").valueBps).toBeNull();
    expect(kpi(r, "days_inventory").interpretation).toMatch(/no cost of sales/i);

    // And the other half of the distinction: stock that did not move is a real
    // turnover of zero, not a missing number, so it is reported as 0 and read
    // as a fact about the month.
    const turnover = kpi(r, "inventory_turnover");
    expect(turnover.valueBps).toBe(0n);
    expect(turnover.computable).toBe(true);
  });

  it("gives every ratio a plain sentence, computable or not", async () => {
    for (const period of [MAY, { from: "2026-08-01", to: "2026-08-31" }]) {
      const r = await financialKpis({ orgId: ORG, entityId: ENT, ...period });
      expect(r.kpis.length).toBeGreaterThanOrEqual(11);
      for (const k of r.kpis) {
        expect(k.interpretation.trim().length).toBeGreaterThan(20);
        expect(k.interpretation.trim().endsWith(".")).toBe(true);
        expect(k.basis.trim().length).toBeGreaterThan(0);
        expect(k.inputs.length).toBeGreaterThan(0);
        // A number with no denominator is null everywhere, never Infinity or NaN.
        if (k.unit !== "MONEY" && !k.computable) expect(k.valueBps).toBeNull();
      }
    }
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(financialKpis({ orgId: ORG, entityId: ENT, from: "2026-05-31", to: "2026-05-01" }))
      .rejects.toThrow(/ends before it starts/i);
  });
});
