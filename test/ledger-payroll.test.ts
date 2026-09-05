import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  addEmployee,
  updateEmployee,
  runPayroll,
  postPayroll,
  payPayroll,
  settleEndOfService,
  wpsFile,
  payrollSummary,
  gratuityEntitlement,
  gratuityAccrual,
} from "@/lib/server/ledger/payroll";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { post } from "@/lib/server/ledger/post";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-pay";
const ENT = "t-ent-pay";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "Payslip" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ApprovalDecision" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ApprovalRule" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Employee" WHERE "orgId" = '${ORG}'`),
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

/** Signed minor units per account code, summed — one journal, several lines. */
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

describe("end-of-service gratuity (Federal Decree-Law 33/2021, Article 51)", () => {
  const JOINED = "2021-01-01";
  const BASIC = 3_000_000n; // AED 30,000 a month, so a day is 100,000 fils
  const at = (days: number) =>
    gratuityEntitlement({ basicMinor: BASIC, joinedOn: JOINED, asOf: plusDays(JOINED, days) });

  it("pays nothing at all below one continuous year", () => {
    expect(at(0)).toBe(0n);
    expect(at(364)).toBe(0n);
    // Article 51(1) is a cliff, not a ramp: the day the year completes, 21 days fall due.
    expect(at(365)).toBe(2_100_000n);
  });

  it("pays 21 days of basic for each of the first five years", () => {
    expect(at(365 * 3)).toBe(6_300_000n);  //  63 days × 100,000
    expect(at(365 * 5)).toBe(10_500_000n); // 105 days × 100,000
  });

  it("pays 30 days of basic for each year beyond five", () => {
    expect(at(365 * 6)).toBe(13_500_000n); // 105 + 30 days
    expect(at(365 * 7)).toBe(16_500_000n); // 105 + 60 days
  });

  it("pays fractions of a year pro rata once the first year is behind", () => {
    // 547 days: 21 days of pay for the year and 21 × 182/365 for the rest of it.
    expect(at(365 + 182)).toBe(3_147_123n);
    expect(at(365 + 182)).toBeGreaterThan(at(365));
    expect(at(365 + 182)).toBeLessThan(at(365 * 2));
  });

  it("caps the whole entitlement at two years of basic pay", () => {
    // Thirty years earns 855 days — 28.5 months — but Article 51(4) stops at 24.
    expect(at(365 * 30)).toBe(BASIC * 24n);
    expect(at(365 * 30)).toBe(72_000_000n);
    expect(at(365 * 40)).toBe(at(365 * 30)); // and it does not grow after that
  });

  it("is computed on basic pay alone, so allowances never enter it", () => {
    const withAllowances = gratuityEntitlement({ basicMinor: BASIC, joinedOn: JOINED, asOf: plusDays(JOINED, 730) });
    const basicOnly = gratuityEntitlement({ basicMinor: BASIC, joinedOn: JOINED, asOf: plusDays(JOINED, 730) });
    expect(withAllowances).toBe(basicOnly);
    expect(basicOnly).toBe(4_200_000n); // 42 days, not a fil more for housing
  });

  it("stops a mid-month leaver's service on the day they left", () => {
    const a = gratuityAccrual({ basicMinor: BASIC, joinedOn: "2025-01-01", leftOn: "2026-06-15" }, "2026-06-30");
    expect(a.serviceDays).toBe(530); // to 15 June, not to 30 June
    expect(a.cumulativeMinor).toBe(3_049_315n);
    expect(a.priorMinor).toBe(2_963_013n);
    expect(a.accrualMinor).toBe(86_302n);
    // Had they stayed the fortnight, they would have earned more.
    expect(gratuityEntitlement({ basicMinor: BASIC, joinedOn: "2025-01-01", asOf: "2026-06-30" })).toBe(3_135_616n);
  });

  it("accrues the increment, so the monthly charges rebuild the cumulative", () => {
    // Twelve accruals across the second year must add up to exactly the
    // difference between the two year-end cumulatives — no drift, no rounding
    // left on the floor.
    const joined = "2024-01-01";
    let sum = 0n;
    for (const period of ["2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07",
                          "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01"]) {
      const [y, m] = period.split("-").map(Number);
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      sum += gratuityAccrual({ basicMinor: BASIC, joinedOn: joined }, end).accrualMinor;
    }
    const opening = gratuityEntitlement({ basicMinor: BASIC, joinedOn: joined, asOf: "2025-01-31" });
    const closing = gratuityEntitlement({ basicMinor: BASIC, joinedOn: joined, asOf: "2026-01-31" });
    expect(sum).toBe(closing - opening);
  });
});

/* ------------------------------------------------------------------------- */

d("payroll", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
    // Money to pay wages out of, and an advance for Ahmed that March will recover.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-01-01", source: "manual", memo: "Capital introduced",
      lines: [{ account: "1010", debit: 50_000_000 }, { account: "3000", credit: 50_000_000 }],
    });
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-02-10", source: "manual", memo: "Salary advance to E-001",
      lines: [{ account: "1400", debit: 50_000 }, { account: "1010", credit: 50_000 }],
    });

    await addEmployee({
      orgId: ORG, entityId: ENT,
      employee: {
        code: "E-001", name: "Ahmed Al Mansouri", joinedOn: "2024-01-01",
        basicMinor: 1_000_000, housingMinor: 400_000, transportMinor: 100_000,
        molPersonId: "10000000000001", routingCode: "023456789", iban: "AE070331234567890123456",
      },
    });
    // No bank details yet — the WPS file has to refuse her by name.
    await addEmployee({
      orgId: ORG, entityId: ENT,
      employee: {
        code: "E-002", name: "Fatima Khan", joinedOn: "2026-01-10",
        basicMinor: 800_000, housingMinor: 200_000,
      },
    });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("puts someone on the payroll", async () => {
    const e = await db.employee.findFirst({ where: { orgId: ORG, code: "E-001" } });
    expect(e?.status).toBe("active");
    expect(e?.leftOn).toBeNull();
    expect(e?.basicMinor).toBe(1_000_000n);
  });

  it("refuses a second employee with the same code", async () => {
    await expect(addEmployee({
      orgId: ORG, entityId: ENT,
      employee: { code: "E-001", name: "Someone Else", joinedOn: "2026-01-01", basicMinor: 500_000 },
    })).rejects.toThrow(/already on the payroll/i);
  });

  it("refuses a package with no basic salary, which would accrue no gratuity", async () => {
    await expect(addEmployee({
      orgId: ORG, entityId: ENT,
      employee: { code: "E-BAD", name: "All Allowances", joinedOn: "2026-01-01", basicMinor: 0, housingMinor: 900_000 },
    })).rejects.toThrow(/basic salary above zero/i);
  });

  it("refuses an IBAN a UAE bank cannot pay into", async () => {
    await expect(addEmployee({
      orgId: ORG, entityId: ENT,
      employee: { code: "E-IBAN", name: "Wrong Bank", joinedOn: "2026-01-01", basicMinor: 500_000, iban: "GB29NWBK60161331926819" },
    })).rejects.toThrow(/not a UAE IBAN/i);
  });

  it("builds the month's draft payslips", async () => {
    const r = await runPayroll({
      orgId: ORG, entityId: ENT, period: "2026-03",
      entries: [
        { code: "E-001", deductionsMinor: 50_000 },  // the February advance, recovered
        { code: "E-002", overtimeMinor: 25_000 },
      ],
    });
    expect(r.employees).toBe(2);
    expect(r.alreadyPosted).toBe(false);
    expect(r.totals.grossMinor).toBe("2525000");
    expect(r.totals.deductionsMinor).toBe("50000");
    expect(r.totals.netMinor).toBe("2475000");
    // Only Ahmed has a year behind him; Fatima joined in January.
    expect(r.totals.gratuityMinor).toBe("59452");
    expect(r.payslips.find((p) => p.code === "E-001")?.gratuityMinor).toBe("59452");
    expect(r.payslips.find((p) => p.code === "E-002")?.gratuityMinor).toBe("0");
    expect(r.payslips.every((p) => p.status === "draft")).toBe(true);
  });

  it("refuses to deduct more than a month's pay", async () => {
    await expect(runPayroll({
      orgId: ORG, entityId: ENT, period: "2026-03",
      entries: [{ code: "E-001", deductionsMinor: 9_000_000 }],
    })).rejects.toThrow(/Net pay cannot be negative/);
  });

  it("names an employee code nobody recognises rather than dropping the line", async () => {
    await expect(runPayroll({
      orgId: ORG, entityId: ENT, period: "2026-03", entries: [{ code: "E-999", overtimeMinor: 1 }],
    })).rejects.toThrow(/no employee E-999/i);
  });

  it("posts the month as one journal", async () => {
    const r = await postPayroll({ orgId: ORG, entityId: ENT, period: "2026-03" });
    expect(r.alreadyPosted).toBe(false);
    expect(r.reference).toMatch(/^PR-/);

    const by = await linesOf(r.entryId);
    expect(by["6000"]).toBe(2_525_000n);   // Dr salaries, at gross
    expect(by["6050"]).toBe(59_452n);      // Dr end-of-service expense
    expect(by["2200"]).toBe(-2_475_000n);  // Cr salaries payable, at net
    expect(by["2250"]).toBe(-59_452n);     // Cr the gratuity provision
    expect(by["1400"]).toBe(-50_000n);     // Cr the advance the deduction repaid

    const slips = await db.payslip.findMany({ where: { orgId: ORG, period: "2026-03" } });
    expect(slips.every((p) => p.status === "posted" && p.entryId === r.entryId)).toBe(true);
  });

  it("does not charge the same month twice", async () => {
    const rerun = await runPayroll({ orgId: ORG, entityId: ENT, period: "2026-03" });
    expect(rerun.alreadyPosted).toBe(true);
    expect(rerun.skipped[0].reason).toMatch(/already posted/);

    const again = await postPayroll({ orgId: ORG, entityId: ENT, period: "2026-03" });
    expect(again.alreadyPosted).toBe(true);

    expect(await accountTotal("6000")).toBe(2_525_000n); // one month's cost, once
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceType: "PAYROLL_RUN" } })).toBe(1);
  });

  it("refuses a salary file for anyone the bank cannot pay, by name", async () => {
    await expect(wpsFile({
      orgId: ORG, entityId: ENT, period: "2026-03",
      employerId: "1234567890123", employerAgentId: "023456789",
    })).rejects.toThrow(/Fatima Khan \(E-002\) has no MOL person id and no routing code and no IBAN/);
  });

  it("builds the salary file once the bank details are there", async () => {
    await updateEmployee({
      orgId: ORG, entityId: ENT, employeeCode: "E-002",
      changes: { molPersonId: "10000000000002", routingCode: "023456789", iban: "AE070331234567890123457" },
    });

    const f = await wpsFile({
      orgId: ORG, entityId: ENT, period: "2026-03",
      employerId: "1234567890123", employerAgentId: "023456789",
      createdAt: new Date("2026-04-01T09:30:00Z"),
    });
    expect(f.records).toBe(2);
    expect(f.totalMinor).toBe("2475000");

    const rows = f.csv.trim().split("\n");
    expect(rows.filter((r) => r.startsWith("EDR"))).toHaveLength(2);

    // Ahmed: fixed pay net of the advance he repaid, nothing variable.
    const ahmed = rows[0].split(",");
    expect(ahmed.slice(0, 4)).toEqual(["EDR", "10000000000001", "023456789", "AE070331234567890123456"]);
    expect(ahmed.slice(4, 7)).toEqual(["2026-03-01", "2026-03-31", "31"]);
    expect(ahmed.slice(7)).toEqual(["14500.00", "0.00"]);
    // Fatima: her overtime is the variable half.
    expect(rows[1].split(",").slice(7)).toEqual(["10000.00", "250.00"]);

    // The trailer the bank reconciles the batch against.
    const scr = rows[2].split(",");
    expect(scr[0]).toBe("SCR");
    expect(scr[1]).toBe("1234567890123");
    expect(scr[5]).toBe("2026-03");
    expect(scr[6]).toBe("2");        // record count
    expect(scr[7]).toBe("24750.00"); // total, equal to the net posted
    expect(scr[8]).toBe("AED");
  });

  it("refuses a salary file without the employer's establishment id", async () => {
    await expect(wpsFile({ orgId: ORG, entityId: ENT, period: "2026-03", employerAgentId: "023456789" }))
      .rejects.toThrow(/13-digit MOHRE establishment id/);
  });

  it("pays the month out of the bank", async () => {
    const r = await payPayroll({ orgId: ORG, entityId: ENT, period: "2026-03", paidOn: "2026-04-05" });
    expect(r.paidMinor).toBe("2475000");
    expect(r.reference).toMatch(/^PP-/);

    const by = await linesOf(r.entryId);
    expect(by["2200"]).toBe(2_475_000n);   // Dr salaries payable — no longer owed
    expect(by["1010"]).toBe(-2_475_000n);  // Cr bank — the WPS transfer

    expect(await accountTotal("2200")).toBe(0n); // the month is fully discharged
    const slips = await db.payslip.findMany({ where: { orgId: ORG, period: "2026-03" } });
    expect(slips.every((p) => p.status === "paid")).toBe(true);
  });

  it("settles end of service and clears the provision", async () => {
    const r = await settleEndOfService({
      orgId: ORG, entityId: ENT, employeeCode: "E-001", leftOn: "2026-04-15",
    });
    expect(r.serviceDays).toBe(835);
    expect(r.entitlementMinor).toBe("1601369");
    expect(r.provisionHeldMinor).toBe("59452");   // one month of accrual, all there was
    expect(r.differenceMinor).toBe("1541917");    // the rest was never provided for

    const by = await linesOf(r.entryId!);
    expect(by["2250"]).toBe(59_452n);      // Dr — the provision released in full
    expect(by["6050"]).toBe(1_541_917n);   // Dr — the shortfall, charged now
    expect(by["1010"]).toBe(-1_601_369n);  // Cr — paid within 14 days, Article 53

    // The provision holds what is owed to people still employed; Ahmed has gone.
    expect(await accountTotal("2250")).toBe(0n);
    const e = await db.employee.findFirst({ where: { orgId: ORG, code: "E-001" } });
    expect(e?.status).toBe("left");
  });

  it("will not settle the same employee twice", async () => {
    await expect(settleEndOfService({
      orgId: ORG, entityId: ENT, employeeCode: "E-001", leftOn: "2026-04-20",
    })).rejects.toThrow(/already left on 2026-04-15/);
  });

  it("keeps the payslips tied to the ledger", async () => {
    const s = await payrollSummary({ orgId: ORG, entityId: ENT, period: "2026-03" });
    expect(s.register.salariesMinor).toBe("2525000"); // gross of the posted payslips
    expect(s.ledger.salariesMinor).toBe("2525000");   // 6000, charged in March
    expect(s.ledger.payableMinor).toBe("0");        // 2200, all paid
    expect(s.ledger.provisionMinor).toBe("0");      // 2250, released on settlement
    expect(s.ledger.salariesAgree).toBe(true);
    expect(s.ledger.payableAgrees).toBe(true);
    expect(s.ledger.provisionAgrees).toBe(true);
    expect(s.ledger.agrees).toBe(true);
    expect(s.employees.find((e) => e.code === "E-002")?.wpsReady).toBe(true);
  });

  it("leaves a departed employee out of the next run, and says so", async () => {
    const r = await runPayroll({ orgId: ORG, entityId: ENT, period: "2026-05" });
    expect(r.skipped.find((s) => s.code === "E-001")?.reason).toMatch(/left on 2026-04-15, before this period/);
    expect(r.payslips.map((p) => p.code)).toEqual(["E-002"]);
  });

  it("pro-rates a joiner on the days they were actually on the payroll", async () => {
    await addEmployee({
      orgId: ORG, entityId: ENT,
      employee: { code: "E-003", name: "Priya Nair", joinedOn: "2026-05-16", basicMinor: 620_000 },
    });
    const r = await runPayroll({ orgId: ORG, entityId: ENT, period: "2026-05" });
    const priya = r.payslips.find((p) => p.code === "E-003")!;
    expect(priya.daysOnPayroll).toBe(16); // 16 May to 31 May inclusive
    expect(priya.basicMinor).toBe("320000"); // 620,000 × 16 / 31
    expect(priya.gratuityMinor).toBe("0");   // nothing until a year is complete
  });

  it("leaves the trial balance tied through the run, the payment and the settlement", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-05" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });

  it("refuses a period that is not a month", async () => {
    await expect(runPayroll({ orgId: ORG, entityId: ENT, period: "Q1" }))
      .rejects.toThrow(/looks like 2026-03/);
  });

  it("holds the organisation's approval rules before a payslip becomes a payment", async () => {
    // PAYROLL is one of the five subjects the approvals engine takes rules
    // for. It was the last posting path not asking, so a rule saying "payroll
    // needs a director" appeared on the screen, showed in the queue, and bound
    // on nothing.
    const rule = await db.approvalRule.create({
      data: {
        orgId: ORG, entityId: ENT, subjectType: "PAYROLL",
        thresholdMinor: 100_000n, approverRole: "DIRECTOR", approversRequired: 1,
      },
    });

    const run = await runPayroll({ orgId: ORG, entityId: ENT, period: "2026-06" });
    expect(run.payslips.length).toBeGreaterThan(0);

    await expect(postPayroll({ orgId: ORG, entityId: ENT, period: "2026-06" }))
      .rejects.toThrow(/needs one more approval from a director/i);
    // Refused before anything was written: the drafts are still drafts.
    expect(await db.payslip.count({ where: { orgId: ORG, period: "2026-06", status: "draft" } }))
      .toBe(run.payslips.length);

    // The figure a limit is written against is the cost of employing people
    // for the month — gross plus gratuity plus the employer's pension — not
    // net pay, which understates it by every deduction withheld.
    const drafts = await db.payslip.findMany({ where: { orgId: ORG, entityId: ENT, period: "2026-06" } });
    const cost = drafts.reduce(
      (a, p) => a + p.basicMinor + p.allowancesMinor + p.overtimeMinor + p.gratuityMinor + p.pensionEmployerMinor,
      0n,
    );
    await db.approvalDecision.create({
      data: {
        orgId: ORG, entityId: ENT, subjectType: "PAYROLL", subjectId: "2026-06",
        decision: "APPROVED", decidedBy: "dir-a", amountMinor: cost,
      },
    });

    const posted = await postPayroll({ orgId: ORG, entityId: ENT, period: "2026-06" });
    expect(posted.alreadyPosted).toBe(false);
    expect(posted.entryId).toBeTruthy();

    // March was posted earlier in this file, before any rule existed. Re-posting
    // it still hands back the original entry rather than being refused: the
    // guard sits after the idempotency return, so a rule written today cannot
    // turn a harmless retry of an already-posted month into a failure.
    const again = await postPayroll({ orgId: ORG, entityId: ENT, period: "2026-03" });
    expect(again.alreadyPosted).toBe(true);

    // And a signature covers the month it was given for. June's decision does
    // nothing for a month nobody has signed.
    await runPayroll({ orgId: ORG, entityId: ENT, period: "2026-07" });
    await expect(postPayroll({ orgId: ORG, entityId: ENT, period: "2026-07" }))
      .rejects.toThrow(/needs one more approval from a director/i);

    await db.approvalRule.delete({ where: { id: rule.id } });
  });

  it("posts a payslip that reaches draft after the month as an entry of its own", async () => {
    await runPayroll({ orgId: ORG, entityId: ENT, period: "2026-08" });
    const run = await postPayroll({ orgId: ORG, entityId: ENT, period: "2026-08" });
    expect(run.supplementary).toBe(false);

    /*
     * A payslip written after the month was posted. It is written straight to
     * the table because that is what produces it: a run that read the register
     * before the post and upserted after it, or a joiner keyed in late.
     *
     * The month used to be sealed by its first journal. The next call hit the
     * early return, reported a gross that INCLUDED this person — the ledger had
     * never received them — and `payPayroll` pays a posted payslip and nothing
     * else, so they were never paid either. Salaries payable was understated by
     * their net with no error anywhere, because the journal that did exist
     * balanced and the trial balance tied on it.
     */
    const omar = await addEmployee({
      orgId: ORG, entityId: ENT,
      employee: { code: "E-004", name: "Omar Farouk", joinedOn: "2026-08-01", basicMinor: 900_000 },
    });
    await db.payslip.create({
      data: {
        orgId: ORG, entityId: ENT, employeeId: omar.id, period: "2026-08",
        basicMinor: 900_000n, netMinor: 900_000n,
      },
    });

    const late = await postPayroll({ orgId: ORG, entityId: ENT, period: "2026-08" });
    expect(late.supplementary).toBe(true);
    expect(late.alreadyPosted).toBe(false);
    expect(late.entryId).not.toBe(run.entryId);
    expect(late.payslips).toBe(1);
    expect(late.grossMinor).toBe("900000");

    const by = await linesOf(late.entryId);
    expect(by["6000"]).toBe(900_000n);    // Dr salaries — the cost, charged at last
    expect(by["2200"]).toBe(-900_000n);   // Cr salaries payable — and now owed

    // The register and the ledger say the same thing about August, which is
    // the only claim either of them is entitled to make.
    const summary = await payrollSummary({ orgId: ORG, entityId: ENT, period: "2026-08" });
    expect(summary.register.salariesMinor).toBe(summary.ledger.salariesMinor);
    expect(summary.ledger.salariesAgree).toBe(true);

    // Nothing outstanding now: the answer is the month's first entry again, and
    // the figures are the ones that reached the ledger.
    const settled = await postPayroll({ orgId: ORG, entityId: ENT, period: "2026-08" });
    expect(settled.alreadyPosted).toBe(true);
    expect(settled.supplementary).toBe(false);
    expect(settled.entryId).toBe(run.entryId);
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceType: "PAYROLL_RUN", sourceId: "2026-08" } })).toBe(2);

    // And the money reaches them, which is what all of it was for.
    const august = await db.payslip.findMany({ where: { orgId: ORG, period: "2026-08" } });
    const paid = await payPayroll({ orgId: ORG, entityId: ENT, period: "2026-08", paidOn: "2026-09-03" });
    expect(BigInt(paid.paidMinor)).toBe(august.reduce((a, p) => a + p.netMinor, 0n));
    const afterPayment = await db.payslip.findMany({ where: { orgId: ORG, period: "2026-08" } });
    expect(afterPayment.every((p) => p.status === "paid")).toBe(true);
  });

  it("transfers a payslip posted after the month was paid, rather than leaving it owed", async () => {
    // The other half of the same seal: August has been paid, and one more
    // payslip reaches the ledger afterwards. The payment key used to be the
    // month, so the next run found it, said "already paid" and left the net
    // sitting on 2200 for a person nobody had transferred anything to.
    const nadia = await addEmployee({
      orgId: ORG, entityId: ENT,
      employee: { code: "E-005", name: "Nadia Aziz", joinedOn: "2026-08-10", basicMinor: 400_000 },
    });
    await db.payslip.create({
      data: {
        orgId: ORG, entityId: ENT, employeeId: nadia.id, period: "2026-08",
        basicMinor: 400_000n, netMinor: 400_000n,
      },
    });
    await postPayroll({ orgId: ORG, entityId: ENT, period: "2026-08" });

    const owed = await accountTotal("2200");
    const paid = await payPayroll({ orgId: ORG, entityId: ENT, period: "2026-08", paidOn: "2026-09-06" });
    expect(paid.supplementary).toBe(true);
    expect(paid.alreadyPaid).toBe(false);
    expect(paid.paidMinor).toBe("400000");

    const by = await linesOf(paid.entryId);
    expect(by["2200"]).toBe(400_000n);   // Dr — no longer owed
    expect(by["1010"]).toBe(-400_000n);  // Cr bank — the transfer that was missing
    // A liability is held negative, so discharging it moves the balance up.
    expect(await accountTotal("2200")).toBe(owed + 400_000n);

    // Asked again, with nothing outstanding, it reports the transfer rather
    // than making a second one.
    const again = await payPayroll({ orgId: ORG, entityId: ENT, period: "2026-08" });
    expect(again.alreadyPaid).toBe(true);
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceType: "PAYROLL_PAYMENT", sourceId: "2026-08" } })).toBe(2);
  });

  it("repairs a run cut off between the journal and the payslips, rather than charging the month twice", async () => {
    await runPayroll({ orgId: ORG, entityId: ENT, period: "2026-09" });
    const run = await postPayroll({ orgId: ORG, entityId: ENT, period: "2026-09" });

    // The journal committed and the payslips were never marked — the state a
    // process dying between the two leaves behind. Read as late payslips it
    // would charge September twice; read as the interrupted run it is, the link
    // is repaired and nothing further is posted.
    await db.payslip.updateMany({
      where: { orgId: ORG, period: "2026-09" },
      data: { status: "draft", entryId: null },
    });

    const repaired = await postPayroll({ orgId: ORG, entityId: ENT, period: "2026-09" });
    expect(repaired.alreadyPosted).toBe(true);
    expect(repaired.supplementary).toBe(false);
    expect(repaired.entryId).toBe(run.entryId);
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceType: "PAYROLL_RUN", sourceId: "2026-09" } })).toBe(1);
    const slips = await db.payslip.findMany({ where: { orgId: ORG, period: "2026-09" } });
    expect(slips.every((p) => p.status === "posted" && p.entryId === run.entryId)).toBe(true);

    // And where the drafts no longer come to what that entry charged, it says
    // so rather than guessing which of them the journal already covers.
    await db.payslip.updateMany({
      where: { orgId: ORG, period: "2026-09" },
      data: { status: "draft", entryId: null },
    });
    const one = await db.payslip.findFirstOrThrow({ where: { orgId: ORG, period: "2026-09" } });
    await db.payslip.update({ where: { id: one.id }, data: { basicMinor: one.basicMinor + 100_000n } });
    await expect(postPayroll({ orgId: ORG, entityId: ENT, period: "2026-09" }))
      .rejects.toThrow(/interrupted between the journal and the payslips/i);
  });
});
