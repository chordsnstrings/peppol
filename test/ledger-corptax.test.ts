import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { post } from "@/lib/server/ledger/post";
import { corporateTaxComputation, postTaxProvision } from "@/lib/server/ledger/corptax";
import { trialBalance } from "@/lib/server/ledger/reports";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-ct";
const ENT = "t-ent-ct";

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

/** Revenue banked, in minor units. */
const sell = (date: string, minor: number, account = "4000") =>
  post({
    orgId: ORG, entityId: ENT, entryDate: date, source: "manual", memo: "Sales",
    lines: [{ account: "1010", debit: minor }, { account, credit: minor }],
  });

/** An expense paid from the bank, in minor units. */
const spend = (date: string, minor: number, account = "6100") =>
  post({
    orgId: ORG, entityId: ENT, entryDate: date, source: "manual", memo: "Costs",
    lines: [{ account, debit: minor }, { account: "1010", credit: minor }],
  });

/** A whole month as a tax period, which is all the shape the computation needs. */
const month = (m: string) => {
  const last = new Date(Date.UTC(2026, Number(m), 0)).getUTCDate();
  return { from: `2026-${m}-01`, to: `2026-${m}-${last}` };
};

const compute = (
  m: { from: string; to: string },
  over: Partial<Parameters<typeof corporateTaxComputation>[0]> = {},
) => corporateTaxComputation({ orgId: ORG, entityId: ENT, from: m.from, to: m.to, ...over });

const adj = (r: Awaited<ReturnType<typeof corporateTaxComputation>>, key: string) =>
  r.adjustments.find((a) => a.key === key)!;

d("UAE corporate tax computation", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // Each scenario gets its own month, so one set of books can carry them all
    // without any of them seeing another's postings.
    // February — other income that may or may not be an exempt dividend.
    await sell("2026-02-10", 40_000_00);
    await sell("2026-02-11", 10_000_00, "4900");

    // March — a profit comfortably inside the 0% band.
    await sell("2026-03-10", 300_000_00);
    await spend("2026-03-11", 100_000_00);

    // April — a profit above the band.
    await sell("2026-04-10", 1_000_000_00);
    await spend("2026-04-11", 500_000_00);

    // May — travel and entertainment.
    await sell("2026-05-10", 600_000_00);
    await spend("2026-05-11", 100_000_00, "6400");

    // June — government fees, some of which are penalties.
    await sell("2026-06-10", 500_000_00);
    await spend("2026-06-11", 30_000_00, "6300");

    // July — a small business, under the AED 3,000,000 revenue ceiling.
    await sell("2026-07-10", 2_000_000_00);
    await spend("2026-07-11", 1_000_000_00);

    // August — the same profit, but too much revenue for the relief.
    await sell("2026-08-10", 4_000_000_00);
    await spend("2026-08-11", 3_000_000_00);

    // September — heavily geared: 30% of EBITDA beats the de minimis.
    await sell("2026-09-10", 50_000_000_00);
    await spend("2026-09-11", 25_000_000_00, "6900");

    // October — geared, but small enough that the de minimis is the cap.
    await sell("2026-10-10", 30_000_000_00);
    await spend("2026-10-11", 13_000_000_00, "6900");

    // November — a loss.
    await sell("2026-11-10", 100_000_00);
    await spend("2026-11-11", 400_000_00);

    // December — revenue just under the Small Business Relief ceiling.
    await sell("2026-12-10", 2_900_000_00);
  });
  afterAll(async () => { await wipe(); });

  it("starts at the accounting profit the statements report, and taxes nothing inside the band", async () => {
    const r = await compute(month("03"));
    // 300,000 of sales less 100,000 of rent.
    expect(r.accountingProfitMinor).toBe("20000000");
    expect(r.taxableIncomeMinor).toBe("20000000");
    // Wholly inside the AED 375,000 nil band (Article 3 with Cabinet Decision 116/2022).
    expect(r.zeroBandMinor).toBe("20000000");
    expect(r.taxedBandMinor).toBe("0");
    expect(r.taxPayableMinor).toBe("0");
    expect(r.effectiveRateBps).toBe(0n);
  });

  it("charges 9% on the excess over AED 375,000 only, to the fil", async () => {
    const r = await compute(month("04"));
    expect(r.accountingProfitMinor).toBe("50000000");
    expect(r.zeroBandMinor).toBe("37500000");
    expect(r.taxedBandMinor).toBe("12500000");
    // 9% of AED 125,000 = AED 11,250.00 exactly.
    expect(r.taxPayableMinor).toBe("1125000");
    // 2.25% of taxable income, as an integer number of basis points.
    expect(r.effectiveRateBps).toBe(225n);
    expect(typeof r.effectiveRateBps).toBe("bigint");
  });

  it("disallows half of entertainment and says the figure came from the account, not the preparer", async () => {
    const r = await compute(month("05"));
    const e = adj(r, "entertainment");
    // Article 32: 50% of AED 100,000.
    expect(e.amountMinor).toBe("5000000");
    expect(e.origin).toBe("derived");
    expect(e.accounts).toContain("6400");
    expect(r.taxableIncomeMinor).toBe("55000000");
    // 6400 mixes travel with entertainment, so the derived figure is an upper
    // bound and the computation has to say so rather than imply precision.
    expect(r.warnings.some((w) => /6400/.test(w) && /travel/i.test(w))).toBe(true);
  });

  it("uses a supplied entertainment figure instead, and marks it supplied", async () => {
    const r = await compute(month("05"), { adjustments: { entertainmentMinor: "4000000" } });
    const e = adj(r, "entertainment");
    expect(e.amountMinor).toBe("2000000");
    expect(e.origin).toBe("supplied");
    expect(e.accounts).toEqual([]);
    expect(r.taxableIncomeMinor).toBe("52000000");
    expect(r.warnings.some((w) => /6400/.test(w) && /travel/i.test(w))).toBe(false);
  });

  it("adds fines back in full, and names the account when it cannot find them itself", async () => {
    const bare = await compute(month("06"));
    // Nothing is added back on the strength of 6300 alone — it holds licence
    // fees too — but the account is named rather than passed over in silence.
    expect(adj(bare, "fines_and_penalties").amountMinor).toBe("0");
    expect(adj(bare, "fines_and_penalties").origin).toBe("none");
    expect(bare.warnings.some((w) => /6300/.test(w))).toBe(true);

    const told = await compute(month("06"), { adjustments: { finesAndPenaltiesMinor: 3_000_00 } });
    const f = adj(told, "fines_and_penalties");
    // Article 33: a fine is disallowed in full, not by half.
    expect(f.amountMinor).toBe("300000");
    expect(f.origin).toBe("supplied");
    expect(told.taxableIncomeMinor).toBe(
      (BigInt(bare.taxableIncomeMinor) + 300_000n).toString(),
    );
  });

  it("deducts exempt income only when it is supplied, and warns about other income when it is not", async () => {
    const bare = await compute(month("02"));
    expect(bare.accountingProfitMinor).toBe("5000000");
    expect(adj(bare, "exempt_income").amountMinor).toBe("0");
    expect(bare.warnings.some((w) => /4900/.test(w))).toBe(true);

    const told = await compute(month("02"), { adjustments: { exemptIncomeMinor: 10_000_00 } });
    expect(adj(told, "exempt_income").amountMinor).toBe("-1000000");
    expect(adj(told, "exempt_income").origin).toBe("supplied");
    expect(told.totalDeductionsMinor).toBe("1000000");
    expect(told.taxableIncomeMinor).toBe("4000000");
  });

  it("refuses exempt income larger than all the income there was", async () => {
    await expect(compute(month("02"), { adjustments: { exemptIncomeMinor: 99_999_999_00 } }))
      .rejects.toThrow(/exceeds the entity's total income/i);
  });

  it("does not apply Small Business Relief unless it is elected", async () => {
    const r = await compute(month("07"));
    expect(r.smallBusinessRelief.eligible).toBe(true);
    expect(r.smallBusinessRelief.elected).toBe(false);
    expect(r.smallBusinessRelief.applied).toBe(false);
    expect(r.smallBusinessRelief.reason).toMatch(/not elected/i);
    // 9% of (1,000,000 − 375,000).
    expect(r.taxPayableMinor).toBe("5625000");
  });

  it("applies Small Business Relief when it is elected, and keeps the figure it displaced", async () => {
    const r = await compute(month("07"), { smallBusinessRelief: true });
    expect(r.smallBusinessRelief.applied).toBe(true);
    expect(r.smallBusinessRelief.revenueMinor).toBe("200000000");
    expect(r.taxableIncomeBeforeReliefMinor).toBe("100000000");
    expect(r.taxableIncomeMinor).toBe("0");
    expect(r.taxPayableMinor).toBe("0");
    expect(r.effectiveRateBps).toBeNull();
  });

  it("refuses the election when revenue exceeds AED 3,000,000, and taxes the period in full", async () => {
    const r = await compute(month("08"), { smallBusinessRelief: true });
    expect(r.smallBusinessRelief.elected).toBe(true);
    expect(r.smallBusinessRelief.eligible).toBe(false);
    expect(r.smallBusinessRelief.applied).toBe(false);
    expect(r.smallBusinessRelief.reason).toMatch(/3,000,000/);
    expect(r.warnings.some((w) => /Small Business Relief was elected but is not available/.test(w))).toBe(true);
    expect(r.taxPayableMinor).toBe("5625000");
  });

  it("caps the interest deduction at 30% of EBITDA when that is the greater figure", async () => {
    const r = await compute(month("09"), { adjustments: { netInterestExpenditureMinor: 25_000_000_00 } });
    // Profit 25,000,000 after 25,000,000 of interest, so EBITDA is 50,000,000.
    expect(r.interestLimitation.adjustedEbitdaMinor).toBe("5000000000");
    expect(r.interestLimitation.thirtyPercentOfEbitdaMinor).toBe("1500000000");
    expect(r.interestLimitation.capBasis).toBe("ebitda");
    expect(r.interestLimitation.capMinor).toBe("1500000000");
    expect(r.interestLimitation.disallowedMinor).toBe("1000000000");
    expect(adj(r, "interest_cap").amountMinor).toBe("1000000000");
    expect(r.taxableIncomeMinor).toBe("3500000000");
    // 9% of (35,000,000 − 375,000).
    expect(r.taxPayableMinor).toBe("311625000");
  });

  it("takes the AED 12,000,000 de minimis when 30% of EBITDA is smaller", async () => {
    const r = await compute(month("10"), { adjustments: { netInterestExpenditureMinor: 13_000_000_00 } });
    expect(r.interestLimitation.thirtyPercentOfEbitdaMinor).toBe("900000000");
    expect(r.interestLimitation.capBasis).toBe("de-minimis");
    expect(r.interestLimitation.capMinor).toBe("1200000000");
    // Only the AED 1,000,000 above the de minimis is disallowed.
    expect(r.interestLimitation.disallowedMinor).toBe("100000000");
    expect(r.warnings.some((w) => /ten tax periods/.test(w))).toBe(true);
  });

  it("leaves the interest rule alone when no net interest is supplied", async () => {
    const r = await compute(month("09"));
    expect(adj(r, "interest_cap").origin).toBe("none");
    expect(r.interestLimitation.disallowedMinor).toBe("0");
    expect(r.interestLimitation.supplied).toBe(false);
  });

  it("charges nothing on a loss, and says the loss will not relieve itself", async () => {
    const r = await compute(month("11"));
    expect(r.accountingProfitMinor).toBe("-30000000");
    expect(r.taxableIncomeMinor).toBe("-30000000");
    expect(r.zeroBandMinor).toBe("0");
    expect(r.taxedBandMinor).toBe("0");
    expect(r.taxPayableMinor).toBe("0");
    expect(r.effectiveRateBps).toBeNull();
    expect(r.warnings.some((w) => /taxable loss/i.test(w) && /carried forward/i.test(w))).toBe(true);
  });

  it("warns when revenue is close enough to the AED 3,000,000 ceiling to lose the relief", async () => {
    const r = await compute(month("12"));
    expect(r.smallBusinessRelief.eligible).toBe(true);
    expect(r.smallBusinessRelief.revenueMinor).toBe("290000000");
    expect(r.warnings.some((w) => /within 10%/.test(w) && /whole period/.test(w))).toBe(true);
  });

  it("refuses a tax period that ends before it starts", async () => {
    await expect(compute({ from: "2026-04-30", to: "2026-04-01" }))
      .rejects.toThrow(/ends before it starts/i);
  });

  it("refuses a negative supplied adjustment rather than quietly flipping its sign", async () => {
    await expect(compute(month("04"), { adjustments: { finesAndPenaltiesMinor: "-100" } }))
      .rejects.toThrow(/must not be negative/i);
  });

  it("says the liability is not on the balance sheet until the provision is posted", async () => {
    const r = await compute(month("04"));
    expect(r.provision.posted).toBe(false);
    expect(r.provision.expensePerLedgerMinor).toBe("0");
    expect(r.warnings.some((w) => /no provision has been posted/i.test(w))).toBe(true);
  });
});

d("the corporate tax provision", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
    await sell("2026-04-10", 1_000_000_00);
    await spend("2026-04-11", 500_000_00);
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("charges the tax to profit and recognises the liability on 2400", async () => {
    const r = await postTaxProvision({ orgId: ORG, entityId: ENT, fiscalYear: "2026", amountMinor: 1_125_000n });
    expect(r.alreadyPosted).toBe(false);
    expect(r.reference).toMatch(/^CT-/);
    // The chart seeds 7000 with subtype CT_EXPENSE, so no fallback is needed.
    expect(r.expenseAccount).toBe("7000");
    expect(r.payableAccount).toBe("2400");
    // A year-end adjustment belongs in the adjustment period, not in December.
    expect(r.periodLabel).toBe("2026-ADJ");
    expect(r.warnings).toEqual([]);

    const entry = await db.journalEntry.findFirstOrThrow({
      where: { orgId: ORG, externalKey: `corptax:${ENT}:2026` },
      include: { lines: { include: { account: true } } },
    });
    const dr = entry.lines.find((l) => l.functionalAmountMinor > 0n)!;
    const cr = entry.lines.find((l) => l.functionalAmountMinor < 0n)!;
    expect(dr.account.code).toBe("7000");
    expect(dr.functionalAmountMinor).toBe(1_125_000n);
    expect(cr.account.code).toBe("2400");
    expect(cr.functionalAmountMinor).toBe(-1_125_000n);
  });

  it("posting the same year twice is a no-op", async () => {
    const again = await postTaxProvision({ orgId: ORG, entityId: ENT, fiscalYear: "2026", amountMinor: 1_125_000n });
    expect(again.alreadyPosted).toBe(true);
    expect(again.amountMinor).toBe("1125000");
    const count = await db.journalEntry.count({ where: { orgId: ORG, externalKey: `corptax:${ENT}:2026` } });
    expect(count).toBe(1);
  });

  it("does not silently re-provide a different amount over one already posted", async () => {
    const other = await postTaxProvision({ orgId: ORG, entityId: ENT, fiscalYear: "2026", amountMinor: 999_999n });
    expect(other.alreadyPosted).toBe(true);
    expect(other.amountMinor).toBe("1125000");
    expect(other.warnings.some((w) => /already posted/i.test(w) && /Reverse/.test(w))).toBe(true);
  });

  it("adds its own charge back, so the tax is not computed on a profit net of tax", async () => {
    const r = await corporateTaxComputation({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-12-31" });
    // Profit is now 500,000 less the 11,250 provision.
    expect(r.accountingProfitMinor).toBe("48875000");
    const back = adj(r, "corporate_tax_expense");
    expect(back.amountMinor).toBe("1125000");
    expect(back.origin).toBe("derived");
    expect(back.accounts).toEqual(["7000"]);
    // Article 33: the charge comes straight back out, so taxable income and the
    // tax on it are unchanged by having provided for it.
    expect(r.taxableIncomeMinor).toBe("50000000");
    expect(r.taxPayableMinor).toBe("1125000");
    expect(r.provision.posted).toBe(true);
    expect(r.provision.matches).toBe(true);
    expect(r.warnings.some((w) => /does not equal the computed charge/.test(w))).toBe(false);
  });

  it("refuses a provision of nothing, and a year that does not exist", async () => {
    await expect(postTaxProvision({ orgId: ORG, entityId: ENT, fiscalYear: "2026", amountMinor: 0 }))
      .rejects.toThrow(/must be a positive amount/i);
    await expect(postTaxProvision({ orgId: ORG, entityId: ENT, fiscalYear: "2029", amountMinor: 100 }))
      .rejects.toThrow(/no fiscal year "2029"/i);
  });

  it("leaves the trial balance tying after the provision", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-ADJ" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
    const codes = tb.rows.map((r) => r.code);
    expect(codes).toContain("7000");
    expect(codes).toContain("2400");
  });
});
