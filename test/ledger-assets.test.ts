import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { addAsset, runDepreciation, disposeAsset, assetRegister, monthlyCharge, accumulatedAt } from "@/lib/server/ledger/assets";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { post } from "@/lib/server/ledger/post";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-fa";
const ENT = "t-ent-fa";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "FixedAsset" WHERE "orgId" = '${ORG}'`),
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

const A = (over: Partial<Parameters<typeof addAsset>[0]["asset"]> = {}) =>
  addAsset({
    orgId: ORG, entityId: ENT,
    asset: {
      code: "FA-001", name: "Delivery van", acquiredOn: "2026-01-15",
      costMinor: 12_000_000, usefulLifeMonths: 60, ...over,
    },
  });

describe("the depreciation charge", () => {
  it("divides a straight-line asset over its life", () => {
    expect(monthlyCharge({
      method: "STRAIGHT_LINE", costMinor: 12_000_000n, residualMinor: 0n,
      accumulatedMinor: 0n, usefulLifeMonths: 60,
    })).toBe(200_000n);
  });

  it("depreciates only down to the residual value", () => {
    expect(monthlyCharge({
      method: "STRAIGHT_LINE", costMinor: 12_000_000n, residualMinor: 2_400_000n,
      accumulatedMinor: 0n, usefulLifeMonths: 48,
    })).toBe(200_000n); // (12,000,000 − 2,400,000) / 48
  });

  it("lets the last month absorb the rounding so the schedule lands exactly", () => {
    // 100 over 3 months is 33, 33, and then 34 — not 33, 33, 33 with one left.
    expect(monthlyCharge({ method: "STRAIGHT_LINE", costMinor: 100n, residualMinor: 0n, accumulatedMinor: 0n, usefulLifeMonths: 3 })).toBe(33n);
    expect(monthlyCharge({ method: "STRAIGHT_LINE", costMinor: 100n, residualMinor: 0n, accumulatedMinor: 66n, usefulLifeMonths: 3 })).toBe(34n);
  });

  it("charges nothing once an asset is fully written down", () => {
    expect(monthlyCharge({
      method: "STRAIGHT_LINE", costMinor: 1_000n, residualMinor: 0n,
      accumulatedMinor: 1_000n, usefulLifeMonths: 10,
    })).toBe(0n);
  });

  it("takes the rate against what is left, for reducing balance", () => {
    // 25% a year on 12,000,000, monthly: 12,000,000 × 0.25 / 12 = 250,000.
    expect(monthlyCharge({
      method: "REDUCING_BALANCE", costMinor: 12_000_000n, residualMinor: 0n,
      accumulatedMinor: 0n, usefulLifeMonths: 60, ratePercent: 25,
    })).toBe(250_000n);
    // Next month it is smaller, because the balance is.
    expect(monthlyCharge({
      method: "REDUCING_BALANCE", costMinor: 12_000_000n, residualMinor: 0n,
      accumulatedMinor: 250_000n, usefulLifeMonths: 60, ratePercent: 25,
    })).toBe(244_791n);
  });

  it("never writes an asset below its residual", () => {
    const charge = monthlyCharge({
      method: "REDUCING_BALANCE", costMinor: 1_000_000n, residualMinor: 900_000n,
      accumulatedMinor: 99_000n, usefulLifeMonths: 60, ratePercent: 50,
    });
    expect(charge).toBe(1_000n); // only 1,000 of depreciable amount was left
  });
});

d("fixed assets", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
    // The asset has to be on the balance sheet before it can be depreciated.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-01-15", source: "manual", memo: "Van purchased",
      lines: [{ account: "1500", debit: 12_000_000 }, { account: "1010", credit: 12_000_000 }],
    });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("registers an asset", async () => {
    const a = await A();
    expect(a.code).toBe("FA-001");
    expect(a.accumulatedMinor).toBe(0n);
    expect(a.depreciatedTo).toBeNull();
  });

  it("refuses a second asset with the same code", async () => {
    await expect(A()).rejects.toThrow(/already on the register/i);
  });

  it("refuses a residual above cost, which would depreciate upwards", async () => {
    await expect(A({ code: "FA-BAD", costMinor: 1_000, residualMinor: 5_000 }))
      .rejects.toThrow(/more than the asset cost/i);
  });

  it("refuses reducing balance with no rate, and a rate on straight line", async () => {
    await expect(A({ code: "FA-RB", method: "REDUCING_BALANCE" })).rejects.toThrow(/needs an annual rate/i);
    await expect(A({ code: "FA-SL", ratePercent: 20 })).rejects.toThrow(/over its life, not at a rate/i);
  });

  it("posts a month of depreciation", async () => {
    const r = await runDepreciation({ orgId: ORG, entityId: ENT, period: "2026-02" });
    expect(r.assetsDepreciated).toBe(1);
    expect(r.totalChargeMinor).toBe("200000");
    expect(r.reference).toMatch(/^DP-/);

    const lines = await db.journalLine.findMany({ where: { entryId: r.entryId! }, include: { account: true } });
    const byCode = Object.fromEntries(lines.map((l) => [l.account.code, l.txnAmountMinor]));
    expect(byCode["6600"]).toBe(200_000n);   // Dr depreciation expense
    expect(byCode["1590"]).toBe(-200_000n);  // Cr accumulated depreciation
  });

  it("will not charge the same month twice", async () => {
    const r = await runDepreciation({ orgId: ORG, entityId: ENT, period: "2026-02" });
    expect(r.assetsDepreciated).toBe(0);
    expect(r.skipped[0].reason).toMatch(/already depreciated to 2026-02/);
    const asset = await db.fixedAsset.findFirst({ where: { orgId: ORG, code: "FA-001" } });
    expect(asset?.accumulatedMinor).toBe(200_000n);
  });

  it("does not depreciate an asset before it was acquired", async () => {
    await A({ code: "FA-FUTURE", name: "Not yet delivered", acquiredOn: "2026-06-01", costMinor: 600_000, usefulLifeMonths: 12 });
    const r = await runDepreciation({ orgId: ORG, entityId: ENT, period: "2026-03" });
    expect(r.skipped.find((s) => s.code === "FA-FUTURE")?.reason).toMatch(/after this period/);
  });

  it("refuses to silently catch up a missed month", async () => {
    // Depreciated to 2026-03; jumping to 2026-06 would fold three months into
    // one charge and hide that two runs were never made.
    const r = await runDepreciation({ orgId: ORG, entityId: ENT, period: "2026-06" });
    const skip = r.skipped.find((s) => s.code === "FA-001");
    expect(skip?.reason).toMatch(/run the months in between first/);
  });

  it("keeps the register tied to the ledger", async () => {
    const reg = await assetRegister({ orgId: ORG, entityId: ENT });
    expect(reg.ledger.costAgrees).toBe(false); // FA-FUTURE is registered but not yet purchased in the books
    const van = reg.assets.find((a) => a.code === "FA-001")!;
    expect(van.accumulatedMinor).toBe("400000"); // February and March
    expect(van.netBookValueMinor).toBe("11600000");
  });

  it("disposes of an asset and books the loss", async () => {
    const r = await disposeAsset({
      orgId: ORG, entityId: ENT, assetCode: "FA-001",
      disposedOn: "2026-04-10", proceedsMinor: 10_000_000,
    });
    // Net book value 11,600,000 sold for 10,000,000 — a 1,600,000 loss.
    expect(r.netBookValueMinor).toBe("11600000");
    expect(r.resultMinor).toBe("-1600000");
    expect(r.gain).toBe(false);

    const lines = await db.journalLine.findMany({ where: { entryId: r.entryId }, include: { account: true } });
    const byCode = Object.fromEntries(lines.map((l) => [l.account.code, l.txnAmountMinor]));
    expect(byCode["1010"]).toBe(10_000_000n);    // Dr proceeds
    expect(byCode["1590"]).toBe(400_000n);       // Dr accumulated depreciation written back
    expect(byCode["1500"]).toBe(-12_000_000n);   // Cr the asset at cost
    expect(byCode["6900"]).toBe(1_600_000n);     // Dr loss on disposal
  });

  it("says on the register when a disposed asset went and what it fetched", async () => {
    const reg = await assetRegister({ orgId: ORG, entityId: ENT });
    const van = reg.assets.find((a) => a.code === "FA-001")!;
    expect(van.status).toBe("disposed");
    // The disposal entry takes the cost and the depreciation back out of the
    // ledger, so the register row is the only place left that can say when the
    // van went and what it fetched. Without these two it said neither, and a
    // status chip is not an answer to either question.
    expect(van.disposedOn).toBe("2026-04-10");
    expect(van.proceedsMinor).toBe("10000000");

    // An asset still held carries neither — not an empty string, and not a
    // zero, which would read as "sold for nothing".
    const future = reg.assets.find((a) => a.code === "FA-FUTURE")!;
    expect(future.disposedOn).toBeNull();
    expect(future.proceedsMinor).toBeNull();

    // And drawn at a date before the sale, the van had not been sold: it is on
    // the register as active, and carrying the date or the proceeds onto that
    // row would date a disposal into a year that never saw it.
    const before = await assetRegister({ orgId: ORG, entityId: ENT, asOf: "2026-03-31" });
    const earlier = before.assets.find((a) => a.code === "FA-001")!;
    expect(earlier.status).toBe("active");
    expect(earlier.disposedOn).toBeNull();
    expect(earlier.proceedsMinor).toBeNull();
  });

  it("will not dispose of the same asset twice", async () => {
    await expect(disposeAsset({
      orgId: ORG, entityId: ENT, assetCode: "FA-001",
      disposedOn: "2026-04-11", proceedsMinor: 1,
    })).rejects.toThrow(/already disposed/i);
  });

  it("stops depreciating a disposed asset", async () => {
    const r = await runDepreciation({ orgId: ORG, entityId: ENT, period: "2026-04" });
    expect(r.skipped.find((s) => s.code === "FA-001")).toBeUndefined(); // not even considered
    const asset = await db.fixedAsset.findFirst({ where: { orgId: ORG, code: "FA-001" } });
    expect(asset?.accumulatedMinor).toBe(400_000n); // unchanged
  });

  it("books a gain when an asset sells for more than its book value", async () => {
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-05-01", source: "manual", memo: "Laptop purchased",
      lines: [{ account: "1500", debit: 500_000 }, { account: "1010", credit: 500_000 }],
    });
    await A({ code: "FA-LAP", name: "Laptop", acquiredOn: "2026-05-01", costMinor: 500_000, usefulLifeMonths: 36 });
    const r = await disposeAsset({
      orgId: ORG, entityId: ENT, assetCode: "FA-LAP",
      disposedOn: "2026-05-20", proceedsMinor: 600_000,
    });
    expect(r.gain).toBe(true);
    expect(r.resultMinor).toBe("100000");
    const lines = await db.journalLine.findMany({ where: { entryId: r.entryId }, include: { account: true } });
    expect(lines.find((l) => l.account.code === "4900")?.txnAmountMinor).toBe(-100_000n);
  });

  it("leaves the trial balance tied through purchase, depreciation and disposal", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-05" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });

  it("does not advance the register when a later run posts nothing", async () => {
    // An asset acquired into a month already depreciated: the run's idempotency
    // key would find the earlier entry, post() would return it having written
    // nothing, and the register would still be advanced — a charge with no
    // journal behind it, and the register silently ahead of the ledger.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-07-01", source: "manual", memo: "Printer",
      lines: [{ account: "1500", debit: 360_000 }, { account: "1010", credit: 360_000 }],
    });
    await A({ code: "FA-EARLY", name: "Printer one", acquiredOn: "2026-07-01", costMinor: 360_000, usefulLifeMonths: 36 });
    const first = await runDepreciation({ orgId: ORG, entityId: ENT, period: "2026-07" });
    expect(first.assetsDepreciated).toBeGreaterThanOrEqual(1);

    // A second asset arrives, back-dated into the same month.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-07-15", source: "manual", memo: "Printer two",
      lines: [{ account: "1500", debit: 720_000 }, { account: "1010", credit: 720_000 }],
    });
    await A({ code: "FA-LATE", name: "Printer two", acquiredOn: "2026-07-15", costMinor: 720_000, usefulLifeMonths: 36 });
    const second = await runDepreciation({ orgId: ORG, entityId: ENT, period: "2026-07" });

    const late = await db.fixedAsset.findFirst({ where: { orgId: ORG, code: "FA-LATE" } });
    if (second.assetsDepreciated > 0) {
      // If it charged, a journal must exist for what it charged.
      const lines = await db.journalLine.findMany({ where: { entryId: second.entryId! } });
      expect(lines.length).toBeGreaterThan(0);
      expect(late?.accumulatedMinor).toBeGreaterThan(0n);
    } else {
      // If it did not charge, the register must not have moved either.
      expect(late?.accumulatedMinor).toBe(0n);
      expect(late?.depreciatedTo).toBeNull();
    }

    // Either way the register and the ledger have to agree.
    const reg = await assetRegister({ orgId: ORG, entityId: ENT });
    expect(reg.ledger.accumulatedAgrees).toBe(true);
  });

  it("refuses a period that is not a month", async () => {
    await expect(runDepreciation({ orgId: ORG, entityId: ENT, period: "Q1" }))
      .rejects.toThrow(/looks like 2026-03/);
  });

  /* -------------------------------------------------- the register at a date */

  it("recomputes accumulated depreciation to a date from the asset's own schedule", () => {
    // 12,000.00 over 24 months, straight line: 500.00 a month, charged from the
    // month of acquisition. Six months to the end of June, not five.
    const a = {
      method: "STRAIGHT_LINE", costMinor: 1_200_000n, residualMinor: 0n,
      usefulLifeMonths: 24, ratePercent: null, acquiredOn: new Date("2026-01-15"),
    };
    expect(accumulatedAt(a, new Date("2026-01-31"))).toBe(50_000n);
    expect(accumulatedAt(a, new Date("2026-06-30"))).toBe(300_000n);
    expect(accumulatedAt(a, new Date("2027-12-31"))).toBe(1_200_000n);
    // And never past the depreciable amount, however far the date runs on.
    expect(accumulatedAt(a, new Date("2035-12-31"))).toBe(1_200_000n);
    // Nothing before it was bought.
    expect(accumulatedAt(a, new Date("2025-12-31"))).toBe(0n);
  });

  it("draws the register as it stood, not as it stands", async () => {
    const now = await assetRegister({ orgId: ORG, entityId: ENT });
    const then = await assetRegister({ orgId: ORG, entityId: ENT, asOf: "2020-01-01" });
    // Nothing in this entity existed in 2020, so the register then is empty
    // while the register now is not — which is the whole point of the date.
    expect(now.assets.length).toBeGreaterThan(0);
    expect(then.assets).toHaveLength(0);
    expect(then.ledger.costMinor).toBe("0");
  });

  it("refuses a date it cannot read", async () => {
    await expect(assetRegister({ orgId: ORG, entityId: ENT, asOf: "not a date" }))
      .rejects.toThrow(/date it can read/i);
  });
});
