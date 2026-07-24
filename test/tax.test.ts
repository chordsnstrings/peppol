import { describe, it, expect } from "vitest";
import { computeLine, computeTotals, deriveDocType } from "@/lib/domain/tax";
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
});
