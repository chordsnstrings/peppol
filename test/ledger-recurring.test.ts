import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createTemplate,
  updateTemplate,
  pauseTemplate,
  resumeTemplate,
  endTemplate,
  dueTemplates,
  runRecurring,
  templateStatus,
  assessDue,
  normaliseLines,
  type RecurringRow,
} from "@/lib/server/ledger/recurring";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-rec";
const ENT = "t-ent-rec";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "RecurringJournal" WHERE "orgId" = '${ORG}'`),
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

const T = (over: Partial<Parameters<typeof createTemplate>[0]["template"]> = {}) =>
  createTemplate({
    orgId: ORG,
    entityId: ENT,
    template: {
      code: "RENT",
      name: "Office rent",
      frequency: "MONTHLY",
      kind: "STANDING",
      startsOn: "2026-01-01",
      lines: [
        { account: "6100", debit: 1_500_000 },
        { account: "1010", credit: 1_500_000 },
      ],
      ...over,
    },
  });

const run = (period: string) => runRecurring({ orgId: ORG, entityId: ENT, period });
const skipReason = (r: { skipped: { code: string; reason: string }[] }, code: string) =>
  r.skipped.find((s) => s.code === code)?.reason;
const postedRow = (r: Awaited<ReturnType<typeof run>>, code: string) => r.posted.find((p) => p.code === code);

/* ------------------------------------------------------ pure, no database */

const ROW = (over: Partial<RecurringRow> = {}): RecurringRow => ({
  id: "t1", orgId: ORG, entityId: ENT, code: "X", name: "X",
  frequency: "MONTHLY", startsOn: new Date("2026-01-01"), endsOn: null,
  runCount: 0, lastRunPeriod: null, lines: "[]", kind: "STANDING",
  autoReverse: false, status: "active", ...over,
});
const idx = (label: string) => {
  const [y, m] = label.split("-").map(Number);
  return y * 12 + (m - 1);
};

describe("when a template is due", () => {
  it("is due in its own month and not before it starts", () => {
    expect(assessDue(ROW(), idx("2026-01")).due).toBe(true);
    expect(assessDue(ROW(), idx("2025-12")).reason).toMatch(/does not start until 2026-01/);
  });

  it("skips the months between quarters", () => {
    const q = ROW({ frequency: "QUARTERLY" });
    expect(assessDue(q, idx("2026-02")).due).toBe(false);
    expect(assessDue(q, idx("2026-02")).reason).toMatch(/the next one is 2026-04/);
    expect(assessDue(q, idx("2026-04")).due).toBe(true);
  });

  it("refuses to catch up a missed month, and names the months to run", () => {
    const behind = ROW({ lastRunPeriod: "2026-01" });
    expect(assessDue(behind, idx("2026-04")).reason).toMatch(/run the months in between \(2026-02, 2026-03\)/);
    expect(assessDue(behind, idx("2026-02")).due).toBe(true);
  });
});

describe("template lines as they are read in", () => {
  it("refuses a fractional amount, because a ledger has no fractions of a fil", () => {
    expect(() => normaliseLines([{ account: "6100", debit: 1500.5 }], "template X"))
      .toThrow(/whole number of minor units/);
  });

  it("refuses a line carrying both a debit and a credit", () => {
    expect(() => normaliseLines([{ account: "6100", debit: 100, credit: 100 }], "template X"))
      .toThrow(/exactly one of debit or credit/);
  });

  it("stores amounts as digits, never as numbers that could lose precision", () => {
    expect(normaliseLines([{ account: "6100", debit: 1_500_000 }], "template X"))
      .toEqual([{ account: "6100", debit: "1500000" }]);
  });
});

/* ------------------------------------------------------------- the ledger */

d("recurring journals", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ---- saving is where a template is judged -------------------------- */

  it("refuses a template that does not balance, when it is saved", async () => {
    await expect(T({
      code: "BAD-BAL",
      lines: [{ account: "6100", debit: 1_500_000 }, { account: "1010", credit: 1_400_000 }],
    })).rejects.toThrow(/does not balance.*out by 1000\.00/s);
    // And nothing was stored: the failure is at save time, not every month at
    // midnight for the rest of the year.
    expect(await db.recurringJournal.count({ where: { orgId: ORG, code: "BAD-BAL" } })).toBe(0);
  });

  it("refuses a control account, by name", async () => {
    await expect(T({
      code: "BAD-CTL",
      lines: [{ account: "1100", debit: 100_000 }, { account: "4100", credit: 100_000 }],
    })).rejects.toThrow(/1100 Trade receivables is a control account/);
  });

  it("refuses a heading, and refuses a single line", async () => {
    await expect(T({
      code: "BAD-HEAD",
      lines: [{ account: "10", debit: 100 }, { account: "1010", credit: 100 }],
    })).rejects.toThrow(/is a heading, not a postable account/);
    await expect(T({ code: "BAD-ONE", lines: [{ account: "6100", debit: 100 }] }))
      .rejects.toThrow(/at least two lines/);
  });

  it("refuses to reverse a prepayment release, which would undo the only thing it does", async () => {
    await expect(T({ code: "BAD-PRE", kind: "PREPAYMENT", autoReverse: true }))
      .rejects.toThrow(/prepayment release is not reversed/);
  });

  it("saves the standing charges, and turns reversal on for an accrual by itself", async () => {
    const rent = await T();
    expect(rent.autoReverse).toBe(false);
    expect(JSON.parse(rent.lines)).toEqual([
      { account: "6100", debit: "1500000" },
      { account: "1010", credit: "1500000" },
    ]);

    await T({ code: "SUB", name: "Software subscription", frequency: "QUARTERLY",
      lines: [{ account: "6250", debit: 300_000 }, { account: "1010", credit: 300_000 }] });

    // An accrual reverses unless somebody deliberately says otherwise.
    const util = await T({
      code: "UTIL", name: "Utilities accrual", kind: "ACCRUAL", startsOn: "2026-02-01",
      lines: [{ account: "6150", debit: 90_000 }, { account: "2050", credit: 90_000 }],
    });
    expect(util.autoReverse).toBe(true);

    // A prepayment released over the three months it covers.
    await T({
      code: "INS", name: "Insurance released from prepayments", kind: "PREPAYMENT",
      startsOn: "2026-01-01", endsOn: "2026-03-31",
      lines: [{ account: "6500", debit: 50_000 }, { account: "1300", credit: 50_000 }],
    });

    await T({ code: "LATE", name: "Cleaning contract",
      lines: [{ account: "6450", debit: 40_000 }, { account: "1010", credit: 40_000 }] });
    await T({ code: "SHORT", name: "Short-lived licence", endsOn: "2026-02-28",
      lines: [{ account: "6300", debit: 20_000 }, { account: "1010", credit: 20_000 }] });

    expect(await db.recurringJournal.count({ where: { orgId: ORG } })).toBe(6);
  });

  it("refuses a second template with the same code", async () => {
    await expect(T()).rejects.toThrow(/already a recurring template with the code RENT/);
  });

  /* ---- January ------------------------------------------------------- */

  it("posts a monthly standing charge once, as its own journal", async () => {
    const r = await run("2026-01");
    const rent = postedRow(r, "RENT")!;
    expect(rent.reference).toMatch(/^RJ-/);
    expect(rent.amountMinor).toBe("1500000");
    expect(rent.reversalEntryId).toBeNull();

    const lines = await db.journalLine.findMany({
      where: { entryId: rent.entryId }, include: { account: true }, orderBy: { lineNo: "asc" },
    });
    expect(lines.map((l) => [l.account.code, l.txnAmountMinor.toString()]))
      .toEqual([["6100", "1500000"], ["1010", "-1500000"]]);

    // Each template posts its own journal, not one combined entry.
    expect(new Set(r.posted.map((p) => p.entryId)).size).toBe(r.posted.length);
    expect(r.posted.map((p) => p.code).sort()).toEqual(["INS", "LATE", "RENT", "SHORT", "SUB"]);
    // UTIL does not start until February.
    expect(skipReason(r, "UTIL")).toMatch(/does not start until 2026-02/);
  });

  it("is a no-op when the same period is run again", async () => {
    const before = await db.journalEntry.count({ where: { orgId: ORG } });
    const r = await run("2026-01");
    expect(r.templatesPosted).toBe(0);
    expect(skipReason(r, "RENT")).toMatch(/already run for 2026-01/);
    expect(await db.journalEntry.count({ where: { orgId: ORG } })).toBe(before);
    const rent = await db.recurringJournal.findFirst({ where: { orgId: ORG, code: "RENT" } });
    expect(rent?.runCount).toBe(1);
  });

  /* ---- February: the accrual ----------------------------------------- */

  it("skips a paused template, and says so", async () => {
    await pauseTemplate({ orgId: ORG, entityId: ENT, code: "LATE" });
    const r = await run("2026-02");
    expect(skipReason(r, "LATE")).toMatch(/it is paused\. Resume it/);
    expect(postedRow(r, "LATE")).toBeUndefined();
  });

  it("does not post a quarterly template in the months between", async () => {
    // February ran above; SUB is quarterly from January, so it is not due.
    const feb = await dueTemplates({ orgId: ORG, entityId: ENT, period: "2026-02" });
    expect(feb.due.map((t) => t.code)).not.toContain("SUB");
    expect(skipReason(feb, "SUB")).toMatch(/the next one is 2026-04/);
    const subEntries = await db.journalEntry.count({
      where: { orgId: ORG, sourceType: "RECURRING_JOURNAL", entryDate: new Date("2026-02-28"), memo: { startsWith: "SUB " } },
    });
    expect(subEntries).toBe(0);
  });

  it("reverses an accrual on the first day of the next period", async () => {
    const util = await db.recurringJournal.findFirst({ where: { orgId: ORG, code: "UTIL" } });
    const entry = await db.journalEntry.findFirst({
      where: { orgId: ORG, externalKey: `recurring:${util!.id}:2026-02` },
      include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } } },
    });
    expect(entry!.entryDate.toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(entry!.lines.map((l) => [l.account.code, l.txnAmountMinor.toString()]))
      .toEqual([["6150", "90000"], ["2050", "-90000"]]);

    const reversal = await db.journalEntry.findFirst({
      where: { orgId: ORG, externalKey: `recurring:${util!.id}:2026-02:reversal` },
      include: { lines: { include: { account: true }, orderBy: { lineNo: "asc" } } },
    });
    // The release lands on the first day of March — not the last day of
    // February, or the cost would still sit in the month it was accrued.
    expect(reversal!.entryDate.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect(reversal!.reversalOfId).toBe(entry!.id);
    expect(reversal!.lines.map((l) => [l.account.code, l.txnAmountMinor.toString()]))
      .toEqual([["6150", "-90000"], ["2050", "90000"]]);

    // The accrual itself is still a posted entry. It was the right entry for
    // February; releasing it next month is not a correction of it.
    expect(entry!.status).toBe("posted");
  });

  it("cannot post the release twice, even if the run is replayed", async () => {
    const util = await db.recurringJournal.findFirst({ where: { orgId: ORG, code: "UTIL" } });
    const before = await db.journalEntry.count({ where: { orgId: ORG } });
    // Simulate a run that posted but died before it could record that it had:
    // re-running the period must find the journals, not write them again.
    await db.recurringJournal.update({ where: { id: util!.id }, data: { lastRunPeriod: null } });

    const r = await run("2026-02");
    const row = postedRow(r, "UTIL")!;
    expect(row.alreadyPosted).toBe(true);
    expect(row.reversalReference).not.toBeNull();
    expect(row.reversesOn).toBe("2026-03-01");
    expect(await db.journalEntry.count({ where: { orgId: ORG } })).toBe(before);

    const after = await db.recurringJournal.findFirst({ where: { orgId: ORG, code: "UTIL" } });
    expect(after?.lastRunPeriod).toBe("2026-02");
    expect(after?.runCount).toBe(1); // a replay is not a second run
  });

  /* ---- March: what stops, and what is unreadable ---------------------- */

  it("stops a template that is past its end date, and reports unreadable lines by name", async () => {
    // A template whose stored JSON has been damaged must name itself; a parse
    // error is not something a bookkeeper can act on.
    const broken = await T({ code: "BROKEN", name: "Damaged template",
      lines: [{ account: "6900", debit: 10_000 }, { account: "1010", credit: 10_000 }] });
    await db.recurringJournal.update({ where: { id: broken.id }, data: { lines: "[{\"account\":\"6900\"," } });

    const r = await run("2026-03");
    expect(skipReason(r, "SHORT")).toMatch(/ended after 2026-02/);
    expect(skipReason(r, "BROKEN")).toMatch(/template BROKEN \(Damaged template\)/);
    expect(skipReason(r, "BROKEN")).toMatch(/not readable JSON/);
    expect(skipReason(r, "BROKEN")).not.toMatch(/JSON\.parse|Unexpected token/);
    // One damaged template does not take the month's other postings with it.
    expect(postedRow(r, "RENT")).toBeDefined();
    expect(postedRow(r, "INS")).toBeDefined();
  });

  it("refuses to catch a resumed template up, and says which months to run", async () => {
    await resumeTemplate({ orgId: ORG, entityId: ENT, code: "LATE" });
    // LATE last ran for January; February and March went by while it was paused.
    const r = await run("2026-04");
    expect(skipReason(r, "LATE")).toMatch(/last ran for 2026-01/);
    expect(skipReason(r, "LATE")).toMatch(/run the months in between \(2026-02, 2026-03\) first/);
    expect(postedRow(r, "LATE")).toBeUndefined();
    // The quarterly one, however, is due again in April.
    expect(postedRow(r, "SUB")?.amountMinor).toBe("300000");
  });

  /* ---- what the screen says ------------------------------------------ */

  it("reports what last ran, what is next and what is behind", async () => {
    const s = await templateStatus({ orgId: ORG, entityId: ENT, asOf: "2026-04" });
    const late = s.templates.find((t) => t.code === "LATE")!;
    expect(late.lastRunPeriod).toBe("2026-01");
    expect(late.nextDuePeriod).toBe("2026-02");
    expect(late.behind).toBe(true);
    expect(late.periodsDue).toBe(3); // February, March and April

    const sub = s.templates.find((t) => t.code === "SUB")!;
    expect(sub.nextDuePeriod).toBe("2026-07");
    expect(sub.behind).toBe(false);

    const short = s.templates.find((t) => t.code === "SHORT")!;
    expect(short.nextDuePeriod).toBeNull(); // it has finished

    const broken = s.templates.find((t) => t.code === "BROKEN")!;
    expect(broken.lines).toBeNull();
    expect(broken.problem).toMatch(/not readable JSON/);
    expect(broken.amountMinor).toBeNull();

    expect(s.behindCount).toBeGreaterThanOrEqual(1);
  });

  it("edits a template without touching what it already posted", async () => {
    const janEntry = await db.journalEntry.findFirst({
      where: { orgId: ORG, memo: { startsWith: "RENT " }, entryDate: new Date("2026-01-31") },
      include: { lines: true },
    });
    await updateTemplate({
      orgId: ORG, entityId: ENT, code: "RENT",
      patch: { name: "Office rent (Business Bay)", lines: [
        { account: "6100", debit: 1_800_000 }, { account: "1010", credit: 1_800_000 },
      ] },
    });
    const again = await db.journalEntry.findFirst({
      where: { id: janEntry!.id }, include: { lines: true },
    });
    // The January journal still says 15,000 — an entry whose meaning changed
    // when somebody edited a template is an entry nobody can audit.
    expect(again!.lines.map((l) => l.txnAmountMinor.toString()).sort())
      .toEqual(janEntry!.lines.map((l) => l.txnAmountMinor.toString()).sort());
    expect(again!.memo).toBe("RENT Office rent — 2026-01");

    await expect(updateTemplate({
      orgId: ORG, entityId: ENT, code: "RENT",
      patch: { lines: [{ account: "6100", debit: 1 }, { account: "1010", credit: 2 }] },
    })).rejects.toThrow(/does not balance/);
  });

  /* ---- and it all still ties ----------------------------------------- */

  it("nets an accrual against its release, and leaves the trial balance tied", async () => {
    // The accrual ran for February, March and April; each release lands in the
    // month after the one it was accrued in, so the last of them is dated
    // 1 May. Ending the template stops May accruing anything new.
    await endTemplate({ orgId: ORG, entityId: ENT, code: "UTIL", endsOn: "2026-04-30" });
    const r = await run("2026-05");
    expect(skipReason(r, "UTIL")).toMatch(/ended|no longer posts/);

    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-05" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);

    // Three accruals, three releases. The liability is back to nothing, and the
    // cost sat in each month it belonged to rather than in one of them twice.
    const accrued = tb.rows.find((row) => row.code === "2050");
    expect(accrued ? accrued.balanceMinor : 0n).toBe(0n);
    const expense = tb.rows.find((row) => row.code === "6150")!;
    expect(expense.balanceMinor).toBe(0n);
  });

  it("refuses a period that is not a month", async () => {
    await expect(run("Q1")).rejects.toThrow(/looks like 2026-03/);
    await expect(run("2026-13")).rejects.toThrow(/no month 13/);
  });
});
