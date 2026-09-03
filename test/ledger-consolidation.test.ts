import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post } from "@/lib/server/ledger/post";
import { profitAndLoss, balanceSheet } from "@/lib/server/ledger/statements";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import {
  createGroup,
  addMember,
  removeMember,
  groupList,
  groupDetail,
  consolidatedStatements,
} from "@/lib/server/ledger/consolidation";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-con";
const PARENT = "t-ent-con-p";
const SUB = "t-ent-con-s";
/** Books opened, nothing ever posted to them. */
const DORMANT = "t-ent-con-d";
/** Books opened in USD, so the group can warn about it. */
const FOREIGN = "t-ent-con-u";
/** No ledger at all. */
const NO_LEDGER = "t-ent-con-x";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "ConsolidationMember" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ConsolidationGroup" WHERE "orgId" = '${ORG}'`),
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

const P = (
  entityId: string,
  entryDate: string,
  lines: { account: string; debit?: number; credit?: number }[],
  memo = "",
) => post({ orgId: ORG, entityId, entryDate, memo, source: "manual", lines });

/**
 * Trade receivables and trade payables are control accounts: the database
 * refuses a manual journal against them. An intragroup invoice reaches them the
 * way a real one would — through a document.
 */
const Doc = (
  entityId: string,
  entryDate: string,
  source: "invoice" | "bill",
  lines: { account: string; debit?: number; credit?: number }[],
  memo = "",
) => post({ orgId: ORG, entityId, entryDate, memo, source, lines });

/** The group as at 28 February — before any intercompany trading. */
const FEB = { from: "2026-01-01", to: "2026-02-28" };
/** March adds one intragroup invoice that matches exactly. */
const MAR = { from: "2026-01-01", to: "2026-03-31" };
/** April adds a second that does not. */
const APR = { from: "2026-01-01", to: "2026-04-30" };

d("consolidation", () => {
  beforeAll(async () => {
    await wipe();

    for (const entityId of [PARENT, SUB, DORMANT]) {
      await openFiscalYear({ orgId: ORG, entityId, label: "2026", startsOn: "2026-01-01" });
      await openBooks({ orgId: ORG, entityId });
    }
    await openFiscalYear({ orgId: ORG, entityId: FOREIGN, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: FOREIGN, functionalCurrency: "USD" });

    // Parent: capital 10,000,000, a 2,000,000 sale, 500,000 of rent.
    await P(PARENT, "2026-01-05", [{ account: "1010", debit: 10_000_000 }, { account: "3000", credit: 10_000_000 }], "Share capital");
    await P(PARENT, "2026-02-10", [{ account: "1010", debit: 2_000_000 }, { account: "4000", credit: 2_000_000 }], "Sales");
    await P(PARENT, "2026-02-15", [{ account: "6100", debit: 500_000 }, { account: "1010", credit: 500_000 }], "Rent");

    // Subsidiary, 75% owned: capital 4,000,000, a 1,000,000 sale, 200,000 of rent.
    await P(SUB, "2026-01-06", [{ account: "1010", debit: 4_000_000 }, { account: "3000", credit: 4_000_000 }], "Share capital");
    await P(SUB, "2026-02-11", [{ account: "1010", debit: 1_000_000 }, { account: "4000", credit: 1_000_000 }], "Sales");
    await P(SUB, "2026-02-16", [{ account: "6100", debit: 200_000 }, { account: "1010", credit: 200_000 }], "Rent");

    // March: the parent invoices the subsidiary 300,000 and it is still unpaid.
    await Doc(PARENT, "2026-03-05", "invoice",
      [{ account: "1100", debit: 300_000 }, { account: "4100", credit: 300_000 }], "Management fee to the subsidiary");
    await Doc(SUB, "2026-03-05", "bill",
      [{ account: "6250", debit: 300_000 }, { account: "2000", credit: 300_000 }], "Management fee from the parent");

    // April: both sides move, but by different amounts, so nothing pairs up.
    await Doc(PARENT, "2026-04-02", "invoice",
      [{ account: "1100", debit: 150_000 }, { account: "4100", credit: 150_000 }], "A third-party sale on credit");
    await Doc(SUB, "2026-04-02", "bill",
      [{ account: "6200", debit: 100_000 }, { account: "2000", credit: 100_000 }], "A third-party bill");

    // Something for the USD member to report.
    await P(FOREIGN, "2026-01-07", [{ account: "1010", debit: 900_000 }, { account: "3000", credit: 900_000 }], "Share capital");

    await createGroup({ orgId: ORG, code: "MAIN", name: "Main group", currency: "AED" });
    await addMember({ orgId: ORG, groupCode: "MAIN", entityId: PARENT, isParent: true });
    await addMember({ orgId: ORG, groupCode: "MAIN", entityId: SUB, ownershipBps: 7500 });
  });

  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ---------------------------------------------------- adding up correctly */

  it("puts every member's 1010 in one row, with a column each", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...FEB });
    const cash = c.assets.lines.filter((l) => l.code === "1010");
    expect(cash).toHaveLength(1);
    // Parent 10,000,000 + 2,000,000 − 500,000; subsidiary 4,000,000 + 1,000,000 − 200,000.
    expect(cash[0].byEntity[PARENT]).toBe("11500000");
    expect(cash[0].byEntity[SUB]).toBe("4800000");
    expect(cash[0].totalMinor).toBe("16300000");
  });

  it("adds the members' columns to exactly the consolidated total, on every line and every section", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...FEB });
    const sections = [c.revenue, c.costOfSales, c.expenses, c.assets, c.liabilities, c.equity];
    expect(sections.some((s) => s.lines.length > 0)).toBe(true);
    for (const s of sections) {
      for (const l of s.lines) {
        const summed = c.members.reduce((a, m) => a + BigInt(l.byEntity[m.entityId] ?? "0"), 0n);
        expect(summed.toString()).toBe(l.totalMinor);
      }
      const sectionSummed = c.members.reduce((a, m) => a + BigInt(s.byEntity[m.entityId] ?? "0"), 0n);
      expect(sectionSummed.toString()).toBe(s.totalMinor);
    }
  });

  it("gives every member an explicit zero on a code it has nothing against", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...MAR });
    const ar = c.assets.lines.find((l) => l.code === "1100")!;
    // Only the parent invoiced anybody. The subsidiary's column is nil, not blank.
    expect(ar.byEntity[SUB]).toBe("0");
    expect(ar.byEntity[PARENT]).toBe("300000");
  });

  it("reports group profit as the sum of the members' own profits", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...FEB });
    const parent = await profitAndLoss({ orgId: ORG, entityId: PARENT, ...FEB });
    const sub = await profitAndLoss({ orgId: ORG, entityId: SUB, ...FEB });
    expect(BigInt(parent.netProfitMinor) + BigInt(sub.netProfitMinor)).toBe(BigInt(c.netProfitMinor));
    expect(c.netProfitMinor).toBe("2300000"); // 1,500,000 + 800,000
  });

  /* ------------------------------------------- control, not proportion */

  it("includes a 75%-owned subsidiary's revenue in full, not at 75%", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...FEB });
    const sales = c.revenue.lines.find((l) => l.code === "4000")!;
    // The subsidiary sold 1,000,000. Proportional consolidation would show
    // 750,000 here, and that is exactly what IFRS 10 does not do.
    expect(sales.byEntity[SUB]).toBe("1000000");
    expect(c.revenue.totalMinor).toBe("3000000");
  });

  it("shows the minority's 25% of net assets as a separate line rather than shrinking the subsidiary", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...FEB });
    const sub = await balanceSheet({ orgId: ORG, entityId: SUB, asOf: FEB.to });
    const netAssets = BigInt(sub.totalAssetsMinor) - BigInt(sub.liabilities.totalMinor);
    expect(netAssets).toBe(4_800_000n);
    expect(c.nonControllingInterestMinor).toBe(((netAssets * 2500n) / 10_000n).toString());
    expect(c.nonControllingInterestMinor).toBe("1200000");
    expect(c.nci).toHaveLength(1);
    expect(c.nci[0]).toMatchObject({ entityId: SUB, ownershipBps: 7500, minorityBps: 2500 });
  });

  it("splits the profit between the parent's owners and the minority without changing the total", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...FEB });
    expect(c.profitAttributableToNciMinor).toBe("200000"); // 25% of the subsidiary's 800,000
    expect(c.profitAttributableToParentMinor).toBe("2100000");
    expect(BigInt(c.profitAttributableToParentMinor) + BigInt(c.profitAttributableToNciMinor))
      .toBe(BigInt(c.netProfitMinor));
  });

  it("takes the non-controlling interest out of equity rather than adding it on top", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...FEB });
    expect(BigInt(c.equityAttributableToParentMinor) + BigInt(c.nonControllingInterestMinor))
      .toBe(BigInt(c.equity.totalMinor));
  });

  it("balances: assets equal liabilities plus parent equity plus the non-controlling interest", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...FEB });
    expect(c.balanced).toBe(true);
    expect(c.differenceMinor).toBe("0");
    expect(c.totalAssetsMinor).toBe("16300000");
    expect(BigInt(c.liabilities.totalMinor) + BigInt(c.equityAttributableToParentMinor) + BigInt(c.nonControllingInterestMinor))
      .toBe(BigInt(c.totalAssetsMinor));
  });

  /* --------------------------------------------- intercompany eliminations */

  it("proposes a matching intercompany receivable and payable, naming both entities", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...MAR });
    expect(c.eliminations).toHaveLength(1);
    expect(c.eliminations[0]).toMatchObject({
      receivableEntityId: PARENT,
      payableEntityId: SUB,
      receivableCode: "1100",
      payableCode: "2000",
      amountMinor: "300000",
      applied: false,
    });
    expect(c.eliminations[0].reason).toMatch(/counterparty/i);
  });

  it("does not apply the proposal by default — the control accounts still stand in full", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...MAR });
    expect(c.eliminationsApplied).toBe(false);
    expect(c.assets.lines.find((l) => l.code === "1100")!.totalMinor).toBe("300000");
    expect(c.liabilities.lines.find((l) => l.code === "2000")!.totalMinor).toBe("300000");
    expect(c.assets.eliminationMinor).toBe("0");
    expect(c.balanced).toBe(true);
  });

  it("applies it when asked, and both control accounts fall by the amount", async () => {
    const before = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...MAR });
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...MAR, applyEliminations: true });
    expect(c.eliminationsApplied).toBe(true);
    expect(c.eliminations[0].applied).toBe(true);

    const ar = c.assets.lines.find((l) => l.code === "1100")!;
    const ap = c.liabilities.lines.find((l) => l.code === "2000")!;
    expect(ar.combinedMinor).toBe("300000");
    expect(ar.eliminationMinor).toBe("300000");
    expect(ar.totalMinor).toBe("0");
    expect(ap.totalMinor).toBe("0");

    // Receivables and payables both come down by the same 300,000, so the
    // group is 300,000 smaller on each side and still balances.
    expect(BigInt(before.totalAssetsMinor) - BigInt(c.totalAssetsMinor)).toBe(300_000n);
    expect(BigInt(before.liabilities.totalMinor) - BigInt(c.liabilities.totalMinor)).toBe(300_000n);
    expect(c.balanced).toBe(true);
    expect(c.differenceMinor).toBe("0");
  });

  it("leaves the members' own columns untouched when it eliminates, so the adjustment is visible", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...MAR, applyEliminations: true });
    const ar = c.assets.lines.find((l) => l.code === "1100")!;
    // The parent really does carry 300,000; the group simply does not.
    expect(ar.byEntity[PARENT]).toBe("300000");
    const summed = c.members.reduce((a, m) => a + BigInt(ar.byEntity[m.entityId] ?? "0"), 0n);
    expect(summed - BigInt(ar.eliminationMinor)).toBe(BigInt(ar.totalMinor));
  });

  it("does not touch group profit when it eliminates a balance sheet pair", async () => {
    const plain = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...MAR });
    const applied = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...MAR, applyEliminations: true });
    expect(applied.netProfitMinor).toBe(plain.netProfitMinor);
  });

  it("warns rather than guesses when the two sides do not match", async () => {
    const c = await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...APR });
    // Parent receivables 450,000, subsidiary payables 400,000 — no exact pair.
    expect(c.eliminations).toHaveLength(0);
    expect(c.warnings.some((w) => w.includes(PARENT) && /overstated/.test(w))).toBe(true);
  });

  /* -------------------------------------------------------------- warnings */

  it("warns that a member reporting in another currency was included with no rate applied", async () => {
    await createGroup({ orgId: ORG, code: "FX", name: "Cross-currency group", currency: "AED" });
    await addMember({ orgId: ORG, groupCode: "FX", entityId: PARENT, isParent: true });
    await addMember({ orgId: ORG, groupCode: "FX", entityId: FOREIGN });

    const c = await consolidatedStatements({ orgId: ORG, groupCode: "FX", ...FEB });
    const w = c.warnings.find((x) => x.includes(FOREIGN))!;
    expect(w).toBeDefined();
    expect(w).toMatch(/USD/);
    expect(w).toMatch(/No rate was applied/i);
  });

  it("warns about a member that has no postings in the period", async () => {
    await createGroup({ orgId: ORG, code: "DORM", name: "Group with a dormant member", currency: "AED" });
    await addMember({ orgId: ORG, groupCode: "DORM", entityId: PARENT, isParent: true });
    await addMember({ orgId: ORG, groupCode: "DORM", entityId: DORMANT });

    const c = await consolidatedStatements({ orgId: ORG, groupCode: "DORM", ...FEB });
    expect(c.warnings.some((w) => w.includes(DORMANT) && /no postings/i.test(w))).toBe(true);
    // And it contributes nothing, so the group reads exactly as the parent alone.
    expect(c.totalAssetsMinor).toBe("11500000");
    expect(c.balanced).toBe(true);
  });

  /* ------------------------------------------------------------- refusals */

  it("refuses to consolidate a group with no parent, listing who is in it", async () => {
    await createGroup({ orgId: ORG, code: "NOPARENT", name: "Orphans", currency: "AED" });
    await addMember({ orgId: ORG, groupCode: "NOPARENT", entityId: SUB, ownershipBps: 6000 });
    await expect(consolidatedStatements({ orgId: ORG, groupCode: "NOPARENT", ...FEB }))
      .rejects.toThrow(new RegExp(`no parent.*${SUB}`, "s"));
  });

  it("refuses a second parent and says which entity already holds the role", async () => {
    await createGroup({ orgId: ORG, code: "TWO", name: "Two parents", currency: "AED" });
    await addMember({ orgId: ORG, groupCode: "TWO", entityId: PARENT, isParent: true });
    await expect(addMember({ orgId: ORG, groupCode: "TWO", entityId: SUB, isParent: true }))
      .rejects.toThrow(new RegExp(`already has a parent, ${PARENT}`));
  });

  it("refuses a member with no ledger, naming the entity", async () => {
    await createGroup({ orgId: ORG, code: "NOBOOKS", name: "Missing books", currency: "AED" });
    await addMember({ orgId: ORG, groupCode: "NOBOOKS", entityId: PARENT, isParent: true });
    await expect(addMember({ orgId: ORG, groupCode: "NOBOOKS", entityId: NO_LEDGER }))
      .rejects.toThrow(new RegExp(`No ledger has been opened for ${NO_LEDGER}`));
  });

  it("refuses an ownership share that nobody could hold, and says what the range is", async () => {
    await expect(addMember({ orgId: ORG, groupCode: "MAIN", entityId: DORMANT, ownershipBps: 12_000 }))
      .rejects.toThrow(/between 1 and 10000/);
    await expect(addMember({ orgId: ORG, groupCode: "MAIN", entityId: DORMANT, ownershipBps: 0 }))
      .rejects.toThrow(/between 1 and 10000/);
  });

  it("refuses to add the same entity twice", async () => {
    await expect(addMember({ orgId: ORG, groupCode: "MAIN", entityId: SUB, ownershipBps: 5000 }))
      .rejects.toThrow(new RegExp(`${SUB} is already a member of MAIN`));
  });

  it("refuses to strand subsidiaries by removing the parent", async () => {
    await expect(removeMember({ orgId: ORG, groupCode: "MAIN", entityId: PARENT }))
      .rejects.toThrow(new RegExp(`is the parent of MAIN.*${SUB}`, "s"));
  });

  it("refuses a group code that does not exist", async () => {
    await expect(consolidatedStatements({ orgId: ORG, groupCode: "GHOST", ...FEB }))
      .rejects.toThrow(/no consolidation group with code GHOST/i);
  });

  it("refuses a duplicate group code, naming the group already using it", async () => {
    await expect(createGroup({ orgId: ORG, code: "MAIN", name: "Another main group" }))
      .rejects.toThrow(/already exists \("Main group"\)/);
  });

  it("carries the statements' own date checks rather than restating them", async () => {
    await expect(consolidatedStatements({ orgId: ORG, groupCode: "MAIN", from: "2026-03-31", to: "2026-03-01" }))
      .rejects.toThrow(/ends before it starts/i);
  });

  /* ------------------------------------------------------- listing a group */

  it("lists groups with their member count and their parent", async () => {
    const list = await groupList({ orgId: ORG });
    const main = list.find((g) => g.code === "MAIN")!;
    expect(main).toMatchObject({ name: "Main group", currency: "AED", memberCount: 2, parentEntityId: PARENT });
    // A group nobody has marked a parent in reports that plainly rather than guessing.
    expect(list.find((g) => g.code === "NOPARENT")!.parentEntityId).toBeNull();
  });

  it("details a group with each member's ownership, currency and whether it has a ledger", async () => {
    const g = await groupDetail({ orgId: ORG, groupCode: "MAIN" });
    expect(g.members[0]).toMatchObject({ entityId: PARENT, isParent: true, ownershipBps: 10_000, currency: "AED", hasLedger: true });
    expect(g.members[1]).toMatchObject({ entityId: SUB, isParent: false, ownershipBps: 7500, hasLedger: true });
  });

  it("drops a member from the figures once it is removed", async () => {
    const before = await consolidatedStatements({ orgId: ORG, groupCode: "DORM", ...FEB });
    expect(before.members.map((m) => m.entityId)).toContain(DORMANT);

    const after = await removeMember({ orgId: ORG, groupCode: "DORM", entityId: DORMANT });
    expect(after.members.map((m) => m.entityId)).not.toContain(DORMANT);

    const c = await consolidatedStatements({ orgId: ORG, groupCode: "DORM", ...FEB });
    expect(c.members.map((m) => m.entityId)).toEqual([PARENT]);
    expect(c.warnings.some((w) => w.includes(DORMANT))).toBe(false);
  });

  it("posts nothing: consolidating leaves every member's ledger exactly as it was", async () => {
    const entries = await db.journalEntry.count({ where: { orgId: ORG } });
    await consolidatedStatements({ orgId: ORG, groupCode: "MAIN", ...MAR, applyEliminations: true });
    expect(await db.journalEntry.count({ where: { orgId: ORG } })).toBe(entries);
    // And the members' own accounts still say what they said before.
    const parent = await balanceSheet({ orgId: ORG, entityId: PARENT, asOf: MAR.to });
    expect(parent.assets.lines.find((l) => l.code === "1100")!.presentedMinor).toBe("300000");
  });
});
