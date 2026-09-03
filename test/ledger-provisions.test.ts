import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  recordProvision, remeasure, unwindDiscount, utilise, release, promote,
  provisionRegister, provisionNote,
  presentValue, monthlyRateBps, monthsUntil, recognitionTest, discountedEstimate,
} from "@/lib/server/ledger/provisions";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-prov";
const ENT = "t-ent-prov";
/** A second entity inside the SAME org, which is the harder isolation test. */
const ENT2 = "t-ent-prov-other";
/** And a second org, to prove nothing here is readable by entity id alone. */
const ORG2 = "t-org-prov-other";

async function wipe() {
  for (const org of [ORG, ORG2]) {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      // Movements first: the cascade is a foreign key, and foreign keys are
      // exactly what the replica role has just switched off.
      db.$executeRawUnsafe(`DELETE FROM "ProvisionMovement" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "Provision" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${org}')`),
      db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${org}'`),
    ]);
  }
}

/** One entry's journal lines, summed by account code. */
async function linesOf(entryId: string) {
  const lines = await db.journalLine.findMany({ where: { entryId }, include: { account: true } });
  const by: Record<string, bigint> = {};
  for (const l of lines) by[l.account.code] = (by[l.account.code] ?? 0n) + l.txnAmountMinor;
  return by;
}

const row = (code: string, orgId = ORG, entityId = ENT) =>
  db.provision.findFirst({ where: { orgId, entityId, code } });

const movementsOf = async (code: string) => {
  const p = await row(code);
  return db.provisionMovement.findMany({ where: { orgId: ORG, provisionId: p!.id }, orderBy: { seq: "asc" } });
};

/*
 * The two provisions the suite is built on, both hand-computed.
 *
 *   PR-WARRANTY  6,000.00 recognised 31 Jan, undiscounted.
 *   PR-LEGAL    10,000.00 expected 31 Dec 2026, recognised 31 Jan 2026 at 12%
 *               a year — exactly 100 basis points a month over 11 months:
 *
 *                 1,000,000 / 1.01^11 = 896,323.98…  →  896,324
 *
 *               and 1.01^11 = 11156683466653165551101 / 10^22, so the figure
 *               below is that division rounded half-up, done in whole fils.
 */
const PV_LEGAL = 896_324n;
/** 896,324 × 1% = 8,963.24 → 8,963, so February leaves 905,287. */
const UNWIND_FEB = 8_963n;
/** 905,287 × 1% = 9,052.87 → 9,053, so March leaves 914,340. */
const UNWIND_MAR = 9_053n;
const CARRYING_MAR = PV_LEGAL + UNWIND_FEB + UNWIND_MAR;
/** 2,500,000 / 1.01^12, the promoted claim measured twelve months out. */
const PV_CLAIM = 2_218_623n;

describe("discounting a provision", () => {
  it("discounts a single amount to a hand-computed present value", () => {
    expect(presentValue({ amountMinor: 1_000_000, ratePerPeriodBps: 100, periods: 11 })).toBe(PV_LEGAL);
    expect(presentValue({ amountMinor: 2_500_000, ratePerPeriodBps: 100, periods: 12 })).toBe(PV_CLAIM);
    // 1,000.00 in one period at 1%: 100000/1.01 = 99,009.90… → 99,010.
    expect(presentValue({ amountMinor: 100_000, ratePerPeriodBps: 100, periods: 1 })).toBe(99_010n);
  });

  it("leaves an undiscounted estimate exactly as it is", () => {
    expect(presentValue({ amountMinor: 1_000_000, ratePerPeriodBps: 0, periods: 11 })).toBe(1_000_000n);
    expect(presentValue({ amountMinor: 1_000_000, ratePerPeriodBps: 100, periods: 0 })).toBe(1_000_000n);
  });

  it("refuses a rate the schema would not hold", () => {
    expect(() => presentValue({ amountMinor: 100, ratePerPeriodBps: 10_001, periods: 1 })).toThrow(/between 0 and 10000/);
    expect(() => presentValue({ amountMinor: 100, ratePerPeriodBps: 5.5, periods: 1 })).toThrow(/whole number of basis points/);
    expect(() => monthlyRateBps(-1)).toThrow(/0 to 10000 basis points/);
  });

  it("turns an annual rate into a monthly one, to the nearest basis point", () => {
    expect(monthlyRateBps(1200)).toBe(100);   // 12% a year is exactly 100bp a month
    expect(monthlyRateBps(600)).toBe(50);
    expect(monthlyRateBps(500)).toBe(42);     // 41.67bp, rounded up — an effective 5.04%
    expect(monthlyRateBps(0)).toBe(0);
  });

  it("counts whole calendar months, and never fewer than none", () => {
    expect(monthsUntil(new Date("2026-01-31"), new Date("2026-12-31"))).toBe(11);
    expect(monthsUntil(new Date("2026-06-30"), new Date("2027-06-30"))).toBe(12);
    expect(monthsUntil(new Date("2026-06-01"), new Date("2026-06-30"))).toBe(0);
    expect(monthsUntil(new Date("2026-06-30"), new Date("2026-01-01"))).toBe(0);
  });

  it("will not discount without a date to discount to", () => {
    expect(() => discountedEstimate({
      estimateMinor: 1_000_000n, annualRateBps: 1200, from: new Date("2026-01-31"), expectedOn: null,
    })).toThrow(/needs a date to discount to/i);
  });
});

describe("the IAS 37.14 recognition test", () => {
  it("passes all three for a provision, and says the outflow is not probable for a contingency", () => {
    const p = recognitionTest("PROVISION", 100n);
    expect(p.recognised).toBe(true);
    expect(p.tests.map((t) => t.pass)).toEqual([true, true, true]);
    expect(p.basis).toMatch(/IAS 37\.14/);

    const c = recognitionTest("CONTINGENT_LIABILITY", 100n);
    expect(c.recognised).toBe(false);
    expect(c.tests[1].pass).toBe(false);
    expect(c.basis).toMatch(/disclosed, never recognised \(IAS 37\.27\)/);
  });

  it("never recognises a contingent asset, whatever the amount", () => {
    const a = recognitionTest("CONTINGENT_ASSET", 5_000_000n);
    expect(a.recognised).toBe(false);
    expect(a.basis).toMatch(/IAS 37\.31/);
  });

  it("fails the reliable-estimate test when there is no amount", () => {
    expect(recognitionTest("CONTINGENT_LIABILITY", 0n).tests[2].pass).toBe(false);
  });
});

d("provisions and contingencies under IAS 37", () => {
  beforeAll(async () => {
    await wipe();
    for (const [org, ent] of [[ORG, ENT], [ORG, ENT2], [ORG2, ENT]] as const) {
      await openFiscalYear({ orgId: org, entityId: ent, label: "2026", startsOn: "2026-01-01" });
      await openBooks({ orgId: org, entityId: ent });
    }
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------------ recognition */

  it("recognises a provision and posts the charge against 2150", async () => {
    const r = await recordProvision({
      orgId: ORG, entityId: ENT,
      code: "PR-WARRANTY", name: "Warranty on the 2025 installations", category: "WARRANTY",
      recognisedOn: "2026-01-31", estimateMinor: 600_000,
    });
    expect(r.recognised).toBe(true);
    expect(r.carryingMinor).toBe("600000");
    expect(r.discountMinor).toBe("0");
    expect(r.reference).toMatch(/^PV-/);
    expect(r.recognitionTest.tests.every((t) => t.pass === true)).toBe(true);

    const by = await linesOf(r.entryId!);
    expect(by["6900"]).toBe(600_000n);     // Dr the expense it belongs to
    expect(by["2150"]).toBe(-600_000n);    // Cr provisions
    expect(Object.keys(by).sort()).toEqual(["2150", "6900"]);

    const m = await movementsOf("PR-WARRANTY");
    expect(m).toHaveLength(1);
    expect(m[0].kind).toBe("RECOGNISE");
    expect(m[0].amountMinor).toBe(600_000n);
    expect(m[0].entryId).toBe(r.entryId);
  });

  it("measures a provision at present value where a rate is given, over a hand-computed term", async () => {
    const r = await recordProvision({
      orgId: ORG, entityId: ENT,
      code: "PR-LEGAL", name: "Claim by a former subcontractor", category: "LEGAL",
      recognisedOn: "2026-01-31", estimateMinor: 1_000_000,
      discountRateBps: 1200, expectedOn: "2026-12-31",
    });
    expect(r.months).toBe(11);
    expect(r.monthlyRateBps).toBe(100);
    expect(r.carryingMinor).toBe(PV_LEGAL.toString());
    expect(r.discountMinor).toBe((1_000_000n - PV_LEGAL).toString());
    expect(r.message).toMatch(/unwinds as a finance cost \(IAS 37\.60\)/);

    const by = await linesOf(r.entryId!);
    // The DISCOUNTED figure is what goes on the balance sheet (IAS 37.45),
    // not the 10,000.00 that will eventually be paid.
    expect(by["6900"]).toBe(PV_LEGAL);
    expect(by["2150"]).toBe(-PV_LEGAL);
  });

  it("refuses a provision with no amount, because that is a contingent liability", async () => {
    await expect(recordProvision({
      orgId: ORG, entityId: ENT, code: "PR-NIL", name: "Unquantifiable claim",
      recognisedOn: "2026-02-01", estimateMinor: 0,
    })).rejects.toThrow(/IAS 37\.26/);
    expect(await row("PR-NIL")).toBeNull();
  });

  it("refuses a second provision with the same code, and a rate with no date to discount to", async () => {
    await expect(recordProvision({
      orgId: ORG, entityId: ENT, code: "PR-LEGAL", name: "Duplicate",
      recognisedOn: "2026-02-01", estimateMinor: 100,
    })).rejects.toThrow(/already on the register/i);

    await expect(recordProvision({
      orgId: ORG, entityId: ENT, code: "PR-NODATE", name: "Discounted, but to when?",
      recognisedOn: "2026-02-01", estimateMinor: 100_000, discountRateBps: 600,
    })).rejects.toThrow(/needs a date to discount to/i);
  });

  /* ----------------------------------------------------------- contingencies */

  it("records a contingent liability and posts absolutely nothing", async () => {
    const before = await db.journalEntry.count({ where: { orgId: ORG, entityId: ENT } });
    const r = await recordProvision({
      orgId: ORG, entityId: ENT,
      code: "PR-CLAIM", name: "Court claim over the Deira contract", category: "LEGAL",
      kind: "CONTINGENT_LIABILITY",
      recognisedOn: "2026-02-28", estimateMinor: 2_500_000,
      discountRateBps: 1200, expectedOn: "2027-06-30",
    });
    expect(r.recognised).toBe(false);
    expect(r.entryId).toBeNull();
    expect(r.reference).toBeNull();
    expect(r.carryingMinor).toBe("0");
    expect(r.message).toMatch(/disclosed, not recognised.*IAS 37\.27/);
    expect(await db.journalEntry.count({ where: { orgId: ORG, entityId: ENT } })).toBe(before);

    const saved = await row("PR-CLAIM");
    expect(saved?.kind).toBe("CONTINGENT_LIABILITY");
    expect(saved?.carryingMinor).toBe(0n);       // the database refuses anything else
    expect(saved?.estimateMinor).toBe(2_500_000n);
    expect(await movementsOf("PR-CLAIM")).toHaveLength(0);
  });

  it("records a contingent asset without recognising it either", async () => {
    const r = await recordProvision({
      orgId: ORG, entityId: ENT,
      code: "PR-INSURANCE", name: "Insurance recovery on the flooded store",
      kind: "CONTINGENT_ASSET", recognisedOn: "2026-02-28", estimateMinor: 400_000,
    });
    expect(r.entryId).toBeNull();
    expect(r.recognitionTest.basis).toMatch(/IAS 37\.31/);
    expect(r.message).toMatch(/never recognised/);

    // And a second contingent liability that stays one, for the note.
    const t = await recordProvision({
      orgId: ORG, entityId: ENT,
      code: "PR-TAX", name: "Disputed customs assessment",
      kind: "CONTINGENT_LIABILITY", recognisedOn: "2026-03-31", estimateMinor: 750_000,
    });
    expect(t.recognised).toBe(false);
    expect(await db.journalEntry.count({ where: { orgId: ORG, entityId: ENT, source: "provision" } })).toBe(2);
  });

  it("reviews a contingency's estimate without posting anything", async () => {
    const r = await remeasure({ orgId: ORG, entityId: ENT, code: "PR-TAX", on: "2026-05-31", estimateMinor: 900_000 });
    expect(r.entryId).toBeNull();
    expect(r.movedMinor).toBe("0");
    expect(r.message).toMatch(/IAS 37\.30/);
    expect((await row("PR-TAX"))?.estimateMinor).toBe(900_000n);
    expect((await row("PR-TAX"))?.carryingMinor).toBe(0n);
    expect(await movementsOf("PR-TAX")).toHaveLength(0);
  });

  /* -------------------------------------------------------------- unwinding */

  it("unwinds the discount as a finance cost, to a hand-computed figure", async () => {
    const r = await unwindDiscount({ orgId: ORG, entityId: ENT, code: "PR-LEGAL", period: "2026-02" });
    expect(r.unwoundMinor).toBe(UNWIND_FEB.toString());
    expect(r.carryingMinor).toBe((PV_LEGAL + UNWIND_FEB).toString());
    expect(r.reference).toMatch(/^PU-/);

    const by = await linesOf(r.entryId!);
    expect(by["6360"]).toBe(UNWIND_FEB);     // Dr finance cost — not the expense line
    expect(by["2150"]).toBe(-UNWIND_FEB);    // Cr provisions: it unwinds INTO the provision
    expect(by["6900"]).toBeUndefined();
  });

  it("will not unwind the same month twice", async () => {
    const again = await unwindDiscount({ orgId: ORG, entityId: ENT, code: "PR-LEGAL", period: "2026-02" });
    expect(again.alreadyUnwound).toBe(true);
    expect(again.unwoundMinor).toBe("0");
    expect((await row("PR-LEGAL"))?.carryingMinor).toBe(PV_LEGAL + UNWIND_FEB);
    expect(await db.journalEntry.count({ where: { orgId: ORG, entityId: ENT, sourceType: "PROVISION_UNWIND" } })).toBe(1);
  });

  it("refuses to unwind the month of recognition, or a provision that is not discounted", async () => {
    await expect(unwindDiscount({ orgId: ORG, entityId: ENT, code: "PR-LEGAL", period: "2026-01" }))
      .rejects.toThrow(/nothing to unwind in 2026-01/i);
    await expect(unwindDiscount({ orgId: ORG, entityId: ENT, code: "PR-WARRANTY", period: "2026-02" }))
      .rejects.toThrow(/not discounted.*IAS 37\.45/is);
    await expect(unwindDiscount({ orgId: ORG, entityId: ENT, code: "PR-LEGAL", period: "Q1" }))
      .rejects.toThrow(/looks like 2026-03/);
  });

  /* ------------------------------------------------------------ remeasuring */

  it("posts nothing when the unwinding has already carried the provision to its present value", async () => {
    const mar = await unwindDiscount({ orgId: ORG, entityId: ENT, code: "PR-LEGAL", period: "2026-03" });
    expect(mar.unwoundMinor).toBe(UNWIND_MAR.toString());
    expect(mar.carryingMinor).toBe(CARRYING_MAR.toString());

    // (E/gⁿ)·g² is E/gⁿ⁻², so a review that leaves the estimate alone has
    // nothing to post — the time value has already been charged as interest.
    const r = await remeasure({ orgId: ORG, entityId: ENT, code: "PR-LEGAL", on: "2026-03-31", estimateMinor: 1_000_000 });
    expect(r.movedMinor).toBe("0");
    expect(r.entryId).toBeNull();
    expect(r.carryingMinor).toBe(CARRYING_MAR.toString());
    expect(presentValue({ amountMinor: 1_000_000, ratePerPeriodBps: 100, periods: 9 })).toBe(CARRYING_MAR);
  });

  it("posts the difference when the estimate goes up", async () => {
    const r = await remeasure({ orgId: ORG, entityId: ENT, code: "PR-WARRANTY", on: "2026-03-31", estimateMinor: 850_000 });
    expect(r.movedMinor).toBe("250000");
    expect(r.carryingMinor).toBe("850000");
    expect(r.reference).toMatch(/^PM-/);

    const by = await linesOf(r.entryId!);
    expect(by["6900"]).toBe(250_000n);
    expect(by["2150"]).toBe(-250_000n);
  });

  it("posts the difference the other way when the estimate comes down", async () => {
    const r = await remeasure({ orgId: ORG, entityId: ENT, code: "PR-WARRANTY", on: "2026-04-30", estimateMinor: 500_000 });
    expect(r.movedMinor).toBe("-350000");
    expect(r.carryingMinor).toBe("500000");
    expect(r.released).toBe(false);
    expect(r.message).toMatch(/unused amount reversed/i);

    const by = await linesOf(r.entryId!);
    expect(by["2150"]).toBe(350_000n);      // Dr the provision back down
    expect(by["6900"]).toBe(-350_000n);     // Cr the expense it was charged to
  });

  it("refuses a remeasurement dated before the provision existed", async () => {
    await expect(remeasure({ orgId: ORG, entityId: ENT, code: "PR-WARRANTY", on: "2025-12-31", estimateMinor: 1 }))
      .rejects.toThrow(/before PR-WARRANTY was recognised/i);
  });

  /* --------------------------------------------------------------- using it */

  it("refuses to charge more against a provision than it carries", async () => {
    await expect(utilise({
      orgId: ORG, entityId: ENT, code: "PR-WARRANTY", on: "2026-05-15", amountMinor: 600_000,
    })).rejects.toThrow(/IAS 37\.61/);
    await expect(utilise({
      orgId: ORG, entityId: ENT, code: "PR-WARRANTY", on: "2026-05-15", amountMinor: 600_000,
    })).rejects.toThrow(/never provided for/i);
    // And nothing was posted on the strength of an attempt that failed.
    expect((await row("PR-WARRANTY"))?.carryingMinor).toBe(500_000n);
    expect(await db.journalEntry.count({ where: { orgId: ORG, entityId: ENT, sourceType: "PROVISION_UTILISE" } })).toBe(0);
  });

  it("charges the expenditure the provision was made for against it", async () => {
    const r = await utilise({
      orgId: ORG, entityId: ENT, code: "PR-WARRANTY", on: "2026-05-15", amountMinor: 400_000,
    });
    expect(r.carryingMinor).toBe("100000");
    expect(r.status).toBe("open");
    expect(r.reference).toMatch(/^PS-/);

    const by = await linesOf(r.entryId);
    expect(by["2150"]).toBe(400_000n);      // Dr the provision
    expect(by["1010"]).toBe(-400_000n);     // Cr bank
    // The cost was charged when the provision was made; using it is not an
    // expense a second time.
    expect(by["6900"]).toBeUndefined();
  });

  it("refuses to charge against a contingency, which has nothing on the balance sheet", async () => {
    await expect(utilise({
      orgId: ORG, entityId: ENT, code: "PR-INSURANCE", on: "2026-05-15", amountMinor: 100,
    })).rejects.toThrow(/never recognised \(IAS 37\.31\)/);
  });

  /* --------------------------------------------------------------- releasing */

  it("will not release a provision without saying why", async () => {
    await expect(release({ orgId: ORG, entityId: ENT, code: "PR-WARRANTY", on: "2026-06-30", reason: "  " }))
      .rejects.toThrow(/Say why/i);
  });

  it("releases the rest back to the account it was charged to", async () => {
    const r = await release({
      orgId: ORG, entityId: ENT, code: "PR-WARRANTY", on: "2026-06-30",
      reason: "the last claim window closed with nothing outstanding",
    });
    expect(r.releasedMinor).toBe("100000");
    expect(r.status).toBe("released");

    const by = await linesOf(r.entryId);
    expect(by["2150"]).toBe(100_000n);      // Dr the provision
    expect(by["6900"]).toBe(-100_000n);     // Cr the same expense line, in June
    expect(r.message).toMatch(/rather than restating/);

    const saved = await row("PR-WARRANTY");
    expect(saved?.carryingMinor).toBe(0n);
    expect(saved?.status).toBe("released");
    // Released, not deleted: the movements are the disclosure.
    const m = await movementsOf("PR-WARRANTY");
    expect(m.map((x) => x.kind)).toEqual(["RECOGNISE", "REMEASURE", "REMEASURE", "UTILISE", "RELEASE"]);
    expect(m.reduce((a, x) => a + x.amountMinor, 0n)).toBe(0n);
    expect(m[m.length - 1].note).toMatch(/claim window/);
  });

  it("will not touch a released provision again", async () => {
    await expect(remeasure({ orgId: ORG, entityId: ENT, code: "PR-WARRANTY", on: "2026-07-31", estimateMinor: 5 }))
      .rejects.toThrow(/is released/i);
    await expect(release({ orgId: ORG, entityId: ENT, code: "PR-WARRANTY", on: "2026-07-31", reason: "again" }))
      .rejects.toThrow(/is released/i);
  });

  /* -------------------------------------------------------------- promotion */

  it("recognises a contingent liability from the date the outflow became probable", async () => {
    const r = await promote({ orgId: ORG, entityId: ENT, code: "PR-CLAIM", on: "2026-06-30" });
    expect(r.months).toBe(12);
    expect(r.carryingMinor).toBe(PV_CLAIM.toString());
    expect(r.reference).toMatch(/^PV-/);
    expect(r.message).toMatch(/IAS 37\.30/);

    const by = await linesOf(r.entryId);
    expect(by["6900"]).toBe(PV_CLAIM);
    expect(by["2150"]).toBe(-PV_CLAIM);

    const saved = await row("PR-CLAIM");
    expect(saved?.kind).toBe("PROVISION");
    expect(saved?.carryingMinor).toBe(PV_CLAIM);
    expect(saved?.recognisedOn.toISOString().slice(0, 10)).toBe("2026-06-30");
    // The date it was first disclosed is not lost when the date it was
    // recognised replaces it.
    expect(saved?.note).toMatch(/contingent liability from 2026-02-28/);

    const m = await movementsOf("PR-CLAIM");
    expect(m).toHaveLength(1);
    expect(m[0].kind).toBe("RECOGNISE");
    expect(m[0].amountMinor).toBe(PV_CLAIM);
  });

  it("refuses to promote a provision that is already recognised, or a contingent asset ever", async () => {
    await expect(promote({ orgId: ORG, entityId: ENT, code: "PR-CLAIM", on: "2026-07-31" }))
      .rejects.toThrow(/already recognised/i);
    await expect(promote({ orgId: ORG, entityId: ENT, code: "PR-INSURANCE", on: "2026-07-31" }))
      .rejects.toThrow(/never recognised \(IAS 37\.31\)/);
    expect((await row("PR-INSURANCE"))?.kind).toBe("CONTINGENT_ASSET");
  });

  /* --------------------------------------------------------------- the books */

  it("ties the register to account 2150", async () => {
    const reg = await provisionRegister({ orgId: ORG, entityId: ENT });
    expect(reg.ledger.agrees).toBe(true);
    expect(reg.ledger.differenceMinor).toBe("0");
    expect(reg.totals.carryingMinor).toBe((CARRYING_MAR + PV_CLAIM).toString());
    expect(reg.ledger.balanceMinor).toBe(reg.totals.carryingMinor);
    expect(reg.ledger.accounts).toContain("2150");

    // Provisions and contingencies are never one list.
    expect(reg.provisions.map((p) => p.code).sort()).toEqual(["PR-CLAIM", "PR-LEGAL", "PR-WARRANTY"]);
    expect(reg.contingencies.map((p) => p.code).sort()).toEqual(["PR-INSURANCE", "PR-TAX"]);
    expect(reg.contingencies.every((c) => c.carryingMinor === "0" && !c.recognised)).toBe(true);
    expect(reg.totals.contingentLiabilityMinor).toBe("900000");
    expect(reg.totals.contingentAssetMinor).toBe("400000");

    const legal = reg.provisions.find((p) => p.code === "PR-LEGAL")!;
    expect(legal.monthlyRateBps).toBe(100);
    expect(legal.discountMinor).toBe((1_000_000n - CARRYING_MAR).toString());
    expect(legal.movements.map((m) => m.kind)).toEqual(["RECOGNISE", "UNWIND", "UNWIND"]);
  });

  it("leaves the trial balance tied through recognition, unwinding, use and release", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-06" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
    expect(tb.rows.find((x) => x.code === "2150")!.balanceMinor).toBe(-(CARRYING_MAR + PV_CLAIM));
    expect(tb.rows.find((x) => x.code === "6360")!.balanceMinor).toBe(UNWIND_FEB + UNWIND_MAR);
  });

  /* ----------------------------------------------------------------- the note */

  it("discloses the movement in each class, adding to the closing balance", async () => {
    const n = await provisionNote({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
    expect(n.periodLabel).toBe("2026");
    expect(n.from).toBe("2026-01-01");
    expect(n.rows.map((r) => r.category).sort()).toEqual(["LEGAL", "WARRANTY"]);

    const warranty = n.rows.find((r) => r.category === "WARRANTY")!;
    expect(warranty.openingMinor).toBe("0");
    expect(warranty.additionsMinor).toBe("850000");        // 600,000 made + 250,000 increase
    expect(warranty.usedMinor).toBe("-400000");            // IAS 37.84(c)
    expect(warranty.releasedMinor).toBe("-450000");        // 350,000 remeasured down + 100,000 released
    expect(warranty.closingMinor).toBe("0");

    const legal = n.rows.find((r) => r.category === "LEGAL")!;
    expect(legal.additionsMinor).toBe((PV_LEGAL + PV_CLAIM).toString());
    expect(legal.unwoundMinor).toBe((UNWIND_FEB + UNWIND_MAR).toString());   // IAS 37.84(e)
    expect(legal.closingMinor).toBe((CARRYING_MAR + PV_CLAIM).toString());
    // The class adds up to the provisions inside it, at the reporting date.
    expect(legal.provisions.reduce((a, p) => a + BigInt(p.carryingMinor), 0n).toString()).toBe(legal.closingMinor);

    // Every row, and the totals, reconcile the way IAS 37.84 asks.
    for (const r of n.rows) {
      const sum = BigInt(r.openingMinor) + BigInt(r.additionsMinor) + BigInt(r.usedMinor) +
        BigInt(r.releasedMinor) + BigInt(r.unwoundMinor);
      expect(sum.toString()).toBe(r.closingMinor);
    }
    expect(n.totals.closingMinor).toBe((CARRYING_MAR + PV_CLAIM).toString());
    expect(n.carryingPerRegisterMinor).toBe(n.totals.closingMinor);
    expect(n.agreesWithRegister).toBe(true);
    expect(n.movementsAfterAsOf).toBe(0);
  });

  it("discloses the contingencies beside the note, and never inside it", async () => {
    const n = await provisionNote({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
    expect(n.contingentLiabilities.map((c) => c.code)).toEqual(["PR-TAX"]);
    expect(n.contingentLiabilities[0].estimateMinor).toBe("900000");
    expect(n.contingentAssets.map((c) => c.code)).toEqual(["PR-INSURANCE"]);
    // Neither of them reaches the movement table.
    const inRows = n.rows.flatMap((r) => r.provisions.map((p) => p.code));
    expect(inRows).not.toContain("PR-TAX");
    expect(inRows).not.toContain("PR-INSURANCE");
    expect(n.narrative.join(" ")).toMatch(/No contingent asset is recognised \(IAS 37\.31, 37\.34\)/);
    expect(n.narrative.join(" ")).toMatch(/reimbursements \(IAS 37\.53\) are not modelled/);
  });

  it("shows the position at an earlier reporting date, and says why it differs from today", async () => {
    const n = await provisionNote({ orgId: ORG, entityId: ENT, asOf: "2026-04-30" });
    expect(n.rows.find((r) => r.category === "WARRANTY")!.closingMinor).toBe("500000");
    expect(n.rows.find((r) => r.category === "LEGAL")!.closingMinor).toBe(CARRYING_MAR.toString());
    expect(n.totals.closingMinor).toBe((500_000n + CARRYING_MAR).toString());
    // The claim was still a contingency in April; it is not in the movements.
    expect(n.rows.flatMap((r) => r.provisions.map((p) => p.code))).not.toContain("PR-CLAIM");
    expect(n.agreesWithRegister).toBe(false);
    expect(n.movementsAfterAsOf).toBe(3);
  });

  /* ------------------------------------------------------------- the ledger's own rules */

  it("is refused by the ledger when the period is closed, in the ledger's own words", async () => {
    await db.accountingPeriod.updateMany({
      where: { orgId: ORG, entityId: ENT, label: "2026-08" }, data: { status: "hard_closed" },
    });
    await expect(unwindDiscount({ orgId: ORG, entityId: ENT, code: "PR-LEGAL", period: "2026-08" }))
      .rejects.toThrow(/2026-08 is hard closed/i);
    await expect(utilise({ orgId: ORG, entityId: ENT, code: "PR-LEGAL", on: "2026-08-15", amountMinor: 1_000 }))
      .rejects.toThrow(/2026-08 is hard closed/i);
    // The register did not move on the strength of a journal that never posted.
    expect((await row("PR-LEGAL"))?.carryingMinor).toBe(CARRYING_MAR);
    expect(await movementsOf("PR-LEGAL")).toHaveLength(3);
    await db.accountingPeriod.updateMany({
      where: { orgId: ORG, entityId: ENT, label: "2026-08" }, data: { status: "open" },
    });
  });

  /* --------------------------------------------------------------- isolation */

  it("keeps a sister entity in the same org completely separate", async () => {
    const other = await recordProvision({
      orgId: ORG, entityId: ENT2, code: "PR-LEGAL", name: "A different entity's claim",
      category: "LEGAL", recognisedOn: "2026-01-31", estimateMinor: 111_100,
    });
    expect(other.carryingMinor).toBe("111100");

    const mine = await provisionRegister({ orgId: ORG, entityId: ENT });
    expect(mine.totals.carryingMinor).toBe((CARRYING_MAR + PV_CLAIM).toString());
    expect(mine.ledger.agrees).toBe(true);

    const theirs = await provisionRegister({ orgId: ORG, entityId: ENT2 });
    expect(theirs.provisions.map((p) => p.code)).toEqual(["PR-LEGAL"]);
    expect(theirs.totals.carryingMinor).toBe("111100");
    expect(theirs.ledger.agrees).toBe(true);

    // A provision of one entity cannot be reached through another, even with
    // the right org and the right code.
    await expect(remeasure({ orgId: ORG, entityId: ENT2, code: "PR-CLAIM", on: "2026-07-31", estimateMinor: 1 }))
      .rejects.toThrow(/not on the register for this entity/i);
  });

  it("keeps another org out entirely, even with the same entity id", async () => {
    const empty = await provisionRegister({ orgId: ORG2, entityId: ENT });
    expect(empty.provisions).toHaveLength(0);
    expect(empty.contingencies).toHaveLength(0);
    expect(empty.totals.carryingMinor).toBe("0");

    await expect(unwindDiscount({ orgId: ORG2, entityId: ENT, code: "PR-LEGAL", period: "2026-02" }))
      .rejects.toThrow(/not on the register for this entity/i);
    await expect(promote({ orgId: ORG2, entityId: ENT, code: "PR-TAX", on: "2026-07-31" }))
      .rejects.toThrow(/not on the register for this entity/i);

    // The same code lives happily in both, and neither can see the other's.
    const r = await recordProvision({
      orgId: ORG2, entityId: ENT, code: "PR-LEGAL", name: "Another org's claim entirely",
      category: "LEGAL", recognisedOn: "2026-01-31", estimateMinor: 222_200,
    });
    expect(r.carryingMinor).toBe("222200");
    const after = await provisionRegister({ orgId: ORG2, entityId: ENT });
    expect(after.totals.carryingMinor).toBe("222200");
    expect(after.ledger.agrees).toBe(true);
    expect((await provisionRegister({ orgId: ORG, entityId: ENT })).totals.carryingMinor)
      .toBe((CARRYING_MAR + PV_CLAIM).toString());
  });
});
