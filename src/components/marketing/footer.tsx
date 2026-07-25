import Link from "next/link";
import { LogoMark } from "@/components/shell/logo";

const COLS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/#features", label: "Features" },
      { href: "/pricing", label: "Pricing" },
      { href: "/#how", label: "How it works" },
      { href: "/login", label: "Sign in" },
    ],
  },
  {
    title: "Compliance",
    links: [
      { href: "/uae-e-invoicing", label: "The UAE mandate" },
      { href: "/uae-e-invoicing#pint-ae", label: "PINT AE format" },
      { href: "/uae-e-invoicing#timeline", label: "Rollout timeline" },
      { href: "/uae-e-invoicing#faq", label: "FTA FAQ" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/#api", label: "REST API" },
      { href: "/#api", label: "MCP for AI" },
      { href: "/.well-known/oauth-authorization-server", label: "OAuth" },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer style={{ background: "var(--ink)", borderTop: "1px solid var(--ink-line)" }}>
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
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
