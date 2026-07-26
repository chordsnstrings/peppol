import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { FeatureGrid } from "@/components/marketing/feature-grid";
import { OrganizationJsonLd, WebSiteJsonLd, ServiceJsonLd, ItemListJsonLd, BreadcrumbJsonLd } from "@/components/marketing/jsonld";
import { FEATURE_GROUPS, ALL_FEATURES } from "@/lib/marketing/content";

export const metadata: Metadata = {
  title: "Features — everything for UAE FTA e-invoicing",
  description:
    "The complete ARKS feature set for UAE e-invoicing: PINT AE validation, Peppol transmission, FTA reporting with evidence bundles, receivables, Excel & accounting imports, a REST API and MCP server — unlimited invoicing on every plan.",
  alternates: { canonical: "/features" },
  openGraph: {
    title: "Features — everything for UAE FTA e-invoicing",
    description:
      "PINT AE validation, Peppol transmission, FTA reporting, receivables, imports, REST API + MCP. The full ARKS platform.",
  },
};

export default function FeaturesPage() {
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd />
      <ServiceJsonLd />
      <ItemListJsonLd name="ARKS features" items={ALL_FEATURES.map((f) => ({ name: f.title.en }))} />
      <BreadcrumbJsonLd items={[{ name: "Home", path: "/" }, { name: "Features", path: "/features" }]} />

      {/* hero */}
      <section className="relative overflow-hidden border-b" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-6xl px-5 pb-12 pt-16 lg:pt-20">
          <p className="mkt-eyebrow">The platform</p>
          <h1 className="mkt-display mt-4 max-w-3xl text-5xl font-extrabold sm:text-6xl">
            Everything you need to be <span style={{ color: "var(--signal)" }}>compliant</span> — and get paid.
          </h1>
          <p className="mt-6 max-w-2xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
            From the invoice editor to the FTA and back to your bank. Every capability below is included on
            every plan — unlimited invoicing, one flat price.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup" className="mkt-btn mkt-btn-primary">
              Start 14-day free trial <ArrowRight className="size-4" />
            </Link>
            <Link href="/pricing" className="mkt-btn mkt-btn-ghost">See pricing</Link>
          </div>

          {/* jump nav */}
          <nav className="mt-10 flex flex-wrap gap-2" aria-label="Feature categories">
            {FEATURE_GROUPS.map((g) => (
              <a
                key={g.id}
                href={`#${g.id}`}
                className="mkt-mono rounded-full border px-3 py-1.5 text-[12px] transition-colors"
                style={{ borderColor: "var(--ink-line)", color: "var(--on-ink-soft)" }}
              >
                {g.eyebrow.en}
              </a>
            ))}
          </nav>
        </div>
      </section>

      {/* the catalog */}
      <section className="mkt-section">
        <div className="mx-auto max-w-6xl px-5">
          <FeatureGrid groups={FEATURE_GROUPS} />
        </div>
      </section>

      {/* developer cross-link */}
      <section className="border-t" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-5 py-12">
          <div className="max-w-xl">
            <h2 className="mkt-display text-2xl font-bold sm:text-3xl">Built to be automated.</h2>
            <p className="mt-2 text-base" style={{ color: "var(--on-ink-soft)" }}>
              A REST API and a native MCP server let your software — and your AI agents — invoice directly.
            </p>
          </div>
          <Link href="/developers" className="mkt-btn mkt-btn-ghost">
            Explore the API & MCP <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto max-w-3xl px-5 py-16 text-center lg:py-20">
          <h2 className="mkt-display text-3xl font-bold sm:text-4xl">See it on your own invoices.</h2>
          <p className="mx-auto mt-4 max-w-xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
            Start free — send a compliant invoice to the FTA in minutes.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link href="/signup" className="mkt-btn mkt-btn-primary">Start 14-day free trial <ArrowRight className="size-4" /></Link>
            <Link href="/uae-e-invoicing" className="mkt-btn mkt-btn-ghost">Read the mandate guide</Link>
          </div>
        </div>
      </section>
    </>
  );
}
