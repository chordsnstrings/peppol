import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { marginSchemeLineTax } from "@/lib/domain/tax";
import { vatReturn } from "@/lib/server/ledger/vat";
import {
  BUILDING_INTERVALS,
  CAPITAL_ASSET_THRESHOLD_MINOR,
  OTHER_INTERVALS,
  adjustmentDue,
  assessInterval,
  capitalAssetRegister,
  designatedZoneTreatment,
  disposeCapitalAsset,
  marginSchemeSupply,
  registerCapitalAsset,
} from "@/lib/server/ledger/vat-schemes";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-vats";
const ENT = "t-ent-vats";
/** A second tenant, to prove nothing here reads across the org boundary. */
const ORG2 = "t-org-vats-other";
const ENT2 = "t-ent-vats-other";

const ORGS = `'${ORG}','${ORG2}'`;

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    // The adjustments go first: with replication_role set to replica the
    // foreign key's cascade does not fire, so the children have to be named.
    db.$executeRawUnsafe(`DELETE FROM "CapitalAssetAdjustment" WHERE "orgId" IN (${ORGS})`),
    db.$executeRawUnsafe(`DELETE FROM "CapitalAssetItem" WHERE "orgId" IN (${ORGS})`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" IN (${ORGS}))`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" IN (${ORGS})`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" IN (${ORGS})`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" IN (${ORGS})`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" IN (${ORGS})`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" IN (${ORGS})`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" IN (${ORGS})`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" IN (${ORGS})`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" IN (${ORGS})`),
  ]);
}

/**
 * The two assets every test below works from.
 *
 * A warehouse: AED 6,000,000 excluding tax, AED 300,000 of input tax, claimed
 * wholly for taxable use, first used 1 February 2021. Ten intervals, so one
 * interval is worth AED 30,000.
 *
 * A production line: AED 5,000,000 exactly — the threshold is "or more", so it
 * is in — AED 250,000 of input tax, claimed at 60% taxable use, first used
 * 1 March 2022. Five intervals, so one interval is worth AED 50,000.
 */
const BUILDING = {
  code: "CA-B1",
  description: "Warehouse, Jebel Ali",
  category: "BUILDING" as const,
  acquiredOn: "2021-01-15",
  firstUsedOn: "2021-02-01",
  costMinor: "600000000",
  inputTaxMinor: "30000000",
  originalUseBps: 10_000,
};
const PLANT = {
  code: "CA-P1",
  description: "Bottling line",
  category: "OTHER" as const,
  acquiredOn: "2022-02-10",
  firstUsedOn: "2022-03-01",
  costMinor: "500000000",
  inputTaxMinor: "25000000",
  originalUseBps: 6_000,
};

const AED = 100n;

d("VAT schemes — capital assets, profit margin, designated zones", () => {
  let building: Awaited<ReturnType<typeof registerCapitalAsset>>;
  let plant: Awaited<ReturnType<typeof registerCapitalAsset>>;

  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2024", startsOn: "2024-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
    building = await registerCapitalAsset({ orgId: ORG, entityId: ENT, asset: BUILDING });
    plant = await registerCapitalAsset({ orgId: ORG, entityId: ENT, asset: PLANT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("gives a building ten intervals and anything else five", () => {
    expect(BUILDING_INTERVALS).toBe(10);
    expect(OTHER_INTERVALS).toBe(5);
    expect(building.intervals).toBe(10);
    expect(plant.intervals).toBe(5);
    // A tenth and a fifth of the input tax: AED 30,000 and AED 50,000.
    expect(building.perIntervalMinor).toBe("3000000");
    expect(plant.perIntervalMinor).toBe("5000000");
    // Ten years from FIRST USE, not from the purchase.
    expect(building.adjustmentPeriodEndsOn).toBe("2031-01-31");
    expect(plant.adjustmentPeriodEndsOn).toBe("2027-02-28");
    // The judgement the software cannot make is stated rather than implied.
    expect(building.notes.join(" ")).toMatch(/judgements taken from you/i);
  });

  it("refuses a cost below the threshold, naming the figure", async () => {
    expect(CAPITAL_ASSET_THRESHOLD_MINOR).toBe(500_000_000n);
    await expect(
      registerCapitalAsset({
        orgId: ORG,
        entityId: ENT,
        asset: { ...PLANT, code: "CA-SMALL", costMinor: "499999999", inputTaxMinor: "24999999" },
      }),
    ).rejects.toThrow(/5,000,000\.00/);
    await expect(
      registerCapitalAsset({
        orgId: ORG,
        entityId: ENT,
        asset: { ...PLANT, code: "CA-SMALL", costMinor: "499999999", inputTaxMinor: "24999999" },
      }),
    ).rejects.toThrow(/Article 57\(1\)/);
    // And it really is not on the register.
    const reg = await capitalAssetRegister({ orgId: ORG, entityId: ENT });
    expect(reg.assets.map((a) => a.code)).toEqual(["CA-B1", "CA-P1"]);
  });

  it("refuses a duplicate code and a nonsensical proportion", async () => {
    await expect(registerCapitalAsset({ orgId: ORG, entityId: ENT, asset: BUILDING }))
      .rejects.toThrow(/already on the register/i);
    await expect(
      registerCapitalAsset({ orgId: ORG, entityId: ENT, asset: { ...PLANT, code: "CA-X", originalUseBps: 12_000 } }),
    ).rejects.toThrow(/basis points/i);
  });

  it("refuses an interval that does not exist, is the first year, or has not closed", async () => {
    await expect(assessInterval({ orgId: ORG, entityId: ENT, code: "CA-B1", interval: 1, useBps: 8_000, on: "2024-06-30" }))
      .rejects.toThrow(/year of first use/i);
    await expect(assessInterval({ orgId: ORG, entityId: ENT, code: "CA-P1", interval: 6, useBps: 8_000, on: "2024-06-30" }))
      .rejects.toThrow(/5 intervals/);
    // Interval 4 of the warehouse runs to 31 January 2025.
    await expect(assessInterval({ orgId: ORG, entityId: ENT, code: "CA-B1", interval: 4, useBps: 8_000, on: "2024-06-30" }))
      .rejects.toThrow(/nothing to assess until the year is over/i);
    await expect(assessInterval({ orgId: ORG, entityId: ENT, code: "NOPE", interval: 2, useBps: 8_000, on: "2024-06-30" }))
      .rejects.toThrow(/not on the register/i);
  });

  it("adjusts down when taxable use falls, and posts it to 1350 and the expense", async () => {
    // Hand-worked: a tenth of AED 300,000 is AED 30,000; taxable use fell from
    // 100% to 70%, a change of −30%; AED 30,000 × −30% = −AED 9,000.
    const r = await assessInterval({
      orgId: ORG, entityId: ENT, code: "CA-B1", interval: 3, useBps: 7_000, on: "2024-02-15",
    });
    expect(r.from).toBe("2023-02-01");
    expect(r.to).toBe("2024-01-31");
    expect(r.changeBps).toBe(-3_000);
    expect(r.adjustmentMinor).toBe("-900000");
    expect(BigInt(r.adjustmentMinor)).toBe(-9_000n * AED);
    expect(r.alreadyAssessed).toBe(false);
    expect(r.entryId).not.toBeNull();

    const lines = await db.journalLine.findMany({
      where: { entryId: r.entryId! },
      include: { account: { select: { code: true } } },
      orderBy: { lineNo: "asc" },
    });
    expect(lines).toHaveLength(2);
    // Tax to repay: it leaves the recoverable-input control account and becomes
    // a cost.
    const vat = lines.find((l) => l.account.code === "1350")!;
    const expense = lines.find((l) => l.account.code === "6900")!;
    expect(vat.functionalAmountMinor).toBe(-900_000n);
    expect(expense.functionalAmountMinor).toBe(900_000n);
    // The tax line carries the treatment; the expense line does not, or the
    // value of the supply would be reported to the FTA a second time.
    expect(vat.taxCode).toBe("INPUT_VAT");
    expect(expense.taxCode).toBeNull();

    const entry = await db.journalEntry.findUnique({ where: { id: r.entryId! } });
    expect(entry?.series).toBe("CA");
    expect(entry?.source).toBe("vat");
    expect(entry?.sourceType).toBe("CAPITAL_ASSET_ADJUSTMENT");
  });

  it("adjusts up when taxable use rises", async () => {
    // Hand-worked: a fifth of AED 250,000 is AED 50,000; taxable use rose from
    // 60% to 80%, a change of +20%; AED 50,000 × 20% = +AED 10,000.
    const r = await assessInterval({
      orgId: ORG, entityId: ENT, code: "CA-P1", interval: 2, useBps: 8_000, on: "2024-03-31",
    });
    expect(r.from).toBe("2023-03-01");
    expect(r.to).toBe("2024-02-29");
    expect(r.changeBps).toBe(2_000);
    expect(r.adjustmentMinor).toBe("1000000");
    expect(BigInt(r.adjustmentMinor)).toBe(10_000n * AED);

    const lines = await db.journalLine.findMany({
      where: { entryId: r.entryId! },
      include: { account: { select: { code: true } } },
    });
    const vat = lines.find((l) => l.account.code === "1350")!;
    const expense = lines.find((l) => l.account.code === "6900")!;
    expect(vat.functionalAmountMinor).toBe(1_000_000n);
    expect(expense.functionalAmountMinor).toBe(-1_000_000n);
    expect(vat.taxCode).toBe("INPUT_VAT");
  });

  it("is idempotent, and refuses to reassess a posted interval at a different proportion", async () => {
    const again = await assessInterval({
      orgId: ORG, entityId: ENT, code: "CA-P1", interval: 2, useBps: 8_000, on: "2024-03-31",
    });
    expect(again.alreadyAssessed).toBe(true);
    expect(again.adjustmentMinor).toBe("1000000");
    expect(again.warnings).toEqual([]);

    const different = await assessInterval({
      orgId: ORG, entityId: ENT, code: "CA-P1", interval: 2, useBps: 9_000, on: "2024-03-31",
    });
    expect(different.alreadyAssessed).toBe(true);
    // The original figure stands: a posted entry is corrected by reversal.
    expect(different.adjustmentMinor).toBe("1000000");
    expect(different.warnings[0]).toMatch(/already assessed at 80%/i);

    const entries = await db.journalEntry.count({
      where: { orgId: ORG, entityId: ENT, sourceType: "CAPITAL_ASSET_ADJUSTMENT" },
    });
    expect(entries).toBe(2);
    const rows = await db.capitalAssetAdjustment.count({ where: { orgId: ORG } });
    expect(rows).toBe(2);
  });

  it("finds an interval that fell due years after the purchase", async () => {
    const due = await adjustmentDue({ orgId: ORG, entityId: ENT, asOf: "2024-06-30" });
    expect(due.intervalCount).toBe(1);
    expect(due.assets).toHaveLength(1);
    expect(due.assets[0].code).toBe("CA-B1");
    expect(due.assets[0].due[0].interval).toBe(2);
    // The year in question ended 31 January 2023 — nearly a year and a half
    // before anybody looked, on an asset bought in 2021.
    expect(due.assets[0].due[0].to).toBe("2023-01-31");
    expect(due.assets[0].due[0].overdueDays).toBeGreaterThan(365);
    // A bound, not an estimate: one interval's share of the input tax.
    expect(due.boundMinor).toBe("3000000");

    expect(due.finding).not.toBeNull();
    expect(due.finding!.key).toBe("capital_asset_adjustments");
    expect(due.finding!.severity).toBe("urgent");
    expect(due.finding!.count).toBe(1);
    expect(due.finding!.href).toBe("/accounting/vat-schemes");
    // It says plainly that the amount is not knowable from the books.
    expect(due.finding!.detail).toMatch(/no accounting record holds that/i);
  });

  it("records a nil adjustment so the interval stops coming back around", async () => {
    const r = await assessInterval({
      orgId: ORG, entityId: ENT, code: "CA-B1", interval: 2, useBps: 10_000, on: "2024-06-30",
    });
    expect(r.adjustmentMinor).toBe("0");
    expect(r.entryId).toBeNull();
    expect(r.lines).toEqual([]);
    expect(r.warnings[0]).toMatch(/no adjustment/i);

    const due = await adjustmentDue({ orgId: ORG, entityId: ENT, asOf: "2024-06-30" });
    expect(due.intervalCount).toBe(0);
    expect(due.finding).toBeNull();
  });

  it("adjusts every remaining interval in one on disposal", async () => {
    // Sold on 10 April 2024, inside interval 3 of five. Intervals 3, 4 and 5
    // are all deemed wholly taxable use (ER 58(12)): a fifth of AED 250,000 is
    // AED 50,000, and 100% against the 60% claimed is +40%, so AED 20,000 an
    // interval and AED 60,000 in all.
    const r = await disposeCapitalAsset({ orgId: ORG, entityId: ENT, code: "CA-P1", on: "2024-04-10" });
    expect(r.remainingIntervals).toEqual([3, 4, 5]);
    expect(r.deemedUseBps).toBe(10_000);
    expect(r.adjustmentMinor).toBe("6000000");
    expect(BigInt(r.adjustmentMinor)).toBe(60_000n * AED);
    expect(r.entryId).not.toBeNull();

    // One entry, whatever the number of intervals it discharges.
    const lines = await db.journalLine.findMany({
      where: { entryId: r.entryId! },
      include: { account: { select: { code: true } } },
    });
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.account.code === "1350")!.functionalAmountMinor).toBe(6_000_000n);
    expect(lines.find((l) => l.account.code === "6900")!.functionalAmountMinor).toBe(-6_000_000n);

    // A row per interval, so none of them is left looking outstanding.
    const rows = await db.capitalAssetAdjustment.findMany({
      where: { orgId: ORG, asset: { code: "CA-P1" } },
      orderBy: { interval: "asc" },
    });
    expect(rows.map((x) => x.interval)).toEqual([2, 3, 4, 5]);
    expect(rows.slice(1).every((x) => x.adjustmentMinor === 2_000_000n)).toBe(true);
    expect(new Set(rows.slice(1).map((x) => x.entryId)).size).toBe(1);

    await expect(disposeCapitalAsset({ orgId: ORG, entityId: ENT, code: "CA-P1", on: "2024-05-01" }))
      .rejects.toThrow(/already been disposed of/i);
    await expect(assessInterval({ orgId: ORG, entityId: ENT, code: "CA-P1", interval: 4, useBps: 5_000, on: "2027-03-01" }))
      .rejects.toThrow(/disposed of/i);
  });

  it("shows every interval's state and reconciles the register to account 1350", async () => {
    const reg = await capitalAssetRegister({ orgId: ORG, entityId: ENT, asOf: "2024-06-30" });
    const b = reg.assets.find((a) => a.code === "CA-B1")!;
    const p = reg.assets.find((a) => a.code === "CA-P1")!;

    expect(b.intervalRows).toHaveLength(10);
    expect(p.intervalRows).toHaveLength(5);
    // Interval 1 is the claim made at the outset; it is not adjusted against
    // itself.
    expect(b.intervalRows[0].state).toBe("original");
    expect(b.intervalRows[0].useBps).toBe(10_000);
    expect(b.intervalRows[1].state).toBe("assessed");
    expect(b.intervalRows[2].state).toBe("assessed");
    expect(b.intervalRows[2].adjustmentMinor).toBe("-900000");
    expect(b.intervalRows[3].state).toBe("not_yet_due");
    expect(b.assessedCount).toBe(2);
    expect(b.outstandingCount).toBe(0);
    expect(b.adjustedMinor).toBe("-900000");
    expect(p.status).toBe("disposed");
    expect(p.adjustedMinor).toBe("7000000");

    // −9,000 + 10,000 + 60,000 = AED 61,000 net recovered.
    expect(reg.totals.adjustedMinor).toBe("6100000");
    expect(reg.totals.recoveredMinor).toBe("7000000");
    expect(reg.totals.repaidMinor).toBe("900000");
    expect(reg.reconciliation.registerMinor).toBe("6100000");
    expect(reg.reconciliation.ledgerMinor).toBe("6100000");
    expect(reg.reconciliation.agrees).toBe(true);
    expect(reg.reconciliation.unpostedCount).toBe(0);
  });

  it("reaches the VAT return through the ledger, and the return still reconciles", async () => {
    // The whole point of posting to 1350 with the INPUT_VAT treatment: the
    // return was not taught about capital assets and picks the adjustments up
    // anyway, on both of the two routes it computes input tax by.
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2024-01-01", to: "2024-12-31" });
    expect(r.totalInputVatMinor).toBe("6100000");
    expect(r.reconciliation.inputVatPerLedgerMinor).toBe("6100000");
    expect(r.reconciliation.inputMatches).toBe(true);
    expect(r.warnings).toEqual([]);
    const box9 = r.expenses.find((b) => b.box === "9")!;
    // No supply is restated: only the tax moved.
    expect(box9.amountMinor).toBe("0");
    // …which is why the whole of it sits in the Adjustment column and none of
    // it in the VAT column. Tax in the VAT column beside a net of nought is a
    // recovery against expenses the business did not incur this period, and
    // the form has a separate column so that it never has to be written that
    // way. The total is the same figure either way.
    expect(box9.vatMinor).toBe("0");
    expect(box9.adjustmentMinor).toBe("6100000");
    expect(BigInt(box9.vatMinor!) + BigInt(box9.adjustmentMinor!)).toBe(6_100_000n);
  });

  it("taxes the margin, not the price, on a second-hand sale", () => {
    // Bought for AED 30,000, sold for AED 35,000. The margin is AED 5,000 and
    // the tax is inside it: 5/105 of 500,000 fils is 23,809.52…, so 23,810.
    const m = marginSchemeSupply({ purchaseMinor: "3000000", saleMinor: "3500000" });
    expect(m.marginMinor).toBe("500000");
    expect(m.taxMinor).toBe("23810");
    expect(m.netMarginMinor).toBe("476190");
    expect(m.ratePercent).toBe(5);
    expect(m.refusal).toBeNull();
    // Not 5% of the margin, which would be 25,000 — a twentieth too much.
    expect(m.taxMinor).not.toBe("25000");
    expect(m.notes.join(" ")).toMatch(/must NOT show a tax amount/);
    expect(m.notes.join(" ")).toMatch(/cannot be recovered/i);
  });

  it("refuses a negative margin rather than turning a loss into a credit", () => {
    const m = marginSchemeSupply({ purchaseMinor: "3500000", saleMinor: "3000000" });
    expect(m.marginMinor).toBe("0");
    expect(m.taxMinor).toBe("0");
    expect(m.refusal).toMatch(/no margin/i);
    expect(m.refusal).toMatch(/not a credit/i);
  });

  it("charges nothing on a sale at cost, without calling it a refusal", () => {
    const m = marginSchemeSupply({ purchaseMinor: "3000000", saleMinor: "3000000" });
    expect(m.marginMinor).toBe("0");
    expect(m.taxMinor).toBe("0");
    expect(m.refusal).toBeNull();
  });

  it("agrees, to the fils, with the margin an invoice line computes", () => {
    // Two modules carry this arithmetic: this one for a supply worked out on
    // its own, and `marginSchemeLineTax` in `src/lib/domain/tax.ts` for a line
    // on a document. The second cannot import the first — that module opens a
    // Prisma client and the invoice editor runs in a browser, and this module
    // already imports the rate table from it, so the import would be a cycle
    // as well. This test is what holds them to the same figures instead.
    const cases: [purchase: number, sale: number][] = [
      [3_000_000, 3_500_000], // AED 30,000 → 35,000: tax 23,810
      [1_000_000, 1_000_210], // a 210-fils margin: tax 10
      [1_000_000, 1_000_001], // a one-fils margin: tax nil
      [3_000_000, 3_000_000], // sold at cost: tax nil
      [3_500_000, 3_000_000], // sold at a loss: tax nil, never a credit
      [0, 7_777_777], // bought for nothing: the whole price is the margin
      [12_345_678, 98_765_432],
    ];
    for (const [purchase, sale] of cases) {
      const scheme = marginSchemeSupply({ purchaseMinor: String(purchase), saleMinor: String(sale) });
      const onALine = marginSchemeLineTax({
        qty: 1,
        unitPriceMinor: sale,
        taxProfileCode: "MARGIN_SCHEME",
        marginPurchaseMinor: purchase,
      });
      expect(String(onALine.taxMinor)).toBe(scheme.taxMinor);
      expect(String(onALine.marginMinor)).toBe(scheme.marginMinor);
    }
  });

  it("treats goods in a designated zone as outside the State, and services as inside it", () => {
    const goods = designatedZoneTreatment({ supply: { kind: "GOODS", movement: "WITHIN_ZONE" } });
    expect(goods.treatment).toBe("OUT_OF_SCOPE");
    expect(goods.taxProfileCode).toBe("DESIGNATED_ZONE");
    expect(goods.citation).toMatch(/Article 51/);
    expect(goods.conditions.join(" ")).toMatch(/consumed within the zone/i);

    const services = designatedZoneTreatment({ supply: { kind: "SERVICES", movement: "WITHIN_ZONE" } });
    expect(services.treatment).toBe("STANDARD_RATED");
    expect(services.taxProfileCode).toBe("STANDARD_5");
    expect(services.citation).toMatch(/Article 51\(7\)/);

    // Mainland into a zone is not an export, which is the trap.
    expect(designatedZoneTreatment({ supply: { kind: "GOODS", movement: "INTO_ZONE" } }).treatment)
      .toBe("STANDARD_RATED");
    expect(designatedZoneTreatment({ supply: { kind: "GOODS", movement: "OUT_OF_ZONE" } }).treatment)
      .toBe("IMPORT");
    expect(designatedZoneTreatment({ supply: { kind: "GOODS", movement: "BETWEEN_ZONES" } }).treatment)
      .toBe("OUT_OF_SCOPE");
  });

  it("keeps one org's register out of another's", async () => {
    // The same code in another tenant is a different asset entirely.
    await registerCapitalAsset({
      orgId: ORG2, entityId: ENT2, asset: { ...BUILDING, description: "Someone else's warehouse" },
    });

    const mine = await capitalAssetRegister({ orgId: ORG, entityId: ENT, asOf: "2024-06-30" });
    expect(mine.assets).toHaveLength(2);
    expect(mine.assets.find((a) => a.code === "CA-B1")!.description).toBe("Warehouse, Jebel Ali");

    const theirs = await capitalAssetRegister({ orgId: ORG2, entityId: ENT2, asOf: "2024-06-30" });
    expect(theirs.assets).toHaveLength(1);
    expect(theirs.assets[0].description).toBe("Someone else's warehouse");
    // Nothing has been posted in that org, so its register has nothing to tie to.
    expect(theirs.reconciliation.ledgerMinor).toBe("0");

    // And an asset cannot be assessed from the wrong side of the boundary.
    await expect(assessInterval({ orgId: ORG2, entityId: ENT2, code: "CA-P1", interval: 3, useBps: 5_000, on: "2024-06-30" }))
      .rejects.toThrow(/not on the register/i);
    const dueTheirs = await adjustmentDue({ orgId: ORG2, entityId: ENT2, asOf: "2024-06-30" });
    expect(dueTheirs.assets.every((a) => a.description === "Someone else's warehouse")).toBe(true);
  });
});
