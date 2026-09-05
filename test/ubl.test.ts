import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoicePreview } from "@/components/invoice/invoice-preview";
import { generateUBL } from "@/lib/domain/ubl";
import { buildTDD } from "@/lib/gateway/tdd";
import { aedTaxTotals, computeTotals, REVERSE_CHARGE_STATEMENT } from "@/lib/domain/tax";
import { convertMinorAtRate } from "@/lib/domain/money";
import type { FxInfo, Invoice, Party } from "@/lib/domain/types";
import { invoice, line } from "./helpers";

/**
 * Both copies of the document: the one the customer reads and the one the
 * network exchanges.
 *
 * `generateUBL` and `buildTDD` had no test of any kind, which is how a
 * serializer that omitted both postal addresses (BR-08 through BR-11 on every
 * document it ever produced), declared a tax currency without the tax amount in
 * it (BR-53), dropped the exemption reasons the editor collects, and built a
 * credit note by swapping the root element while leaving `cbc:InvoiceTypeCode`
 * and `cac:InvoiceLine` inside it — invalid against the CreditNote XSD before
 * any schematron rule is reached — stayed that way.
 *
 * The rendered invoice is here too, and deliberately in the same file. The two
 * copies are one document, and the failure worth catching is not that either is
 * wrong on its own but that they disagree: the tax stated in AED has to be the
 * same number in both, or the FTA holds two accounts of the same supply.
 *
 * No XML parser is installed and the test environment is node, so the
 * assertions below read the serialized string, and the component is rendered to
 * static markup rather than into a DOM. Both are the artifacts that leave the
 * product, and reading them is what catches an element in the wrong place.
 */
const AED_PEG: FxInfo = { rateToAED: "3.6725", source: "CBUAE", rateDate: "2026-07-01" };

const seller: Party = {
  nameEn: "Seller LLC",
  trn: "100123456700003",
  peppolId: "0235:1001234567",
  address: { street: "Sheikh Zayed Road", poBox: "12345", emirate: "DU", country: "AE" },
};

const buyer: Party = {
  nameEn: "Buyer FZE",
  trn: "100999888800003",
  peppolId: "0235:1009998888",
  address: { street: "Corniche Road", city: "Abu Dhabi", emirate: "AZ", country: "AE" },
};

/** The tag names in document order, so an element's position can be asserted. */
function order(xml: string, ...tags: string[]): boolean {
  const at = tags.map((t) => xml.indexOf(`<${t}`));
  return at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1]));
}

/**
 * Every start tag matched by its end tag, in the right nesting.
 *
 * The document is built by string concatenation, and a conditional fragment
 * that forgets its closing tag produces XML nothing will parse. This is the
 * cheapest guard that says so.
 */
function nestingErrors(xml: string): string[] {
  const errors: string[] = [];
  const stack: string[] = [];
  for (const m of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, name, attrs, selfClose] = m;
    if (attrs.startsWith("?xml")) continue;
    if (selfClose) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) errors.push(`</${name}> closes <${open ?? "nothing"}>`);
    } else {
      stack.push(name);
    }
  }
  if (stack.length) errors.push(`unclosed: ${stack.join(", ")}`);
  return errors;
}

/** The slice of the document between two markers, for a party-scoped assertion. */
function between(xml: string, open: string, close: string): string {
  const from = xml.indexOf(open);
  const to = xml.indexOf(close, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return xml.slice(from, to);
}

function standardInvoice(partial: Partial<Invoice> = {}): Invoice {
  const built = invoice({
    seller,
    buyer,
    lines: [line({ qty: 2, unitPriceMinor: 50_000 })],
    ...partial,
  });
  // The shared builder only fills the fields it knows about, and the reference
  // to a corrected document is not one of them.
  return { ...built, precedingInvoices: partial.precedingInvoices };
}

describe("generateUBL — parties", () => {
  it("gives both parties a postal address with a country code (BR-08 to BR-11)", () => {
    const xml = generateUBL(standardInvoice());

    const supplier = between(xml, "<cac:AccountingSupplierParty>", "</cac:AccountingSupplierParty>");
    expect(supplier).toContain("<cac:PostalAddress>");
    expect(supplier).toContain("<cbc:StreetName>Sheikh Zayed Road</cbc:StreetName>");
    expect(supplier).toContain("<cbc:Line>P.O. Box 12345</cbc:Line>");
    expect(supplier).toContain("<cbc:IdentificationCode>AE</cbc:IdentificationCode>");

    const customer = between(xml, "<cac:AccountingCustomerParty>", "</cac:AccountingCustomerParty>");
    expect(customer).toContain("<cac:PostalAddress>");
    expect(customer).toContain("<cbc:StreetName>Corniche Road</cbc:StreetName>");
    expect(customer).toContain("<cbc:CityName>Abu Dhabi</cbc:CityName>");
    expect(customer).toContain("<cbc:IdentificationCode>AE</cbc:IdentificationCode>");
  });

  it("writes the emirate out as a subdivision name, not this product's storage code", () => {
    const xml = generateUBL(standardInvoice());
    expect(xml).toContain("<cbc:CountrySubentity>Dubai</cbc:CountrySubentity>");
    expect(xml).toContain("<cbc:CountrySubentity>Abu Dhabi</cbc:CountrySubentity>");
    expect(xml).not.toContain("<cbc:CountrySubentity>DU</cbc:CountrySubentity>");
  });

  it("still emits the address group when a party has no address at all", () => {
    const xml = generateUBL(standardInvoice({ buyer: { nameEn: "Walk-in customer" } }));
    const customer = between(xml, "<cac:AccountingCustomerParty>", "</cac:AccountingCustomerParty>");
    expect(customer).toContain("<cac:PostalAddress>");
    expect(customer).toContain("<cbc:IdentificationCode>AE</cbc:IdentificationCode>");
  });

  it("escapes markup in a party name", () => {
    const xml = generateUBL(standardInvoice({ buyer: { nameEn: 'Smith & Sons <"Trading">' } }));
    expect(xml).toContain("Smith &amp; Sons &lt;&quot;Trading&quot;&gt;");
    expect(nestingErrors(xml)).toEqual([]);
  });
});

describe("generateUBL — tax", () => {
  it("carries a line's exemption reason on the line and on the breakdown", () => {
    const xml = generateUBL(
      standardInvoice({
        lines: [
          line({
            taxProfileCode: "ZERO_EXPORT",
            exemptionReason: "Export of goods outside the GCC",
          }),
        ],
      }),
    );
    // Once inside cac:ClassifiedTaxCategory on the line, once on the subtotal
    // the line fed — BR-Z-10 reads the breakdown, not the lines.
    expect([...xml.matchAll(/<cbc:TaxExemptionReason>/g)]).toHaveLength(2);
    expect(xml).toContain(
      "<cbc:TaxExemptionReason>Export of goods outside the GCC</cbc:TaxExemptionReason>",
    );
  });

  it("states the same reason once when several lines share it", () => {
    const xml = generateUBL(
      standardInvoice({
        lines: [
          line({ taxProfileCode: "ZERO_EXPORT", exemptionReason: "Export outside the GCC" }),
          line({ lineNo: 2, taxProfileCode: "ZERO_EXPORT", exemptionReason: "Export outside the GCC" }),
        ],
      }),
    );
    const subtotal = between(xml, "<cac:TaxSubtotal>", "</cac:TaxSubtotal>");
    expect([...subtotal.matchAll(/Export outside the GCC/g)]).toHaveLength(1);
  });

  it("puts the Article 59(1)(l) reverse-charge statement on the AE breakdown (BR-AE-10)", () => {
    const xml = generateUBL(
      standardInvoice({ lines: [line({ taxProfileCode: "REVERSE_CHARGE" })] }),
    );
    expect(xml).toContain(`<cbc:TaxExemptionReason>${REVERSE_CHARGE_STATEMENT}</cbc:TaxExemptionReason>`);
    // The same sentence the rendered invoice prints: one statement, two copies.
    expect(REVERSE_CHARGE_STATEMENT).toContain("Article 48");
  });
});

describe("generateUBL — the tax currency", () => {
  it("declares AED and states the tax in it (BR-53)", () => {
    const inv = standardInvoice({ currency: "USD", fx: AED_PEG });
    const xml = generateUBL(inv);

    expect(xml).toContain("<cbc:TaxCurrencyCode>AED</cbc:TaxCurrencyCode>");
    // 1,000.00 USD at 5% is 50.00 USD of tax; 5000 fils × 3.6725 is 18,362.5,
    // which rounds away from zero to 183.63 AED.
    expect(xml).toContain('<cbc:TaxAmount currencyID="AED">183.63</cbc:TaxAmount>');
    expect([...xml.matchAll(/<cac:TaxTotal>/g)]).toHaveLength(2);
    expect(aedTaxTotals(inv)?.vatMinorAED).toBe(18_363);
  });

  it("prints the same AED figure the document build recorded", () => {
    const lines = [line({ qty: 2, unitPriceMinor: 50_000 })];
    const totals = computeTotals(lines, { currency: "USD", fx: AED_PEG });
    const inv = standardInvoice({ currency: "USD", fx: AED_PEG, lines, totals });
    expect(totals.vatMinorAED).toBe(18_363);
    expect(generateUBL(inv)).toContain(
      `<cbc:TaxAmount currencyID="AED">${(totals.vatMinorAED! / 100).toFixed(2)}</cbc:TaxAmount>`,
    );
  });

  it("declares no tax currency on an AED document", () => {
    const xml = generateUBL(standardInvoice());
    expect(xml).not.toContain("TaxCurrencyCode");
    expect([...xml.matchAll(/<cac:TaxTotal>/g)]).toHaveLength(1);
  });

  it("declares no tax currency when the rate is not usable yet", () => {
    // A half-typed rate in the editor. Declaring AED and stating no amount in
    // it is the BR-53 failure; stating an amount at a rate nobody supplied
    // would be worse.
    const xml = generateUBL(
      standardInvoice({
        currency: "USD",
        fx: { rateToAED: "3.", source: "MANUAL", rateDate: "2026-07-01" },
      }),
    );
    expect(xml).not.toContain("TaxCurrencyCode");
    expect([...xml.matchAll(/<cac:TaxTotal>/g)]).toHaveLength(1);
  });
});

describe("generateUBL — credit notes", () => {
  const creditNote = () =>
    standardInvoice({
      docType: "TAX_CREDIT_NOTE",
      precedingInvoices: [{ number: "INV2026-00001", issueDate: "2026-06-01" }],
    });

  it("uses CreditNote element names throughout, not Invoice ones", () => {
    const xml = generateUBL(creditNote());
    expect(xml).toContain("<CreditNote xmlns=");
    expect(xml).toContain("<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>");
    expect(xml).toContain("<cac:CreditNoteLine>");
    expect(xml).toContain("<cbc:CreditedQuantity");
    // The old shape: a CreditNote-2 root holding Invoice children, which the
    // XSD rejects outright.
    expect(xml).not.toContain("cbc:InvoiceTypeCode");
    expect(xml).not.toContain("cac:InvoiceLine");
    expect(xml).not.toContain("cbc:InvoicedQuantity");
    expect(nestingErrors(xml)).toEqual([]);
  });

  it("references the invoice it credits (BT-25/BT-26)", () => {
    const xml = generateUBL(creditNote());
    const ref = between(xml, "<cac:BillingReference>", "</cac:BillingReference>");
    expect(ref).toContain("<cbc:ID>INV2026-00001</cbc:ID>");
    expect(ref).toContain("<cbc:IssueDate>2026-06-01</cbc:IssueDate>");
  });

  it("omits the reference when nothing is being credited", () => {
    expect(generateUBL(standardInvoice())).not.toContain("BillingReference");
  });
});

describe("generateUBL — document order", () => {
  it("keeps the UBL sequence, including where the reference and the tax totals sit", () => {
    const xml = generateUBL(
      standardInvoice({
        currency: "USD",
        fx: AED_PEG,
        notes: "Payment within 30 days.",
        precedingInvoices: [{ number: "INV2026-00001" }],
      }),
    );
    expect(
      order(
        xml,
        "cbc:CustomizationID",
        "cbc:ProfileID",
        "cbc:ID",
        "cbc:IssueDate",
        "cbc:DueDate",
        "cbc:InvoiceTypeCode",
        "cbc:Note",
        "cbc:DocumentCurrencyCode",
        "cbc:TaxCurrencyCode",
        "cac:BillingReference",
        "cac:AccountingSupplierParty",
        "cac:AccountingCustomerParty",
        "cac:TaxTotal",
        "cac:LegalMonetaryTotal",
        "cac:InvoiceLine",
      ),
    ).toBe(true);
    expect(nestingErrors(xml)).toEqual([]);
  });
});

describe("buildTDD", () => {
  const inv = standardInvoice({ currency: "USD", fx: AED_PEG });

  it("hashes the exact UBL it was handed", () => {
    const ubl = generateUBL(inv);
    const tdd = buildTDD(inv, ubl);
    expect(tdd).toMatch(/<SourceDocumentHash algorithm="SHA-256">[0-9a-f]{64}<\/SourceDocumentHash>/);
    // A different document must not report the same hash — that is the whole
    // point of carrying one into the reporting leg.
    expect(tdd).not.toBe(buildTDD(inv, ubl + " "));
  });

  it("reports the tax in AED at the rate the exchanged document states", () => {
    const tdd = buildTDD(inv, generateUBL(inv));
    expect(tdd).toContain("<AEDConversionRate>3.6725</AEDConversionRate>");
    expect(tdd).toContain("<TotalTaxAED>183.63</TotalTaxAED>");
    // The reporting leg and the exchanged document are two statements of the
    // same tax to the same authority; if they ever disagree, one of them is
    // wrong in the FTA's records.
    expect(tdd).toContain(
      `<TotalTaxAED>${(convertMinorAtRate(inv.totals.vatMinor, AED_PEG.rateToAED)! / 100).toFixed(2)}</TotalTaxAED>`,
    );
  });

  it("reports the same AED tax as the UBL at a rate a float rounds the other way", () => {
    // The dollar peg hides this: 3.6725 against these amounts lands clear of a
    // half fils, so a conversion made through a float agrees with an exact one
    // and the divergence only shows up in production. 1.80 of tax at 1.025 is
    // 1.845 — 1.85 rounded half away from zero, and 184.49999999999997 in
    // binary, which `Math.round(minor * Number(rate))` reported as 1.84.
    //
    // The two legs are two statements of one supply to one authority. A fils
    // between them is a discrepancy in the FTA's own records, on every document
    // whose product happens to land on a half.
    const fx: FxInfo = { rateToAED: "1.025", source: "CBUAE", rateDate: "2026-07-01" };
    const inv = standardInvoice({ currency: "EUR", fx, lines: [line({ qty: 1, unitPriceMinor: 3_600 })] });
    expect(inv.totals.vatMinor).toBe(180);
    expect(Math.round(inv.totals.vatMinor * Number(fx.rateToAED))).toBe(184);

    const ubl = generateUBL(inv);
    const tdd = buildTDD(inv, ubl);
    expect(ubl).toContain('<cbc:TaxAmount currencyID="AED">1.85</cbc:TaxAmount>');
    expect(tdd).toContain("<TotalTaxAED>1.85</TotalTaxAED>");
    expect(tdd).toContain("<TaxAmountAED>1.85</TaxAmountAED>");
    // And the payable, the other figure that lands on a half here: 37.80 at
    // 1.025 is 38.745, so 38.75 exactly and 38.74 through the float.
    expect(tdd).toContain("<TotalPayableAED>38.75</TotalPayableAED>");
    expect(tdd).not.toContain("38.74");
    expect(tdd).not.toContain("1.84<");
  });

  it("states no AED figure for a document with no rate to convert at", () => {
    // It converted at an implied 1, which filed the euro figure with the FTA
    // under an AED label. A zero-rated export is the document that reaches this
    // case: AE-0500 stops one that charges tax from being sent with no rate at
    // all, and a document that charges none still has a taxable amount nobody
    // can state in dirhams.
    const inv = standardInvoice({
      currency: "EUR",
      lines: [
        line({ qty: 1, unitPriceMinor: 3_600, taxProfileCode: "ZERO_EXPORT", exemptionReason: "Export outside the GCC" }),
      ],
    });
    const tdd = buildTDD(inv, generateUBL(inv));
    expect(tdd).not.toContain("AEDConversionRate");
    expect(tdd).not.toContain("TotalTaxableAED");
    expect(tdd).not.toContain("36.00");
    // Nought is the one amount that survives a missing rate, because nought
    // converts to nought at every rate.
    expect(tdd).toContain("<TotalTaxAED>0.00</TotalTaxAED>");
    expect(nestingErrors(tdd)).toEqual([]);
  });

  it("states an AED document's own figures, converting nothing", () => {
    const tdd = buildTDD(standardInvoice(), generateUBL(standardInvoice()));
    expect(tdd).toContain("<TotalTaxAED>50.00</TotalTaxAED>");
    expect(tdd).toContain("<TotalPayableAED>1050.00</TotalPayableAED>");
    expect(tdd).not.toContain("AEDConversionRate");
  });
});

/**
 * The rendered document, held to the particulars Article 59 of the Executive
 * Regulation lists. Rendered to static markup and read as text — every
 * assertion below is something the reader of the invoice can see on it.
 */
function render(inv: Invoice): string {
  // The project compiles JSX with `"jsx": "preserve"` and hands it to Next, so
  // the classic transform is what runs under vitest and a component that does
  // not import React itself resolves the identifier globally. Providing it here
  // is what lets these assertions read the real component's markup instead of a
  // copy of it kept in the test.
  (globalThis as { React?: typeof React }).React ??= React;
  return renderToStaticMarkup(React.createElement(InvoicePreview, { invoice: inv }));
}

describe("the rendered tax invoice — Article 59 particulars", () => {
  it("prints the address of both parties (Article 59(1)(b) and (c))", () => {
    const html = render(standardInvoice());
    // The supplier's address was collected at onboarding and printed nowhere.
    expect(html).toContain("Sheikh Zayed Road");
    expect(html).toContain("P.O. Box 12345");
    expect(html).toContain("Dubai");
    expect(html).toContain("United Arab Emirates");
    // The buyer's was printed as an emirate code and nothing else.
    expect(html).toContain("Corniche Road");
    expect(html).toContain("Abu Dhabi");
  });

  it("prints the tax in AED, and the rate it was converted at (Article 59(1)(k))", () => {
    const inv = standardInvoice({ currency: "USD", fx: AED_PEG });
    const html = render(inv);
    expect(html).toContain("VAT in AED");
    expect(html).toContain("183.63");
    expect(html).toContain("3.6725");
    // What was there printed the rate with no figure after it — the
    // multiplication instead of the answer.
    expect(html).toContain("the CBUAE rate");
  });

  it("prints the same AED tax as the exchanged copy", () => {
    const inv = standardInvoice({ currency: "USD", fx: AED_PEG });
    const aed = aedTaxTotals(inv)!;
    const printed = (aed.vatMinorAED / 100).toFixed(2);
    expect(render(inv)).toContain(printed);
    expect(generateUBL(inv)).toContain(`<cbc:TaxAmount currencyID="AED">${printed}</cbc:TaxAmount>`);
  });

  it("does not call a hand-typed rate a central bank rate", () => {
    const html = render(
      standardInvoice({
        currency: "USD",
        fx: { rateToAED: "3.70", source: "MANUAL", rateDate: "2026-07-01" },
      }),
    );
    expect(html).toContain("a manually entered rate");
    expect(html).not.toContain("CBUAE");
  });

  it("prints the reverse-charge statement instead of a bare zero rate (Article 59(1)(l))", () => {
    const html = render(standardInvoice({ lines: [line({ taxProfileCode: "REVERSE_CHARGE" })] }));
    expect(html).toContain("required to account for the VAT");
    expect(html).toContain("Article 48");
    // And the breakdown row names the treatment rather than only its rate.
    expect(html).toContain("Reverse charge");
  });

  it("names the treatment on a zero-rated row", () => {
    const html = render(
      standardInvoice({
        lines: [line({ taxProfileCode: "ZERO_EXPORT", exemptionReason: "Export outside the GCC" })],
      }),
    );
    expect(html).toContain("Zero-rated");
    expect(html).toContain("Export outside the GCC");
  });

  it("says nothing about AED on a document that is already in AED", () => {
    const html = render(standardInvoice());
    expect(html).not.toContain("VAT in AED");
    expect(html).not.toContain("has to be stated in AED");
  });

  it("says so when a foreign-currency document charges tax it cannot state in AED", () => {
    // Silence here is a missing Article 59(1)(k) particular that only the
    // person looking at this preview can supply.
    const html = render(standardInvoice({ currency: "USD" }));
    expect(html).toContain("has to be stated in AED");
  });

  it("keeps quiet where there is no tax to convert", () => {
    const html = render(
      standardInvoice({
        currency: "USD",
        lines: [line({ taxProfileCode: "ZERO_EXPORT", exemptionReason: "Export outside the GCC" })],
      }),
    );
    expect(html).not.toContain("has to be stated in AED");
  });
});
