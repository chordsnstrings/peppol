import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postBill, postSupplierPayment, payablesAgeing } from "@/lib/server/ledger/ap";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { LedgerError } from "@/lib/server/ledger/post";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-ap";
const ENT = "t-ent-ap";

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
function line(net: number, vat: number, profile: TaxProfileCode = "STANDARD_5"): InvoiceLine {
  return {
    id: `l${++seq}`, lineNo: seq, description: "Supply", qty: 1, unitCode: "C62",
    unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
  };
}

function bill(over: Partial<Invoice> = {}, lines: InvoiceLine[] = [line(100_000, 5_000)]): Invoice {
  const net = lines.reduce((a, l) => a + l.lineNetMinor, 0);
  const vat = lines.reduce((a, l) => a + l.lineVatMinor, 0);
  return {
    id: `bill-${++seq}`, orgId: ORG, entityId: ENT, direction: "INBOUND", docType: "TAX_INVOICE",
    number: `BILL-${seq}`, issueDate: "2026-04-08", supplyDate: "2026-04-08", currency: "AED",
    buyer: { nameEn: "Our Company" }, seller: { nameEn: "Gulf Supplies LLC" },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED",
    source: "INGEST",
    compliance: { taxableEventDate: "2026-04-08", daysRemaining: 14, breached: false },
    createdAt: "2026-04-08T00:00:00Z", updatedAt: "2026-04-08T00:00:00Z",
    ...over,
  } as Invoice;
}

async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { lineNo: "asc" } });
  const out: Record<string, bigint> = {};
  for (const r of rows) out[r.account.code] = (out[r.account.code] ?? 0n) + r.txnAmountMinor;
  return out;
}

d("payables subledger", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("turns a supplier bill into expense, recoverable VAT and a payable", async () => {
    const r = await postBill({ orgId: ORG, bill: bill() });
    expect(await linesOf(r.entryId)).toEqual({
      "6900": 100_000n,   // Dr expense — net
      "1350": 5_000n,     // Dr recoverable input VAT
      "2000": -105_000n,  // Cr payable — gross
    });
  });

  it("routes a line to the account a caller codes it to", async () => {
    const r = await postBill({
      orgId: ORG,
      bill: bill({ number: "BILL-RENT" }, [line(80_000, 4_000)]),
      accountFor: () => "6100", // rent
    });
    const l = await linesOf(r.entryId);
    expect(l["6100"]).toBe(80_000n);
    expect(l["6900"]).toBeUndefined();
  });

  it("routes stock to inventory rather than to expense", async () => {
    const r = await postBill({
      orgId: ORG,
      bill: bill({ number: "BILL-STOCK" }, [line(60_000, 3_000)]),
      accountFor: () => "1200", // inventory is a control account…
    });
    const l = await linesOf(r.entryId);
    // …and the subledger is allowed through it, exactly as with 1100 and 2000.
    expect(l["1200"]).toBe(60_000n);
  });

  it("self-accounts for reverse charge on both sides", async () => {
    // An imported service: the supplier charges nothing, and the buyer books
    // both the output tax it owes and the input tax it reclaims. Getting this
    // wrong understates output VAT even though no cash moves.
    const r = await postBill({
      orgId: ORG,
      bill: bill({ number: "BILL-RC" }, [line(200_000, 0, "REVERSE_CHARGE")]),
    });
    const l = await linesOf(r.entryId);
    expect(l["6250"]).toBe(200_000n);    // Dr the imported service
    expect(l["2000"]).toBe(-200_000n);   // Cr the supplier — no VAT on their bill
    expect(l["2100"]).toBe(-10_000n);    // Cr output VAT — self-accounted, 5%
    expect(l["1350"]).toBe(10_000n);     // Dr input VAT — reclaimed
    expect(r.reverseChargeMinor).toBe("10000");
  });

  it("does not invent reverse charge on an ordinary bill", async () => {
    const r = await postBill({ orgId: ORG, bill: bill({ number: "BILL-PLAIN" }) });
    expect(r.reverseChargeMinor).toBe("0");
    expect((await linesOf(r.entryId))["2100"]).toBeUndefined();
  });

  it("handles a bill that mixes reverse charge with ordinary VAT", async () => {
    const r = await postBill({
      orgId: ORG,
      bill: bill({ number: "BILL-MIX" }, [line(100_000, 5_000), line(40_000, 0, "REVERSE_CHARGE")]),
    });
    const l = await linesOf(r.entryId);
    expect(l["2000"]).toBe(-145_000n);          // owed: 100,000 + 5,000 VAT + 40,000
    expect(l["2100"]).toBe(-2_000n);            // self-accounted on the 40,000 only
    expect(l["1350"]).toBe(5_000n + 2_000n);    // supplier's VAT plus the reclaim
  });

  it("posts the same bill twice without paying for it twice", async () => {
    const b = bill({ number: "BILL-DUP" });
    const first = await postBill({ orgId: ORG, bill: b });
    const second = await postBill({ orgId: ORG, bill: b });
    expect(second.alreadyPosted).toBe(true);
    expect(second.entryId).toBe(first.entryId);
  });

  it("flips every side for a supplier credit note", async () => {
    const r = await postBill({ orgId: ORG, bill: bill({ docType: "TAX_CREDIT_NOTE", number: "SCN-1" }) });
    expect(await linesOf(r.entryId)).toEqual({
      "6900": -100_000n,
      "1350": -5_000n,
      "2000": 105_000n,
    });
  });

  it("refuses a sales invoice through the payables subledger", async () => {
    await expect(postBill({ orgId: ORG, bill: bill({ direction: "OUTBOUND" }) })).rejects.toThrow(LedgerError);
  });

  it("refuses a bill whose lines do not add up", async () => {
    const b = bill({ number: "BILL-BAD" });
    b.totals.payableMinor = 999_999;
    await expect(postBill({ orgId: ORG, bill: b })).rejects.toThrow(/does not add up/i);
  });

  it("settles a supplier payment against the payable", async () => {
    const b = bill({ number: "BILL-PAY" });
    await postBill({ orgId: ORG, bill: b });
    const r = await postSupplierPayment({
      orgId: ORG, entityId: ENT, billId: b.id, billNumber: b.number,
      paymentId: "sp-1", paidOn: "2026-04-20", bankAmountMinor: 105_000,
    });
    expect(await linesOf(r.entryId)).toEqual({ "2000": 105_000n, "1010": -105_000n });
  });

  it("books the exchange difference when less leaves the bank than was owed", async () => {
    const b = bill({ number: "BILL-FX" });
    await postBill({ orgId: ORG, bill: b });
    const r = await postSupplierPayment({
      orgId: ORG, entityId: ENT, billId: b.id, billNumber: b.number,
      paymentId: "sp-fx", paidOn: "2026-04-21",
      bankAmountMinor: 104_800, clearedAmountMinor: 105_000,
    });
    const l = await linesOf(r.entryId);
    expect(l["4950"]).toBe(-200n); // paying less than owed is a gain
  });

  it("ages payables and drops what has been paid", async () => {
    const ageing = await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-30") });
    // Owed amounts are reported positive even though the ledger holds them
    // on the credit side.
    expect(BigInt(ageing.totalMinor)).toBeGreaterThan(0n);
    expect(ageing.open.some((o) => BigInt(o.outstandingMinor) > 0n)).toBe(true);
    // A bill that has been paid nets to zero and leaves the report.
    expect(ageing.open.find((o) => o.memo.includes("BILL-PAY"))).toBeUndefined();
    // An unapplied supplier credit note is a genuine debit on payables — the
    // supplier owes us. It belongs in the report as a negative, not hidden:
    // netting it away silently is how a credit goes unclaimed.
    const credit = ageing.open.find((o) => o.memo.includes("SCN-1"));
    expect(credit).toBeDefined();
    expect(BigInt(credit!.outstandingMinor)).toBe(-105_000n);
    const detail = ageing.open.reduce((a, o) => a + BigInt(o.outstandingMinor), 0n);
    expect(detail.toString()).toBe(ageing.totalMinor);
  });

  it("keeps the trial balance tied after everything above", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-04" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });
});
