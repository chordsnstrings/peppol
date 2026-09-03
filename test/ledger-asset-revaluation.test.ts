import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  splitMovement, revalueAsset, releaseSurplus, revaluationRegister, revaluationHistory,
  carryingOf, unimpairedCarrying, SURPLUS_ACCOUNT, IMPAIRMENT_ACCOUNT,
} from "@/lib/server/ledger/asset-revaluation";
import { addAsset, runDepreciation } from "@/lib/server/ledger/assets";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-rev16";
const ENT = "t-ent-rev16";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "AssetRevaluation" WHERE "orgId" = '${ORG}'`),
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

async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true } });
  const by: Record<string, bigint> = {};
  for (const r of rows) by[r.account.code] = (by[r.account.code] ?? 0n) + r.txnAmountMinor;
  return by;
}

describe("the IAS 16.39-40 split", () => {
  it("puts an increase into the surplus when nothing was ever charged to profit", () => {
    const s = splitMovement({ movementMinor: 100_000n, surplusMinor: 0n, impairedMinor: 0n, reversalRoomMinor: 0n });
    expect(s.toSurplusMinor).toBe(100_000n);
    expect(s.toProfitMinor).toBe(0n);
    expect(s.kind).toBe("REVALUATION");
    expect(s.reasoning).toMatch(/whole increase is a revaluation surplus/);
  });

  it("sends an increase back to profit first, to the extent profit bore the fall", () => {
    // 60,000 was charged to profit before; an increase of 100,000 reverses that
    // and the remaining 40,000 is a surplus.
    const s = splitMovement({ movementMinor: 100_000n, surplusMinor: 0n, impairedMinor: 60_000n, reversalRoomMinor: 100_000n });
    expect(s.toProfitMinor).toBe(60_000n);
    expect(s.toSurplusMinor).toBe(40_000n);
    expect(s.impairedAfterMinor).toBe(0n);
    expect(s.reasoning).toMatch(/IAS 36\.117/);
  });

  it("caps the reversal at what the asset would have been carried at anyway", () => {
    // 60,000 was charged, but only 25,000 of room is left because the asset
    // would have gone on depreciating in the meantime.
    const s = splitMovement({ movementMinor: 100_000n, surplusMinor: 0n, impairedMinor: 60_000n, reversalRoomMinor: 25_000n });
    expect(s.toProfitMinor).toBe(25_000n);
    expect(s.toSurplusMinor).toBe(75_000n);
    expect(s.impairedAfterMinor).toBe(35_000n);
  });

  it("takes a fall out of this asset's own surplus first", () => {
    const s = splitMovement({ movementMinor: -30_000n, surplusMinor: 50_000n, impairedMinor: 0n, reversalRoomMinor: 0n });
    expect(s.toSurplusMinor).toBe(-30_000n);
    expect(s.toProfitMinor).toBe(0n);
    expect(s.surplusAfterMinor).toBe(20_000n);
    expect(s.kind).toBe("REVALUATION");
  });

  it("charges to profit only what the surplus cannot absorb", () => {
    const s = splitMovement({ movementMinor: -80_000n, surplusMinor: 50_000n, impairedMinor: 0n, reversalRoomMinor: 0n });
    expect(s.toSurplusMinor).toBe(-50_000n);
    expect(s.toProfitMinor).toBe(-30_000n);
    expect(s.surplusAfterMinor).toBe(0n);
    expect(s.impairedAfterMinor).toBe(30_000n);
    expect(s.kind).toBe("IMPAIRMENT");
  });

  it("always splits the movement exactly, whatever the inputs", () => {
    const cases: [bigint, bigint, bigint, bigint][] = [
      [100n, 0n, 0n, 0n], [-100n, 40n, 0n, 0n], [7n, 0n, 3n, 5n], [-1n, 1n, 0n, 0n], [0n, 9n, 9n, 9n],
    ];
    for (const [m, surplus, impaired, room] of cases) {
      const s = splitMovement({ movementMinor: m, surplusMinor: surplus, impairedMinor: impaired, reversalRoomMinor: room });
      expect(s.toSurplusMinor + s.toProfitMinor).toBe(m);
      expect(s.surplusAfterMinor >= 0n).toBe(true);
      expect(s.impairedAfterMinor >= 0n).toBe(true);
    }
  });
});

d("revaluing and impairing an asset", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
    // 1,200,000 over 24 months, straight line: 50,000 a month from January.
    await addAsset({
      ...S,
      asset: {
        code: "FA-1", name: "Warehouse fit-out", acquiredOn: "2026-01-15",
        costMinor: 1_200_000, usefulLifeMonths: 24, method: "STRAIGHT_LINE",
      },
    });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("charges the first fall to profit, because nothing is held in equity for it", async () => {
    // Six months' depreciation first: 300,000, leaving 900,000 carried.
    for (const m of ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]) {
      await runDepreciation({ ...S, period: m });
    }
    const before = await db.fixedAsset.findFirstOrThrow({ where: { orgId: ORG, code: "FA-1" } });
    expect(carryingOf(before)).toBe(900_000n);

    const r = await revalueAsset({ ...S, code: "FA-1", on: "2026-06-30", fairValueMinor: 700_000, basis: "Valuer's report" });
    expect(r.kind).toBe("IMPAIRMENT");
    expect(r.movementMinor).toBe(-200_000n);
    expect(r.toProfitMinor).toBe(-200_000n);
    expect(r.toSurplusMinor).toBe(0n);

    const by = await linesOf(r.entryId!);
    // Accumulated depreciation eliminated against cost, then the fall.
    expect(by["1590"]).toBe(300_000n);
    expect(by["1500"]).toBe(-300_000n - 200_000n);
    expect(by[IMPAIRMENT_ACCOUNT]).toBe(200_000n);
  });

  it("restates the register so depreciation follows the new carrying amount", async () => {
    const a = await db.fixedAsset.findFirstOrThrow({ where: { orgId: ORG, code: "FA-1" } });
    expect(a.costMinor).toBe(700_000n);
    expect(a.accumulatedMinor).toBe(0n);
    expect(a.impairedMinor).toBe(200_000n);
    expect(a.surplusMinor).toBe(0n);
  });

  it("reverses that charge before crediting equity, and no further than the ceiling", async () => {
    // Valued back up to 1,000,000 at the end of July. Had it never been
    // impaired it would stand at 1,200,000 less seven months at 50,000, which
    // is 850,000 — so only 850,000 − 650,000 may go back to profit.
    await runDepreciation({ ...S, period: "2026-07" });
    const mid = await db.fixedAsset.findFirstOrThrow({ where: { orgId: ORG, code: "FA-1" } });
    const carrying = carryingOf(mid);

    const events = await db.assetRevaluation.findMany({ where: { assetId: mid.id }, orderBy: { seq: "asc" } });
    const ceiling = unimpairedCarrying(mid as never, events as never, new Date("2026-07-31"));
    expect(ceiling).toBe(850_000n);

    const r = await revalueAsset({ ...S, code: "FA-1", on: "2026-07-31", fairValueMinor: 1_000_000 });
    expect(r.ceilingMinor).toBe(850_000n);
    expect(r.toProfitMinor).toBe(850_000n - carrying);
    expect(r.toSurplusMinor).toBe(1_000_000n - 850_000n);
    expect(r.toSurplusMinor + r.toProfitMinor).toBe(r.movementMinor);

    const by = await linesOf(r.entryId!);
    expect(by[SURPLUS_ACCOUNT]).toBe(-r.toSurplusMinor);
    expect(by[IMPAIRMENT_ACCOUNT]).toBe(-r.toProfitMinor);
  });

  it("takes the next fall out of the surplus before it reaches profit", async () => {
    const before = await db.fixedAsset.findFirstOrThrow({ where: { orgId: ORG, code: "FA-1" } });
    const surplus = before.surplusMinor;
    expect(surplus > 0n).toBe(true);

    const target = carryingOf(before) - surplus - 10_000n;
    const r = await revalueAsset({ ...S, code: "FA-1", on: "2026-08-31", fairValueMinor: target.toString() });
    expect(r.toSurplusMinor).toBe(-surplus);
    expect(r.toProfitMinor).toBe(-10_000n);
    expect(r.surplusAfterMinor).toBe(0n);
    expect(r.reasoning).toMatch(/IAS 16\.40/);
  });

  it("posts nothing when the valuation is what the books already carry", async () => {
    const a = await db.fixedAsset.findFirstOrThrow({ where: { orgId: ORG, code: "FA-1" } });
    const r = await revalueAsset({ ...S, code: "FA-1", on: "2026-09-30", fairValueMinor: carryingOf(a).toString() });
    expect(r.movementMinor).toBe(0n);
    expect(r.entryId).toBeNull();
    expect(r.note).toMatch(/Nothing posted/);
  });

  it("refuses a value before the asset existed, and a negative one", async () => {
    await expect(revalueAsset({ ...S, code: "FA-1", on: "2025-12-31", fairValueMinor: 100 }))
      .rejects.toThrow(/cannot be valued before it existed/i);
    await expect(revalueAsset({ ...S, code: "FA-1", on: "2026-09-30", fairValueMinor: -1 }))
      .rejects.toThrow(/cannot be worth less than nothing/i);
  });

  it("refuses an asset that is not on the register", async () => {
    await expect(revalueAsset({ ...S, code: "NOPE", on: "2026-09-30", fairValueMinor: 100 }))
      .rejects.toThrow(/no asset NOPE/i);
  });

  /* ------------------------------------------------------- the surplus */

  it("moves a realised surplus to retained earnings without changing equity in total", async () => {
    await revalueAsset({ ...S, code: "FA-1", on: "2026-10-31", fairValueMinor: 1_500_000 });
    const a = await db.fixedAsset.findFirstOrThrow({ where: { orgId: ORG, code: "FA-1" } });
    expect(a.surplusMinor > 0n).toBe(true);

    const r = await releaseSurplus({ ...S, code: "FA-1", on: "2026-10-31", amountMinor: 50_000 });
    expect(r.transferredMinor).toBe(50_000n);
    const by = await linesOf(r.entryId);
    expect(by[SURPLUS_ACCOUNT]).toBe(50_000n);
    expect(by["3900"]).toBe(-50_000n);
    expect(r.note).toMatch(/Equity is unchanged in total/);
  });

  it("refuses to transfer more surplus than the asset carries", async () => {
    await expect(releaseSurplus({ ...S, code: "FA-1", on: "2026-10-31", amountMinor: 99_999_999 }))
      .rejects.toThrow(/never more than was put there/i);
  });

  it("refuses a transfer from an asset that carries none", async () => {
    await addAsset({
      ...S,
      asset: { code: "FA-2", name: "Van", acquiredOn: "2026-02-01", costMinor: 500_000, usefulLifeMonths: 60 },
    });
    await expect(releaseSurplus({ ...S, code: "FA-2", on: "2026-10-31" }))
      .rejects.toThrow(/carries no revaluation surplus/i);
  });

  /* ----------------------------------------------------- the register */

  it("ties the register to the ledger, which is the only reason to show it", async () => {
    const reg = await revaluationRegister(S);
    expect(reg.reconciliation.agrees).toBe(true);
    expect(reg.reconciliation.differenceMinor).toBe(0n);
    expect(reg.assets.map((a) => a.code)).toContain("FA-1");
    // FA-2 has never been revalued, so it is not in the register at all.
    expect(reg.assets.map((a) => a.code)).not.toContain("FA-2");
  });

  it("keeps every event, so the split can be checked afterwards", async () => {
    const h = await revaluationHistory({ ...S, code: "FA-1" });
    expect(h.events.length).toBeGreaterThanOrEqual(4);
    expect(h.events.map((e) => e.seq)).toEqual([...h.events.map((_, i) => i + 1)]);
    for (const e of h.events) {
      expect(e.toSurplusMinor + e.toProfitMinor).toBe(e.movementMinor);
      expect(e.fairValueMinor - e.carryingBeforeMinor).toBe(e.movementMinor);
    }
    expect(h.events[0].basis).toBe("Valuer's report");
  });

  it("leaves the books balanced after all of it", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-10" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });

  it("does not revalue another organisation's asset", async () => {
    await expect(revalueAsset({ orgId: "someone-else", entityId: ENT, code: "FA-1", on: "2026-10-31", fairValueMinor: 1 }))
      .rejects.toThrow(/no asset FA-1/i);
  });
});
