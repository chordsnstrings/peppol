import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  setRate, ratesOnFile, revaluationPreview, runRevaluation, reverseRevaluation, classify,
} from "@/lib/server/ledger/revaluation";
import { openBooks, openFiscalYear, UAE_CHART } from "@/lib/server/ledger/setup";
import { post } from "@/lib/server/ledger/post";
import { trialBalance } from "@/lib/server/ledger/reports";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-fx";
const ENT = "t-ent-fx";

/** The cheque mirror runs on its own books, so it can count what was revalued. */
const ORG2 = "t-org-fx-chq";
const ENT2 = "t-ent-fx-chq";

const wipe = () => wipeOrg(ORG);

async function wipeOrg(ORG: string) {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "FxRate" WHERE "orgId" = '${ORG}'`),
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

/** The transaction-currency balance of one account — the thing that must not move. */
async function txnBalance(code: string, currency: string) {
  const account = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code } });
  const agg = await db.journalLine.aggregate({
    where: { orgId: ORG, accountId: account!.id, txnCurrency: currency },
    _sum: { txnAmountMinor: true },
  });
  return agg._sum.txnAmountMinor ?? 0n;
}

async function linesByCode(entryId: string) {
  const lines = await db.journalLine.findMany({ where: { entryId }, include: { account: true } });
  const out = new Map<string, bigint>();
  for (const l of lines) out.set(l.account.code, (out.get(l.account.code) ?? 0n) + l.txnAmountMinor);
  return Object.fromEntries(out);
}

d("period-end currency revaluation", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // A USD sale: the customer owes USD 10,000, booked at the 3.6730 on the
    // invoice, so receivables carry AED 36,730.00.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-03-10", source: "invoice",
      memo: "Invoice INV-1 — USD 10,000",
      lines: [
        { account: "1100", debit: 1_000_000, currency: "USD", fxRate: 3.673 },
        { account: "4000", credit: 1_000_000, currency: "USD", fxRate: 3.673 },
      ],
    });

    // A USD purchase: the entity owes USD 4,000, carried at AED 14,692.00.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-03-12", source: "bill",
      memo: "Bill BILL-1 — USD 4,000",
      lines: [
        { account: "5000", debit: 400_000, currency: "USD", fxRate: 3.673 },
        { account: "2000", credit: 400_000, currency: "USD", fxRate: 3.673 },
      ],
    });

    // A machine bought in USD, paid from a USD overdraft. The machine is
    // non-monetary; the bank balance is not.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-03-14", source: "manual",
      memo: "Press bought in USD",
      lines: [
        { account: "1500", debit: 500_000, currency: "USD", fxRate: 3.673 },
        { account: "1010", credit: 500_000, currency: "USD", fxRate: 3.673 },
      ],
    });
  });

  afterAll(async () => { await wipe(); });

  /* ── rates ── */

  it("refuses a rate of zero or a negative rate, and says why it matters", async () => {
    await expect(setRate({ orgId: ORG, entityId: ENT, currency: "USD", rate: 0, rateDate: "2026-03-31" }))
      .rejects.toThrow(/greater than zero/i);
    await expect(setRate({ orgId: ORG, entityId: ENT, currency: "USD", rate: 0, rateDate: "2026-03-31" }))
      .rejects.toThrow(/value them all at nothing/i);
    await expect(setRate({ orgId: ORG, entityId: ENT, currency: "USD", rate: "-3.6725", rateDate: "2026-03-31" }))
      .rejects.toThrow(/receivables into payables/i);
    expect(await db.fxRate.count({ where: { orgId: ORG } })).toBe(0);
  });

  it("refuses a rate for the functional currency and a non-currency code", async () => {
    await expect(setRate({ orgId: ORG, entityId: ENT, currency: "AED", rate: 1, rateDate: "2026-03-31" }))
      .rejects.toThrow(/no rate to itself/i);
    await expect(setRate({ orgId: ORG, entityId: ENT, currency: "dollars", rate: 3.67, rateDate: "2026-03-31" }))
      .rejects.toThrow(/three-letter ISO code/i);
  });

  it("records a period-end rate, and updates it in place for the same day", async () => {
    await setRate({ orgId: ORG, entityId: ENT, currency: "USD", rate: "3.6700", rateDate: "2026-03-31" });
    await setRate({ orgId: ORG, entityId: ENT, currency: "USD", rate: "3.6725", rateDate: "2026-03-31" });
    const rates = await ratesOnFile({ orgId: ORG, entityId: ENT });
    expect(rates).toHaveLength(1);
    expect(rates[0].currency).toBe("USD");
    expect(Number(rates[0].rate)).toBe(3.6725);
    expect(rates[0].source).toBe("CBUAE");
  });

  /* ── preview ── */

  it("shows a receivable revalued down as a loss of exactly the right fils", async () => {
    const p = await revaluationPreview({ orgId: ORG, entityId: ENT, asOf: "2026-03-31" });
    const ar = p.rows.find((r) => r.account === "1100")!;
    expect(ar.currency).toBe("USD");
    expect(ar.txnBalanceMinor).toBe("1000000");   // USD 10,000, untouched
    expect(ar.carryingMinor).toBe("3673000");     // AED 36,730.00 at 3.6730
    expect(ar.revaluedMinor).toBe("3672500");     // AED 36,725.00 at 3.6725
    expect(ar.differenceMinor).toBe("-500");      // AED 5.00 unrealised loss
    expect(ar.gain).toBe(false);
    expect(p.blockers).toEqual([]);
  });

  it("shows a payable revalued down as a GAIN — the opposite direction", async () => {
    const p = await revaluationPreview({ orgId: ORG, entityId: ENT, asOf: "2026-03-31" });
    const ap = p.rows.find((r) => r.account === "2000")!;
    // USD 4,000 owed, carried at 14,692.00, now costs 14,690.00 to settle.
    expect(ap.txnBalanceMinor).toBe("-400000");
    expect(ap.carryingMinor).toBe("-1469200");
    expect(ap.revaluedMinor).toBe("-1469000");
    expect(ap.differenceMinor).toBe("200");
    expect(ap.gain).toBe(true);

    // Same rate movement, same currency, opposite sign from the receivable.
    const ar = p.rows.find((r) => r.account === "1100")!;
    expect(BigInt(ar.differenceMinor) < 0n).toBe(true);
    expect(BigInt(ap.differenceMinor) > 0n).toBe(true);
  });

  it("skips the fixed asset as non-monetary, and says so", async () => {
    const p = await revaluationPreview({ orgId: ORG, entityId: ENT, asOf: "2026-03-31" });
    expect(p.rows.some((r) => r.account === "1500")).toBe(false);
    const skip = p.skipped.find((s) => s.account === "1500")!;
    expect(skip.reason).toMatch(/non-monetary/i);
    expect(skip.reason).toMatch(/IAS 21\.23/);
    expect(skip.currency).toBe("USD");
  });

  it("leaves income and expense alone, rather than silently dropping them", async () => {
    const p = await revaluationPreview({ orgId: ORG, entityId: ENT, asOf: "2026-03-31" });
    expect(p.skipped.find((s) => s.account === "4000")?.reason).toMatch(/never retranslated/i);
    expect(p.skipped.find((s) => s.account === "5000")?.reason).toMatch(/transaction-date rate/i);
    // Every foreign-currency balance is accounted for: revalued or explained.
    const seen = [...p.rows.map((r) => r.account), ...p.skipped.map((s) => s.account)].sort();
    expect(seen).toEqual(["1010", "1100", "1500", "2000", "4000", "5000"]);
  });

  /* ── the posting ── */

  it("posts one journal, in the functional currency, with the gain and loss gross", async () => {
    const r = await runRevaluation({ orgId: ORG, entityId: ENT, asOf: "2026-03-31" });
    expect(r.alreadyPosted).toBe(false);
    expect(r.accountsRevalued).toBe(3);              // bank, receivables, payables
    expect(r.totalLossMinor).toBe("500");
    expect(r.totalGainMinor).toBe("450");            // 250 on the bank, 200 on the payable
    expect(r.netDifferenceMinor).toBe("-50");
    expect(r.reference).toMatch(/^FX-/);

    const byCode = await linesByCode(r.entryId!);
    expect(byCode["1100"]).toBe(-500n);              // Cr receivables
    expect(byCode["2000"]).toBe(200n);               // Dr payables
    expect(byCode["1010"]).toBe(250n);               // Dr bank (a USD overdraft)
    expect(byCode["4950"]).toBe(-450n);              // Cr unrealised gain
    expect(byCode["6800"]).toBe(500n);               // Dr unrealised loss

    // Every line is in AED at rate 1: a revaluation restates the carrying
    // amount, it does not move foreign currency.
    const lines = await db.journalLine.findMany({ where: { entryId: r.entryId! } });
    expect(lines.every((l) => l.txnCurrency === "AED")).toBe(true);
    expect(lines.every((l) => Number(l.fxRate) === 1)).toBe(true);
    expect(lines.every((l) => l.txnAmountMinor === l.functionalAmountMinor)).toBe(true);
  });

  it("does not move the transaction-currency balances", async () => {
    // These are the amounts actually owed. The rate moved; the debt did not.
    expect(await txnBalance("1100", "USD")).toBe(1_000_000n);
    expect(await txnBalance("2000", "USD")).toBe(-400_000n);
    expect(await txnBalance("1010", "USD")).toBe(-500_000n);
    expect(await txnBalance("1500", "USD")).toBe(500_000n);
    // And the adjustment itself added no USD anywhere.
    const usd = await db.journalLine.aggregate({
      where: { orgId: ORG, txnCurrency: "USD" }, _sum: { txnAmountMinor: true },
    });
    expect(usd._sum.txnAmountMinor).toBe(0n);
  });

  it("reverses on the first day of the next period, linked to the original", async () => {
    const original = await db.journalEntry.findFirst({
      where: { orgId: ORG, externalKey: `revaluation:${ENT}:2026-03-31` },
    });
    const reversal = await db.journalEntry.findFirst({
      where: { orgId: ORG, externalKey: `revaluation-reversal:${ENT}:2026-03-31` },
    });
    expect(reversal).not.toBeNull();
    expect(reversal!.entryDate.toISOString().slice(0, 10)).toBe("2026-04-01");
    expect(reversal!.reversalOfId).toBe(original!.id);
    // The original stands: it is the period-end measurement, not a mistake.
    expect(original!.status).toBe("posted");

    const rev = await linesByCode(reversal!.id);
    const orig = await linesByCode(original!.id);
    for (const code of Object.keys(orig)) expect(rev[code]).toBe(-orig[code]);
  });

  it("puts the loss in the period it arose and takes it back out of the next", async () => {
    const loss = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code: "6800" } });
    const march = await db.journalLine.aggregate({
      where: { orgId: ORG, accountId: loss!.id, entry: { entryDate: { lte: new Date("2026-03-31") } } },
      _sum: { functionalAmountMinor: true },
    });
    const april = await db.journalLine.aggregate({
      where: { orgId: ORG, accountId: loss!.id, entry: { entryDate: { lte: new Date("2026-04-30") } } },
      _sum: { functionalAmountMinor: true },
    });
    expect(march._sum.functionalAmountMinor).toBe(500n);  // recognised at 31 March
    expect(april._sum.functionalAmountMinor).toBe(0n);    // and reversed on 1 April
  });

  it("does not double the adjustment when the same date is run twice", async () => {
    const before = await db.journalEntry.count({ where: { orgId: ORG, series: "FX" } });
    const first = await db.journalEntry.findFirst({ where: { orgId: ORG, externalKey: `revaluation:${ENT}:2026-03-31` } });

    const again = await runRevaluation({ orgId: ORG, entityId: ENT, asOf: "2026-03-31" });
    expect(again.alreadyPosted).toBe(true);
    expect(again.entryId).toBe(first!.id);
    expect(again.totalLossMinor).toBe("500");   // what was posted, not a fresh recomputation

    expect(await db.journalEntry.count({ where: { orgId: ORG, series: "FX" } })).toBe(before);
    const ar = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code: "1100" } });
    const carried = await db.journalLine.aggregate({
      where: { orgId: ORG, accountId: ar!.id, entry: { entryDate: { lte: new Date("2026-03-31") } } },
      _sum: { functionalAmountMinor: true },
    });
    expect(carried._sum.functionalAmountMinor).toBe(3_672_500n); // 36,725.00, adjusted once
  });

  it("refuses a second revaluation in the same period at a different date", async () => {
    await expect(runRevaluation({ orgId: ORG, entityId: ENT, asOf: "2026-03-25" }))
      .rejects.toThrow(/2026-03 was already revalued as at 2026-03-31/);
  });

  it("still ties the trial balance after revaluing", async () => {
    const march = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-03" });
    expect(march.balanced).toBe(true);
    expect(march.differenceMinor).toBe(0n);
    const april = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-04" });
    expect(april.balanced).toBe(true);
    expect(april.differenceMinor).toBe(0n);
  });

  /* ── a currency with no rate ── */

  it("blocks the run by name when a currency has no rate on file", async () => {
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-04-05", source: "manual",
      memo: "EUR supplier accrual",
      lines: [
        { account: "1010", debit: 100_000, currency: "EUR", fxRate: 3.95 },
        { account: "2050", credit: 100_000, currency: "EUR", fxRate: 3.95 },
      ],
    });

    const p = await revaluationPreview({ orgId: ORG, entityId: ENT, asOf: "2026-04-30" });
    expect(p.blockers.some((b) => /No EUR rate is on file as at 2026-04-30/.test(b))).toBe(true);
    expect(p.skipped.some((s) => s.currency === "EUR" && /no EUR rate/i.test(s.reason))).toBe(true);
    expect(p.rows.some((r) => r.currency === "EUR")).toBe(false);

    await expect(runRevaluation({ orgId: ORG, entityId: ENT, asOf: "2026-04-30" }))
      .rejects.toThrow(/EUR/);
    // Nothing was posted while it was blocked.
    expect(await db.journalEntry.findFirst({ where: { orgId: ORG, externalKey: `revaluation:${ENT}:2026-04-30` } })).toBeNull();
  });

  it("recomputes the next period from the original carrying amount, not the adjusted one", async () => {
    await setRate({ orgId: ORG, entityId: ENT, currency: "EUR", rate: "3.9000", rateDate: "2026-04-30" });
    const r = await runRevaluation({ orgId: ORG, entityId: ENT, asOf: "2026-04-30" });

    const byCode = await linesByCode(r.entryId!);
    // The USD differences are the same as March's, because the March adjustment
    // was reversed on 1 April — the basis is the rate each item was booked at.
    expect(byCode["1100"]).toBe(-500n);
    expect(byCode["2000"]).toBe(200n);
    // EUR 1,000.00 booked at 3.95 is worth 3,900.00 at 3.90: a 50.00 loss on
    // the bank and a 50.00 gain on the accrual it funded.
    expect(byCode["2050"]).toBe(5_000n);
    expect(byCode["1010"]).toBe(250n - 5_000n);  // +250 on USD, −5,000 on EUR, one account
    expect(r.totalLossMinor).toBe("5500");
    expect(r.totalGainMinor).toBe("5450");
    expect(r.reversalDate).toBe("2026-05-01");

    const april = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-04" });
    expect(april.balanced).toBe(true);
    // Still nobody's debt changed.
    expect(await txnBalance("1100", "USD")).toBe(1_000_000n);
    expect(await txnBalance("1010", "EUR")).toBe(100_000n);
  });

  it("reverses on request, and refuses to reverse a revaluation that was never made", async () => {
    const already = await reverseRevaluation({ orgId: ORG, entityId: ENT, asOf: "2026-04-30" });
    expect(already.alreadyPosted).toBe(true);
    expect(already.reversalDate).toBe("2026-05-01");
    await expect(reverseRevaluation({ orgId: ORG, entityId: ENT, asOf: "2026-06-30" }))
      .rejects.toThrow(/no revaluation as at 2026-06-30/i);
  });

  it("refuses a date that is not a date", async () => {
    await expect(revaluationPreview({ orgId: ORG, entityId: ENT, asOf: "2026-03" }))
      .rejects.toThrow(/looks like 2026-03-31/);
  });
});

describe("the monetary map against the chart", () => {
  const postable = UAE_CHART.filter((a) => a.isPostable !== false);

  it("decides every balance-sheet account the standard chart has", () => {
    // An account this cannot decide is skipped, and a skipped account's whole
    // unrealised difference is left out of profit or loss. The remedy the
    // message prescribes — give it a subtype — cannot be carried out from any
    // screen, so a gap here is a number nobody can fix. 1060 was exactly that:
    // in the chart since the cheque subledger was written, monetary beyond any
    // doubt, and absent from the map while its 2060 mirror was in it.
    const undecided = postable
      .filter((a) => ["ASSET", "LIABILITY"].includes(a.type))
      .map((a) => ({ a, c: classify(a) }))
      .filter(({ c }) => !c.monetary && /cannot be decided from the chart/.test(c.reason))
      .map(({ a }) => `${a.code} ${a.name}`);
    expect(undecided).toEqual([]);
  });

  it("treats a cheque the same whichever way it points", () => {
    // IAS 21.16: the essential feature is a right to receive, or an obligation
    // to deliver, a determinable number of units of currency. A cheque is that
    // in both directions — the entity's own cheque in the supplier's drawer and
    // the customer's cheque in the entity's.
    expect(classify({ code: "1060", type: "ASSET" }).monetary).toBe(true);
    expect(classify({ code: "2060", type: "LIABILITY" }).monetary).toBe(true);
  });

  it("leaves income, expense and contributed equity out of it", () => {
    // Their effect is already at the transaction-date rate (IAS 21.21). A map
    // entry for one of them would retranslate an event rather than a balance.
    for (const a of postable.filter((x) => ["INCOME", "EXPENSE", "EQUITY"].includes(x.type))) {
      const c = classify(a);
      expect(c.monetary, `${a.code} ${a.name} should not be monetary`).toBe(false);
    }
  });
});

d("a foreign-currency cheque, held and issued", () => {
  beforeAll(async () => {
    await wipeOrg(ORG2);
    await openFiscalYear({ orgId: ORG2, entityId: ENT2, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG2, entityId: ENT2 });

    // A EUR 10,000 invoice, settled by a ninety-day cheque at the same rate,
    // so the receivable is nil in euros and 1060 carries AED 39,000.00 alone.
    await post({
      orgId: ORG2, entityId: ENT2, entryDate: "2026-03-04", source: "invoice",
      memo: "Invoice — EUR 10,000",
      lines: [
        { account: "1100", debit: 1_000_000, currency: "EUR", fxRate: 3.9 },
        { account: "4000", credit: 1_000_000, currency: "EUR", fxRate: 3.9 },
      ],
    });
    await post({
      orgId: ORG2, entityId: ENT2, entryDate: "2026-03-05", source: "cheque",
      memo: "PDC from customer — EUR 10,000",
      lines: [
        { account: "1060", debit: 1_000_000, currency: "EUR", fxRate: 3.9 },
        { account: "1100", credit: 1_000_000, currency: "EUR", fxRate: 3.9 },
      ],
    });

    // And the mirror: a EUR 5,000 bill settled with the entity's own cheque,
    // leaving 2060 carrying AED 19,500.00 and the payable nil.
    await post({
      orgId: ORG2, entityId: ENT2, entryDate: "2026-03-06", source: "bill",
      memo: "Bill — EUR 5,000",
      lines: [
        { account: "5000", debit: 500_000, currency: "EUR", fxRate: 3.9 },
        { account: "2000", credit: 500_000, currency: "EUR", fxRate: 3.9 },
      ],
    });
    await post({
      orgId: ORG2, entityId: ENT2, entryDate: "2026-03-07", source: "cheque",
      memo: "PDC to supplier — EUR 5,000",
      lines: [
        { account: "2000", debit: 500_000, currency: "EUR", fxRate: 3.9 },
        { account: "2060", credit: 500_000, currency: "EUR", fxRate: 3.9 },
      ],
    });

    await setRate({ orgId: ORG2, entityId: ENT2, currency: "EUR", rate: "4.0000", rateDate: "2026-03-31" });
  });

  afterAll(async () => { await wipeOrg(ORG2); await db.$disconnect(); });

  it("revalues the cheque it holds as well as the cheque it wrote", async () => {
    const p = await revaluationPreview({ orgId: ORG2, entityId: ENT2, asOf: "2026-03-31" });

    // Held: EUR 10,000 booked at 3.9000 is carried at 39,000.00 and is worth
    // 40,000.00 at 4.0000 — a gain of exactly AED 1,000.00. This is the row
    // that was missing: 1060 was skipped as "carries no subtype" while 2060,
    // the identical instrument pointing the other way, was revalued.
    const held = p.rows.find((r) => r.account === "1060")!;
    expect(held.currency).toBe("EUR");
    expect(held.txnBalanceMinor).toBe("1000000");
    expect(held.carryingMinor).toBe("3900000");
    expect(held.revaluedMinor).toBe("4000000");
    expect(held.differenceMinor).toBe("100000");
    expect(held.gain).toBe(true);

    // Issued: EUR 5,000 owed, carried at 19,500.00, now costs 20,000.00 to
    // honour — a loss of AED 500.00.
    const issued = p.rows.find((r) => r.account === "2060")!;
    expect(issued.txnBalanceMinor).toBe("-500000");
    expect(issued.carryingMinor).toBe("-1950000");
    expect(issued.revaluedMinor).toBe("-2000000");
    expect(issued.differenceMinor).toBe("-50000");
    expect(issued.gain).toBe(false);

    expect(p.skipped.some((sk) => sk.account === "1060")).toBe(false);
    expect(p.blockers).toEqual([]);
  });

  it("posts both halves, so profit carries the net 500.00 it should", async () => {
    const r = await runRevaluation({ orgId: ORG2, entityId: ENT2, asOf: "2026-03-31" });
    // The two cheque accounts only: the receivable and the payable were both
    // discharged in euros by the cheques and are skipped as nil.
    expect(r.accountsRevalued).toBe(2);
    expect(r.totalGainMinor).toBe("100000");   // 1,000.00 on the cheque held
    expect(r.totalLossMinor).toBe("50000");    // 500.00 on the cheque written
    expect(r.netDifferenceMinor).toBe("50000");

    const byCode = await linesByCode(r.entryId!);
    expect(byCode["1060"]).toBe(100_000n);     // Dr the held cheque up to 40,000.00
    expect(byCode["2060"]).toBe(-50_000n);     // Cr the written cheque up to 20,000.00
    expect(byCode["4950"]).toBe(-100_000n);    // Cr unrealised gain
    expect(byCode["6800"]).toBe(50_000n);      // Dr unrealised loss

    // Before 1060 was classified, only the 500.00 loss reached profit: the
    // whole 1,000.00 gain on paper the entity was holding went nowhere.
    const tb = await db.journalLine.aggregate({
      where: { orgId: ORG2, entryId: r.entryId! }, _sum: { functionalAmountMinor: true },
    });
    expect(tb._sum.functionalAmountMinor).toBe(0n);
  });

  it("does not touch the euros themselves", async () => {
    // A revaluation restates a carrying amount. The cheque is still for the
    // same EUR 10,000 it was written for, and the adjustment is in AED.
    const held = await db.account.findFirst({ where: { orgId: ORG2, entityId: ENT2, code: "1060" } });
    const eur = await db.journalLine.aggregate({
      where: { orgId: ORG2, accountId: held!.id, txnCurrency: "EUR" },
      _sum: { txnAmountMinor: true },
    });
    expect(eur._sum.txnAmountMinor).toBe(1_000_000n);
    // At the period end it is carried at 40,000.00 — and on 1 April the
    // adjustment reverses, because the next event is a bank credit at the rate
    // on the day the cheque clears, not at March's.
    const aed = await db.journalLine.aggregate({
      where: { orgId: ORG2, accountId: held!.id, entry: { entryDate: { lte: new Date("2026-03-31") } } },
      _sum: { functionalAmountMinor: true },
    });
    expect(aed._sum.functionalAmountMinor).toBe(4_000_000n); // 39,000.00 + 1,000.00
  });
});
