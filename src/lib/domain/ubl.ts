import { minorToMajor } from "./money";
import { getProfile, DOC_TYPE_LABEL } from "./tax";
import type { Invoice } from "./types";

/**
 * Simplified PINT AE (UBL 2.1) serializer — element order is hand-kept.
 * A real, deterministic artifact generated from the invoice's own data.
 * (The production build validates against official schematron; this is the
 * faithful shape for preview/export.)
 */
function esc(s: string | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function amt(minor: number, currency: string): string {
  return `${minorToMajor(minor).toFixed(2)}`;
}

export function generateUBL(inv: Invoice): string {
  const isCredit = inv.docType === "TAX_CREDIT_NOTE";
  const root = isCredit ? "CreditNote" : "Invoice";
  const cur = inv.currency;

  const lines = inv.lines
    .map((l, i) => {
      const p = getProfile(l.taxProfileCode);
      return `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${esc(l.unitCode)}">${l.qty}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${cur}">${amt(l.lineNetMinor, cur)}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>${esc(l.description)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>${p.categoryCode}</cbc:ID>
        <cbc:Percent>${p.ratePercent.toFixed(2)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${cur}">${amt(l.unitPriceMinor, cur)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
    })
    .join("\n");

  const subtotals = inv.totals.perCategory
    .map(
      (c) => `    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${cur}">${amt(c.taxableMinor, cur)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${cur}">${amt(c.vatMinor, cur)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>${c.categoryCode}</cbc:ID>
        <cbc:Percent>${c.ratePercent.toFixed(2)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:peppol:pint:billing-1@ae-1</cbc:CustomizationID>
  <cbc:ProfileID>urn:peppol:bis:billing</cbc:ProfileID>
  <cbc:ID>${esc(inv.number)}</cbc:ID>
  <cbc:IssueDate>${inv.issueDate}</cbc:IssueDate>
  <cbc:DueDate>${inv.dueDate ?? inv.issueDate}</cbc:DueDate>
  <cbc:InvoiceTypeCode>${isCredit ? "381" : "388"}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${cur}</cbc:DocumentCurrencyCode>
  ${cur !== "AED" ? "<cbc:TaxCurrencyCode>AED</cbc:TaxCurrencyCode>" : ""}
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="0235">${esc(inv.seller.peppolId?.split(":")[1])}</cbc:EndpointID>
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(inv.seller.nameEn)}</cbc:RegistrationName></cac:PartyLegalEntity>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(inv.seller.trn ?? inv.seller.tin)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      ${inv.buyer.peppolId ? `<cbc:EndpointID schemeID="0235">${esc(inv.buyer.peppolId.split(":")[1])}</cbc:EndpointID>` : ""}
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(inv.buyer.nameEn)}</cbc:RegistrationName></cac:PartyLegalEntity>
      ${inv.buyer.trn ? `<cac:PartyTaxScheme><cbc:CompanyID>${esc(inv.buyer.trn)}</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>` : ""}
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${cur}">${amt(inv.totals.vatMinor, cur)}</cbc:TaxAmount>
${subtotals}
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${cur}">${amt(inv.totals.taxExclusiveMinor, cur)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${cur}">${amt(inv.totals.taxExclusiveMinor, cur)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${cur}">${amt(inv.totals.taxInclusiveMinor, cur)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${cur}">${amt(inv.totals.payableMinor, cur)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${lines}
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
