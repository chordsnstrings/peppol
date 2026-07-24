import { describe, it, expect } from "vitest";
import { validateTRN, derivePeppolId, cleanTaxId, isWellFormedPeppolId } from "@/lib/domain/peppol";

describe("validateTRN", () => {
  it("accepts a 15-digit TRN", () => {
    const r = validateTRN("100123456700003");
    expect(r.ok).toBe(true);
    expect(r.cleaned).toBe("100123456700003");
  });
  it("warns on 14 digits (Excel-stripped leading zero)", () => {
    const r = validateTRN("10012345670000");
    expect(r.ok).toBe(false);
    expect(r.tone).toBe("warning");
  });
  it("is neutral when empty", () => {
    expect(validateTRN("  ").tone).toBe("neutral");
  });
});

describe("cleanTaxId", () => {
  it("normalises O→0 and strips non-digits", () => {
    expect(cleanTaxId("1OO-123 456")).toBe("100123456");
  });
});

describe("derivePeppolId / isWellFormedPeppolId", () => {
  it("derives a 0235 scheme id from a tax id", () => {
    expect(derivePeppolId("100123456700003")).toBe("0235:1001234567");
    expect(derivePeppolId("123")).toBeUndefined();
  });
  it("validates well-formed peppol ids", () => {
    expect(isWellFormedPeppolId("0235:1001234567")).toBe(true);
    expect(isWellFormedPeppolId("nope")).toBe(false);
  });
});
