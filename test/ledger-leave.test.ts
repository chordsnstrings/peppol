import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  leaveEntitlement,
  leaveBalance,
  leaveRegister,
  leaveRecords,
  recordLeave,
  encashLeave,
  provisionForPeriod,
} from "@/lib/server/ledger/leave";
import { addEmployee } from "@/lib/server/ledger/payroll";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { post } from "@/lib/server/ledger/post";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-leave";
const ENT = "t-ent-leave";
/** A second entity inside the SAME org, which is the harder isolation test. */
const ENT2 = "t-ent-leave-other";
/** And a second org, to prove nothing here is readable by entity id alone. */
const ORG2 = "t-org-leave-other";

async function wipe() {
  for (const org of [ORG, ORG2]) {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      // Leave records first: the cascade to Employee is a foreign key, and
      // foreign keys are exactly what the replica role has just switched off.
      db.$executeRawUnsafe(`DELETE FROM "LeaveRecord" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "LeaveProvision" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "Payslip" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "Employee" WHERE "orgId" = '${org}'`),
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

/** Everything the ledger holds on one account, across every posted entry. */
async function accountTotal(code: string) {
  const account = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code } });
  const lines = await db.journalLine.findMany({
    where: { orgId: ORG, accountId: account!.id, entry: { status: "posted" } },
    select: { functionalAmountMinor: true },
  });
  return lines.reduce((a, l) => a + l.functionalAmountMinor, 0n);
}

const plusDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

/* ------------------------------------------------------------------------- */

describe("annual leave earned (Federal Decree-Law 33/2021, Article 29)", () => {
  const JOINED = "2025-01-01";
  const at = (days: number, over?: Partial<{ leaveDaysPerYear: number; unpaidTenth: number; leftOn: string }>) =>
    leaveEntitlement({
      employee: { joinedOn: JOINED, ...over },
      asOf: plusDays(JOINED, days),
    });

  it("gives nothing at all below six months of service", () => {
    expect(at(0)).toBe(0);
    // 182 days is 5.98 twelfths of a 365-day year, and Article 29(1)(b) opens
    // at six months exactly. This is a cliff in the law, not a rounding edge.
    expect(at(182)).toBe(0);
  });

  it("gives two working days a month between six months and a year", () => {
    // 183 days is the first day six twelfths of the year are complete: 6 × 2 = 12.
    expect(at(183)).toBe(120);
    // Still six months' worth at 212 days; the seventh month completes at 213.
    expect(at(212)).toBe(120);
    expect(at(213)).toBe(140);
    // Eleven months is as far as this band reaches: 11 × 2 = 22 days.
    expect(at(364)).toBe(220);
  });

  it("gives thirty calendar days once a year of service is complete", () => {
    // The step from 22 days to 30 is Article 29's, between its two limbs, and
    // is not smoothed: pro-rating across it would pay eleven months more than
    // Article 29(1)(b) allows.
    expect(at(365)).toBe(300);
    expect(at(365)).toBeGreaterThan(at(364));
    // Two years earns two years' worth, to the day.
    expect(at(730)).toBe(600);
  });

  it("pro-rates a part year, in tenths of a day", () => {
    // 547 days × 30 / 365 = 44.958…, and a tenth is as fine as leave is kept.
    expect(at(547)).toBe(449);
    expect(at(547)).toBeGreaterThan(at(365));
    expect(at(547)).toBeLessThan(at(730));
  });

  it("gives a contract that improves on the law what the contract says", () => {
    expect(at(365, { leaveDaysPerYear: 45 })).toBe(450);
    expect(at(730, { leaveDaysPerYear: 45 })).toBe(900);
    // …and refuses one that does not. Article 29 is a floor, not a default.
    expect(() => at(365, { leaveDaysPerYear: 21 })).toThrow(/cannot fall below it/);
  });

  it("earns nothing for a month of unpaid leave", () => {
    // Thirty days unpaid inside two years: 730 − 30 = 700 days of service,
    // 700 × 30 / 365 = 57.53 days rather than 60. The 2.5 days lost are exactly
    // what the unpaid month would have earned.
    expect(at(730, { unpaidTenth: 300 })).toBe(575);
    expect(at(730) - at(730, { unpaidTenth: 300 })).toBe(25);
    // And inside the first year it can push somebody back under the twelve-month
    // line into the two-days-a-month band: 335 days of service is 11 months.
    expect(at(365, { unpaidTenth: 300 })).toBe(220);
  });

  it("stops service on the day the employee left", () => {
    expect(at(730, { leftOn: plusDays(JOINED, 365) })).toBe(300);
    expect(at(730, { leftOn: plusDays(JOINED, 365) })).toBe(at(365));
  });
});

/* ------------------------------------------------------------------------- */

d("annual leave and the untaken-leave provision", () => {
  /*
   * Three employees, and every figure below is hand-computed from them.
   *
   *   E-001  joined 2025-01-01, basic 9,000 + housing 6,000 + transport 1,000.
   *          Leave pay is basic + housing = 15,000, so a day is 500.00 and a
   *          TENTH of a day is exactly 50.00 — 5,000 fils.
   *   E-002  joined 2026-01-01, basic 6,000 + housing 3,000 = 9,000, so a day
   *          is 300.00 and a tenth is 3,000 fils.
   *   E-003  joined 2025-01-01, same pay as E-001, but a contract giving 45
   *          days a year instead of the statutory 30.
   *
   * Days of service from 2025-01-01: 454 to 31 Mar 2026, 484 to 30 Apr,
   * 499 to 15 May, 515 to 31 May, 545 to 30 Jun, 576 to 31 Jul. From
   * 2026-01-01: 89, 119, 150, 180 to the same month ends.
   */
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-01-01", source: "manual", memo: "Capital introduced",
      lines: [{ account: "1010", debit: 50_000_000 }, { account: "3000", credit: 50_000_000 }],
    });

    await addEmployee({
      orgId: ORG, entityId: ENT,
      employee: {
        code: "E-001", name: "Ahmed Al Mansouri", joinedOn: "2025-01-01",
        basicMinor: 900_000, housingMinor: 600_000, transportMinor: 100_000,
      },
    });
    await addEmployee({
      orgId: ORG, entityId: ENT,
      employee: { code: "E-002", name: "Fatima Khan", joinedOn: "2026-01-01", basicMinor: 600_000, housingMinor: 300_000 },
    });
    await addEmployee({
      orgId: ORG, entityId: ENT,
      employee: { code: "E-003", name: "Priya Nair", joinedOn: "2025-01-01", basicMinor: 900_000, housingMinor: 600_000 },
    });
    // The payroll module has no opinion about leave, so the better-than-statutory
    // contract is set on the record directly.
    await db.employee.updateMany({
      where: { orgId: ORG, entityId: ENT, code: "E-003" },
      data: { leaveDaysPerYear: 45 },
    });

    // The second org's employee shares a code with the first's on purpose.
    await addEmployee({
      orgId: ORG2, entityId: ENT2,
      employee: { code: "E-001", name: "Someone Else Entirely", joinedOn: "2025-01-01", basicMinor: 100_000 },
    });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("values a day at basic plus housing over thirty, and leaves transport out", async () => {
    const b = await leaveBalance({ orgId: ORG, entityId: ENT, code: "E-001", asOf: "2026-03-31" });
    // 900,000 + 600,000 = 1,500,000. The 100,000 of transport reimburses a cost
    // that is not incurred while on leave, so it does not enter, exactly as it
    // does not enter the Article 51 gratuity.
    expect(b.leavePayBaseMinor).toBe("1500000");
    expect(b.dailyRateMinor).toBe("50000");
    expect(b.serviceDays).toBe(454);
    expect(b.earnedTenth).toBe(373); // 454 × 30 / 365 = 37.31 days
    expect(b.balanceTenth).toBe(373);
    expect(b.valueMinor).toBe("1865000"); // 37.3 days × 500.00
  });

  it("records leave in the calendar days between the dates", async () => {
    const r = await recordLeave({
      orgId: ORG, entityId: ENT, code: "E-001",
      startsOn: "2026-02-01", endsOn: "2026-02-10", note: "Family visit",
    });
    // Ten calendar days, weekend included: Article 29 grants calendar days, and
    // counting working days would quietly turn 30 days into six working weeks.
    expect(r.daysTenth).toBe(100);
    expect(r.days).toBe("10.0");
    expect(r.kind).toBe("ANNUAL");
    expect(r.paid).toBe(true);
  });

  it("takes leave taken off the balance", async () => {
    const b = await leaveBalance({ orgId: ORG, entityId: ENT, code: "E-001", asOf: "2026-03-31" });
    expect(b.earnedTenth).toBe(373);
    expect(b.takenTenth).toBe(100);
    expect(b.balanceTenth).toBe(273);
    expect(b.valueMinor).toBe("1365000"); // 27.3 days × 500.00
  });

  it("refuses annual leave that overlaps annual leave already recorded, by name", async () => {
    await expect(recordLeave({
      orgId: ORG, entityId: ENT, code: "E-001", startsOn: "2026-02-05", endsOn: "2026-02-12",
    })).rejects.toThrow(/already has annual leave from 2026-02-01 to 2026-02-10/);
  });

  it("keeps sick leave out of the annual leave balance (Article 31)", async () => {
    const before = await leaveBalance({ orgId: ORG, entityId: ENT, code: "E-001", asOf: "2026-03-31" });
    await recordLeave({
      orgId: ORG, entityId: ENT, code: "E-001", kind: "SICK",
      startsOn: "2026-03-16", endsOn: "2026-03-20", note: "Signed off",
    });
    const after = await leaveBalance({ orgId: ORG, entityId: ENT, code: "E-001", asOf: "2026-03-31" });
    expect(after.otherTenth).toBe(50);
    expect(after.takenTenth).toBe(before.takenTenth); // it is not annual leave
    expect(after.balanceTenth).toBe(before.balanceTenth);
  });

  it("shows a negative balance rather than clamping it to nil", async () => {
    // Fatima joined on 1 January and takes five days in March, two months in.
    // She has earned nothing at all yet — Article 29 gives nothing below six
    // months — so she is five days overdrawn, and that is a real position.
    await recordLeave({ orgId: ORG, entityId: ENT, code: "E-002", startsOn: "2026-03-02", endsOn: "2026-03-06" });
    const b = await leaveBalance({ orgId: ORG, entityId: ENT, code: "E-002", asOf: "2026-03-31" });
    expect(b.earnedTenth).toBe(0);
    expect(b.takenTenth).toBe(50);
    expect(b.balanceTenth).toBe(-50);
    expect(b.valueMinor).toBe("-150000"); // 5 days × 300.00, owed the other way
    // It is not provided for, though: what she owes the employer is a debt from
    // her, not a smaller liability to everybody else.
    expect(b.provisionTenth).toBe(0);
    expect(b.provisionMinor).toBe("0");
  });

  it("refuses more days than will fit between the dates", async () => {
    await expect(recordLeave({
      orgId: ORG, entityId: ENT, code: "E-001",
      startsOn: "2026-08-01", endsOn: "2026-08-02", daysTenth: 50,
    })).rejects.toThrow(/will not fit between 2026-08-01 and 2026-08-02/);
  });

  it("will not let leave be paid out by writing a record", async () => {
    await expect(recordLeave({
      orgId: ORG, entityId: ENT, code: "E-001", kind: "ENCASHED",
      startsOn: "2026-04-01", endsOn: "2026-04-01",
    })).rejects.toThrow(/has to reach the ledger at the same time/);
  });

  it("posts the first provision as the whole position", async () => {
    const r = await provisionForPeriod({ orgId: ORG, entityId: ENT, period: "2026-03" });
    // 27.3 days × 500.00 = 13,650.00 for Ahmed, 55.9 × 500.00 = 27,950.00 for
    // Priya on her 45-day contract, and nothing for Fatima, who is overdrawn.
    expect(r.employees).toBe(3);
    expect(r.daysTenth).toBe(832);
    expect(r.balanceMinor).toBe("4160000");
    expect(r.openingMinor).toBe("0");
    expect(r.chargeMinor).toBe("4160000");
    expect(r.unchanged).toBe(false);
    expect(r.reference).toMatch(/^PR-/);

    const by = await linesOf(r.entryId!);
    expect(by["6000"]).toBe(4_160_000n);   // Dr salaries — leave pay is wages
    expect(by["2260"]).toBe(-4_160_000n);  // Cr the untaken leave provision
    expect(Object.keys(by).sort()).toEqual(["2260", "6000"]);

    const row = await db.leaveProvision.findFirst({ where: { orgId: ORG, entityId: ENT, period: "2026-03" } });
    expect(row?.balanceMinor).toBe(4_160_000n);
    expect(row?.daysTenth).toBe(832);
    expect(row?.entryId).toBe(r.entryId);
  });

  it("posts nothing at all when the position has not moved", async () => {
    const again = await provisionForPeriod({ orgId: ORG, entityId: ENT, period: "2026-03" });
    expect(again.unchanged).toBe(true);
    expect(again.chargeMinor).toBe("0");
    expect(again.balanceMinor).toBe("4160000");
    expect(again.message).toMatch(/nothing to post/);

    expect(await accountTotal("2260")).toBe(-4_160_000n); // still one charge, not two
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceType: "LEAVE_PROVISION" } })).toBe(1);
  });

  it("ties the register to 2260 once the month is provided for", async () => {
    const reg = await leaveRegister({ orgId: ORG, entityId: ENT, asOf: "2026-03-31" });
    expect(reg.employees.map((e) => e.code)).toEqual(["E-001", "E-002", "E-003"]);
    expect(reg.totals.provisionMinor).toBe("4160000");
    expect(reg.ledger.balanceMinor).toBe("4160000");
    expect(reg.ledger.differenceMinor).toBe("0");
    expect(reg.ledger.agrees).toBe(true);
    // The five days Fatima is overdrawn are stated on their own rather than
    // netted against the other two.
    expect(reg.totals.advanceTenth).toBe(-50);
    expect(reg.totals.advanceMinor).toBe("-150000");
    expect(reg.totals.netMinor).toBe("4010000");
    expect(reg.lastProvision?.period).toBe("2026-03");
  });

  it("posts only the movement for the next month", async () => {
    const r = await provisionForPeriod({ orgId: ORG, entityId: ENT, period: "2026-04" });
    // 39.7 days for Ahmed (484 × 30 / 365, less the 10 taken) and 59.6 for
    // Priya (484 × 45 / 365): 19,850.00 + 29,800.00 = 44,650.00.
    expect(r.balanceMinor).toBe("4465000");
    expect(r.openingMinor).toBe("4160000");
    expect(r.chargeMinor).toBe("305000");
    // Exactly the difference between the two positions, and nothing else.
    expect(BigInt(r.balanceMinor) - BigInt(r.openingMinor)).toBe(305_000n);

    const by = await linesOf(r.entryId!);
    expect(by["6000"]).toBe(305_000n);
    expect(by["2260"]).toBe(-305_000n);
    expect(await accountTotal("2260")).toBe(-4_465_000n);
  });

  it("pays untaken leave out, and takes it off the balance", async () => {
    const r = await encashLeave({ orgId: ORG, entityId: ENT, code: "E-001", daysTenth: 50, on: "2026-05-15" });
    expect(r.paidMinor).toBe("250000"); // 5 days × 500.00
    expect(r.reference).toMatch(/^PR-/);
    expect(r.balance.encashedTenth).toBe(50);
    // 41.0 days earned to 15 May, less 10 taken and 5 bought back.
    expect(r.balance.balanceTenth).toBe(260);

    const by = await linesOf(r.entryId);
    // The cost was charged to profit when the days were earned, so the payment
    // settles the provision rather than incurring the cost a second time.
    expect(by["2260"]).toBe(250_000n);
    expect(by["1010"]).toBe(-250_000n);
    expect(await accountTotal("2260")).toBe(-4_215_000n);

    const rows = await leaveRecords({ orgId: ORG, entityId: ENT, code: "E-001" });
    expect(rows.filter((x) => x.kind === "ENCASHED")).toHaveLength(1);
  });

  it("refuses to pay out more leave than has been earned", async () => {
    await expect(encashLeave({
      orgId: ORG, entityId: ENT, code: "E-001", daysTenth: 400, on: "2026-05-20",
    })).rejects.toThrow(/26\.4 days of leave at 2026-05-20/);
    // Nothing was recorded and nothing was posted for the refused attempt.
    expect(await accountTotal("2260")).toBe(-4_215_000n);
  });

  it("charges the payment through the next month's movement", async () => {
    const r = await provisionForPeriod({ orgId: ORG, entityId: ENT, period: "2026-05" });
    // 27.3 days for Ahmed (42.3 earned, 10 taken, 5 paid out) and 63.4 for
    // Priya: 13,650.00 + 31,700.00 = 45,350.00.
    expect(r.balanceMinor).toBe("4535000");
    expect(r.openingMinor).toBe("4215000"); // what the encashment left on 2260
    expect(r.chargeMinor).toBe("320000");

    const by = await linesOf(r.entryId!);
    expect(by["6000"]).toBe(320_000n);
    expect(by["2260"]).toBe(-320_000n);
    expect(await accountTotal("2260")).toBe(-4_535_000n);

    const reg = await leaveRegister({ orgId: ORG, entityId: ENT, asOf: "2026-05-31" });
    expect(reg.totals.provisionMinor).toBe("4535000");
    expect(reg.ledger.agrees).toBe(true);
    expect(reg.ledger.differenceMinor).toBe("0");
  });

  it("leaves the trial balance tied through every leave posting", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-05" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });

  it("is refused by post() when the period is closed", async () => {
    await db.accountingPeriod.updateMany({
      where: { orgId: ORG, entityId: ENT, label: "2026-06" }, data: { status: "hard_closed" },
    });
    await expect(provisionForPeriod({ orgId: ORG, entityId: ENT, period: "2026-06" }))
      .rejects.toThrow(/Period 2026-06 is hard closed/);
    // And nothing was half-done: no row, no movement on the account.
    expect(await db.leaveProvision.count({ where: { orgId: ORG, entityId: ENT, period: "2026-06" } })).toBe(0);
    expect(await accountTotal("2260")).toBe(-4_535_000n);
  });

  it("refuses a period that is not a month", async () => {
    await expect(provisionForPeriod({ orgId: ORG, entityId: ENT, period: "Q2" }))
      .rejects.toThrow(/looks like 2026-03/);
  });

  it("earns no annual leave for a month of unpaid leave", async () => {
    const before = await leaveBalance({ orgId: ORG, entityId: ENT, code: "E-001", asOf: "2026-07-31" });
    expect(before.earnedTenth).toBe(473); // 576 days × 30 / 365

    const r = await recordLeave({
      orgId: ORG, entityId: ENT, code: "E-001", kind: "UNPAID",
      startsOn: "2026-07-01", endsOn: "2026-07-30", paid: true, note: "Extended trip home",
    });
    // Unpaid leave is unpaid whatever the caller says, or the payroll would pay
    // salary that was never due. The database insists on it too.
    expect(r.paid).toBe(false);
    expect(r.daysTenth).toBe(300);

    const after = await leaveBalance({ orgId: ORG, entityId: ENT, code: "E-001", asOf: "2026-07-31" });
    expect(after.unpaidTenth).toBe(300);
    // 546 days of service rather than 576: 44.8 days rather than 47.3. The
    // 2.5 days lost are what the unpaid month would otherwise have earned.
    expect(after.earnedTenth).toBe(448);
    expect(before.earnedTenth - after.earnedTenth).toBe(25);
    // It is not deducted a second time as leave taken — that would charge the
    // same absence twice.
    expect(after.takenTenth).toBe(100);
    expect(after.balanceTenth).toBe(298);
  });

  it("records half a day where the dates alone would say a whole one", async () => {
    const r = await recordLeave({
      orgId: ORG, entityId: ENT, code: "E-002",
      startsOn: "2026-08-03", endsOn: "2026-08-03", daysTenth: 5,
    });
    expect(r.daysTenth).toBe(5);
    expect(r.days).toBe("0.5");
    const b = await leaveBalance({ orgId: ORG, entityId: ENT, code: "E-002", asOf: "2026-08-31" });
    expect(b.takenTenth).toBe(55); // the five days in March and this half day
  });

  it("scopes every read and write to the org and the entity together", async () => {
    // E-001 exists in this org, and in the other org, and in neither case can
    // an entity id on its own reach it.
    await expect(leaveBalance({ orgId: ORG, entityId: ENT2, code: "E-001", asOf: "2026-05-31" }))
      .rejects.toThrow(/not on the payroll for this entity/);
    await expect(leaveBalance({ orgId: ORG2, entityId: ENT, code: "E-001", asOf: "2026-05-31" }))
      .rejects.toThrow(/not on the payroll for this entity/);
    await expect(recordLeave({
      orgId: ORG, entityId: ENT2, code: "E-001", startsOn: "2026-09-01", endsOn: "2026-09-02",
    })).rejects.toThrow(/not on the payroll for this entity/);

    // The other org's E-001 is a different person on a different wage, and the
    // leave recorded against this org's E-001 is not theirs.
    const other = await leaveBalance({ orgId: ORG2, entityId: ENT2, code: "E-001", asOf: "2026-05-31" });
    expect(other.name).toBe("Someone Else Entirely");
    expect(other.takenTenth).toBe(0);
    expect(other.earnedTenth).toBe(423);
    expect(other.valueMinor).toBe("141000"); // 42.3 days at 1,000.00 / 30

    // And nothing of this org's leaks into an entity that has none of it.
    const empty = await leaveRegister({ orgId: ORG, entityId: ENT2, asOf: "2026-05-31" });
    expect(empty.employees).toHaveLength(0);
    expect(empty.totals.provisionMinor).toBe("0");
    expect(await leaveRecords({ orgId: ORG, entityId: ENT2 })).toHaveLength(0);
  });
});
