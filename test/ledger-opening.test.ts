import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { previewOpeningBalances, importOpeningBalances, parseTrialBalance } from "@/lib/server/ledger/opening";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { balanceSheet } from "@/lib/server/ledger/statements";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-open";
const ENT = "t-ent-open";

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

/** A small but realistic trial balance for a trading business. */
const BALANCED = [
  { accountCode: "1010", debitMinor: 8_500_000 },
  { accountCode: "1100", debitMinor: 4_200_000 },   // a control account
  { accountCode: "1200", debitMinor: 3_100_000 },   // also a control account
  { accountCode: "1500", debitMinor: 6_000_000 },
  { accountCode: "1590", creditMinor: 1_200_000 },
  { accountCode: "2000", creditMinor: 5_600_000 },  // a control account
  { accountCode: "2100", creditMinor: 400_000 },    // and another
  { accountCode: "3000", creditMinor: 10_000_000 },
  { accountCode: "3900", creditMinor: 4_600_000 },
];

describe("reading a pasted trial balance", () => {
  it("finds columns by name, not by position", () => {
    const { lines, problems } = parseTrialBalance(
      "Account Code,Account Name,Debit,Credit\n1010,Bank,8500.00,\n3000,Capital,,8500.00",
    );
    expect(problems).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountCode: "1010", debitMinor: "850000" });
    expect(lines[1]).toMatchObject({ accountCode: "3000", creditMinor: "850000" });
  });

  it("reads a single signed balance column", () => {
    const { lines } = parseTrialBalance("Code,Balance\n1010,8500.00\n3000,(8500.00)");
    expect(lines[0].debitMinor).toBe("850000");
    // Parentheses are the accounting negative here as everywhere else.
    expect(lines[1].creditMinor).toBe("850000");
  });

  it("copes with thousands separators and currency symbols", () => {
    const { lines } = parseTrialBalance("Code,Debit,Credit\n1010,\"AED 1,234,567.89\",");
    expect(lines[0].debitMinor).toBe("123456789");
  });

  it("names the row it could not read rather than dropping it", () => {
    const { problems } = parseTrialBalance("Code,Debit,Credit\n1010,not a number,\n3000,,100.00");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Row 2 \(1010\)/);
  });

  it("skips blank rows and subtotal bands without complaining", () => {
    const { lines, problems } = parseTrialBalance("Code,Debit,Credit\n1010,100.00,\n,,\n3000,,100.00");
    expect(lines).toHaveLength(2);
    expect(problems).toEqual([]);
  });

  it("says what is missing when the header has no amounts", () => {
    const { problems } = parseTrialBalance("Code,Name\n1010,Bank");
    expect(problems[0]).toMatch(/debit.*credit.*pair|single "balance" column/i);
  });
});

d("opening balances", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("refuses a trial balance that does not balance, and does not plug it", async () => {
    const p = await previewOpeningBalances({
      orgId: ORG, entityId: ENT, asOf: "2026-01-01",
      lines: [{ accountCode: "1010", debitMinor: 100_000 }, { accountCode: "3000", creditMinor: 90_000 }],
    });
    expect(p.balanced).toBe(false);
    expect(p.differenceMinor).toBe("10000");
    expect(p.blockers[0]).toMatch(/credits are short by 100\.00/i);
    // The reason matters as much as the refusal.
    expect(p.blockers[0]).toMatch(/balance and are wrong/i);

    await expect(importOpeningBalances({
      orgId: ORG, entityId: ENT, asOf: "2026-01-01",
      lines: [{ accountCode: "1010", debitMinor: 100_000 }, { accountCode: "3000", creditMinor: 90_000 }],
    })).rejects.toThrow(/does not balance/i);

    // And nothing was posted.
    expect(await db.journalEntry.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("catches every problem at once rather than one per attempt", async () => {
    const p = await previewOpeningBalances({
      orgId: ORG, entityId: ENT, asOf: "2026-01-01",
      lines: [
        { accountCode: "9999", debitMinor: 100 },              // does not exist
        { accountCode: "1", creditMinor: 100 },                 // a heading
        { accountCode: "1010", debitMinor: 50, creditMinor: 50 }, // both sides
        { accountCode: "1010", debitMinor: 10 },                // and a duplicate
      ],
    });
    expect(p.blockers.length).toBeGreaterThanOrEqual(4);
    expect(p.blockers.join(" ")).toMatch(/9999 is not in this entity's chart/);
    expect(p.blockers.join(" ")).toMatch(/is a heading/);
    expect(p.blockers.join(" ")).toMatch(/both a debit and a credit/);
    expect(p.blockers.join(" ")).toMatch(/appears more than once/);
  });

  it("refuses a negative amount rather than guessing the side", async () => {
    const p = await previewOpeningBalances({
      orgId: ORG, entityId: ENT, asOf: "2026-01-01",
      lines: [{ accountCode: "1010", debitMinor: -100 }, { accountCode: "3000", creditMinor: -100 }],
    });
    expect(p.blockers.join(" ")).toMatch(/negative amount/i);
  });

  it("imports a balanced trial balance, reaching the control accounts", async () => {
    const r = await importOpeningBalances({ orgId: ORG, entityId: ENT, asOf: "2026-01-01", lines: BALANCED });
    expect(r.reference).toMatch(/^OB-/);
    expect(r.linesPosted).toBe(9);

    const lines = await db.journalLine.findMany({
      where: { entryId: r.entryId! }, include: { account: true },
    });
    const byCode = Object.fromEntries(lines.map((l) => [l.account.code, l.txnAmountMinor]));
    // 1100, 1200, 2000 and 2100 are control accounts that refuse a manual
    // journal. A migrating business really does have receivables on day one,
    // so the import has to be able to reach them.
    expect(byCode["1100"]).toBe(4_200_000n);
    expect(byCode["2000"]).toBe(-5_600_000n);
    expect(byCode["2100"]).toBe(-400_000n);
  });

  it("produces a balance sheet that balances", async () => {
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-01-31" });
    expect(bs.balanced).toBe(true);
    // 8,500,000 + 4,200,000 + 3,100,000 + 6,000,000 − 1,200,000
    expect(bs.totalAssetsMinor).toBe("20600000");
  });

  it("keeps the trial balance tied", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-01" });
    expect(tb.balanced).toBe(true);
    // The trial balance presents each account on its natural side, so
    // accumulated depreciation sits in the credit column rather than netting
    // against the asset — 8.5 + 4.2 + 3.1 + 6.0 million on the debit side.
    expect(tb.totalDebitMinor).toBe(21_800_000n);
    expect(tb.totalCreditMinor).toBe(21_800_000n);
  });

  it("will not import the same date twice", async () => {
    const again = await importOpeningBalances({ orgId: ORG, entityId: ENT, asOf: "2026-01-01", lines: BALANCED });
    expect(again.alreadyImported).toBe(true);
    expect(await db.journalEntry.count({ where: { orgId: ORG, series: "OB" } })).toBe(1);
  });

  it("says so in the preview once it has been imported", async () => {
    const p = await previewOpeningBalances({ orgId: ORG, entityId: ENT, asOf: "2026-01-01", lines: BALANCED });
    expect(p.alreadyImported).toBe(true);
    expect(p.reference).toMatch(/^OB-/);
  });

  it("creates accounts the chart does not have, when asked", async () => {
    const r = await importOpeningBalances({
      orgId: ORG, entityId: ENT, asOf: "2026-02-01",
      lines: [
        { accountCode: "1490", debitMinor: 250_000, createIfMissing: { name: "Rent deposit", type: "ASSET" } },
        { accountCode: "3900", creditMinor: 250_000 },
      ],
    });
    expect(r.accountsCreated).toBe(1);
    const created = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code: "1490" } });
    expect(created?.name).toBe("Rent deposit");
    expect(created?.type).toBe("ASSET");
  });

  it("refuses an invented account type", async () => {
    await expect(importOpeningBalances({
      orgId: ORG, entityId: ENT, asOf: "2026-03-01",
      lines: [
        { accountCode: "1491", debitMinor: 100, createIfMissing: { name: "Nonsense", type: "WIDGET" } },
        { accountCode: "3900", creditMinor: 100 },
      ],
    })).rejects.toThrow(/ASSET, LIABILITY, EQUITY, INCOME or EXPENSE/);
  });

  it("refuses a date no period covers, and says what to do", async () => {
    const p = await previewOpeningBalances({
      orgId: ORG, entityId: ENT, asOf: "2019-12-31", lines: BALANCED,
    });
    expect(p.blockers.join(" ")).toMatch(/No accounting period covers 2019-12-31/);
    expect(p.blockers.join(" ")).toMatch(/open the fiscal year/i);
  });

  it("refuses to post into a closed period", async () => {
    await db.accountingPeriod.updateMany({
      where: { orgId: ORG, entityId: ENT, label: "2026-04" }, data: { status: "hard_closed" },
    });
    const p = await previewOpeningBalances({
      orgId: ORG, entityId: ENT, asOf: "2026-04-15",
      lines: [{ accountCode: "1010", debitMinor: 100 }, { accountCode: "3900", creditMinor: 100 }],
    });
    expect(p.blockers.join(" ")).toMatch(/2026-04 is hard closed/);
  });

  it("refuses an import with nothing in it", async () => {
    const p = await previewOpeningBalances({ orgId: ORG, entityId: ENT, asOf: "2026-05-01", lines: [] });
    expect(p.blockers.join(" ")).toMatch(/no balances to import/i);
  });

  it("refuses to import into an entity with no books", async () => {
    await expect(previewOpeningBalances({
      orgId: ORG, entityId: "t-ent-no-books", asOf: "2026-01-01", lines: BALANCED,
    })).rejects.toThrow(/Open the books for this entity first|Open the books/i);
  });
});
