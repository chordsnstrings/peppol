import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import { OrganizationJsonLd, WebSiteJsonLd, ItemListJsonLd, BreadcrumbJsonLd } from "@/components/marketing/jsonld";
import { INTEGRATIONS } from "@/lib/marketing/integrations";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Integrations — connect your accounting & store to UAE e-invoicing",
  description:
    "Connect Zoho Books, QuickBooks, Xero, Odoo, Shopify and WooCommerce to ARKS. Your invoices and orders sync in, get validated to PINT AE, and are reported to the UAE FTA over Peppol.",
  alternates: { canonical: "/connect" },
  openGraph: {
    title: "Integrations — connect your accounting & store to UAE e-invoicing",
    description: "Zoho Books, QuickBooks, Xero, Odoo, Shopify and WooCommerce — synced, validated and reported to the FTA.",
  },
};

const KINDS = ["Accounting", "E-commerce"] as const;

export default function IntegrationsHub() {
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd />
      <ItemListJsonLd
        name="ARKS integrations"
        items={INTEGRATIONS.map((i) => ({ name: i.name, url: `${SITE_URL}/connect/${i.slug}` }))}
      />
      <BreadcrumbJsonLd items={[{ name: "Home", path: "/" }, { name: "Integrations", path: "/connect" }]} />

      <section className="relative overflow-hidden border-b" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-6xl px-5 pb-12 pt-16 lg:pt-20">
          <p className="mkt-eyebrow">Integrations</p>
          <h1 className="mkt-display mt-4 max-w-3xl text-5xl font-extrabold sm:text-6xl">
            Your stack, <span style={{ color: "var(--signal)" }}>connected</span> to the FTA.
          </h1>
          <p className="mt-6 max-w-2xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
            Keep invoicing where your business already runs. Connect your accounting system or online store and
            ARKS validates every invoice to PINT AE and reports it to the UAE FTA over Peppol.
          </p>
        </div>
      </section>

      <section className="mkt-section">
        <div className="mx-auto max-w-6xl space-y-14 px-5">
          {KINDS.map((kind) => (
            <div key={kind}>
              <h2 className="mkt-eyebrow">{kind}</h2>
              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {INTEGRATIONS.filter((i) => i.kind === kind).map((i) => (
                  <Link
                    key={i.slug}
                    href={`/connect/${i.slug}`}
                    className="mkt-card group flex flex-col rounded-2xl border p-6"
                    style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className="mkt-display flex size-11 items-center justify-center rounded-xl text-lg font-bold"
                        style={{ background: "var(--ink-3)", color: "var(--signal)" }}
                      >
                        {i.mono}
                      </span>
                      <ArrowUpRight className="size-5" style={{ color: "var(--on-ink-faint)" }} />
                    </div>
                    <h3 className="mkt-display mt-5 text-lg font-bold">{i.name}</h3>
                    <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--on-ink-soft)" }}>{i.tagline}</p>
                  </Link>
                ))}
              </div>
            </div>
          ))}
          <p className="text-sm" style={{ color: "var(--on-ink-soft)" }}>
            Prefer files? ARKS also imports from Excel, CSV and Tally exports — with automatic column mapping.
          </p>
        </div>
      </section>

      <section className="border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto max-w-3xl px-5 py-16 text-center lg:py-20">
          <h2 className="mkt-display text-3xl font-bold sm:text-4xl">Don&rsquo;t see your system?</h2>
          <p className="mx-auto mt-4 max-w-xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
            Use the REST API or MCP server to connect anything — or import a spreadsheet in seconds.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link href="/signup" className="mkt-btn mkt-btn-primary">Start free <ArrowRight className="size-4" /></Link>
            <Link href="/developers" className="mkt-btn mkt-btn-ghost">See the API</Link>
          </div>
        </div>
      </section>
    </>
  );
}
