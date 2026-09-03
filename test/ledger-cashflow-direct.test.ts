import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { directCashFlow, lineFor } from "@/lib/server/ledger/cashflow-direct";
import { post, reverse } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { LedgerError } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-cfd";
const ENT = "t-ent-cfd";
const S = { orgId: ORG, entityId: ENT };

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
    db.$executeRawUnsafe(`DELETE FROM "Dimension" WHERE "orgId" = '${ORG}'`),
  ]);
}

describe("which line a contra account puts the cash on", () => {
  it("reads receivables as customer receipts and payables as supplier payments", () => {
    expect(lineFor("1100")).toBe("receipts_from_customers");
    expect(lineFor("2000")).toBe("payments_to_suppliers");
  });

  it("prefers a named account to its prefix", () => {
    // 1350 is VAT input, not the "13" prefix's supplier payments; 1500 is
    // property, plant and equipment and stays investing.
    expect(lineFor("1350")).toBe("vat_paid");
    expect(lineFor("1300")).toBe("payments_to_suppliers");
    expect(lineFor("1500")).toBe("investing");
  });

  it("puts wages and end-of-service with employees, and capital with financing", () => {
    expect(lineFor("5100")).toBe("payments_to_employees");
    expect(lineFor("2250")).toBe("payments_to_employees");
    expect(lineFor("3000")).toBe("financing");
  });

  it("has an answer for an account nothing names", () => {
    expect(lineFor("9999")).toBe("other_operating");
  });
});

d("the direct method", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ ...S, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("refuses a period that ends before it starts", async () => {
    await expect(directCashFlow({ ...S, from: "2026-06-30", to: "2026-01-01" }))
      .rejects.toThrow(LedgerError);
  });

  it("attributes an unambiguous receipt and payment to their own lines", async () => {
    // A customer pays 10,000.00 against their account, and a supplier is paid
    // 4,000.00 against theirs.
    await post({
      ...S, entryDate: new Date("2026-02-05"), source: "receipt", memo: "Receipt",
      externalKey: "cfd:receipt", series: "JV",
      lines: [{ account: "1010", debit: 1_000_000n }, { account: "1100", credit: 1_000_000n }],
    });
    await post({
      ...S, entryDate: new Date("2026-02-06"), source: "payment", memo: "Payment",
      externalKey: "cfd:payment", series: "JV",
      lines: [{ account: "2000", debit: 400_000n }, { account: "1010", credit: 400_000n }],
    });

    const r = await directCashFlow({ ...S, from: "2026-02-01", to: "2026-02-28" });
    const by = new Map(r.operating.map((o) => [o.line, o.amountMinor]));
    expect(by.get("receipts_from_customers")).toBe(1_000_000n);
    expect(by.get("payments_to_suppliers")).toBe(-400_000n);
    expect(r.netOperatingMinor).toBe(600_000n);
    expect(r.reconciles).toBe(true);
    expect(r.differenceMinor).toBe(0n);
    expect(r.mixedEntries).toBe(0);
  });

  it("presents payments as negative figures, because the statement has to add up", async () => {
    const r = await directCashFlow({ ...S, from: "2026-02-01", to: "2026-02-28" });
    expect(r.operating.every((o) => o.amountMinor !== 0n)).toBe(true);
    expect(r.netCashMovementMinor).toBe(r.cashMovementPerLedgerMinor);
  });

  it("splits a payment run across its bills without losing a fil", async () => {
    // One bank line of 1,000.00 settling three payables of 333.33, 333.33 and
    // 333.34. Every part is a supplier payment, so the whole 1,000.00 lands on
    // one line and nothing is lost to rounding.
    await post({
      ...S, entryDate: new Date("2026-03-04"), source: "payment", memo: "Payment run",
      externalKey: "cfd:run", series: "JV",
      lines: [
        { account: "2000", debit: 33_333n },
        { account: "2000", debit: 33_333n },
        { account: "2000", debit: 33_334n },
        { account: "1010", credit: 100_000n },
      ],
    });
    const r = await directCashFlow({ ...S, from: "2026-03-01", to: "2026-03-31" });
    const by = new Map(r.operating.map((o) => [o.line, o.amountMinor]));
    expect(by.get("payments_to_suppliers")).toBe(-100_000n);
    expect(r.reconciles).toBe(true);
    // Alike lines are not a mixed entry, however many of them there are.
    expect(r.mixedEntries).toBe(0);
  });

  it("splits an entry of differing character and says that it did", async () => {
    // 1,500.00 out of the bank: 1,000.00 to a supplier and 500.00 for a machine.
    await post({
      ...S, entryDate: new Date("2026-04-02"), source: "payment", memo: "Mixed",
      externalKey: "cfd:mixed", series: "JV",
      lines: [
        { account: "2000", debit: 100_000n },
        { account: "1500", debit: 50_000n },
        { account: "1010", credit: 150_000n },
      ],
    });
    const r = await directCashFlow({ ...S, from: "2026-04-01", to: "2026-04-30" });
    const by = new Map(r.operating.map((o) => [o.line, o.amountMinor]));
    expect(by.get("payments_to_suppliers")).toBe(-100_000n);
    expect(r.investingMinor).toBe(-50_000n);
    expect(r.mixedEntries).toBe(1);
    expect(r.warnings.some((w) => w.includes("differing character"))).toBe(true);
    expect(r.reconciles).toBe(true);
  });

  it("apportions to the exact cash line where the split does not divide", async () => {
    // 100.01 out of the bank against two payables of 33.34 and 66.67. Neither
    // third is exact; largest remainder makes the parts add back to 100.01.
    await post({
      ...S, entryDate: new Date("2026-05-02"), source: "payment", memo: "Odd split",
      externalKey: "cfd:odd", series: "JV",
      lines: [
        { account: "2000", debit: 3_334n },
        { account: "1500", debit: 6_667n },
        { account: "1010", credit: 10_001n },
      ],
    });
    const r = await directCashFlow({ ...S, from: "2026-05-01", to: "2026-05-31" });
    const by = new Map(r.operating.map((o) => [o.line, o.amountMinor]));
    expect((by.get("payments_to_suppliers") ?? 0n) + r.investingMinor).toBe(-10_001n);
    expect(r.reconciles).toBe(true);
    expect(r.differenceMinor).toBe(0n);
  });

  it("treats a transfer between two cash accounts as no flow at all", async () => {
    await post({
      ...S, entryDate: new Date("2026-06-03"), source: "manual", memo: "To the deposit account",
      externalKey: "cfd:transfer", series: "JV",
      lines: [{ account: "1020", debit: 500_000n }, { account: "1010", credit: 500_000n }],
    });
    const r = await directCashFlow({ ...S, from: "2026-06-01", to: "2026-06-30" });
    // Both legs are cash, so the entry nets to nil and reaches no section.
    expect(r.unattributedMinor).toBe(0n);
    expect(r.netCashMovementMinor).toBe(0n);
    expect(r.cashMovementPerLedgerMinor).toBe(0n);
    expect(r.operating).toEqual([]);
  });

  it("agrees with the indirect statement on operating cash flow", async () => {
    const r = await directCashFlow({ ...S, from: "2026-01-01", to: "2026-12-31" });
    expect(r.reconciliation.agreesWithDirect).toBe(true);
    expect(r.reconciliation.differenceMinor).toBe(0n);
    expect(r.reconciliation.netOperatingIndirectMinor).toBe(r.netOperatingMinor);
  });

  it("accounts for every dirham the cash accounts moved", async () => {
    const r = await directCashFlow({ ...S, from: "2026-01-01", to: "2026-12-31" });
    const parts = r.netOperatingMinor + r.investingMinor + r.financingMinor + r.unattributedMinor;
    expect(parts).toBe(r.netCashMovementMinor);
    expect(r.netCashMovementMinor).toBe(r.cashMovementPerLedgerMinor);
    expect(r.reconciles).toBe(true);
  });

  it("counts a reversal, and the entry it reversed, so the two cancel", async () => {
    const before = await directCashFlow({ ...S, from: "2026-01-01", to: "2026-12-31" });
    const e = await post({
      ...S, entryDate: new Date("2026-07-01"), source: "receipt", memo: "To reverse",
      externalKey: "cfd:tocancel", series: "JV",
      lines: [{ account: "1010", debit: 700_000n }, { account: "1100", credit: 700_000n }],
    });
    await reverse({ orgId: ORG, entryId: e.id, entryDate: new Date("2026-07-01"), memo: "The reversal" });
    const after = await directCashFlow({ ...S, from: "2026-01-01", to: "2026-12-31" });
    // Filtering to "posted" alone would drop one side and move the figure by
    // the full 7,000.00.
    expect(after.netOperatingMinor).toBe(before.netOperatingMinor);
    expect(after.reconciles).toBe(true);
  });

  it("keeps one organisation out of another's cash", async () => {
    await expect(directCashFlow({ orgId: "t-org-cfd-2", entityId: ENT, from: "2026-01-01", to: "2026-12-31" }))
      .rejects.toThrow(/No ledger has been opened/);
  });
});
