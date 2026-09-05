import { convertMinorAtRate, minorToMajor } from "@/lib/domain/money";
import { aedTaxTotals, DOC_TYPE_LABEL } from "@/lib/domain/tax";
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
  // The same derivation the exchanged UBL and the printed invoice use, so the
  // reporting leg cannot state a different tax in AED from the document it
  // reports on. It is defined only where the document is in another currency
  // AND carries a rate this product can convert at.
  const aed = aedTaxTotals(invoice);
  const alreadyAED = invoice.currency === "AED";

  /**
   * One amount of the document, stated in AED.
   *
   * The conversion goes through `convertMinorAtRate` — whole minor units at the
   * exact decimal rate — because that is what the UBL uses, and the
   * `Math.round(minor * Number(rate))` this used to be diverges from it by a
   * fils at ordinary rates: 1.80 of tax at 1.025 is 1.845, which is 1.85 here
   * and was 1.84 there, and so are 88.25 at 2.260 and 539.05 at 8.700. Two
   * statements of the same supply to the same authority, a fils apart.
   *
   * Undefined where the figure cannot be stated at all. That is a document in
   * another currency carrying no usable rate, and it used to convert at an
   * implied 1 — which filed the foreign-currency figure with the FTA under an
   * AED label, so a hundred dollars of tax was reported as a hundred dirhams.
   * Nought is the one amount that survives a missing rate, because nought
   * converts to nought at every rate; that is what lets a zero-rated export
   * still report its nil tax while its taxable amount goes unstated.
   */
  const inAED = (minor: number): string | undefined => {
    if (alreadyAED) return amt(minor);
    if (aed) {
      const converted = convertMinorAtRate(minor, aed.rateToAED);
      return converted === undefined ? undefined : amt(converted);
    }
    return minor === 0 ? amt(0) : undefined;
  };

  /** The element, or nothing at all where the figure cannot be stated. */
  const element = (tag: string, minor: number, indent: string): string => {
    const value = inAED(minor);
    return value === undefined ? "" : `${indent}<${tag}>${value}</${tag}>`;
  };

  const breakdown = invoice.totals.perCategory
    .map((c) =>
      [
        `    <TaxSubtotal>`,
        `      <Category>${esc(c.categoryCode)}</Category>`,
        `      <RatePercent>${c.ratePercent.toFixed(2)}</RatePercent>`,
        element("TaxableAmountAED", c.taxableMinor, "      "),
        element("TaxAmountAED", c.vatMinor, "      "),
        `    </TaxSubtotal>`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");

  const summary = [
    breakdown,
    element("TotalTaxableAED", invoice.totals.taxExclusiveMinor, "    "),
    element("TotalTaxAED", invoice.totals.vatMinor, "    "),
    element("TotalPayableAED", invoice.totals.taxInclusiveMinor, "    "),
  ]
    .filter(Boolean)
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
    ${aed ? `<AEDConversionRate>${esc(aed.rateToAED)}</AEDConversionRate>` : ""}
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
${summary}
  </TaxSummary>
</TaxDataDocument>`;
}
