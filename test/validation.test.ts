import { describe, it, expect } from "vitest";
import { validateInvoice } from "@/lib/domain/validation";
import { invoice, line } from "./helpers";

const codes = (inv: Parameters<typeof validateInvoice>[0]) => validateInvoice(inv).issues.map((i) => i.code);

describe("validateInvoice", () => {
  it("flags an empty invoice and blocks sending", () => {
    const r = validateInvoice({});
    expect(r.canSend).toBe(false);
    expect(codes({})).toContain("AE-0001"); // no number
    expect(codes({})).toContain("AE-0002"); // no lines
  });

  it("requires a buyer name", () => {
    const inv = invoice({ buyer: { nameEn: "" } });
    expect(codes(inv)).toContain("AE-0200");
    expect(validateInvoice(inv).canSend).toBe(false);
  });

  it("blocks lines with non-positive quantity", () => {
    const inv = invoice({ lines: [line({ qty: 0 })] });
    expect(codes(inv)).toContain("AE-0101");
  });

  it("requires the buyer TRN on reverse-charge lines", () => {
    const inv = invoice({ lines: [line({ taxProfileCode: "REVERSE_CHARGE" })], buyer: { nameEn: "Buyer", trn: undefined } });
    expect(codes(inv)).toContain("AE-0201");
  });

  it("passes a well-formed invoice", () => {
    const inv = invoice({
      number: "INV2026-00009",
      lines: [line({ description: "Consulting", qty: 1, unitPriceMinor: 100000, taxProfileCode: "STANDARD_5" })],
      buyer: { nameEn: "Acme FZE" },
      currency: "AED",
    });
    const r = validateInvoice(inv);
    expect(r.canSend).toBe(true);
    expect(r.errors).toBe(0);
  });
});
