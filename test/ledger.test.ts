import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post, reverse, LedgerError } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance, generalLedger } from "@/lib/server/ledger/reports";

/**
 * End-to-end ledger behaviour against a real Postgres. Skipped when no database
 * is configured so the unit suite still runs anywhere.
 */
const db = new PrismaClient();
const HAS_DB = Boolean(process.env.DATABASE_URL);
const d = HAS_DB ? describe : describe.skip;

const ORG = "t-org-ledger";
const ENT = "t-ent-ledger";

async function wipe() {
  // The ledger refuses edits to posted entries — correctly, and that includes
  // this teardown. Triggers are disabled for the length of this one transaction
  // (SET LOCAL reverts on commit) so fixtures can be torn down without weakening
  // the guarantee anywhere else.
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

d("ledger", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("opens a UAE chart of accounts with bilingual names", async () => {
    const ar = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code: "1100" } });
    expect(ar?.name).toBe("Trade receivables");
    expect(ar?.nameAr).toBe("الذمم المدينة التجارية");
    expect(ar?.isControl).toBe(true);
  });

  it("never lands an ordinary posting in the adjustment period by accident", async () => {
    // The adjustment period shares its last day with December on purpose. A
    // posting dated that day belongs to December unless a caller says
    // otherwise, or a routine year-end sale would silently become an
    // adjustment.
    const e = await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-12-31", source: "manual",
      memo: "New year's eve sale",
      lines: [{ account: "1010", debit: 1_000 }, { account: "4000", credit: 1_000 }],
    });
    const entry = await db.journalEntry.findUnique({ where: { id: e.id }, include: { period: true } });
    expect(entry?.period.isAdjustment).toBe(false);
    expect(entry?.period.label).toBe("2026-12");
  });

  it("posts into the adjustment period when asked for it by name", async () => {
    const adj = await db.accountingPeriod.findFirst({ where: { orgId: ORG, entityId: ENT, isAdjustment: true } });
    const e = await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-12-31", source: "manual", periodId: adj!.id,
      memo: "Year-end adjustment",
      lines: [{ account: "1010", debit: 500 }, { account: "4000", credit: 500 }],
    });
    const entry = await db.journalEntry.findUnique({ where: { id: e.id }, include: { period: true } });
    expect(entry?.period.isAdjustment).toBe(true);
  });

  it("posts a balanced sale with VAT and returns a numbered entry", async () => {
    const e = await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-01-15", source: "invoice",
      memo: "Invoice INV-001",
      lines: [
        { account: "1100", debit: 10_500 },   // AR 105.00
        { account: "4000", credit: 10_000 },  // Sales 100.00
        { account: "2100", credit: 500 },     // VAT output 5.00
      ],
    });
    expect(e.status).toBe("posted");
    expect(e.number).toMatch(/^\d{5}$/);
    expect(e.lines).toHaveLength(3);
    const sum = e.lines.reduce((a, l) => a + l.txnAmountMinor, 0n);
    expect(sum).toBe(0n);
  });

  it("refuses an unbalanced entry with an actionable message", async () => {
    await expect(post({
      orgId: ORG, entityId: ENT, entryDate: "2026-01-15",
      lines: [{ account: "1000", debit: 5_000 }, { account: "4000", credit: 4_900 }],
    })).rejects.toThrow(/does not balance/i);
  });

  it("refuses a manual journal against a control account", async () => {
    await expect(post({
      orgId: ORG, entityId: ENT, entryDate: "2026-01-15", source: "manual",
      lines: [{ account: "1100", debit: 100 }, { account: "4000", credit: 100 }],
    })).rejects.toThrow(/control account/i);
  });

  it("refuses posting into a period that is not open", async () => {
    await db.accountingPeriod.updateMany({ where: { orgId: ORG, entityId: ENT, label: "2026-03" }, data: { status: "hard_closed" } });
    await expect(post({
      orgId: ORG, entityId: ENT, entryDate: "2026-03-10",
      lines: [{ account: "1000", debit: 100 }, { account: "4000", credit: 100 }],
    })).rejects.toThrow(/hard closed|posting refused/i);
    await db.accountingPeriod.updateMany({ where: { orgId: ORG, entityId: ENT, label: "2026-03" }, data: { status: "open" } });
  });

  it("is idempotent on externalKey — a retry does not double-post", async () => {
    const args = {
      orgId: ORG, entityId: ENT, entryDate: "2026-01-20", externalKey: "webhook-abc-123",
      lines: [{ account: "1000", debit: 2_500 }, { account: "4900", credit: 2_500 }],
    };
    const a = await post(args);
    const b = await post(args);
    expect(b.id).toBe(a.id);
    const n = await db.journalEntry.count({ where: { orgId: ORG, externalKey: "webhook-abc-123" } });
    expect(n).toBe(1);
  });

  it("converts a foreign-currency line into the functional currency", async () => {
    const e = await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-01-22", source: "bank",
      lines: [
        { account: "1000", debit: 36_730, currency: "AED" },
        { account: "4900", credit: 10_000, currency: "USD", fxRate: 3.673 },
      ],
    });
    const usd = e.lines.find((l) => l.txnCurrency === "USD")!;
    expect(usd.functionalAmountMinor).toBe(-36_730n);
    expect(e.lines.reduce((a, l) => a + l.functionalAmountMinor, 0n)).toBe(0n);
  });

  it("keeps the trial balance in balance", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-01" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
    expect(tb.rows.length).toBeGreaterThan(0);
  });

  it("corrects by reversal, leaving the original intact", async () => {
    const original = await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-01-25", memo: "Mistake",
      lines: [{ account: "6900", debit: 7_777 }, { account: "1000", credit: 7_777 }],
    });
    const rev = await reverse({ orgId: ORG, entryId: original.id, memo: "Reversing the mistake" });

    const after = await db.journalEntry.findUnique({ where: { id: original.id }, include: { lines: true } });
    expect(after?.status).toBe("reversed");
    expect(after?.lines.reduce((a, l) => a + l.txnAmountMinor, 0n)).toBe(0n);

    const revRow = await db.journalEntry.findUnique({ where: { id: rev.id }, include: { lines: true } });
    expect(revRow?.reversalOfId).toBe(original.id);
    // The pair nets to nothing.
    const net = [...(after?.lines ?? []), ...(revRow?.lines ?? [])].reduce((a, l) => a + l.txnAmountMinor, 0n);
    expect(net).toBe(0n);

    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-01" });
    expect(tb.balanced).toBe(true);
  });

  it("drills from an account to its journal lines with a running balance", async () => {
    const gl = await generalLedger({ orgId: ORG, entityId: ENT, accountCode: "1000" });
    expect(gl.account.code).toBe("1000");
    expect(gl.lines.length).toBeGreaterThan(0);
    for (const l of gl.lines) expect(l.reference).toMatch(/^GJ-\d{5}$/);
  });

  it("rejects a line that is neither a debit nor a credit", async () => {
    await expect(post({
      orgId: ORG, entityId: ENT, entryDate: "2026-01-15",
      lines: [{ account: "1000" } as never, { account: "4000", credit: 100 }],
    })).rejects.toThrow(LedgerError);
  });
});
