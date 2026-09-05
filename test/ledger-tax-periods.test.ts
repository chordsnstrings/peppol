import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  dueDateFor,
  filingFor,
  getRegistration,
  outstandingReturns,
  recordFiling,
  recordRegistration,
  taxPeriodFor,
  taxPeriodsBetween,
} from "@/lib/server/ledger/tax-periods";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-taxperiods";
const ENT = "t-ent-taxperiods";

async function wipe() {
  await db.$executeRawUnsafe(
    `DELETE FROM "TaxFiling" WHERE "registrationId" IN (SELECT id FROM "TaxRegistration" WHERE "orgId" = '${ORG}')`,
  );
  await db.$executeRawUnsafe(`DELETE FROM "TaxRegistration" WHERE "orgId" = '${ORG}'`);
}

/* The stagger arithmetic needs no database at all, and is the part that has to
   be right for all twelve of the months the FTA can assign. */
describe("tax periods, from the stagger", () => {
  const feb = { frequency: "QUARTERLY" as const, firstPeriodEndMonth: 2 };

  it("puts a Feb/May/Aug/Nov registrant on Feb/May/Aug/Nov, not on calendar quarters", () => {
    // The case the product used to get wrong every single quarter: three
    // modules read `Math.floor(month / 3)` and handed this registrant the
    // calendar quarter, which is a month out at both ends.
    const periods = taxPeriodsBetween(feb, "2026-01-01", "2026-12-31");
    expect(periods.map((p) => p.label)).toEqual([
      "Dec 2025-Feb 2026",
      "Mar-May 2026",
      "Jun-Aug 2026",
      "Sep-Nov 2026",
      "Dec 2026-Feb 2027",
    ]);
    expect(periods[1]).toEqual({
      label: "Mar-May 2026",
      from: "2026-03-01",
      to: "2026-05-31",
      dueOn: "2026-06-28",
    });
  });

  it("straddles a year end without losing a period", () => {
    const [first] = taxPeriodsBetween(feb, "2026-01-01", "2026-01-31");
    // January 2026 sits inside a period that began in December 2025. A period
    // that started in the previous year is still the period that carries
    // January's supplies.
    expect(first.from).toBe("2025-12-01");
    expect(first.to).toBe("2026-02-28");
    expect(first.dueOn).toBe("2026-03-28");
  });

  it("comes out right for every one of the twelve staggers", () => {
    for (let anchor = 1; anchor <= 12; anchor++) {
      const rule = { frequency: "QUARTERLY" as const, firstPeriodEndMonth: anchor };
      const p = taxPeriodFor(rule, "2026-07-15");
      // It contains the date it was asked about, it is three months long, and
      // it ends in a month the stagger actually ends in.
      expect(p.from <= "2026-07-15" && "2026-07-15" <= p.to).toBe(true);
      const endMonth = Number(p.to.slice(5, 7));
      const startMonth = Number(p.from.slice(5, 7));
      expect((endMonth - anchor + 12) % 3).toBe(0);
      expect((endMonth - startMonth + 12) % 12).toBe(2);
    }
  });

  it("gives a monthly filer one period a month whatever the stagger says", () => {
    const p = taxPeriodFor({ frequency: "MONTHLY", firstPeriodEndMonth: 2 }, "2026-07-15");
    expect(p).toEqual({ label: "Jul 2026", from: "2026-07-01", to: "2026-07-31", dueOn: "2026-08-28" });
    expect(taxPeriodsBetween({ frequency: "MONTHLY", firstPeriodEndMonth: 7 }, "2026-01-01", "2026-12-31"))
      .toHaveLength(12);
  });

  it("gives an annual registrant one period ending in its own month", () => {
    const p = taxPeriodFor({ frequency: "ANNUAL", firstPeriodEndMonth: 3 }, "2025-09-30");
    expect(p.from).toBe("2025-04-01");
    expect(p.to).toBe("2026-03-31");
    expect(p.label).toBe("Apr 2025-Mar 2026");
  });

  it("makes a return due on the 28th day after the period ends (Article 64)", () => {
    // Every tax period ends on the last day of a month, so the 28th day after
    // the end is the 28th of the following month — including out of February
    // in a leap year, where a naive "add a month" would land on 29 March.
    expect(dueDateFor("2026-05-31")).toBe("2026-06-28");
    expect(dueDateFor("2026-02-28")).toBe("2026-03-28");
    expect(dueDateFor("2028-02-29")).toBe("2028-03-28");
    expect(dueDateFor("2026-12-31")).toBe("2027-01-28");
  });

  it("refuses a stagger month that is not a month", () => {
    expect(() => taxPeriodFor({ frequency: "QUARTERLY", firstPeriodEndMonth: 0 }, "2026-05-01"))
      .toThrow(/1 to 12/);
    expect(() => taxPeriodFor({ frequency: "QUARTERLY", firstPeriodEndMonth: 13 }, "2026-05-01"))
      .toThrow(/1 to 12/);
  });
});

d("the registration and its filings", () => {
  beforeAll(async () => { await wipe(); });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("records a registration and amends it in place", async () => {
    const created = await recordRegistration({
      orgId: ORG, entityId: ENT, regime: "VAT",
      trn: "100123456700003", frequency: "QUARTERLY", firstPeriodEndMonth: 2,
      registeredOn: "2025-01-01",
    });
    expect(created.frequency).toBe("QUARTERLY");
    expect(created.firstPeriodEndMonth).toBe(2);
    expect(created.trn).toBe("100123456700003");

    // Amended, not duplicated: a second VAT registration for one entity would
    // mean two sets of tax periods and no way to say which a filing belongs to.
    const amended = await recordRegistration({
      orgId: ORG, entityId: ENT, regime: "VAT",
      trn: "100123456700003", frequency: "MONTHLY", firstPeriodEndMonth: 1,
      registeredOn: "2025-01-01",
    });
    expect(amended.id).toBe(created.id);
    expect(amended.frequency).toBe("MONTHLY");

    // Back to the quarterly stagger the rest of these tests use.
    await recordRegistration({
      orgId: ORG, entityId: ENT, regime: "VAT",
      trn: "100123456700003", frequency: "QUARTERLY", firstPeriodEndMonth: 2,
      registeredOn: "2025-01-01",
    });
    const read = await getRegistration({ orgId: ORG, entityId: ENT });
    expect(read?.frequency).toBe("QUARTERLY");
  });

  it("refuses a TRN that is not fifteen digits, and says where the missing one usually went", async () => {
    await expect(recordRegistration({
      orgId: ORG, entityId: ENT, regime: "EXCISE", trn: "10012345670000",
      frequency: "MONTHLY", firstPeriodEndMonth: 1,
    })).rejects.toThrow(/leading zero/i);
  });

  it("records a filing against the period it covers", async () => {
    const filed = await recordFiling({
      orgId: ORG, entityId: ENT, periodLabel: "Mar-May 2026",
      filedOn: "2026-06-20", filedBy: "u-1", reference: "FTA-99", netVatMinor: 4_000_00,
      asOf: "2026-07-01",
    });
    expect(filed.periodFrom).toBe("2026-03-01");
    expect(filed.periodTo).toBe("2026-05-31");
    expect(filed.dueOn).toBe("2026-06-28");
    expect(filed.netVatMinor).toBe("400000");

    const read = await filingFor({ orgId: ORG, entityId: ENT, periodLabel: "Mar-May 2026" });
    expect(read?.filedOn).toBe("2026-06-20");
    expect(read?.reference).toBe("FTA-99");
  });

  it("refuses a filing for a period that has not ended", async () => {
    // Jun-Aug 2026 is still running on 1 July. There is nothing to file: the
    // supplies of July and August have not happened yet.
    await expect(recordFiling({
      orgId: ORG, entityId: ENT, periodLabel: "Jun-Aug 2026", asOf: "2026-07-01",
    })).rejects.toThrow(/has not ended/i);
  });

  it("refuses a filing dated before the period it covers had ended", async () => {
    await expect(recordFiling({
      orgId: ORG, entityId: ENT, periodLabel: "Jun-Aug 2026", filedOn: "2026-08-30", asOf: "2026-10-01",
    })).rejects.toThrow(/only ended on 2026-08-31/);
  });

  it("refuses a second filing for a period already filed", async () => {
    await expect(recordFiling({
      orgId: ORG, entityId: ENT, periodLabel: "Mar-May 2026", filedOn: "2026-06-25", asOf: "2026-07-01",
    })).rejects.toThrow(/voluntary disclosure/i);
  });

  it("refuses a period label that is not one of this registration's periods", async () => {
    // "2026 Q2" is the calendar quarter three other modules used to assume.
    // This registrant does not have one.
    await expect(recordFiling({
      orgId: ORG, entityId: ENT, periodLabel: "2026 Q2", asOf: "2026-07-01",
    })).rejects.toThrow(/not a tax period of this registration/i);
  });

  it("lists what is outstanding and how late each one is", async () => {
    // As at 1 October 2026 the registrant has had four periods end since it
    // registered on 1 January 2025 that fall in this window: the ones ending
    // Feb 2025 through Aug 2026. Mar-May 2026 is filed, so it is not listed.
    const out = await outstandingReturns({ orgId: ORG, entityId: ENT, asOf: "2026-10-01" });
    expect(out.registered).toBe(true);
    const labels = out.periods.map((p) => p.label);
    expect(labels).toContain("Jun-Aug 2026");
    expect(labels).not.toContain("Mar-May 2026");
    // A period still running is not outstanding — there is nothing to file yet.
    expect(labels).not.toContain("Sep-Nov 2026");

    // Jun-Aug 2026 ended on 31 August and was due on 28 September, so on
    // 1 October it is three days late.
    const jun = out.periods.find((p) => p.label === "Jun-Aug 2026")!;
    expect(jun.dueOn).toBe("2026-09-28");
    expect(jun.daysOverdue).toBe(3);
    expect(jun.overdue).toBe(true);
  });

  it("says it does not know, rather than guessing, for an entity with no registration", async () => {
    const out = await outstandingReturns({ orgId: ORG, entityId: "t-ent-unregistered", asOf: "2026-10-01" });
    expect(out.registered).toBe(false);
    expect(out.periods).toEqual([]);
    expect(out.note).toMatch(/cannot say/i);
    expect(await getRegistration({ orgId: ORG, entityId: "t-ent-unregistered" })).toBeNull();
  });

  it("refuses to record a filing at all where no registration says what the periods are", async () => {
    await expect(recordFiling({
      orgId: ORG, entityId: "t-ent-unregistered", periodLabel: "Mar-May 2026", asOf: "2026-07-01",
    })).rejects.toThrow(/No VAT registration is recorded/i);
  });
});
