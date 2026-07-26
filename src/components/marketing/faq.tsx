import { Plus } from "lucide-react";

/**
 * FAQ as native <details> — no client JS, keyboard-accessible, and the answer
 * text is in the DOM for crawlers and assistants. Takes already-resolved strings
 * so both bilingual (mapped via faqText) and EN-only callers share it. Pairs with
 * FaqJsonLd.
 */
export function FaqList({ items }: { items: { q: string; a: string }[] }) {
  return (
    <div className="divide-y" style={{ borderColor: "var(--ink-line)" }}>
      {items.map((it) => (
        <details key={it.q} className="mkt-faq group border-b" style={{ borderColor: "var(--ink-line)" }}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5">
            <span className="text-base font-medium" style={{ color: "var(--on-ink)" }}>
              {it.q}
            </span>
            <Plus
              className="size-5 shrink-0 transition-transform group-open:rotate-45"
              style={{ color: "var(--signal)" }}
            />
          </summary>
          <p className="max-w-2xl pb-5 text-sm leading-relaxed" style={{ color: "var(--on-ink-soft)" }}>
            {it.a}
          </p>
        </details>
      ))}
    </div>
  );
}
