import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { FaqList } from "@/components/marketing/faq";
import { OrganizationJsonLd, ArticleJsonLd, FaqJsonLd, BreadcrumbJsonLd } from "@/components/marketing/jsonld";
import { MANDATE_FAQ, REGIME_FACTS, faqText } from "@/lib/marketing/content";
import { GUIDES } from "@/lib/marketing/guides";

const MANDATE_FAQ_EN = MANDATE_FAQ.map((f) => faqText(f, "en"));

const PUBLISHED = "2026-01-01";
const MODIFIED = "2026-07-01";

export const metadata: Metadata = {
  title: "UAE e-invoicing explained — the FTA mandate, PINT AE & Peppol",
  description:
    "A plain-English guide to UAE mandatory e-invoicing: Ministerial Decision 64, the Peppol 5-corner model, the PINT AE format, the Tax Data Document, and the rollout timeline — and how to be ready.",
  alternates: { canonical: "/uae-e-invoicing" },
  openGraph: { type: "article", title: "UAE e-invoicing explained — the FTA mandate, PINT AE & Peppol" },
};

const TOC = [
  { href: "#overview", label: "Overview" },
  { href: "#model", label: "The 5-corner model" },
  { href: "#pint-ae", label: "PINT AE format" },
  { href: "#timeline", label: "Rollout timeline" },
  { href: "#arks", label: "How ARKS helps" },
  { href: "#faq", label: "FAQ" },
];

export default function MandateGuide() {
  return (
    <>
      <OrganizationJsonLd />
      <ArticleJsonLd
        headline="UAE e-invoicing explained: the FTA mandate, PINT AE and Peppol"
        description="A plain-English guide to UAE mandatory e-invoicing under Ministerial Decision 64 — the Peppol 5-corner model, the PINT AE format, the Tax Data Document, and the rollout timeline."
        path="/uae-e-invoicing"
        datePublished={PUBLISHED}
        dateModified={MODIFIED}
      />
      <FaqJsonLd items={MANDATE_FAQ_EN} />
      <BreadcrumbJsonLd items={[{ name: "Home", path: "/" }, { name: "UAE e-invoicing", path: "/uae-e-invoicing" }]} />

      {/* hero */}
      <section className="relative overflow-hidden border-b" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-3xl px-5 pb-12 pt-16 lg:pt-20">
          <p className="mkt-eyebrow">Compliance guide</p>
          <h1 className="mkt-display mt-4 text-4xl font-extrabold sm:text-5xl">
            UAE e-invoicing, explained.
          </h1>
          <p className="mt-5 text-lg" style={{ color: "var(--on-ink-soft)" }}>
            What the FTA mandate actually requires — the Peppol network, the PINT AE format, and the reporting
            step — written plainly, kept current.
          </p>
          <div className="mkt-mono mt-6 flex flex-wrap gap-x-5 gap-y-1 text-[11px]" style={{ color: "var(--on-ink-faint)" }}>
            {REGIME_FACTS.map((f) => (
              <span key={f.k.en}>{f.k.en}: <span style={{ color: "var(--on-ink-soft)" }}>{f.v.en}</span></span>
            ))}
          </div>
        </div>
      </section>

      {/* body on paper for legibility */}
      <section className="mkt-paper">
        <div className="mx-auto grid max-w-5xl gap-12 px-5 py-14 lg:grid-cols-[220px_1fr] lg:py-20">
          {/* sticky TOC */}
          <nav className="hidden lg:block">
            <div className="sticky top-24">
              <p className="mkt-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--on-paper-soft)" }}>On this page</p>
              <ul className="mt-3 space-y-2 border-l pl-4" style={{ borderColor: "var(--paper-line)" }}>
                {TOC.map((t) => (
                  <li key={t.href}>
                    <a href={t.href} className="text-sm" style={{ color: "var(--on-paper-soft)" }}>{t.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>

          <article className="mkt-article max-w-2xl">
            <Prose id="overview" h="What is UAE e-invoicing?">
              <p>
                The United Arab Emirates is moving to mandatory <strong>electronic invoicing</strong>. Under
                Ministerial Decision No. 64 of 2025, VAT-registered businesses will exchange invoices as
                structured digital documents through accredited service providers, and the underlying tax data
                will be reported to the Federal Tax Authority (FTA). This replaces the informal PDF-by-email
                invoice with a machine-readable document that can be validated, transmitted and reported
                automatically.
              </p>
              <p>
                The goal is a real-time, standardised view of business-to-business and business-to-government
                transactions — reducing VAT fraud and administrative cost, and bringing the UAE in line with
                international continuous-transaction-control regimes.
              </p>
            </Prose>

            <Prose id="model" h="The Peppol 5-corner model">
              <p>
                The UAE uses the international <strong>Peppol</strong> framework in a <strong>5-corner
                model</strong>:
              </p>
              <ul>
                <li><strong>Corner 1 — Supplier:</strong> issues the invoice.</li>
                <li><strong>Corner 2 — Supplier&rsquo;s access point:</strong> validates and sends it (this is where ARKS sits).</li>
                <li><strong>Corner 3 — Buyer&rsquo;s access point:</strong> receives and delivers it.</li>
                <li><strong>Corner 4 — Buyer:</strong> receives the structured invoice.</li>
                <li><strong>Corner 5 — The FTA:</strong> receives the reported tax data.</li>
              </ul>
              <p>
                Because both parties connect through accredited access points, the two businesses never have to
                agree on a file format or a portal — the network handles interoperability.
              </p>
            </Prose>

            <Prose id="pint-ae" h="The PINT AE format">
              <p>
                <strong>PINT AE</strong> is the UAE&rsquo;s national specialisation of Peppol International
                (PINT) — a structured <abbr title="Universal Business Language">UBL</abbr> XML format that
                defines exactly which fields a UAE tax invoice must carry (TRN, VAT breakdown, line items,
                references, and more) and the rules those fields must satisfy.
              </p>
              <p>
                Validating to PINT AE <em>before</em> sending is the single most important step: an invoice
                that fails the rules should never reach the network. ARKS runs this validation on every
                document and surfaces precise, field-level errors so they can be fixed at source.
              </p>
            </Prose>

            <Prose id="timeline" h="Rollout timeline">
              <p>
                The FTA is introducing the mandate in <strong>phases</strong>, beginning with larger taxpayers
                and expanding to all VAT-registered businesses. Each phase has its own go-live date set by the
                FTA, alongside an accreditation process for service providers.
              </p>
              <p>
                The practical takeaway: the direction is fixed and the phases are approaching. Being ready
                early means no last-minute scramble, no failed submissions, and no compliance risk when your
                phase begins.
              </p>
            </Prose>

            <Prose id="arks" h="How ARKS helps">
              <p>
                ARKS is the access point and reporting bridge in one. You create or import an invoice; ARKS
                validates it to PINT AE, transmits it over Peppol, and reports the <strong>Tax Data
                Document</strong> to the FTA — then hands you an evidence bundle proving delivery and
                reporting. Unlimited invoicing, a REST API and an MCP server for automation, and a flat
                subscription with a 14-day free trial.
              </p>
            </Prose>

            <div className="mt-8 rounded-2xl border p-6" style={{ borderColor: "var(--paper-line)", background: "#fff" }}>
              <p className="mkt-display text-xl font-bold">Ready when your phase is.</p>
              <p className="mkt-soft mt-1.5 text-sm">Start free — send a compliant invoice to the FTA today.</p>
              <Link href="/signup" className="mkt-btn mkt-btn-dark mt-4">
                Start 14-day free trial <ArrowRight className="size-4" />
              </Link>
            </div>
          </article>
        </div>
      </section>

      {/* faq */}
      <section id="faq" className="scroll-mt-20 border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto max-w-3xl px-5 py-16 lg:py-20">
          <h2 className="mkt-display text-center text-3xl font-bold sm:text-4xl">Mandate FAQ</h2>
          <div className="mt-10">
            <FaqList items={MANDATE_FAQ_EN} />
          </div>
        </div>
      </section>

      {/* go deeper — pillar → spoke internal links */}
      <section className="border-t" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
        <div className="mx-auto max-w-6xl px-5 py-14">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mkt-eyebrow">Go deeper</p>
              <h2 className="mkt-display mt-3 text-2xl font-bold sm:text-3xl">Detailed guides</h2>
            </div>
            <Link href="/guides" className="mkt-btn mkt-btn-ghost">All guides <ArrowRight className="size-4" /></Link>
          </div>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {GUIDES.filter((g) => g.slug !== "glossary").map((g) => (
              <Link key={g.slug} href={`/guides/${g.slug}`} className="mkt-card rounded-2xl border p-5" style={{ borderColor: "var(--ink-line)", background: "var(--ink)" }}>
                <p className="mkt-display font-bold">{g.h1}</p>
                <p className="mt-1 text-sm" style={{ color: "var(--on-ink-soft)" }}>{g.description}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function Prose({ id, h, children }: { id: string; h: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 [&:not(:first-child)]:mt-10">
      <h2 className="mkt-display text-2xl font-bold sm:text-3xl">{h}</h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed [&_abbr]:cursor-help [&_li]:mt-1.5 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5" style={{ color: "var(--on-paper-soft)" }}>
        {children}
      </div>
    </section>
  );
}
