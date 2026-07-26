import Link from "next/link";
import { Check } from "lucide-react";
import { SUB_TIERS, type SubTier } from "@/lib/domain/billing";
import type { Locale } from "@/lib/marketing/i18n";

function aed(minor: number) {
  return (minor / 100).toLocaleString("en-AE", { maximumFractionDigits: 0 });
}

const STR = {
  en: {
    cur: "AED", mo: "/mo", vat: "· incl. 5% VAT", cta: "Start 14-day free trial",
    best: (p: number) => `Best value · save ${p}%`,
    save: (p: number) => `save ${p}%`,
    billed: (price: number, months: number) =>
      months === 1 ? "billed every month" : months === 12 ? `AED ${aed(price)} billed once a year` : `AED ${aed(price)} billed every ${months} months`,
    tier: { MONTHLY: "Monthly", SEMIANNUAL: "6 months", ANNUAL: "Annual" } as Record<SubTier, string>,
    everything: [
      "Unlimited invoices & credit notes",
      "PINT AE validation + Peppol transmission",
      "FTA reporting with evidence bundle",
      "Excel & accounting-system import",
      "REST API + MCP for AI agents",
      "Team members & multi-entity",
    ],
  },
  ar: {
    cur: "درهم", mo: "/شهر", vat: "· شامل ضريبة 5%", cta: "ابدأ تجربة 14 يوماً مجاناً",
    best: (p: number) => `الأفضل قيمة · وفّر ${p}%`,
    save: (p: number) => `وفّر ${p}%`,
    billed: (price: number, months: number) =>
      months === 1 ? "يُدفع شهرياً" : months === 12 ? `${aed(price)} درهم سنوياً` : `${aed(price)} درهم كل ${months} أشهر`,
    tier: { MONTHLY: "شهري", SEMIANNUAL: "6 أشهر", ANNUAL: "سنوي" } as Record<SubTier, string>,
    everything: [
      "فواتير وإشعارات دائنة غير محدودة",
      "تحقق PINT AE + إرسال عبر Peppol",
      "إبلاغ الهيئة مع حزمة أدلة",
      "استيراد من Excel وأنظمة المحاسبة",
      "واجهة REST + خادم MCP",
      "أعضاء فريق ومنشآت متعددة",
    ],
  },
};

/**
 * The pricing table. Annual is the anchor (largest saving, visually lifted);
 * every tier includes everything — the only variable is commitment. Locale-aware
 * so the Arabic mirror reuses it (RTL handled by the page's dir).
 */
export function PricingCards({ compact = false, locale = "en" }: { compact?: boolean; locale?: Locale }) {
  const s = STR[locale];
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
                className="mkt-mono absolute -top-3 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider"
                style={{ background: "var(--signal)", color: "var(--signal-ink)", insetInlineStart: "1.5rem" }}
              >
                {s.best(t.savingsPct)}
              </span>
            )}
            <div className="flex items-baseline justify-between">
              <h3 className="mkt-display text-lg font-bold">{s.tier[t.tier]}</h3>
              {!lifted && t.savingsPct > 0 && (
                <span className="mkt-mono text-[11px]" style={{ color: "var(--signal-2)" }}>{s.save(t.savingsPct)}</span>
              )}
            </div>

            <div className="mt-4 flex items-end gap-1.5">
              <span className="mkt-mono text-sm" style={{ color: "var(--on-ink-soft)" }}>{s.cur}</span>
              <span className="mkt-display text-5xl font-extrabold tabular-nums leading-none">{aed(t.perMonthMinor)}</span>
              <span className="mb-1 text-sm" style={{ color: "var(--on-ink-soft)" }}>{s.mo}</span>
            </div>
            <p className="mkt-mono mt-2 text-[11px]" style={{ color: "var(--on-ink-faint)" }}>
              {s.billed(t.priceMinor, t.months)} {s.vat}
            </p>

            <Link
              href={`/signup?tier=${t.tier}`}
              className={`mkt-btn mt-5 justify-center ${lifted ? "mkt-btn-primary" : "mkt-btn-ghost"}`}
            >
              {s.cta}
            </Link>

            {!compact && (
              <ul className="mt-6 space-y-2.5 border-t pt-6" style={{ borderColor: "var(--ink-line)" }}>
                {s.everything.map((f) => (
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
