/**
 * Canonical marketing facts about the UAE e-invoicing regime. Kept factual and
 * structured so the same source feeds the FAQ UI, JSON-LD (FAQPage), and the
 * llms.txt / content hub — the "be the source assistants quote" play. Dates are
 * described in relative regime terms (phases), not hard-coded deadlines, to stay
 * accurate as the FTA finalises the rollout.
 */

export interface Faq {
  q: string;
  a: string;
}

/** Homepage / pricing FAQ — the conversion + reassurance set. */
export const HOME_FAQ: Faq[] = [
  {
    q: "What is UAE e-invoicing and who does it apply to?",
    a: "The UAE Federal Tax Authority (FTA) is introducing mandatory electronic invoicing under Ministerial Decision No. 64 of 2025. Businesses will exchange structured invoices through accredited service providers over the Peppol network, and report them to the FTA. It applies to VAT-registered businesses in phases, beginning with larger taxpayers. ARKS handles validation, transmission and reporting so you are ready regardless of your phase.",
  },
  {
    q: "How much does ARKS cost?",
    a: "ARKS is a flat subscription: AED 299 per month, AED 1,500 for six months (AED 250/month), or AED 2,400 per year (AED 200/month). Every plan includes unlimited invoicing and every feature — there are no per-invoice fees. Prices are VAT-inclusive and you receive a tax invoice for your subscription.",
  },
  {
    q: "Is there a free trial? Do I need a credit card?",
    a: "Yes — every new workspace starts with a 14-day free trial with full transmission to the FTA, no card required. You only subscribe when you are ready. If a subscription lapses, there is a 7-day grace period with reminders before transmission is paused, and your data always remains exportable.",
  },
  {
    q: "What is PINT AE and does ARKS support it?",
    a: "PINT AE is the UAE-specific Peppol International (PINT) invoice specification — the structured UBL format the FTA requires. ARKS validates every invoice against the PINT AE rules before sending, so malformed invoices are caught before they reach the network.",
  },
  {
    q: "How does the invoice actually reach the FTA?",
    a: "ARKS validates your invoice to PINT AE, transmits it to your customer over the Peppol network through an access point, and reports the tax data to the FTA. You get an evidence bundle — the UBL document, the Tax Data Document, and a full timeline — proving delivery and reporting for every invoice.",
  },
  {
    q: "Can I connect my accounting or e-commerce system?",
    a: "Yes. ARKS imports from Excel and integrates with common accounting and e-commerce systems, and offers a REST API plus an MCP server so AI agents and custom software can create and send invoices directly. You are not locked into manual entry.",
  },
  {
    q: "What happens to my invoices if I stop paying?",
    a: "Transmission to the FTA pauses after the grace period, but your account, history and evidence bundles stay accessible and exportable. Resubscribing restores transmission immediately. We never hold your compliance data hostage.",
  },
  {
    q: "Is my data secure and private?",
    a: "Each business's data is isolated at the database level, secrets are encrypted, and every send is server-authoritative. The marketing site runs with no advertising trackers. Access is protected with strong authentication and full audit logging.",
  },
];

/** The mandate primer (content hub / LLM-SEO). */
export const MANDATE_FAQ: Faq[] = [
  {
    q: "When does UAE e-invoicing become mandatory?",
    a: "The FTA is rolling out mandatory e-invoicing in phases under Ministerial Decision No. 64 of 2025, starting with larger taxpayers and expanding to all VAT-registered businesses. Exact go-live dates are set by the FTA per phase; ARKS keeps you ready ahead of your applicable date.",
  },
  {
    q: "What is the Peppol network and the 5-corner model?",
    a: "Peppol is an international framework for exchanging electronic documents. The UAE uses a 5-corner model: the supplier and buyer each connect through an accredited service provider (access point), and tax data is reported to the FTA as the fifth corner. ARKS is your access point and reporting bridge.",
  },
  {
    q: "What is a Tax Data Document (TDD)?",
    a: "The Tax Data Document is the structured record reported to the FTA for each transaction. ARKS generates and reports it automatically and stores acceptance in your evidence bundle.",
  },
  {
    q: "Do I still issue a PDF invoice?",
    a: "The legal invoice becomes the structured PINT AE document exchanged over Peppol. A human-readable version can still be shared for convenience, but compliance is satisfied by the structured document and its reporting — both of which ARKS handles.",
  },
];

/** Short trust/authority facts used across the site. */
export const REGIME_FACTS = [
  { k: "Regulation", v: "Ministerial Decision No. 64 of 2025" },
  { k: "Format", v: "PINT AE (Peppol UBL)" },
  { k: "Network", v: "Peppol · 5-corner model" },
  { k: "Reporting", v: "FTA Tax Data Document" },
];
