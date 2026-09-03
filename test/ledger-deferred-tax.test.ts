import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  deferredTaxNote,
  deriveFromAssets,
  position,
  postDeferredTax,
  recordItems,
  reportingDates,
  HEADLINE_RATE_BPS,
} from "@/lib/server/ledger/deferred-tax";
import { addAsset, runDepreciation } from "@/lib/server/ledger/assets";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-dt";
const ENT = "t-ent-dt";
/** A second org, to prove nothing here is readable by org id alone. */
const ORG2 = "t-org-dt-other";
/** A second entity inside the SAME org, which is the harder isolation test. */
const ENT2 = "t-ent-dt-other";

async function wipe() {
  for (const org of [ORG, ORG2]) {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(`DELETE FROM "DeferredTaxItem" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "DeferredTaxPosting" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "FixedAsset" WHERE "orgId" = '${org}'`),
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

const record = (asOf: string, items: Parameters<typeof recordItems>[0]["items"]) =>
  recordItems({ orgId: ORG, entityId: ENT, asOf, items });
const at = (asOf: string) => position({ orgId: ORG, entityId: ENT, asOf });
const item = (p: Awaited<ReturnType<typeof at>>, code: string) => p.items.find((i) => i.code === code)!;

/** Every journal line the entity has, so an entry can be checked as posted. */
const linesOf = (entryId: string) =>
  db.journalLine.findMany({
    where: { orgId: ORG, entryId },
    include: { account: { select: { code: true } } },
    orderBy: { lineNo: "asc" },
  });

d("measuring temporary differences", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // An earlier reporting date, so the June position has something to move from.
    await record("2026-03-31", [
      { code: "PPE", description: "Plant and equipment", category: "FIXED_ASSET", carryingMinor: 10_000_000, taxBaseMinor: 9_000_000 },
    ]);

    await record("2026-06-30", [
      // An ASSET carried above its tax base: taxable, a liability.
      { code: "PPE", description: "Plant and equipment", category: "FIXED_ASSET", carryingMinor: 10_000_000, taxBaseMinor: 6_000_000 },
      // A LIABILITY carried above its tax base: deductible, an asset. Same
      // magnitudes as MIRROR below, opposite side, opposite answer.
      { code: "WARRANTY", description: "Warranty provision", category: "PROVISION", carryingMinor: -2_000_000, taxBaseMinor: 0 },
      // The mirror of WARRANTY as an ASSET, which must come out the other way.
      { code: "MIRROR", description: "Asset with the same figures as WARRANTY", category: "OTHER", carryingMinor: 2_000_000, taxBaseMinor: 0 },
      // A tax loss: nothing carried, a tax base of what is still available.
      { code: "LOSS", description: "Tax losses carried forward", category: "LOSS", carryingMinor: 0, taxBaseMinor: 5_000_000, unrecognisedMinor: 3_000_000 },
      // Half a fil, to pin the rounding.
      { code: "ROUND", description: "Rounding probe", category: "OTHER", carryingMinor: 50, taxBaseMinor: 0 },
    ]);
  });
  afterAll(async () => { await wipe(); });

  it("takes a taxable difference on an asset to a deferred tax liability, at 9%", async () => {
    const p = await at("2026-06-30");
    const ppe = item(p, "PPE");
    // IAS 12.5: carrying 100,000 less a tax base of 60,000.
    expect(ppe.differenceMinor).toBe("4000000");
    expect(ppe.kind).toBe("taxable");
    expect(ppe.side).toBe("asset");
    expect(ppe.rateBps).toBe(HEADLINE_RATE_BPS);
    // 9% of AED 40,000 = AED 3,600.00. Positive is a liability.
    expect(ppe.taxMinor).toBe("360000");
  });

  it("takes a deductible difference on a liability to a deferred tax asset", async () => {
    const p = await at("2026-06-30");
    const w = item(p, "WARRANTY");
    expect(w.side).toBe("liability");
    expect(w.differenceMinor).toBe("-2000000");
    expect(w.kind).toBe("deductible");
    // 9% of AED 20,000 = AED 1,800.00. Negative is an asset.
    expect(w.taxMinor).toBe("-180000");
  });

  it("reverses the sign for a liability: the same figures on the other side give the opposite answer", async () => {
    const p = await at("2026-06-30");
    const liability = item(p, "WARRANTY");
    const asset = item(p, "MIRROR");
    // Identical magnitudes, opposite balance sheet sides.
    expect(asset.carryingMinor).toBe((-BigInt(liability.carryingMinor)).toString());
    expect(asset.taxBaseMinor).toBe(liability.taxBaseMinor);
    // IAS 12.15 against IAS 12.24: one is a liability, the other an asset, and
    // the only thing that decided it was which side of the balance sheet the
    // carrying amount sits on.
    expect(asset.kind).toBe("taxable");
    expect(liability.kind).toBe("deductible");
    expect(asset.taxMinor).toBe("180000");
    expect(liability.taxMinor).toBe("-180000");
    expect(BigInt(asset.taxMinor) + BigInt(liability.taxMinor)).toBe(0n);
  });

  it("caps the asset at what is recognised, and keeps the rest as unrecognised (IAS 12.24)", async () => {
    const p = await at("2026-06-30");
    const l = item(p, "LOSS");
    expect(l.differenceMinor).toBe("-5000000");
    expect(l.unrecognisedMinor).toBe("3000000");
    expect(l.recognisedDifferenceMinor).toBe("-2000000");
    // 9% of the whole 50,000 would be 4,500; only the recognised 20,000 counts.
    expect(l.grossTaxMinor).toBe("-450000");
    expect(l.taxMinor).toBe("-180000");
    expect(l.unrecognisedTaxMinor).toBe("270000");
    expect(p.unrecognised.differenceMinor).toBe("3000000");
    expect(p.unrecognised.taxMinor).toBe("270000");
  });

  it("rounds the tax half-up on the fil, in integers", async () => {
    const p = await at("2026-06-30");
    // 9% of 50 fils is 4.5 fils, which rounds to 5, not to 4.
    expect(item(p, "ROUND").taxMinor).toBe("5");
  });

  it("presents both gross halves and the net, and cites the offset it applied", async () => {
    const p = await at("2026-06-30");
    // Liabilities: PPE 3,600 + MIRROR 1,800 + ROUND 0.05.
    expect(p.liabilityMinor).toBe("540005");
    // Assets: WARRANTY 1,800 + LOSS 1,800.
    expect(p.assetMinor).toBe("360000");
    expect(p.netMinor).toBe("180005");
    expect(BigInt(p.netMinor)).toBe(BigInt(p.liabilityMinor) - BigInt(p.assetMinor));
    expect(p.offsetBasis).toMatch(/IAS 12\.74/);
    expect(p.offsetBasis).toMatch(/same taxation authority/i);
  });

  it("measures the movement against the previous dated position, not against nothing", async () => {
    const march = await at("2026-03-31");
    expect(march.netMinor).toBe("90000");
    expect(march.previous).toBeNull();

    const june = await at("2026-06-30");
    expect(june.previous?.asOf).toBe("2026-03-31");
    expect(june.previous?.netMinor).toBe("90000");
    expect(june.movement.fromAsOf).toBe("2026-03-31");
    // Nothing has been posted, so the base is the register's own previous date
    // and the page is told as much rather than being left to assume.
    expect(june.movement.basis).toBe("register");
    // 180,005 less 90,000.
    expect(june.movement.chargeMinor).toBe("90005");
    expect(june.movement.netMinor).toBe("90005");
  });

  it("refuses two items with the same code at one reporting date, in a sentence", async () => {
    await expect(
      record("2026-12-31", [
        { code: "PPE", description: "One", carryingMinor: 1, taxBaseMinor: 0 },
        { code: "PPE", description: "Two", carryingMinor: 2, taxBaseMinor: 0 },
      ]),
    ).rejects.toThrow(/appears twice at 2026-12-31/i);
  });

  it("refuses to write off more than the difference, or to write anything off a liability", async () => {
    await expect(
      record("2026-12-31", [{ code: "X", description: "Too much", carryingMinor: 0, taxBaseMinor: 1_000, unrecognisedMinor: 1_001 }]),
    ).rejects.toThrow(/Nothing can be written off that is not there/i);
    await expect(
      record("2026-12-31", [{ code: "X", description: "Wrong side", carryingMinor: 1_000, taxBaseMinor: 0, unrecognisedMinor: 100 }]),
    ).rejects.toThrow(/IAS 12\.15 recognises that in full/i);
  });

  it("refuses a rate that is not a rate, and a reporting date that is not a date", async () => {
    await expect(
      record("2026-12-31", [{ code: "X", description: "Silly rate", carryingMinor: 1, taxBaseMinor: 0, rateBps: 90_000 }]),
    ).rejects.toThrow(/basis points/i);
    await expect(record("31-12-2026", [])).rejects.toThrow(/looks like 2026-12-31/i);
  });

  it("says so when a provision has been entered on the wrong side", async () => {
    const r = await record("2026-11-30", [
      { code: "P", description: "Provision entered positive", category: "PROVISION", carryingMinor: 1_000, taxBaseMinor: 0 },
    ]);
    expect(r.warnings.some((w) => /A provision is a liability/.test(w))).toBe(true);
    await db.deferredTaxItem.deleteMany({ where: { orgId: ORG, entityId: ENT, asOf: new Date("2026-11-30T00:00:00.000Z") } });
  });

  it("replaces a reporting date wholesale rather than merging into it", async () => {
    await record("2026-10-31", [
      { code: "A", description: "First", carryingMinor: 1_000_000, taxBaseMinor: 0 },
      { code: "B", description: "Second", carryingMinor: 1_000_000, taxBaseMinor: 0 },
    ]);
    const again = await record("2026-10-31", [{ code: "A", description: "First, revised", carryingMinor: 2_000_000, taxBaseMinor: 0 }]);
    expect(again.replaced).toBe(2);
    expect(again.recorded).toBe(1);
    const p = await at("2026-10-31");
    expect(p.items.map((i) => i.code)).toEqual(["A"]);
    expect(p.liabilityMinor).toBe("180000");
    await db.deferredTaxItem.deleteMany({ where: { orgId: ORG, entityId: ENT, asOf: new Date("2026-10-31T00:00:00.000Z") } });
  });

  it("warns that a flat rate is an upper bound while the AED 375,000 band exists", async () => {
    const p = await at("2026-06-30");
    expect(p.warnings.some((w) => /375,000/.test(w) && /upper\s+bound/.test(w))).toBe(true);
    expect(p.warnings.some((w) => /IAS 12\.24/.test(w) && /reassessed/.test(w))).toBe(true);
  });

  it("refuses to post a movement whose previous position never reached the ledger", async () => {
    await expect(postDeferredTax({ orgId: ORG, entityId: ENT, asOf: "2026-06-30" }))
      .rejects.toThrow(/2026-03-31 has not been posted/i);
    // And nothing was recorded as posted by the attempt.
    expect(await db.deferredTaxPosting.count({ where: { orgId: ORG, entityId: ENT } })).toBe(0);
  });

  it("gives the note the standard asks for, and it agrees with the position", async () => {
    const p = await at("2026-06-30");
    const n = await deferredTaxNote({ orgId: ORG, entityId: ENT, asOf: "2026-06-30" });

    expect(n.previousAsOf).toBe("2026-03-31");
    // IAS 12.81(g) wants it by TYPE of difference, not by item.
    const byCategory = new Map(n.rows.map((r) => [r.category, r]));
    expect(byCategory.get("FIXED_ASSET")!.closingNetMinor).toBe("360000");
    expect(byCategory.get("PROVISION")!.closingNetMinor).toBe("-180000");
    expect(byCategory.get("LOSS")!.closingNetMinor).toBe("-180000");
    expect(byCategory.get("LOSS")!.unrecognisedTaxMinor).toBe("270000");
    // The fixed asset difference was there at the previous date too, so the
    // note shows the movement in it rather than only where it ended.
    expect(byCategory.get("FIXED_ASSET")!.openingNetMinor).toBe("90000");
    expect(byCategory.get("FIXED_ASSET")!.movementMinor).toBe("270000");

    // The disclosure and the balance sheet are the same figures.
    expect(n.totals.closingAssetMinor).toBe(p.assetMinor);
    expect(n.totals.closingLiabilityMinor).toBe(p.liabilityMinor);
    expect(n.totals.closingNetMinor).toBe(p.netMinor);
    expect(n.totals.movementMinor).toBe(p.movement.chargeMinor);
    // Every category's net has to add back up to the position.
    const summed = n.rows.reduce((a, r) => a + BigInt(r.closingNetMinor), 0n);
    expect(summed.toString()).toBe(p.netMinor);
    expect(n.narrative.some((s) => /not discounted \(IAS 12\.53\)/.test(s))).toBe(true);
    expect(n.narrative.some((s) => /12\.81\(e\)/.test(s))).toBe(true);
  });

  it("derives the fixed asset difference from the register instead of asking for it again", async () => {
    await addAsset({
      orgId: ORG, entityId: ENT,
      asset: { code: "FA-1", name: "Racking", acquiredOn: "2026-01-15", costMinor: 12_000_000, usefulLifeMonths: 60 },
    });
    for (const m of ["2026-01", "2026-02", "2026-03"]) {
      await runDepreciation({ orgId: ORG, entityId: ENT, period: m });
    }

    const derived = await deriveFromAssets({
      orgId: ORG, entityId: ENT, asOf: "2026-03-31", taxDepreciationRateBps: 4_000,
    });
    // Accounting: 12,000,000 over 60 months is 200,000 a month, three charged.
    expect(derived.totals.carryingMinor).toBe("11400000");
    // Tax: 40% a year on cost for three months is 1,200,000.
    expect(derived.assets[0].taxDepreciationMinor).toBe("1200000");
    expect(derived.totals.taxBaseMinor).toBe("10800000");
    expect(derived.totals.differenceMinor).toBe("600000");
    // 9% of AED 6,000.
    expect(derived.totals.taxMinor).toBe("54000");
    expect(derived.item.category).toBe("FIXED_ASSET");
    // The software says plainly that the rate is an assumption, not knowledge.
    expect(derived.warnings.some((w) => /your assumption, not a fact/i.test(w))).toBe(true);
    expect(derived.item.note).toMatch(/UAE tax depreciation rules are not implemented/);
    // Deriving writes nothing — the register is replaced wholesale, so it would
    // drop everything else measured at that date.
    const stillThere = await at("2026-03-31");
    expect(stillThere.items.map((i) => i.code)).toEqual(["PPE"]);
  });

  it("says when the asset register has been depreciated past the date being measured", async () => {
    const derived = await deriveFromAssets({
      orgId: ORG, entityId: ENT, asOf: "2026-02-28", taxDepreciationRateBps: 4_000,
    });
    expect(derived.warnings.some((w) => /depreciated to 2026-03, past this reporting date/.test(w))).toBe(true);
  });

  it("lists the reporting dates the register holds, newest first", async () => {
    const dates = await reportingDates({ orgId: ORG, entityId: ENT });
    expect(dates.map((x) => x.asOf)).toEqual(["2026-06-30", "2026-03-31"]);
    expect(dates[0].items).toBe(5);
    expect(dates[0].posted).toBe(false);
  });

  it("is scoped to the org AND the entity, never to an id on its own", async () => {
    // The same entity id, under a different org.
    const otherOrg = await position({ orgId: ORG2, entityId: ENT, asOf: "2026-06-30" });
    expect(otherOrg.items).toEqual([]);
    expect(otherOrg.netMinor).toBe("0");

    // A different entity, inside the SAME org — the harder half of the test.
    await recordItems({
      orgId: ORG, entityId: ENT2, asOf: "2026-06-30",
      items: [{ code: "PPE", description: "Someone else's plant", carryingMinor: 99_000_000, taxBaseMinor: 0 }],
    });
    const sibling = await position({ orgId: ORG, entityId: ENT2, asOf: "2026-06-30" });
    expect(sibling.liabilityMinor).toBe("8910000");
    // The original entity is untouched by its neighbour.
    const mine = await at("2026-06-30");
    expect(mine.liabilityMinor).toBe("540005");
    expect(mine.items).toHaveLength(5);
    await db.deferredTaxItem.deleteMany({ where: { orgId: ORG, entityId: ENT2 } });
  });
});

d("posting the deferred tax movement", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // March: a net liability of 1,800.
    await record("2026-03-31", [
      { code: "PPE", description: "Plant and equipment", category: "FIXED_ASSET", carryingMinor: 10_000_000, taxBaseMinor: 8_000_000 },
    ]);
    // June: the liability grows and a provision appears — net 2,700.
    await record("2026-06-30", [
      { code: "PPE", description: "Plant and equipment", category: "FIXED_ASSET", carryingMinor: 9_000_000, taxBaseMinor: 5_000_000 },
      { code: "WARRANTY", description: "Warranty provision", category: "PROVISION", carryingMinor: -1_000_000, taxBaseMinor: 0 },
    ]);
    // September: the difference reverses and the position crosses to a net asset.
    await record("2026-09-30", [
      { code: "PPE", description: "Plant and equipment", category: "FIXED_ASSET", carryingMinor: 4_000_000, taxBaseMinor: 4_000_000 },
      { code: "WARRANTY", description: "Warranty provision", category: "PROVISION", carryingMinor: -5_000_000, taxBaseMinor: 0 },
    ]);
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("puts the first position on the ledger as a charge against 2320", async () => {
    const r = await postDeferredTax({ orgId: ORG, entityId: ENT, asOf: "2026-03-31" });
    expect(r.alreadyPosted).toBe(false);
    expect(r.reference).toMatch(/^DT-/);
    expect(r.periodLabel).toBe("2026-03");
    expect(r.netMinor).toBe("180000");
    expect(r.basisNetMinor).toBe("0");
    expect(r.chargeMinor).toBe("180000");

    const lines = await linesOf(r.entryId!);
    expect(lines).toHaveLength(2);
    const byCode = new Map(lines.map((l) => [l.account.code, l.functionalAmountMinor]));
    expect(byCode.get("7010")).toBe(180_000n);
    expect(byCode.get("2320")).toBe(-180_000n);
    expect(lines.reduce((a, l) => a + l.functionalAmountMinor, 0n)).toBe(0n);
  });

  it("posts only the movement to the next reporting date, not the position again", async () => {
    const r = await postDeferredTax({ orgId: ORG, entityId: ENT, asOf: "2026-06-30" });
    // Gross: a liability of 3,600 and an asset of 900. Net 2,700, from 1,800.
    expect(r.liabilityMinor).toBe("360000");
    expect(r.assetMinor).toBe("90000");
    expect(r.netMinor).toBe("270000");
    expect(r.basisAsOf).toBe("2026-03-31");
    expect(r.chargeMinor).toBe("90000");
    // What the screen offered to post is what was posted: the position reads
    // its base from the ledger, exactly as the posting does.
    const shown = await at("2026-09-30");
    expect(shown.movement.basis).toBe("posted");
    expect(shown.movement.fromAsOf).toBe("2026-06-30");
    expect(shown.movement.fromNetMinor).toBe("270000");

    const lines = await linesOf(r.entryId!);
    expect(lines).toHaveLength(2);
    const byCode = new Map(lines.map((l) => [l.account.code, l.functionalAmountMinor]));
    // Exactly the difference — 900 — and nothing else.
    expect(byCode.get("7010")).toBe(90_000n);
    expect(byCode.get("2320")).toBe(-90_000n);
    // The gross asset stayed off the ledger: IAS 12.74 puts one net figure on
    // the balance sheet, and the halves are a disclosure.
    expect(byCode.has("1320")).toBe(false);
  });

  it("does nothing at all when it is run again over the same position", async () => {
    const before = await db.journalEntry.count({ where: { orgId: ORG, entityId: ENT, series: "DT" } });
    const again = await postDeferredTax({ orgId: ORG, entityId: ENT, asOf: "2026-06-30" });
    expect(again.alreadyPosted).toBe(true);
    expect(again.netMinor).toBe("270000");
    expect(again.lines).toEqual([]);
    expect(await db.journalEntry.count({ where: { orgId: ORG, entityId: ENT, series: "DT" } })).toBe(before);
    expect(await db.deferredTaxPosting.count({ where: { orgId: ORG, entityId: ENT } })).toBe(2);
  });

  it("is refused by the ledger when the period is hard closed, in the ledger's own words", async () => {
    await db.accountingPeriod.updateMany({
      where: { orgId: ORG, entityId: ENT, label: "2026-09" }, data: { status: "hard_closed" },
    });
    await expect(postDeferredTax({ orgId: ORG, entityId: ENT, asOf: "2026-09-30" }))
      .rejects.toThrow(/2026-09 is hard closed/i);
    // Nothing was recorded as posted on the strength of an attempt that failed.
    expect(await db.deferredTaxPosting.count({ where: { orgId: ORG, entityId: ENT, asOf: new Date("2026-09-30T00:00:00.000Z") } })).toBe(0);
    await db.accountingPeriod.updateMany({
      where: { orgId: ORG, entityId: ENT, label: "2026-09" }, data: { status: "open" },
    });
  });

  it("moves both balance sheet accounts when the position crosses from a liability to an asset", async () => {
    const p = await at("2026-09-30");
    expect(p.netMinor).toBe("-450000");
    // The proposed lines are shown before anything is asked to post them.
    expect(p.movement.lines).toHaveLength(3);

    const r = await postDeferredTax({ orgId: ORG, entityId: ENT, asOf: "2026-09-30" });
    expect(r.chargeMinor).toBe("-720000");

    const lines = await linesOf(r.entryId!);
    expect(lines).toHaveLength(3);
    const byCode = new Map(lines.map((l) => [l.account.code, l.functionalAmountMinor]));
    // The old liability comes off, the new asset goes on, and the difference is
    // a credit to profit or loss (IAS 12.58).
    expect(byCode.get("1320")).toBe(450_000n);
    expect(byCode.get("2320")).toBe(270_000n);
    expect(byCode.get("7010")).toBe(-720_000n);
    expect(lines.reduce((a, l) => a + l.functionalAmountMinor, 0n)).toBe(0n);
  });

  it("leaves the ledger holding exactly the position the register measures", async () => {
    const all = await db.journalLine.findMany({
      where: { orgId: ORG, entry: { entityId: ENT, series: "DT", status: { in: ["posted", "reversed"] } } },
      include: { account: { select: { code: true } } },
    });
    const balance = (code: string) =>
      all.filter((l) => l.account.code === code).reduce((a, l) => a + l.functionalAmountMinor, 0n);

    // 1320 carries the net asset as a debit; 2320 has been emptied.
    expect(balance("1320")).toBe(450_000n);
    expect(balance("2320")).toBe(0n);
    // The charge for the year to date: 1,800 + 900 − 7,200.
    expect(balance("7010")).toBe(-450_000n);
    // Everything the module posted still balances.
    expect(all.reduce((a, l) => a + l.functionalAmountMinor, 0n)).toBe(0n);

    const p = await at("2026-09-30");
    expect((-BigInt(p.netMinor)).toString()).toBe(balance("1320").toString());
    expect(p.posted?.stale).toBe(false);
  });

  it("refuses to post a date behind one already posted, because the movements are a chain", async () => {
    await record("2026-07-31", [
      { code: "PPE", description: "Plant and equipment", category: "FIXED_ASSET", carryingMinor: 8_000_000, taxBaseMinor: 5_000_000 },
    ]);
    await expect(postDeferredTax({ orgId: ORG, entityId: ENT, asOf: "2026-07-31" }))
      .rejects.toThrow(/2026-09-30 has already been posted/i);
  });

  it("says the posted entry has gone stale when the register is measured again over it", async () => {
    const changed = await record("2026-09-30", [
      { code: "PPE", description: "Plant and equipment", category: "FIXED_ASSET", carryingMinor: 4_000_000, taxBaseMinor: 3_000_000 },
      { code: "WARRANTY", description: "Warranty provision", category: "PROVISION", carryingMinor: -5_000_000, taxBaseMinor: 0 },
    ]);
    expect(changed.warnings.some((w) => /already been posted/i.test(w) && /reverse that entry/i.test(w))).toBe(true);

    const p = await at("2026-09-30");
    expect(p.posted?.stale).toBe(true);

    // And it will not quietly post the difference over the top of itself.
    const again = await postDeferredTax({ orgId: ORG, entityId: ENT, asOf: "2026-09-30" });
    expect(again.alreadyPosted).toBe(true);
    expect(again.warnings.some((w) => /a posted entry is never edited/i.test(w))).toBe(true);
    expect(await db.journalEntry.count({ where: { orgId: ORG, entityId: ENT, series: "DT" } })).toBe(3);
  });
});
