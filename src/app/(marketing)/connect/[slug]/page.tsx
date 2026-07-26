import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { FaqList } from "@/components/marketing/faq";
import {
  OrganizationJsonLd, WebSiteJsonLd, SoftwareApplicationJsonLd, HowToJsonLd, FaqJsonLd, BreadcrumbJsonLd,
} from "@/components/marketing/jsonld";
import { INTEGRATIONS, INTEGRATION_BY_SLUG } from "@/lib/marketing/integrations";

export function generateStaticParams() {
  return INTEGRATIONS.map((i) => ({ slug: i.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const it = INTEGRATION_BY_SLUG[slug];
  if (!it) return {};
  const title = `${it.name} UAE e-invoicing — sync to the FTA`;
  return {
    title,
    description: it.intro,
    alternates: { canonical: `/connect/${it.slug}` },
    openGraph: { title, description: it.tagline },
  };
}

export default async function IntegrationPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const it = INTEGRATION_BY_SLUG[slug];
  if (!it) notFound();

  const others = INTEGRATIONS.filter((i) => i.slug !== it.slug).slice(0, 3);

  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd />
      <SoftwareApplicationJsonLd />
      <HowToJsonLd name={`Connect ${it.name} to UAE e-invoicing`} steps={it.steps} />
      <FaqJsonLd items={it.faq} />
      <BreadcrumbJsonLd
        items={[{ name: "Home", path: "/" }, { name: "Integrations", path: "/connect" }, { name: it.name, path: `/connect/${it.slug}` }]}
      />

      {/* hero */}
      <section className="relative overflow-hidden border-b" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-4xl px-5 pb-12 pt-16 lg:pt-20">
          <nav className="mkt-mono text-[12px]" style={{ color: "var(--on-ink-faint)" }} aria-label="Breadcrumb">
            <Link href="/connect" style={{ color: "var(--on-ink-soft)" }}>Integrations</Link> / {it.name}
          </nav>
          <div className="mt-6 flex items-center gap-4">
            <span className="mkt-display flex size-14 items-center justify-center rounded-2xl text-2xl font-bold" style={{ background: "var(--ink-3)", color: "var(--signal)" }}>
              {it.mono}
            </span>
            <span className="mkt-mono rounded-full border px-3 py-1 text-[11px]" style={{ borderColor: "var(--ink-line)", color: "var(--on-ink-soft)" }}>
              {it.kind}
            </span>
          </div>
          <h1 className="mkt-display mt-6 max-w-3xl text-4xl font-extrabold sm:text-5xl">{it.tagline}</h1>
          <p className="mt-5 max-w-2xl text-lg" style={{ color: "var(--on-ink-soft)" }}>{it.intro}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup" className="mkt-btn mkt-btn-primary">Start 14-day free trial <ArrowRight className="size-4" /></Link>
            <Link href="/features" className="mkt-btn mkt-btn-ghost">See all features</Link>
          </div>
        </div>
      </section>

      {/* what it does */}
      <section className="mkt-section">
        <div className="mx-auto grid max-w-4xl gap-12 px-5 lg:grid-cols-[1fr_1fr]">
          <div>
            <p className="mkt-eyebrow">What you get</p>
            <h2 className="mkt-display mt-3 text-3xl font-bold">A real connection, not a CSV dance.</h2>
            <ul className="mt-6 space-y-3">
              {it.bullets.map((b) => (
                <li key={b} className="flex items-start gap-2.5 text-sm" style={{ color: "var(--on-ink-soft)" }}>
                  <Check className="mt-0.5 size-4 shrink-0" style={{ color: "var(--signal)" }} />
                  {b}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mkt-eyebrow">How it works</p>
            <ol className="mt-4 space-y-4">
              {it.steps.map((s, i) => (
                <li key={s.name} className="rounded-xl border p-4" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
                  <span className="mkt-mono text-sm" style={{ color: "var(--signal)" }}>{String(i + 1).padStart(2, "0")}</span>
                  <p className="mkt-display mt-1 font-bold">{s.name}</p>
                  <p className="mt-1 text-sm" style={{ color: "var(--on-ink-soft)" }}>{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto max-w-3xl px-5 py-14">
          <h2 className="mkt-display text-2xl font-bold sm:text-3xl">{it.name} e-invoicing FAQ</h2>
          <div className="mt-6">
            <FaqList items={it.faq} />
          </div>
        </div>
      </section>

      {/* other integrations */}
      <section className="border-t" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
        <div className="mx-auto max-w-6xl px-5 py-14">
          <p className="mkt-eyebrow">More integrations</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            {others.map((o) => (
              <Link key={o.slug} href={`/connect/${o.slug}`} className="mkt-card rounded-2xl border p-5" style={{ borderColor: "var(--ink-line)", background: "var(--ink)" }}>
                <span className="mkt-display flex size-10 items-center justify-center rounded-lg font-bold" style={{ background: "var(--ink-3)", color: "var(--signal)" }}>{o.mono}</span>
                <p className="mkt-display mt-3 font-bold">{o.name}</p>
                <p className="mt-1 text-sm" style={{ color: "var(--on-ink-soft)" }}>{o.tagline}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
