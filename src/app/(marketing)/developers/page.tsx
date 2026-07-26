import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Terminal, Bot, KeyRound, Gauge, Webhook, ShieldCheck } from "lucide-react";
import { OrganizationJsonLd, WebSiteJsonLd, SoftwareApplicationJsonLd, HowToJsonLd, BreadcrumbJsonLd } from "@/components/marketing/jsonld";

export const metadata: Metadata = {
  title: "Developers — UAE e-invoicing REST API & MCP server",
  description:
    "Automate UAE e-invoicing with a clean REST API and a native MCP server. Create, validate and transmit PINT AE invoices to the FTA from your own software or an AI agent — OAuth 2.1, scoped API keys, usage metering.",
  alternates: { canonical: "/developers" },
  openGraph: {
    title: "Developers — UAE e-invoicing REST API & MCP server",
    description: "A REST API and native MCP server for UAE PINT AE e-invoicing. Let your software and AI agents invoice directly.",
  },
};

const CAPS = [
  { icon: Terminal, t: "REST API v1", d: "Create, validate, send and fetch invoices with bearer API keys — the same engine that powers the app." },
  { icon: Bot, t: "MCP server", d: "A native Model Context Protocol endpoint so an AI agent can list, validate, create and send invoices directly." },
  { icon: KeyRound, t: "OAuth 2.1", d: "Discovery, dynamic client registration, auth-code + PKCE and rotating refresh tokens for secure agent sign-in." },
  { icon: ShieldCheck, t: "Scoped API keys", d: "arks_live_ keys, shown once, SHA-256 hashed, org-scoped and revocable, with a last-used stamp." },
  { icon: Gauge, t: "Usage metering", d: "Query billable exchanges against your allowance programmatically." },
  { icon: Webhook, t: "Verified webhooks", d: "HMAC-verified gateway and payment callbacks with replay protection keep your state in sync." },
];

const MCP_TOOLS = [
  "list_entities", "list_customers", "list_invoices", "get_invoice",
  "validate_invoice", "create_invoice", "send_invoice", "get_usage",
];

const STEPS = [
  { name: "Create an API key", text: "In Settings → API, create an arks_live_ key. It is shown once and scoped to your organization." },
  { name: "Call the API or connect MCP", text: "POST to /api/v1/invoices with a bearer token, or point your AI client at the MCP endpoint and sign in with OAuth." },
  { name: "Validate & send", text: "Validate against PINT AE, then send — ARKS transmits over Peppol and reports the Tax Data Document to the FTA." },
];

export default function DevelopersPage() {
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd />
      <SoftwareApplicationJsonLd />
      <HowToJsonLd name="Send a UAE e-invoice via the ARKS API" steps={STEPS} />
      <BreadcrumbJsonLd items={[{ name: "Home", path: "/" }, { name: "Developers", path: "/developers" }]} />

      {/* hero */}
      <section className="relative overflow-hidden border-b" style={{ borderColor: "var(--ink-line)" }}>
        <div className="mkt-grid pointer-events-none absolute inset-0 opacity-50" />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 pb-14 pt-16 lg:grid-cols-2 lg:pt-20">
          <div>
            <p className="mkt-eyebrow inline-flex items-center gap-2"><Terminal className="size-3.5" /> For builders</p>
            <h1 className="mkt-display mt-4 text-5xl font-extrabold sm:text-6xl">
              Invoicing your code and your <span style={{ color: "var(--signal)" }}>AI</span> can drive.
            </h1>
            <p className="mt-6 max-w-xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
              A clean REST API and a native MCP server mean your backend — or an autonomous agent — can create,
              validate and transmit a compliant UAE e-invoice to the FTA. The plumbing is done.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/signup" className="mkt-btn mkt-btn-primary">Start building <ArrowRight className="size-4" /></Link>
              <Link href="/features" className="mkt-btn mkt-btn-ghost">See all features</Link>
            </div>
          </div>

          <div className="rounded-2xl border p-5 shadow-2xl" style={{ borderColor: "var(--ink-line)", background: "var(--ink)" }}>
            <div className="mkt-mono flex items-center gap-2 text-[11px]" style={{ color: "var(--on-ink-faint)" }}>
              <Terminal className="size-3.5" /> POST /api/v1/invoices
            </div>
            <pre className="mkt-mono mt-3 overflow-x-auto rounded-lg p-4 text-[12.5px] leading-relaxed" style={{ background: "#070a0e", color: "var(--on-ink-soft)" }}>
{`curl -X POST https://arks.ae/api/v1/invoices \\
  -H "Authorization: Bearer arks_live_…" \\
  -d '{ "customer": "Gulf Materials LLC",
        "trn": "100xxxxxxxxxxxx",
        "lines": [{ "desc": "Consulting",
                    "qty": 1, "unit": 12000,
                    "vat": 5 }],
        "send": true }'
`}
              <span style={{ color: "var(--signal-2)" }}>{`→ 201 { "status": "SENT",
        "delivered": true, "reported": true }`}</span>
            </pre>
          </div>
        </div>
      </section>

      {/* capabilities */}
      <section className="mkt-section">
        <div className="mx-auto max-w-6xl px-5">
          <div className="max-w-2xl">
            <p className="mkt-eyebrow">The developer surface</p>
            <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-5xl">Everything is an API call away.</h2>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CAPS.map((c) => (
              <div key={c.t} className="mkt-card rounded-2xl border p-6" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
                <span className="flex size-11 items-center justify-center rounded-xl" style={{ background: "var(--ink-3)", color: "var(--signal)" }}>
                  <c.icon className="size-5" />
                </span>
                <h3 className="mkt-display mt-5 text-lg font-bold">{c.t}</h3>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--on-ink-soft)" }}>{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* MCP band */}
      <section className="border-y" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 lg:grid-cols-2">
          <div>
            <p className="mkt-eyebrow inline-flex items-center gap-2"><Bot className="size-3.5" /> Model Context Protocol</p>
            <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-[2.75rem]">Connect your AI to invoicing.</h2>
            <p className="mt-4 max-w-xl text-lg" style={{ color: "var(--on-ink-soft)" }}>
              Point any MCP client at the ARKS server, sign in with OAuth, and your assistant can raise and
              transmit compliant invoices on your behalf. These are the tools it gets:
            </p>
          </div>
          <div className="rounded-2xl border p-5" style={{ borderColor: "var(--ink-line)", background: "var(--ink)" }}>
            <div className="mkt-mono flex items-center gap-2 text-[11px]" style={{ color: "var(--on-ink-faint)" }}>
              <Bot className="size-3.5" /> MCP tools
            </div>
            <ul className="mt-3 grid grid-cols-2 gap-2">
              {MCP_TOOLS.map((tool) => (
                <li key={tool} className="mkt-mono rounded-lg border px-3 py-2 text-[12.5px]" style={{ borderColor: "var(--ink-line)", color: "var(--signal-2)" }}>
                  {tool}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* get started */}
      <section className="mkt-section">
        <div className="mx-auto max-w-6xl px-5">
          <div className="max-w-2xl">
            <p className="mkt-eyebrow">Get started</p>
            <h2 className="mkt-display mt-3 text-4xl font-bold sm:text-5xl">Live in three steps.</h2>
          </div>
          <ol className="mt-10 grid gap-5 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.name} className="rounded-2xl border p-6" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
                <span className="mkt-mono text-sm" style={{ color: "var(--signal)" }}>{String(i + 1).padStart(2, "0")}</span>
                <h3 className="mkt-display mt-3 text-lg font-bold">{s.name}</h3>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--on-ink-soft)" }}>{s.text}</p>
              </li>
            ))}
          </ol>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/signup" className="mkt-btn mkt-btn-primary">Get your API key <ArrowRight className="size-4" /></Link>
            <Link href="/uae-e-invoicing" className="mkt-btn mkt-btn-ghost">Read the mandate guide</Link>
          </div>
        </div>
      </section>
    </>
  );
}
