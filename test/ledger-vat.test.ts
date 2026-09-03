import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postInvoice } from "@/lib/server/ledger/ar";
import { postBill } from "@/lib/server/ledger/ap";
import { post } from "@/lib/server/ledger/post";
import { vatReturn } from "@/lib/server/ledger/vat";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-vat";
const ENT = "t-ent-vat";

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
    buyer: { nameEn: "Buyer" }, seller: { nameEn: "Seller", address: { emirate: "DU" } },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED", source: "EDITOR",
    compliance: { taxableEventDate: "2026-05-15", daysRemaining: 14, breached: false },
    createdAt: "2026-05-15T00:00:00Z", updatedAt: "2026-05-15T00:00:00Z",
    ...over,
  } as Invoice;
}

const box = (r: Awaited<ReturnType<typeof vatReturn>>, which: "sales" | "expenses", n: string) =>
  r[which].find((b) => b.box === n)!;

d("VAT 201 return", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // A quarter's trading: standard-rated sales, an export, a standard-rated
    // purchase, and an imported service under reverse charge.
    await postInvoice({ orgId: ORG, invoice: doc("OUTBOUND", [line(1_000_000, 50_000)]) });
    await postInvoice({ orgId: ORG, invoice: doc("OUTBOUND", [line(400_000, 0, "ZERO_EXPORT")]) });
    await postBill({ orgId: ORG, bill: doc("INBOUND", [line(200_000, 10_000)]) });
    await postBill({ orgId: ORG, bill: doc("INBOUND", [line(100_000, 0, "REVERSE_CHARGE")]) });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("puts standard-rated sales and their tax in box 1", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    expect(box(r, "sales", "1").amountMinor).toBe("1000000");
    expect(box(r, "sales", "1").vatMinor).toBe("50000");
  });

  it("puts zero-rated exports in box 4 with no tax figure at all", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    expect(box(r, "sales", "4").amountMinor).toBe("400000");
    // Not "0.00" — a zero-rated box has no tax, and saying so is different
    // from reporting a computed zero.
    expect(box(r, "sales", "4").vatMinor).toBeNull();
  });

  it("reports reverse-charge purchases on both sides, as the FTA requires", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    // Box 3 — the supply the buyer must self-account for.
    expect(box(r, "sales", "3").vatMinor).toBe("5000");
    // Box 10 — the same amount, recoverable.
    expect(box(r, "expenses", "10").amountMinor).toBe("100000");
    expect(box(r, "expenses", "10").vatMinor).toBe("5000");
  });

  it("puts standard-rated purchases and their recoverable tax in box 9", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    expect(box(r, "expenses", "9").amountMinor).toBe("200000");
    expect(box(r, "expenses", "9").vatMinor).toBe("10000");
  });

  it("computes the net position", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    // Output: 50,000 on sales + 5,000 self-accounted. Input: 10,000 charged +
    // 5,000 reclaimed. Net 40,000 payable.
    expect(r.totalOutputVatMinor).toBe("55000");
    expect(r.totalInputVatMinor).toBe("15000");
    expect(r.netVatMinor).toBe("40000");
    expect(r.payable).toBe(true);
  });

  it("reconciles to the VAT control accounts", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    expect(r.reconciliation.outputMatches).toBe(true);
    expect(r.reconciliation.inputMatches).toBe(true);
    expect(r.reconciliation.outputVatPerLedgerMinor).toBe(r.totalOutputVatMinor);
    expect(r.warnings).toEqual([]);
  });

  it("excludes anything outside the period", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-06-01", to: "2026-06-30" });
    expect(r.totalOutputVatMinor).toBe("0");
    expect(r.netVatMinor).toBe("0");
  });

  it("warns about revenue posted without a tax treatment rather than hiding it", async () => {
    // A hand-written journal straight to revenue carries no tax code. Silently
    // leaving it out of the return is how output tax gets understated.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-05-20", source: "manual",
      memo: "Miscellaneous income",
      lines: [{ account: "1010", debit: 30_000 }, { account: "4900", credit: 30_000 }],
    });
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/no tax treatment/i);
    expect(r.warnings[0]).toMatch(/4900/);
  });

  it("reports a reclaim as a negative net rather than as a payment", async () => {
    await postBill({
      orgId: ORG,
      bill: doc("INBOUND", [line(2_000_000, 100_000)], { issueDate: "2026-07-10", supplyDate: "2026-07-10" }),
    });
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-07-01", to: "2026-07-31" });
    expect(r.netVatMinor).toBe("-100000");
    expect(r.payable).toBe(false);
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-31", to: "2026-05-01" }))
      .rejects.toThrow(/ends before it starts/i);
  });
});
