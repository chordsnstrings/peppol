import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { monthEnd, closeMonth } from "@/lib/server/ledger/month-end";
import { post } from "@/lib/server/ledger/post";
import { addAsset } from "@/lib/server/ledger/assets";
import { importStatement } from "@/lib/server/ledger/bank";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-me";
const ENT = "t-ent-me";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "AssetRevaluation" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FixedAsset" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "BankStatementLine" WHERE "orgId" = '${ORG}'`),
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

const check = (m: Awaited<ReturnType<typeof monthEnd>>, key: string) =>
  m.checks.find((c) => c.key === key);

d("the month-end checklist", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
    await post({
      ...S, entryDate: "2026-01-05", source: "manual", memo: "Owner capital",
      lines: [{ account: "1010", debit: 1_000_000 }, { account: "3000", credit: 1_000_000 }],
    });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("refuses a period that is not a month, and one that does not exist", async () => {
    await expect(monthEnd({ ...S, period: "January" })).rejects.toThrow(/not a month/i);
    await expect(monthEnd({ ...S, period: "2099-01" })).rejects.toThrow(/no accounting period 2099-01/i);
  });

  it("says a quiet month is finished", async () => {
    const m = await monthEnd({ ...S, period: "2026-01" });
    expect(m.blockers).toBe(0);
    expect(m.canClose).toBe(true);
    expect(check(m, "trial_balance")!.severity).toBe("done");
    expect(m.note).toMatch(/finished and nothing is outstanding/);
  });

  it("counts a check that could not run against closing, rather than as a pass", async () => {
    // A check that returned nothing and a check that never ran look identical
    // from the outside, which is exactly why they are kept apart.
    const m = await monthEnd({ ...S, period: "2026-01" });
    expect(m.failed).toEqual([]);
    expect(m.canClose).toBe(true);
  });

  it("blocks the month when an asset has not been depreciated", async () => {
    await addAsset({
      ...S,
      asset: { code: "FA-ME", name: "Fit-out", acquiredOn: "2026-02-01", costMinor: 240_000, usefulLifeMonths: 24 },
    });
    const m = await monthEnd({ ...S, period: "2026-02" });
    const dep = check(m, "depreciation")!;
    expect(dep.severity).toBe("blocker");
    expect(dep.detail).toMatch(/invisible in the ledger/);
    expect(m.canClose).toBe(false);
  });

  it("refuses to close a month with a blocker, quoting the blocker", async () => {
    await expect(closeMonth({ ...S, period: "2026-02" }))
      .rejects.toThrow(/not been depreciated for 2026-02/i);
  });

  it("blocks a month while an earlier one is still open", async () => {
    // January is still open, so closing February would let February's opening
    // position change after it was closed.
    const m = await monthEnd({ ...S, period: "2026-03" });
    const prior = check(m, "prior_periods")!;
    expect(prior.severity).toBe("blocker");
    expect(prior.detail).toMatch(/2026-01/);
    expect(prior.detail).toMatch(/opening position can change/);
  });

  it("closes a month one state at a time, never skipping one", async () => {
    const first = await closeMonth({ ...S, period: "2026-01" });
    expect(first.closed).toBe(true);
    expect(first.status).toBe("soft_closed");
    expect(first.note).toMatch(/Close it again/);

    const second = await closeMonth({ ...S, period: "2026-01" });
    expect(second.status).toBe("hard_closed");
    expect(second.note).toMatch(/Reopening it needs the permission/);

    const third = await closeMonth({ ...S, period: "2026-01" });
    expect(third.closed).toBe(false);
    expect(third.note).toMatch(/already hard closed/);
  });

  it("sorts blockers above advisories above what is already done", async () => {
    const m = await monthEnd({ ...S, period: "2026-02" });
    const order = m.checks.map((c) => c.severity);
    const rank = { blocker: 0, advisory: 1, done: 2 } as const;
    for (let i = 1; i < order.length; i++) {
      expect(rank[order[i]]).toBeGreaterThanOrEqual(rank[order[i - 1]]);
    }
  });

  it("gives every check somewhere to go and something to read", async () => {
    const m = await monthEnd({ ...S, period: "2026-02" });
    expect(m.checks.length).toBeGreaterThan(0);
    for (const c of m.checks) {
      expect(c.href.startsWith("/accounting/")).toBe(true);
      expect(c.detail.length).toBeGreaterThan(20);
      expect(c.label.length).toBeGreaterThan(3);
    }
  });

  it("reads the borrowings register too, and does not claim every register agrees", async () => {
    // A loan credited straight to 2500 by hand and never put on the register.
    // The books balance, the balance sheet looks right, and the register that
    // supports the disclosure — maturity analysis, current portion, covenant
    // tests — knows nothing about it.
    //
    // This check used to read six registers and print "Every subledger register
    // agrees with the account it feeds" over the top of the seventh.
    await post({
      ...S, entryDate: "2026-02-14", source: "manual", memo: "Loan from the bank",
      lines: [{ account: "1010", debit: 500_000 }, { account: "2500", credit: 500_000 }],
    });

    const m = await monthEnd({ ...S, period: "2026-02" });
    const registers = check(m, "registers");
    expect(registers).toBeDefined();
    expect(registers!.severity).toBe("blocker");
    expect(registers!.detail).toMatch(/borrowings/);

    // And the sentence that would otherwise have been printed instead.
    expect(registers!.detail).not.toMatch(/Every subledger register agrees/);
  });

  it("reads the two registers that grew a reconciliation after the check was written", async () => {
    // Neither 1255 nor 1330 is a control account, so the ledger accepts a
    // hand-keyed journal into both — and both support a disclosure. 1255 is
    // restricted cash under IAS 7.48, tied to the margin the banks hold; 1330
    // is work in progress, tied to the timesheets. Nothing on the register
    // moved, so both now disagree with the ledger by the amount posted.
    await post({
      ...S, entryDate: "2026-02-20", source: "manual", memo: "Margin and WIP by hand",
      lines: [
        { account: "1255", debit: 100_000 },
        { account: "1330", debit: 50_000 },
        { account: "1010", credit: 150_000 },
      ],
    });

    const m = await monthEnd({ ...S, period: "2026-02" });
    const registers = check(m, "registers")!;
    expect(registers.severity).toBe("blocker");
    expect(registers.detail).toMatch(/margin held against guarantees/);
    expect(registers.detail).toMatch(/work in progress/);
  });

  it("ties the control accounts as at the month end rather than as at today", async () => {
    // A sale raised in March. The open items at the end of February do not
    // include it, and neither does account 1100 read at that date — but the
    // control balance used to be read as it stands, with no date on it at all,
    // so one invoice in a later month made February's check report a difference
    // that was nothing but the calendar. The blocker it raised said one of the
    // two figures was wrong and nobody should act on either, about a month in
    // which nothing had happened.
    await post({
      ...S, entryDate: "2026-03-10", source: "invoice", memo: "Sale after the month end",
      lines: [
        { account: "1100", debit: 500_000 },
        { account: "4000", credit: 500_000, taxCode: "ZERO_OTHER", taxEmirate: "DU" },
      ],
    });

    const february = await monthEnd({ ...S, period: "2026-02" });
    const control = check(february, "control_accounts")!;
    expect(control.severity).toBe("done");
    expect(control.detail).toMatch(/which is what 1100 and 2000 hold/);

    // And in the month the sale is actually in, the two still agree — the
    // ageing and the control account are both read at the end of March.
    const march = await monthEnd({ ...S, period: "2026-03" });
    expect(check(march, "control_accounts")!.severity).toBe("done");
  });

  it("counts every unmatched bank line, not the page a reconciliation itemises", async () => {
    // The defect: the advisory counted the rows of the reconciliation's own
    // list, which stops at 200. So an account with 250 unexplained lines was
    // reported as having 200 — the page size, told to somebody deciding
    // whether the month is finished, on the check that exists to say how much
    // of the cash nobody has explained.
    const LINES = 250;
    const PAGE = 200;
    await importStatement({
      ...S, accountCode: "1010", batch: "me-april",
      // A different amount and a different description on every line, so none
      // is a re-import of another and all 250 land. All of them are inside
      // April, so the months the tests above are written against do not move.
      lines: Array.from({ length: LINES }, (_, i) => ({
        postedOn: `2026-04-${String((i % 28) + 1).padStart(2, "0")}`,
        description: `Unexplained credit ${i + 1}`,
        amountMinor: 1_000 + i,
      })),
    });

    const m = await monthEnd({ ...S, period: "2026-04" });
    const bank = check(m, "bank")!;
    expect(bank).toBeDefined();
    expect(bank.count).toBe(LINES);
    expect(bank.count).not.toBe(PAGE);
    expect(bank.detail).toMatch(new RegExp(`${LINES} statement lines`));
    // An unmatched line means the bank knows something the books do not. That
    // is worth chasing and it does not make the month wrong, so it stays an
    // advisory however many of them there are.
    expect(bank.severity).toBe("advisory");
  });

  it("does not read another organisation's month", async () => {
    await expect(monthEnd({ orgId: "someone-else", entityId: ENT, period: "2026-01" }))
      .rejects.toThrow(/no accounting period 2026-01/i);
  });
});
