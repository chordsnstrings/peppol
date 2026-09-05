import { describe, it, expect } from "vitest";
import { validateInvoice } from "@/lib/domain/validation";
import type { FxInfo, Party } from "@/lib/domain/types";
import { invoice, line } from "./helpers";

const codes = (inv: Parameters<typeof validateInvoice>[0]) => validateInvoice(inv).issues.map((i) => i.code);
const issue = (inv: Parameters<typeof validateInvoice>[0], code: string) =>
  validateInvoice(inv).issues.find((i) => i.code === code);

/** The two parties as a real document carries them, so one rule can be read at a time. */
const seller: Party = {
  nameEn: "Seller LLC",
  trn: "100123456700003",
  address: { street: "Sheikh Zayed Road", poBox: "12345", emirate: "DU", country: "AE" },
};
const buyer: Party = {
  nameEn: "Acme FZE",
  address: { street: "Corniche Road", city: "Abu Dhabi", emirate: "AZ", country: "AE" },
};

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
      seller,
      buyer,
      currency: "AED",
    });
    const r = validateInvoice(inv);
    expect(r.canSend).toBe(true);
    expect(r.errors).toBe(0);
  });
});

/**
 * The addresses, which had no rule at all.
 *
 * BR-08 and BR-10 make each party's postal address mandatory and BR-09 and
 * BR-11 make the country code inside it mandatory, so a document without them
 * fails four business rules before any schematron runs; Article 59(1)(b)-(c) of
 * the Executive Regulation wants the same two addresses on the face of it. The
 * serializer meanwhile writes `AE` for a party that carries none — the
 * jurisdiction of issue is the only guess available, and it is still a guess
 * presented to a tax authority as a fact. These rules are what stop it being
 * reached.
 */
describe("the addresses a tax invoice has to carry", () => {
  it("blocks a document whose buyer has no address", () => {
    const inv = invoice({ number: "INV2026-00010", seller, buyer: { nameEn: "Acme FZE" } });
    const r = validateInvoice(inv);
    expect(codes(inv)).toContain("AE-0204");
    expect(issue(inv, "AE-0204")?.severity).toBe("ERROR");
    expect(r.canSend).toBe(false);
  });

  it("blocks a document whose supplier has no address, and sends the user to the record it comes from", () => {
    const inv = invoice({ number: "INV2026-00011", seller: { nameEn: "Seller LLC", trn: "100123456700003" }, buyer });
    expect(codes(inv)).toContain("AE-0210");
    expect(issue(inv, "AE-0210")?.severity).toBe("ERROR");
    expect(issue(inv, "AE-0210")?.fix).toContain("Business details");
  });

  it("counts an address with no country as no address, because that is what the serializer guesses at", () => {
    const inv = invoice({
      number: "INV2026-00012",
      seller: { ...seller, address: { street: "Sheikh Zayed Road", country: "" } },
      buyer: { ...buyer, address: { street: "Corniche Road", country: "  " } },
    });
    expect(codes(inv)).toContain("AE-0204");
    expect(codes(inv)).toContain("AE-0210");
  });

  it("says nothing when both parties carry one", () => {
    const inv = invoice({ number: "INV2026-00013", seller, buyer });
    expect(codes(inv)).not.toContain("AE-0204");
    expect(codes(inv)).not.toContain("AE-0210");
  });
});

/**
 * The AED conversion (AE-0500).
 *
 * Article 69 of Federal Decree-Law 8/2017 converts the tax on a
 * foreign-currency document to AED and Article 59(1)(k) of the Executive
 * Regulation puts the converted figure and the rate on the document. This was a
 * warning, so an invoice went to the buyer and to the FTA stating neither.
 */
describe("the AED conversion rate", () => {
  const peg: FxInfo = { rateToAED: "3.6725", source: "CBUAE", rateDate: "2026-07-01" };
  const foreign = (partial: Parameters<typeof invoice>[0] = {}) =>
    invoice({ number: "INV2026-00020", currency: "USD", seller, buyer, ...partial });

  it("blocks a foreign-currency invoice that charges tax and carries no rate", () => {
    const inv = foreign();
    expect(inv.totals.vatMinor).toBeGreaterThan(0);
    expect(issue(inv, "AE-0500")?.severity).toBe("ERROR");
    expect(validateInvoice(inv).canSend).toBe(false);
  });

  it("treats a half-typed rate as no rate, because nothing can convert at one", () => {
    const inv = foreign({ fx: { rateToAED: "3.", source: "MANUAL", rateDate: "2026-07-01" } });
    expect(issue(inv, "AE-0500")?.severity).toBe("ERROR");
  });

  it("only cautions where the document charges no tax to convert", () => {
    // A zero-rated export genuinely has nothing to state in AED, and refusing
    // to send it would be inventing a requirement the Article does not impose.
    const inv = foreign({
      lines: [line({ taxProfileCode: "ZERO_EXPORT", exemptionReason: "Export outside the GCC" })],
    });
    expect(inv.totals.vatMinor).toBe(0);
    expect(issue(inv, "AE-0500")?.severity).toBe("WARNING");
    expect(validateInvoice(inv).canSend).toBe(true);
  });

  it("says nothing once a usable rate is on the document", () => {
    expect(codes(foreign({ fx: peg }))).not.toContain("AE-0500");
    expect(validateInvoice(foreign({ fx: peg })).canSend).toBe(true);
  });

  it("says nothing on a document already in AED", () => {
    expect(codes(invoice({ number: "INV2026-00021", seller, buyer }))).not.toContain("AE-0500");
  });
});
