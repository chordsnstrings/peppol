import { describe, it, expect } from "vitest";
import {
  aedTaxTotals,
  categorySubtotalKey,
  computeLine,
  computeTotals,
  deriveDocType,
  documentTaxStatements,
  importVatOnGoods,
  marginSchemeLineTax,
  MARGIN_SCHEME_STATEMENT,
  PURCHASE_TAX_PROFILE_LIST,
  REVERSE_CHARGE_STATEMENT,
  TAX_PROFILE_LIST,
} from "@/lib/domain/tax";
import { convertMinorAtRate } from "@/lib/domain/money";
import type { FxInfo, TaxableLine } from "@/lib/domain/types";
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

describe("goods imported into the UAE", () => {
  /**
   * Article 48 of Federal Decree-Law 8/2017 puts the tax on an import of goods
   * on the importer rather than on the overseas seller. The seller's invoice
   * carries no UAE VAT at all, so the document has to state none — and the
   * importer still owes five percent of the value, which it declares in box 6
   * of the VAT 201 and recovers in box 10.
   *
   * Goods of AED 5,000 imported: the supplier is paid AED 5,000, and AED 250 is
   * accounted for to the FTA and reclaimed from it in the same breath.
   */
  const imported = (over: Partial<TaxableLine> = {}): TaxableLine => ({
    ...line(),
    taxProfileCode: "IMPORT_GOODS",
    unitPriceMinor: 500_000,
    ...over,
  });

  it("states no tax on the line, because the supplier charged none", () => {
    expect(computeLine(imported())).toEqual({ lineNetMinor: 500_000, lineVatMinor: 0 });
  });

  it("works out the tax the importer owes on it", () => {
    expect(importVatOnGoods([imported()])).toBe(25_000);
  });

  it("rounds the import tax once, over the goods, not once per line", () => {
    // Two lines of 3,333 fils: 6,666 × 5% = 333.3, so 333. Per line it would be
    // 167 + 167 = 334, and the return would be a fils out.
    const l = (n: number) => imported({ lineNo: n, unitPriceMinor: 3_333 });
    expect(importVatOnGoods([l(1), l(2)])).toBe(333);
  });

  it("keeps the import tax out of what the supplier is paid", () => {
    const t = computeTotals([imported(), line({ lineNo: 2, unitPriceMinor: 100_000 })]);
    expect(t.taxExclusiveMinor).toBe(600_000);
    // 5,000 on the standard-rated line only. The import contributes nothing:
    // paying the overseas supplier the FTA's money would be paying it twice.
    expect(t.vatMinor).toBe(5_000);
    expect(t.payableMinor).toBe(605_000);
    // Reported beside it, so it can be posted and put on the return.
    expect(t.importVatMinor).toBe(25_000);

    // Its own subtotal. The import profile carries category AE at 5% and the
    // reverse charge carries AE at 0, so a key of category-and-rate alone would
    // have put 5% of the customs value on the face of the document.
    const imports = t.perCategory.find((c) => c.profileCode === "IMPORT_GOODS")!;
    expect(imports.taxableMinor).toBe(500_000);
    expect(imports.vatMinor).toBe(0);
    expect(imports.ratePercent).toBe(0);
  });

  it("leaves documents with no imported goods alone", () => {
    expect(computeTotals([line({ unitPriceMinor: 100_000 })]).importVatMinor).toBeUndefined();
  });

  it("does not make a document that states no tax a tax invoice", () => {
    expect(deriveDocType([imported()])).toBe("COMMERCIAL_INVOICE");
  });

  it("is offered on a purchase and not in the tax dropdown of a sales document", () => {
    // Nothing an entity sells is an import of its own, and the invoice, product
    // and sales-order editors all render TAX_PROFILE_LIST whole.
    expect(TAX_PROFILE_LIST.map((p) => p.code)).not.toContain("IMPORT_GOODS");
    expect(PURCHASE_TAX_PROFILE_LIST.map((p) => p.code)).toContain("IMPORT_GOODS");
  });
});

describe("the AED conversion (Article 69, ER Article 59(1)(k))", () => {
  const peg: FxInfo = { rateToAED: "3.6725", source: "CBUAE", rateDate: "2026-07-01" };
  const usd = () => [line({ qty: 2, unitPriceMinor: 50_000 })];

  it("records the tax and the payable in AED when the build is given the rate", () => {
    // 1,000.00 USD of goods, 50.00 USD of tax. At 3.6725 the tax is 18,362.5
    // fils, which rounds away from zero to 183.63 AED, and the payable is
    // 105,000 × 3.6725 = 385,612.5 → 3,856.13 AED.
    const t = computeTotals(usd(), { currency: "USD", fx: peg });
    expect(t.vatMinorAED).toBe(18_363);
    expect(t.payableMinorAED).toBe(385_613);
    // The document currency is untouched: the conversion is stated beside the
    // figures, it does not replace them.
    expect(t.vatMinor).toBe(5_000);
    expect(t.payableMinor).toBe(105_000);
  });

  it("converts exactly, not through a float", () => {
    // 1.80 at 1.025 is 1.845, which is 1.85 rounded half away from zero. In
    // binary floating point the product lands a hair under and rounds to 1.84 —
    // a fils the FTA is short on every document that hits the case.
    expect(convertMinorAtRate(180, "1.025")).toBe(185);
    expect(convertMinorAtRate(8_825, "2.260")).toBe(19_945);
    expect(convertMinorAtRate(53_905, "8.700")).toBe(468_974);
  });

  it("converts nothing it cannot convert", () => {
    // A half-typed rate, a nought, a word. Undefined rather than a nought: a
    // nought reads as a conversion that was made and came to nothing.
    expect(convertMinorAtRate(5_000, "3.")).toBeUndefined();
    expect(convertMinorAtRate(5_000, "0")).toBeUndefined();
    expect(convertMinorAtRate(5_000, "abc")).toBeUndefined();
    expect(convertMinorAtRate(5_000, "-3.67")).toBeUndefined();
    expect(convertMinorAtRate(5_000, "")).toBeUndefined();
  });

  it("records nothing on an AED document, or where no usable rate was captured", () => {
    expect(computeTotals(usd()).vatMinorAED).toBeUndefined();
    expect(computeTotals(usd(), { currency: "AED", fx: peg }).vatMinorAED).toBeUndefined();
    expect(
      computeTotals(usd(), {
        currency: "USD",
        fx: { rateToAED: "", source: "MANUAL", rateDate: "2026-07-01" },
      }).vatMinorAED,
    ).toBeUndefined();
  });

  it("reads back the same figures from a document whose totals predate the fields", () => {
    // A persisted invoice totalled before the AED figures were recorded — or by
    // a caller with no rate to hand — still prints and serializes the
    // conversion, because the renderers derive it from the document's own rate
    // rather than from a stored copy that may have been taken at another one.
    const totals = computeTotals(usd());
    expect(totals.vatMinorAED).toBeUndefined();
    const aed = aedTaxTotals({ currency: "USD", fx: peg, totals });
    expect(aed?.vatMinorAED).toBe(18_363);
    expect(aed?.payableMinorAED).toBe(385_613);
    expect(aed?.rateToAED).toBe("3.6725");
    expect(aed?.source).toBe("CBUAE");
  });

  it("makes no conversion the document cannot stand behind", () => {
    const totals = computeTotals(usd());
    expect(aedTaxTotals({ currency: "AED", fx: peg, totals })).toBeUndefined();
    expect(aedTaxTotals({ currency: "USD", totals })).toBeUndefined();
  });
});

describe("the statements a document must carry", () => {
  it("states that the recipient accounts for the tax, and cites the provision", () => {
    // ER Article 59(1)(l) requires both halves. A bare "VAT 0%" row reads as a
    // relief, and a buyer who takes it at face value never self-accounts.
    const totals = computeTotals([line({ taxProfileCode: "REVERSE_CHARGE" })]);
    expect(documentTaxStatements(totals)).toEqual([REVERSE_CHARGE_STATEMENT]);
    expect(REVERSE_CHARGE_STATEMENT).toContain("Article 48");
  });

  it("says the margin scheme was applied", () => {
    // ER Article 43: say so, and state no tax amount. The totals already
    // withhold the amount; this is the other half of the rule.
    const totals = computeTotals([
      line({ taxProfileCode: "MARGIN_SCHEME", unitPriceMinor: 3_500_000, marginPurchaseMinor: 3_000_000 }),
    ]);
    expect(documentTaxStatements(totals)).toEqual([MARGIN_SCHEME_STATEMENT]);
  });

  it("says nothing on an ordinary document", () => {
    expect(documentTaxStatements(computeTotals([line()]))).toEqual([]);
  });
});

describe("categorySubtotalKey", () => {
  it("keeps treatments that state no tax out of the subtotal they would corrupt", () => {
    // Both carry a 5% profile — margin under category S, imports under AE — and
    // both must show nil on the face of the document, so neither may share a
    // subtotal with the ordinary rate that has the same key.
    expect(categorySubtotalKey("MARGIN_SCHEME")).not.toBe(categorySubtotalKey("STANDARD_5"));
    expect(categorySubtotalKey("IMPORT_GOODS")).not.toBe(categorySubtotalKey("REVERSE_CHARGE"));
    // Two treatments that state the same rate under the same category are one
    // subtotal, which is what lets the serializer hang a reason on the right one.
    expect(categorySubtotalKey("ZERO_EXPORT")).toBe(categorySubtotalKey("ZERO_OTHER"));
  });
});
