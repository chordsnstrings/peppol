import { describe, it, expect } from "vitest";
import { computeLine, computeTotals, deriveDocType, marginSchemeLineTax } from "@/lib/domain/tax";
import { line } from "./helpers";

describe("computeLine", () => {
  it("computes net and 5% VAT", () => {
    expect(computeLine({ qty: 2, unitPriceMinor: 50000, taxProfileCode: "STANDARD_5" })).toEqual({
      lineNetMinor: 100000,
      lineVatMinor: 5000,
    });
  });
  it("zero-rated export has no VAT", () => {
    expect(computeLine({ qty: 1, unitPriceMinor: 90000, taxProfileCode: "ZERO_EXPORT" }).lineVatMinor).toBe(0);
  });
});

describe("computeTotals", () => {
  it("sums a single standard line", () => {
    const t = computeTotals([line({ qty: 2, unitPriceMinor: 50000 })]);
    expect(t.taxExclusiveMinor).toBe(100000);
    expect(t.vatMinor).toBe(5000);
    expect(t.taxInclusiveMinor).toBe(105000);
    expect(t.perCategory).toHaveLength(1);
  });

  it("rounds VAT per category, not per line (EN 16931)", () => {
    // Two lines of 3333 → category taxable 6666 → VAT 333 (not 167+167=334).
    const t = computeTotals([
      line({ qty: 1, unitPriceMinor: 3333 }),
      line({ lineNo: 2, qty: 1, unitPriceMinor: 3333 }),
    ]);
    expect(t.taxExclusiveMinor).toBe(6666);
    expect(t.vatMinor).toBe(333);
  });

  it("splits VAT by category for mixed rates", () => {
    const t = computeTotals([
      line({ qty: 1, unitPriceMinor: 100000, taxProfileCode: "STANDARD_5" }),
      line({ lineNo: 2, qty: 1, unitPriceMinor: 100000, taxProfileCode: "ZERO_EXPORT" }),
    ]);
    expect(t.taxExclusiveMinor).toBe(200000);
    expect(t.vatMinor).toBe(5000); // only the standard line contributes
    expect(t.perCategory).toHaveLength(2);
  });
});

describe("deriveDocType", () => {
  it("is a tax invoice when any line is taxable", () => {
    expect(deriveDocType([line({ taxProfileCode: "STANDARD_5" })])).toBe("TAX_INVOICE");
  });

  it("does not make a margin-scheme sale a tax invoice", () => {
    // A tax invoice is the document that states the tax, and Executive
    // Regulation Article 43 forbids stating it on a margin-scheme supply. So a
    // used-car sale on its own is a commercial invoice.
    const doc = [line({ taxProfileCode: "MARGIN_SCHEME", unitPriceMinor: 3_500_000, marginPurchaseMinor: 3_000_000 })];
    expect(deriveDocType(doc)).toBe("COMMERCIAL_INVOICE");
  });

  it("is still a tax invoice when an ordinary taxable line sits beside a margin one", () => {
    // The standard-rated line does state tax, so the document is a tax invoice
    // for it; the margin line simply shows no tax beside it.
    expect(
      deriveDocType([
        line({ taxProfileCode: "MARGIN_SCHEME", unitPriceMinor: 3_500_000, marginPurchaseMinor: 3_000_000 }),
        line({ lineNo: 2, taxProfileCode: "STANDARD_5", unitPriceMinor: 100_000 }),
      ]),
    ).toBe("TAX_INVOICE");
  });
});

describe("profit margin scheme", () => {
  /**
   * Article 29 of Federal Decree-Law 8/2017 taxes the margin, and Article 43 of
   * the Executive Regulation puts the tax INSIDE it. Bought for AED 30,000,
   * sold for AED 35,000: the margin is AED 5,000 = 500,000 fils, and the tax is
   * 500,000 × 5 ÷ 105 = 23,809.52…, so 23,810 fils. Not 25,000, which is 5% OF
   * the margin, and emphatically not 175,000, which is 5% of the whole price.
   */
  const usedCar = () =>
    line({ taxProfileCode: "MARGIN_SCHEME", unitPriceMinor: 3_500_000, marginPurchaseMinor: 3_000_000 });

  it("takes 5/105 of the margin, not 5% of it and not 5% of the price", () => {
    const m = marginSchemeLineTax(usedCar());
    expect(m.marginMinor).toBe(500_000);
    expect(m.taxMinor).toBe(23_810);
    expect(m.costKnown).toBe(true);
    expect(m.taxMinor).not.toBe(25_000);
    expect(m.taxMinor).not.toBe(175_000);
  });

  it("charges the buyer nothing on the face of the line", () => {
    // ER Article 43: the invoice says the scheme was applied and states no tax.
    expect(computeLine(usedCar()).lineNetMinor).toBe(3_500_000);
    expect(computeLine(usedCar()).lineVatMinor).toBe(0);
  });

  it("rounds once, at the end, and to the nearest fils", () => {
    // A margin of 210 fils is exactly ten fils of tax: 210 × 5 ÷ 105 = 10.
    expect(
      marginSchemeLineTax(line({ taxProfileCode: "MARGIN_SCHEME", unitPriceMinor: 1_000_210, marginPurchaseMinor: 1_000_000 }))
        .taxMinor,
    ).toBe(10);
    // A margin of one fils is 0.0476 of a fils of tax, which is nothing.
    expect(
      marginSchemeLineTax(line({ taxProfileCode: "MARGIN_SCHEME", unitPriceMinor: 1_000_001, marginPurchaseMinor: 1_000_000 }))
        .taxMinor,
    ).toBe(0);
  });

  it("charges nothing on a nil or negative margin, and does not turn a loss into a credit", () => {
    const atCost = marginSchemeLineTax(
      line({ taxProfileCode: "MARGIN_SCHEME", unitPriceMinor: 3_000_000, marginPurchaseMinor: 3_000_000 }),
    );
    expect(atCost.taxMinor).toBe(0);
    expect(atCost.costKnown).toBe(true);

    const atALoss = marginSchemeLineTax(
      line({ taxProfileCode: "MARGIN_SCHEME", unitPriceMinor: 2_800_000, marginPurchaseMinor: 3_000_000 }),
    );
    expect(atALoss.marginMinor).toBe(0);
    // Not −200,000 and not −9,524: there is no negative output tax on a margin.
    expect(atALoss.taxMinor).toBe(0);
  });

  it("says the cost is unknown rather than treating it as nought", () => {
    // Nought would make the whole selling price the margin, which is the very
    // thing the scheme exists to avoid.
    const noCost = marginSchemeLineTax(line({ taxProfileCode: "MARGIN_SCHEME", unitPriceMinor: 3_500_000 }));
    expect(noCost.costKnown).toBe(false);
    expect(noCost.taxMinor).toBe(0);
  });

  it("keeps the margin tax out of the payable and out of the standard-rated subtotal", () => {
    // One used car at AED 35,000 bought for AED 30,000, and one ordinary
    // standard-rated line at AED 1,000.
    const t = computeTotals([
      usedCar(),
      line({ lineNo: 2, taxProfileCode: "STANDARD_5", unitPriceMinor: 100_000 }),
    ]);
    expect(t.taxExclusiveMinor).toBe(3_600_000);
    // 5,000 on the standard line only. The old behaviour charged 5% of all
    // 3,600,000 — 180,000 — which taxed the whole price of the car.
    expect(t.vatMinor).toBe(5_000);
    expect(t.taxInclusiveMinor).toBe(3_605_000);
    // The buyer pays the price plus the tax on the standard line, and nothing
    // for the margin: that tax is already inside the AED 35,000.
    expect(t.payableMinor).toBe(3_605_000);
    expect(t.marginTaxMinor).toBe(23_810);
    expect(t.marginLinesWithoutCostCount).toBe(0);

    // Two subtotals, not one. Both carry category S, so a shared key would have
    // folded the car into the standard-rated subtotal.
    const margin = t.perCategory.find((c) => c.profileCode === "MARGIN_SCHEME")!;
    const standard = t.perCategory.find((c) => c.profileCode === "STANDARD_5")!;
    expect(margin.taxableMinor).toBe(3_500_000);
    expect(margin.vatMinor).toBe(0);
    expect(margin.ratePercent).toBe(0);
    expect(standard.taxableMinor).toBe(100_000);
    expect(standard.vatMinor).toBe(5_000);
  });

  it("counts margin lines whose cost nobody recorded", () => {
    const t = computeTotals([
      usedCar(),
      line({ lineNo: 2, taxProfileCode: "MARGIN_SCHEME", unitPriceMinor: 900_000 }),
    ]);
    expect(t.marginTaxMinor).toBe(23_810);
    expect(t.marginLinesWithoutCostCount).toBe(1);
  });

  it("leaves documents with no margin line alone", () => {
    const t = computeTotals([line({ qty: 2, unitPriceMinor: 50_000 })]);
    expect(t.marginTaxMinor).toBeUndefined();
    expect(t.marginLinesWithoutCostCount).toBeUndefined();
  });
});
