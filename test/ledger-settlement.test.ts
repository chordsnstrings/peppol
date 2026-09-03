import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postBill, payablesAgeing } from "@/lib/server/ledger/ap";
import { post, reverse, LedgerError } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import type { Invoice, InvoiceLine } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-settle";
const ENT = "t-ent-settle";

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
const line = (net: number, vat: number): InvoiceLine => ({
  id: `l${++seq}`, lineNo: seq, description: "Supply", qty: 1, unitCode: "C62",
  unitPriceMinor: net, taxProfileCode: "STANDARD_5", lineNetMinor: net, lineVatMinor: vat,
});

function bill(id: string, issueDate: string, dueDate: string | undefined, net: number, vat: number): Invoice {
  const lines = [line(net, vat)];
  return {
    id, orgId: ORG, entityId: ENT, direction: "INBOUND", docType: "TAX_INVOICE",
    number: id.toUpperCase(), issueDate, supplyDate: issueDate, dueDate, currency: "AED",
    buyer: { nameEn: "Our Company" }, seller: { nameEn: "Gulf Supplies LLC" },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED",
    source: "INGEST",
    compliance: { taxableEventDate: issueDate, daysRemaining: 14, breached: false },
    createdAt: `${issueDate}T00:00:00Z`, updatedAt: `${issueDate}T00:00:00Z`,
  } as Invoice;
}

const itemOf = (ageing: Awaited<ReturnType<typeof payablesAgeing>>, id: string) =>
  ageing.open.find((o) => o.sourceId === id);

d("due dates and settlement", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("carries a document's due date onto the entry it posts", async () => {
    const r = await postBill({ orgId: ORG, bill: bill("bill-a", "2026-02-01", "2026-04-02", 100_000, 5_000) });
    const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: r.entryId } });
    expect(entry.dueDate?.toISOString().slice(0, 10)).toBe("2026-04-02");
  });

  it("tells old from overdue, which one date alone cannot", async () => {
    // Raised on 1 February on sixty-day terms. On 1 April it is two months old
    // and not yet due — the distinction the ageing could not previously make.
    const ageing = await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-01") });
    const a = itemOf(ageing, "bill-a")!;
    expect(a.daysOld).toBe(59);
    expect(a.dueDate).toBe("2026-04-02");
    expect(a.daysOverdue).toBe(0);
    expect(ageing.overdueMinor).toBe("0");

    const later = await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-20") });
    expect(itemOf(later, "bill-a")!.daysOverdue).toBe(18);
    expect(later.overdueMinor).toBe("105000");
  });

  it("leaves a document with no terms aged exactly as before", async () => {
    await postBill({ orgId: ORG, bill: bill("bill-b", "2026-03-01", undefined, 40_000, 2_000) });
    const ageing = await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-20") });
    const b = itemOf(ageing, "bill-b")!;
    expect(b.dueDate).toBeNull();
    expect(b.daysOverdue).toBe(0);
    expect(b.daysOld).toBe(50);
  });

  it("refuses a due date before the document exists, saying which way round they went", async () => {
    await expect(post({
      orgId: ORG, entityId: ENT, entryDate: "2026-03-10", dueDate: "2026-03-01", source: "manual",
      memo: "Backwards", lines: [{ account: "6900", debit: 1_000 }, { account: "1010", credit: 1_000 }],
    })).rejects.toThrow(/cannot fall due before it is raised/i);
  });

  it("holds the same rule in the database, for writers that do not come through post()", async () => {
    const any = await db.journalEntry.findFirstOrThrow({ where: { orgId: ORG } });
    // A posted entry is immutable, so the rule has to be proved on a write
    // rather than an edit — the ledger's own trigger gets there first.
    await expect(
      db.journalEntry.update({ where: { id: any.id }, data: { dueDate: new Date("2020-01-01") } }),
    ).rejects.toThrow(/immutable — correct by reversal/i);

    await expect(db.$executeRawUnsafe(`
      INSERT INTO "JournalEntry" ("id","orgId","entityId","bookId","periodId","series","number","entryDate","dueDate","status","source")
      SELECT 'settle-check', "orgId", "entityId", "bookId", "periodId", 'GJ', 'X-1', "entryDate", "entryDate" - 1, 'draft', 'manual'
      FROM "JournalEntry" WHERE id = '${any.id}'
    `)).rejects.toThrow(/JournalEntry_due_after_entry_check/);
  });

  /* -------------------------------------------------- one entry, many bills */

  it("clears every bill a single payment entry settles", async () => {
    // The failure this exists to prevent: one batch payment, and every bill
    // but the first still showing as outstanding — which is how a supplier
    // gets paid twice.
    const before = await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-20") });
    expect(itemOf(before, "bill-a")!.outstandingMinor).toBe("105000");
    expect(itemOf(before, "bill-b")!.outstandingMinor).toBe("42000");

    const batch = await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-04-21", source: "payment",
      sourceType: "PAYMENT_RUN", sourceId: "run-1", memo: "Payment run PR-1",
      lines: [
        { account: "2000", debit: 105_000, settlesId: "bill-a", memo: "BILL-A" },
        { account: "2000", debit: 42_000, settlesId: "bill-b", memo: "BILL-B" },
        { account: "1010", credit: 147_000, memo: "One transfer to the supplier" },
      ],
    });

    const after = await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-30") });
    expect(itemOf(after, "bill-a")).toBeUndefined();
    expect(itemOf(after, "bill-b")).toBeUndefined();
    expect(after.totalMinor).toBe("0");

    // One entry, three lines — not three entries.
    const lines = await db.journalLine.count({ where: { entryId: batch.id } });
    expect(lines).toBe(3);
  });

  it("reopens both bills when the batch is reversed, and neither before", async () => {
    const batch = await db.journalEntry.findFirstOrThrow({
      where: { orgId: ORG, sourceId: "run-1", status: "posted" },
    });
    await reverse({ orgId: ORG, entryId: batch.id, entryDate: "2026-05-02", memo: "Bank returned it" });

    const after = await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-05-10") });
    expect(itemOf(after, "bill-a")!.outstandingMinor).toBe("105000");
    expect(itemOf(after, "bill-b")!.outstandingMinor).toBe("42000");
    expect(after.totalMinor).toBe("147000");
  });

  it("still honours the entry-level settlement everything already posted uses", async () => {
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-05-11", source: "payment",
      sourceType: "SUPPLIER_PAYMENT", sourceId: "pay-1", settlesId: "bill-b", memo: "Paying BILL-B alone",
      lines: [{ account: "2000", debit: 42_000 }, { account: "1010", credit: 42_000 }],
    });
    const after = await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-05-20") });
    expect(itemOf(after, "bill-b")).toBeUndefined();
    expect(itemOf(after, "bill-a")!.outstandingMinor).toBe("105000");
  });
});
