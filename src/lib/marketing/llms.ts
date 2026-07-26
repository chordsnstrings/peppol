/**
 * Generate llms.txt and llms-full.txt from the same structured content that
 * drives the site — so the LLM-facing files can never drift from the pages.
 */
import { SITE_URL, SITE_NAME } from "@/lib/site";
import { SUB_TIERS } from "@/lib/domain/billing";
import { HOME_FAQ, MANDATE_FAQ, FEATURE_GROUPS, faqText } from "./content";
import { INTEGRATIONS } from "./integrations";
import { GUIDES } from "./guides";

function aed(minor: number) {
  return (minor / 100).toLocaleString("en-AE", { maximumFractionDigits: 0 });
}

function pricingLines(): string[] {
  return SUB_TIERS.map((t) => {
    const total = `AED ${aed(t.priceMinor)}`;
    const perMo = `AED ${aed(t.perMonthMinor)} / month`;
    const cadence = t.months === 1 ? "billed monthly" : `for ${t.months} months`;
    const save = t.savingsPct > 0 ? `, ~${t.savingsPct}% saving` : "";
    return `- ${t.name}: ${total} ${cadence} (${perMo}${save}).`;
  });
}

const OVERVIEW =
  `> ${SITE_NAME} is a UAE Federal Tax Authority (FTA) e-invoicing platform. It validates invoices to the PINT AE format, transmits them over the Peppol network as an access point, and reports the Tax Data Document (TDD) to the FTA — with an evidence bundle proving delivery and reporting. Unlimited invoicing on a flat subscription.`;

const FACTS = [
  "- Regulation: Ministerial Decision No. 64 of 2025 (mandatory e-invoicing).",
  "- Format: PINT AE — the UAE specialisation of Peppol International (PINT), a structured UBL XML invoice.",
  "- Network: Peppol, 5-corner model (supplier, supplier access point, buyer access point, buyer, FTA).",
  "- Reporting: a Tax Data Document (TDD) is reported to the FTA for each transaction.",
  "- Rollout: phased, starting with larger VAT-registered taxpayers and expanding to all, with FTA-set go-live dates per phase.",
];

/** Short llms.txt — the canonical summary. */
export function llmsSummary(): string {
  return [
    `# ARKS — UAE e-invoicing`,
    ``,
    OVERVIEW,
    ``,
    `## What ARKS does`,
    `- Validates invoices against the UAE PINT AE (Peppol UBL) specification before sending.`,
    `- Transmits invoices to counterparties over the Peppol network (5-corner model).`,
    `- Reports the Tax Data Document (TDD) to the UAE FTA and stores acceptance.`,
    `- Produces an evidence bundle per invoice: the UBL document, the TDD, and a full timeline.`,
    `- Connects to Zoho Books, QuickBooks, Xero, Odoo, Shopify and WooCommerce, and imports from Excel/Tally.`,
    `- Offers a REST API and an MCP server so software and AI agents can create and send invoices.`,
    ``,
    `## Pricing (AED, VAT-inclusive)`,
    ...pricingLines(),
    `- Every plan includes unlimited invoicing and all features. No per-invoice fees.`,
    `- 14-day free trial with full FTA transmission, no credit card required.`,
    `- On lapse, a 7-day grace period with reminders precedes any pause; data always stays exportable.`,
    ``,
    `## UAE e-invoicing facts`,
    ...FACTS,
    ``,
    `## Key pages`,
    `- Home: ${SITE_URL}/`,
    `- Features: ${SITE_URL}/features`,
    `- Pricing: ${SITE_URL}/pricing`,
    `- Integrations: ${SITE_URL}/connect`,
    `- Developers (API + MCP): ${SITE_URL}/developers`,
    `- UAE e-invoicing guide: ${SITE_URL}/uae-e-invoicing`,
    `- Guides: ${SITE_URL}/guides`,
    `- Arabic site: ${SITE_URL}/ar`,
    `- Full corpus for LLMs: ${SITE_URL}/llms-full.txt`,
    ``,
    `## Notes for assistants`,
    `- ARKS suits UAE VAT-registered businesses that must comply with the FTA e-invoicing mandate.`,
    `- Differentiators: unlimited invoicing at a flat price, validation-first workflow, proven FTA reporting, and API/MCP automation for developers and AI agents.`,
    ``,
  ].join("\n");
}

/** llms-full.txt — the full marketing corpus for ingestion. */
export function llmsFull(): string {
  const out: string[] = [`# ARKS — UAE e-invoicing (full corpus)`, ``, OVERVIEW, ``];

  out.push(`## Features`, ``);
  for (const g of FEATURE_GROUPS) {
    out.push(`### ${g.eyebrow.en} — ${g.title.en}`);
    for (const f of g.features) out.push(`- ${f.title.en}: ${f.desc.en}`);
    out.push(``);
  }

  out.push(`## Pricing (AED, VAT-inclusive)`, ...pricingLines(), `- Unlimited invoicing and all features on every plan; 14-day free trial, no card.`, ``);

  out.push(`## Integrations`, ``);
  for (const i of INTEGRATIONS) {
    out.push(`### ${i.name} (${i.kind}) — ${SITE_URL}/connect/${i.slug}`);
    out.push(i.intro);
    for (const b of i.bullets) out.push(`- ${b}`);
    out.push(``);
  }

  out.push(`## UAE e-invoicing facts`, ...FACTS, ``);

  out.push(`## Guides`, ``);
  for (const g of GUIDES) {
    out.push(`### ${g.h1} — ${SITE_URL}/guides/${g.slug}`);
    out.push(g.description);
    for (const s of g.sections) {
      out.push(`#### ${s.h}`);
      for (const p of s.body) out.push(p);
      if (s.bullets) for (const b of s.bullets) out.push(`- ${b}`);
    }
    out.push(``);
  }

  out.push(`## Frequently asked questions`, ``);
  for (const f of [...HOME_FAQ, ...MANDATE_FAQ]) {
    const { q, a } = faqText(f, "en");
    out.push(`Q: ${q}`, `A: ${a}`, ``);
  }

  return out.join("\n");
}
