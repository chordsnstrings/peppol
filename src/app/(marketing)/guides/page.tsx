import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BookOpen } from "lucide-react";
import { OrganizationJsonLd, WebSiteJsonLd, ItemListJsonLd, BreadcrumbJsonLd } from "@/components/marketing/jsonld";
import { GUIDES } from "@/lib/marketing/guides";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "UAE e-invoicing guides — PINT AE, Peppol, the FTA mandate",
  description:
    "Plain-English guides to UAE e-invoicing: the PINT AE format, the Peppol 5-corner model, the Tax Data Document, Ministerial Decision 64, a readiness checklist and a glossary.",
  alternates: { canonical: "/guides" },
  openGraph: {
    title: "UAE e-invoicing guides — PINT AE, Peppol, the FTA mandate",
    description: "Factual, structured guides to the UAE e-invoicing regime.",
  },
};

export default function GuidesHub() {
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd />
      <ItemListJsonLd name="UAE e-invoicing guides" items={GUIDES.map((g) => ({ name: g.h1, url: `${SITE_URL}/guides/${g.slug}` }))} />
      <BreadcrumbJsonLd items={[{ name: "Home", path: "/" }, { name: "Guides", path: "/guides" }]} />

      <section className="relative overflow-hidden border-b" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-6xl px-5 pb-12 pt-16 lg:pt-20">
          <p className="mkt-eyebrow">Guides</p>
          <h1 className="mkt-display mt-4 max-w-3xl text-5xl font-extrabold sm:text-6xl">
            Understand UAE <span style={{ color: "var(--signal)" }}>e-invoicing</span>.
          </h1>
          <p className="mt-6 max-w-2xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
            The mandate, the formats and the network — explained plainly and kept current. Start with the
            overview, then go deep.
          </p>
          <div className="mt-8">
            <Link href="/uae-e-invoicing" className="mkt-btn mkt-btn-primary">
              Start with the overview <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      <section className="mkt-section">
        <div className="mx-auto grid max-w-6xl gap-4 px-5 sm:grid-cols-2 lg:grid-cols-3">
          {GUIDES.map((g) => (
            <Link
              key={g.slug}
              href={`/guides/${g.slug}`}
              className="mkt-card group flex flex-col rounded-2xl border p-6"
              style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}
            >
              <BookOpen className="size-5" style={{ color: "var(--signal)" }} />
              <h2 className="mkt-display mt-4 text-lg font-bold">{g.h1}</h2>
              <p className="mt-2 flex-1 text-sm leading-relaxed" style={{ color: "var(--on-ink-soft)" }}>{g.description}</p>
              <span className="mkt-mono mt-4 text-[12px]" style={{ color: "var(--signal-2)" }}>Read →</span>
            </Link>
          ))}
        </div>
      </section>
    </>
  );
}
