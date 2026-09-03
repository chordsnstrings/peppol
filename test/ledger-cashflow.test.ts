import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post } from "@/lib/server/ledger/post";
import { profitAndLoss } from "@/lib/server/ledger/statements";
import { cashFlowStatement, CLASSIFICATION, CASH_CODES } from "@/lib/server/ledger/cashflow";
import { openBooks, openFiscalYear, UAE_CHART } from "@/lib/server/ledger/setup";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-cf";
const ENT = "t-ent-cf";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
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

/** Control accounts (AR, AP, VAT) refuse a manual journal, so those postings
 *  come in under the source the subledger would have used. */
const P = (
  entryDate: string,
  lines: { account: string; debit?: number; credit?: number }[],
  memo = "",
  source = "manual",
) => post({ orgId: ORG, entityId: ENT, entryDate, memo, source, lines });

const CF = (from: string, to: string) => cashFlowStatement({ orgId: ORG, entityId: ENT, from, to });

d("cash flow statement", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // An account the cash flow classification has never heard of. A user adding
    // one to their chart is exactly how a real statement stops reconciling.
    await db.account.create({
      data: {
        orgId: ORG, entityId: ENT, code: "1450", name: "Director's suspense",
        nameAr: "حساب معلق", type: "ASSET", isPostable: true,
      },
    });

    // One month, one kind of transaction, so each test can take its own window.
    // January — capital introduced.
    await P("2026-01-05", [{ account: "1010", debit: 5_000_000 }, { account: "3000", credit: 5_000_000 }], "Share capital");
    // February — a sale settled in cash.
    await P("2026-02-10", [{ account: "1010", debit: 1_200_000 }, { account: "4000", credit: 1_200_000 }], "Cash sale");
    // March — a sale on credit, so profit is earned but no cash arrives.
    await P("2026-03-10", [{ account: "1100", debit: 800_000 }, { account: "4100", credit: 800_000 }], "Invoiced sale", "invoice");
    // April — rent taken on credit, so the cost is borne but no cash leaves.
    await P("2026-04-10", [{ account: "6100", debit: 300_000 }, { account: "2000", credit: 300_000 }], "Rent on account", "bill");
    // May — a fixed asset bought for cash.
    await P("2026-05-10", [{ account: "1500", debit: 2_000_000 }, { account: "1010", credit: 2_000_000 }], "Delivery van");
    // June — depreciation, a charge against profit that moves no cash.
    await P("2026-06-30", [{ account: "6600", debit: 100_000 }, { account: "1590", credit: 100_000 }], "Depreciation");
    // July — a loan drawn down.
    await P("2026-07-15", [{ account: "1010", debit: 1_000_000 }, { account: "2500", credit: 1_000_000 }], "Bank loan");
    // August — cash paid out to an account nothing knows how to classify.
    await P("2026-08-12", [{ account: "1450", debit: 250_000 }, { account: "1010", credit: 250_000 }], "Unexplained payment");
    // September — the van sold for more than its written-down value.
    await P("2026-09-20", [
      { account: "1010", debit: 2_050_000 },
      { account: "1590", debit: 100_000 },
      { account: "1500", credit: 2_000_000 },
      { account: "4900", credit: 150_000 },
    ], "Sale of the van");
    // November — an unrealised gain on revaluing a foreign currency receivable.
    await P("2026-11-30", [{ account: "1100", debit: 50_000 }, { account: "4950", credit: 50_000 }], "FX revaluation", "fx");
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("shows a cash sale as an operating inflow, and reconciles", async () => {
    const cf = await CF("2026-02-01", "2026-02-28");
    expect(cf.operating.totalMinor).toBe("1200000");
    expect(cf.investing.totalMinor).toBe("0");
    expect(cf.financing.totalMinor).toBe("0");
    expect(cf.netCashMovementMinor).toBe("1200000");
    expect(cf.cashMovementPerLedgerMinor).toBe("1200000");
    expect(cf.reconciles).toBe(true);
    expect(cf.differenceMinor).toBe("0");
    expect(cf.warnings).toEqual([]);
  });

  it("puts an increase in receivables below the profit that created it", async () => {
    const cf = await CF("2026-03-01", "2026-03-31");
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: "2026-03-31" });
    expect(pl.netProfitMinor).toBe("800000");
    const receivables = cf.operating.lines.find((l) => l.code === "1100")!;
    // The sign AND the word, because a sign on its own is what gets misread.
    expect(receivables.amountMinor).toBe("-800000");
    expect(receivables.direction).toBe("use");
    expect(receivables.movementMinor).toBe("800000");
    // Profit 800,000, cash nil.
    expect(BigInt(cf.operating.totalMinor)).toBeLessThan(BigInt(pl.netProfitMinor));
    expect(cf.operating.totalMinor).toBe("0");
    expect(cf.reconciles).toBe(true);
  });

  it("puts an increase in payables above the loss that created it", async () => {
    const cf = await CF("2026-04-01", "2026-04-30");
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-04-01", to: "2026-04-30" });
    expect(pl.netProfitMinor).toBe("-300000");
    const payables = cf.operating.lines.find((l) => l.code === "2000")!;
    expect(payables.amountMinor).toBe("300000");
    expect(payables.direction).toBe("source");
    expect(payables.movementMinor).toBe("-300000"); // a credit, as the ledger holds it
    expect(BigInt(cf.operating.totalMinor)).toBeGreaterThan(BigInt(pl.netProfitMinor));
    expect(cf.operating.totalMinor).toBe("0");
    expect(cf.reconciles).toBe(true);
  });

  it("adds depreciation back in operating and leaves nothing of it in investing", async () => {
    const cf = await CF("2026-06-01", "2026-06-30");
    const addBack = cf.operating.lines.find((l) => l.code === "6600")!;
    expect(addBack.amountMinor).toBe("100000");
    expect(addBack.direction).toBe("source");
    expect(cf.operating.totalMinor).toBe("0"); // the loss and the add-back cancel
    // Accumulated depreciation moved, but none of it is an investing flow.
    expect(cf.investing.lines.find((l) => l.code === "1590")).toBeUndefined();
    expect(cf.investing.totalMinor).toBe("0");
    expect(cf.reconciles).toBe(true);
  });

  it("puts the purchase of a fixed asset in investing, not operating", async () => {
    const cf = await CF("2026-05-01", "2026-05-31");
    const van = cf.investing.lines.find((l) => l.code === "1500")!;
    expect(van.amountMinor).toBe("-2000000");
    expect(van.direction).toBe("use");
    expect(cf.investing.totalMinor).toBe("-2000000");
    expect(cf.operating.totalMinor).toBe("0");
    expect(cf.reconciles).toBe(true);
  });

  it("puts share capital in financing", async () => {
    const cf = await CF("2026-01-01", "2026-01-31");
    const capital = cf.financing.lines.find((l) => l.code === "3000")!;
    expect(capital.amountMinor).toBe("5000000");
    expect(capital.direction).toBe("source");
    expect(cf.financing.totalMinor).toBe("5000000");
    expect(cf.operating.totalMinor).toBe("0");
    expect(cf.investing.totalMinor).toBe("0");
    expect(cf.reconciles).toBe(true);
  });

  it("puts a loan drawdown in financing", async () => {
    const cf = await CF("2026-07-01", "2026-07-31");
    expect(cf.financing.lines.find((l) => l.code === "2500")?.amountMinor).toBe("1000000");
    expect(cf.financing.totalMinor).toBe("1000000");
    expect(cf.reconciles).toBe(true);
  });

  it("sums the three sections to the movement on the cash accounts", async () => {
    // Seven months of trading, financing and investing together.
    const cf = await CF("2026-01-01", "2026-07-31");
    expect(cf.operating.totalMinor).toBe("1200000");
    expect(cf.investing.totalMinor).toBe("-2000000");
    expect(cf.financing.totalMinor).toBe("6000000");
    expect(cf.netCashMovementMinor).toBe("5200000");
    expect(cf.cashMovementPerLedgerMinor).toBe("5200000");
    expect(cf.reconciles).toBe(true);
    expect(cf.differenceMinor).toBe("0");
  });

  it("opening cash plus the net movement equals closing cash", async () => {
    const cf = await CF("2026-02-01", "2026-02-28");
    expect(cf.openingCashMinor).toBe("5000000"); // January's capital
    expect(cf.closingCashMinor).toBe("6200000");
    expect(BigInt(cf.openingCashMinor) + BigInt(cf.netCashMovementMinor)).toBe(BigInt(cf.closingCashMinor));
    // And the cash accounts are shown one by one, so the total can be checked.
    const bank = cf.cashAccounts.find((a) => a.code === "1010")!;
    expect(bank.movementMinor).toBe("1200000");
    expect(bank.closingMinor).toBe("6200000");
  });

  it("names an account it cannot classify, and refuses to reconcile without it", async () => {
    const cf = await CF("2026-08-01", "2026-08-31");
    // Both halves matter: the warning is what makes the failure fixable, and
    // the failure is what stops the warning being ignored.
    expect(cf.warnings.some((w) => w.includes("1450") && w.includes("Director's suspense"))).toBe(true);
    expect(cf.reconciles).toBe(false);
    expect(cf.differenceMinor).toBe("250000");
    // Nothing was invented to make it agree: the sections still total nil.
    expect(cf.netCashMovementMinor).toBe("0");
    expect(cf.cashMovementPerLedgerMinor).toBe("-250000");
    expect(cf.warnings.some((w) => /does not reconcile/i.test(w))).toBe(true);
    // And the unclassified account appears in no section at all.
    const everywhere = [...cf.operating.lines, ...cf.investing.lines, ...cf.financing.lines];
    expect(everywhere.find((l) => l.code === "1450")).toBeUndefined();
  });

  it("shows a disposal as investing proceeds, with the gain taken out of operating", async () => {
    const cf = await CF("2026-09-01", "2026-09-30");
    // Van at cost 2,000,000 less 100,000 depreciation, sold for 2,050,000.
    expect(cf.investing.totalMinor).toBe("2050000");
    // The gain is profit but not operating cash, so operating nets to nil.
    expect(cf.operating.totalMinor).toBe("0");
    const removal = cf.operating.lines.find((l) => l.label.includes("Gain on disposal"))!;
    expect(removal.amountMinor).toBe("-150000");
    expect(cf.reconciles).toBe(true);
    expect(cf.differenceMinor).toBe("0");
  });

  it("takes an unrealised exchange gain back out through the balance it revalued", async () => {
    // The gain raises profit; the movement on the receivable it revalued takes
    // the same amount straight out again. That is why there is no separate
    // unrealised-FX line — a second adjustment would remove the gain twice.
    const cf = await CF("2026-11-01", "2026-11-30");
    const pl = await profitAndLoss({ orgId: ORG, entityId: ENT, from: "2026-11-01", to: "2026-11-30" });
    expect(pl.netProfitMinor).toBe("50000");
    expect(cf.operating.lines.find((l) => l.code === "1100")?.amountMinor).toBe("-50000");
    expect(cf.operating.totalMinor).toBe("0");
    expect(cf.reconciles).toBe(true);
  });

  it("reports a period in which no cash moved at all without inventing one", async () => {
    const cf = await CF("2026-10-01", "2026-10-31");
    expect(cf.netCashMovementMinor).toBe("0");
    expect(cf.cashMovementPerLedgerMinor).toBe("0");
    expect(cf.reconciles).toBe(true);
    expect(cf.openingCashMinor).toBe(cf.closingCashMinor);
    expect(cf.warnings).toEqual([]);
  });

  it("explains the direction of a working capital movement in words, not only in a sign", async () => {
    const cf = await CF("2026-03-01", "2026-03-31");
    const receivables = cf.operating.lines.find((l) => l.code === "1100")!;
    expect(receivables.note).toMatch(/use of cash/i);
    const payables = (await CF("2026-04-01", "2026-04-30")).operating.lines.find((l) => l.code === "2000")!;
    expect(payables.note).toMatch(/source of cash/i);
  });

  it("starts the operating section from the profit for the period", async () => {
    const cf = await CF("2026-02-01", "2026-02-28");
    const first = cf.operating.lines[0];
    expect(first.label).toBe("Profit for the period");
    expect(first.amountMinor).toBe("1200000");
    expect(first.code).toBeNull();
  });

  it("measures the opening position at the day before the period, not its first day", async () => {
    // The January capital was posted on the 5th. A window opening on the 5th
    // must still show nil brought forward, and the receipt as the movement.
    const cf = await CF("2026-01-05", "2026-01-31");
    expect(cf.openingCashMinor).toBe("0");
    expect(cf.netCashMovementMinor).toBe("5000000");
    expect(cf.reconciles).toBe(true);
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(CF("2026-03-31", "2026-03-01")).rejects.toThrow(/ends before it starts/i);
  });

  it("refuses dates it cannot read", async () => {
    await expect(CF("not-a-date", "2026-03-01")).rejects.toThrow(/valid start and end date/i);
  });
});

describe("the classification map against the chart", () => {
  it("classifies every balance-sheet account the standard chart has", () => {
    // The map was written once and the chart went on growing. Every account
    // added since — provisions, contract assets and liabilities, deferred tax,
    // the revaluation surplus, the leave provision — went unclassified, and an
    // unclassified movement is reported as a warning and left out of the
    // statement. This test is what stops it happening again.
    const cash = new Set(CASH_CODES);
    const missing = UAE_CHART
      .filter((a) => a.isPostable !== false)
      .filter((a) => ["ASSET", "LIABILITY", "EQUITY"].includes(a.type))
      .filter((a) => !cash.has(a.code))
      .filter((a) => !(a.code in CLASSIFICATION))
      .map((a) => `${a.code} ${a.name}`);
    expect(missing).toEqual([]);
  });

  it("classifies nothing that is not on the balance sheet", () => {
    // A profit-and-loss account in the map would be double counted: its effect
    // is already in the profit the statement starts from.
    const byCode = new Map(UAE_CHART.map((a) => [a.code, a]));
    const wrong = Object.keys(CLASSIFICATION)
      .map((code) => byCode.get(code))
      .filter((a) => a && ["INCOME", "EXPENSE"].includes(a.type))
      .map((a) => `${a!.code} ${a!.name}`);
    expect(wrong).toEqual([]);
  });
});

describe("what counts as cash", () => {
  it("keeps post-dated cheques out of cash and cash equivalents", async () => {
    // A cheque dated ninety days out is a promise, not money. IAS 7.7 wants an
    // insignificant risk of a change in value and a post-dated cheque is
    // nothing but that risk — it can bounce, and the whole cheque subledger
    // exists because it can. Three modules keep their own cash list, and if
    // any of them ever picks 1060 up the balance sheet will quietly start
    // reporting paper as cash again.
    const forecast = await import("@/lib/server/ledger/forecast");
    const equity = await import("@/lib/server/ledger/equity");
    const src = [
      await import("node:fs").then((fs) =>
        ["cashflow", "forecast", "equity"].map((m) =>
          fs.readFileSync(`src/lib/server/ledger/${m}.ts`, "utf8"),
        ),
      ),
    ].flat();

    expect(CASH_CODES).not.toContain("1060");
    for (const text of src) {
      const line = text.split("\n").find((l) => l.includes("CASH_CODES") && l.includes("1000"));
      expect(line, "each module states its own cash list on one line").toBeTruthy();
      expect(line).not.toContain("1060");
    }
    // The imports are what make the failure land here rather than at runtime:
    // a module that stops existing should break this test, not a screen.
    expect(typeof forecast).toBe("object");
    expect(typeof equity).toBe("object");
  });

  it("classifies both cheque accounts as operating working capital", () => {
    // Taking a cheque moves a receivable to paper and clearing it moves the
    // paper to the bank. Every step of that is the operating cycle; none of it
    // is investing or financing.
    expect(CLASSIFICATION["1060"]).toBe("operating_working_capital");
    expect(CLASSIFICATION["2060"]).toBe("operating_working_capital");
  });
});
