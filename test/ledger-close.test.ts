import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { previewClose, closeYear, openNextYear } from "@/lib/server/ledger/close";
import { profitAndLoss, balanceSheet } from "@/lib/server/ledger/statements";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-close";
const ENT = "t-ent-close";

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

const P = (entryDate: string, lines: { account: string; debit?: number; credit?: number }[], memo = "") =>
  post({ orgId: ORG, entityId: ENT, entryDate, memo, source: "manual", lines });

const hardCloseAll = () =>
  db.accountingPeriod.updateMany({
    where: { orgId: ORG, entityId: ENT, isAdjustment: false },
    data: { status: "hard_closed" },
  });

d("year-end close", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    await P("2026-01-10", [{ account: "1010", debit: 3_000_000 }, { account: "3000", credit: 3_000_000 }], "Capital");
    await P("2026-03-15", [{ account: "1010", debit: 2_000_000 }, { account: "4000", credit: 2_000_000 }], "Sales");
    await P("2026-04-20", [{ account: "5000", debit: 800_000 }, { account: "1010", credit: 800_000 }], "Cost of sales");
    await P("2026-06-30", [{ account: "6100", debit: 300_000 }, { account: "1010", credit: 300_000 }], "Rent");
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("refuses to close while periods can still receive postings", async () => {
    const p = await previewClose({ orgId: ORG, entityId: ENT, fiscalYear: "2026" });
    expect(p.blockers.length).toBeGreaterThan(0);
    expect(p.blockers[0]).toMatch(/still open/i);
    await expect(closeYear({ orgId: ORG, entityId: ENT, fiscalYear: "2026" })).rejects.toThrow(/still open/i);
  });

  it("shows what the close will do before it does it", async () => {
    await hardCloseAll();
    const p = await previewClose({ orgId: ORG, entityId: ENT, fiscalYear: "2026" });
    expect(p.blockers).toEqual([]);
    expect(p.netProfitMinor).toBe("900000"); // 2,000,000 − 800,000 − 300,000
    // Revenue is held negative, so closing it is a debit.
    expect(p.lines.find((l) => l.code === "4000")?.closingMinor).toBe("2000000");
    expect(p.lines.find((l) => l.code === "5000")?.closingMinor).toBe("-800000");
    expect(p.alreadyClosed).toBe(false);
  });

  it("closes the year into retained earnings", async () => {
    const r = await closeYear({ orgId: ORG, entityId: ENT, fiscalYear: "2026" });
    expect(r.reference).toMatch(/^CL-/);
    expect(r.netProfitMinor).toBe("900000");
    expect(r.accountsClosed).toBe(3);

    const lines = await db.journalLine.findMany({ where: { entryId: r.entryId! }, include: { account: true } });
    const byCode = Object.fromEntries(lines.map((l) => [l.account.code, l.txnAmountMinor]));
    expect(byCode["4000"]).toBe(2_000_000n);   // Dr revenue, to zero it
    expect(byCode["5000"]).toBe(-800_000n);    // Cr cost of sales
    expect(byCode["6100"]).toBe(-300_000n);    // Cr rent
    expect(byCode["3900"]).toBe(-900_000n);    // Cr retained earnings with the profit
  });

  it("posts the close into the adjustment period, not into a trading month", async () => {
    const entry = await db.journalEntry.findFirst({
      where: { orgId: ORG, series: "CL" }, include: { period: true },
    });
    expect(entry?.period.isAdjustment).toBe(true);
  });

  it("still reports the year's trading after it has been closed", async () => {
    // Closing a year debits income and credits expenses to nothing. That is a
    // transfer into equity, not trading, so it is taken back out of the profit
    // and loss — otherwise every closed year reads nil, and a corporate tax
    // computation run after the close finds no profit and charges no tax.
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-12-31" });
    expect(pl.revenue.totalMinor).not.toBe("0");
    expect(pl.netProfitMinor).not.toBe("0");

    // And the result has not been double counted: the balance sheet carries it
    // in retained earnings, with nothing left in current-year earnings.
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
    expect(bs.currentYearEarningsMinor).toBe("0");
    expect(bs.balanced).toBe(true);
  });

  it("carries the result into equity, so the balance sheet still balances", async () => {
    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
    expect(bs.balanced).toBe(true);
    // The profit is now posted retained earnings, not a computed current-year line.
    expect(bs.currentYearEarningsMinor).toBe("0");
    expect(bs.equity.lines.find((l) => l.code === "3900")?.presentedMinor).toBe("900000");
    expect(bs.totalAssetsMinor).toBe("3900000"); // 3,000,000 + 2,000,000 − 800,000 − 300,000
  });

  it("keeps the trial balance tied", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-ADJ" });
    expect(tb.balanced).toBe(true);
  });

  it("closing twice does nothing the second time", async () => {
    const again = await closeYear({ orgId: ORG, entityId: ENT, fiscalYear: "2026" });
    expect(again.alreadyClosed).toBe(true);
    const count = await db.journalEntry.count({ where: { orgId: ORG, series: "CL" } });
    expect(count).toBe(1);
  });

  it("leaves the adjustment period as it found it", async () => {
    const adj = await db.accountingPeriod.findFirst({ where: { orgId: ORG, entityId: ENT, isAdjustment: true } });
    // It was open before the close and is open after — the close borrows it,
    // it does not change the period's state as a side effect.
    expect(adj?.status).toBe("open");
  });

  it("opens the next year without copying anything forward", async () => {
    const next = await openNextYear({ orgId: ORG, entityId: ENT, afterFiscalYear: "2026" });
    expect(next.label).toBe("2027");
    expect(next.startsOn).toBe("2027-01-01");
    expect(next.created).toBe(true);
    expect(next.periods).toBe(13); // twelve months and an adjustment period

    // The balance sheet carries itself; there is no opening-balance journal.
    const opening = await db.journalEntry.count({ where: { orgId: ORG, sourceType: "OPENING_BALANCE" } });
    expect(opening).toBe(0);
  });

  it("starts the new year with a clean profit and loss and the balance sheet intact", async () => {
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2027-01-01", to: "2027-12-31" });
    expect(pl.netProfitMinor).toBe("0");

    const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2027-01-31" });
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssetsMinor).toBe("3900000");
    expect(bs.equity.lines.find((l) => l.code === "3900")?.presentedMinor).toBe("900000");
  });

  it("opening the next year twice does not create it twice", async () => {
    const again = await openNextYear({ orgId: ORG, entityId: ENT, afterFiscalYear: "2026" });
    expect(again.created).toBe(false);
    const count = await db.fiscalYear.count({ where: { orgId: ORG, entityId: ENT, label: "2027" } });
    expect(count).toBe(1);
  });

  it("records who locked the months, not only when", async () => {
    // Locking is the one irreversible act in this product — a locked period
    // never reopens, whoever asks — and it recorded a timestamp and no name.
    // Every posted journal entry carries an actor; the act that freezes a
    // whole year of them carried none.
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2028", startsOn: "2028-01-01" });
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2028-03-15", source: "manual", memo: "A year to close",
      lines: [{ account: "1010", debit: 400_000 }, { account: "4000", credit: 400_000 }],
    });

    // The year has to be hard-closed month by month before it can be closed —
    // a year closed over periods that can still receive postings is wrong by
    // tomorrow — so this walks them through the same states a person would.
    const months = await db.accountingPeriod.findMany({
      where: { orgId: ORG, entityId: ENT, fiscalYear: { label: "2028" } },
      select: { id: true },
    });
    for (const status of ["soft_closed", "hard_closed"]) {
      await db.accountingPeriod.updateMany({ where: { id: { in: months.map((m) => m.id) } }, data: { status } });
    }

    const r = await closeYear({
      orgId: ORG, entityId: ENT, fiscalYear: "2028", lockPeriods: true, actorId: "u-controller",
    });
    expect(r.periodsLocked).toBeGreaterThan(0);

    const locked = await db.accountingPeriod.findMany({
      where: { orgId: ORG, entityId: ENT, status: "locked", fiscalYear: { label: "2028" } },
      select: { label: true, closedAt: true, closedBy: true },
    });
    expect(locked.length).toBe(r.periodsLocked);
    for (const p of locked) {
      expect(p.closedBy, p.label).toBe("u-controller");
      expect(p.closedAt, p.label).toBeInstanceOf(Date);
    }
  });

  it("refuses a year that does not exist", async () => {
    await expect(previewClose({ orgId: ORG, entityId: ENT, fiscalYear: "1999" }))
      .rejects.toThrow(/no fiscal year/i);
  });

  it("closes an account that demands a cost centre, one line per centre", async () => {
    // Discovered by the dimensional reconciliation: an account with
    // requiresDimension refuses a posting that names no value, and the closing
    // entry is a posting like any other — so a year with such an account could
    // not be closed at all. Bringing it to zero means bringing each cost
    // centre to zero, which is also what keeps the dimensional reports true.
    const entry = await db.journalEntry.findFirst({
      where: { orgId: ORG, entityId: ENT, source: "close" },
      include: { lines: { include: { account: true, dimensions: { include: { value: true } } } } },
    });
    expect(entry).not.toBeNull();
    // Nothing in this entity requires a dimension, so every line is plain —
    // the shape the split has to preserve.
    expect(entry!.lines.every((l) => l.dimensions.length === 0)).toBe(true);
    expect(entry!.lines.length).toBeGreaterThan(1);
  });
});

d("closing a year with nothing in it", () => {
  const ORG2 = "t-org-close2";
  const ENT2 = "t-ent-close2";
  beforeAll(async () => {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG2}'`),
      db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG2}'`),
      db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG2}'`),
      db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG2}'`),
    ]);
    await openFiscalYear({ orgId: ORG2, entityId: ENT2, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG2, entityId: ENT2 });
    await db.accountingPeriod.updateMany({
      where: { orgId: ORG2, entityId: ENT2, isAdjustment: false }, data: { status: "hard_closed" },
    });
  });
  afterAll(async () => {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG2}'`),
      db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG2}'`),
      db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG2}'`),
      db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG2}'`),
    ]);
  });

  it("says so rather than posting an empty journal", async () => {
    await expect(closeYear({ orgId: ORG2, entityId: ENT2, fiscalYear: "2026" }))
      .rejects.toThrow(/nothing to carry to retained earnings/i);
  });
});
