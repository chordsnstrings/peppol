import { SITE_URL, SITE_NAME } from "@/lib/site";
import { SUB_TIERS } from "@/lib/domain/billing";

/**
 * Structured data (schema.org) — the machine-readable substrate for Google rich
 * results and the LLM-citation play. Rendered as a single <script type="ld+json">
 * (allowed by CSP — it is not executable script). Kept factual and canonical so
 * an assistant answering "how do I comply with UAE e-invoicing" can quote it.
 */

function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      // Structured data is inert JSON, not executed. Stringify guards injection.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}

const ORG = {
  "@type": "Organization",
  "@id": `${SITE_URL}/#org`,
  name: "ARKS",
  legalName: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/icons/icon.svg`,
  description:
    "ARKS is a UAE e-invoicing platform (accredited-ASP model) that validates and transmits PINT AE invoices to the Federal Tax Authority over the Peppol network.",
  areaServed: { "@type": "Country", name: "United Arab Emirates" },
  knowsAbout: ["UAE e-invoicing", "Peppol", "PINT AE", "FTA compliance", "Ministerial Decision 64", "VAT"],
};

export function OrganizationJsonLd() {
  return <JsonLd data={{ "@context": "https://schema.org", ...ORG }} />;
}

export function SoftwareApplicationJsonLd() {
  const lowest = Math.min(...SUB_TIERS.map((t) => t.perMonthMinor)) / 100;
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: SITE_NAME,
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Accounting & Tax Compliance",
        operatingSystem: "Web",
        url: SITE_URL,
        description:
          "Create, validate and transmit UAE PINT AE e-invoices to the FTA over Peppol. Unlimited invoicing, delivery and FTA reporting proven, from AED 299/month.",
        offers: SUB_TIERS.map((t) => ({
          "@type": "Offer",
          name: `ARKS ${t.name}`,
          price: (t.priceMinor / 100).toFixed(2),
          priceCurrency: "AED",
          url: `${SITE_URL}/pricing`,
          category: "subscription",
        })),
        aggregateRating: undefined,
        provider: { "@id": `${SITE_URL}/#org` },
        featureList: [
          "PINT AE UBL validation",
          "Peppol transmission",
          "FTA (Tax Data Document) reporting",
          "Unlimited invoicing",
          "REST API and MCP for AI agents",
        ],
        lowPrice: lowest.toFixed(2),
      }}
    />
  );
}

export function FaqJsonLd({ items }: { items: { q: string; a: string }[] }) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: items.map((it) => ({
          "@type": "Question",
          name: it.q,
          acceptedAnswer: { "@type": "Answer", text: it.a },
        })),
      }}
    />
  );
}

export function BreadcrumbJsonLd({ items }: { items: { name: string; path: string }[] }) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((it, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: it.name,
          item: `${SITE_URL}${it.path}`,
        })),
      }}
    />
  );
}

export function ArticleJsonLd({
  headline,
  description,
  path,
  datePublished,
  dateModified,
}: {
  headline: string;
  description: string;
  path: string;
  datePublished: string;
  dateModified: string;
}) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "Article",
        headline,
        description,
        datePublished,
        dateModified,
        mainEntityOfPage: `${SITE_URL}${path}`,
        author: { "@id": `${SITE_URL}/#org` },
        publisher: { "@id": `${SITE_URL}/#org` },
      }}
    />
  );
}
