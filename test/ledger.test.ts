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
    db.$executeRawUnsafe(`DELETE FROM "DimensionValue" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Dimension" WHERE "orgId" = '${ORG}'`),
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

  it("carries a line's dimensions through a reversal", async () => {
    // Without this the total still reconciles while every column is wrong: the
    // cost stays against the department and the credit lands in Unallocated.
    // Because the total is right, nothing else catches it.
    const dim = await db.dimension.create({
      data: { orgId: ORG, code: "COST_CENTRE_T", name: "Cost centre" },
    });
    await db.dimensionValue.create({ data: { orgId: ORG, dimensionId: dim.id, code: "OPS_T", name: "Operations" } });

    const e = await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-05-04", source: "manual", memo: "Tagged cost",
      lines: [
        { account: "6900", debit: 40_000, dimensions: { COST_CENTRE_T: "OPS_T" } },
        { account: "1010", credit: 40_000 },
      ],
    });
    const r = await reverse({ orgId: ORG, entryId: e.id, entryDate: "2026-05-05" });
    const reversedLine = await db.journalLine.findFirst({
      where: { entryId: r.id, account: { code: "6900" } },
      include: { dimensions: { include: { value: true } } },
    });
    expect(reversedLine?.dimensions).toHaveLength(1);
    expect(reversedLine?.dimensions[0].value.code).toBe("OPS_T");
  });

  it("can reverse an entry on an account that requires a dimension", async () => {
    // The more serious half. post() refuses a line with no dimension on such an
    // account — including the reversal it builds itself — so correction was
    // impossible on exactly the accounts carrying the strongest control.
    const dim = await db.dimension.findFirst({ where: { orgId: ORG, code: "COST_CENTRE_T" } });
    expect(dim).not.toBeNull();
    await db.account.updateMany({
      where: { orgId: ORG, entityId: ENT, code: "6250" },
      data: { requiresDimension: "COST_CENTRE_T" },
    });

    const e = await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-05-06", source: "manual", memo: "Controlled cost",
      lines: [
        { account: "6250", debit: 25_000, dimensions: { COST_CENTRE_T: "OPS_T" } },
        { account: "1010", credit: 25_000 },
      ],
    });
    await expect(reverse({ orgId: ORG, entryId: e.id, entryDate: "2026-05-07" })).resolves.toBeTruthy();

    // Leave the chart as it was found.
    await db.account.updateMany({
      where: { orgId: ORG, entityId: ENT, code: "6250" },
      data: { requiresDimension: null },
    });
  });

  it("refuses a posting to a closed cost centre, and distinguishes it from an unknown one", async () => {
    const dim = await db.dimension.findFirst({ where: { orgId: ORG, code: "COST_CENTRE_T" } });
    await db.dimensionValue.create({
      data: { orgId: ORG, dimensionId: dim!.id, code: "CLOSED_T", name: "Finished job", status: "archived" },
    });

    // A late posting to a closed job is how cost quietly arrives against work
    // already reported as complete.
    await expect(post({
      orgId: ORG, entityId: ENT, entryDate: "2026-05-09", source: "manual",
      lines: [
        { account: "6900", debit: 1_000, dimensions: { COST_CENTRE_T: "CLOSED_T" } },
        { account: "1010", credit: 1_000 },
      ],
    })).rejects.toThrow(/has been closed, so nothing further can be posted/i);

    // And "closed" is a different problem from "does not exist" — saying the
    // wrong one sends someone off to create a duplicate.
    await expect(post({
      orgId: ORG, entityId: ENT, entryDate: "2026-05-09", source: "manual",
      lines: [
        { account: "6900", debit: 1_000, dimensions: { COST_CENTRE_T: "NEVER_EXISTED" } },
        { account: "1010", credit: 1_000 },
      ],
    })).rejects.toThrow(/is not a value of COST_CENTRE_T/i);
  });

  it("says which of the dimension and the value it does not recognise", async () => {
    await expect(post({
      orgId: ORG, entityId: ENT, entryDate: "2026-05-08", source: "manual",
      lines: [
        { account: "6900", debit: 1_000, dimensions: { NO_SUCH_DIMENSION: "OPS_T" } },
        { account: "1010", credit: 1_000 },
      ],
    })).rejects.toThrow(/no dimension called "NO_SUCH_DIMENSION"/i);

    await expect(post({
      orgId: ORG, entityId: ENT, entryDate: "2026-05-08", source: "manual",
      lines: [
        { account: "6900", debit: 1_000, dimensions: { COST_CENTRE_T: "NO_SUCH_VALUE" } },
        { account: "1010", credit: 1_000 },
      ],
    })).rejects.toThrow(/"NO_SUCH_VALUE" is not a value of COST_CENTRE_T/i);
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

  it("cannot be walked around by changing an entry's source after its lines are written", async () => {
    // The route the guards left open: a draft entry with a subledger source
    // takes control-account lines legitimately, is then made manual while
    // still a draft, and is posted. The line guard read the source when the
    // line was written and it was true then; nothing re-checked afterwards.
    const book = await db.book.findFirstOrThrow({ where: { orgId: ORG, entityId: ENT } });
    const period = await db.accountingPeriod.findFirstOrThrow({
      where: { orgId: ORG, entityId: ENT, status: "open" },
    });
    const ar = await db.account.findFirstOrThrow({ where: { orgId: ORG, entityId: ENT, code: "1100" } });
    const bank = await db.account.findFirstOrThrow({ where: { orgId: ORG, entityId: ENT, code: "1010" } });

    const draft = await db.journalEntry.create({
      data: {
        orgId: ORG, entityId: ENT, bookId: book.id, periodId: period.id,
        series: "GJ", number: `X-${Date.now()}`, entryDate: new Date("2026-01-20"),
        status: "draft", source: "invoice",
        lines: {
          create: [
            { orgId: ORG, lineNo: 1, accountId: ar.id, txnCurrency: "AED", txnAmountMinor: 1_000n,
              functionalCurrency: "AED", functionalAmountMinor: 1_000n },
            { orgId: ORG, lineNo: 2, accountId: bank.id, txnCurrency: "AED", txnAmountMinor: -1_000n,
              functionalCurrency: "AED", functionalAmountMinor: -1_000n },
          ],
        },
      },
    });

    // Step three is now refused, at the moment the entry becomes manual.
    await expect(
      db.journalEntry.update({ where: { id: draft.id }, data: { source: "manual" } }),
    ).rejects.toThrow(/1100 is a control account/);

    // And again at the moment of posting, which is the last chance to catch it.
    await db.$executeRawUnsafe(`UPDATE "JournalEntry" SET "source" = 'manual' WHERE id = '${draft.id}' AND false`);
    await expect(
      db.$executeRawUnsafe(
        `UPDATE "JournalEntry" SET "source" = 'manual', "status" = 'posted' WHERE id = '${draft.id}'`,
      ),
    ).rejects.toThrow(/1100 is a control account/);

    await db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "entryId" = '${draft.id}'`);
    await db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE id = '${draft.id}'`);
  });
});
