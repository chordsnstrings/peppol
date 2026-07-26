import Link from "next/link";
import { LogoMark } from "@/components/shell/logo";

const COLS: { title: string; links: { href: string; label: string }[] }[] = [
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

export function MarketingFooter() {
  return (
    <footer style={{ background: "var(--ink)", borderTop: "1px solid var(--ink-line)" }}>
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div>
          <div className="flex items-center gap-2.5">
            <LogoMark size={30} />
            <span className="mkt-display text-[17px] font-bold">ARKS</span>
          </div>
          <p className="mt-3 max-w-xs text-sm" style={{ color: "var(--on-ink-soft)" }}>
            UAE e-invoicing, engineered. Validate and transmit PINT AE invoices to the FTA over Peppol — with
            delivery and reporting proven.
          </p>
          <p className="mkt-mono mt-4 text-[11px]" style={{ color: "var(--on-ink-faint)" }}>
            Built for the UAE FTA e-invoicing mandate.
          </p>
        </div>
        {COLS.map((c) => (
          <div key={c.title}>
            <p className="mkt-mono text-[11px] uppercase tracking-wider" style={{ color: "var(--on-ink-faint)" }}>
              {c.title}
            </p>
            <ul className="mt-3 space-y-2">
              {c.links.map((l) => (
                <li key={l.label}>
                  <Link href={l.href} className="text-sm transition-colors" style={{ color: "var(--on-ink-soft)" }}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t px-5 py-5" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <p className="mkt-mono text-[11px]" style={{ color: "var(--on-ink-faint)" }}>
            © {new Date().getUTCFullYear()} ARKS. All rights reserved.
          </p>
          <p className="mkt-mono text-[11px]" style={{ color: "var(--on-ink-faint)" }}>
            Prices in AED, VAT-inclusive.
          </p>
        </div>
      </div>
    </footer>
  );
}
