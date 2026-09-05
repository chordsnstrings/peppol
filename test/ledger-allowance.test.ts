import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postInvoice } from "@/lib/server/ledger/ar";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { writeOffReceivable } from "@/lib/server/ledger/write-offs";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  allowanceView,
  raiseAllowance,
  provisionMatrix,
  normaliseRates,
  DEFAULT_MATRIX,
  BAND_ORDER,
  type LossRates,
} from "@/lib/server/ledger/allowance";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-allow";
const ENT = "t-ent-allow";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "ReceivableWriteOff" WHERE "orgId" = '${ORG}'`),
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
    id: `al${++seq}`, lineNo: seq, description: "Consulting", qty: 1, unitCode: "C62",
    unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
  };
}

/** A sales invoice, raised and posted on a date, so the ageing has something to age. */
async function raise(number: string, issueDate: string, grossMinor: number): Promise<Invoice> {
  // Zero-rated, so the gross is the net and each band's figure is the number
  // written here rather than that number plus a tax nobody is testing.
  const lines = [line(grossMinor, 0, "ZERO_OTHER")];
  const inv = {
    id: `alinv-${++seq}`, orgId: ORG, entityId: ENT, direction: "OUTBOUND", docType: "TAX_INVOICE",
    number, issueDate, supplyDate: issueDate, currency: "AED",
    buyer: { nameEn: "Al Marri Trading LLC" }, seller: { nameEn: "Our Company" },
    lines,
    totals: { taxExclusiveMinor: grossMinor, vatMinor: 0, taxInclusiveMinor: grossMinor, payableMinor: grossMinor, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED",
    source: "EDITOR",
    compliance: { taxableEventDate: issueDate, daysRemaining: 14, breached: false },
    createdAt: `${issueDate}T00:00:00Z`, updatedAt: `${issueDate}T00:00:00Z`,
  } as Invoice;
  await postInvoice({ orgId: ORG, invoice: inv });
  return inv;
}

async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({
    where: { entryId }, include: { account: true }, orderBy: { lineNo: "asc" },
  });
  return rows.map((r) => ({ code: r.account.code, amount: r.txnAmountMinor }));
}

/**
 * What an account carries at a date, debit-positive, straight off the lines.
 *
 * Read from the postings rather than from the balance cache so the test is
 * checking what was actually written, and counting both "posted" and
 * "reversed" for the reason every reader in this product does: a reversed
 * entry happened, and the reversing entry is what offsets it.
 */
async function balanceOf(code: string, asOf: string): Promise<bigint> {
  const account = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code }, select: { id: true } });
  if (!account) return 0n;
  const lines = await db.journalLine.findMany({
    where: {
      accountId: account.id,
      entry: { orgId: ORG, status: { in: ["posted", "reversed"] }, entryDate: { lte: new Date(`${asOf}T00:00:00.000Z`) } },
    },
    select: { functionalAmountMinor: true },
  });
  return lines.reduce((a, l) => a + l.functionalAmountMinor, 0n);
}

d("the allowance for doubtful debts", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    // The year after as well: the allowance is remeasured at successive dates
    // below, and an entry needs a period to land in.
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2027", startsOn: "2027-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    /*
     * Four debts, chosen so that at 2026-12-31 each falls in a different band
     * and every band figure is a round number:
     *
     *   raised 2026-12-15  → 16 days old  → not more than 30
     *   raised 2026-11-10  → 51 days old  → 31 to 60
     *   raised 2026-09-20  → 102 days old → 91 to 120
     *   raised 2026-03-01  → 305 days old → more than 120
     *
     * The 61-to-90 band is deliberately left empty, because a matrix that is
     * only ever exercised with every band populated never proves it handles
     * the one that is not.
     */
    await raise("INV-A", "2026-12-15", 10_000_00);
    await raise("INV-B", "2026-11-10", 20_000_00);
    await raise("INV-C", "2026-09-20", 30_000_00);
    await raise("INV-D", "2026-03-01", 40_000_00);
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------------ the matrix */

  it("multiplies each ageing band by its own loss rate, half-up, in whole minor units", () => {
    // 3,333.33 at 1.5% is 49.9999…, which truncates to 49.99 and rounds to
    // 50.00. Truncating five bands the same way understates the allowance
    // every single time, which is why this is half-up and why it is tested on
    // a figure that does not divide.
    const rows = provisionMatrix(
      { current: "333333", d31_60: "0", d61_90: "0", d91_120: "0", over120: "0" },
      { ...DEFAULT_MATRIX, current: 150 },
    );
    expect(rows[0].lossMinor).toBe("5000");
    expect(rows[0].ratePercent).toBe("1.50%");
    expect(rows.map((r) => r.band)).toEqual(BAND_ORDER);
  });

  it("applies a rate to nil rather than to a credit balance", () => {
    // An unapplied credit note leaves a band negative — `receivablesAgeing`
    // shows it rather than netting it away. Money the entity owes is not an
    // exposure to credit loss, and it must not be allowed to reduce another
    // band's provision either.
    const rows = provisionMatrix(
      { current: "-500000", d31_60: "1000000", d61_90: "0", d91_120: "0", over120: "0" },
      DEFAULT_MATRIX,
    );
    expect(rows[0].grossMinor).toBe("-500000");
    expect(rows[0].exposureMinor).toBe("0");
    expect(rows[0].lossMinor).toBe("0");
    // 10,000.00 at 2% — untouched by the credit balance beside it.
    expect(rows[1].lossMinor).toBe("20000");
  });

  it("refuses a rate that is not a whole percentage the standard could mean", async () => {
    expect(() => normaliseRates({ current: 2.5 })).toThrow(/whole basis points/i);
    expect(() => normaliseRates({ over120: -100 })).toThrow(/between 0 and 10,000/i);
    expect(() => normaliseRates({ over120: 10_001 })).toThrow(/more than the customer ever owed/i);
    // A rate that is not given falls back to the default rather than to nil,
    // which would silently provide nothing for that band.
    expect(normaliseRates({ current: 100 })).toEqual({ ...DEFAULT_MATRIX, current: 100 });
    expect(normaliseRates(null)).toEqual(DEFAULT_MATRIX);
  });

  it("does not call a blank form field a preparer's judgement", async () => {
    // A rate left empty on the screen arrives as undefined inside an object.
    // Treating the object's existence as the judgement would put "loss rates
    // set by the preparer" on an entry nobody set a rate on.
    const view = await allowanceView({
      orgId: ORG, entityId: ENT, asOf: "2026-12-31", rates: { current: undefined },
    });
    expect(view.ratesSupplied).toBe(false);
    expect(view.rates).toEqual(DEFAULT_MATRIX);
  });

  /* ------------------------------------------------------- the measurement */

  it("measures the allowance from the ageing and says what the ledger carries against it", async () => {
    const view = await allowanceView({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });

    expect(view.grossReceivablesMinor).toBe("10000000"); // 100,000.00 across four debts
    expect(Object.fromEntries(view.matrix.map((m) => [m.band, m.exposureMinor]))).toEqual({
      current: "1000000", d31_60: "2000000", d61_90: "0", d91_120: "3000000", over120: "4000000",
    });
    // 1,000,000 × 0.5% + 2,000,000 × 2% + 0 + 3,000,000 × 15% + 4,000,000 × 50%
    //      5,000  +      40,000       + 0 +     450,000       +   2,000,000
    expect(view.targetMinor).toBe("2495000");
    expect(view.carriedMinor).toBe("0");
    expect(view.movementMinor).toBe("2495000");
    expect(view.netReceivablesMinor).toBe("10000000");
    // Nothing has been posted at this date yet.
    expect(view.postedEntryId).toBeNull();
    expect(view.ratesSupplied).toBe(false);
  });

  it("posts the movement, not the target, and records the matrix on the entry", async () => {
    const r = await raiseAllowance({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
    expect(r.posted).toBe(true);
    expect(r.movementMinor).toBe("2495000");
    expect(r.targetMinor).toBe("2495000");
    expect(await linesOf(r.entryId!)).toEqual([
      { code: "6700", amount: 2_495_000n },
      { code: "1150", amount: -2_495_000n },
    ]);

    const entry = await db.journalEntry.findUnique({ where: { id: r.entryId! } });
    expect(entry?.source).toBe("allowance");
    expect(entry?.sourceType).toBe("ECL_ALLOWANCE");
    expect(entry?.series).toBe("AL");
    // The judgement lives on the entry, because there is no table for it and a
    // screen that recomputes it against a later ageing cannot answer an
    // auditor asking where THIS number came from.
    expect(entry?.memo).toMatch(/IFRS 9\.5\.5\.15/);
    expect(entry?.memo).toMatch(/More than 120 days old 50\.00% of 40,000\.00 = 20,000\.00/);
    expect(entry?.memo).toMatch(/Target 24,950\.00 against 0\.00 already carried on 1150/);
    // Nobody set the rates, and the entry says so rather than letting the
    // default pass as a measurement of this business's own experience.
    expect(entry?.memo).toMatch(/Loss rates left at the product default/);

    // The allowance is a contra-asset: a credit balance on 1150.
    expect(await balanceOf("1150", "2026-12-31")).toBe(-2_495_000n);
    expect(await balanceOf("6700", "2026-12-31")).toBe(2_495_000n);
  });

  it("is idempotent on the entity and the date", async () => {
    const again = await raiseAllowance({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
    expect(again.posted).toBe(false);
    expect(again.alreadyPosted).toBe(true);
    expect(again.note).toMatch(/already measured and posted/i);
    // Nothing was posted, and the positions beside that are the real ones —
    // reporting nought for a target it had not looked at would be the module
    // asserting something it had not established.
    expect(again.movementMinor).toBe("0");
    expect(again.targetMinor).toBe("2495000");
    expect(again.carriedMinor).toBe("2495000");
    expect(again.matrix).toHaveLength(5);
    // One entry, not two — the whole point of the key.
    expect(await db.journalEntry.count({
      where: { orgId: ORG, entityId: ENT, sourceType: "ECL_ALLOWANCE" },
    })).toBe(1);
    expect(await balanceOf("1150", "2026-12-31")).toBe(-2_495_000n);
  });

  it("posts nothing where the allowance carried is already what the matrix asks for", async () => {
    // A day later, with the same ageing and the same rates: the target has not
    // moved, so there is no movement, and an allowance that has not moved is
    // not a journal entry.
    const r = await raiseAllowance({ orgId: ORG, entityId: ENT, asOf: "2027-01-01" });
    expect(r.posted).toBe(false);
    expect(r.alreadyPosted).toBe(false);
    expect(r.movementMinor).toBe("0");
    expect(r.entryId).toBeNull();
    expect(r.note).toMatch(/nothing to post/i);
  });

  it("takes the loss rates as an argument and records whose they were", async () => {
    // The preparer's own experience says the oldest band is not half lost but
    // wholly lost, and the newest is fine.
    const rates: Partial<LossRates> = { current: 0, over120: 10_000 };
    const view = await allowanceView({ orgId: ORG, entityId: ENT, asOf: "2027-01-02", rates });
    // 0 + 40,000 + 0 + 450,000 + 4,000,000
    expect(view.targetMinor).toBe("4490000");
    expect(view.ratesSupplied).toBe(true);
    expect(view.carriedMinor).toBe("2495000");
    expect(view.movementMinor).toBe("1995000");

    const r = await raiseAllowance({ orgId: ORG, entityId: ENT, asOf: "2027-01-02", rates });
    expect(r.posted).toBe(true);
    expect(r.movementMinor).toBe("1995000");
    expect(await linesOf(r.entryId!)).toEqual([
      { code: "6700", amount: 1_995_000n },
      { code: "1150", amount: -1_995_000n },
    ]);
    const entry = await db.journalEntry.findUnique({ where: { id: r.entryId! } });
    expect(entry?.memo).toMatch(/Loss rates set by the preparer/);
    expect(entry?.memo).toMatch(/Not more than 30 days old 0\.00%/);
    expect(entry?.memo).toMatch(/More than 120 days old 100\.00% of 40,000\.00 = 40,000\.00/);
    // The second measurement charged only the difference. Posting the target
    // again would have charged 44,900 on top of the 24,950 already taken.
    expect(await balanceOf("1150", "2027-01-02")).toBe(-4_490_000n);
    expect(await balanceOf("6700", "2027-01-02")).toBe(4_490_000n);
  });

  it("releases the allowance where the matrix falls, rather than leaving it high", async () => {
    const r = await raiseAllowance({
      orgId: ORG, entityId: ENT, asOf: "2027-01-03",
      rates: { current: 0, d31_60: 0, d61_90: 0, d91_120: 0, over120: 0 },
    });
    expect(r.posted).toBe(true);
    expect(r.targetMinor).toBe("0");
    expect(r.movementMinor).toBe("-4490000");
    // The other way up: the allowance is debited and the expense credited back.
    expect(await linesOf(r.entryId!)).toEqual([
      { code: "1150", amount: 4_490_000n },
      { code: "6700", amount: -4_490_000n },
    ]);
    expect(await balanceOf("1150", "2027-01-03")).toBe(0n);
    expect(await balanceOf("6700", "2027-01-03")).toBe(0n);
  });

  /* --------------------------------------------- what the write-off consumes */

  it("hands the write-off an allowance to consume, which is what it was raised for", async () => {
    // Put the allowance back on, then write one debt off against it. The
    // expense was taken when the allowance was raised, so using it must charge
    // nothing further — that is the whole reason a provision matrix and a
    // write-off have to agree about what 1150 means.
    await raiseAllowance({ orgId: ORG, entityId: ENT, asOf: "2027-01-04" });
    const before = await balanceOf("1150", "2027-01-04");
    expect(before).toBeLessThan(0n);
    const expenseBefore = await balanceOf("6260", "2027-01-04");

    const docs = await allowanceView({ orgId: ORG, entityId: ENT, asOf: "2027-01-04" });
    expect(docs.history.length).toBe(4);

    const invoice = await db.journalEntry.findFirst({
      where: { orgId: ORG, entityId: ENT, source: "invoice", memo: { contains: "INV-A" } },
      select: { sourceId: true },
    });
    const w = await writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: invoice!.sourceId!,
      amountMinor: 1_000_000, against: "allowance",
      writtenOffOn: "2027-01-05", reason: "Customer liquidated, no distribution expected",
    });
    expect(await linesOf(w.entryId)).toEqual([
      { code: "1150", amount: 1_000_000n },
      { code: "1100", amount: -1_000_000n },
    ]);
    // Nothing extra reached the profit and loss account.
    expect(await balanceOf("6260", "2027-01-05")).toBe(expenseBefore);
    expect(await balanceOf("1150", "2027-01-05")).toBe(before + 1_000_000n);
  });

  /* ------------------------------------------------------------- refusals */

  it("refuses a date it cannot read", async () => {
    await expect(raiseAllowance({ orgId: ORG, entityId: ENT, asOf: "the year end" }))
      .rejects.toThrow(LedgerError);
    await expect(allowanceView({ orgId: ORG, entityId: ENT, asOf: "not a date" }))
      .rejects.toThrow(/written like 2026-12-31/i);
  });

  it("refuses an entity with no ledger rather than reporting a nil allowance for it", async () => {
    await expect(allowanceView({ orgId: ORG, entityId: "t-ent-allow-none", asOf: "2026-12-31" }))
      .rejects.toThrow(/No ledger has been opened/i);
  });
});
