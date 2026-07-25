import Link from "next/link";
import { Check } from "lucide-react";
import { SUB_TIERS } from "@/lib/domain/billing";

function aed(minor: number) {
  return (minor / 100).toLocaleString("en-AE", { maximumFractionDigits: 0 });
}

/** Billing cadence line, derived from the tier so it can't drift from the price. */
function billedLine(priceMinor: number, months: number) {
  if (months === 1) return "billed every month";
  if (months === 12) return `AED ${aed(priceMinor)} billed once a year`;
  return `AED ${aed(priceMinor)} billed every ${months} months`;
}

const EVERYTHING = [
  "Unlimited invoices & credit notes",
  "PINT AE validation + Peppol transmission",
  "FTA reporting with evidence bundle",
  "Excel & accounting-system import",
  "REST API + MCP for AI agents",
  "Team members & multi-entity",
];

/**
 * The pricing table. Annual is the anchor (largest saving, visually lifted);
 * every tier includes everything — the only variable is commitment. CTAs go
 * straight to the trial-first signup funnel with the tier remembered.
 */
export function PricingCards({ compact = false }: { compact?: boolean }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {SUB_TIERS.map((t) => {
        const lifted = t.highlight;
        return (
          <div
            key={t.tier}
            className="relative flex flex-col rounded-2xl border p-6"
            style={{
              background: lifted ? "var(--ink-2)" : "var(--ink)",
              borderColor: lifted ? "color-mix(in srgb, var(--signal) 55%, transparent)" : "var(--ink-line)",
              boxShadow: lifted ? "0 24px 60px -28px color-mix(in srgb, var(--signal) 60%, transparent)" : "none",
            }}
          >
            {lifted && (
              <span
                className="mkt-mono absolute -top-3 left-6 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider"
                style={{ background: "var(--signal)", color: "var(--signal-ink)" }}
              >
                Best value · save {t.savingsPct}%
              </span>
            )}
            <div className="flex items-baseline justify-between">
              <h3 className="mkt-display text-lg font-bold">{t.name}</h3>
              {!lifted && t.savingsPct > 0 && (
                <span className="mkt-mono text-[11px]" style={{ color: "var(--signal-2)" }}>
                  save {t.savingsPct}%
                </span>
              )}
            </div>

            <div className="mt-4 flex items-end gap-1.5">
              <span className="mkt-mono text-sm" style={{ color: "var(--on-ink-soft)" }}>
                AED
              </span>
              <span className="mkt-display text-5xl font-extrabold tabular-nums leading-none">
                {aed(t.perMonthMinor)}
              </span>
              <span className="mb-1 text-sm" style={{ color: "var(--on-ink-soft)" }}>
                /mo
              </span>
            </div>
            <p className="mkt-mono mt-2 text-[11px]" style={{ color: "var(--on-ink-faint)" }}>
              {billedLine(t.priceMinor, t.months)} · incl. 5% VAT
            </p>

            <Link
              href={`/signup?tier=${t.tier}`}
              className={`mkt-btn mt-5 justify-center ${lifted ? "mkt-btn-primary" : "mkt-btn-ghost"}`}
            >
              Start 14-day free trial
            </Link>

            {!compact && (
              <ul className="mt-6 space-y-2.5 border-t pt-6" style={{ borderColor: "var(--ink-line)" }}>
                {EVERYTHING.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm" style={{ color: "var(--on-ink-soft)" }}>
                    <Check className="mt-0.5 size-4 shrink-0" style={{ color: "var(--signal)" }} />
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
