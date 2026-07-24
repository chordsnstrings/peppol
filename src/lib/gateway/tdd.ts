import { minorToMajor } from "@/lib/domain/money";
import { DOC_TYPE_LABEL } from "@/lib/domain/tax";
import type { Invoice } from "@/lib/domain/types";
import { createHash } from "node:crypto";

/**
 * UAE Tax Data Document (TDD) builder (spec §7.3 / §2). This is the reporting-leg
 * payload our ASP (C2) sends to the FTA (C5) for each document. It carries the
 * tax-relevant subset of the invoice plus an integrity hash of the exact PINT AE
 * UBL that was exchanged. Under Route A the partner gateway may generate the TDD
 * itself; we still build it for the archive/evidence bundle and Route B.
 */
function esc(s?: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function amt(minor: number): string {
  return minorToMajor(minor).toFixed(2);
}

export function buildTDD(invoice: Invoice, ublXml: string): string {
  const docHash = createHash("sha256").update(ublXml, "utf8").digest("hex");
  const rateToAED = invoice.fx ? Number(invoice.fx.rateToAED) : 1;
  const aed = (minor: number) => amt(Math.round(minor * rateToAED));

  const breakdown = invoice.totals.perCategory
    .map(
      (c) => `    <TaxSubtotal>
      <Category>${esc(c.categoryCode)}</Category>
      <RatePercent>${c.ratePercent.toFixed(2)}</RatePercent>
      <TaxableAmountAED>${aed(c.taxableMinor)}</TaxableAmountAED>
      <TaxAmountAED>${aed(c.vatMinor)}</TaxAmountAED>
    </TaxSubtotal>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<TaxDataDocument xmlns="urn:peppol:tdd:ae:1.0" version="1.0.0">
  <Header>
    <DocumentType>${esc(DOC_TYPE_LABEL[invoice.docType])}</DocumentType>
    <ReportingParty role="C2"/>
    <GeneratedAt>${invoice.reportedAt ?? invoice.updatedAt}</GeneratedAt>
    <SourceDocumentHash algorithm="SHA-256">${docHash}</SourceDocumentHash>
  </Header>
  <Invoice>
    <ID>${esc(invoice.number)}</ID>
    <IssueDate>${invoice.issueDate}</IssueDate>
    <SupplyDate>${invoice.supplyDate}</SupplyDate>
    <DocumentCurrency>${esc(invoice.currency)}</DocumentCurrency>
    ${invoice.fx ? `<AEDConversionRate>${esc(invoice.fx.rateToAED)}</AEDConversionRate>` : ""}
  </Invoice>
  <Seller>
    <Name>${esc(invoice.seller.nameEn)}</Name>
    <TRN>${esc(invoice.seller.trn ?? invoice.seller.tin)}</TRN>
    <PeppolID>${esc(invoice.seller.peppolId)}</PeppolID>
  </Seller>
  <Buyer>
    <Name>${esc(invoice.buyer.nameEn)}</Name>
    <TRN>${esc(invoice.buyer.trn ?? invoice.buyer.tin)}</TRN>
    <PeppolID>${esc(invoice.buyer.peppolId)}</PeppolID>
  </Buyer>
  <TaxSummary>
${breakdown}
    <TotalTaxableAED>${aed(invoice.totals.taxExclusiveMinor)}</TotalTaxableAED>
    <TotalTaxAED>${aed(invoice.totals.vatMinor)}</TotalTaxAED>
    <TotalPayableAED>${aed(invoice.totals.taxInclusiveMinor)}</TotalPayableAED>
  </TaxSummary>
</TaxDataDocument>`;
}
