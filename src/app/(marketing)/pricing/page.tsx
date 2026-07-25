import type { Metadata } from "next";
import Link from "next/link";
import { Check, ArrowRight, ShieldCheck, Infinity as InfinityIcon, FileCheck2 } from "lucide-react";
import { PricingCards } from "@/components/marketing/pricing-cards";
import { FaqList } from "@/components/marketing/faq";
import { SoftwareApplicationJsonLd, FaqJsonLd, BreadcrumbJsonLd } from "@/components/marketing/jsonld";
import { HOME_FAQ } from "@/lib/marketing/content";

export const metadata: Metadata = {
  title: "Pricing — unlimited UAE e-invoicing from AED 299/mo",
  description:
    "Simple, flat pricing for UAE FTA e-invoicing. AED 299/month, AED 1,500/6 months, or AED 2,400/year — all with unlimited invoicing and every feature. 14-day free trial, no card required.",
  alternates: { canonical: "/pricing" },
};

const INCLUDED = [
  "Unlimited invoices, credit & debit notes",
  "PINT AE validation before every send",
  "Peppol transmission via access point",
  "FTA reporting + evidence bundle (UBL · TDD · timeline)",
  "Excel import & accounting-system connectors",
  "REST API + MCP server for AI agents",
  "Team members, roles & multi-entity",
  "Audit log & data export, always",
];

const TRUST = [
  { icon: InfinityIcon, t: "No metering", d: "Our cost per invoice is a fraction of a fil. We don't count — you just send." },
  { icon: FileCheck2, t: "No lock-in", d: "Export your invoices and evidence bundles at any time, on any plan." },
  { icon: ShieldCheck, t: "No cutoff without warning", d: "A 7-day grace period and reminders precede any pause. Your data stays yours." },
];

export default function PricingPage() {
  return (
    <>
      <SoftwareApplicationJsonLd />
      <FaqJsonLd items={HOME_FAQ} />
      <BreadcrumbJsonLd items={[{ name: "Home", path: "/" }, { name: "Pricing", path: "/pricing" }]} />

      {/* hero */}
      <section className="relative overflow-hidden">
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-3xl px-5 pb-4 pt-16 text-center lg:pt-24">
          <p className="mkt-eyebrow">Pricing</p>
          <h1 className="mkt-display mt-4 text-5xl font-extrabold sm:text-6xl">
            Unlimited invoicing.
            <br />
            One flat <span style={{ color: "var(--signal)" }}>price</span>.
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
            Every plan is the full product with unlimited transmission to the FTA. The longer you commit, the
            less you pay per month — nothing else changes.
          </p>
        </div>
      </section>

      {/* cards */}
      <section className="mx-auto max-w-6xl px-5 pb-4 pt-8">
        <PricingCards />
        <p className="mkt-mono mt-6 text-center text-[12px]" style={{ color: "var(--on-ink-faint)" }}>
          Prices in AED, VAT-inclusive · a tax invoice is issued for your subscription · 14-day free trial, no card
        </p>
      </section>

      {/* everything included */}
      <section className="mkt-section">
        <div className="mx-auto max-w-6xl px-5">
          <div className="rounded-3xl border p-8 lg:p-12" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
            <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
              <div>
                <p className="mkt-eyebrow">In every plan</p>
                <h2 className="mkt-display mt-3 text-3xl font-bold sm:text-4xl">
                  There is no &ldquo;pro&rdquo; tier. This is the whole thing.
                </h2>
                <p className="mt-4 text-base" style={{ color: "var(--on-ink-soft)" }}>
                  We don&rsquo;t gate compliance features behind a higher price. Whether you send ten invoices
                  or ten thousand, you get the complete platform.
                </p>
                <Link href="/signup" className="mkt-btn mkt-btn-primary mt-6">
                  Start free <ArrowRight className="size-4" />
                </Link>
              </div>
              <ul className="grid gap-3 sm:grid-cols-2">
                {INCLUDED.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm" style={{ color: "var(--on-ink)" }}>
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--signal-ink)", color: "var(--signal-2)" }}>
                      <Check className="size-3.5" />
                    </span>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {TRUST.map((t) => (
              <div key={t.t} className="rounded-2xl border p-6" style={{ borderColor: "var(--ink-line)" }}>
                <t.icon className="size-5" style={{ color: "var(--signal)" }} />
                <h3 className="mkt-display mt-4 text-lg font-bold">{t.t}</h3>
                <p className="mt-2 text-sm" style={{ color: "var(--on-ink-soft)" }}>{t.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* faq */}
      <section className="border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto max-w-3xl px-5 py-16 lg:py-20">
          <h2 className="mkt-display text-center text-3xl font-bold sm:text-4xl">Pricing questions</h2>
          <div className="mt-10">
            <FaqList items={HOME_FAQ.slice(1, 5)} />
          </div>
          <p className="mt-8 text-center text-sm" style={{ color: "var(--on-ink-soft)" }}>
            Still deciding?{" "}
            <Link href="/signup" className="font-medium" style={{ color: "var(--signal-2)" }}>
              Start the free trial
            </Link>{" "}
            — no card, cancel anytime.
          </p>
        </div>
      </section>
    </>
  );
}
