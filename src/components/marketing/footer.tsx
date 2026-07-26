import Link from "next/link";
import { LogoMark } from "@/components/shell/logo";
import type { Locale } from "@/lib/marketing/i18n";

type Col = { title: string; links: { href: string; label: string }[] };

const EN_COLS: Col[] = [
  {
    title: "Product",
    links: [
      { href: "/features", label: "Features" },
      { href: "/pricing", label: "Pricing" },
      { href: "/connect", label: "Integrations" },
      { href: "/developers", label: "Developers" },
      { href: "/login", label: "Sign in" },
    ],
  },
  {
    title: "Compliance",
    links: [
      { href: "/uae-e-invoicing", label: "The UAE mandate" },
      { href: "/guides/ministerial-decision-64", label: "Ministerial Decision 64" },
      { href: "/guides/pint-ae-format", label: "PINT AE format" },
      { href: "/guides/peppol-5-corner-model", label: "Peppol 5-corner model" },
    ],
  },
  {
    title: "Guides",
    links: [
      { href: "/guides", label: "All guides" },
      { href: "/guides/readiness-checklist", label: "Readiness checklist" },
      { href: "/guides/tax-data-document", label: "Tax Data Document" },
      { href: "/guides/glossary", label: "Glossary" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/developers", label: "REST API" },
      { href: "/developers", label: "MCP for AI" },
      { href: "/.well-known/oauth-authorization-server", label: "OAuth" },
    ],
  },
];

const AR_COLS: Col[] = [
  {
    title: "المنتج",
    links: [
      { href: "/ar/features", label: "المزايا" },
      { href: "/ar/pricing", label: "الأسعار" },
      { href: "/ar/uae-e-invoicing", label: "دليل الامتثال" },
      { href: "/login", label: "تسجيل الدخول" },
    ],
  },
  {
    title: "بلغتك",
    links: [
      { href: "/", label: "English site" },
      { href: "/guides", label: "Guides (EN)" },
      { href: "/developers", label: "API & MCP (EN)" },
    ],
  },
];

const BRAND = {
  en: {
    blurb: "UAE e-invoicing, engineered. Validate and transmit PINT AE invoices to the FTA over Peppol — with delivery and reporting proven.",
    built: "Built for the UAE FTA e-invoicing mandate.",
    rights: "All rights reserved.",
    vat: "Prices in AED, VAT-inclusive.",
  },
  ar: {
    blurb: "الفوترة الإلكترونية في الإمارات، بإتقان. تحقّق من فواتير PINT AE وأرسلها إلى الهيئة عبر Peppol — مع إثبات التسليم والإبلاغ.",
    built: "مبنيّ لأجل تفويض الفوترة الإلكترونية للهيئة الاتحادية للضرائب.",
    rights: "جميع الحقوق محفوظة.",
    vat: "الأسعار بالدرهم، شاملة ضريبة القيمة المضافة.",
  },
};

export function MarketingFooter({ locale = "en" }: { locale?: Locale }) {
  const cols = locale === "ar" ? AR_COLS : EN_COLS;
  const b = BRAND[locale];
  const gridCols = locale === "ar" ? "md:grid-cols-[1.6fr_1fr_1fr]" : "md:grid-cols-[1.4fr_repeat(4,1fr)]";
  return (
    <footer style={{ background: "var(--ink)", borderTop: "1px solid var(--ink-line)" }}>
      <div className={`mx-auto grid max-w-6xl gap-10 px-5 py-14 ${gridCols}`}>
        <div>
          <div className="flex items-center gap-2.5">
            <LogoMark size={30} />
            <span className="mkt-display text-[17px] font-bold">ARKS</span>
          </div>
          <p className="mt-3 max-w-xs text-sm" style={{ color: "var(--on-ink-soft)" }}>{b.blurb}</p>
          <p className="mkt-mono mt-4 text-[11px]" style={{ color: "var(--on-ink-faint)" }}>{b.built}</p>
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <p className="mkt-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--on-ink-faint)" }}>{c.title}</p>
            <ul className="mt-3 space-y-2">
              {c.links.map((l) => (
                <li key={l.label}>
                  <Link href={l.href} className="text-sm transition-colors" style={{ color: "var(--on-ink-soft)" }}>{l.label}</Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t px-5 py-5" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <p className="mkt-mono text-[11px]" style={{ color: "var(--on-ink-faint)" }}>© {new Date().getUTCFullYear()} ARKS. {b.rights}</p>
          <p className="mkt-mono text-[11px]" style={{ color: "var(--on-ink-faint)" }}>{b.vat}</p>
        </div>
      </div>
    </footer>
  );
}
