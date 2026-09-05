import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { profitAndLoss, balanceSheet } from "@/lib/server/ledger/statements";
import { addAsset, runDepreciation } from "@/lib/server/ledger/assets";
import { addLease, activateLease, runLeasePeriod, payLease } from "@/lib/server/ledger/leases";
import { revalueAsset, releaseSurplus } from "@/lib/server/ledger/asset-revaluation";
import { recordProvision } from "@/lib/server/ledger/provisions";
import { recordItems } from "@/lib/server/ledger/deferred-tax";
import { declareRelatedParty, declareCompensation, attest } from "@/lib/server/ledger/related-parties";
import { closeYear } from "@/lib/server/ledger/close";
import {
  changesInEquity,
  notesToTheAccounts,
  equityAndNotes,
  fiscalYearsFor,
  type Note,
  type PolicyNote,
  type PpeNote,
  type IntangiblesNote,
  type LeaseNote,
  type ReceivablesPayablesNote,
  type RevenueNote,
  type RelatedPartyNote,
  type ProvisionsNote,
  type TaxNote,
  type DeferredTaxNote,
  type RequiresInputNote,
} from "@/lib/server/ledger/equity";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-eq";
const ENT = "t-ent-eq";
/** A ledger with nothing in it but capital — where "empty" is the honest answer. */
const BARE = "t-ent-eq-bare";
/** A ledger carrying an equity account this statement has never heard of. */
const ODD = "t-ent-eq-odd";
/** A ledger that has revalued one asset and impaired another. */
const REV = "t-ent-eq-rev";
/** A ledger whose provisions, deferred tax and related parties are all recorded. */
const PACK = "t-ent-eq-pack";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "Lease" WHERE "orgId" = '${ORG}'`),
    // Children before parents: the cascade is a foreign key, and foreign keys
    // are exactly what the replica role has just switched off.
    db.$executeRawUnsafe(`DELETE FROM "AssetRevaluation" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FixedAsset" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ProvisionMovement" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Provision" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DeferredTaxPosting" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DeferredTaxItem" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "RelatedParty" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "KeyManagementComp" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "RelatedPartyAttestation" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Counterparty" WHERE "orgId" = '${ORG}'`),
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

/** Control accounts (AR, AP, VAT) refuse a manual journal, so those postings
 *  come in under the source the subledger would have used. */
const P = (
  entityId: string,
  entryDate: string,
  lines: { account: string; debit?: number; credit?: number; taxCode?: string }[],
  extra: { memo?: string; source?: string; sourceId?: string; settlesId?: string } = {},
) =>
  post({
    orgId: ORG,
    entityId,
    entryDate,
    memo: extra.memo ?? "",
    source: extra.source ?? "manual",
    sourceId: extra.sourceId,
    settlesId: extra.settlesId,
    lines,
  });

const E = (entityId = ENT, fiscalYear = "2026") =>
  changesInEquity({ orgId: ORG, entityId, fiscalYear });
const N = (entityId = ENT, fiscalYear = "2026") =>
  notesToTheAccounts({ orgId: ORG, entityId, fiscalYear });

const noteOf = <T extends Note>(notes: Note[], key: Note["key"]) => notes.find((n) => n.key === key) as T;

/** The initial lease liability, read from the activation rather than assumed. */
let leasePvMinor = "0";

d("statement of changes in equity and the notes", () => {
  beforeAll(async () => {
    await wipe();

    /* ---- the trading entity ------------------------------------------- */

    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // Capital, and money the shareholder put in through the current account.
    await P(ENT, "2026-01-05", [
      { account: "1010", debit: 100_000_000 },
      { account: "3000", credit: 100_000_000 },
    ], { memo: "Share capital issued" });
    await P(ENT, "2026-01-06", [
      { account: "1010", debit: 200_000 },
      { account: "3100", credit: 200_000 },
    ], { memo: "Shareholder funds introduced" });

    // A van bought for cash and depreciated over five years.
    await P(ENT, "2026-01-15", [
      { account: "1500", debit: 12_000_000 },
      { account: "1010", credit: 12_000_000 },
    ], { memo: "Delivery van" });
    await addAsset({
      orgId: ORG, entityId: ENT,
      asset: { code: "FA-001", name: "Delivery van", acquiredOn: "2026-01-15", costMinor: 12_000_000, usefulLifeMonths: 60 },
    });
    // An ERP licence capitalised in the same year. Registered as INTANGIBLE, so
    // it routes to 1560 / 1570 / 6610 rather than joining the van on 1500 and
    // amortising through 6600 "Depreciation" under a heading that says property,
    // plant and equipment.
    await P(ENT, "2026-01-20", [
      { account: "1560", debit: 3_600_000 },
      { account: "1010", credit: 3_600_000 },
    ], { memo: "ERP licence" });
    await addAsset({
      orgId: ORG, entityId: ENT,
      asset: {
        code: "IA-001", name: "ERP licence", category: "INTANGIBLE",
        acquiredOn: "2026-01-20", costMinor: 3_600_000, usefulLifeMonths: 36,
      },
    });

    for (const m of ["01", "02", "03", "04", "05", "06"]) {
      await runDepreciation({ orgId: ORG, entityId: ENT, period: `2026-${m}` });
    }

    // A standard-rated sale on credit, part settled, and a zero-rated export.
    await P(ENT, "2026-02-10", [
      { account: "1100", debit: 42_000_000 },
      { account: "4000", credit: 40_000_000, taxCode: "STANDARD_5" },
      { account: "2100", credit: 2_000_000, taxCode: "OUTPUT_VAT" },
    ], { memo: "INV-1 goods", source: "invoice", sourceId: "INV-1" });
    await P(ENT, "2026-03-10", [
      { account: "1010", debit: 30_000_000 },
      { account: "1100", credit: 30_000_000 },
    ], { memo: "Receipt against INV-1", source: "receipt", settlesId: "INV-1" });
    await P(ENT, "2026-04-15", [
      { account: "1100", debit: 20_000_000 },
      { account: "4200", credit: 20_000_000, taxCode: "ZERO_EXPORT" },
    ], { memo: "INV-2 export", source: "invoice", sourceId: "INV-2" });

    // A bill left unpaid, and cost of sales settled in cash.
    await P(ENT, "2026-05-10", [
      { account: "6100", debit: 3_000_000 },
      { account: "2000", credit: 3_000_000 },
    ], { memo: "BILL-1 office rent", source: "bill", sourceId: "BILL-1" });
    await P(ENT, "2026-06-10", [
      { account: "5000", debit: 4_000_000 },
      { account: "1010", credit: 4_000_000 },
    ], { memo: "Goods sold" });

    // Two leases: one capitalised over two years, one short-term and exempt.
    await addLease({
      orgId: ORG, entityId: ENT,
      lease: { code: "LS-001", name: "Warehouse", lessor: "Al Quoz Properties", startsOn: "2026-07-01", endsOn: "2028-06-30", paymentMinor: 500_000, discountRateBps: 600 },
    });
    await addLease({
      orgId: ORG, entityId: ENT,
      lease: { code: "LS-002", name: "Site office", lessor: "Portakabin", startsOn: "2026-07-01", endsOn: "2027-06-30", paymentMinor: 200_000, discountRateBps: 600 },
    });
    const activation = await activateLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-001" });
    leasePvMinor = activation.initialLiabilityMinor;
    await activateLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-002", exempt: "SHORT_TERM" });
    for (const m of ["07", "08", "09", "10", "11", "12"]) {
      await runLeasePeriod({ orgId: ORG, entityId: ENT, period: `2026-${m}` });
      await payLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-001", period: `2026-${m}` });
    }

    // The movements in equity themselves.
    await P(ENT, "2026-09-30", [
      { account: "3900", debit: 500_000 },
      { account: "2050", credit: 500_000 },
    ], { memo: "Accrual omitted from the prior year" });
    await P(ENT, "2026-10-15", [
      { account: "3100", debit: 80_000 },
      { account: "1010", credit: 80_000 },
    ], { memo: "Shareholder drawings" });
    await P(ENT, "2026-11-30", [
      { account: "3900", debit: 6_000_000 },
      { account: "1010", credit: 6_000_000 },
    ], { memo: "Dividend paid" });
    await P(ENT, "2026-12-31", [
      { account: "3900", debit: 4_000_000 },
      { account: "3200", credit: 4_000_000 },
    ], { memo: "Transfer to the statutory reserve" });

    /* ---- a ledger with nothing in it but capital ----------------------- */

    await openFiscalYear({ orgId: ORG, entityId: BARE, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: BARE });
    await P(BARE, "2026-01-10", [
      { account: "1010", debit: 1_000_000 },
      { account: "3000", credit: 1_000_000 },
    ], { memo: "Share capital issued" });

    /* ---- a ledger with an equity account off the chart ------------------ */

    await openFiscalYear({ orgId: ORG, entityId: ODD, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ODD });
    await db.account.create({
      data: {
        // 3300 is the revaluation surplus and is now in the standard chart,
        // so this needs a code the chart does not have — the point of the
        // fixture is an equity account the statement has no column for.
        orgId: ORG, entityId: ODD, code: "3400", name: "General reserve",
        nameAr: "احتياطي عام", type: "EQUITY", isPostable: true,
      },
    });
    await P(ODD, "2026-02-01", [
      { account: "1010", debit: 1_000_000 },
      { account: "3000", credit: 1_000_000 },
    ], { memo: "Share capital issued" });
    await P(ODD, "2026-03-01", [
      { account: "1500", debit: 500_000 },
      { account: "3400", credit: 500_000 },
    ], { memo: "Revaluation surplus" });

    /* ---- a ledger that has revalued one asset and impaired another ------ */

    /*
     * Both assets are bought on 2026-01-15 for cash and depreciated for six
     * months, then valued on 2026-06-30:
     *
     *   FA-R1  cost 120,000.00 over 60 months  →  2,000.00 a month
     *          six months of depreciation      →     12,000.00 accumulated
     *          carrying 108,000.00, valued at 150,000.00
     *          movement +42,000.00, nothing was ever charged to profit on it,
     *          so the whole increase is a revaluation surplus (IAS 16.39).
     *
     *   FA-R2  cost 50,000.00 over 50 months   →  1,000.00 a month
     *          six months                      →      6,000.00 accumulated
     *          carrying 44,000.00, valued at 30,000.00
     *          movement −14,000.00, it carries no surplus, so the whole fall
     *          is charged to profit (IAS 16.40, IAS 36.59).
     *
     * Each event first eliminates the accumulated depreciation against cost
     * (IAS 16.35(b)), which is the posting the note used to read as a disposal.
     */
    await openFiscalYear({ orgId: ORG, entityId: REV, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: REV });
    await P(REV, "2026-01-05", [
      { account: "1010", debit: 30_000_000 },
      { account: "3000", credit: 30_000_000 },
    ], { memo: "Share capital issued" });
    await P(REV, "2026-01-15", [
      { account: "1500", debit: 17_000_000 },
      { account: "1010", credit: 17_000_000 },
    ], { memo: "Plant and a forklift" });
    await addAsset({
      orgId: ORG, entityId: REV,
      asset: { code: "FA-R1", name: "Plant", acquiredOn: "2026-01-15", costMinor: 12_000_000, usefulLifeMonths: 60 },
    });
    await addAsset({
      orgId: ORG, entityId: REV,
      asset: { code: "FA-R2", name: "Forklift", acquiredOn: "2026-01-15", costMinor: 5_000_000, usefulLifeMonths: 50 },
    });
    for (const m of ["01", "02", "03", "04", "05", "06"]) {
      await runDepreciation({ orgId: ORG, entityId: REV, period: `2026-${m}` });
    }
    await revalueAsset({ orgId: ORG, entityId: REV, code: "FA-R1", on: "2026-06-30", fairValueMinor: 15_000_000 });
    await revalueAsset({ orgId: ORG, entityId: REV, code: "FA-R2", on: "2026-06-30", fairValueMinor: 3_000_000 });
    // A tenth of the surplus realised into retained earnings (IAS 16.41):
    // equity does not change in total, only in composition.
    await releaseSurplus({ orgId: ORG, entityId: REV, code: "FA-R1", on: "2026-12-31", amountMinor: 1_000_000 });

    /* ---- a ledger whose registers hold the notes the pack now carries --- */

    await openFiscalYear({ orgId: ORG, entityId: PACK, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: PACK });
    await P(PACK, "2026-01-05", [
      { account: "1010", debit: 10_000_000 },
      { account: "3000", credit: 10_000_000 },
    ], { memo: "Share capital issued" });
    // A provision, recognised and posted, and a contingency that is not.
    await recordProvision({
      orgId: ORG, entityId: PACK, code: "PR-WAR", name: "Warranty on the 2026 installations",
      category: "WARRANTY", recognisedOn: "2026-03-31", estimateMinor: 6_000_000,
    });
    await recordProvision({
      orgId: ORG, entityId: PACK, code: "CL-CLAIM", name: "Claim by a former subcontractor",
      kind: "CONTINGENT_LIABILITY", category: "LEGAL", recognisedOn: "2026-08-01", estimateMinor: 2_500_000,
    });
    // One temporary difference: plant carried at 100,000.00 with a tax base of
    // 80,000.00 is 20,000.00 taxable, worth 1,800.00 of deferred tax at 9%.
    await recordItems({
      orgId: ORG, entityId: PACK, asOf: "2026-12-31",
      items: [{
        code: "DT-PPE", description: "Accelerated allowances on plant", category: "FIXED_ASSET",
        carryingMinor: 10_000_000, taxBaseMinor: 8_000_000,
      }],
    });
    // Everything IAS 24 asks for, declared: who the party is, what key
    // management was paid by category, and who controls the entity.
    await db.counterparty.create({
      data: { orgId: ORG, entityId: PACK, code: "ACME", name: "Acme Holding LLC", kind: "BOTH", status: "active" },
    });
    await declareRelatedParty({
      orgId: ORG, entityId: PACK,
      party: {
        partyKey: "ACME", name: "Acme Holding LLC", relationship: "PARENT",
        declaredBy: "R. Khan", startedOn: "2020-01-01",
      },
    });
    for (const [category, amountMinor, headcount] of [
      ["SHORT_TERM", 1_200_000, 2],
      ["POST_EMPLOYMENT", 90_000, 2],
      ["OTHER_LONG_TERM", 0, 0],
      ["TERMINATION", 0, 0],
      ["SHARE_BASED", 0, 0],
    ] as const) {
      await declareCompensation({
        orgId: ORG, entityId: PACK, period: "2026", category, amountMinor, headcount, declaredBy: "R. Khan",
      });
    }
    await attest({
      orgId: ORG, entityId: PACK, period: "2026", attestedBy: "R. Khan", attestedOn: "2027-02-01",
      parentName: "Acme Holding LLC", ultimateControllingParty: "Mr A. Al Mansoori",
    });
    // A second bank account, outside the four codes that used to be the whole
    // definition of cash, and a dividend paid out of it. Whether the statement
    // can see that this was settled in cash is what tells a distribution apart
    // from a prior period adjustment.
    await db.account.create({
      data: {
        orgId: ORG, entityId: PACK, code: "1030", name: "Bank — call deposit",
        nameAr: "البنك — وديعة تحت الطلب", type: "ASSET", subtype: "BANK", isPostable: true,
      },
    });
    await P(PACK, "2026-06-01", [
      { account: "1030", debit: 900_000 },
      { account: "1010", credit: 900_000 },
    ], { memo: "Transfer to the call deposit" });
    await P(PACK, "2026-11-30", [
      { account: "3900", debit: 500_000 },
      { account: "1030", credit: 500_000 },
    ], { memo: "Dividend paid from the call deposit" });
  }, 180_000);

  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ============================================== the matrix, before close */

  describe("the matrix", () => {
    it("has every equity account in the standard chart as a column, named from the chart", async () => {
      const s = await E();
      // 3300 is here because the product ships a module that credits it. It
      // used to be left out, which put every revaluation surplus into an
      // "unclassified" bucket whose only remedy was to edit this array.
      expect(s.columns.map((c) => c.code)).toEqual(["3000", "3100", "3200", "3300", "3900"]);
      expect(s.columns[0].name).toBe("Share capital");
      expect(s.columns[3].name).toBe("Revaluation surplus");
      expect(s.columns[4].name).toBe("Retained earnings");
      // Bilingual by construction, not by a translation table bolted on.
      expect(s.columns[0].nameAr).toBe("رأس المال");
    });

    it("brings nothing forward in the entity's first year", async () => {
      const s = await E();
      expect(s.opening.totalMinor).toBe("0");
      expect(s.opening.cells["3000"]).toBe("0");
      expect(s.opening.cells["3900"]).toBe("0");
    });

    it("puts share capital issued in its own column and nowhere else", async () => {
      const s = await E();
      const row = s.movements.find((r) => r.key === "share_capital")!;
      expect(row.cells["3000"]).toBe("100000000");
      expect(row.cells["3100"]).toBe("0");
      expect(row.cells["3900"]).toBe("0");
      expect(row.totalMinor).toBe("100000000");
    });

    it("separates what the shareholder put in from what they took out", async () => {
      const s = await E();
      expect(s.movements.find((r) => r.key === "capital_introduced")!.cells["3100"]).toBe("200000");
      // Credit-positive throughout, so drawings are negative and render in
      // parentheses rather than needing a column of their own.
      expect(s.movements.find((r) => r.key === "distributions")!.cells["3100"]).toBe("-80000");
    });

    it("shows a dividend as a reduction of retained earnings", async () => {
      const s = await E();
      const row = s.movements.find((r) => r.key === "distributions")!;
      expect(row.cells["3900"]).toBe("-6000000");
      expect(row.totalMinor).toBe("-6080000"); // the dividend and the drawings together
    });

    it("moves a statutory reserve transfer between two columns and adds it to nil", async () => {
      const s = await E();
      const row = s.movements.find((r) => r.key === "reserve_transfer")!;
      expect(row.cells["3200"]).toBe("4000000");
      expect(row.cells["3900"]).toBe("-4000000");
      // The row total is the test: an appropriation changes the composition of
      // equity, never its size.
      expect(row.totalMinor).toBe("0");
    });

    it("names a movement on retained earnings it cannot classify rather than guessing", async () => {
      const s = await E();
      const row = s.movements.find((r) => r.key === "prior_period_adjustment")!;
      expect(row.cells["3900"]).toBe("-500000");
      // 500,000 minor units is AED 5,000.00, and the warning names the account
      // and the date so the entry can be found and confirmed.
      expect(s.warnings.some((w) => /prior period adjustment/i.test(w) && w.includes("-5,000.00") && w.includes("2026-09-30"))).toBe(true);
    });

    it("adds up to the same figure down the columns and across the rows", async () => {
      const s = await E();
      expect(s.foots).toBe(true);
      expect(s.totalByRowsMinor).toBe(s.totalByColumnsMinor);
      // And the arithmetic itself, column by column: closing is opening plus
      // every movement, not a figure read back off the balance sheet.
      for (const c of s.columns) {
        const moved = s.movements.reduce((a, r) => a + BigInt(r.cells[c.code]), 0n);
        expect(BigInt(s.closing.cells[c.code])).toBe(BigInt(s.opening.cells[c.code]) + moved);
      }
      // Row totals, added down, are the same grand total.
      const byRows = [s.opening, ...s.movements].reduce((a, r) => a + BigInt(r.totalMinor), 0n);
      expect(byRows.toString()).toBe(s.totalByColumnsMinor);
    });
  });

  /* ================================== profit, and the proof against the sheet */

  describe("profit for the period, before the year is closed", () => {
    it("shows the year's result even though nothing has been posted to retained earnings", async () => {
      const s = await E();
      const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-12-31" });
      const row = s.movements.find((r) => r.key === "profit_for_period")!;
      expect(row.origin).toBe("derived");
      expect(row.totalMinor).toBe(pl.netProfitMinor);
      expect(row.cells["3900"]).toBe(pl.netProfitMinor);
      expect(s.profitForThePeriodMinor).toBe(pl.netProfitMinor);
      expect(s.closed).toBe(false);
      expect(BigInt(row.totalMinor)).toBeGreaterThan(0n);
    });

    it("is exactly what the balance sheet carries as current year earnings", async () => {
      const s = await E();
      const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
      expect(s.profitForThePeriodMinor).toBe(bs.currentYearEarningsMinor);
    });

    it("closes to the equity section of the balance sheet, to the fil", async () => {
      const s = await E();
      const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
      expect(s.equityPerBalanceSheetMinor).toBe(bs.equity.totalMinor);
      expect(s.totalByColumnsMinor).toBe(bs.equity.totalMinor);
      expect(s.differenceMinor).toBe("0");
      expect(s.reconciles).toBe(true);
    });

    it("carries forward the columns the seed put there", async () => {
      const s = await E();
      expect(s.closing.cells["3000"]).toBe("100000000");
      expect(s.closing.cells["3100"]).toBe("120000");   // 200,000 in less 80,000 out
      expect(s.closing.cells["3200"]).toBe("4000000");
      // Retained earnings: the year's profit less the dividend, the reserve
      // transfer and the restatement.
      expect(s.closing.cells["3900"]).toBe(
        (BigInt(s.profitForThePeriodMinor) - 6_000_000n - 4_000_000n - 500_000n).toString(),
      );
    });
  });

  /* ======================================================== the notes ===== */

  describe("the notes", () => {
    it("numbers the notes and returns them all", async () => {
      const notes = await N();
      expect(notes.map((n) => n.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect(notes.map((n) => n.key)).toEqual([
        "accounting_policies",
        "property_plant_and_equipment",
        // A capitalised licence used to sit inside the note above, on 1500,
        // amortising through 6600 and captioned as plant. IAS 38.118 asks for
        // its own reconciliation and this is it.
        "intangible_assets",
        "leases",
        "trade_receivables_and_payables",
        "revenue",
        "related_parties",
        // Both of these were built, tested and reconciled in their own modules
        // and simply never called from here.
        "provisions",
        "corporate_tax",
        "deferred_tax",
        "events_after_the_reporting_period",
        "commitments_and_contingencies",
      ]);
    });

    it("gives an intangible its own note rather than calling it plant", async () => {
      const notes = await N();
      const ppe = noteOf<PpeNote>(notes, "property_plant_and_equipment");
      const ia = noteOf<IntangiblesNote>(notes, "intangible_assets");

      // The ERP licence is 3,600,000 over 36 months = 100,000 a month, six
      // months charged = 600,000; the van is 12,000,000 over 60 = 200,000 a
      // month, 1,200,000 charged. Each is wholly in one note and in neither
      // other.
      expect(ia.cost.additionsMinor).toBe("3600000");
      expect(ia.accumulatedAmortisation.chargeMinor).toBe("600000");
      expect(ia.netBookValue.closingMinor).toBe("3000000");
      expect(ia.cost.agrees).toBe(true);
      expect(ia.accumulatedAmortisation.agrees).toBe(true);
      expect(ia.costAccount).toBe("1560");
      expect(ia.accumulatedAmortisationAccount).toBe("1570");

      // The van, and only the van. Before this the licence was on 1500 and
      // inside the class table below it.
      expect(ppe.cost.additionsMinor).toBe("12000000");
      expect(ppe.accumulatedDepreciation.chargeMinor).toBe("1200000");
      expect(ppe.byCategory.map((c) => c.category)).not.toContain("INTANGIBLE");
      expect(ppe.cost.agrees).toBe(true);

      // IAS 38.118(a): the amortisation period, by class.
      expect(ia.byCategory).toHaveLength(1);
      expect(ia.byCategory[0]).toMatchObject({
        category: "INTANGIBLE", count: 1, shortestLifeMonths: 36, longestLifeMonths: 36,
      });

      // And what it cannot say, said. An indefinite life and an internally
      // generated asset both need a judgement no accounting record holds.
      expect(ia.notDerivable.join(" ")).toMatch(/indefinite/i);
      expect(ia.notDerivable.join(" ")).toMatch(/internally/i);
    });

    it("states the IAS 38 policy once there is an intangible, and not before", async () => {
      const policies = noteOf<PolicyNote>(await N(), "accounting_policies").policies;
      const ia = policies.find((p) => p.key === "intangible_assets")!;
      expect(ia).toBeDefined();
      expect(ia.policy).toMatch(/straight-line/i);
      expect(ia.policy).toMatch(/presented separately from depreciation/i);
      // IAS 38.75: the revaluation model needs an active market, and software
      // has none — so the note says the model is not applied rather than
      // leaving a reader to wonder which was chosen.
      expect(ia.policy).toMatch(/revaluation model is not applied/i);
      expect(ia.basis).toMatch(/IAS 38\.118/);

      // An entity holding none does not get the paragraph. A policy note padded
      // with paragraphs that apply to nothing is one nobody reads to the end.
      const bare = noteOf<PolicyNote>(await N(BARE), "accounting_policies").policies;
      expect(bare.find((p) => p.key === "intangible_assets")).toBeUndefined();
    });

    it("states only the policies this entity's data actually needs", async () => {
      const policies = noteOf<PolicyNote>(await N(), "accounting_policies");
      const keys = policies.policies.map((p) => p.key);
      expect(policies.functionalCurrency).toBe("AED");
      expect(keys).toContain("basis_of_preparation");
      expect(keys).toContain("functional_currency");
      expect(keys).toContain("revenue");
      expect(keys).toContain("property_plant_and_equipment");
      expect(keys).toContain("leases");
      expect(keys).toContain("value_added_tax");
      // Nothing has ever been posted to inventory, so no inventory policy is
      // claimed — the point of deriving them rather than listing them.
      expect(keys).not.toContain("inventory");
      expect(keys).not.toContain("employee_benefits");
    });

    it("reports property, plant and equipment as cost, additions and depreciation", async () => {
      const ppe = noteOf<PpeNote>(await N(), "property_plant_and_equipment");
      expect(ppe.state).toBe("present");
      expect(ppe.cost.openingMinor).toBe("0");
      expect(ppe.cost.additionsMinor).toBe("12000000");
      expect(ppe.cost.disposalsMinor).toBe("0");
      expect(ppe.cost.revaluationMinor).toBe("0");
      expect(ppe.cost.closingMinor).toBe("12000000");
      expect(ppe.cost.agrees).toBe(true);
      // Six months at 12,000,000 over sixty months.
      expect(ppe.accumulatedDepreciation.chargeMinor).toBe("1200000");
      expect(ppe.accumulatedDepreciation.eliminatedOnRevaluationMinor).toBe("0");
      expect(ppe.accumulatedDepreciation.closingMinor).toBe("1200000");
      expect(ppe.accumulatedDepreciation.agrees).toBe(true);
      expect(ppe.netBookValue.closingMinor).toBe("10800000");
      // The register is the second record; it has to agree with the ledger.
      expect(ppe.register.assets).toBe(1);
      expect(ppe.register.costAgrees).toBe(true);
      expect(ppe.register.accumulatedAgrees).toBe(true);
      expect(ppe.byCategory).toEqual([
        { category: "EQUIPMENT", count: 1, costMinor: "12000000", accumulatedMinor: "1200000", netBookValueMinor: "10800000" },
      ]);
      // Nothing has been revalued or impaired, so the IAS 16.73(e)(iv)-(vi)
      // rows are nil rather than absent — a nil is a fact about the year.
      expect(ppe.revaluation).toEqual({
        events: 0,
        increasesMinor: "0",
        decreasesMinor: "0",
        impairmentLossesMinor: "0",
        impairmentReversalsMinor: "0",
        netMovementMinor: "0",
        perLedgerMinor: "0",
        agrees: true,
      });
    });

    it("gives the IFRS 16.53 lease disclosures the register can support", async () => {
      const leases = noteOf<LeaseNote>(await N(), "leases");
      expect(leases.state).toBe("present");
      expect(leases.leases).toBe(2);
      // The right-of-use asset is recognised at the liability, and nothing else.
      expect(leases.rightOfUseAssets.additionsMinor).toBe(leasePvMinor);
      expect(leases.liabilities.additionsMinor).toBe(leasePvMinor);
      expect(leases.rightOfUseAssets.agrees).toBe(true);
      expect(leases.liabilities.agrees).toBe(true);
      // Six contractual payments of 5,000.00 on the capitalised lease.
      expect(leases.liabilities.paymentsMinor).toBe("3000000");
      // Interest unwinds INTO the liability and is a separate charge.
      expect(BigInt(leases.liabilities.interestMinor)).toBeGreaterThan(0n);
      expect(leases.interestExpenseMinor).toBe(leases.liabilities.interestMinor);
      // Six months of the short-term lease, at 2,000.00 a month.
      expect(leases.shortTermAndLowValueExpenseMinor).toBe("1200000");
      // Payments on one lease plus the rent on the other.
      expect(leases.totalCashOutflowMinor).toBe("4200000");
      // Eighteen months of the capitalised lease left, undiscounted.
      expect(leases.maturity.find((m) => m.key === "within_1_year")!.amountMinor).toBe("6000000");
      expect(leases.maturity.find((m) => m.key === "1_to_5_years")!.amountMinor).toBe("3000000");
      expect(leases.maturity.find((m) => m.key === "over_5_years")!.amountMinor).toBe("0");
      // An exempt lease leaves no trace in 1700 or 2600, so the register is the
      // only place it can be seen at all.
      expect(leases.exemptions.map((e) => e.code)).toEqual(["LS-002"]);
      expect(leases.exemptions[0].reason).toBe("SHORT_TERM");
      expect(leases.notDerivable.length).toBeGreaterThan(0);
    });

    it("ages the receivables and payables and ties them to their control accounts", async () => {
      const note = noteOf<ReceivablesPayablesNote>(await N(), "trade_receivables_and_payables");
      expect(note.state).toBe("present");
      expect(note.receivables.asOf).toBe("2026-12-31");
      // 42,000,000 invoiced less 30,000,000 received, plus a 20,000,000 export.
      expect(note.receivables.totalPerAgeingMinor).toBe("32000000");
      expect(note.receivables.totalPerLedgerMinor).toBe("32000000");
      expect(note.receivables.agrees).toBe(true);
      expect(note.receivables.openItems).toBe(2);
      // Both documents are more than 120 days old at the reporting date.
      expect(note.receivables.bands.find((b) => b.key === "over120")!.amountMinor).toBe("32000000");
      expect(note.receivables.bands.find((b) => b.key === "current")!.amountMinor).toBe("0");
      expect(note.payables.totalPerAgeingMinor).toBe("3000000");
      expect(note.payables.agrees).toBe(true);
      // No allowance has been recognised, so none is claimed.
      expect(note.allowanceForDoubtfulDebtsMinor).toBe("0");
      expect(note.netReceivablesMinor).toBe("32000000");
    });

    it("disaggregates revenue by tax treatment and by account, and the two agree", async () => {
      const revenue = noteOf<RevenueNote>(await N(), "revenue");
      expect(revenue.state).toBe("present");
      expect(revenue.totalMinor).toBe("60000000");
      const standard = revenue.byTaxTreatment.find((t) => t.taxCode === "STANDARD_5")!;
      const zero = revenue.byTaxTreatment.find((t) => t.taxCode === "ZERO_EXPORT")!;
      expect(standard.amountMinor).toBe("40000000");
      expect(zero.amountMinor).toBe("20000000");
      // Shares in basis points, by integer division — they add to 100%.
      expect(standard.shareBps).toBe(6666);
      expect(zero.shareBps).toBe(3333);
      expect(revenue.byAccount.map((a) => a.code)).toEqual(["4000", "4200"]);
      expect(revenue.byAccount.find((a) => a.code === "4000")!.amountMinor).toBe("40000000");
      expect(revenue.untaggedMinor).toBe("0");
      expect(revenue.untaggedLines).toBe(0);
      expect(revenue.agrees).toBe(true);
    });

    it("presents the shareholder current account as the balance that is related by construction", async () => {
      const related = noteOf<RelatedPartyNote>(await N(), "related_parties");
      expect(related.state).toBe("present");
      expect(related.account.code).toBe("3100");
      expect(related.openingMinor).toBe("0");
      expect(related.closingMinor).toBe("120000");
      expect(related.movements.map((m) => m.key).sort()).toEqual(["capital_introduced", "distributions"]);
      // A ledger cannot see relatedness, and the note says so rather than
      // implying that this is the whole of it. Nobody has declared a party,
      // paid key management or attested to a controlling party here, so all
      // three are still outstanding and the note says which.
      expect(related.parties).toEqual([]);
      expect(related.attestation.present).toBe(false);
      expect(related.completeness.complete).toBe(false);
      expect(related.requiresInput.length).toBeGreaterThan(0);
      expect(related.requiresInput).toEqual(related.completeness.reasons);
      expect(related.requiresInput.join(" ")).toMatch(/key management/i);
      expect(related.requiresInput.join(" ")).toMatch(/attested/i);
    });

    it("reconciles the corporate tax charge to the accounting profit, and the rows foot", async () => {
      const s = await E();
      const tax = noteOf<TaxNote>(await N(), "corporate_tax");
      expect(tax.state).toBe("present");
      expect(tax.computationReadsClosedYear).toBe(false);
      // Nothing in this chart produces a derived adjustment, so taxable income
      // is the accounting profit.
      expect(tax.taxableIncomeMinor).toBe(s.profitForThePeriodMinor);
      const taxable = BigInt(tax.taxableIncomeMinor);
      const expected = ((taxable - 37_500_000n) * 9n + 50n) / 100n;
      expect(tax.computedChargeMinor).toBe(expected.toString());
      // The reconciliation is the proof: every row is a tax amount and they
      // add to the charge exactly, with nothing left over.
      expect(tax.foots).toBe(true);
      expect(tax.reconciliationTotalMinor).toBe(tax.computedChargeMinor);
      expect(tax.reconciliation.map((r) => r.key)).toEqual(["at_statutory_rate", "adjustments", "zero_band"]);
      expect(tax.reconciliation.find((r) => r.key === "adjustments")!.amountMinor).toBe("0");
      // The zero band is worth 9% of AED 375,000 to every taxpayer.
      expect(tax.reconciliation.find((r) => r.key === "zero_band")!.amountMinor).toBe("-3375000");
      // The provision has not been posted, and the note says so instead of
      // presenting the computed figure as if it were in the books.
      expect(tax.chargePerLedgerMinor).toBe("0");
      expect(tax.payableClosingMinor).toBe("0");
      expect(tax.provisionPosted).toBe(false);
      expect(tax.warnings.some((w) => /no provision has been posted/i.test(w))).toBe(true);
    });

    it("marks the notes nobody can derive as needing an answer, not as empty", async () => {
      const notes = await N();
      const events = noteOf<RequiresInputNote>(notes, "events_after_the_reporting_period");
      const commitments = noteOf<RequiresInputNote>(notes, "commitments_and_contingencies");
      expect(events.state).toBe("requires_input");
      expect(commitments.state).toBe("requires_input");
      expect(events.requires.length).toBeGreaterThan(2);
      expect(commitments.requires.length).toBeGreaterThan(2);
      expect(events.requires.map((r) => r.key)).toContain("authorisation_date");
      expect(commitments.requires.map((r) => r.key)).toContain("capital_commitments");
      // Every question carries the paragraph that asks it.
      expect(events.requires.every((r) => r.basis.length > 0)).toBe(true);
    });
  });

  /* ============================ a ledger with nothing in it but capital ==== */

  describe("an entity with nothing to disclose", () => {
    it("tells an empty note apart from a note nobody has filled in", async () => {
      const notes = await N(BARE);
      expect(noteOf<PpeNote>(notes, "property_plant_and_equipment").state).toBe("empty");
      expect(noteOf<LeaseNote>(notes, "leases").state).toBe("empty");
      expect(noteOf<ReceivablesPayablesNote>(notes, "trade_receivables_and_payables").state).toBe("empty");
      expect(noteOf<RevenueNote>(notes, "revenue").state).toBe("empty");
      // Nil is a fact about the ledger. Relatedness is not, so a nil
      // shareholder account cannot stand as "there were no related parties".
      expect(noteOf<RelatedPartyNote>(notes, "related_parties").state).toBe("requires_input");
      expect(noteOf<RequiresInputNote>(notes, "events_after_the_reporting_period").state).toBe("requires_input");
    });

    it("claims no policy for something the entity has none of", async () => {
      const policies = noteOf<PolicyNote>(await N(BARE), "accounting_policies");
      const keys = policies.policies.map((p) => p.key);
      expect(keys).toContain("basis_of_preparation");
      expect(keys).toContain("functional_currency");
      expect(keys).not.toContain("property_plant_and_equipment");
      expect(keys).not.toContain("leases");
      expect(keys).not.toContain("revenue");
    });

    it("still reconciles, with a profit row of nothing", async () => {
      const s = await E(BARE);
      const row = s.movements.find((r) => r.key === "profit_for_period")!;
      expect(row.totalMinor).toBe("0");
      expect(s.closing.cells["3000"]).toBe("1000000");
      expect(s.totalByColumnsMinor).toBe("1000000");
      expect(s.reconciles).toBe(true);
      expect(s.warnings).toEqual([]);
    });
  });

  /* ================== an equity account the statement has never heard of === */

  describe("an equity account outside the columns", () => {
    it("names it, and refuses to reconcile without it", async () => {
      const s = await E(ODD);
      expect(s.warnings.some((w) => w.includes("3400") && w.includes("General reserve"))).toBe(true);
      expect(s.reconciles).toBe(false);
      // Nothing was invented to make it agree: the columns still total the
      // share capital alone, and the difference is exactly the missing account.
      expect(s.totalByColumnsMinor).toBe("1000000");
      expect(s.equityPerBalanceSheetMinor).toBe("1500000");
      expect(s.differenceMinor).toBe("-500000");
      expect(s.foots).toBe(true);
      // And it appears in no row at all rather than in a balancing line.
      const everywhere = [s.opening, ...s.movements, s.closing];
      expect(everywhere.every((r) => !("3400" in r.cells))).toBe(true);
    });
  });

  /* ================================ an asset revalued and an asset impaired */

  describe("revaluation and impairment", () => {
    it("counts neither the elimination nor the uplift as an addition or a disposal", async () => {
      const ppe = noteOf<PpeNote>(await N(REV), "property_plant_and_equipment");
      // Two assets bought for 170,000.00 between them, and nothing sold.
      expect(ppe.cost.additionsMinor).toBe("17000000");
      expect(ppe.cost.disposalsMinor).toBe("0");
      // What the revaluations did to cost: 12,000 + 6,000 of accumulated
      // depreciation eliminated against it, then 42,000 on and 14,000 off.
      //   −1,200,000 − 600,000 + 4,200,000 − 1,400,000 = +1,000,000
      expect(ppe.cost.revaluationMinor).toBe("1000000");
      expect(ppe.cost.closingMinor).toBe("18000000");
      expect(ppe.cost.agrees).toBe(true);

      // Six months on both assets: 2,000.00 and 1,000.00 a month.
      expect(ppe.accumulatedDepreciation.chargeMinor).toBe("1800000");
      // Nothing was disposed of; all of it was eliminated on revaluation.
      expect(ppe.accumulatedDepreciation.releasedOnDisposalMinor).toBe("0");
      expect(ppe.accumulatedDepreciation.eliminatedOnRevaluationMinor).toBe("1800000");
      expect(ppe.accumulatedDepreciation.closingMinor).toBe("0");
      expect(ppe.accumulatedDepreciation.agrees).toBe(true);
      // 150,000.00 and 30,000.00, which is what both were valued at.
      expect(ppe.netBookValue.closingMinor).toBe("18000000");
    });

    it("gives the IAS 16.73(e)(iv)-(vi) rows from the events, and ties them to the ledger", async () => {
      const ppe = noteOf<PpeNote>(await N(REV), "property_plant_and_equipment");
      expect(ppe.revaluation.events).toBe(2);
      expect(ppe.revaluation.increasesMinor).toBe("4200000");
      expect(ppe.revaluation.decreasesMinor).toBe("0");
      expect(ppe.revaluation.impairmentLossesMinor).toBe("1400000");
      expect(ppe.revaluation.impairmentReversalsMinor).toBe("0");
      // 42,000.00 to equity less 14,000.00 to profit.
      expect(ppe.revaluation.netMovementMinor).toBe("2800000");
      // And the same figure again from the cost and depreciation accounts
      // themselves: +1,000,000 on cost and +1,800,000 off accumulated
      // depreciation. Two records of one thing, which is the point of showing
      // it — the register decided the split, the ledger carries the total.
      expect(ppe.revaluation.perLedgerMinor).toBe("2800000");
      expect(ppe.revaluation.agrees).toBe(true);
    });

    it("states the revaluation model for an entity that has revalued", async () => {
      const policies = noteOf<PolicyNote>(await N(REV), "accounting_policies");
      const ppe = policies.policies.find((p) => p.key === "property_plant_and_equipment")!;
      expect(ppe.policy).toMatch(/revalued amount/i);
      expect(ppe.policy).not.toMatch(/stated at cost less accumulated depreciation/i);
      expect(ppe.basis).toContain("IAS 16.39");
      // The forklift was written down, so the impairment sentence is there too.
      expect(ppe.policy).toMatch(/recoverable amount/i);
      expect(ppe.basis).toContain("IAS 36");
      expect(ppe.evidence).toContain("3300");
    });

    it("keeps the cost model for an entity that has not", async () => {
      const policies = noteOf<PolicyNote>(await N(), "accounting_policies");
      const ppe = policies.policies.find((p) => p.key === "property_plant_and_equipment")!;
      expect(ppe.policy).toMatch(/stated at cost less accumulated depreciation/i);
      expect(ppe.policy).not.toMatch(/revalued amount/i);
      expect(ppe.evidence).not.toContain("3300");
    });

    it("puts the surplus in its own column and its own row, and reconciles", async () => {
      const st = await E(REV);
      const row = st.movements.find((r) => r.key === "revaluation")!;
      expect(row.cells["3300"]).toBe("4200000");
      // The write-down went to profit, not against a surplus that asset never
      // had, so it is nowhere on this row.
      expect(row.totalMinor).toBe("4200000");
      // Depreciation of 18,000.00 and an impairment of 14,000.00.
      expect(st.profitForThePeriodMinor).toBe("-3200000");
      expect(st.movements.find((r) => r.key === "profit_for_period")!.label).toBe("Loss for the period");

      expect(st.closing.cells["3000"]).toBe("30000000");
      // 42,000.00 arising less the 10,000.00 realised.
      expect(st.closing.cells["3300"]).toBe("3200000");
      expect(st.closing.cells["3900"]).toBe("-2200000");
      expect(st.totalByColumnsMinor).toBe("31000000");

      // The proof. Before 3300 was a column this was false every year, by
      // exactly the surplus, with a remedy no user of this software could act
      // on.
      expect(st.reconciles).toBe(true);
      expect(st.differenceMinor).toBe("0");
      expect(st.foots).toBe(true);
      expect(st.warnings).toEqual([]);
    });

    it("nets the realisation of a surplus to nil across the row", async () => {
      const st = await E(REV);
      const row = st.movements.find((r) => r.key === "transfer_within_equity")!;
      // Dr 3300, Cr 3900. Both legs are classified now; the 3300 leg used to
      // be dropped, so the row read as a credit of 10,000.00 out of nowhere.
      expect(row.cells["3300"]).toBe("-1000000");
      expect(row.cells["3900"]).toBe("1000000");
      expect(row.totalMinor).toBe("0");
    });
  });

  /* ========================== the notes the pack used not to call at all === */

  describe("provisions, deferred tax and related parties", () => {
    it("carries the provisions register's IAS 37.84 movement table", async () => {
      const note = noteOf<ProvisionsNote>(await N(PACK), "provisions");
      expect(note.number).toBe(8);
      expect(note.state).toBe("present");
      expect(note.rows.map((r) => r.category)).toEqual(["WARRANTY"]);
      const warranty = note.rows[0];
      expect(warranty.openingMinor).toBe("0");
      expect(warranty.additionsMinor).toBe("6000000");
      expect(warranty.usedMinor).toBe("0");
      expect(warranty.releasedMinor).toBe("0");
      expect(warranty.unwoundMinor).toBe("0");
      expect(warranty.closingMinor).toBe("6000000");
      expect(note.totals.closingMinor).toBe("6000000");
      // The note has to add up to what the register carries, or the register
      // is the finding.
      expect(note.carryingPerRegisterMinor).toBe("6000000");
      expect(note.agreesWithRegister).toBe(true);
      // Disclosed and not recognised, and never added into the totals above.
      expect(note.contingentLiabilities.map((c) => c.code)).toEqual(["CL-CLAIM"]);
      expect(note.contingentLiabilities[0].estimateMinor).toBe("2500000");
      expect(note.contingentAssets).toEqual([]);
      expect(note.narrative.length).toBeGreaterThan(0);
    });

    it("carries the deferred tax register's IAS 12.81(g) note after the tax charge", async () => {
      const notes = await N(PACK);
      const note = noteOf<DeferredTaxNote>(notes, "deferred_tax");
      expect(note.number).toBe(10);
      expect(notes.find((n) => n.key === "corporate_tax")!.number).toBe(9);
      expect(note.state).toBe("present");
      expect(note.rows.map((r) => r.category)).toEqual(["FIXED_ASSET"]);
      // 20,000.00 of taxable difference at 9% is 1,800.00.
      expect(note.totals.closingLiabilityMinor).toBe("180000");
      expect(note.totals.closingAssetMinor).toBe("0");
      expect(note.totals.closingNetMinor).toBe("180000");
      expect(note.previousAsOf).toBeNull();
      expect(note.totals.movementMinor).toBe("180000");
      expect(note.totals.unrecognisedTaxMinor).toBe("0");
    });

    it("asks nothing of a related party note whose register has been filled in", async () => {
      const note = noteOf<RelatedPartyNote>(await N(PACK), "related_parties");
      expect(note.state).toBe("present");
      expect(note.parties.map((p) => p.name)).toEqual(["Acme Holding LLC"]);
      expect(note.parties[0].relationshipLabel).toBe("Parent");
      expect(note.parties[0].declaredBy).toBe("R. Khan");
      expect(note.byRelationship.map((g) => g.relationship)).toEqual(["PARENT"]);
      // 12,000.00 short-term and 900.00 post-employment, over two people.
      expect(note.compensation.totalMinor).toBe("1290000");
      expect(note.compensation.headcount).toBe(2);
      expect(note.compensation.missingCategories).toEqual([]);
      expect(note.attestation.ultimateControllingParty).toBe("Mr A. Al Mansoori");
      expect(note.completeness.unassessedCount).toBe(0);
      expect(note.completeness.complete).toBe(true);
      // The four questions this note used to ask every entity forever have
      // all been answered, so it asks nothing.
      expect(note.requiresInput).toEqual([]);
      // And the shareholder current account is still the balance related by
      // construction, whoever else has been declared.
      expect(note.account.code).toBe("3100");
      expect(note.closingMinor).toBe("0");
    });

    it("says where a contingency already disclosed can be found", async () => {
      const notes = await N(PACK);
      const commitments = noteOf<RequiresInputNote>(notes, "commitments_and_contingencies");
      const question = commitments.requires.find((r) => r.key === "contingent_liabilities")!.question;
      expect(question).toContain("disclosed in note 8");
      // The question is still asked: a register holding one contingency is not
      // a register holding all of them.
      expect(question).toMatch(/litigation, claim or assessment/);
      expect(commitments.requires.find((r) => r.key === "contingent_assets")!.question)
        .not.toContain("disclosed in note");
    });

    it("still ties to the balance sheet with a provision on it", async () => {
      const st = await E(PACK);
      // 10,000,000 of capital, less the 6,000,000 provision charged to profit
      // and the 500,000 dividend paid.
      expect(st.profitForThePeriodMinor).toBe("-6000000");
      expect(st.totalByColumnsMinor).toBe("3500000");
      expect(st.reconciles).toBe(true);
      expect(st.warnings).toEqual([]);
    });

    it("sees a dividend paid out of a bank account outside the four seeded codes", async () => {
      const st = await E(PACK);
      // 1030 is not one of 1000, 1010, 1020 and 1050, and it is cash all the
      // same: `cash.ts` derives the list from the chart. Read from the four
      // codes alone this entry looked like a debit to retained earnings that
      // touched no cash, which the classifier reports as a prior period
      // adjustment and then asks the preparer to confirm.
      expect(st.movements.find((r) => r.key === "distributions")!.cells["3900"]).toBe("-500000");
      expect(st.movements.some((r) => r.key === "prior_period_adjustment")).toBe(false);
      expect(st.warnings).toEqual([]);
    });

    it("leaves both notes empty rather than absent where the registers are", async () => {
      const notes = await N(BARE);
      expect(noteOf<ProvisionsNote>(notes, "provisions").state).toBe("empty");
      expect(noteOf<DeferredTaxNote>(notes, "deferred_tax").state).toBe("empty");
    });
  });

  /* ============================================ the year, once it is closed */

  describe("once the year is closed", () => {
    it("does not double count the profit the close has posted", async () => {
      const before = await E();
      const profitBefore = before.profitForThePeriodMinor;

      await db.accountingPeriod.updateMany({
        where: { orgId: ORG, entityId: ENT, isAdjustment: false },
        data: { status: "hard_closed" },
      });
      const closed = await closeYear({ orgId: ORG, entityId: ENT, fiscalYear: "2026" });
      expect(closed.reference).toMatch(/^CL-/);

      const after = await E();
      // The profit and loss for a closed year reads nil, and current year
      // earnings on the balance sheet read nil, because the close brought
      // every income and expense account to zero. The statement still reports
      // the year's result, once, because it takes it from the closing entry
      // instead.
      const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-12-31" });
      const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
      // The profit and loss takes the closing entry back out, so it still
      // reports the year's trading; the balance sheet shows the result has
      // moved out of current-year earnings and into retained earnings.
      expect(pl.netProfitMinor).toBe(profitBefore);
      expect(bs.currentYearEarningsMinor).toBe("0");

      expect(after.closed).toBe(true);
      expect(after.profitForThePeriodMinor).toBe(profitBefore);
      const row = after.movements.find((r) => r.key === "profit_for_period")!;
      expect(row.origin).toBe("posted");
      expect(row.cells["3900"]).toBe(profitBefore);
    });

    it("still ties to the balance sheet, and to the same closing figures", async () => {
      const s = await E();
      const bs = await balanceSheet({ orgId: ORG, entityId: ENT, asOf: "2026-12-31" });
      expect(s.reconciles).toBe(true);
      expect(s.differenceMinor).toBe("0");
      expect(s.foots).toBe(true);
      expect(s.totalByColumnsMinor).toBe(bs.equity.totalMinor);
      expect(s.closing.cells["3000"]).toBe("100000000");
      expect(s.closing.cells["3100"]).toBe("120000");
      expect(s.closing.cells["3200"]).toBe("4000000");
    });

    it("keeps reporting the year's revenue, which the close would otherwise erase", async () => {
      const revenue = noteOf<RevenueNote>(await N(), "revenue");
      expect(revenue.totalMinor).toBe("60000000");
      expect(revenue.byTaxTreatment.find((t) => t.taxCode === "STANDARD_5")!.amountMinor).toBe("40000000");
    });

    it("computes the tax on a closed year from the year's real trading", async () => {
      // This used to read a profit of nil: the closing entry zeroed every
      // income and expense account inside the window the computation reads, so
      // a tax computation run after the close found no profit and charged no
      // tax. The two routes to the year's result now agree.
      const tax = noteOf<TaxNote>(await N(), "corporate_tax");
      expect(tax.computationReadsClosedYear).toBe(false);
      expect(tax.accountingProfitPerComputationMinor).toBe(tax.profitForThePeriodMinor);
      expect(BigInt(tax.profitForThePeriodMinor)).toBeGreaterThan(0n);
      expect(tax.warnings.some((w) => /closing entry/i.test(w))).toBe(false);
    });
  });

  /* ==================================================== the whole envelope */

  describe("statement and notes together", () => {
    it("defaults to the most recent fiscal year the ledger holds", async () => {
      const both = await equityAndNotes({ orgId: ORG, entityId: ENT });
      expect(both.fiscalYear).toBe("2026");
      expect(both.from).toBe("2026-01-01");
      expect(both.to).toBe("2026-12-31");
      expect(both.currency).toBe("AED");
      expect(both.availableYears.map((y) => y.label)).toEqual(["2026"]);
      expect(both.notes).toHaveLength(12);
      expect(both.statement.reconciles).toBe(true);
    });

    it("lists the fiscal years available to report on", async () => {
      const years = await fiscalYearsFor({ orgId: ORG, entityId: ENT });
      expect(years).toHaveLength(1);
      expect(years[0]).toMatchObject({ label: "2026", startsOn: "2026-01-01", endsOn: "2026-12-31" });
    });

    it("refuses a fiscal year this entity does not have", async () => {
      await expect(E(ENT, "2031")).rejects.toThrow(/no fiscal year "2031"/i);
    });

    it("refuses an entity whose books have never been opened", async () => {
      await expect(changesInEquity({ orgId: ORG, entityId: "t-ent-eq-nobody", fiscalYear: "2026" }))
        .rejects.toThrow(/No ledger has been opened/i);
    });
  });
});
