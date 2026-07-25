"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Check, ShieldCheck, Loader2 } from "lucide-react";
import { SUB_BY_TIER, isSubTier, type SubTier } from "@/lib/domain/billing";

const PROOF = [
  "14-day free trial — full FTA transmission",
  "No credit card to start",
  "Unlimited invoicing on every plan",
  "Cancel anytime, export your data",
];

function tierSummary(tier: SubTier) {
  const p = SUB_BY_TIER[tier];
  const total = (p.priceMinor / 100).toLocaleString("en-AE", { maximumFractionDigits: 0 });
  const perMo = (p.perMonthMinor / 100).toLocaleString("en-AE", { maximumFractionDigits: 0 });
  return { name: p.name, total, perMo, months: p.months, savingsPct: p.savingsPct };
}

export default function SignupPage() {
  const [tier, setTier] = React.useState<SubTier | null>(null);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [orgName, setOrgName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tier");
    if (t && isSubTier(t)) setTier(t);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name, email, password, orgName, locale: "en" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? "Couldn't create your account.");
        setLoading(false);
        return;
      }
      // Trial is live. If they picked a paid tier, take them straight to billing
      // to subscribe in one step; otherwise into the product.
      window.location.href = tier ? `/settings/billing?tier=${tier}` : "/dashboard?welcome=1";
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  };

  const summary = tier ? tierSummary(tier) : null;

  return (
    <section className="relative overflow-hidden">
      <div className="mkt-grid pointer-events-none absolute inset-0 opacity-40" />
      <div className="relative mx-auto grid max-w-5xl gap-12 px-5 py-14 lg:grid-cols-[1fr_0.9fr] lg:py-20">
        {/* form */}
        <div className="w-full max-w-md">
          <h1 className="mkt-display text-4xl font-extrabold">Start your free trial</h1>
          <p className="mt-2 text-base" style={{ color: "var(--on-ink-soft)" }}>
            14 days of full FTA transmission. No card required.
          </p>

          <form onSubmit={submit} className="mt-8 space-y-4">
            <SignupField label="Your name" value={name} onChange={setName} placeholder="Layla Ahmed" autoFocus required />
            <SignupField label="Work email" type="email" value={email} onChange={setEmail} placeholder="you@company.ae" required />
            <SignupField label="Company name" value={orgName} onChange={setOrgName} placeholder="Company Trading LLC" required />
            <SignupField label="Password" type="password" value={password} onChange={setPassword} placeholder="At least 8 characters" minLength={8} required />

            {error && (
              <p className="rounded-lg px-3 py-2 text-sm" style={{ background: "color-mix(in srgb, #ff5f57 14%, transparent)", color: "#ffb4b0" }}>
                {error}
              </p>
            )}

            <button type="submit" disabled={loading} className="mkt-btn mkt-btn-primary w-full justify-center">
              {loading ? <><Loader2 className="size-4 animate-spin" /> Creating your workspace…</> : <>Create workspace <ArrowRight className="size-4" /></>}
            </button>

            <p className="mkt-mono text-center text-[11px]" style={{ color: "var(--on-ink-faint)" }}>
              By continuing you agree to our terms. Prices are VAT-inclusive.
            </p>
          </form>

          <p className="mt-6 text-sm" style={{ color: "var(--on-ink-soft)" }}>
            Already have an account?{" "}
            <Link href="/login" className="font-medium" style={{ color: "var(--signal-2)" }}>
              Sign in
            </Link>
          </p>
        </div>

        {/* value / selected plan panel */}
        <aside className="lg:pt-2">
          <div className="rounded-2xl border p-6" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
            {summary ? (
              <>
                <p className="mkt-eyebrow">Selected plan</p>
                <div className="mt-3 flex items-end justify-between">
                  <span className="mkt-display text-2xl font-bold">{summary.name}</span>
                  {summary.savingsPct > 0 && (
                    <span className="mkt-mono text-[11px]" style={{ color: "var(--signal-2)" }}>save {summary.savingsPct}%</span>
                  )}
                </div>
                <p className="mt-2 text-sm" style={{ color: "var(--on-ink-soft)" }}>
                  <span className="mkt-mono text-lg font-bold" style={{ color: "var(--on-ink)" }}>AED {summary.perMo}</span>/mo ·
                  {" "}AED {summary.total} billed {summary.months === 1 ? "monthly" : `every ${summary.months} months`}
                </p>
                <p className="mt-3 rounded-lg px-3 py-2 text-[12px]" style={{ background: "var(--ink-3)", color: "var(--on-ink-soft)" }}>
                  You&rsquo;ll start on the free trial now — subscribe whenever you&rsquo;re ready, no charge today.
                </p>
              </>
            ) : (
              <>
                <p className="mkt-eyebrow">Why ARKS</p>
                <p className="mkt-display mt-3 text-2xl font-bold">Compliance, handled.</p>
              </>
            )}

            <ul className="mt-6 space-y-3 border-t pt-6" style={{ borderColor: "var(--ink-line)" }}>
              {PROOF.map((p) => (
                <li key={p} className="flex items-start gap-2.5 text-sm" style={{ color: "var(--on-ink-soft)" }}>
                  <Check className="mt-0.5 size-4 shrink-0" style={{ color: "var(--signal)" }} />
                  {p}
                </li>
              ))}
            </ul>

            <div className="mkt-mono mt-6 flex items-center gap-2 border-t pt-5 text-[11px]" style={{ borderColor: "var(--ink-line)", color: "var(--on-ink-faint)" }}>
              <ShieldCheck className="size-3.5" style={{ color: "var(--signal)" }} /> Isolated tenants · encrypted · audit-logged
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

function SignupField({
  label, value, onChange, type = "text", placeholder, autoFocus, required, minLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
  required?: boolean;
  minLength?: number;
}) {
  return (
    <label className="block">
      <span className="mkt-mono mb-1.5 block text-[11px] uppercase tracking-wider" style={{ color: "var(--on-ink-faint)" }}>
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        required={required}
        minLength={minLength}
        className="w-full rounded-lg border px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-[var(--signal)]"
        style={{ background: "var(--ink)", borderColor: "var(--ink-line)", color: "var(--on-ink)" }}
      />
    </label>
  );
}
