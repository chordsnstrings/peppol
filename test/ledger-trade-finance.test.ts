import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  issueFacility, drawFacility, settleFacility, closeFacility,
  contingentLiabilities, facilityRegister, isOwnExposure, KINDS,
} from "@/lib/server/ledger/trade-finance";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { ledgerBalances } from "@/lib/server/ledger/balances";
import { CASH_CODES } from "@/lib/server/ledger/cashflow";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-tf";
const ENT = "t-ent-tf";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "TradeFacilityEvent" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "TradeFacility" WHERE "orgId" = '${ORG}'`),
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
    expect(CASH_CODES).not.toContain("1255");
  });
});

d("trade finance", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ ...S, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

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

  it("keeps one organisation out of another's facilities", async () => {
    await expect(drawFacility({
      orgId: "t-org-tf-2", entityId: ENT, reference: "LC-1", amountMinor: 1n, drawnOn: "2026-05-01",
    })).rejects.toThrow(/no facility LC-1/);
  });
});
