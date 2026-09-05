import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post, reverse, LedgerError } from "@/lib/server/ledger/post";
import { generalLedger } from "@/lib/server/ledger/reports";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-gl";
const ENT = "t-ent-gl";
const CASH = "1010";
const S = { orgId: ORG, entityId: ENT, accountCode: CASH };

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

/** The date is the identity of every posting here, so it is also the idempotency key. */
const P = (entryDate: string, memo: string, lines: { account: string; debit?: number; credit?: number }[]) =>
  post({ orgId: ORG, entityId: ENT, entryDate, memo, source: "manual", externalKey: `gl-test:${entryDate}`, lines });

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const on = (l: { date: Date }) => l.date.toISOString().slice(0, 10);

/**
 * Ten postings to the bank account across three months, arranged so that every
 * figure the report quotes is a different number from every other one — a page
 * total that happens to equal the account's balance would let the bug this
 * suite exists for pass unnoticed.
 *
 *   January   +400,000 (four receipts of 100,000)
 *   February  −150,000 (three payments of 50,000)
 *   March     +600,000 (three receipts of 200,000)
 *             ────────
 *              850,000
 */
d("general ledger detail", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    for (const date of ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"]) {
      await P(date, `Receipt ${date}`, [{ account: CASH, debit: 100_000 }, { account: "4000", credit: 100_000 }]);
    }
    for (const date of ["2026-02-05", "2026-02-06", "2026-02-07"]) {
      await P(date, `Payment ${date}`, [{ account: "6900", debit: 50_000 }, { account: CASH, credit: 50_000 }]);
    }
    for (const date of ["2026-03-05", "2026-03-06", "2026-03-07"]) {
      await P(date, `Receipt ${date}`, [{ account: CASH, debit: 200_000 }, { account: "4000", credit: 200_000 }]);
    }
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("closes at the account's balance, not at the last line of the page", async () => {
    // The defect: the closing figure was the running total of however many
    // lines were listed, so an account with more postings than the limit
    // reported the balance as at the page's last posting — presented as fact.
    const gl = await generalLedger({ ...S, limit: 3 });
    expect(gl.closingMinor).toBe(850_000n);
    expect(gl.listed).toBe(3);
    expect(gl.lineCount).toBe(10);
    expect(gl.truncated).toBe(true);
    // What the page alone adds up to, which is what used to be presented.
    expect(gl.lines.reduce((a, l) => a + l.debitMinor - l.creditMinor, 0n)).toBe(600_000n);
    // And the column ties to the footer, which is the whole point of both.
    expect(gl.lines.at(-1)!.runningMinor).toBe(gl.closingMinor);
  });

  it("lists the newest lines, because those are the ones somebody drilled in for", async () => {
    const gl = await generalLedger({ ...S, limit: 3 });
    expect(gl.lines.map(on)).toEqual(["2026-03-05", "2026-03-06", "2026-03-07"]);
  });

  it("opens a truncated page at the balance brought forward rather than at zero", async () => {
    const gl = await generalLedger({ ...S, limit: 3 });
    // January and February, which the page does not show.
    expect(gl.broughtForwardMinor).toBe(250_000n);
    expect(gl.lines[0].runningMinor).toBe(450_000n);
    // Nothing precedes the beginning of the ledger, so there is no opening.
    expect(gl.openingMinor).toBe(0n);
  });

  it("opens a date range at the balance brought forward into it", async () => {
    const feb = await generalLedger({ ...S, from: day("2026-02-01"), to: day("2026-02-28") });
    expect(feb.openingMinor).toBe(400_000n);
    expect(feb.broughtForwardMinor).toBe(400_000n);
    expect(feb.truncated).toBe(false);
    // Each figure is the balance on that day. Starting from zero — the defect —
    // would have given −50,000, −100,000, −150,000: the movement, labelled as
    // the balance.
    expect(feb.lines.map((l) => l.runningMinor)).toEqual([350_000n, 300_000n, 250_000n]);
    expect(feb.closingMinor).toBe(250_000n);
  });

  it("distinguishes what the range opened at from what the page opens at", async () => {
    // Everything from February, of which only the last two lines are listed.
    const tail = await generalLedger({ ...S, from: day("2026-02-01"), limit: 2 });
    expect(tail.openingMinor).toBe(400_000n);
    expect(tail.broughtForwardMinor).toBe(450_000n);
    expect(tail.lines.map(on)).toEqual(["2026-03-06", "2026-03-07"]);
    expect(tail.lines.map((l) => l.runningMinor)).toEqual([650_000n, 850_000n]);
    // The balance at the end of the range, not the range's movement.
    expect(tail.closingMinor).toBe(850_000n);
  });

  it("clamps a limit that no caller should have sent", async () => {
    // Nothing is a page of nought lines, and `Number("all")` is NaN, which
    // reaches Prisma as `take: NaN` and fails the read rather than the request.
    const none = await generalLedger({ ...S, limit: 0 });
    expect(none.listed).toBe(1);
    expect(none.closingMinor).toBe(850_000n);

    const nonsense = await generalLedger({ ...S, limit: Number("all") });
    expect(nonsense.listed).toBe(10);
    expect(nonsense.truncated).toBe(false);
    expect(nonsense.lines.at(-1)!.runningMinor).toBe(850_000n);
  });

  it("refuses an account that is not in the chart", async () => {
    await expect(generalLedger({ orgId: ORG, entityId: ENT, accountCode: "ZZZZ" }))
      .rejects.toThrow(LedgerError);
  });

  it("counts a reversed entry and its reversal, which is what makes them net", async () => {
    // Left last: it changes the balance every test above is written against.
    const original = await db.journalEntry.findFirstOrThrow({
      where: { orgId: ORG, memo: "Receipt 2026-03-07" },
    });
    await reverse({ orgId: ORG, entryId: original.id, memo: "Receipt banked twice" });

    const gl = await generalLedger({ ...S });
    expect(gl.lineCount).toBe(11);
    expect(gl.closingMinor).toBe(650_000n);
    expect(gl.lines.at(-1)!.runningMinor).toBe(650_000n);
    expect(gl.lines.filter((l) => l.status === "reversed")).toHaveLength(1);
  });
});
