import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  openFund, recordSpend, reimburse, returnCash, closeFund,
  fundState, fundDetail, fundList,
} from "@/lib/server/ledger/petty-cash";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { LedgerError } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-pc";
const ENT = "t-ent-pc";
const OTHER_ORG = "t-org-pc-other";
const OTHER_ENT = "t-ent-pc-other";

/** A real fifteen-digit UAE TRN shape — anything else buys no input tax back. */
const TRN = "100123456700003";

async function wipe() {
  for (const org of [ORG, OTHER_ORG]) {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(`DELETE FROM "PettyCashMovement" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "PettyCashFund" WHERE "orgId" = '${org}'`),
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

/** The journal as the ledger actually holds it: account code → signed minor units. */
async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { lineNo: "asc" } });
  const out: Record<string, bigint> = {};
  for (const r of rows) out[r.account.code] = (out[r.account.code] ?? 0n) + r.txnAmountMinor;
  return out;
}

/** What one account carries across the whole entity, straight off the lines. */
async function balanceOf(code: string, orgId = ORG) {
  const rows = await db.journalLine.findMany({
    where: { orgId, account: { code } },
    select: { txnAmountMinor: true },
  });
  return rows.reduce((a, r) => a + r.txnAmountMinor, 0n);
}

const scope = { orgId: ORG, entityId: ENT };

async function float(code: string, floatMinor: number, over: Partial<{ custodian: string; accountCode: string }> = {}) {
  return openFund({
    ...scope,
    code,
    name: `${code} tin`,
    custodian: over.custodian ?? "Layla Haddad",
    floatMinor,
    accountCode: over.accountCode,
    openedOn: "2026-04-01",
  });
}

async function spend(fundId: string, amountMinor: number, over: Partial<{
  description: string; accountCode: string; vatMinor: number; supplierTrn: string | null; movedOn: string;
}> = {}) {
  return recordSpend({
    ...scope,
    fundId,
    movedOn: over.movedOn ?? "2026-04-05",
    description: over.description ?? "Couriered documents",
    amountMinor,
    accountCode: over.accountCode ?? "6900",
    vatMinor: over.vatMinor ?? 0,
    supplierTrn: over.supplierTrn ?? null,
  });
}

d("petty cash on the imprest system", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
    await openFiscalYear({ orgId: OTHER_ORG, entityId: OTHER_ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: OTHER_ORG, entityId: OTHER_ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("advances the float out of the bank, once", async () => {
    const opened = await float("PC-OPEN", 200_000);
    expect(opened.alreadyOpen).toBe(false);
    expect(opened.reference.startsWith("PC-")).toBe(true);

    // The cash physically left the bank and is now in a tin.
    expect(await linesOf(opened.entryId)).toEqual({
      "1000": 200_000n,   // Dr petty cash — the float
      "1010": -200_000n,  // Cr bank
    });

    const state = await fundState({ ...scope, fundId: opened.fundId });
    expect(state.cashMinor).toBe(200_000n);
    expect(state.unreimbursedMinor).toBe(0n);
    expect(state.imprestMinor).toBe(200_000n);
    expect(state.differenceMinor).toBe(0n);
    expect(state.reconciled).toBe(true);

    // The opening is a movement like any other, and it names its journal entry.
    const detail = await fundDetail({ ...scope, fundId: opened.fundId });
    expect(detail.movements).toHaveLength(1);
    expect(detail.movements[0].kind).toBe("OPENING");
    expect(detail.movements[0].entryId).toBe(opened.entryId);
    expect(detail.movements[0].cashAfterMinor).toBe(200_000n);

    // Opening the same float again would hand out a second tin of cash.
    await expect(float("PC-OPEN", 200_000)).rejects.toThrow(/already exists/i);
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceId: opened.fundId, sourceType: "PETTY_CASH_OPENING" } })).toBe(1);
  });

  it("keeps cash on hand plus receipts equal to the float after every spend", async () => {
    const fund = await float("PC-IDENTITY", 200_000);
    const FLOAT = 200_000n;

    // Three receipts, one after another. The identity is checked after each,
    // because a float that only balances at the end is a float that was wrong
    // in between.
    const amounts = [12_500, 4_075, 63_000];
    let spent = 0n;
    for (const amount of amounts) {
      const r = await spend(fund.fundId, amount, { description: `Receipt for ${amount}` });
      spent += BigInt(amount);
      expect(r.state.cashMinor).toBe(FLOAT - spent);
      expect(r.state.unreimbursedMinor).toBe(spent);
      expect(r.state.cashMinor + r.state.unreimbursedMinor).toBe(FLOAT);
      expect(r.state.differenceMinor).toBe(0n);
    }

    const state = await fundState({ ...scope, fundId: fund.fundId });
    expect(state.receiptCount).toBe(3);
    expect(state.cashMinor).toBe(120_425n);
    expect(state.unreimbursedMinor).toBe(79_575n);
    expect(state.reconciled).toBe(true);

    // And not one of those receipts has touched the general ledger: under the
    // imprest treatment the expenses are posted when the float is reimbursed.
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceId: fund.fundId } })).toBe(1);
    const detail = await fundDetail({ ...scope, fundId: fund.fundId });
    expect(detail.movements.filter((m) => m.kind === "SPEND").every((m) => m.entryId === null)).toBe(true);
    expect(detail.movements.filter((m) => m.outstanding)).toHaveLength(3);
  });

  it("refuses a spend larger than the cash in the tin, and says what is in it", async () => {
    const fund = await float("PC-OVERSPEND", 50_000);
    await spend(fund.fundId, 30_000, { description: "Water delivery" });

    // 20,000 fils left, and someone tries to spend 25,000 of it.
    await expect(spend(fund.fundId, 25_000, { description: "Taxi" }))
      .rejects.toThrow(/only holds 200\.00 in cash/);
    await expect(spend(fund.fundId, 25_000, { description: "Taxi" })).rejects.toThrow(LedgerError);

    // Nothing was recorded, so the float still adds up.
    const state = await fundState({ ...scope, fundId: fund.fundId });
    expect(state.movementCount).toBe(2);
    expect(state.cashMinor).toBe(20_000n);
    expect(state.cashMinor + state.unreimbursedMinor).toBe(50_000n);

    // Spending exactly what is left is fine — it is the tin, emptied.
    const last = await spend(fund.fundId, 20_000, { description: "Stationery" });
    expect(last.state.cashMinor).toBe(0n);
    expect(last.state.unreimbursedMinor).toBe(50_000n);
    expect(last.state.reconciled).toBe(true);
  });

  it("reclaims input VAT only where the receipt shows a supplier TRN", async () => {
    const fund = await float("PC-VAT", 100_000);

    // A tax invoice from a courier: TRN on the paper, so the VAT is recoverable.
    const invoiced = await spend(fund.fundId, 10_500, {
      description: "Courier", accountCode: "6400", vatMinor: 500, supplierTrn: TRN,
    });
    expect(invoiced.recoverableVatMinor).toBe("500");
    expect(invoiced.blockedVatMinor).toBe("0");

    // A car park chit: VAT charged, no TRN, so it is a cost and not a tax asset.
    const chit = await spend(fund.fundId, 5_250, {
      description: "Parking", accountCode: "6900", vatMinor: 250, supplierTrn: null,
    });
    expect(chit.recoverableVatMinor).toBe("0");
    expect(chit.blockedVatMinor).toBe("250");

    // A TRN that is not a TRN is refused rather than quietly ignored: nobody
    // discovers a mistyped TRN afterwards.
    await expect(spend(fund.fundId, 1_000, { description: "Keys cut", vatMinor: 50, supplierTrn: "12345" }))
      .rejects.toThrow(/fifteen digits/i);

    const r = await reimburse({ ...scope, fundId: fund.fundId, movedOn: "2026-04-30" });
    expect(await linesOf(r.entryId)).toEqual({
      "6400": 10_000n,  // Dr travel — the courier at net, its VAT is reclaimable
      "6900": 5_250n,   // Dr other expenses — the chit in full, VAT and all
      "1350": 500n,     // Dr input VAT — only the receipt with a TRN behind it
      "1010": -15_750n, // Cr bank — exactly what the custodian was handed back
    });
    expect(r.recoverableVatMinor).toBe("500");
    expect(r.blockedVatMinor).toBe("250");

    // Tagged, so the VAT return reads it out of the ledger rather than out of a
    // second pass over the tins.
    const vatLine = await db.journalLine.findFirstOrThrow({ where: { entryId: r.entryId, account: { code: "1350" } } });
    expect(vatLine.taxCode).toBe("INPUT_VAT");
  });

  it("restores the float to exactly its imprest amount", async () => {
    const fund = await float("PC-RESTORE", 150_000);
    await spend(fund.fundId, 22_000, { description: "Milk and coffee", accountCode: "6900" });
    await spend(fund.fundId, 8_400, { description: "Taxi", accountCode: "6400" });

    const before = await fundState({ ...scope, fundId: fund.fundId });
    expect(before.cashMinor).toBe(119_600n);

    const r = await reimburse({ ...scope, fundId: fund.fundId, movedOn: "2026-05-02" });
    expect(r.alreadyPosted).toBe(false);
    expect(r.receiptCount).toBe(2);
    // Never a round number, never an amount somebody chose: the receipts.
    expect(r.reimbursedMinor).toBe("30400");
    expect(await linesOf(r.entryId)).toEqual({
      "6900": 22_000n,
      "6400": 8_400n,
      "1010": -30_400n,
    });

    const after = await fundState({ ...scope, fundId: fund.fundId });
    expect(after.cashMinor).toBe(150_000n);       // back to the float, to the fils
    expect(after.unreimbursedMinor).toBe(0n);
    expect(after.receiptCount).toBe(0);
    expect(after.differenceMinor).toBe(0n);

    // A second round of spending starts from a full tin again.
    const next = await spend(fund.fundId, 1_000, { description: "Post", movedOn: "2026-05-03" });
    expect(next.state.cashMinor).toBe(149_000n);
    expect(next.state.unreimbursedMinor).toBe(1_000n);
  });

  it("reimburses a set of receipts once, however many times it is asked", async () => {
    const fund = await float("PC-IDEMPOTENT", 80_000);
    await spend(fund.fundId, 6_000, { description: "Bottled water" });
    const first = await reimburse({ ...scope, fundId: fund.fundId, movedOn: "2026-05-04" });
    expect(first.alreadyPosted).toBe(false);

    // Simulate the process dying between post() and the movement being written:
    // the journal entry exists, the subledger has never heard of it.
    await db.pettyCashMovement.deleteMany({ where: { fundId: fund.fundId, kind: "REIMBURSE" } });

    const retry = await reimburse({ ...scope, fundId: fund.fundId, movedOn: "2026-05-04" });
    expect(retry.alreadyPosted).toBe(true);
    expect(retry.entryId).toBe(first.entryId);
    expect(await db.journalEntry.count({
      where: { orgId: ORG, sourceId: fund.fundId, sourceType: "PETTY_CASH_REIMBURSEMENT" },
    })).toBe(1);

    // Repaired, and the float adds up again.
    const healed = await fundState({ ...scope, fundId: fund.fundId });
    expect(healed.cashMinor).toBe(80_000n);
    expect(healed.reconciled).toBe(true);

    // Asking a third time now has nothing to settle, and says so.
    await expect(reimburse({ ...scope, fundId: fund.fundId, movedOn: "2026-05-04" }))
      .rejects.toThrow(/no receipts waiting to be reimbursed/i);
  });

  it("refuses to reimburse a float that has spent nothing", async () => {
    const fund = await float("PC-NOTHING", 40_000);
    await expect(reimburse({ ...scope, fundId: fund.fundId, movedOn: "2026-05-05" }))
      .rejects.toThrow(/nothing to pay/i);
    // Not a single entry beyond the opening.
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceId: fund.fundId } })).toBe(1);
  });

  it("refuses to hand back more cash than the tin holds", async () => {
    const fund = await float("PC-RETURN", 100_000);
    await spend(fund.fundId, 35_000, { description: "Office plants" });

    // 65,000 in notes and 35,000 in receipts. The receipts are not spendable.
    await expect(returnCash({ ...scope, fundId: fund.fundId, amountMinor: 80_000, movedOn: "2026-05-06" }))
      .rejects.toThrow(/holds 650\.00 in cash/);
    await expect(returnCash({ ...scope, fundId: fund.fundId, amountMinor: 0, movedOn: "2026-05-06" }))
      .rejects.toThrow(LedgerError);

    const r = await returnCash({ ...scope, fundId: fund.fundId, amountMinor: 25_000, movedOn: "2026-05-06" });
    expect(await linesOf(r.entryId)).toEqual({
      "1010": 25_000n,   // Dr bank — the notes went back
      "1000": -25_000n,  // Cr petty cash — the float is that much smaller
    });

    // The float in force came down with the cash, so the identity still holds.
    const state = await fundState({ ...scope, fundId: fund.fundId });
    expect(state.cashMinor).toBe(40_000n);
    expect(state.unreimbursedMinor).toBe(35_000n);
    expect(state.imprestMinor).toBe(75_000n);
    expect(state.differenceMinor).toBe(0n);
    expect(state.floatMinor).toBe(100_000n);  // what it was opened with, unchanged
  });

  it("refuses to close a float with cash or receipts still in it, naming both", async () => {
    const fund = await float("PC-CLOSE", 60_000);
    await spend(fund.fundId, 9_000, { description: "Cleaning supplies", movedOn: "2026-05-10" });

    await expect(closeFund({ ...scope, fundId: fund.fundId }))
      .rejects.toThrow(/510\.00 in cash and 90\.00 in receipts/);

    // Settle it properly: reimburse the paper, then hand the notes back.
    await reimburse({ ...scope, fundId: fund.fundId, movedOn: "2026-05-11" });
    await expect(closeFund({ ...scope, fundId: fund.fundId })).rejects.toThrow(/600\.00 in cash/);

    const back = await returnCash({ ...scope, fundId: fund.fundId, amountMinor: 60_000, movedOn: "2026-05-12" });
    expect(back.state.cashMinor).toBe(0n);
    expect(back.state.imprestMinor).toBe(0n);

    const closed = await closeFund({ ...scope, fundId: fund.fundId });
    expect(closed.status).toBe("closed");
    expect(closed.state.cashMinor).toBe(0n);
    expect(closed.state.unreimbursedMinor).toBe(0n);

    // A closed tin takes nothing further.
    await expect(spend(fund.fundId, 100, { description: "One more" })).rejects.toThrow(/is closed/i);
    await expect(returnCash({ ...scope, fundId: fund.fundId, amountMinor: 100 })).rejects.toThrow(/is closed/i);
  });

  it("never lets one organisation or entity reach another's float", async () => {
    const fund = await float("PC-SCOPED", 30_000);

    // A fund id is not authority: the same id, read as another tenant, is not there.
    await expect(fundState({ orgId: OTHER_ORG, entityId: OTHER_ENT, fundId: fund.fundId }))
      .rejects.toThrow(/does not exist/i);
    await expect(fundState({ orgId: OTHER_ORG, entityId: ENT, fundId: fund.fundId }))
      .rejects.toThrow(/does not exist/i);
    // Right org, wrong entity — a group's other company cannot spend this tin.
    await expect(fundState({ orgId: ORG, entityId: OTHER_ENT, fundId: fund.fundId }))
      .rejects.toThrow(/does not exist/i);
    await expect(recordSpend({
      orgId: ORG, entityId: OTHER_ENT, fundId: fund.fundId,
      movedOn: "2026-05-14", description: "Not ours", amountMinor: 100,
    })).rejects.toThrow(/does not exist/i);
    await expect(reimburse({ orgId: OTHER_ORG, entityId: OTHER_ENT, fundId: fund.fundId }))
      .rejects.toThrow(/does not exist/i);

    // The other org's list is its own, and the same code is free there.
    const theirs = await fundList({ orgId: OTHER_ORG, entityId: OTHER_ENT });
    expect(theirs.funds).toHaveLength(0);
    const mine = await fundList(scope);
    expect(mine.funds.some((f) => f.code === "PC-SCOPED")).toBe(true);
    const clash = await openFund({
      orgId: OTHER_ORG, entityId: OTHER_ENT, code: "PC-SCOPED", name: "Their tin",
      custodian: "Someone else", floatMinor: 10_000, openedOn: "2026-04-01",
    });
    expect(clash.fundId).not.toBe(fund.fundId);
    expect(await balanceOf("1000", OTHER_ORG)).toBe(10_000n);
  });

  it("lists every float with the one figure that matters, and ties to the ledger", async () => {
    const list = await fundList(scope);
    const byCode = new Map(list.funds.map((f) => [f.code, f]));
    expect(byCode.get("PC-CLOSE")?.status).toBe("closed");
    expect(byCode.get("PC-IDENTITY")?.unreimbursedMinor).toBe(79_575n);

    // Every float in this entity adds up, which is what the screen leads with.
    expect(list.funds.every((f) => f.reconciled)).toBe(true);
    expect(list.summary.outOfBalanceCount).toBe(0);
    expect(list.summary.cashMinor + list.summary.unreimbursedMinor).toBe(list.summary.floatMinor);

    // And the general ledger's petty cash account carries the floats in force —
    // the float, not a running cash balance. That is the imprest treatment, and
    // it is the check that the subledger and the ledger have not drifted apart.
    const onAccount = list.funds
      .filter((f) => f.accountCode === "1000")
      .reduce((a, f) => a + (f.openedMinor - f.returnedMinor), 0n);
    expect(await balanceOf("1000")).toBe(onAccount);

    // The receipts still in the tins are exactly what a period-end accrual would
    // be, and none of them has reached an expense account yet.
    expect(list.summary.unreimbursedMinor).toBeGreaterThan(0n);
  });

  it("keeps the trial balance tied after everything above", async () => {
    for (const label of ["2026-04", "2026-05"]) {
      const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: label });
      expect(tb.balanced).toBe(true);
      expect(tb.differenceMinor).toBe(0n);
    }
  });
});
