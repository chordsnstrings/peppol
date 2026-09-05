import { minorToMajor } from "./money";
import { EMIRATES } from "./peppol";
import {
  aedTaxTotals,
  categorySubtotalKey,
  getProfile,
  REVERSE_CHARGE_STATEMENT,
} from "./tax";
import type { CategoryBreakdown, Invoice, Party } from "./types";

/**
 * Simplified PINT AE (UBL 2.1) serializer — element order is hand-kept.
 * A real, deterministic artifact generated from the invoice's own data.
 * (The production build validates against official schematron; this is the
 * faithful shape for preview/export.)
 *
 * Hand-kept order means the order matters: UBL's XSD declares a sequence, so an
 * element in the wrong place is rejected before any schematron rule is reached.
 * The two roots differ — a credit note names its type code `cbc:CreditNoteTypeCode`
 * and its lines `cac:CreditNoteLine`, and the quantity on those lines is
 * `cbc:CreditedQuantity` — which is why nothing here is built by swapping the
 * root element on an invoice and hoping.
 */
function esc(s: string | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function amt(minor: number): string {
  return minorToMajor(minor).toFixed(2);
}

/**
 * The postal address of a party.
 *
 * BR-08 and BR-10 make the address group mandatory for both parties and BR-09
 * and BR-11 make the country code inside it mandatory, so every document this
 * serializer produced without one failed all four — on every invoice, not on an
 * unusual one. Article 59(1)(b)-(c) of the Executive Regulation wants the same
 * two addresses on the face of the document, so this is one omission with two
 * consequences.
 *
 * The PO box goes in `cac:AddressLine` rather than `cbc:PostalZone`: the UAE
 * issues no postcodes, and a box number is not one. The emirate is written out
 * in full because BT-39 is a subdivision NAME — "DU" is this product's own
 * storage code and means nothing to a receiving system. The country falls back to
 * AE only when the party carries no address at all — every address this product
 * records is written with a country (the entity, customer and onboarding forms
 * all set it), and the alternative to a fallback is a document that fails
 * BR-09/BR-11 outright rather than one that names the jurisdiction it was
 * issued in.
 */
function postalAddress(party: Party): string {
  const a = party.address;
  const lines = [
    a?.street ? `        <cbc:StreetName>${esc(a.street)}</cbc:StreetName>` : "",
    a?.additional
      ? `        <cbc:AdditionalStreetName>${esc(a.additional)}</cbc:AdditionalStreetName>`
      : "",
    a?.city ? `        <cbc:CityName>${esc(a.city)}</cbc:CityName>` : "",
    a?.emirate
      ? `        <cbc:CountrySubentity>${esc(EMIRATES.find((e) => e.code === a.emirate)?.name ?? a.emirate)}</cbc:CountrySubentity>`
      : "",
    a?.poBox
      ? `        <cac:AddressLine><cbc:Line>P.O. Box ${esc(a.poBox)}</cbc:Line></cac:AddressLine>`
      : "",
    `        <cac:Country><cbc:IdentificationCode>${esc(a?.country || "AE")}</cbc:IdentificationCode></cac:Country>`,
  ].filter(Boolean);
  return [`      <cac:PostalAddress>`, ...lines, `      </cac:PostalAddress>`].join("\n");
}

/**
 * The reason a category subtotal carries no tax, or none the supplier charged.
 *
 * BR-E-10, BR-Z-10 and BR-AE-10 each require the breakdown group to explain
 * itself, and the reasons are collected on the LINES — which is where the
 * editor asks for them and where `validateInvoice` reads them. Grouping the
 * lines by `categorySubtotalKey` is what puts each reason on the subtotal its
 * line actually fed; grouping them a second way here would eventually group
 * them differently from `computeTotals`.
 *
 * A reverse-charge subtotal takes the statement Article 59(1)(l) requires
 * instead of a typed reason, because that statement is not optional and is not
 * something the user should have to remember to type. A margin-scheme subtotal
 * takes whatever reason its line carried and nothing more: which PINT AE
 * category a margin supply belongs under is not established anywhere in this
 * codebase, and a statement hung on a category that may be the wrong one would
 * be worse than the reason the user actually typed.
 */
function exemptionReasonFor(category: CategoryBreakdown, byCategory: Map<string, string[]>): string {
  if (category.profileCode === "REVERSE_CHARGE") return REVERSE_CHARGE_STATEMENT;
  return (byCategory.get(categorySubtotalKey(category.profileCode)) ?? []).join("; ");
}

export function generateUBL(inv: Invoice): string {
  const isCredit = inv.docType === "TAX_CREDIT_NOTE";
  const root = isCredit ? "CreditNote" : "Invoice";
  const typeCodeTag = isCredit ? "cbc:CreditNoteTypeCode" : "cbc:InvoiceTypeCode";
  const lineTag = isCredit ? "cac:CreditNoteLine" : "cac:InvoiceLine";
  const quantityTag = isCredit ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity";
  const cur = inv.currency;
  // One derivation, shared with the rendered invoice. BR-53 requires the tax
  // total in the tax currency whenever a tax currency is declared, so the code
  // and the second `cac:TaxTotal` below stand or fall together — declaring the
  // currency and then omitting the amount, which is what this did, is the
  // failure BR-53 exists to catch.
  const aed = aedTaxTotals(inv);

  const reasonsByCategory = new Map<string, string[]>();
  for (const l of inv.lines) {
    const reason = l.exemptionReason?.trim();
    if (!reason) continue;
    const key = categorySubtotalKey(l.taxProfileCode);
    const held = reasonsByCategory.get(key) ?? [];
    // Distinct: five zero-rated export lines carrying the same reason are one
    // reason on the breakdown, not the same sentence five times.
    if (!held.includes(reason)) held.push(reason);
    reasonsByCategory.set(key, held);
  }

  const lines = inv.lines
    .map((l, i) => {
      const p = getProfile(l.taxProfileCode);
      const reason = l.exemptionReason?.trim();
      return `  <${lineTag}>
    <cbc:ID>${i + 1}</cbc:ID>
    <${quantityTag} unitCode="${esc(l.unitCode)}">${l.qty}</${quantityTag}>
    <cbc:LineExtensionAmount currencyID="${cur}">${amt(l.lineNetMinor)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${esc(l.description)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${p.categoryCode}</cbc:ID>
        <cbc:Percent>${p.ratePercent.toFixed(2)}</cbc:Percent>
${reason ? `        <cbc:TaxExemptionReason>${esc(reason)}</cbc:TaxExemptionReason>\n` : ""}        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${cur}">${amt(l.unitPriceMinor)}</cbc:PriceAmount>
    </cac:Price>
  </${lineTag}>`;
    })
    .join("\n");

  const subtotals = inv.totals.perCategory
    .map((c) => {
      const reason = exemptionReasonFor(c, reasonsByCategory);
      return `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${cur}">${amt(c.taxableMinor)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${cur}">${amt(c.vatMinor)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${c.categoryCode}</cbc:ID>
        <cbc:Percent>${c.ratePercent.toFixed(2)}</cbc:Percent>
${reason ? `        <cbc:TaxExemptionReason>${esc(reason)}</cbc:TaxExemptionReason>\n` : ""}        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`;
    })
    .join("\n");

  // BT-25/BT-26. `precedingInvoices` exists so a credit note can say what it
  // credits, and until now it was collected and dropped: a credit note that
  // names no preceding invoice is a document the buyer cannot match to
  // anything, and the correction path in §8.2.2 fills this in on every one it
  // builds. Emitted on an invoice too where one is held, since a corrective
  // invoice references its predecessor the same way.
  const billingReferences = (inv.precedingInvoices ?? [])
    .map(
      (ref) => `  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>${esc(ref.number)}</cbc:ID>
${ref.issueDate ? `      <cbc:IssueDate>${esc(ref.issueDate)}</cbc:IssueDate>\n` : ""}    </cac:InvoiceDocumentReference>
  </cac:BillingReference>`,
    )
    .join("\n");

  const body = [
    `  <cbc:CustomizationID>urn:peppol:pint:billing-1@ae-1</cbc:CustomizationID>`,
    `  <cbc:ProfileID>urn:peppol:bis:billing</cbc:ProfileID>`,
    `  <cbc:ID>${esc(inv.number)}</cbc:ID>`,
    `  <cbc:IssueDate>${inv.issueDate}</cbc:IssueDate>`,
    `  <cbc:DueDate>${inv.dueDate ?? inv.issueDate}</cbc:DueDate>`,
    `  <${typeCodeTag}>${isCredit ? "381" : "388"}</${typeCodeTag}>`,
    inv.notes ? `  <cbc:Note>${esc(inv.notes)}</cbc:Note>` : "",
    `  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>`,
    aed ? `  <cbc:TaxCurrencyCode>AED</cbc:TaxCurrencyCode>` : "",
    billingReferences,
    `  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="0235">${esc(inv.seller.peppolId?.split(":")[1])}</cbc:EndpointID>
${postalAddress(inv.seller)}
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(inv.seller.nameEn)}</cbc:RegistrationName></cac:PartyLegalEntity>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(inv.seller.trn ?? inv.seller.tin)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>`,
    `  <cac:AccountingCustomerParty>
    <cac:Party>
${inv.buyer.peppolId ? `      <cbc:EndpointID schemeID="0235">${esc(inv.buyer.peppolId.split(":")[1])}</cbc:EndpointID>\n` : ""}${postalAddress(inv.buyer)}
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(inv.buyer.nameEn)}</cbc:RegistrationName></cac:PartyLegalEntity>
${inv.buyer.trn ? `      <cac:PartyTaxScheme><cbc:CompanyID>${esc(inv.buyer.trn)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>\n` : ""}    </cac:Party>
  </cac:AccountingCustomerParty>`,
    `  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${cur}">${amt(inv.totals.vatMinor)}</cbc:TaxAmount>
${subtotals}
  </cac:TaxTotal>`,
    // BT-111, and the whole reason the tax currency may be declared at all: the
    // tax stated in AED, at the rate the document itself prints. No breakdown —
    // the second total carries the amount only.
    aed
      ? `  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="AED">${amt(aed.vatMinorAED)}</cbc:TaxAmount>
  </cac:TaxTotal>`
      : "",
    `  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${cur}">${amt(inv.totals.taxExclusiveMinor)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${cur}">${amt(inv.totals.taxExclusiveMinor)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${cur}">${amt(inv.totals.taxInclusiveMinor)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${cur}">${amt(inv.totals.payableMinor)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>`,
    lines,
  ].filter(Boolean);

  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
${body.join("\n")}
</${root}>`;
}

export function downloadText(filename: string, text: string, type = "text/plain") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
