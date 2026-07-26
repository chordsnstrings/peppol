import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight, FileCheck2, Radio, ShieldCheck, Infinity as InfinityIcon,
  Zap, Lock, Boxes, Terminal, FileStack, Globe2, CircleCheck,
} from "lucide-react";
import { HeroProof } from "@/components/marketing/hero-proof";
import { PricingCards } from "@/components/marketing/pricing-cards";
import { FaqList } from "@/components/marketing/faq";
import {
  OrganizationJsonLd, WebSiteJsonLd, SoftwareApplicationJsonLd, ServiceJsonLd, HowToJsonLd, FaqJsonLd, BreadcrumbJsonLd,
} from "@/components/marketing/jsonld";
import { HOME_FAQ, REGIME_FACTS, faqText } from "@/lib/marketing/content";

const HOME_FAQ_EN = HOME_FAQ.map((f) => faqText(f, "en"));

export const metadata: Metadata = {
  title: "UAE e-invoicing, engineered — validate & reach the FTA",
  description:
    "Become UAE FTA e-invoicing compliant the moment your phase begins. Validate PINT AE invoices, transmit over Peppol, and prove FTA reporting — unlimited invoicing from AED 299/month. 14-day free trial, no card.",
  alternates: { canonical: "/" },
  openGraph: { title: "UAE e-invoicing, engineered — validate & reach the FTA" },
};

const STEPS = [
  {
    icon: FileStack,
    n: "01",
    t: "Create or import",
    d: "Enter an invoice, import from Excel, or push from your accounting system, e-commerce store, or an AI agent over our API.",
  },
  {
    icon: FileCheck2,
    n: "02",
    t: "Validate to PINT AE",
    d: "Every field is checked against the UAE PINT AE rules before anything leaves your workspace. Errors are caught here, not at the FTA.",
  },
  {
    icon: Radio,
    n: "03",
    t: "Transmit & report",
    d: "We send it to your customer over Peppol and report the Tax Data Document to the FTA — with an evidence bundle proving both.",
  },
];

const FEATURES = [
  { icon: InfinityIcon, t: "Unlimited invoicing", d: "One flat price. No per-invoice fees, no metering anxiety, no surprise bills at month end." },
  { icon: ShieldCheck, t: "Proven to the FTA", d: "Every invoice ships with an evidence bundle: the UBL, the Tax Data Document, and a full timeline." },
  { icon: FileCheck2, t: "Validation-first", d: "PINT AE rules run before send, so malformed invoices never reach the network or the FTA." },
  { icon: Terminal, t: "API & MCP native", d: "A clean REST API and an MCP server let your software — and AI agents — invoice directly." },
  { icon: Boxes, t: "Multi-entity ready", d: "Run several TRNs and branches from one workspace, each isolated, each audit-logged." },
  { icon: Lock, t: "Isolated & encrypted", d: "Per-tenant data isolation, encrypted secrets, strong auth, and full audit trails by default." },
];

export default function LandingPage() {
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd />
      <SoftwareApplicationJsonLd />
      <ServiceJsonLd />
      <HowToJsonLd name="How to send a UAE e-invoice to the FTA" steps={STEPS.map((s) => ({ name: s.t, text: s.d }))} />
      <FaqJsonLd items={HOME_FAQ_EN} />
      <BreadcrumbJsonLd items={[{ name: "Home", path: "/" }]} />

      {/* ---------------------------------------------------------------- HERO */}
      <section className="relative overflow-hidden">
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-60" />
        <div
          className="pointer-events-none absolute -top-40 right-0 h-[520px] w-[520px] rounded-full opacity-40 blur-3xl"
          style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--signal) 40%, transparent), transparent 70%)" }}
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 pb-16 pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:pb-24 lg:pt-20">
          <div>
            <span
              className="mkt-mono inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px]"
              style={{ borderColor: "var(--ink-line)", color: "var(--on-ink-soft)" }}
            >
              <span className="size-1.5 rounded-full" style={{ background: "var(--signal)" }} />
              UAE FTA mandate · Ministerial Decision 64
            </span>

            <h1 className="mkt-display mt-6 text-5xl font-extrabold sm:text-6xl lg:text-[4.4rem]">
              Reach the FTA
              <br />
              in one <span style={{ color: "var(--signal)" }}>clean</span> send.
            </h1>

            <p className="mt-6 max-w-xl text-lg leading-relaxed" style={{ color: "var(--on-ink-soft)" }}>
              ARKS validates your invoice to PINT AE, transmits it over Peppol, and proves it reached the
              Federal Tax Authority. Unlimited invoicing, one flat price — so compliance is a background fact,
              not a monthly worry.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/signup" className="mkt-btn mkt-btn-primary">
                Start 14-day free trial <ArrowRight className="size-4" />
              </Link>
              <Link href="/#how" className="mkt-btn mkt-btn-ghost">
                See how it works
              </Link>
            </div>

            <div className="mkt-mono mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px]" style={{ color: "var(--on-ink-faint)" }}>
              <span className="inline-flex items-center gap-1.5"><CircleCheck className="size-3.5" style={{ color: "var(--signal)" }} /> No credit card</span>
              <span className="inline-flex items-center gap-1.5"><CircleCheck className="size-3.5" style={{ color: "var(--signal)" }} /> Unlimited invoices</span>
              <span className="inline-flex items-center gap-1.5"><CircleCheck className="size-3.5" style={{ color: "var(--signal)" }} /> From AED 299/mo</span>
            </div>
          </div>

          <div className="lg:pl-4">
            <HeroProof />
          </div>
        </div>

        {/* regime facts strip */}
        <div className="relative border-y" style={{ borderColor: "var(--ink-line)", background: "color-mix(in srgb, var(--ink-2) 60%, transparent)" }}>
          <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px px-5 md:grid-cols-4">
            {REGIME_FACTS.map((f) => (
              <div key={f.k.en} className="px-2 py-5">
                <p className="mkt-eyebrow">{f.k.en}</p>
                <p className="mt-1.5 text-sm font-medium" style={{ color: "var(--on-ink)" }}>{f.v.en}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ HOW (paper) */}
      <section id="how" className="mkt-paper mkt-section scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="max-w-2xl">
            <p className="mkt-eyebrow">How it works</p>
            <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-5xl">
              From draft to the FTA, without the guesswork.
            </h2>
            <p className="mkt-soft mt-4 text-lg">
              Three steps, fully automated. You approve; ARKS validates, transmits, and reports.
            </p>
          </div>

          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-2xl border p-6" style={{ borderColor: "var(--paper-line)", background: "#fff" }}>
                <div className="flex items-center justify-between">
                  <span
                    className="flex size-11 items-center justify-center rounded-xl"
                    style={{ background: "var(--signal-ink)", color: "var(--signal-2)" }}
                  >
                    <s.icon className="size-5" />
                  </span>
                  <span className="mkt-mono text-xl font-bold" style={{ color: "var(--paper-line)" }}>{s.n}</span>
                </div>
                <h3 className="mkt-display mt-5 text-xl font-bold">{s.t}</h3>
                <p className="mkt-soft mt-2 text-sm leading-relaxed">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- FEATURES */}
      <section id="features" className="mkt-section scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="max-w-2xl">
              <p className="mkt-eyebrow">What you get</p>
              <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-5xl">
                Built for compliance you never have to think about.
              </h2>
            </div>
            <Link href="/features" className="mkt-btn mkt-btn-ghost">
              See all features <ArrowRight className="size-4" />
            </Link>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.t} className="mkt-card rounded-2xl border p-6" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
                <span className="flex size-11 items-center justify-center rounded-xl" style={{ background: "var(--ink-3)", color: "var(--signal)" }}>
                  <f.icon className="size-5" />
                </span>
                <h3 className="mkt-display mt-5 text-lg font-bold">{f.t}</h3>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--on-ink-soft)" }}>{f.d}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center">
            <Link href="/features" className="mkt-mono text-sm" style={{ color: "var(--signal-2)" }}>
              Explore the full feature set →
            </Link>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- API / MCP band */}
      <section id="api" className="scroll-mt-20 border-y" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 lg:grid-cols-2 lg:py-20">
          <div>
            <p className="mkt-eyebrow inline-flex items-center gap-2"><Zap className="size-3.5" /> For builders</p>
            <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-[2.75rem]">
              Invoicing your software — and your AI — can drive.
            </h2>
            <p className="mt-4 max-w-xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
              A clean REST API and a native MCP server mean an agent or your own backend can create, validate
              and transmit a compliant invoice programmatically. OAuth 2.1, scoped API keys, webhooks — the
              plumbing is done.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Link href="/signup" className="mkt-btn mkt-btn-primary">Start building <ArrowRight className="size-4" /></Link>
              <Link href="/uae-e-invoicing" className="mkt-btn mkt-btn-ghost">Read the mandate guide</Link>
            </div>
          </div>

          <div className="rounded-2xl border p-5 shadow-2xl" style={{ borderColor: "var(--ink-line)", background: "var(--ink)" }}>
            <div className="mkt-mono flex items-center gap-2 text-[11px]" style={{ color: "var(--on-ink-faint)" }}>
              <Terminal className="size-3.5" /> POST /api/v1/invoices
            </div>
            <pre className="mkt-mono mt-3 overflow-x-auto rounded-lg p-4 text-[12.5px] leading-relaxed" style={{ background: "#070a0e", color: "var(--on-ink-soft)" }}>
{`{
  "customer": "Gulf Materials Trading LLC",
  "trn": "100xxxxxxxxxxxx",
  "lines": [{ "desc": "Consulting", "qty": 1,
              "unit": 12000, "vat": 5 }],
  "send": true
}
`}
              <span style={{ color: "var(--signal-2)" }}>{`→ 201  { "status": "SENT",
        "delivered": true, "reported": true }`}</span>
            </pre>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------- PRICING */}
      <section className="mkt-section">
        <div className="mx-auto max-w-6xl px-5">
          <div className="mx-auto max-w-2xl text-center">
            <p className="mkt-eyebrow">Simple pricing</p>
            <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-5xl">One flat price. Everything included.</h2>
            <p className="mt-4 text-lg" style={{ color: "var(--on-ink-soft)" }}>
              Unlimited invoicing on every plan. Commit longer, pay less — that&rsquo;s the only difference.
            </p>
          </div>
          <div className="mt-12">
            <PricingCards compact />
          </div>
          <p className="mkt-mono mt-6 text-center text-[12px]" style={{ color: "var(--on-ink-faint)" }}>
            All prices VAT-inclusive · you receive a tax invoice · cancel anytime
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------------------ FAQ */}
      <section id="faq" className="scroll-mt-20 border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto max-w-3xl px-5 py-16 lg:py-24">
          <div className="text-center">
            <p className="mkt-eyebrow">Questions</p>
            <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-5xl">Everything you were about to ask.</h2>
          </div>
          <div className="mt-10">
            <FaqList items={HOME_FAQ_EN} />
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ FINAL CTA */}
      <section className="relative overflow-hidden border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{ background: "radial-gradient(60% 120% at 50% 0%, color-mix(in srgb, var(--signal) 18%, transparent), transparent 70%)" }}
        />
        <div className="relative mx-auto max-w-3xl px-5 py-20 text-center lg:py-28">
          <h2 className="mkt-display text-4xl font-extrabold sm:text-5xl">
            Be ready before the mandate reaches you.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
            Start free today. Send your first compliant invoice to the FTA in minutes — no card, no sales call.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link href="/signup" className="mkt-btn mkt-btn-primary">
              Start 14-day free trial <ArrowRight className="size-4" />
            </Link>
            <Link href="/pricing" className="mkt-btn mkt-btn-ghost">
              <Globe2 className="size-4" /> Compare plans
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
