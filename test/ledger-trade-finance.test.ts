import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  issueFacility, drawFacility, settleFacility, closeFacility,
  contingentLiabilities, facilityRegister, isOwnExposure, KINDS,
} from "@/lib/server/ledger/trade-finance";
import { openBooks, openFiscalYear, UAE_CHART } from "@/lib/server/ledger/setup";
import { setRate } from "@/lib/server/ledger/revaluation";
import { trialBalance } from "@/lib/server/ledger/reports";
import { ledgerBalances } from "@/lib/server/ledger/balances";
import { cashCodesFrom, NEVER_CASH } from "@/lib/server/ledger/cash";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-tf";
const ENT = "t-ent-tf";
const S = { orgId: ORG, entityId: ENT };

/** A second org, so the foreign-currency facilities do not move any figure above. */
const FX_ORG = "t-org-tf-fx";
const FX_ENT = "t-ent-tf-fx";
const FX = { orgId: FX_ORG, entityId: FX_ENT };

async function wipe(org: string) {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "TradeFacilityEvent" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "TradeFacility" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${org}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${org}'`),
    db.$executeRawUnsafe(`DELETE FROM "FxRate" WHERE "orgId" = '${org}'`),
  ]);
}

async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true } });
  const by: Record<string, bigint> = {};
  for (const r of rows) by[r.account.code] = (by[r.account.code] ?? 0n) + r.txnAmountMinor;
  return by;
}

/**
 * The same, but keeping what a foreign-currency line is actually made of: the
 * amount in the currency of the facility, what the ledger carries it at, and
 * the rate between them. A defect that puts USD minor units into an AED book at
 * par is invisible to `linesOf`, because the transaction amount is right.
 */
async function convertedLinesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true } });
  const by: Record<string, { txn: bigint; functional: bigint; currency: string; rate: number }> = {};
  for (const r of rows) {
    const at = by[r.account.code] ?? { txn: 0n, functional: 0n, currency: r.txnCurrency, rate: Number(r.fxRate) };
    by[r.account.code] = {
      txn: at.txn + r.txnAmountMinor,
      functional: at.functional + r.functionalAmountMinor,
      currency: r.txnCurrency,
      rate: Number(r.fxRate),
    };
  }
  return by;
}

const failed = (r: PromiseSettledResult<unknown>) =>
  r.status === "rejected" ? String((r.reason as Error).message) : "";

/**
 * Two callers reaching one facility at the same moment, every time.
 *
 * Firing two requests together does not reliably make them overlap: the client
 * has a small connection pool, and it will happily run one after the other — so
 * the same test caught the lost update when it ran on its own and passed when it
 * ran after thirty others, which is worse than not testing it at all.
 *
 * Holding the facility's row first is what makes the interleaving the defect
 * needs happen on purpose. Both callers read the facility freely, both reach the
 * write, both wait; the lock is released and whatever the module does about two
 * writers is what the assertions see.
 */
async function racingOn<T>(org: string, reference: string, start: () => Promise<T>[]) {
  const held: Promise<PromiseSettledResult<T>[]>[] = [];
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "TradeFacility" WHERE "orgId" = ${org} AND "reference" = ${reference} FOR UPDATE`;
    held.push(Promise.allSettled(start()));
    // Long enough for both callers to have read the facility and to be queued
    // behind the lock on it before it is let go.
    await new Promise((r) => setTimeout(r, 250));
  }, { timeout: 20_000 });
  return held[0];
}

/** What the ledger says was advanced under one facility, from the entries themselves. */
async function owedUnder(facilityId: string) {
  const lines = await db.journalLine.findMany({
    where: { entry: { sourceType: "FACILITY_DRAW", sourceId: facilityId } },
    include: { account: true },
  });
  return -lines.filter((l) => l.account.code === "2470").reduce((a, l) => a + l.txnAmountMinor, 0n);
}

describe("whose exposure is it", () => {
  it("counts an import credit, a guarantee and a trust receipt as the entity's own", () => {
    expect(isOwnExposure("LC_IMPORT")).toBe(true);
    expect(isOwnExposure("BANK_GUARANTEE")).toBe(true);
    expect(isOwnExposure("TRUST_RECEIPT")).toBe(true);
  });

  it("does not count an export credit, which is security the entity holds", () => {
    // It is issued by the buyer's bank in the entity's favour. Counting it as
    // an exposure would report the entity as at risk from its own customer
    // twice — once in receivables and once here.
    expect(isOwnExposure("LC_EXPORT")).toBe(false);
  });

  it("names four kinds", () => {
    expect(Object.keys(KINDS)).toHaveLength(4);
  });
});

describe("restricted cash is not cash", () => {
  it("keeps the margin account out of cash and cash equivalents", () => {
    // Money the bank is holding against a promise cannot be spent. Reporting
    // it as cash tells a reader the business has liquidity it does not have —
    // the same error as counting a post-dated cheque.
    expect(cashCodesFrom(UAE_CHART)).not.toContain("1255");
    // Restricted means restricted whatever the chart is later edited to say.
    expect(NEVER_CASH.has("1255")).toBe(true);
    expect(cashCodesFrom([{ code: "1255", subtype: "BANK" }])).not.toContain("1255");
  });
});

d("trade finance", () => {
  beforeAll(async () => {
    await wipe(ORG);
    await openFiscalYear({ ...S, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
  });
  afterAll(async () => { await wipe(ORG); });

  it("refuses a facility that expires before it is issued", async () => {
    await expect(issueFacility({
      ...S,
      facility: {
        reference: "BAD", kind: "BANK_GUARANTEE", bank: "ENBD", beneficiary: "DEWA",
        amountMinor: 100_000n, issuedOn: "2026-06-01", expiresOn: "2026-01-01",
      },
    })).rejects.toThrow(/protect nobody/);
  });

  it("refuses a margin larger than the facility it secures", async () => {
    await expect(issueFacility({
      ...S,
      facility: {
        reference: "BAD2", kind: "LC_IMPORT", bank: "ENBD", beneficiary: "Supplier",
        amountMinor: 100_000n, marginMinor: 150_000n, issuedOn: "2026-01-01", expiresOn: "2026-12-31",
      },
    })).rejects.toThrow(/holding a deposit, not a margin/);
  });

  it("posts the margin and the commission, and nothing against the face", async () => {
    // A 1,000,000.00 import credit with 200,000.00 of margin and 5,000.00 of
    // commission. The face reaches no account at all.
    const r = await issueFacility({
      ...S,
      facility: {
        reference: "LC-1", kind: "LC_IMPORT", bank: "Emirates NBD", beneficiary: "Shandong Steel",
        amountMinor: 100_000_000n, marginMinor: 20_000_000n, commissionMinor: 500_000n,
        issuedOn: "2026-02-01", expiresOn: "2026-08-31",
      },
    });
    const l = await linesOf(r.entryId!);
    expect(l["1255"]).toBe(20_000_000n);       // margin, restricted
    expect(l["6350"]).toBe(500_000n);          // commission
    expect(l["1010"]).toBe(-20_500_000n);      // both left the bank
    // Nothing anywhere is 100,000,000.
    expect(Object.values(l).some((v) => v === 100_000_000n || v === -100_000_000n)).toBe(false);
    expect(r.note).toContain("the face of it is a disclosure");
  });

  it("posts nothing at all where there is no margin and no commission", async () => {
    const r = await issueFacility({
      ...S,
      facility: {
        reference: "BG-1", kind: "BANK_GUARANTEE", bank: "ADCB", beneficiary: "Dubai Municipality",
        amountMinor: 5_000_000n, issuedOn: "2026-03-01", expiresOn: "2026-09-30",
      },
    });
    expect(r.entryId).toBeNull();
    expect(r.note).toContain("not a liability");
  });

  it("refuses a duplicate reference", async () => {
    await expect(issueFacility({
      ...S,
      facility: {
        reference: "LC-1", kind: "LC_IMPORT", bank: "ENBD", beneficiary: "Someone",
        amountMinor: 1_000n, issuedOn: "2026-04-01", expiresOn: "2026-05-01",
      },
    })).rejects.toThrow(/already a facility LC-1/);
  });

  it("discloses the face as contingent, and recognises none of it", async () => {
    const c = await contingentLiabilities({ ...S, asOf: "2026-04-01" });
    expect(c.totalFacedMinor).toBe(105_000_000n);
    expect(c.totalDrawnMinor).toBe(0n);
    expect(c.totalContingentMinor).toBe(105_000_000n);
    expect(c.basis).toContain("IAS 37.27");

    // And not a fil of it is on the balance sheet.
    const bal = await ledgerBalances({ ...S, codes: ["2470", "1255"] });
    expect(bal.get("2470") ?? 0n).toBe(0n);
    expect(bal.get("1255")).toBe(20_000_000n);
  });

  it("ties the margin on the register to what 1255 holds", async () => {
    const c = await contingentLiabilities({ ...S, asOf: "2026-04-01" });
    expect(c.restrictedCash.marginMinor).toBe(20_000_000n);
    expect(c.restrictedCash.ledgerMinor).toBe(20_000_000n);
    expect(c.restrictedCash.agrees).toBe(true);
  });

  it("moves the debt from the supplier to the bank when the credit is negotiated", async () => {
    const r = await drawFacility({
      ...S, reference: "LC-1", amountMinor: 60_000_000n, drawnOn: "2026-05-15",
    });
    const l = await linesOf(r.entryId);
    expect(l["2000"]).toBe(60_000_000n);      // payable discharged
    expect(l["2470"]).toBe(-60_000_000n);     // owed to the bank instead
    expect(r.availableMinor).toBe(40_000_000n);
    expect(r.note).toContain("has not gone away");
  });

  it("charges a called guarantee to expense, because nothing is received for it", async () => {
    const r = await drawFacility({
      ...S, reference: "BG-1", amountMinor: 1_000_000n, drawnOn: "2026-06-01",
    });
    const l = await linesOf(r.entryId);
    // Not a payable: the entity has paid for somebody's failure to perform.
    expect(l["2000"]).toBeUndefined();
    expect(l["6900"]).toBe(1_000_000n);
    expect(l["2470"]).toBe(-1_000_000n);
    expect(r.note).toContain("getting nothing for the money");
  });

  it("refuses to draw more than the face of the credit", async () => {
    await expect(drawFacility({
      ...S, reference: "LC-1", amountMinor: 50_000_000n, drawnOn: "2026-06-10",
    })).rejects.toThrow(/A bank paying beyond the face of a credit has made a loan/);
  });

  it("takes what has been called off the contingent figure", async () => {
    const c = await contingentLiabilities({ ...S, asOf: "2026-06-30" });
    expect(c.totalDrawnMinor).toBe(61_000_000n);
    expect(c.totalContingentMinor).toBe(44_000_000n);
    // What was called IS a liability now, and it is on the balance sheet.
    const bal = await ledgerBalances({ ...S, codes: ["2470"] });
    expect(bal.get("2470")).toBe(-61_000_000n);
  });

  it("refuses a settlement larger than what the bank advanced", async () => {
    await expect(settleFacility({
      ...S, reference: "BG-1", amountMinor: 2_000_000n, settledOn: "2026-07-01",
    })).rejects.toThrow(/more than it advanced/);
  });

  it("pays the bank back", async () => {
    const r = await settleFacility({
      ...S, reference: "BG-1", amountMinor: 1_000_000n, settledOn: "2026-07-01",
    });
    expect(r.outstandingMinor).toBe(0n);
    const l = await linesOf(r.entryId);
    expect(l["2470"]).toBe(1_000_000n);
    expect(l["1010"]).toBe(-1_000_000n);
  });

  it("refuses to close a facility that still owes the bank", async () => {
    await expect(closeFacility({ ...S, reference: "LC-1", closedOn: "2026-08-31" }))
      .rejects.toThrow(/would leave a debt with no facility behind it/);
  });

  it("releases the margin on closing, whatever was drawn", async () => {
    await settleFacility({ ...S, reference: "LC-1", amountMinor: 60_000_000n, settledOn: "2026-08-15" });
    const r = await closeFacility({ ...S, reference: "LC-1", closedOn: "2026-08-31" });
    expect(r.marginReleasedMinor).toBe(20_000_000n);
    const l = await linesOf(r.entryId!);
    expect(l["1010"]).toBe(20_000_000n);
    expect(l["1255"]).toBe(-20_000_000n);
    const bal = await ledgerBalances({ ...S, codes: ["1255"] });
    expect(bal.get("1255") ?? 0n).toBe(0n);
  });

  it("refuses to close it twice", async () => {
    await expect(closeFacility({ ...S, reference: "LC-1", closedOn: "2026-09-01" }))
      .rejects.toThrow(/already expired/);
  });

  it("drops a facility whose expiry has passed from the disclosure", async () => {
    // BG-1 runs out on 30 September. Nobody can call a credit that has run
    // out, so it stops being an exposure on the day it expires rather than on
    // the day somebody remembers to close it.
    const before = await contingentLiabilities({ ...S, asOf: "2026-09-29" });
    const after = await contingentLiabilities({ ...S, asOf: "2026-10-01" });
    expect(before.totalFacedMinor).toBe(5_000_000n);
    expect(after.totalFacedMinor).toBe(0n);
    expect(after.statement).toContain("no guarantees or letters of credit");
  });

  it("names a facility past its expiry that nobody has closed", async () => {
    const reg = await facilityRegister({ ...S, asOf: "2026-10-01" });
    expect(reg.lapsed).toContain("BG-1");
    expect(reg.lapsedCount).toBe(reg.lapsed.length);
  });

  it("still names the lapsed one when the register is narrowed to another state", async () => {
    // The panel is about facilities the bank is still holding margin against.
    // It used to be filtered out of a page ordered by status, which is how a
    // live undrawn facility fell off first as expired rows accumulated.
    const reg = await facilityRegister({ ...S, asOf: "2026-10-01", status: "expired" });
    expect(reg.facilities.every((f) => f.status === "expired")).toBe(true);
    expect(reg.facilities.some((f) => f.reference === "BG-1")).toBe(false);
    expect(reg.lapsed).toContain("BG-1");
  });

  it("shows only what was asked for when a status is sent", async () => {
    const drawn = await facilityRegister({ ...S, asOf: "2026-10-01", status: "drawn" });
    expect(drawn.facilities.map((f) => f.reference)).toEqual(["BG-1"]);
    expect(drawn.facilities.every((f) => f.status === "drawn")).toBe(true);
  });

  it("keeps an open facility on the register however old it is, and bounds the closed ones", async () => {
    // LC-1 was closed on 31 August 2026 and BG-1 is still open with an expiry
    // of 30 September 2026. Read four years later, the closed one is outside
    // the window and the open one is not — the bank is still holding margin
    // against it and no amount of age makes that stop mattering.
    const far = await facilityRegister({ ...S, asOf: "2030-10-01" });
    const refs = far.facilities.map((f) => f.reference);
    expect(refs).toContain("BG-1");
    expect(refs).not.toContain("LC-1");
    expect(far.since).toBe("2028-10-01");

    // Read close to the events, both are inside the window.
    const near = await facilityRegister({ ...S, asOf: "2026-10-01" });
    expect(near.since).toBe("2024-10-01");
    expect(near.facilities.map((f) => f.reference)).toContain("LC-1");
    expect(near.truncated).toBe(false);
    expect(near.listed).toBe(near.facilities.length);
  });

  it("keeps an export credit out of the entity's own exposure", async () => {
    await issueFacility({
      ...S,
      facility: {
        reference: "LC-EXP-1", kind: "LC_EXPORT", bank: "HSBC", beneficiary: "Our Company",
        amountMinor: 30_000_000n, issuedOn: "2026-10-01", expiresOn: "2027-03-31",
      },
    });
    const c = await contingentLiabilities({ ...S, asOf: "2026-11-01" });
    expect(c.totalFacedMinor).toBe(0n);
    expect(c.heldInFavourMinor).toBe(30_000_000n);
  });

  it("refuses to draw against an export credit, and says where the money belongs", async () => {
    await expect(drawFacility({
      ...S, reference: "LC-EXP-1", amountMinor: 1_000n, drawnOn: "2026-11-01",
    })).rejects.toThrow(/belongs on the receivables screen/);
  });

  it("records a facility cancelled early as cancelled, not as expired", async () => {
    // A guarantee good until 2027 that the entity walks away from in 2026.
    // Without a reason "expire" wins, and the register would then show status
    // "expired" against an expiry date still in the future — which is not an
    // untidiness but the difference between the bank letting it run out and
    // the entity ending it.
    await issueFacility({
      ...S,
      facility: {
        reference: "BG-3", kind: "BANK_GUARANTEE", bank: "Mashreq", beneficiary: "Municipality",
        amountMinor: 4_000_000n, marginMinor: 400_000n,
        issuedOn: "2026-11-01", expiresOn: "2027-10-31",
      },
    });
    const r = await closeFacility({ ...S, reference: "BG-3", closedOn: "2026-11-20", reason: "cancel" });
    expect(r.status).toBe("cancelled");
    expect(r.marginReleasedMinor).toBe(400_000n);

    const reg = await facilityRegister({ ...S, asOf: "2026-12-01", status: "cancelled" });
    const row = reg.facilities.find((f) => f.reference === "BG-3")!;
    expect(row.status).toBe("cancelled");
    // It has not lapsed: its expiry is still ahead of the date it was closed.
    expect(reg.lapsed).not.toContain("BG-3");

    const events = await db.tradeFacilityEvent.findMany({
      where: { orgId: ORG, kind: "cancel" },
    });
    expect(events).toHaveLength(1);
  });

  it("warns about what expires within ninety days", async () => {
    await issueFacility({
      ...S,
      facility: {
        reference: "BG-2", kind: "BANK_GUARANTEE", bank: "ADCB", beneficiary: "RTA",
        amountMinor: 2_500_000n, issuedOn: "2026-11-01", expiresOn: "2026-12-15",
      },
    });
    const c = await contingentLiabilities({ ...S, asOf: "2026-11-01" });
    expect(c.expiringWithin90Days.map((e) => e.reference)).toEqual(["BG-2"]);
    expect(c.expiringWithin90Days[0].contingentMinor).toBe(2_500_000n);
  });

  it("keeps the trial balance tied after everything above", async () => {
    for (const period of ["2026-02", "2026-05", "2026-06", "2026-07", "2026-08", "2026-11"]) {
      const tb = await trialBalance({ ...S, periodLabel: period });
      expect(tb.balanced, period).toBe(true);
    }
  });

  it("refuses a drawing dated after the credit expired, and allows one dated before it", async () => {
    // Its own facility, so nothing above is disturbed: a drawing is a running
    // total on the register and settling it pays the bank rather than undrawing
    // it, so a drawing made here would follow the figures around this file.
    await issueFacility({
      ...S,
      facility: {
        reference: "BG-LAPSED", kind: "BANK_GUARANTEE", bank: "Mashreq",
        beneficiary: "Sharjah Municipality", amountMinor: 2_000_000n,
        issuedOn: "2026-11-01", expiresOn: "2026-11-30",
      },
    });

    // The stored status is still "issued" — nothing moves it, and nothing
    // should have to for this to be refused. contingentLiabilities() has
    // already dropped this facility from the IAS 37 note, because it filters on
    // expiresOn and not on status. A drawing that got past this posted against
    // an exposure the disclosure had let go.
    await expect(drawFacility({
      ...S, reference: "BG-LAPSED", amountMinor: 500_000n, drawnOn: "2026-12-15",
    })).rejects.toThrow(/expired on 2026-11-30 and this is dated 2026-12-15/);

    // And the case that must NOT be refused: the bank paid on the 29th and the
    // paperwork reached the ledger weeks later. Refusing that would only teach
    // people to move the date to one that gets past the guard.
    const ok = await drawFacility({
      ...S, reference: "BG-LAPSED", amountMinor: 500_000n, drawnOn: "2026-11-29",
    });
    expect(ok.entryId).toBeTruthy();
  });

  it("keeps one organisation out of another's facilities", async () => {
    await expect(drawFacility({
      orgId: "t-org-tf-2", entityId: ENT, reference: "LC-1", amountMinor: 1n, drawnOn: "2026-05-01",
    })).rejects.toThrow(/no facility LC-1/);
  });

  /* ------------------------------------------------ two people at one facility */

  it("refuses the second of two drawings made at once instead of over-drawing", async () => {
    // Its own facility: a drawing is a running total, so one made here would
    // follow every figure above it around.
    await issueFacility({
      ...S,
      facility: {
        reference: "LC-RACE", kind: "LC_IMPORT", bank: "ENBD", beneficiary: "Shandong Steel",
        amountMinor: 100_000_000n, issuedOn: "2026-11-01", expiresOn: "2027-06-30",
      },
    });

    // 700,000.00 and 600,000.00 against a 1,000,000.00 credit. Read, check,
    // post and SET meant both checks were made against a drawn figure of zero,
    // so both posted and the second wrote the first out of the register.
    const both = await racingOn(ORG, "LC-RACE", () => [
      drawFacility({ ...S, reference: "LC-RACE", amountMinor: 70_000_000n, drawnOn: "2026-11-05" }),
      drawFacility({ ...S, reference: "LC-RACE", amountMinor: 60_000_000n, drawnOn: "2026-11-05" }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(both.map(failed).join("")).toMatch(/A bank paying beyond the face of a credit has made a loan/);

    const row = await db.tradeFacility.findFirstOrThrow({
      where: { orgId: ORG, entityId: ENT, reference: "LC-RACE" },
    });
    // Whichever won, the register holds exactly that drawing and no more than
    // the face of the credit.
    expect([70_000_000n, 60_000_000n]).toContain(row.drawnMinor);
    expect(row.drawnMinor <= row.amountMinor).toBe(true);

    const events = await db.tradeFacilityEvent.findMany({ where: { facilityId: row.id, kind: "draw" } });
    expect(events).toHaveLength(1);
    expect(events[0].amountMinor).toBe(row.drawnMinor);
    expect(events[0].entryId).toBeTruthy();

    // And the ledger says the bank advanced exactly what the register says was
    // drawn. This is the assertion the lost update actually broke: both
    // drawings reached 2470 and only one of them reached the facility.
    expect(await owedUnder(row.id)).toBe(row.drawnMinor);
  });

  it("gives two drawings of the same amount at the same moment a journal each", async () => {
    // Equal drawings used to compute the same running total, so they built the
    // same externalKey. Either way that landed was wrong: the second post()
    // found the first entry and hung a second register event on it, or lost the
    // race to the unique index and was refused as though the bank had not paid.
    // The running total now comes from the increment, so each drawing has one.
    await issueFacility({
      ...S,
      facility: {
        reference: "LC-TWIN", kind: "LC_IMPORT", bank: "ADCB", beneficiary: "Hebei Wire",
        amountMinor: 100_000_000n, issuedOn: "2026-11-01", expiresOn: "2027-06-30",
      },
    });

    const both = await racingOn(ORG, "LC-TWIN", () => [
      drawFacility({ ...S, reference: "LC-TWIN", amountMinor: 20_000_000n, drawnOn: "2026-11-06" }),
      drawFacility({ ...S, reference: "LC-TWIN", amountMinor: 20_000_000n, drawnOn: "2026-11-06" }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(2);

    const row = await db.tradeFacility.findFirstOrThrow({
      where: { orgId: ORG, entityId: ENT, reference: "LC-TWIN" },
    });
    expect(row.drawnMinor).toBe(40_000_000n);

    const events = await db.tradeFacilityEvent.findMany({ where: { facilityId: row.id, kind: "draw" } });
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.entryId)).size).toBe(2);
    expect(await owedUnder(row.id)).toBe(40_000_000n);
  });

  it("refuses the second of two settlements made at once", async () => {
    await issueFacility({
      ...S,
      facility: {
        reference: "LC-PAID", kind: "LC_IMPORT", bank: "Mashreq", beneficiary: "Jiangsu Tube",
        amountMinor: 50_000_000n, issuedOn: "2026-11-01", expiresOn: "2027-06-30",
      },
    });
    await drawFacility({ ...S, reference: "LC-PAID", amountMinor: 30_000_000n, drawnOn: "2026-11-07" });

    // 200,000.00 twice against 300,000.00 advanced. Both read the whole advance
    // as outstanding, so both used to pay the bank.
    const both = await racingOn(ORG, "LC-PAID", () => [
      settleFacility({ ...S, reference: "LC-PAID", amountMinor: 20_000_000n, settledOn: "2026-11-20" }),
      settleFacility({ ...S, reference: "LC-PAID", amountMinor: 20_000_000n, settledOn: "2026-11-20" }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(both.map(failed).join("")).toMatch(/Paying a bank more than it advanced/);

    const settlements = await db.tradeFacilityEvent.findMany({
      where: { orgId: ORG, facility: { reference: "LC-PAID" }, kind: "settle" },
    });
    expect(settlements).toHaveLength(1);
  });

  it("gives the drawing back when the journal behind it is refused", async () => {
    // The register moves before the journal is posted, so a refusal from post()
    // has to undo it. 2027 has no accounting period, and a facility left
    // showing a drawing no entry supports would be settled off that figure.
    const before = await db.tradeFacility.findFirstOrThrow({
      where: { orgId: ORG, entityId: ENT, reference: "LC-RACE" },
    });
    await expect(drawFacility({
      ...S, reference: "LC-RACE", amountMinor: 1_000_000n, drawnOn: "2027-01-05",
    })).rejects.toThrow(/No accounting period covers 2027-01-05/);

    const after = await db.tradeFacility.findFirstOrThrow({ where: { id: before.id } });
    expect(after.drawnMinor).toBe(before.drawnMinor);
    const events = await db.tradeFacilityEvent.findMany({ where: { facilityId: before.id, kind: "draw" } });
    expect(events).toHaveLength(1);
    expect(events.every((e) => e.entryId !== null)).toBe(true);
  });

  it("keeps the trial balance tied after the drawings above", async () => {
    const tb = await trialBalance({ ...S, periodLabel: "2026-11" });
    expect(tb.balanced).toBe(true);
  });
});

/* -------------------------------------------- a facility that is not in dirhams */

d("trade finance in another currency", () => {
  beforeAll(async () => {
    await wipe(FX_ORG);
    await openFiscalYear({ ...FX, label: "2026", startsOn: "2026-01-01" });
    await openBooks(FX);
    // The rate on the day the credit was opened, the day it was drawn, and a
    // later one that must not be reached back for.
    await setRate({ ...FX, currency: "USD", rate: "3.6725", rateDate: "2026-01-01" });
    await setRate({ ...FX, currency: "USD", rate: "3.6700", rateDate: "2026-05-01" });
    await setRate({ ...FX, currency: "USD", rate: "4.0000", rateDate: "2026-06-01" });
  });
  afterAll(async () => { await wipe(FX_ORG); await db.$disconnect(); });

  it("posts a dollar credit in dollars, at the rate on the day it was opened", async () => {
    // USD 100,000.00 with a 10% margin and USD 500.00 of commission. Every line
    // used to reach post() with no currency and no rate, which is a rate of 1:
    // account 1255 was debited AED 10,000.00 of restricted cash the entity does
    // not hold, and the bank was credited money it never took.
    const r = await issueFacility({
      ...FX,
      facility: {
        reference: "USD-LC-1", kind: "LC_IMPORT", bank: "Emirates NBD", beneficiary: "Shandong Steel",
        currency: "USD", amountMinor: 10_000_000n, marginMinor: 1_000_000n, commissionMinor: 50_000n,
        issuedOn: "2026-02-01", expiresOn: "2026-12-31",
      },
    });

    const l = await convertedLinesOf(r.entryId!);
    expect(l["1255"].currency).toBe("USD");
    expect(l["1255"].txn).toBe(1_000_000n);          // USD 10,000.00 of margin
    expect(l["1255"].functional).toBe(3_672_500n);   // AED 36,725.00, at 3.6725
    expect(l["1255"].rate).toBeCloseTo(3.6725, 8);
    expect(l["6350"].txn).toBe(50_000n);             // USD 500.00 of commission
    expect(l["6350"].functional).toBe(183_625n);
    expect(l["1010"].txn).toBe(-1_050_000n);
    expect(l["1010"].functional).toBe(-3_856_125n);

    // What the ledger carries is dirhams, and it is not the dollar figure.
    const bal = await ledgerBalances({ ...FX, codes: ["1255"] });
    expect(bal.get("1255")).toBe(3_672_500n);
  });

  it("draws at the rate on the day of the drawing, not at a later one", async () => {
    // Drawn on 15 May. The rate on file for 1 June is 4.0000 and must not be
    // reached back for: it would restate the drawing with information nobody
    // had when the bank paid.
    const r = await drawFacility({
      ...FX, reference: "USD-LC-1", amountMinor: 5_000_000n, drawnOn: "2026-05-15",
    });
    const l = await convertedLinesOf(r.entryId);
    expect(l["2000"].currency).toBe("USD");
    expect(l["2000"].txn).toBe(5_000_000n);          // USD 50,000.00
    expect(l["2000"].functional).toBe(18_350_000n);  // AED 183,500.00, at 3.6700
    expect(l["2000"].rate).toBeCloseTo(3.67, 8);
    expect(l["2470"].txn).toBe(-5_000_000n);
    expect(l["2470"].functional).toBe(-18_350_000n);
  });

  it("refuses to post a facility in a currency with no rate on file, and records nothing", async () => {
    await expect(issueFacility({
      ...FX,
      facility: {
        reference: "EUR-LC-1", kind: "LC_IMPORT", bank: "HSBC", beneficiary: "Ruhr Stahl",
        currency: "EUR", amountMinor: 5_000_000n, marginMinor: 500_000n,
        issuedOn: "2026-03-01", expiresOn: "2026-12-31",
      },
    })).rejects.toThrow(/no EUR rate is on file as at 2026-03-01/);

    // Not recorded and then found unpostable: the reference is still free for
    // the facility somebody is actually trying to open.
    const row = await db.tradeFacility.findFirst({
      where: { orgId: FX_ORG, entityId: FX_ENT, reference: "EUR-LC-1" },
    });
    expect(row).toBeNull();
  });

  it("refuses a currency whose minor unit is a different size from the book's", async () => {
    // A rate in this ledger multiplies minor units directly, so a three-decimal
    // currency against a two-decimal book is out by a factor of ten — and the
    // entry, the trial balance and the note would all agree with each other
    // about it.
    await setRate({ ...FX, currency: "KWD", rate: "11.9000", rateDate: "2026-01-01" });
    await expect(issueFacility({
      ...FX,
      facility: {
        reference: "KWD-BG-1", kind: "BANK_GUARANTEE", bank: "NBK", beneficiary: "Kuwait Municipality",
        currency: "KWD", amountMinor: 1_000_000n, marginMinor: 100_000n,
        issuedOn: "2026-03-01", expiresOn: "2026-12-31",
      },
    })).rejects.toThrow(/out by a factor of 10/);
  });

  it("states the note in the currency the books are kept in", async () => {
    const c = await contingentLiabilities({ ...FX, asOf: "2026-06-30" });
    expect(c.functionalCurrency).toBe("AED");

    // The exposure at the closing rate of 4.0000: USD 100,000.00 promised, USD
    // 50,000.00 of it called.
    expect(c.totalFacedMinor).toBe(40_000_000n);
    expect(c.totalDrawnMinor).toBe(20_000_000n);
    expect(c.totalContingentMinor).toBe(20_000_000n);

    // The margin at the rate it was paid at, which is what 1255 carries. At the
    // closing rate it would read AED 40,000.00 and report an exchange
    // difference as a missing deposit.
    expect(c.restrictedCash.marginMinor).toBe(3_672_500n);
    expect(c.restrictedCash.ledgerMinor).toBe(3_672_500n);
    expect(c.restrictedCash.agrees).toBe(true);
    expect(c.untranslated).toHaveLength(0);
  });

  it("leaves a facility it cannot translate out of the figures and says so", async () => {
    // Recorded, because a register of what the banks have issued does not
    // depend on the ledger being able to convert it — and named, because a
    // total that quietly drops an exposure is not a smaller number but a wrong
    // one.
    await issueFacility({
      ...FX,
      facility: {
        reference: "KWD-BG-2", kind: "BANK_GUARANTEE", bank: "NBK", beneficiary: "Kuwait Municipality",
        currency: "KWD", amountMinor: 1_000_000n,
        issuedOn: "2026-07-01", expiresOn: "2026-12-31",
      },
    });

    const c = await contingentLiabilities({ ...FX, asOf: "2026-07-31" });
    expect(c.untranslated.map((u) => u.reference)).toEqual(["KWD-BG-2"]);
    expect(c.untranslated[0].reason).toMatch(/factor of 10/);
    expect(c.statement).toContain("KWD-BG-2");
    // Its face is nowhere in the totals, which are still only the dollar credit.
    expect(c.totalFacedMinor).toBe(40_000_000n);
  });

  it("keeps the trial balance tied with two currencies in it", async () => {
    for (const period of ["2026-02", "2026-05"]) {
      const tb = await trialBalance({ ...FX, periodLabel: period });
      expect(tb.balanced, period).toBe(true);
    }
  });
});
