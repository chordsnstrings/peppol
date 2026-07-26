import {
  FileText, FileCheck2, Calculator, Files, Hash, Radio, ShieldCheck, FileArchive, Network,
  SearchCheck, Wallet, CreditCard, Repeat, BellRing, Table2, Boxes, MessageCircle, Terminal,
  Bot, KeyRound, Gauge, Building2, Lock, Download, ClipboardCheck, type LucideIcon,
} from "lucide-react";
import type { FeatureGroup } from "@/lib/marketing/content";
import type { Locale } from "@/lib/marketing/i18n";

const ICONS: Record<string, LucideIcon> = {
  FileText, FileCheck2, Calculator, Files, Hash, Radio, ShieldCheck, FileArchive, Network,
  SearchCheck, Wallet, CreditCard, Repeat, BellRing, Table2, Boxes, MessageCircle, Terminal,
  Bot, KeyRound, Gauge, Building2, Lock, Download, ClipboardCheck,
};

/**
 * The full, grouped feature catalog. Server component (no client JS), locale-aware
 * so the Arabic mirror reuses it. Each group is a section with an eyebrow + title.
 */
export function FeatureGrid({ groups, locale = "en" }: { groups: FeatureGroup[]; locale?: Locale }) {
  return (
    <div className="space-y-16">
      {groups.map((g) => (
        <section key={g.id} id={g.id} className="scroll-mt-24">
          <div className="max-w-2xl">
            <p className="mkt-eyebrow">{g.eyebrow[locale]}</p>
            <h2 className="mkt-display mt-3 text-3xl font-bold sm:text-4xl">{g.title[locale]}</h2>
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {g.features.map((f) => {
              const Icon = ICONS[f.icon] ?? FileText;
              return (
                <div key={f.title.en} className="mkt-card rounded-2xl border p-6" style={{ borderColor: "var(--ink-line)", background: "var(--ink-2)" }}>
                  <span className="flex size-11 items-center justify-center rounded-xl" style={{ background: "var(--ink-3)", color: "var(--signal)" }}>
                    <Icon className="size-5" />
                  </span>
                  <h3 className="mkt-display mt-5 text-lg font-bold">{f.title[locale]}</h3>
                  <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--on-ink-soft)" }}>
                    {f.desc[locale]}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
