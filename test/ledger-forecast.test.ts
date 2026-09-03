import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { cashForecast, cashPosition, paymentBehaviour } from "@/lib/server/ledger/forecast";
import { postInvoice, postReceipt } from "@/lib/server/ledger/ar";
import { postBill } from "@/lib/server/ledger/ap";
import { post } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import type { Invoice, InvoiceLine } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-fc";
const ENT = "t-ent-fc";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "PaymentRunItem" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "PaymentRun" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "RecurringJournal" WHERE "orgId" = '${ORG}'`),
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
const line = (net: number, vat: number): InvoiceLine => ({
  id: `l${++seq}`, lineNo: seq, description: "Supply", qty: 1, unitCode: "C62",
  unitPriceMinor: net, taxProfileCode: "STANDARD_5", lineNetMinor: net, lineVatMinor: vat,
});

function doc(over: {
  id: string; direction: "OUTBOUND" | "INBOUND"; issueDate: string; dueDate?: string;
  net: number; vat: number; party: string;
}): Invoice {
  const lines = [line(over.net, over.vat)];
  const isOut = over.direction === "OUTBOUND";
  return {
    id: over.id, orgId: ORG, entityId: ENT, direction: over.direction, docType: "TAX_INVOICE",
    number: over.id.toUpperCase(), issueDate: over.issueDate, supplyDate: over.issueDate,
    dueDate: over.dueDate, currency: "AED",
    buyer: { nameEn: isOut ? over.party : "Our Company" },
    seller: { nameEn: isOut ? "Our Company" : over.party },
    lines,
    totals: {
      taxExclusiveMinor: over.net, vatMinor: over.vat,
      taxInclusiveMinor: over.net + over.vat, payableMinor: over.net + over.vat, perCategory: [],
    },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED",
    source: "INGEST",
    compliance: { taxableEventDate: over.issueDate, daysRemaining: 14, breached: false },
    createdAt: `${over.issueDate}T00:00:00Z`, updatedAt: `${over.issueDate}T00:00:00Z`,
  } as Invoice;
}

const allLines = (f: Awaited<ReturnType<typeof cashForecast>>) => f.buckets.flatMap((b) => b.lines);
const find = (f: Awaited<ReturnType<typeof cashForecast>>, label: RegExp) =>
  allLines(f).find((l) => label.test(l.label));

d("cash flow forecast", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);

    // Money in the bank to start with.
    await post({
      ...S, entryDate: "2026-01-02", source: "manual", memo: "Owner capital",
      lines: [{ account: "1010", debit: 500_000 }, { account: "3000", credit: 500_000 }],
    });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("starts from what is actually in the bank", async () => {
    const p = await cashPosition({ ...S, asOf: "2026-03-15" });
    expect(p.totalMinor).toBe(500_000n);
    expect(p.accounts.find((a) => a.code === "1010")!.balanceMinor).toBe(500_000n);
  });

  it("expects a receivable on its own due date, not on an assumed term", async () => {
    // Sixty-day terms. On terms alone it arrives on 1 May, not on 1 April.
    await postInvoice({ orgId: ORG, invoice: doc({
      id: "inv-slow", direction: "OUTBOUND", issueDate: "2026-03-02", dueDate: "2026-05-01",
      net: 200_000, vat: 10_000, party: "Slow Payer LLC",
    }) });

    const f = await cashForecast({ ...S, from: "2026-03-15", to: "2026-06-01", bucket: "month" });
    const l = find(f, /Slow Payer/)!;
    expect(l.on).toBe("2026-05-01");
    expect(l.amountMinor).toBe(210_000n);
    expect(l.firmness).toBe("expected");
    expect(l.source).toBe("ar");
  });

  it("brings an invoice already past due forward, rather than losing it in the past", async () => {
    await postInvoice({ orgId: ORG, invoice: doc({
      id: "inv-late", direction: "OUTBOUND", issueDate: "2026-01-05", dueDate: "2026-02-04",
      net: 50_000, vat: 2_500, party: "Late Payer LLC",
    }) });

    const f = await cashForecast({ ...S, from: "2026-03-15", to: "2026-06-01", bucket: "month" });
    const l = find(f, /Late Payer/)!;
    // Dating it 4 February would put it outside the window and quietly drop it.
    expect(l.on).toBe("2026-03-15");
    expect(l.amountMinor).toBe(52_500n);
  });

  it("takes a bill out on its due date", async () => {
    await postBill({ orgId: ORG, bill: doc({
      id: "bill-1", direction: "INBOUND", issueDate: "2026-03-10", dueDate: "2026-04-09",
      net: 80_000, vat: 4_000, party: "Gulf Supplies LLC",
    }) });

    const f = await cashForecast({ ...S, from: "2026-03-15", to: "2026-06-01", bucket: "month" });
    const l = allLines(f).find((x) => x.source === "ap")!;
    expect(l.on).toBe("2026-04-09");
    expect(l.amountMinor).toBe(-84_000n);
  });

  it("runs the cash balance forward through the buckets", async () => {
    const f = await cashForecast({ ...S, from: "2026-03-15", to: "2026-06-01", bucket: "month" });
    expect(f.openingMinor).toBe(500_000n);

    // Each bucket closes where the next one opens, which is the only property
    // that makes a running balance a running balance.
    let running = f.openingMinor;
    for (const b of f.buckets) {
      running += b.netMinor;
      expect(b.closingMinor).toBe(running);
      expect(b.netMinor).toBe(b.inMinor + b.outMinor);
    }
    expect(f.closingMinor).toBe(running);
  });

  it("says when the cash runs out, and stays quiet when it does not", async () => {
    const comfortable = await cashForecast({ ...S, from: "2026-03-15", to: "2026-06-01", bucket: "month" });
    expect(comfortable.shortfallOn).toBeNull();

    // A bill far larger than the bank can cover.
    await postBill({ orgId: ORG, bill: doc({
      id: "bill-big", direction: "INBOUND", issueDate: "2026-03-11", dueDate: "2026-03-20",
      net: 900_000, vat: 45_000, party: "Big Supplier LLC",
    }) });

    const tight = await cashForecast({ ...S, from: "2026-03-15", to: "2026-06-01", bucket: "month" });
    expect(tight.shortfallOn).not.toBeNull();
    expect(tight.shortfallMinor).not.toBeNull();
    expect(tight.shortfallMinor! < 0n).toBe(true);
  });

  /* ------------------------------------------------------------- behaviour */

  it("learns how late a customer actually pays, from settled documents only", async () => {
    // Two invoices on 30-day terms, both settled ten days late.
    for (const [id, issued, due, paid] of [
      ["inv-h1", "2026-01-10", "2026-02-09", "2026-02-19"],
      ["inv-h2", "2026-01-20", "2026-02-19", "2026-03-01"],
    ] as const) {
      await postInvoice({ orgId: ORG, invoice: doc({
        id, direction: "OUTBOUND", issueDate: issued, dueDate: due,
        net: 100_000, vat: 5_000, party: "Habitual Late LLC",
      }) });
      await post({
        ...S, entryDate: paid, source: "payment", sourceType: "RECEIPT", sourceId: `rc-${id}`,
        settlesId: id, memo: `Receipt for ${id}`,
        lines: [{ account: "1010", debit: 105_000 }, { account: "1100", credit: 105_000 }],
      });
    }

    const b = await paymentBehaviour(S);
    expect(b.overall.sample).toBe(2);
    expect(b.overall.meanDays).toBe(10);

    // The still-open invoices must not be counted: a debt nobody has paid says
    // nothing about how long payment takes.
    expect(b.overall.sample).toBeLessThan(4);
  });

  it("shifts an expected receipt by that record, and labels every line it moves", async () => {
    const onTerms = await cashForecast({ ...S, from: "2026-03-15", to: "2026-07-01", bucket: "month" });
    const byTerms = find(onTerms, /Slow Payer/)!;
    expect(byTerms.on).toBe("2026-05-01");
    expect(byTerms.shiftedDays).toBeUndefined();

    const onBehaviour = await cashForecast({
      ...S, from: "2026-03-15", to: "2026-07-01", bucket: "month", basis: "behaviour",
    });
    const moved = find(onBehaviour, /Slow Payer/)!;
    expect(moved.on).toBe("2026-05-11");
    expect(moved.shiftedDays).toBe(10);
  });

  /* ---------------------------------------------------------------- guards */

  it("refuses a window that ends before it begins", async () => {
    await expect(cashForecast({ ...S, from: "2026-06-01", to: "2026-03-01" }))
      .rejects.toThrow(/end after it begins/i);
  });

  it("refuses a window so long the arithmetic stops being information", async () => {
    await expect(cashForecast({ ...S, from: "2026-01-01", to: "2028-01-01" }))
      .rejects.toThrow(/arithmetic, not information/i);
  });

  it("refuses dates it cannot read", async () => {
    await expect(cashForecast({ ...S, from: "not a date", to: "2026-06-01" }))
      .rejects.toThrow(/two dates it can read/i);
  });

  it("buckets by week when asked, covering the window without a gap or an overlap", async () => {
    const f = await cashForecast({ ...S, from: "2026-03-01", to: "2026-03-29", bucket: "week" });
    expect(f.buckets).toHaveLength(5);
    expect(f.buckets[0].from).toBe("2026-03-01");
    expect(f.buckets[0].to).toBe("2026-03-07");
    expect(f.buckets[4].to).toBe("2026-03-29");
    for (let i = 1; i < f.buckets.length; i++) {
      const prevEnd = new Date(`${f.buckets[i - 1].to}T00:00:00Z`).getTime();
      const thisStart = new Date(`${f.buckets[i].from}T00:00:00Z`).getTime();
      expect(thisStart - prevEnd).toBe(86_400_000);
    }
  });

  it("does not project another organisation's cash", async () => {
    await expect(cashForecast({ orgId: "someone-else", entityId: ENT, from: "2026-03-15", to: "2026-06-01" }))
      .rejects.toThrow(/no ledger has been opened/i);
  });
});
