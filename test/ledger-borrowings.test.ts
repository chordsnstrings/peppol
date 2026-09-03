import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  RATE_SCALE, nanoFromAnnualBps, annualBpsFromNano, presentValueAt, levelInstalment,
  flatInstalment, effectiveRateOf, buildBorrowingSchedule, currentPortionOf, addMonths,
  instalmentsOf, termsOf,
  addBorrowing, drawDown, postInstalment, reclassifyCurrentPortion,
  borrowingRegister, borrowingSchedule, maturityAnalysis, addCovenant, testCovenants,
  BORROWINGS_ACCOUNT, BORROWINGS_CURRENT_ACCOUNT, INTEREST_ACCOUNT, CASH_ACCOUNT,
} from "@/lib/server/ledger/borrowings";
// The lease liability is the same arithmetic at a coarser rate. Importing its
// present value here rather than restating it is what proves the two agree.
import { presentValue } from "@/lib/server/ledger/leases";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { post } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-brw";
const ENT = "t-ent-brw";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "BorrowingCovenant" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Borrowing" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${ORG}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Dimension" WHERE "orgId" = '${ORG}'`),
  ]);
}

async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true } });
  const by: Record<string, bigint> = {};
  for (const r of rows) by[r.account.code] = (by[r.account.code] ?? 0n) + r.txnAmountMinor;
  return by;
}

/* ------------------------------------------------------------ the arithmetic */

describe("interest rates, held as integers", () => {
  it("turns an annual rate into a rate per period without a float", () => {
    // 6% a year over twelve months is exactly half a percent a month.
    expect(nanoFromAnnualBps(600, 12)).toBe(5_000_000n);
    // 5% is 0.4166…% a month, which is why a whole basis point is not enough:
    // rounded to 42bp it would be 5.04% a year.
    expect(nanoFromAnnualBps(500, 12)).toBe(4_166_667n);
    expect(annualBpsFromNano(4_166_667n, 12)).toBe(500);
    // Quarterly and annual fall out of the same arithmetic.
    expect(nanoFromAnnualBps(800, 4)).toBe(20_000_000n);
    expect(nanoFromAnnualBps(800, 1)).toBe(80_000_000n);
  });

  it("refuses a rate that is not whole basis points between nil and 100%", () => {
    expect(() => nanoFromAnnualBps(5.5, 12)).toThrow(/whole number of basis points/i);
    expect(() => nanoFromAnnualBps(20_000, 12)).toThrow(/whole number of basis points/i);
    expect(() => nanoFromAnnualBps(-100, 12)).toThrow(/whole number of basis points/i);
  });
});

describe("a reducing-balance schedule", () => {
  // AED 120,000.00 at 6% a year on the reducing balance, twelve monthly
  // instalments. Worked by hand: the rate is exactly 0.5% a month, so the
  // annuity is 120,000 × 0.005 × 1.005¹² / (1.005¹² − 1) = 10,327.97, the first
  // month's interest is 600.00 and the first principal repayment is 9,727.97.
  const P = 12_000_000n;
  const n = 12;
  const r = nanoFromAnnualBps(600, 12);
  const A = levelInstalment({ principalMinor: P, periods: n, ratePerPeriodNano: r });

  it("computes the level instalment", () => {
    expect(A).toBe(1_032_797n);
  });

  it("agrees with the lease liability, which is the same arithmetic", () => {
    // presentValue() in leases.ts discounts level payments in arrears at whole
    // basis points. Half a percent a month IS 50 basis points, so the two must
    // land on the same figure — and they do, within the two fils by which the
    // instalment was itself rounded to the fil.
    const pv = presentValue({ paymentMinor: A, periods: n, ratePerPeriodBps: 50 });
    // Not merely close — the same figure to the fil, because 50 basis points
    // and 5,000,000 of the finer units are the same rate.
    expect(presentValueAt(A, n, r)).toBe(pv);
    expect(pv).toBe(11_999_998n);
    // And that figure is the principal, less the two fils by which the
    // instalment was itself rounded to the fil.
    expect(P - pv).toBe(2n);
  });

  it("closes to exactly nil, with the rounding in the final instalment", () => {
    const rows = buildBorrowingSchedule({ principalMinor: P, instalmentMinor: A, periods: n, ratePerPeriodNano: r });

    expect(rows[0].openingMinor).toBe(12_000_000n);
    expect(rows[0].interestMinor).toBe(60_000n);       // 600.00
    expect(rows[0].principalMinor).toBe(972_797n);     // 9,727.97
    expect(rows[0].closingMinor).toBe(11_027_203n);    // 110,272.03

    expect(rows[5].openingMinor).toBe(7_087_132n);     // 70,871.32 at month six
    expect(rows[5].interestMinor).toBe(35_436n);       // 354.36

    // The last instalment is the settlement figure, so it carries the two fils
    // of rounding the level instalment left behind: 10,327.99, not 10,327.97.
    const last = rows[n - 1];
    expect(last.openingMinor).toBe(1_027_661n);
    expect(last.interestMinor).toBe(5_138n);
    expect(last.principalMinor).toBe(1_027_661n);
    expect(last.instalmentMinor).toBe(1_032_799n);
    expect(last.instalmentMinor - A).toBe(2n);
    expect(last.closingMinor).toBe(0n);

    // Not approximately nil. Exactly nil, and every principal repayment adds
    // back to the amount advanced.
    expect(rows.reduce((a, x) => a + x.principalMinor, 0n)).toBe(P);
    expect(rows.reduce((a, x) => a + x.interestMinor, 0n)).toBe(393_566n); // 3,935.66
    expect(rows.reduce((a, x) => a + x.instalmentMinor, 0n)).toBe(P + 393_566n);
  });

  it("charges no interest at all on an interest-free loan, and still closes", () => {
    const free = levelInstalment({ principalMinor: 10_000_00n, periods: 7, ratePerPeriodNano: 0n });
    const rows = buildBorrowingSchedule({
      principalMinor: 10_000_00n, instalmentMinor: free, periods: 7, ratePerPeriodNano: 0n,
    });
    expect(rows.every((x) => x.interestMinor === 0n)).toBe(true);
    expect(rows[6].closingMinor).toBe(0n);
    expect(rows.reduce((a, x) => a + x.principalMinor, 0n)).toBe(10_000_00n);
  });

  it("refuses terms where the instalment never repays anything", () => {
    // 100,000.00 at 12% a year monthly is 1,000.00 of interest in month one.
    expect(() =>
      buildBorrowingSchedule({
        principalMinor: 10_000_000n, instalmentMinor: 50_000n, periods: 24,
        ratePerPeriodNano: nanoFromAnnualBps(1_200, 12),
      }),
    ).toThrow(/does not cover the .* of interest/i);
  });
});

describe("a flat rate, and what it actually costs", () => {
  // The UAE term-loan shape: AED 100,000.00, quoted at 5% flat over three
  // years, repaid in 36 monthly instalments.
  //
  // Worked by hand: flat interest is 100,000 × 5% × 3 = 15,000.00, so the
  // instalment is 115,000 / 36 = 3,194.44. But the borrower does not have
  // 100,000 for three years — by the last instalment they have barely 3,000 —
  // so the rate on the money actually outstanding is far above 5%.
  const P = 10_000_000n;
  const n = 36;
  const flat = flatInstalment({ principalMinor: P, statedRateBps: 500, termMonths: 36, periods: n });

  it("computes the flat instalment the lender quotes", () => {
    expect(flat.flatInterestMinor).toBe(1_500_000n); // 15,000.00
    expect(flat.instalmentMinor).toBe(319_444n);     // 3,194.44
  });

  it("computes an effective rate materially above the quoted one", () => {
    const eff = effectiveRateOf({ principalMinor: P, instalmentMinor: flat.instalmentMinor, periods: n });
    // 0.7758680% a month.
    expect(eff).toBe(7_758_680n);
    const annual = annualBpsFromNano(eff, 12);
    expect(annual).toBe(931);            // 9.31% a year against a quoted 5.00%
    expect(annual - 500).toBe(431);      // 431 basis points of difference
    // Close to the rule of thumb that a flat rate over three years is very
    // nearly doubled. Stated as a ratio so the point cannot be missed.
    expect(annual).toBeGreaterThan(2 * 500 - 100);
  });

  it("amortises at the effective rate, not the quoted one, and still closes to nil", () => {
    const eff = effectiveRateOf({ principalMinor: P, instalmentMinor: flat.instalmentMinor, periods: n });
    const rows = buildBorrowingSchedule({
      principalMinor: P, instalmentMinor: flat.instalmentMinor, periods: n, ratePerPeriodNano: eff,
    });

    // IFRS 9.5.4.1 measures at amortised cost using the effective rate, so the
    // interest is FRONT-LOADED against the lender's own flat allocation of
    // 15,000 / 36 = 416.67 every month.
    expect(rows[0].interestMinor).toBe(77_587n);   // 775.87 in month one
    expect(rows[0].principalMinor).toBe(241_857n); // 2,418.57
    expect(rows[35].interestMinor).toBe(2_459n);   // 24.59 in the last month
    expect(rows[0].interestMinor).toBeGreaterThan(41_667n);
    expect(rows[35].interestMinor).toBeLessThan(41_667n);

    expect(rows[35].closingMinor).toBe(0n);
    expect(rows.reduce((a, x) => a + x.principalMinor, 0n)).toBe(P);
    // The cash is unchanged — only the split between interest and principal
    // moves — so the total interest is the flat 15,000 within the rounding.
    const totalInterest = rows.reduce((a, x) => a + x.interestMinor, 0n);
    expect(totalInterest).toBe(1_499_984n);
    expect(flat.flatInterestMinor - totalInterest).toBe(16n);
  });

  it("gives a reducing-balance facility its own rate back", () => {
    // A plain loan with no arrangement fee has an effective rate equal to its
    // contractual one; the whole difference above is what "flat" does.
    const A = levelInstalment({ principalMinor: 12_000_000n, periods: 12, ratePerPeriodNano: nanoFromAnnualBps(600, 12) });
    const eff = effectiveRateOf({ principalMinor: 12_000_000n, instalmentMinor: A, periods: 12 });
    expect(annualBpsFromNano(eff, 12)).toBe(600);
  });

  it("calls a loan repaid at no more than it advanced interest-free", () => {
    expect(effectiveRateOf({ principalMinor: 100_000n, instalmentMinor: 10_000n, periods: 10 })).toBe(0n);
    expect(RATE_SCALE).toBe(1_000_000_000n);
  });
});

describe("terms, dates and the twelve-month split", () => {
  it("counts instalments, and refuses a term the frequency cannot divide", () => {
    expect(instalmentsOf(36, "MONTHLY")).toBe(36);
    expect(instalmentsOf(36, "QUARTERLY")).toBe(12);
    expect(instalmentsOf(36, "SEMIANNUAL")).toBe(6);
    expect(instalmentsOf(36, "ANNUAL")).toBe(3);
    expect(() => instalmentsOf(13, "QUARTERLY")).toThrow(/multiple of 3/i);
  });

  it("rolls a month end back rather than forward", () => {
    expect(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(addMonths(new Date("2026-01-31T00:00:00Z"), 3).toISOString().slice(0, 10)).toBe("2026-04-30");
    expect(addMonths(new Date("2026-01-15T00:00:00Z"), 12).toISOString().slice(0, 10)).toBe("2027-01-15");
  });

  it("splits the principal falling due within twelve months, and only the principal", () => {
    const terms = termsOf({
      principalMinor: 10_000_000n, statedRateBps: 500, interestBasis: "FLAT",
      frequency: "MONTHLY", termMonths: 36, drawdownOn: new Date("2026-01-31T00:00:00Z"),
    });
    const split = currentPortionOf({
      rows: terms.rows, dueOn: terms.dueOn, paidTo: 0, asOf: new Date("2026-01-31T00:00:00Z"),
    });
    // Instalments 1 to 12 fall on 2026-02-28 through 2027-01-31, all within the
    // twelve months. Their PRINCIPAL is 30,293.93 — the interest in those same
    // instalments has not accrued at the reporting date and is not a liability.
    expect(split.currentMinor).toBe(3_029_393n);
    expect(split.currentMinor + split.nonCurrentMinor).toBe(10_000_000n);
    // The twelve instalments themselves total far more, which is exactly why
    // the note and the balance sheet cannot carry the same figure.
    const twelveInstalments = terms.rows.slice(0, 12).reduce((a, x) => a + x.instalmentMinor, 0n);
    expect(twelveInstalments).toBe(3_833_328n);
    expect(twelveInstalments).toBeGreaterThan(split.currentMinor);
  });

  it("treats an instalment already past due as current, whatever its date", () => {
    const terms = termsOf({
      principalMinor: 10_000_000n, statedRateBps: 500, interestBasis: "FLAT",
      frequency: "MONTHLY", termMonths: 36, drawdownOn: new Date("2026-01-31T00:00:00Z"),
    });
    // Two years on with nothing paid: everything left is in arrears or falls
    // due inside the year, so nothing is non-current.
    const split = currentPortionOf({
      rows: terms.rows, dueOn: terms.dueOn, paidTo: 0, asOf: new Date("2028-01-31T00:00:00Z"),
    });
    expect(split.nonCurrentMinor).toBe(0n);
    expect(split.currentMinor).toBe(10_000_000n);
  });
});

/* ------------------------------------------------------------- in the books */

d("borrowings in the ledger", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2027", startsOn: "2027-01-01" });
    await openBooks(S);
    // Something for the loan to be drawn against, so equity and the current
    // ratio are real figures rather than artefacts of an empty ledger.
    await post({
      ...S, entryDate: "2026-01-01", memo: "Capital introduced", source: "manual", series: "GJ",
      lines: [
        { account: "1010", debit: 5_000_000n, memo: "Bank" },
        { account: "3000", credit: 5_000_000n, memo: "Share capital" },
      ],
    });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("records a facility without posting anything", async () => {
    const b = await addBorrowing({
      ...S,
      borrowing: {
        code: "BRW-1", lender: "Emirates NBD", principalMinor: 10_000_000n,
        drawdownOn: "2026-01-31", statedRateBps: 500, interestBasis: "FLAT",
        frequency: "MONTHLY", termMonths: 36,
      },
    });
    expect(b.status).toBe("draft");
    // Fixed at the moment it is recorded, so a later edit cannot restate it.
    expect(b.instalmentMinor).toBe(319_444n);
    expect(b.effectiveRateBps).toBe(931);
    expect(b.statedRateBps).toBe(500);

    const entries = await db.journalEntry.count({ where: { orgId: ORG, source: "borrowing" } });
    expect(entries).toBe(0);
  });

  it("refuses a second facility on the same code", async () => {
    await expect(addBorrowing({
      ...S,
      borrowing: {
        code: "BRW-1", lender: "Someone else", principalMinor: 100_000n,
        drawdownOn: "2026-02-01", statedRateBps: 400, termMonths: 12,
      },
    })).rejects.toThrow(/already on the register/i);
  });

  it("refuses terms whose effective rate is above 100% a year", async () => {
    // 80% flat over three years is 108.28% on the balance outstanding. The
    // quoted rate is inside the range basis points can hold; the effective one
    // is not, and it is refused with a sentence rather than a constraint.
    await expect(addBorrowing({
      ...S,
      borrowing: {
        code: "BRW-WILD", lender: "Nobody sensible", principalMinor: 1_000_000n,
        drawdownOn: "2026-02-01", statedRateBps: 8_000, interestBasis: "FLAT", termMonths: 36,
      },
    })).rejects.toThrow(/above 100% a year/i);
    expect(await db.borrowing.count({ where: { orgId: ORG, code: "BRW-WILD" } })).toBe(0);
  });

  it("refuses a facility in a currency these books are not kept in", async () => {
    await addBorrowing({
      ...S,
      borrowing: {
        code: "BRW-USD", lender: "Offshore Bank", principalMinor: 1_000_000n, currency: "USD",
        drawdownOn: "2026-02-01", statedRateBps: 700, termMonths: 12,
      },
    });
    await expect(drawDown({ ...S, code: "BRW-USD" })).rejects.toThrow(/IAS 21\.23\(a\)/);
  });

  it("posts the drawdown: bank up, borrowings up", async () => {
    const r = await drawDown({ ...S, code: "BRW-1" });
    expect(r.alreadyDrawn).toBe(false);
    const by = await linesOf(r.entryId);
    expect(by[CASH_ACCOUNT]).toBe(10_000_000n);
    expect(by[BORROWINGS_ACCOUNT]).toBe(-10_000_000n);
  });

  it("draws once however many times it is asked", async () => {
    const again = await drawDown({ ...S, code: "BRW-1" });
    expect(again.alreadyDrawn).toBe(true);
    const n = await db.journalEntry.count({ where: { orgId: ORG, sourceType: "BORROWING_DRAWDOWN" } });
    expect(n).toBe(1);
  });

  it("posts an instalment: principal off the liability, interest to finance costs", async () => {
    const r = await postInstalment({ ...S, code: "BRW-1", instalmentNo: 1 });
    expect(r.dueOn).toBe("2026-02-28");
    expect(r.interestMinor).toBe("77587");    // 775.87 at the effective rate
    expect(r.principalMinor).toBe("241857");  // 2,418.57
    expect(r.instalmentMinor).toBe("319444"); // 3,194.44 of cash

    const by = await linesOf(r.entryId);
    expect(by[BORROWINGS_ACCOUNT]).toBe(241_857n);
    expect(by[INTEREST_ACCOUNT]).toBe(77_587n);
    expect(by[CASH_ACCOUNT]).toBe(-319_444n);
  });

  it("posts the same instalment once, however many times it is run", async () => {
    const again = await postInstalment({ ...S, code: "BRW-1", instalmentNo: 1 });
    expect(again.alreadyPosted).toBe(true);
    expect(again.entryId).toBeTruthy();

    const entries = await db.journalEntry.findMany({
      where: { orgId: ORG, sourceType: "BORROWING_INSTALMENT" },
    });
    expect(entries.length).toBe(1);

    // And the register has not been paid down twice.
    const b = await db.borrowing.findFirstOrThrow({ where: { orgId: ORG, code: "BRW-1" } });
    expect(b.paidTo).toBe(1);
    expect(b.outstandingMinor).toBe(9_758_143n); // 97,581.43
  });

  it("refuses an instalment out of order, because a gap means one was missed", async () => {
    await expect(postInstalment({ ...S, code: "BRW-1", instalmentNo: 4 }))
      .rejects.toThrow(/paid to instalment 1, so instalment 2 is the next one due/i);
    await expect(postInstalment({ ...S, code: "BRW-1", instalmentNo: 99 }))
      .rejects.toThrow(/numbered 1 to 36/i);
  });

  it("keeps the books balanced after every posting", async () => {
    await postInstalment({ ...S, code: "BRW-1", instalmentNo: 2 });
    await postInstalment({ ...S, code: "BRW-1", instalmentNo: 3 });
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-04" });
    expect(tb.balanced).toBe(true);
  });

  it("ties the register to the ledger", async () => {
    const reg = await borrowingRegister({ ...S, asOf: "2026-12-31" });
    expect(reg.ledger.agrees).toBe(true);
    expect(reg.ledger.differenceMinor).toBe("0");
    const f = reg.facilities.find((x) => x.code === "BRW-1")!;
    expect(f.paidTo).toBe(3);
    expect(f.effectiveRateBps).toBe(931);
    expect(f.ratePremiumBps).toBe(431);
  });

  it("derives the current portion at a reporting date and says it is not posted yet", async () => {
    const reg = await borrowingRegister({ ...S, asOf: "2026-12-31" });
    const f = reg.facilities.find((x) => x.code === "BRW-1")!;
    // Instalments 4 to 15 fall due between 2027-01-31 and 2027-12-31.
    expect(BigInt(f.currentMinor) + BigInt(f.nonCurrentMinor)).toBe(BigInt(f.outstandingMinor));
    expect(BigInt(f.currentMinor) > 0n).toBe(true);
    expect(f.reclassifiedMinor).toBe("0");
    expect(f.splitPosted).toBe(false);
  });

  it("posts the split so the balance sheet can present it (IAS 1.69)", async () => {
    const before = await borrowingRegister({ ...S, asOf: "2026-12-31" });
    const target = BigInt(before.facilities.find((x) => x.code === "BRW-1")!.currentMinor);

    const r = await reclassifyCurrentPortion({ ...S, asOf: "2026-12-31" });
    expect(r.posted).toBe(true);
    expect(r.movedMinor).toBe(target.toString());

    const by = await linesOf(r.entryId!);
    expect(by[BORROWINGS_ACCOUNT]).toBe(target);
    expect(by[BORROWINGS_CURRENT_ACCOUNT]).toBe(-target);

    const after = await borrowingRegister({ ...S, asOf: "2026-12-31" });
    expect(after.facilities.find((x) => x.code === "BRW-1")!.splitPosted).toBe(true);
    // The total owed has not moved — only where it is presented.
    expect(after.ledger.totalMinor).toBe(before.ledger.totalMinor);
    expect(after.ledger.agrees).toBe(true);
    expect(after.ledger.currentMinor).toBe(target.toString());
  });

  it("posts nothing on a second split at the same date", async () => {
    const again = await reclassifyCurrentPortion({ ...S, asOf: "2026-12-31" });
    expect(again.posted).toBe(false);
    expect(again.alreadyPosted).toBe(true);
    const n = await db.journalEntry.count({ where: { orgId: ORG, sourceType: "BORROWING_RECLASS" } });
    expect(n).toBe(1);
  });

  it("takes a later instalment out of the current portion first", async () => {
    const b = await db.borrowing.findFirstOrThrow({ where: { orgId: ORG, code: "BRW-1" } });
    expect(b.currentPortionMinor > 0n).toBe(true);

    const r = await postInstalment({ ...S, code: "BRW-1", instalmentNo: 4, paidOn: "2026-12-31" });
    const by = await linesOf(r.entryId);
    // The principal comes out of 2450, not 2500 — what is repaid in the next
    // twelve months is what was reclassified as falling due in them.
    expect(by[BORROWINGS_CURRENT_ACCOUNT]).toBe(BigInt(r.principalMinor));
    expect(by[BORROWINGS_ACCOUNT]).toBeUndefined();

    const after = await db.borrowing.findFirstOrThrow({ where: { orgId: ORG, code: "BRW-1" } });
    expect(after.currentPortionMinor).toBe(b.currentPortionMinor - BigInt(r.principalMinor));

    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-12" });
    expect(tb.balanced).toBe(true);
  });

  it("gives an undiscounted maturity analysis that deliberately does not tie to the carrying amount", async () => {
    const m = await maturityAnalysis({ ...S, asOf: "2026-12-31" });
    expect(m.bands.map((b) => b.band)).toEqual(["WITHIN_1Y", "Y1_2", "Y2_5", "OVER_5Y"]);
    // Nothing on a three-year facility falls beyond five years.
    expect(m.bands[3].cashFlowMinor).toBe("0");

    const cash = BigInt(m.totals.cashFlowMinor);
    const carrying = BigInt(m.carryingAmountMinor);
    // The principal in the analysis IS the carrying amount; the excess is the
    // interest that has not accrued yet, which is why the two never agree.
    expect(BigInt(m.totals.principalMinor)).toBe(carrying);
    expect(cash - carrying).toBe(BigInt(m.totals.interestMinor));
    expect(m.differenceMinor).toBe(m.totals.interestMinor);
    expect(cash > carrying).toBe(true);
    expect(m.note).toMatch(/undiscounted/i);
  });

  it("reproduces the whole schedule with the instalments already posted marked", async () => {
    const s = await borrowingSchedule({ ...S, code: "BRW-1" });
    expect(s.rows.length).toBe(36);
    expect(s.rows.filter((r) => r.posted).length).toBe(4);
    expect(s.rows[35].closingMinor).toBe("0");
    expect(s.effectiveRateBps).toBe(931);
    expect(s.statedRateBps).toBe(500);
    expect(s.note).toMatch(/amortised cost/i);
    // Every principal repayment adds back to what was advanced, with nothing
    // left over: the schedule closes to exactly nil.
    const principal = s.rows.reduce((a, r) => a + BigInt(r.principalMinor), 0n);
    expect(principal).toBe(10_000_000n);
  });

  it("tests a covenant it can measure and reports the breach", async () => {
    await addCovenant({
      ...S,
      covenant: {
        borrowingCode: "BRW-1", code: "GEARING", metric: "DEBT_TO_EQUITY",
        direction: "MAX", thresholdBps: 10_000, // debt no more than equity
        wording: "Total borrowings shall not exceed shareholders' funds.",
      },
    });
    const r = await testCovenants({ ...S, asOf: "2026-12-31" });
    const t = r.tests.find((x) => x.code === "GEARING")!;
    // Borrowings of ~96,700 against equity of 50,000 less the interest charged.
    expect(t.result).toBe("breach");
    expect(t.actualBps).toBeGreaterThan(10_000);
    expect(r.breaches).toBe(1);
    expect(r.note).toMatch(/IAS 1\.74/);
  });

  it("says a covenant is untested rather than passed when it cannot be measured", async () => {
    await addCovenant({
      ...S,
      covenant: {
        borrowingCode: "BRW-1", code: "INSURANCE", metric: "OTHER",
        wording: "The borrower shall keep the pledged plant insured to full replacement value.",
      },
    });
    const r = await testCovenants({ ...S, asOf: "2026-12-31" });
    const t = r.tests.find((x) => x.code === "INSURANCE")!;
    expect(t.result).toBe("not_tested");
    expect(t.actualBps).toBeNull();
    expect(t.why).toMatch(/nothing in this ledger measures it/i);
    expect(r.untested).toBe(1);
  });

  it("does not report a pass for interest cover in a period with no interest in it", async () => {
    await addCovenant({
      ...S,
      covenant: { borrowingCode: "BRW-1", code: "COVER", metric: "INTEREST_COVER", direction: "MIN", thresholdBps: 30_000 },
    });
    const r = await testCovenants({ ...S, asOf: "2026-01-31", from: "2026-01-01" });
    const t = r.tests.find((x) => x.code === "COVER")!;
    expect(t.result).toBe("not_tested");
    expect(t.why).toMatch(/no finance cost was charged/i);
  });

  it("refuses a ratio covenant with no threshold, and an untestable one with no wording", async () => {
    await expect(addCovenant({
      ...S,
      covenant: { borrowingCode: "BRW-1", code: "X1", metric: "CURRENT_RATIO", thresholdBps: null },
    })).rejects.toThrow(/whole number of basis points/i);
    await expect(addCovenant({
      ...S,
      covenant: { borrowingCode: "BRW-1", code: "X2", metric: "OTHER" },
    })).rejects.toThrow(/has to say what it actually requires/i);
  });

  it("says nothing about another organisation's borrowings", async () => {
    const reg = await borrowingRegister({ orgId: "someone-else", entityId: ENT, asOf: "2026-12-31" });
    expect(reg.facilities).toEqual([]);
    expect(reg.totals.outstandingMinor).toBe("0");
    await expect(borrowingSchedule({ orgId: "someone-else", entityId: ENT, code: "BRW-1" }))
      .rejects.toThrow(/no facility BRW-1/i);
  });

  it("leaves the trial balance balanced at the end of it all", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-12" });
    expect(tb.balanced).toBe(true);
  });
});
