"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Check, ShieldCheck, Radio, FileCheck2 } from "lucide-react";
import type { Locale } from "@/lib/marketing/i18n";

const STR = {
  en: {
    steps: [
      { label: "Validated · PINT AE UBL", detail: "0 errors" },
      { label: "Transmitted · Peppol network", detail: "0235:100…" },
      { label: "Reported to the FTA", detail: "TDD accepted" },
    ],
    win: "arks · transmit",
    ready: "READY", sending: "SENDING", completed: "COMPLETED",
    taxInvoice: "TAX INVOICE", to: "to Gulf Materials Trading LLC", inclVat: "incl. VAT 5%",
    evidence: "Evidence bundle: UBL · TDD · timeline", delivered: "DELIVERED", reported: "REPORTED",
  },
  ar: {
    steps: [
      { label: "تم التحقق · PINT AE", detail: "لا أخطاء" },
      { label: "تم الإرسال · شبكة Peppol", detail: "0235:100…" },
      { label: "تم الإبلاغ للهيئة", detail: "قُبل TDD" },
    ],
    win: "arks · إرسال",
    ready: "جاهز", sending: "جارٍ الإرسال", completed: "مكتمل",
    taxInvoice: "فاتورة ضريبية", to: "إلى شركة الخليج للمواد ذ.م.م", inclVat: "شامل ضريبة 5%",
    evidence: "حزمة الأدلة: UBL · TDD · السجل", delivered: "تم التسليم", reported: "تم الإبلاغ",
  },
};

const STEP_ICONS = [FileCheck2, Radio, ShieldCheck];

/**
 * The proof: an invoice being validated and transmitted to the FTA, with delivery
 * + reporting ticking green. Loops (unless reduced motion). Locale-aware.
 */
export function HeroProof({ locale = "en" }: { locale?: Locale }) {
  const reduce = useReducedMotion();
  const [active, setActive] = React.useState(0);
  const s = STR[locale];

  React.useEffect(() => {
    if (reduce) {
      setActive(s.steps.length);
      return;
    }
    let alive = true;
    const run = async () => {
      while (alive) {
        for (let i = 0; i < s.steps.length; i++) {
          if (!alive) return;
          setActive(i + 1);
          await new Promise((r) => setTimeout(r, 900));
        }
        await new Promise((r) => setTimeout(r, 1800));
        if (!alive) return;
        setActive(0);
        await new Promise((r) => setTimeout(r, 500));
      }
    };
    run();
    return () => {
      alive = false;
    };
  }, [reduce, s.steps.length]);

  return (
    <div className="relative">
      <div className="mkt-signal-glow pointer-events-none absolute -inset-10 -z-10 opacity-70" />
      <div className="overflow-hidden rounded-2xl border shadow-2xl" style={{ background: "var(--ink-2)", borderColor: "var(--ink-line)" }}>
        {/* window bar */}
        <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "var(--ink-line)" }}>
          <span className="size-2.5 rounded-full" style={{ background: "#ff5f57" }} />
          <span className="size-2.5 rounded-full" style={{ background: "#febc2e" }} />
          <span className="size-2.5 rounded-full" style={{ background: "#28c840" }} />
          <span className="mkt-mono ms-2 text-[11px]" style={{ color: "var(--on-ink-faint)" }} dir="ltr">{s.win}</span>
          <span className="mkt-mono ms-auto rounded-md px-2 py-0.5 text-[10px]" style={{ background: "var(--signal-ink)", color: "var(--signal-2)" }}>
            {active >= 3 ? s.completed : active === 0 ? s.ready : s.sending}
          </span>
        </div>

        {/* invoice summary */}
        <div className="px-5 pt-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="mkt-mono text-[11px]" style={{ color: "var(--on-ink-faint)" }}>{s.taxInvoice}</p>
              <p className="mkt-display mt-0.5 text-lg font-bold" dir="ltr">INV-2026-00042</p>
              <p className="mt-1 text-sm" style={{ color: "var(--on-ink-soft)" }}>{s.to}</p>
            </div>
            <div className="text-end">
              <p className="mkt-mono text-2xl font-bold tabular-nums" dir="ltr">AED 12,600.00</p>
              <p className="mkt-mono mt-0.5 text-[11px]" style={{ color: "var(--on-ink-faint)" }}>{s.inclVat}</p>
            </div>
          </div>
        </div>

        {/* steps */}
        <div className="space-y-1.5 px-5 py-5">
          {s.steps.map((step, i) => {
            const Icon = STEP_ICONS[i];
            const done = active > i + 1;
            const current = active === i + 1;
            const lit = done || current;
            return (
              <div
                key={step.label}
                className="flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors"
                style={{
                  borderColor: lit ? "color-mix(in srgb, var(--signal) 45%, transparent)" : "var(--ink-line)",
                  background: lit ? "color-mix(in srgb, var(--signal) 8%, transparent)" : "transparent",
                }}
              >
                <div
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors"
                  style={{
                    background: done ? "var(--signal)" : lit ? "var(--signal-ink)" : "var(--ink-3)",
                    color: done ? "var(--signal-ink)" : lit ? "var(--signal-2)" : "var(--on-ink-faint)",
                  }}
                >
                  {done ? <Check className="size-4" /> : <Icon className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium" style={{ color: lit ? "var(--on-ink)" : "var(--on-ink-soft)" }}>{step.label}</p>
                </div>
                {lit && (
                  <motion.span
                    initial={reduce ? false : { opacity: 0, y: 3 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mkt-mono text-[11px]"
                    style={{ color: "var(--signal-2)" }}
                  >
                    {step.detail}
                  </motion.span>
                )}
              </div>
            );
          })}
        </div>

        {/* footer proof */}
        <div className="flex items-center justify-between border-t px-5 py-3" style={{ borderColor: "var(--ink-line)", background: "var(--ink)" }}>
          <span className="mkt-mono text-[11px]" style={{ color: "var(--on-ink-faint)" }}>{s.evidence}</span>
          <span className="flex items-center gap-3">
            <StatusTick label={s.delivered} on={active >= 3} />
            <StatusTick label={s.reported} on={active >= 3} />
          </span>
        </div>
      </div>
    </div>
  );
}

function StatusTick({ label, on }: { label: string; on: boolean }) {
  return (
    <span className="mkt-mono flex items-center gap-1 text-[11px]" style={{ color: on ? "var(--signal-2)" : "var(--on-ink-faint)" }}>
      <span className="flex size-4 items-center justify-center rounded-full transition-colors" style={{ background: on ? "var(--signal)" : "var(--ink-3)", color: "var(--signal-ink)" }}>
        {on && <Check className="size-3" />}
      </span>
      {label}
    </span>
  );
}
