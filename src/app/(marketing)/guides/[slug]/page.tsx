import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { FaqList } from "@/components/marketing/faq";
import {
  OrganizationJsonLd, WebSiteJsonLd, ArticleJsonLd, FaqJsonLd, BreadcrumbJsonLd,
} from "@/components/marketing/jsonld";
import { GUIDES, GUIDE_BY_SLUG } from "@/lib/marketing/guides";

export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const g = GUIDE_BY_SLUG[slug];
  if (!g) return {};
  return {
    title: g.title,
    description: g.description,
    alternates: { canonical: `/guides/${g.slug}` },
    openGraph: {
      type: "article",
      title: g.title,
      description: g.description,
      publishedTime: g.published,
      modifiedTime: g.modified,
    },
  };
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const g = GUIDE_BY_SLUG[slug];
  if (!g) notFound();

  const related = g.related.map((s) => GUIDE_BY_SLUG[s]).filter(Boolean);

  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd />
      <ArticleJsonLd
        headline={g.h1}
        description={g.description}
        path={`/guides/${g.slug}`}
        datePublished={g.published}
        dateModified={g.modified}
      />
      {g.faq && <FaqJsonLd items={g.faq} />}
      <BreadcrumbJsonLd items={[{ name: "Home", path: "/" }, { name: "Guides", path: "/guides" }, { name: g.h1, path: `/guides/${g.slug}` }]} />

      {/* hero */}
      <section className="relative overflow-hidden border-b" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto max-w-3xl px-5 pb-10 pt-16 lg:pt-20">
          <nav className="mkt-mono text-[12px]" style={{ color: "var(--on-ink-faint)" }} aria-label="Breadcrumb">
            <Link href="/guides" style={{ color: "var(--on-ink-soft)" }}>Guides</Link> / {g.h1}
          </nav>
          <h1 className="mkt-display mt-5 text-4xl font-extrabold sm:text-5xl">{g.h1}</h1>
          <p className="mt-4 text-lg" style={{ color: "var(--on-ink-soft)" }}>{g.description}</p>
        </div>
      </section>

      {/* body on paper */}
      <section className="mkt-paper">
        <div className="mx-auto max-w-3xl px-5 py-14 lg:py-20">
          <article className="mkt-article">
            {g.sections.map((s) => (
              <section key={s.h} className="[&:not(:first-child)]:mt-10">
                <h2 className="mkt-display text-2xl font-bold sm:text-3xl">{s.h}</h2>
                <div className="mt-4 space-y-4 text-[15px] leading-relaxed" style={{ color: "var(--on-paper-soft)" }}>
                  {s.body.map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                  {s.bullets && (
                    <ul className="mt-3 list-disc space-y-1.5 pl-5">
                      {s.bullets.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            ))}
          </article>

          <div className="mt-10 rounded-2xl border p-6" style={{ borderColor: "var(--paper-line)", background: "#fff" }}>
            <p className="mkt-display text-xl font-bold">Be ready before your phase.</p>
            <p className="mkt-soft mt-1.5 text-sm">Start free — send a compliant invoice to the FTA today.</p>
            <Link href="/signup" className="mkt-btn mkt-btn-dark mt-4">
              Start 14-day free trial <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      {g.faq && (
        <section className="border-t" style={{ borderColor: "var(--ink-line)" }}>
          <div className="mx-auto max-w-3xl px-5 py-14">
            <h2 className="mkt-display text-2xl font-bold sm:text-3xl">FAQ</h2>
            <div className="mt-6">
              <FaqList items={g.faq} />
            </div>
          </div>
        </section>
      )}

      {/* related */}
      {related.length > 0 && (
        <section className="border-t" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
          <div className="mx-auto max-w-6xl px-5 py-14">
            <p className="mkt-eyebrow">Keep reading</p>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              {related.map((r) => (
                <Link key={r.slug} href={`/guides/${r.slug}`} className="mkt-card rounded-2xl border p-5" style={{ borderColor: "var(--ink-line)", background: "var(--ink)" }}>
                  <p className="mkt-display font-bold">{r.h1}</p>
                  <p className="mt-1 text-sm" style={{ color: "var(--on-ink-soft)" }}>{r.description}</p>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}
