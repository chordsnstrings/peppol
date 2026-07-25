"use client";

import * as React from "react";
import Link from "next/link";
import { LogoMark } from "@/components/shell/logo";

const LINKS = [
  { href: "/#how", label: "How it works" },
  { href: "/#features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/uae-e-invoicing", label: "The mandate" },
];

export function MarketingNav() {
  const [authed, setAuthed] = React.useState<boolean | null>(null);
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => setAuthed(r.ok))
      .catch(() => setAuthed(false));
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className="sticky top-0 z-50 transition-colors"
      style={{
        background: scrolled ? "color-mix(in srgb, var(--ink) 82%, transparent)" : "transparent",
        backdropFilter: scrolled ? "blur(12px)" : "none",
        borderBottom: scrolled ? "1px solid var(--ink-line)" : "1px solid transparent",
      }}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
        <Link href="/" className="flex items-center gap-2.5" aria-label="ARKS home">
          <LogoMark size={30} />
          <span className="mkt-display text-[17px] font-bold tracking-tight">ARKS</span>
        </Link>

        <nav className="ml-4 hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="rounded-lg px-3 py-2 text-sm transition-colors"
              style={{ color: "var(--on-ink-soft)" }}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {authed ? (
            <Link href="/dashboard" className="mkt-btn mkt-btn-primary">
              Go to dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="mkt-btn mkt-btn-ghost hidden sm:inline-flex">
                Sign in
              </Link>
              <Link href="/signup" className="mkt-btn mkt-btn-primary">
                Start free
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
