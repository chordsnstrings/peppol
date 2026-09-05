import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  addEmployee, runPayroll, postPayroll,
  pensionContribution, accruesGratuity, gratuityAccrual,
  GPSSA_DEFAULT_RATES,
} from "@/lib/server/ledger/payroll";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { ledgerBalances } from "@/lib/server/ledger/balances";
import { LedgerError } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-pen";
const ENT = "t-ent-pen";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "Payslip" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "LeaveProvision" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "LeaveRecord" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Employee" WHERE "orgId" = '${ORG}'`),
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

describe("who is provided for by a pension rather than a gratuity", () => {
  it("gives the Article 51 gratuity to the foreign worker only", () => {
    // FDL 33/2021 Article 51 gives end-of-service gratuity to the foreign
    // worker; a UAE national is covered by Federal Law 7/1999 instead.
    expect(accruesGratuity("NONE")).toBe(true);
    expect(accruesGratuity("GPSSA")).toBe(false);
    expect(accruesGratuity("GCC_HOME_STATE")).toBe(false);
  });

  it("computes each side at its own rate, rounded once", () => {
    // AED 12,000 contribution salary. 5% is 600.00; 12.5% is 1,500.00.
    const c = pensionContribution({ scheme: "GPSSA", contributionSalaryMinor: 1_200_000n });
    expect(c.employeeMinor).toBe(60_000n);
    expect(c.employerMinor).toBe(150_000n);
    expect(c.totalMinor).toBe(210_000n);
    expect(c.note).toBeNull();
  });

  it("rounds each side rather than splitting a rounded total", () => {
    // AED 3,333.33. 5% is 166.6665 → 166.67; 12.5% is 416.66625 → 416.67.
    // Rounding the 17.5% total and splitting it would put the odd fil on
    // whichever side the arithmetic favoured, and the employee's half is
    // withheld from their pay.
    const c = pensionContribution({ scheme: "GPSSA", contributionSalaryMinor: 333_333n });
    expect(c.employeeMinor).toBe(16_667n);
    expect(c.employerMinor).toBe(41_667n);
  });

  it("raises a salary to the scheme's floor and says so", () => {
    const c = pensionContribution({ scheme: "GPSSA", contributionSalaryMinor: 50_000n });
    expect(c.contributionSalaryMinor).toBe(GPSSA_DEFAULT_RATES.floorMinor);
    expect(c.note).toContain("floor");
  });

  it("caps it, and says pay above the cap does not contribute", () => {
    const c = pensionContribution({ scheme: "GPSSA", contributionSalaryMinor: 9_000_000n });
    expect(c.contributionSalaryMinor).toBe(GPSSA_DEFAULT_RATES.capMinor);
    // 5% and 12.5% of AED 50,000, not of AED 90,000.
    expect(c.employeeMinor).toBe(250_000n);
    expect(c.employerMinor).toBe(625_000n);
    expect(c.note).toContain("cap");
  });

  it("contributes nothing for somebody in no scheme", () => {
    const c = pensionContribution({ scheme: "NONE", contributionSalaryMinor: 1_200_000n });
    expect(c.totalMinor).toBe(0n);
  });

  it("takes the rates as an argument, because they are policy and not arithmetic", () => {
    const c = pensionContribution({
      scheme: "GPSSA", contributionSalaryMinor: 1_000_000n,
      rates: { employeeBps: 500, employerBps: 1_500, floorMinor: 0n, capMinor: 99_999_999n },
    });
    expect(c.employerMinor).toBe(150_000n);
  });

  it("refuses a negative contribution salary", () => {
    expect(() => pensionContribution({ scheme: "GPSSA", contributionSalaryMinor: -1n }))
      .toThrow(LedgerError);
  });
});

d("a payroll with both kinds of employee", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ ...S, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
    // A foreign worker: gratuity, no pension.
    await addEmployee({
      ...S,
      employee: {
        code: "E-EXPAT", name: "R. Khan", joinedOn: "2024-01-01",
        basicMinor: 1_000_000, housingMinor: 400_000,
        molPersonId: "10000000000001", routingCode: "023456789", iban: "AE070331234567890123456",
      },
    });
    // A UAE national: pension, no gratuity.
    await addEmployee({
      ...S,
      employee: {
        code: "E-NATIONAL", name: "A. Al Mansoori", joinedOn: "2024-01-01",
        basicMinor: 1_000_000, housingMinor: 400_000,
        nationality: "AE", pensionScheme: "GPSSA",
        molPersonId: "10000000000002", routingCode: "023456789", iban: "AE070331234567890123457",
      },
    });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("accrues a gratuity for the foreign worker and none for the national", async () => {
    await runPayroll({ ...S, period: "2026-03" });
    const slips = await db.payslip.findMany({
      where: { orgId: ORG, period: "2026-03" },
      include: { employee: true },
      orderBy: { employee: { code: "asc" } },
    });
    const expat = slips.find((s) => s.employee.code === "E-EXPAT")!;
    const national = slips.find((s) => s.employee.code === "E-NATIONAL")!;

    expect(expat.gratuityMinor).toBeGreaterThan(0n);
    expect(national.gratuityMinor).toBe(0n);
    // Providing for both would cover the same service twice.
    expect(national.pensionEmployeeMinor).toBeGreaterThan(0n);
    expect(expat.pensionEmployeeMinor).toBe(0n);
  });

  it("withholds the employee's share from net pay and charges the employer's", async () => {
    const slips = await db.payslip.findMany({
      where: { orgId: ORG, period: "2026-03" }, include: { employee: true },
    });
    const national = slips.find((s) => s.employee.code === "E-NATIONAL")!;
    const expat = slips.find((s) => s.employee.code === "E-EXPAT")!;

    // Contribution salary is basic 10,000 + housing 4,000 = 14,000.
    // 5% is 700.00 withheld; 12.5% is 1,750.00 from the employer.
    expect(national.pensionEmployeeMinor).toBe(70_000n);
    expect(national.pensionEmployerMinor).toBe(175_000n);

    // Both are paid the same gross; only the national's net is reduced.
    const gross = (p: typeof national) => p.basicMinor + p.allowancesMinor + p.overtimeMinor;
    expect(gross(national)).toBe(gross(expat));
    expect(expat.netMinor - national.netMinor).toBe(70_000n);
  });

  it("posts the employer's share as a cost and both sides as one liability", async () => {
    const r = await postPayroll({ ...S, period: "2026-03" });
    const bal = await ledgerBalances({ ...S, codes: ["6000", "2200", "2230", "2250"] });

    // Gross for two at 14,000 is 28,000, plus 1,750 of employer contribution.
    expect(bal.get("6000")).toBe(2_975_000n);
    // The authority is owed both halves and settles them as one payment.
    expect(bal.get("2230")).toBe(-245_000n);
    // Only the foreign worker's gratuity reaches the provision.
    expect(bal.get("2250")).toBeLessThan(0n);
    expect(r.entryId).toBeTruthy();
  });

  it("keeps the trial balance tied", async () => {
    const tb = await trialBalance({ ...S, periodLabel: "2026-03" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });

  it("would have provided for the same service twice before this", async () => {
    // The gratuity the national would have accrued under the old behaviour,
    // shown so the size of the overstatement is on the record.
    const would = gratuityAccrual(
      { basicMinor: 1_000_000n, joinedOn: "2024-01-01" },
      "2026-03-31",
    );
    expect(would.accrualMinor).toBeGreaterThan(0n);
    const slips = await db.payslip.findMany({
      where: { orgId: ORG, period: "2026-03" }, include: { employee: true },
    });
    expect(slips.find((s) => s.employee.code === "E-NATIONAL")!.gratuityMinor).toBe(0n);
  });
});
