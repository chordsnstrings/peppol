/**
 * Integration landing-page content. English-first (long-tail commercial intent).
 * Each entry is genuinely specific to that connector's real adapter behaviour —
 * NOT a spun template — to stay clear of thin-content/doorway-page penalties.
 * Source adapters: src/lib/integrations/{zoho,qbo,xero,odoo,shopify,woocommerce}.ts
 */

export interface Integration {
  slug: string;
  name: string;
  kind: "Accounting" | "E-commerce";
  mono: string; // monogram (no third-party logos / trademarks)
  tagline: string;
  intro: string;
  bullets: string[];
  steps: { name: string; text: string }[];
  faq: { q: string; a: string }[];
  keyword: string;
}

export const INTEGRATIONS: Integration[] = [
  {
    slug: "zoho-books",
    name: "Zoho Books",
    kind: "Accounting",
    mono: "Z",
    tagline: "Turn Zoho Books invoices into FTA-reported e-invoices.",
    intro:
      "Connect Zoho Books to ARKS and your invoices flow straight into the UAE e-invoicing pipeline — validated to PINT AE, transmitted over Peppol and reported to the FTA — without leaving your accounting workflow. The connection is a real OAuth 2 link that respects your Zoho data-centre region and organization.",
    bullets: [
      "Secure OAuth 2 connection, scoped to the Zoho organization you choose (handles the .com / .eu / .sa data-centre domains).",
      "Invoices sync into ARKS with your customer's TRN mapped for Peppol addressing.",
      "Each imported invoice is validated against the PINT AE rules before it is sent.",
      "Sync is idempotent — the same Zoho invoice is never double-imported.",
    ],
    steps: [
      { name: "Connect Zoho Books", text: "In ARKS → Integrations, choose Zoho Books and authorise with OAuth. Pick the organization to sync." },
      { name: "Sync invoices", text: "ARKS pulls invoices, maps customer TRNs, and validates each one against PINT AE." },
      { name: "Transmit to the FTA", text: "Send — ARKS transmits over Peppol and reports the Tax Data Document, with an evidence bundle per invoice." },
    ],
    faq: [
      { q: "Does it work with my Zoho data-centre region?", a: "Yes. The connection detects your Zoho domain (for example .com, .eu or .sa) so it works regardless of the region your Zoho Books account is hosted in." },
      { q: "Do I need to re-enter customer TRNs?", a: "No. Customer tax registration numbers come across with the invoice and are used to derive the Peppol participant address automatically." },
    ],
    keyword: "Zoho Books UAE e-invoicing",
  },
  {
    slug: "quickbooks",
    name: "QuickBooks Online",
    kind: "Accounting",
    mono: "Q",
    tagline: "Report QuickBooks Online invoices to the FTA over Peppol.",
    intro:
      "Link QuickBooks Online to ARKS and keep invoicing where your books already live. ARKS connects to your QuickBooks company (realm) over OAuth 2, imports invoices, validates them to PINT AE and transmits them to the FTA over Peppol — with a full evidence bundle for every document.",
    bullets: [
      "OAuth 2 connection scoped to your QuickBooks company (realmId).",
      "Invoices import with line items, tax and customer identity intact.",
      "Every invoice is validated to PINT AE before transmission — errors are surfaced with fixes.",
      "Idempotent sync so a QuickBooks invoice maps to exactly one ARKS document.",
    ],
    steps: [
      { name: "Connect QuickBooks", text: "Authorise ARKS against your QuickBooks Online company with OAuth 2." },
      { name: "Import & validate", text: "ARKS imports invoices and checks each against the UAE PINT AE rules." },
      { name: "Send to the FTA", text: "Transmit over Peppol and report the Tax Data Document — proven with an evidence bundle." },
    ],
    faq: [
      { q: "Which QuickBooks does this support?", a: "QuickBooks Online. ARKS connects to your company via the standard OAuth 2 flow using your realm identifier." },
      { q: "Are credit notes handled?", a: "Yes — ARKS supports credit and debit notes with the correct document types and reason codes for UAE compliance." },
    ],
    keyword: "QuickBooks UAE e-invoicing",
  },
  {
    slug: "xero",
    name: "Xero",
    kind: "Accounting",
    mono: "X",
    tagline: "Send Xero invoices to the FTA, PINT AE-validated.",
    intro:
      "Connect Xero to ARKS to bring your sales invoices into the UAE e-invoicing flow. ARKS uses Xero's multi-tenant OAuth 2 connection, so you choose exactly which Xero organisation to sync, then validates and transmits each invoice to the FTA over Peppol.",
    bullets: [
      "Multi-tenant OAuth 2 — select the specific Xero organisation to connect.",
      "Sales invoices import with contacts, tax rates and line detail.",
      "PINT AE validation runs before every send.",
      "Idempotent sync keyed to the Xero invoice so nothing is duplicated.",
    ],
    steps: [
      { name: "Connect Xero", text: "Authorise ARKS and pick the Xero organisation you want to sync." },
      { name: "Validate to PINT AE", text: "Imported invoices are checked against the UAE rules, with plain-language fixes for any issues." },
      { name: "Transmit & report", text: "Send over Peppol; ARKS reports the Tax Data Document to the FTA and stores the evidence." },
    ],
    faq: [
      { q: "Can I connect more than one Xero organisation?", a: "Yes. Xero's connection is multi-tenant, so you can authorise the specific organisation you want to sync into ARKS." },
      { q: "Does it handle UAE VAT treatments?", a: "ARKS maps to the UAE VAT categories (standard, zero-rated, exempt, reverse-charge and more) and rounds VAT per category to EN 16931 conventions." },
    ],
    keyword: "Xero UAE e-invoicing",
  },
  {
    slug: "odoo",
    name: "Odoo",
    kind: "Accounting",
    mono: "O",
    tagline: "Bridge Odoo to UAE e-invoicing and the FTA.",
    intro:
      "Connect your Odoo instance to ARKS to route customer invoices through UAE e-invoicing. ARKS talks to Odoo over its JSON-RPC interface with an API key, imports invoices, validates them to PINT AE, and transmits them to the FTA over Peppol.",
    bullets: [
      "JSON-RPC connection authenticated with an Odoo API key — works with self-hosted and Odoo Online.",
      "Customer invoices import with taxes and partner identity.",
      "PINT AE validation before send; errors are returned with fixes.",
      "Idempotent import so each Odoo invoice becomes one ARKS document.",
    ],
    steps: [
      { name: "Connect Odoo", text: "Provide your Odoo URL, database and API key in ARKS → Integrations." },
      { name: "Sync & validate", text: "ARKS pulls invoices over JSON-RPC and validates each to PINT AE." },
      { name: "Report to the FTA", text: "Transmit over Peppol and report the Tax Data Document, with a downloadable evidence bundle." },
    ],
    faq: [
      { q: "Does this work with self-hosted Odoo?", a: "Yes. ARKS connects over Odoo's JSON-RPC API with an API key, so both self-hosted and Odoo Online instances are supported." },
      { q: "Which Odoo versions?", a: "Any version exposing the standard JSON-RPC endpoint and invoice models. The connection uses your database name and API key." },
    ],
    keyword: "Odoo UAE e-invoicing",
  },
  {
    slug: "shopify",
    name: "Shopify",
    kind: "E-commerce",
    mono: "S",
    tagline: "Convert Shopify orders into compliant UAE e-invoices.",
    intro:
      "Connect your Shopify store to ARKS and turn orders into FTA-reported tax invoices. ARKS reads orders through the Shopify Admin API, builds a PINT AE invoice for each, and transmits it to the FTA over Peppol — so your e-commerce sales are compliant without manual re-keying.",
    bullets: [
      "Connects to your store through the Shopify Admin API (with a validated, SSRF-safe store handle).",
      "Orders become PINT AE invoices with line items, tax and customer detail.",
      "Every invoice is validated before it is sent to the network.",
      "Idempotent — an order maps to a single ARKS invoice.",
    ],
    steps: [
      { name: "Connect Shopify", text: "Authorise ARKS against your Shopify store's Admin API." },
      { name: "Orders → invoices", text: "ARKS turns each order into a PINT AE invoice and validates it." },
      { name: "Send to the FTA", text: "Transmit over Peppol and report the Tax Data Document, evidence bundle included." },
    ],
    faq: [
      { q: "Do I invoice every order automatically?", a: "You control which orders become invoices. ARKS imports orders and builds compliant invoices you can review and send, or automate." },
      { q: "Is my store connection secure?", a: "Yes. The store handle is validated to prevent request forgery, and access tokens are encrypted at rest." },
    ],
    keyword: "Shopify UAE e-invoicing",
  },
  {
    slug: "woocommerce",
    name: "WooCommerce",
    kind: "E-commerce",
    mono: "W",
    tagline: "Report WooCommerce sales to the FTA over Peppol.",
    intro:
      "Connect your WooCommerce store to ARKS to bring online sales into UAE e-invoicing. ARKS reads orders through the WooCommerce REST API, builds a PINT AE invoice for each, validates it, and transmits it to the FTA over Peppol with a full evidence trail.",
    bullets: [
      "Connects through the WooCommerce REST API with your store keys.",
      "Orders convert into PINT AE invoices with tax and customer identity.",
      "PINT AE validation runs before every transmission.",
      "Idempotent sync so an order never produces two invoices.",
    ],
    steps: [
      { name: "Connect WooCommerce", text: "Add your store URL and REST API keys in ARKS → Integrations." },
      { name: "Import & validate", text: "ARKS pulls orders, builds invoices and validates them to PINT AE." },
      { name: "Transmit & prove", text: "Send over Peppol, report the Tax Data Document, and download the evidence bundle." },
    ],
    faq: [
      { q: "What do I need to connect WooCommerce?", a: "Your store URL and a WooCommerce REST API key/secret with read access to orders. ARKS stores credentials encrypted." },
      { q: "Does it handle refunds or credit notes?", a: "ARKS supports credit notes so a refund can be reflected as a compliant credit document with the right reason code." },
    ],
    keyword: "WooCommerce UAE e-invoicing",
  },
];

export const INTEGRATION_BY_SLUG: Record<string, Integration> = Object.fromEntries(
  INTEGRATIONS.map((i) => [i.slug, i]),
);
