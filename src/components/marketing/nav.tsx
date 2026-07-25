"use client";

import * as React from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
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
  const [menuOpen, setMenuOpen] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => setAuthed(r.ok))
      .catch(() => setAuthed(false));
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const opaque = scrolled || menuOpen;

  return (
    <header
      className="sticky top-0 z-50 transition-colors"
      style={{
        background: opaque ? "color-mix(in srgb, var(--ink) 82%, transparent)" : "transparent",
        backdropFilter: opaque ? "blur(12px)" : "none",
        borderBottom: opaque ? "1px solid var(--ink-line)" : "1px solid transparent",
      }}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
        <Link href="/" className="flex items-center gap-2.5" aria-label="ARKS home" onClick={() => setMenuOpen(false)}>
          <LogoMark size={30} />
          <span className="mkt-display text-[17px] font-bold tracking-tight">ARKS</span>
        </Link>

        <nav className="ml-4 hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="mkt-navlink rounded-lg px-3 py-2 text-sm">
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
              {/* Wrapper carries the responsive visibility: .mkt-btn forces
                  display:inline-flex, which would otherwise beat Tailwind's `hidden`. */}
              <span className="hidden sm:inline-flex">
                <Link href="/login" className="mkt-btn mkt-btn-ghost">
                  Sign in
                </Link>
              </span>
              <Link href="/signup" className="mkt-btn mkt-btn-primary">
                Start free
              </Link>
            </>
          )}

          {/* mobile menu toggle (wrapper hides it at >=md for the same reason) */}
          <span className="inline-flex md:hidden">
            <button
              type="button"
              className="mkt-btn mkt-btn-ghost"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              aria-controls="mkt-mobile-menu"
              onClick={() => setMenuOpen((v) => !v)}
              style={{ padding: "0.55rem" }}
            >
              {menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </span>
        </div>
      </div>

      {/* mobile disclosure panel */}
      {menuOpen && (
        <nav
          id="mkt-mobile-menu"
          className="md:hidden"
          style={{ borderTop: "1px solid var(--ink-line)", background: "color-mix(in srgb, var(--ink) 96%, transparent)" }}
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-3">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setMenuOpen(false)}
                className="mkt-navlink rounded-lg px-3 py-2.5 text-[15px]"
              >
                {l.label}
              </Link>
            ))}
            {!authed && (
              <Link
                href="/login"
                onClick={() => setMenuOpen(false)}
                className="mkt-navlink rounded-lg px-3 py-2.5 text-[15px] sm:hidden"
              >
                Sign in
              </Link>
            )}
          </div>
        </nav>
      )}
    </header>
  );
}
