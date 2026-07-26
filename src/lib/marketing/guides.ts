/**
 * Long-form guide content — the organic-acquisition + LLM-citation engine.
 * English-first, factual and structured (each guide is a real Article). Phrased
 * in relative "phase" terms rather than hard dates so it stays accurate as the
 * FTA finalises the rollout. Cross-linked hub-and-spoke with /uae-e-invoicing.
 */

export interface GuideSection {
  h: string;
  body: string[];
  bullets?: string[];
}

export interface Guide {
  slug: string;
  title: string;
  h1: string;
  description: string;
  published: string;
  modified: string;
  sections: GuideSection[];
  faq?: { q: string; a: string }[];
  related: string[];
}

const PUB = "2026-01-15";
const MOD = "2026-07-01";

export const GUIDES: Guide[] = [
  {
    slug: "pint-ae-format",
    title: "PINT AE format explained — the UAE e-invoice structure",
    h1: "The PINT AE format, explained",
    description:
      "PINT AE is the UAE's Peppol invoice specification — a structured UBL format the FTA requires. What it contains, why validation matters, and how to get it right.",
    published: PUB,
    modified: MOD,
    sections: [
      {
        h: "What PINT AE is",
        body: [
          "PINT AE (Peppol International — Arab Emirates) is the UAE's national specialisation of the Peppol International invoice model. It defines exactly which fields a compliant UAE tax invoice must carry and the rules those fields must satisfy, expressed as a structured UBL 2.1 XML document.",
          "Because it is a specialisation of an international standard, an invoice that is valid PINT AE can be exchanged over the Peppol network and understood by any other participant — while still carrying the UAE-specific tax details the Federal Tax Authority requires.",
        ],
      },
      {
        h: "What a PINT AE invoice contains",
        body: ["At minimum, a PINT AE invoice carries the parties, the tax basis, and the commercial detail in structured form:"],
        bullets: [
          "Supplier and buyer identity, including Tax Registration Numbers (TRN) and Peppol participant identifiers.",
          "Invoice number, issue date, currency and document type (tax invoice, credit note, etc.).",
          "Line items with quantities, unit prices, and a tax category per line.",
          "VAT breakdown per tax category, with totals reconciled to the line detail.",
          "References such as the related invoice for a credit note.",
        ],
      },
      {
        h: "Why validation happens before sending",
        body: [
          "A structured format only helps if the document actually conforms to it. The single most important step in e-invoicing is validating against the PINT AE rules before the invoice is transmitted — a malformed invoice that reaches the network or the FTA is a rejected invoice, and a compliance problem.",
          "ARKS validates every invoice against the PINT AE rules at creation time and surfaces field-level errors with plain-language fixes, so problems are caught at the source rather than after submission.",
        ],
      },
    ],
    faq: [
      { q: "Is PINT AE the same as a normal UBL invoice?", a: "PINT AE is a UBL-based format, but it is a specific UAE customization of the Peppol International model with its own required fields and rules. A generic UBL invoice is not automatically valid PINT AE." },
      { q: "Do I need to build PINT AE XML myself?", a: "No. ARKS generates the PINT AE UBL for you from your invoice data and validates it before sending." },
    ],
    related: ["peppol-5-corner-model", "tax-data-document", "readiness-checklist"],
  },
  {
    slug: "peppol-5-corner-model",
    title: "The Peppol 5-corner model in the UAE, explained",
    h1: "The Peppol 5-corner model",
    description:
      "How UAE e-invoices actually travel: the Peppol network, access points, and the fifth corner — reporting to the Federal Tax Authority.",
    published: PUB,
    modified: MOD,
    sections: [
      {
        h: "Why a network, not a portal",
        body: [
          "Peppol is an international framework for exchanging electronic business documents. Instead of every company agreeing on a file format or logging into a government portal, each party connects once to an accredited access point, and the network handles interoperability between them.",
        ],
      },
      {
        h: "The five corners",
        body: ["The UAE model has five corners:"],
        bullets: [
          "Corner 1 — the supplier, who issues the invoice.",
          "Corner 2 — the supplier's access point, which validates and sends it (this is where ARKS sits).",
          "Corner 3 — the buyer's access point, which receives and delivers it.",
          "Corner 4 — the buyer, who receives the structured invoice.",
          "Corner 5 — the Federal Tax Authority, which receives the reported tax data.",
        ],
      },
      {
        h: "What the model means for you",
        body: [
          "Because you connect through an access point, you never have to negotiate formats with your customers or operate portal logins per counterparty. You issue an invoice; your access point validates it, transmits it to the buyer's access point, and reports the tax data to the FTA — all from one action.",
        ],
      },
    ],
    faq: [
      { q: "What is an access point?", a: "An access point is an accredited service provider that connects you to the Peppol network — validating, sending and receiving documents on your behalf. ARKS acts as your access point and reporting bridge to the FTA." },
      { q: "Does the buyer need to be on Peppol?", a: "The buyer receives structured documents through their own access point. ARKS can check whether a customer is reachable on the Peppol network before you invoice them." },
    ],
    related: ["pint-ae-format", "tax-data-document", "ministerial-decision-64"],
  },
  {
    slug: "tax-data-document",
    title: "The Tax Data Document (TDD) and FTA reporting, explained",
    h1: "The Tax Data Document (TDD)",
    description:
      "What the Tax Data Document is, how it is reported to the UAE FTA, and how an evidence bundle proves both delivery and reporting for every invoice.",
    published: PUB,
    modified: MOD,
    sections: [
      {
        h: "What the TDD is",
        body: [
          "The Tax Data Document is the structured record reported to the Federal Tax Authority for each transaction. Where the invoice is the document exchanged with your customer, the TDD is the tax-reporting counterpart sent to the FTA — the fifth-corner report in the Peppol model.",
        ],
      },
      {
        h: "How reporting works",
        body: [
          "When an invoice is sent, the access point generates the TDD and reports it to the FTA. ARKS produces the TDD with a cryptographic (SHA-256) integrity hash of the exact UBL invoice, and records the FTA's acceptance.",
          "Delivery to the customer and reporting to the FTA are tracked as two separate legs, so you can always see exactly where an invoice stands.",
        ],
      },
      {
        h: "Proving it: the evidence bundle",
        body: [
          "For every invoice, ARKS assembles a downloadable evidence bundle: the UBL document, the Tax Data Document, a full event timeline, and a SHA-256 manifest. This is the audit-ready proof that an invoice was validated, delivered and reported — retained for the periods UAE record-keeping requires.",
        ],
      },
    ],
    faq: [
      { q: "Is the TDD the same as the invoice?", a: "No. The invoice is exchanged with your customer; the Tax Data Document is the structured report sent to the FTA. Both are generated by ARKS from the same source invoice." },
      { q: "How do I prove an invoice was reported?", a: "Each invoice has an evidence bundle containing the UBL, the TDD, a timeline and an integrity manifest — audit-ready proof of delivery and reporting." },
    ],
    related: ["peppol-5-corner-model", "pint-ae-format", "readiness-checklist"],
  },
  {
    slug: "readiness-checklist",
    title: "UAE e-invoicing readiness checklist",
    h1: "Your UAE e-invoicing readiness checklist",
    description:
      "A practical checklist to be ready for mandatory UAE e-invoicing before your phase begins — from TRN data to validation and reporting.",
    published: PUB,
    modified: MOD,
    sections: [
      {
        h: "Before your phase begins",
        body: ["Being ready early means no failed submissions and no compliance risk when your phase goes live. Work through this checklist:"],
        bullets: [
          "Confirm your VAT registration and TRN details are accurate for every entity you invoice under.",
          "Clean your customer master data — names, TRNs and addresses — so Peppol participant identifiers derive correctly.",
          "Decide how invoices will originate: manual entry, spreadsheet import, an accounting/e-commerce connector, or the API.",
          "Ensure your invoices validate against PINT AE — the format, the tax categories and the totals.",
          "Have a plan to transmit over Peppol and report the Tax Data Document to the FTA.",
          "Keep an audit trail: an evidence bundle per invoice, retained for the required period.",
        ],
      },
      {
        h: "How ARKS covers the list",
        body: [
          "ARKS validates every invoice to PINT AE, derives Peppol identifiers from TRNs, imports from Excel and common accounting/e-commerce systems, transmits over Peppol, reports the TDD to the FTA, and stores an evidence bundle for each invoice. A 14-day free trial lets you send a real compliant invoice before you commit.",
        ],
      },
    ],
    faq: [
      { q: "How early should I get ready?", a: "The direction is fixed and the phases are approaching. Getting ready ahead of your applicable date avoids a last-minute scramble and the risk of failed submissions." },
      { q: "What if my accounting system isn't listed?", a: "You can import from Excel or Tally exports, or use the REST API and MCP server to connect any system." },
    ],
    related: ["ministerial-decision-64", "pint-ae-format", "tax-data-document"],
  },
  {
    slug: "ministerial-decision-64",
    title: "Ministerial Decision 64: UAE e-invoicing rollout & phases",
    h1: "Ministerial Decision 64 and the UAE rollout",
    description:
      "What Ministerial Decision No. 64 of 2025 introduces, who it applies to, and how the phased rollout of mandatory UAE e-invoicing works.",
    published: PUB,
    modified: MOD,
    sections: [
      {
        h: "What the decision introduces",
        body: [
          "Ministerial Decision No. 64 of 2025 underpins the UAE's move to mandatory electronic invoicing. It establishes that VAT-registered businesses will exchange invoices as structured digital documents through accredited service providers over the Peppol network, and that the underlying tax data is reported to the Federal Tax Authority.",
        ],
      },
      {
        h: "A phased rollout",
        body: [
          "The mandate is being introduced in phases, beginning with larger taxpayers and expanding to all VAT-registered businesses. Each phase has its own go-live date set by the FTA, alongside the accreditation of service providers.",
          "The practical implication is simple: the requirement is coming, the phases are approaching, and being ready ahead of your date removes both the operational scramble and the compliance risk.",
        ],
      },
      {
        h: "What it replaces",
        body: [
          "The informal PDF-by-email invoice gives way to a structured document that can be validated, transmitted and reported automatically — reducing VAT fraud and administrative cost, and bringing the UAE in line with international continuous-transaction-control regimes.",
        ],
      },
    ],
    faq: [
      { q: "Who does Ministerial Decision 64 apply to?", a: "It applies to VAT-registered businesses in the UAE, introduced in phases beginning with larger taxpayers and expanding to all. Exact dates per phase are set by the FTA." },
      { q: "Do I still send a PDF?", a: "The legal invoice becomes the structured document exchanged over Peppol. A readable copy can still be shared, but compliance is satisfied by the structured document and its reporting." },
    ],
    related: ["peppol-5-corner-model", "readiness-checklist", "tax-data-document"],
  },
  {
    slug: "glossary",
    title: "UAE e-invoicing glossary — key terms defined",
    h1: "UAE e-invoicing glossary",
    description:
      "Plain-language definitions of the key UAE e-invoicing terms: PINT AE, Peppol, access point, TDD, TRN, the 5-corner model and more.",
    published: PUB,
    modified: MOD,
    sections: [
      { h: "PINT AE", body: ["The UAE's Peppol invoice specification — a structured UBL format defining the fields and rules a compliant UAE tax invoice must satisfy."] },
      { h: "Peppol", body: ["An international framework for exchanging electronic business documents through accredited access points, used by the UAE for e-invoicing."] },
      { h: "Access point", body: ["An accredited service provider that connects a business to the Peppol network — validating, sending and receiving documents. ARKS is your access point."] },
      { h: "5-corner model", body: ["The UAE exchange model: supplier, supplier's access point, buyer's access point, buyer, and the FTA as the reporting corner."] },
      { h: "Tax Data Document (TDD)", body: ["The structured record reported to the Federal Tax Authority for each transaction, generated alongside the invoice."] },
      { h: "TRN", body: ["Tax Registration Number — the VAT identifier used to identify parties and derive Peppol participant addresses."] },
      { h: "UBL", body: ["Universal Business Language — the XML document standard that PINT AE is built on."] },
      { h: "Evidence bundle", body: ["A downloadable audit pack per invoice: the UBL, the TDD, a timeline and an integrity manifest, proving delivery and reporting."] },
    ],
    related: ["pint-ae-format", "peppol-5-corner-model", "tax-data-document"],
  },
];

export const GUIDE_BY_SLUG: Record<string, Guide> = Object.fromEntries(GUIDES.map((g) => [g.slug, g]));
