import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  allocate, createContract, modifyContract, recordBilling, satisfyObligation,
  setProgress, cancelContract, runRecognition, runRecognitionAll,
  contractRegister, contractDetail, positionOf,
  CONTRACT_ASSET_ACCOUNT, CONTRACT_LIABILITY_ACCOUNT,
} from "@/lib/server/ledger/revenue";
import { reverse } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-rev";
const ENT = "t-ent-rev";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "PerformanceObligation" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "RevenueContract" WHERE "orgId" = '${ORG}'`),
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

/** One entry's journal lines, summed by account code. */
async function linesOf(entryId: string) {
  const lines = await db.journalLine.findMany({ where: { entryId }, include: { account: true } });
  const by: Record<string, bigint> = {};
  for (const l of lines) by[l.account.code] = (by[l.account.code] ?? 0n) + l.txnAmountMinor;
  return by;
}

/** What the ledger holds on one account, counting both halves of a reversal. */
async function held(code: string) {
  const rows = await db.journalLine.findMany({
    where: {
      orgId: ORG,
      account: { entityId: ENT, code },
      entry: { status: { in: ["posted", "reversed"] } },
    },
    select: { functionalAmountMinor: true },
  });
  return rows.reduce((a, r) => a + r.functionalAmountMinor, 0n);
}

describe("allocating a transaction price", () => {
  it("splits in proportion to standalone selling prices", () => {
    expect(allocate([600_000n, 400_000n], 1_000_000n)).toEqual([600_000n, 400_000n]);
  });

  it("gives the residue to the largest remainders, so the split sums to the price", () => {
    // 1000 over standalone prices 7, 11, 13 (sum 31):
    //   7000/31 = 225 r 25, 11000/31 = 354 r 26, 13000/31 = 419 r 11
    // The bases sum to 998, so two units are left; they go to the remainders
    // of 26 and 25, in that order.
    expect(allocate([7n, 11n, 13n], 1000n)).toEqual([226n, 355n, 419n]);
  });

  it("never loses a minor unit, whatever the proportions", () => {
    const cases: Array<[bigint[], bigint]> = [
      [[1n, 1n, 1n], 100n],
      [[1n, 2n, 3n, 4n], 999_999n],
      [[333n, 333n, 334n], 1n],
      [[9_999n, 1n], 12_345_678n],
    ];
    for (const [s, total] of cases) {
      expect(allocate(s, total).reduce((a, b) => a + b, 0n)).toBe(total);
    }
  });

  it("breaks ties towards the earlier obligation, so the answer is reproducible", () => {
    expect(allocate([1n, 1n, 1n], 100n)).toEqual([34n, 33n, 33n]);
  });

  it("refuses a contract with nothing promised in it", () => {
    expect(() => allocate([], 100n)).toThrow(/at least one performance obligation/i);
  });
});

d("recognising revenue against a contract", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("allocates the price across the obligations when the contract is recorded", async () => {
    const c = await createContract({
      ...S,
      contract: {
        code: "RC-001", customerName: "Gulf Logistics LLC", signedOn: "2026-01-05",
        priceMinor: 1_000_000, revenueAccount: "4100",
        obligations: [
          { description: "Software licence", standalonePriceMinor: 600_000, timing: "POINT_IN_TIME" },
          { description: "Twelve months of support", standalonePriceMinor: 400_000, timing: "OVER_TIME" },
        ],
      },
    });
    expect(c.obligations.map((o) => o.allocatedMinor)).toEqual([600_000n, 400_000n]);
    expect(c.obligations.reduce((a, o) => a + o.allocatedMinor, 0n)).toBe(c.priceMinor);
  });

  it("refuses a second contract on the same code, naming who the first is with", async () => {
    await expect(createContract({
      ...S,
      contract: {
        code: "RC-001", customerName: "Someone else", signedOn: "2026-01-05", priceMinor: 500_000,
        obligations: [{ description: "x", standalonePriceMinor: 1 }],
      },
    })).rejects.toThrow(/already exists — it is with Gulf Logistics LLC/);
  });

  it("refuses an obligation with no standalone price, and says how to estimate one", async () => {
    await expect(createContract({
      ...S,
      contract: {
        code: "RC-BAD", customerName: "Nobody", signedOn: "2026-01-05", priceMinor: 500_000,
        obligations: [{ description: "Free thing", standalonePriceMinor: 0 }],
      },
    })).rejects.toThrow(/nil has no proportion.*15\.79/is);
  });

  it("defers the whole price when it is billed before anything is delivered", async () => {
    await recordBilling({ ...S, code: "RC-001", amountMinor: 1_000_000 });
    const r = await runRecognition({ ...S, code: "RC-001", on: "2026-01-31" });

    expect(r.posted).toBe(true);
    const by = await linesOf(r.entryId!);
    expect(by["4100"]).toBe(1_000_000n);                    // Dr revenue, taking it back out
    expect(by[CONTRACT_LIABILITY_ACCOUNT]).toBe(-1_000_000n); // Cr contract liability
    expect(r.contractLiabilityMinor).toBe(1_000_000n);
    expect(r.note).toMatch(/billed but not yet earned/);
  });

  it("posts nothing on a second run, because the position has not moved", async () => {
    const r = await runRecognition({ ...S, code: "RC-001", on: "2026-01-31" });
    expect(r.posted).toBe(false);
    expect(r.revenueMinor).toBe(0n);
    expect(await held(CONTRACT_LIABILITY_ACCOUNT)).toBe(-1_000_000n);
  });

  it("releases an obligation's share when it is satisfied", async () => {
    await satisfyObligation({ ...S, code: "RC-001", seq: 1, on: "2026-02-10" });
    const r = await runRecognition({ ...S, code: "RC-001", on: "2026-02-28" });

    const by = await linesOf(r.entryId!);
    expect(by[CONTRACT_LIABILITY_ACCOUNT]).toBe(600_000n); // Dr, releasing the deferral
    expect(by["4100"]).toBe(-600_000n);                    // Cr revenue, now earned
    expect(r.contractLiabilityMinor).toBe(400_000n);
  });

  it("recognises an over-time obligation in proportion to progress", async () => {
    await setProgress({ ...S, code: "RC-001", seq: 2, progressBps: 5000 });
    const r = await runRecognition({ ...S, code: "RC-001", on: "2026-03-31" });

    const by = await linesOf(r.entryId!);
    expect(by["4100"]).toBe(-200_000n);                    // half of the 400,000 support
    expect(by[CONTRACT_LIABILITY_ACCOUNT]).toBe(200_000n);
  });

  it("posts a negative catch-up when a measure of progress is revised down", async () => {
    await setProgress({ ...S, code: "RC-001", seq: 2, progressBps: 2500 });
    const r = await runRecognition({ ...S, code: "RC-001", on: "2026-04-30" });

    const by = await linesOf(r.entryId!);
    expect(by["4100"]).toBe(100_000n);                     // Dr: revenue taken back
    expect(by[CONTRACT_LIABILITY_ACCOUNT]).toBe(-100_000n);
  });

  it("completes the contract once everything is earned and billed", async () => {
    await setProgress({ ...S, code: "RC-001", seq: 2, progressBps: 10000 });
    const r = await runRecognition({ ...S, code: "RC-001", on: "2026-05-31" });
    expect(r.contractLiabilityMinor).toBe(0n);

    const c = await db.revenueContract.findFirst({ where: { orgId: ORG, code: "RC-001" } });
    expect(c!.status).toBe("complete");
  });

  it("nets to nothing over the life of the contract — it moves revenue, it never makes any", async () => {
    // Every entry this module posted for RC-001, summed on the revenue account.
    const rows = await db.journalLine.findMany({
      where: {
        orgId: ORG,
        account: { entityId: ENT, code: "4100" },
        entry: { status: { in: ["posted", "reversed"] }, sourceType: "revenue_contract", sourceId: (await db.revenueContract.findFirstOrThrow({ where: { orgId: ORG, code: "RC-001" } })).id },
      },
      select: { functionalAmountMinor: true },
    });
    expect(rows.reduce((a, r) => a + r.functionalAmountMinor, 0n)).toBe(0n);
    expect(await held(CONTRACT_LIABILITY_ACCOUNT)).toBe(0n);
  });

  it("holds a contract asset when the work runs ahead of the invoice", async () => {
    await createContract({
      ...S,
      contract: {
        code: "RC-002", customerName: "Emaar Facilities", signedOn: "2026-02-01",
        priceMinor: 900_000,
        obligations: [
          { description: "Fit-out, phase one", standalonePriceMinor: 500_000, timing: "OVER_TIME" },
          { description: "Fit-out, phase two", standalonePriceMinor: 400_000, timing: "OVER_TIME" },
        ],
      },
    });
    await setProgress({ ...S, code: "RC-002", seq: 1, progressBps: 10000 });
    const r = await runRecognition({ ...S, code: "RC-002", on: "2026-03-31" });

    const by = await linesOf(r.entryId!);
    expect(by[CONTRACT_ASSET_ACCOUNT]).toBe(500_000n);     // Dr unbilled revenue
    expect(by["4100"]).toBe(-500_000n);
    expect(r.contractAssetMinor).toBe(500_000n);
  });

  it("turns the contract asset into nothing once the invoice catches up", async () => {
    await recordBilling({ ...S, code: "RC-002", amountMinor: 500_000 });
    const r = await runRecognition({ ...S, code: "RC-002", on: "2026-04-30" });

    const by = await linesOf(r.entryId!);
    expect(by[CONTRACT_ASSET_ACCOUNT]).toBe(-500_000n);    // Cr, the asset is billed out
    expect(by["4100"]).toBe(500_000n);
    expect(await held(CONTRACT_ASSET_ACCOUNT)).toBe(0n);
  });

  it("crosses from asset to liability in a single entry when billing overtakes delivery", async () => {
    await recordBilling({ ...S, code: "RC-002", amountMinor: 400_000 });
    // Nothing more has been delivered, so the extra 400,000 is deferred.
    const r = await runRecognition({ ...S, code: "RC-002", on: "2026-05-31" });

    const by = await linesOf(r.entryId!);
    expect(by[CONTRACT_LIABILITY_ACCOUNT]).toBe(-400_000n);
    expect(by["4100"]).toBe(400_000n);
    expect(r.contractAssetMinor).toBe(0n);
    expect(r.contractLiabilityMinor).toBe(400_000n);
  });

  it("refuses to bill more than the contract is worth", async () => {
    await expect(recordBilling({ ...S, code: "RC-002", amountMinor: 1 }))
      .rejects.toThrow(/above its transaction price of 9000\.00/);
  });

  it("reallocates on a modification and catches the difference up in the current period", async () => {
    // The customer adds scope: the price rises to 12,000.00 and phase two is
    // worth more standing alone than it was.
    const c = await modifyContract({ ...S, code: "RC-002", priceMinor: 1_200_000, standalone: { 2: 700_000 } });
    expect(c.obligations.map((o) => o.allocatedMinor)).toEqual([500_000n, 700_000n]);
    // Phase one is complete, so its recognised amount follows its allocation.
    expect(c.obligations[0].recognisedMinor).toBe(500_000n);

    const r = await runRecognition({ ...S, code: "RC-002", on: "2026-06-30" });
    // Earned is still 500,000 and billed is 900,000, so the position has not
    // moved: a reallocation that changes nothing earned changes nothing posted.
    expect(r.posted).toBe(false);

    await setProgress({ ...S, code: "RC-002", seq: 2, progressBps: 10000 });
    const r2 = await runRecognition({ ...S, code: "RC-002", on: "2026-06-30" });
    const by = await linesOf(r2.entryId!);
    expect(by["4100"]).toBe(-700_000n);
    expect(by[CONTRACT_LIABILITY_ACCOUNT]).toBe(400_000n);
    expect(by[CONTRACT_ASSET_ACCOUNT]).toBe(300_000n);     // earned 1,200,000 against 900,000 billed
  });

  it("repairs itself when one of its entries is reversed by hand", async () => {
    const entry = await db.journalEntry.findFirstOrThrow({
      where: { orgId: ORG, sourceType: "revenue_contract", status: "posted" },
      orderBy: { createdAt: "desc" },
    });
    const before = await held(CONTRACT_ASSET_ACCOUNT);
    await reverse({ orgId: ORG, entryId: entry.id, entryDate: "2026-07-01", memo: "Reversed in error" });
    expect(await held(CONTRACT_ASSET_ACCOUNT)).not.toBe(before);

    // The next run reads what the ledger actually holds, so it puts back
    // exactly what the reversal removed rather than doubling it.
    const r = await runRecognition({ ...S, code: "RC-002", on: "2026-07-31" });
    expect(r.posted).toBe(true);
    expect(await held(CONTRACT_ASSET_ACCOUNT)).toBe(before);
  });

  it("refuses to mark an over-time obligation done on a date", async () => {
    await expect(satisfyObligation({ ...S, code: "RC-002", seq: 2, on: "2026-07-31" }))
      .rejects.toThrow(/satisfied over time.*progress/is);
  });

  it("refuses progress outside the scale, saying what the scale is", async () => {
    await expect(setProgress({ ...S, code: "RC-002", seq: 2, progressBps: 12000 }))
      .rejects.toThrow(/basis points, from 0 to 10000/);
  });

  it("keeps the two kinds of obligation apart, and refuses to satisfy one twice", async () => {
    // A contract of its own, because the checks below are about an obligation's
    // timing rather than about anything that has happened to RC-001.
    await createContract({
      ...S,
      contract: {
        code: "RC-004", customerName: "Ajman Steel", signedOn: "2026-04-01", priceMinor: 200_000,
        obligations: [
          { description: "Delivery", standalonePriceMinor: 100_000, timing: "POINT_IN_TIME" },
          { description: "Maintenance", standalonePriceMinor: 100_000, timing: "OVER_TIME" },
        ],
      },
    });

    await expect(setProgress({ ...S, code: "RC-004", seq: 1, progressBps: 5000 }))
      .rejects.toThrow(/point in time.*delivered or it is not/is);

    await satisfyObligation({ ...S, code: "RC-004", seq: 1, on: "2026-04-20" });
    await expect(satisfyObligation({ ...S, code: "RC-004", seq: 1, on: "2026-05-01" }))
      .rejects.toThrow(/already satisfied on 2026-04-20/);
  });

  it("stops recognising a cancelled contract but leaves what was earned alone", async () => {
    await createContract({
      ...S,
      contract: {
        code: "RC-003", customerName: "Sharjah Media", signedOn: "2026-03-01", priceMinor: 300_000,
        obligations: [{ description: "Campaign", standalonePriceMinor: 300_000, timing: "OVER_TIME" }],
      },
    });
    await setProgress({ ...S, code: "RC-003", seq: 1, progressBps: 3000 });
    await runRecognition({ ...S, code: "RC-003", on: "2026-08-31" });
    await cancelContract({ ...S, code: "RC-003" });

    await expect(setProgress({ ...S, code: "RC-003", seq: 1, progressBps: 6000 }))
      .rejects.toThrow(/is cancelled/);
    const det = await contractDetail({ ...S, code: "RC-003" });
    expect(det.earnedMinor).toBe(90_000n);
    expect(det.pendingMinor).toBe(0n);
  });

  it("explains a difference that is only a run not yet made", async () => {
    // RC-004 has delivered an obligation that has not been recognised, so the
    // register is ahead of the ledger — and the screen has to be able to say
    // that this is work outstanding rather than a defect.
    const reg = await contractRegister(S);
    expect(reg.reconciliation.agrees).toBe(false);
    expect(reg.reconciliation.pendingAssetMinor).toBe(100_000n);
    expect(reg.reconciliation.explained).toBe(true);
  });

  it("ties the register to the ledger once recognition has run", async () => {
    await runRecognition({ ...S, code: "RC-004", on: "2026-09-30" });
    const reg = await contractRegister(S);
    expect(reg.reconciliation.agrees).toBe(true);
    expect(reg.reconciliation.assetDifferenceMinor).toBe(0n);
    expect(reg.reconciliation.liabilityDifferenceMinor).toBe(0n);
    expect(reg.reconciliation.pendingAssetMinor).toBe(0n);
    expect(reg.contracts.map((c) => c.code)).toContain("RC-002");
  });

  it("leaves the books balanced after everything above", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-09" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });

  it("runs every contract in one pass, and the pass after it has nothing to do", async () => {
    const all = await runRecognitionAll({ ...S, on: "2026-09-30" });
    expect(all.results.map((r) => r.code)).toEqual(["RC-001", "RC-002", "RC-003", "RC-004"]);

    // RC-004 delivered something and billed nothing, so the first sweep has
    // work to do; the second must not, or the sweep is not idempotent.
    const again = await runRecognitionAll({ ...S, on: "2026-09-30" });
    expect(again.postedCount).toBe(0);
    expect(again.revenueMinor).toBe(0n);
  });

  it("does not find another organisation's contract", async () => {
    await expect(contractDetail({ orgId: "someone-else", entityId: ENT, code: "RC-001" }))
      .rejects.toThrow(/no contract RC-001/);
  });

  it("computes a position from the contract alone, for a screen that has one to hand", async () => {
    const c = await db.revenueContract.findFirstOrThrow({
      where: { orgId: ORG, code: "RC-003" }, include: { obligations: true },
    });
    const p = positionOf(c);
    expect(p.earnedMinor).toBe(90_000n);
    expect(p.billedMinor).toBe(0n);
    expect(p.contractAssetMinor).toBe(90_000n);
    expect(p.unearnedMinor).toBe(210_000n);
  });
});
