import { Plus } from "lucide-react";
import type { Faq } from "@/lib/marketing/content";
import type { Locale } from "@/lib/marketing/i18n";

/**
 * FAQ as native <details> — no client JS, keyboard-accessible, and the answer
 * text is in the DOM for crawlers and assistants. Pairs with FaqJsonLd.
 */
export function FaqList({ items, locale = "en" }: { items: Faq[]; locale?: Locale }) {
  return (
    <div className="divide-y" style={{ borderColor: "var(--ink-line)" }}>
      {items.map((it) => (
        <details key={it.q[locale]} className="mkt-faq group border-b" style={{ borderColor: "var(--ink-line)" }}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5">
            <span className="text-base font-medium" style={{ color: "var(--on-ink)" }}>
              {it.q[locale]}
            </span>
            <Plus
              className="size-5 shrink-0 transition-transform group-open:rotate-45"
              style={{ color: "var(--signal)" }}
            />
          </summary>
          <p className="max-w-2xl pb-5 text-sm leading-relaxed" style={{ color: "var(--on-ink-soft)" }}>
            {it.a[locale]}
          </p>
        </details>
      ))}
    </div>
  );
}
