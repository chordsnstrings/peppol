import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  addLease, activateLease, runLeasePeriod, payLease, leaseRegister, leaseSchedule,
  presentValue, periodRateBps, buildSchedule, termMonths, exemptionOf,
} from "@/lib/server/ledger/leases";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-lease";
const ENT = "t-ent-lease";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "Lease" WHERE "orgId" = '${ORG}'`),
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

/** A lease's journal lines, summed by account code. */
async function linesOf(entryId: string) {
  const lines = await db.journalLine.findMany({ where: { entryId }, include: { account: true } });
  const by: Record<string, bigint> = {};
  for (const l of lines) by[l.account.code] = (by[l.account.code] ?? 0n) + l.txnAmountMinor;
  return by;
}

const L = (over: Partial<Parameters<typeof addLease>[0]["lease"]> = {}) =>
  addLease({
    orgId: ORG, entityId: ENT,
    lease: {
      code: "LS-001", name: "Warehouse, Al Quoz", lessor: "Al Quoz Properties",
      startsOn: "2026-01-01", endsOn: "2027-12-31",
      paymentMinor: 500_000, discountRateBps: 600, ...over,
    },
  });

/* The lease used throughout: 24 monthly payments of 5,000.00 at 6% a year,
 * which is exactly 50 basis points a month. Its present value is 11,281,433
 * and the figures below were computed from that by hand. */
const PV_24_AT_50BP = 11_281_433n;

describe("present value", () => {
  it("discounts each payment, against a hand-computed figure", () => {
    // 1,000.00 a period for three periods at 1% a period:
    //   1000/1.01 + 1000/1.0201 + 1000/1.030301
    //   = 990.0990… + 980.2960… + 970.5901… = 2,940.9852…
    expect(presentValue({ paymentMinor: 100_000, periods: 3, ratePerPeriodBps: 100 })).toBe(294_099n);
  });

  it("is the undiscounted total at a zero rate", () => {
    expect(presentValue({ paymentMinor: 500_000, periods: 24, ratePerPeriodBps: 0 })).toBe(12_000_000n);
    expect(presentValue({ paymentMinor: 1n, periods: 1, ratePerPeriodBps: 0 })).toBe(1n);
  });

  it("is always less than the payments once a rate is applied", () => {
    const pv = presentValue({ paymentMinor: 500_000, periods: 24, ratePerPeriodBps: 50 });
    expect(pv).toBe(PV_24_AT_50BP);
    expect(pv).toBeLessThan(500_000n * 24n);
  });

  it("refuses a rate the schema would not hold", () => {
    expect(() => presentValue({ paymentMinor: 100, periods: 12, ratePerPeriodBps: -1 })).toThrow(/between 0 and 10000/);
    expect(() => presentValue({ paymentMinor: 100, periods: 12, ratePerPeriodBps: 10_001 })).toThrow(/between 0 and 10000/);
    expect(() => presentValue({ paymentMinor: 100, periods: 12, ratePerPeriodBps: 5.5 })).toThrow(/whole number of basis points/);
  });

  it("refuses a payment of nothing and a term of nothing", () => {
    expect(() => presentValue({ paymentMinor: 0, periods: 12, ratePerPeriodBps: 50 })).toThrow(/more than nothing/);
    expect(() => presentValue({ paymentMinor: 100, periods: 0, ratePerPeriodBps: 50 })).toThrow(/greater than zero/);
  });
});

describe("the rate per period", () => {
  it("divides the annual rate exactly where it can", () => {
    expect(periodRateBps(600, 12)).toBe(50);   // 6% a year is 50bp a month
    expect(periodRateBps(500, 4)).toBe(125);   // 5% a year is 125bp a quarter
    expect(periodRateBps(725, 1)).toBe(725);
  });

  it("rounds to the nearest basis point rather than carrying a float", () => {
    expect(periodRateBps(500, 12)).toBe(42);   // 41.67bp, rounded up
    expect(periodRateBps(700, 12)).toBe(58);   // 58.33bp, rounded down
    expect(periodRateBps(150, 12)).toBe(13);   // 12.5bp, half-up
  });
});

describe("the amortisation schedule", () => {
  const sched = buildSchedule({
    liabilityMinor: PV_24_AT_50BP, rouMinor: PV_24_AT_50BP,
    paymentMinor: 500_000n, ratePerPeriodBps: 50, periods: 24,
  });

  it("ends with a closing liability of exactly zero", () => {
    expect(sched[sched.length - 1].closingLiabilityMinor).toBe(0n);
    // And so does an awkward one, where nothing divides cleanly.
    const odd = buildSchedule({
      liabilityMinor: presentValue({ paymentMinor: 33_333, periods: 7, ratePerPeriodBps: 317 }),
      rouMinor: presentValue({ paymentMinor: 33_333, periods: 7, ratePerPeriodBps: 317 }),
      paymentMinor: 33_333n, ratePerPeriodBps: 317, periods: 7,
    });
    expect(odd[odd.length - 1].closingLiabilityMinor).toBe(0n);
    expect(odd[odd.length - 1].closingRouMinor).toBe(0n);
  });

  it("shrinks the interest period after period", () => {
    for (let i = 1; i < sched.length; i++) {
      expect(sched[i].interestMinor).toBeLessThan(sched[i - 1].interestMinor);
    }
    expect(sched[0].interestMinor).toBe(56_407n);  // 11,281,433 × 0.5%
    expect(sched[1].interestMinor).toBe(54_189n);
  });

  it("depreciates straight-line, independently of the interest", () => {
    const flat = sched.slice(0, sched.length - 1).map((r) => r.rouDepreciationMinor);
    expect(new Set(flat.map(String)).size).toBe(1);   // every period the same
    expect(flat[0]).toBe(470_059n);                   // 11,281,433 / 24
    // The last period takes the remainder, as the last month of an asset's
    // life does — 24 × 470,059 is 17 fils short of the asset.
    expect(sched[23].rouDepreciationMinor).toBe(470_076n);
    expect(sched.reduce((a, r) => a + r.rouDepreciationMinor, 0n)).toBe(PV_24_AT_50BP);
  });

  it("charges total interest equal to the payments less what was recognised", () => {
    const interest = sched.reduce((a, r) => a + r.interestMinor, 0n);
    expect(interest).toBe(500_000n * 24n - PV_24_AT_50BP);
    expect(interest).toBe(718_567n);
  });

  it("front-loads the total charge against straight-line rent", () => {
    // The old operating-lease charge would have been 500,000 a month flat.
    const cost = (r: (typeof sched)[number]) => r.interestMinor + r.rouDepreciationMinor;
    expect(cost(sched[0])).toBeGreaterThan(500_000n);
    expect(cost(sched[23])).toBeLessThan(500_000n);
    // Over the whole term the two come to the same figure, and only there.
    expect(sched.reduce((a, r) => a + cost(r), 0n)).toBe(500_000n * 24n);
  });

  it("refuses a liability that its payments cannot amortise", () => {
    expect(() => buildSchedule({
      liabilityMinor: 9_000_000n, rouMinor: 9_000_000n,
      paymentMinor: 500_000n, ratePerPeriodBps: 50, periods: 3,
    })).toThrow(/does not clear the liability/);
  });
});

describe("the term and the exemption", () => {
  it("counts a term inclusively at both ends", () => {
    expect(termMonths(new Date("2026-01-01"), new Date("2026-12-31"))).toBe(12);
    expect(termMonths(new Date("2026-01-01"), new Date("2027-12-31"))).toBe(24);
    expect(termMonths(new Date("2026-05-15"), new Date("2026-05-31"))).toBe(1);
  });

  it("reads the exemption off the balance sheet rather than off a flag", () => {
    const base = { startsOn: new Date("2026-01-01"), endsOn: new Date("2026-12-31") };
    expect(exemptionOf({ ...base, status: "draft", initialLiabilityMinor: 0n }).exempt).toBe(false);
    expect(exemptionOf({ ...base, status: "active", initialLiabilityMinor: 1n }).exempt).toBe(false);
    expect(exemptionOf({ ...base, status: "active", initialLiabilityMinor: 0n })).toEqual({ exempt: true, reason: "SHORT_TERM" });
    expect(exemptionOf({ status: "active", initialLiabilityMinor: 0n, startsOn: new Date("2026-01-01"), endsOn: new Date("2029-12-31") }))
      .toEqual({ exempt: true, reason: "LOW_VALUE" });
  });
});

d("leases under IFRS 16", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("records the contract without touching the ledger", async () => {
    const l = await L();
    expect(l.code).toBe("LS-001");
    expect(l.status).toBe("draft");
    expect(l.initialLiabilityMinor).toBe(0n);
    expect(l.liabilityMinor).toBe(0n);
    expect(await db.journalEntry.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("refuses a second lease with the same code", async () => {
    await expect(L()).rejects.toThrow(/already on the register/i);
  });

  it("refuses a lease that ends before it starts, a payment of nothing, and an impossible rate", async () => {
    await expect(L({ code: "LS-BAD1", startsOn: "2026-06-01", endsOn: "2026-01-31" }))
      .rejects.toThrow(/has to end after it starts/i);
    await expect(L({ code: "LS-BAD2", paymentMinor: 0 })).rejects.toThrow(/more than nothing/i);
    await expect(L({ code: "LS-BAD3", discountRateBps: 12_000 })).rejects.toThrow(/between 0 and 10000/);
  });

  it("refuses a quarterly lease rather than quietly treating it as monthly", async () => {
    await expect(L({ code: "LS-Q", frequency: "QUARTERLY" })).rejects.toThrow(/built on calendar months/i);
  });

  it("projects an indicative schedule before the lease has commenced", async () => {
    const s = await leaseSchedule({ orgId: ORG, entityId: ENT, leaseCode: "LS-001" });
    expect(s.activated).toBe(false);
    expect(s.note).toMatch(/not commenced/i);
    expect(s.periods).toBe(24);
    expect(s.periodRateBps).toBe(50);
    expect(s.initialLiabilityMinor).toBe(PV_24_AT_50BP.toString());
    expect(s.rows[23].closingLiabilityMinor).toBe("0");
  });

  it("recognises the lease at the present value of the payments", async () => {
    const r = await activateLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-001" });
    expect(r.exempt).toBe(false);
    expect(r.periods).toBe(24);
    expect(r.initialLiabilityMinor).toBe(PV_24_AT_50BP.toString());
    // IFRS 16.23–24: the right-of-use asset starts equal to the liability.
    expect(r.initialRouMinor).toBe(r.initialLiabilityMinor);
    expect(r.reference).toMatch(/^LI-/);

    const by = await linesOf(r.entryId!);
    expect(by["1700"]).toBe(PV_24_AT_50BP);    // Dr right-of-use asset
    expect(by["2600"]).toBe(-PV_24_AT_50BP);   // Cr lease liability
    expect(Object.keys(by).sort()).toEqual(["1700", "2600"]);
  });

  it("will not commence the same lease twice", async () => {
    await expect(activateLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-001" }))
      .rejects.toThrow(/already commenced/i);
  });

  it("refuses a short-term election on a lease of more than twelve months", async () => {
    await L({ code: "LS-002", name: "Forklift" });
    await expect(activateLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-002", exempt: "SHORT_TERM" }))
      .rejects.toThrow(/not a short-term lease/i);
    const still = await db.lease.findFirst({ where: { orgId: ORG, code: "LS-002" } });
    expect(still?.status).toBe("draft");
  });

  it("takes the short-term exemption and puts nothing on the balance sheet", async () => {
    await L({ code: "LS-EXE", name: "Site cabin", startsOn: "2026-01-01", endsOn: "2026-12-31", paymentMinor: 100_000 });
    const r = await activateLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-EXE", exempt: "SHORT_TERM" });
    expect(r.exempt).toBe(true);
    expect(r.exemptionReason).toBe("SHORT_TERM");
    expect(r.entryId).toBeNull();               // nothing recognised, nothing posted
    expect(r.initialLiabilityMinor).toBe("0");

    const row = await db.lease.findFirst({ where: { orgId: ORG, code: "LS-EXE" } });
    expect(row?.status).toBe("active");
    expect(row?.initialRouMinor).toBe(0n);
    // Still only the one inception entry — the exempt lease made none.
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceType: "LEASE_INCEPTION" } })).toBe(1);
  });

  it("charges interest and depreciation as two separate things", async () => {
    const r = await runLeasePeriod({ orgId: ORG, entityId: ENT, period: "2026-01" });
    expect(r.leasesCharged).toBe(2);            // LS-001 and the exempt LS-EXE
    expect(r.interestMinor).toBe("56407");
    expect(r.depreciationMinor).toBe("470059");
    expect(r.reference).toMatch(/^LS-/);

    const by = await linesOf(r.entryId!);
    expect(by["6360"]).toBe(56_407n);           // Dr finance cost
    expect(by["2600"]).toBe(-56_407n);          // Cr lease liability — it unwinds INTO the liability
    expect(by["6600"]).toBe(470_059n);          // Dr depreciation
    expect(by["1700"]).toBe(-470_059n);         // Cr right-of-use asset

    const lease = await db.lease.findFirst({ where: { orgId: ORG, code: "LS-001" } });
    expect(lease?.liabilityMinor).toBe(PV_24_AT_50BP + 56_407n);
    expect(lease?.accumRouDepMinor).toBe(470_059n);
    expect(lease?.chargedTo).toBe("2026-01");
  });

  it("charges an exempt lease to rent, and nothing to the balance sheet", async () => {
    const entry = await db.journalEntry.findFirst({ where: { orgId: ORG, sourceType: "LEASE_RUN", sourceId: "2026-01" } });
    const by = await linesOf(entry!.id);
    expect(by["6100"]).toBe(100_000n);          // Dr rent
    expect(by["1010"]).toBe(-100_000n);         // Cr bank
    // The exempt lease contributed nothing to 2600 or 1700: those carry only
    // LS-001's interest and depreciation.
    expect(by["2600"]).toBe(-56_407n);
    expect(by["1700"]).toBe(-470_059n);
    const rent = await db.journalLine.findFirst({
      where: { entryId: entry!.id, account: { code: "6100" } },
    });
    expect(rent?.memo).toMatch(/exempt, short-term lease of 12 months or less \(IFRS 16\.5\(a\)\)/);
  });

  it("will not charge the same month twice", async () => {
    const r = await runLeasePeriod({ orgId: ORG, entityId: ENT, period: "2026-01" });
    expect(r.leasesCharged).toBe(0);
    expect(r.entryId).toBeNull();
    expect(r.skipped.find((s) => s.code === "LS-001")?.reason).toMatch(/already charged to 2026-01/);
    const lease = await db.lease.findFirst({ where: { orgId: ORG, code: "LS-001" } });
    expect(lease?.liabilityMinor).toBe(PV_24_AT_50BP + 56_407n);   // unchanged
    expect(lease?.accumRouDepMinor).toBe(470_059n);
  });

  it("refuses to silently catch up a missed month", async () => {
    // Charged to 2026-01; jumping to 2026-04 would fold three months into one
    // charge and hide that two runs were never made.
    const r = await runLeasePeriod({ orgId: ORG, entityId: ENT, period: "2026-04" });
    expect(r.leasesCharged).toBe(0);
    expect(r.skipped.find((s) => s.code === "LS-001")?.reason).toMatch(/run the months in between first/);
  });

  it("settles the liability with a payment, and never rent", async () => {
    const before = await db.lease.findFirst({ where: { orgId: ORG, code: "LS-001" } });
    const r = await payLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-001", period: "2026-01" });
    expect(r.alreadyRecorded).toBe(false);
    expect(r.amountMinor).toBe("500000");
    expect(r.liabilityMinor).toBe((before!.liabilityMinor - 500_000n).toString());
    expect(r.reference).toMatch(/^LP-/);

    const by = await linesOf(r.entryId);
    expect(by["2600"]).toBe(500_000n);          // Dr lease liability
    expect(by["1010"]).toBe(-500_000n);         // Cr bank
    // The whole point of IFRS 16: a lease payment is not an expense.
    expect(by["6100"]).toBeUndefined();
    expect(by["6360"]).toBeUndefined();
  });

  it("will not record the same payment twice", async () => {
    const r = await payLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-001", period: "2026-01" });
    expect(r.alreadyRecorded).toBe(true);
    const lease = await db.lease.findFirst({ where: { orgId: ORG, code: "LS-001" } });
    expect(lease?.liabilityMinor).toBe(PV_24_AT_50BP + 56_407n - 500_000n);
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceType: "LEASE_PAYMENT" } })).toBe(1);
  });

  it("refuses a payment larger than what is outstanding", async () => {
    await expect(payLease({
      orgId: ORG, entityId: ENT, leaseCode: "LS-001", period: "2026-02", amountMinor: 99_999_999,
    })).rejects.toThrow(/would take the liability below nil/i);
  });

  it("refuses to pay an exempt lease, which has no liability to discharge", async () => {
    await expect(payLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-EXE", period: "2026-01" }))
      .rejects.toThrow(/exempt .* no liability to discharge/i);
  });

  it("shrinks the interest as the liability comes down, and leaves the depreciation alone", async () => {
    const r = await runLeasePeriod({ orgId: ORG, entityId: ENT, period: "2026-02" });
    expect(r.leasesCharged).toBe(2);
    expect(BigInt(r.interestMinor)).toBeLessThan(56_407n);
    expect(r.interestMinor).toBe("54189");
    expect(r.depreciationMinor).toBe("470059");   // unmoved: it is not interest
  });

  it("keeps the register tied to 2600 and 1700", async () => {
    const reg = await leaseRegister({ orgId: ORG, entityId: ENT });
    expect(reg.ledger.liabilityAgrees).toBe(true);
    expect(reg.ledger.rouAgrees).toBe(true);
    expect(reg.totals.liabilityMinor).toBe((PV_24_AT_50BP + 56_407n - 500_000n + 54_189n).toString());
    expect(reg.totals.rouCarryingMinor).toBe((PV_24_AT_50BP - 940_118n).toString());
    expect(reg.ledger.liabilityMinor).toBe(reg.totals.liabilityMinor);
    expect(reg.ledger.rouMinor).toBe(reg.totals.rouCarryingMinor);

    const one = reg.leases.find((l) => l.code === "LS-001")!;
    expect(one.chargedTo).toBe("2026-02");
    expect(one.periodRateBps).toBe(50);
    expect(one.exempt).toBe(false);
  });

  it("names every exemption in the register, because one nobody sees is one nobody audits", async () => {
    const reg = await leaseRegister({ orgId: ORG, entityId: ENT });
    expect(reg.exemptions).toHaveLength(1);
    expect(reg.exemptions[0].code).toBe("LS-EXE");
    expect(reg.exemptions[0].reason).toBe("SHORT_TERM");
    expect(reg.exemptions[0].note).toMatch(/IFRS 16\.5\(a\)/);

    const exe = reg.leases.find((l) => l.code === "LS-EXE")!;
    expect(exe.exempt).toBe(true);
    expect(exe.liabilityMinor).toBe("0");
    expect(exe.rouCarryingMinor).toBe("0");
    // And it is left out of the reconciliation, which is why that still ties.
    expect(reg.totals.liabilityMinor).not.toBe("0");
  });

  it("ends the posted lease's schedule at exactly nil", async () => {
    const s = await leaseSchedule({ orgId: ORG, entityId: ENT, leaseCode: "LS-001" });
    expect(s.activated).toBe(true);
    expect(s.note).toBeNull();
    expect(s.rows).toHaveLength(24);
    expect(s.rows[23].closingLiabilityMinor).toBe("0");
    expect(s.rows[23].closingRouMinor).toBe("0");
    expect(s.totals.interestMinor).toBe("718567");
    expect(s.totals.paymentsMinor).toBe("12000000");
    // The two charged months are the schedule's first two rows, so the run and
    // the table cannot drift apart.
    expect(s.rows[0].interestMinor).toBe("56407");
    expect(s.rows[1].interestMinor).toBe("54189");
  });

  it("says an exempt lease has no schedule instead of showing a table of zeroes", async () => {
    const s = await leaseSchedule({ orgId: ORG, entityId: ENT, leaseCode: "LS-EXE" });
    expect(s.exempt).toBe(true);
    expect(s.rows).toHaveLength(0);
    expect(s.note).toMatch(/charged straight-line to rent/i);
  });

  it("skips a draft lease with a reason rather than in silence", async () => {
    const r = await runLeasePeriod({ orgId: ORG, entityId: ENT, period: "2026-03" });
    expect(r.skipped.find((s) => s.code === "LS-002")?.reason).toMatch(/still a draft/);
    expect(r.leasesCharged).toBe(2);
  });

  it("winds a lease down to exactly nil over its whole term", async () => {
    await L({
      code: "LS-SHORT", name: "Compressor", lessor: undefined,
      startsOn: "2026-06-01", endsOn: "2026-11-30", paymentMinor: 200_000,
    });
    const a = await activateLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-SHORT" });
    expect(a.periods).toBe(6);

    // Month by month, because the run refuses to skip one — and the payment
    // after the charge, because interest accrues before the payment falls due.
    for (let m = 4; m <= 11; m++) {
      const period = `2026-${String(m).padStart(2, "0")}`;
      await runLeasePeriod({ orgId: ORG, entityId: ENT, period });
      if (m >= 6) await payLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-SHORT", period });
    }

    const lease = await db.lease.findFirst({ where: { orgId: ORG, code: "LS-SHORT" } });
    expect(lease?.liabilityMinor).toBe(0n);                       // nothing owed
    expect(lease?.accumRouDepMinor).toBe(BigInt(a.initialRouMinor)); // fully depreciated
    expect(lease?.status).toBe("ended");

    // Six payments of 2,000.00 cost the initial liability plus the interest,
    // and not a fil more.
    const reg = await leaseRegister({ orgId: ORG, entityId: ENT });
    expect(reg.ledger.liabilityAgrees).toBe(true);
    expect(reg.ledger.rouAgrees).toBe(true);
    expect(reg.leases.find((l) => l.code === "LS-SHORT")!.rouCarryingMinor).toBe("0");
  });

  it("still posts for a lease that commences into a month already run", async () => {
    // LS-002 commenced on 1 January but was recognised only now. Charging its
    // first month must post a real journal — an idempotency key made of the
    // month alone would find January's entry, post nothing, and still advance
    // the register.
    const a = await activateLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-002" });
    const before = await leaseRegister({ orgId: ORG, entityId: ENT });

    const r = await runLeasePeriod({ orgId: ORG, entityId: ENT, period: "2026-01" });
    expect(r.leasesCharged).toBe(1);
    expect(r.entryId).not.toBeNull();
    expect(r.skipped.find((s) => s.code === "LS-001")?.reason).toMatch(/already charged/);

    const by = await linesOf(r.entryId!);
    expect(by["6360"]).toBe(BigInt(r.interestMinor));
    expect(by["6600"]).toBe(BigInt(r.depreciationMinor));

    const after = await leaseRegister({ orgId: ORG, entityId: ENT });
    expect(after.ledger.liabilityAgrees).toBe(true);
    expect(after.ledger.rouAgrees).toBe(true);
    expect(BigInt(after.totals.liabilityMinor) - BigInt(before.totals.liabilityMinor)).toBe(BigInt(r.interestMinor));
    expect(BigInt(a.initialLiabilityMinor)).toBeGreaterThan(0n);
  });

  it("leaves the trial balance tied through recognition, unwinding, depreciation and payment", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-11" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
    const rou = tb.rows.find((x) => x.code === "1700")!;
    const liab = tb.rows.find((x) => x.code === "2600")!;
    expect(rou.balanceMinor).toBeGreaterThan(0n);
    expect(liab.balanceMinor).toBeLessThan(0n);
  });

  it("refuses a period that is not a month", async () => {
    await expect(runLeasePeriod({ orgId: ORG, entityId: ENT, period: "Q1" }))
      .rejects.toThrow(/looks like 2026-03/);
    await expect(payLease({ orgId: ORG, entityId: ENT, leaseCode: "LS-001", period: "2026" }))
      .rejects.toThrow(/looks like 2026-03/);
  });
});
