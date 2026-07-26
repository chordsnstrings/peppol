import { SITE_URL, SITE_NAME, SITE_SHORT, SITE_SOCIALS, SITE_LOGO_PNG, SITE_LOGO_W, SITE_LOGO_H, SITE_AREA } from "@/lib/site";
import { SUB_TIERS } from "@/lib/domain/billing";
import type { Locale } from "@/lib/marketing/i18n";
import { htmlLang } from "@/lib/marketing/i18n";

/**
 * Structured data (schema.org) — the machine-readable substrate for Google rich
 * results and the LLM-citation play. Rendered as <script type="ld+json"> (allowed
 * by CSP — inert, not executed). Kept factual and canonical so an assistant
 * answering "how do I comply with UAE e-invoicing" can quote it. All emitters
 * reference the single Organization node by @id so entity signals consolidate.
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

const ORG_ID = `${SITE_URL}/#org`;
const WEBSITE_ID = `${SITE_URL}/#website`;

const ORG = {
  "@type": "Organization",
  "@id": ORG_ID,
  name: SITE_SHORT,
  legalName: SITE_NAME,
  url: SITE_URL,
  logo: {
    "@type": "ImageObject",
    url: `${SITE_URL}${SITE_LOGO_PNG}`,
    width: SITE_LOGO_W,
    height: SITE_LOGO_H,
  },
  description:
    "ARKS is a UAE e-invoicing platform that validates PINT AE invoices, transmits them to the Federal Tax Authority over the Peppol network, and proves delivery and reporting.",
  areaServed: { "@type": "Country", name: SITE_AREA },
  knowsAbout: ["UAE e-invoicing", "Peppol", "PINT AE", "FTA compliance", "Ministerial Decision 64", "VAT", "Tax Data Document"],
  ...(SITE_SOCIALS.length ? { sameAs: SITE_SOCIALS } : {}),
};

export function OrganizationJsonLd() {
  return <JsonLd data={{ "@context": "https://schema.org", ...ORG }} />;
}

/** WebSite node — the primary signal Google uses for the site-name in SERPs. */
export function WebSiteJsonLd({ locale = "en" }: { locale?: Locale } = {}) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        url: SITE_URL,
        name: SITE_NAME,
        inLanguage: htmlLang(locale),
        publisher: { "@id": ORG_ID },
      }}
    />
  );
}

// Offers stay quotable for ~a year; recomputed each build (SSG).
const PRICE_VALID_UNTIL = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

export function SoftwareApplicationJsonLd() {
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
          availability: "https://schema.org/InStock",
          priceValidUntil: PRICE_VALID_UNTIL,
          category: "subscription",
        })),
        provider: { "@id": ORG_ID },
        featureList: [
          "PINT AE UBL validation",
          "Peppol transmission",
          "FTA (Tax Data Document) reporting",
          "Unlimited invoicing",
          "REST API and MCP for AI agents",
        ],
      }}
    />
  );
}

/** The e-invoicing service itself (distinct from the software), with its offers. */
export function ServiceJsonLd() {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "Service",
        serviceType: "E-invoicing and FTA reporting",
        name: `${SITE_SHORT} UAE e-invoicing`,
        areaServed: { "@type": "Country", name: SITE_AREA },
        provider: { "@id": ORG_ID },
        description:
          "Validate PINT AE invoices, transmit them over the Peppol network, and report the Tax Data Document to the UAE Federal Tax Authority — with an evidence bundle per invoice.",
        hasOfferCatalog: {
          "@type": "OfferCatalog",
          name: "ARKS subscription plans",
          itemListElement: SUB_TIERS.map((t) => ({
            "@type": "Offer",
            name: `ARKS ${t.name}`,
            price: (t.priceMinor / 100).toFixed(2),
            priceCurrency: "AED",
          })),
        },
      }}
    />
  );
}

export function HowToJsonLd({
  name,
  steps,
  locale = "en",
}: {
  name: string;
  steps: { name: string; text: string }[];
  locale?: Locale;
}) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "HowTo",
        name,
        inLanguage: htmlLang(locale),
        step: steps.map((s, i) => ({
          "@type": "HowToStep",
          position: i + 1,
          name: s.name,
          text: s.text,
        })),
      }}
    />
  );
}

export function FaqJsonLd({ items, locale = "en" }: { items: { q: string; a: string }[]; locale?: Locale }) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "FAQPage",
        inLanguage: htmlLang(locale),
        mainEntity: items.map((it) => ({
          "@type": "Question",
          name: it.q,
          acceptedAnswer: { "@type": "Answer", text: it.a },
        })),
      }}
    />
  );
}

/** ItemList — for feature / integration catalog pages. */
export function ItemListJsonLd({ name, items }: { name: string; items: { name: string; url?: string }[] }) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "ItemList",
        name,
        itemListElement: items.map((it, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: it.name,
          ...(it.url ? { url: it.url } : {}),
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
  locale = "en",
}: {
  headline: string;
  description: string;
  path: string;
  datePublished: string;
  dateModified: string;
  locale?: Locale;
}) {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "Article",
        headline,
        description,
        inLanguage: htmlLang(locale),
        datePublished,
        dateModified,
        mainEntityOfPage: `${SITE_URL}${path}`,
        image: `${SITE_URL}/opengraph-image`,
        author: { "@id": ORG_ID },
        publisher: { "@id": ORG_ID },
      }}
    />
  );
}
