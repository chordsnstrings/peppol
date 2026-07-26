"use client";

import * as React from "react";
import Link from "next/link";
import { Menu, X, Languages } from "lucide-react";
import { LogoMark } from "@/components/shell/logo";
import type { Locale } from "@/lib/marketing/i18n";

// Links present in each locale. AR only lists pages that have an Arabic mirror.
const EN_LINKS = [
  { href: "/features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/connect", label: "Integrations" },
  { href: "/developers", label: "Developers" },
  { href: "/guides", label: "Guides" },
];
const AR_LINKS = [
  { href: "/ar/features", label: "المزايا" },
  { href: "/ar/pricing", label: "الأسعار" },
  { href: "/ar/uae-e-invoicing", label: "الدليل" },
];

const T = {
  en: { signin: "Sign in", start: "Start free", dash: "Go to dashboard", other: "العربية", menu: "Menu" },
  ar: { signin: "تسجيل الدخول", start: "ابدأ مجاناً", dash: "لوحة التحكم", other: "English", menu: "القائمة" },
};

// Pages that exist in both locales — the language switch maps 1:1 for these.
const MIRRORED = new Set(["/", "/features", "/pricing", "/uae-e-invoicing"]);

function counterpart(pathname: string, locale: Locale): string {
  if (locale === "ar") {
    const en = pathname.replace(/^\/ar(?=\/|$)/, "");
    return en === "" ? "/" : en;
  }
  if (MIRRORED.has(pathname)) return pathname === "/" ? "/ar" : `/ar${pathname}`;
  return "/ar";
}

export function MarketingNav({ locale = "en" }: { locale?: Locale }) {
  const [authed, setAuthed] = React.useState<boolean | null>(null);
  const [scrolled, setScrolled] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [langHref, setLangHref] = React.useState(locale === "ar" ? "/" : "/ar");

  React.useEffect(() => {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((r) => setAuthed(r.ok))
      .catch(() => setAuthed(false));
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    setLangHref(counterpart(window.location.pathname, locale));
    return () => window.removeEventListener("scroll", onScroll);
  }, [locale]);

  const links = locale === "ar" ? AR_LINKS : EN_LINKS;
  const tt = T[locale];
  const homeHref = locale === "ar" ? "/ar" : "/";
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
        <Link href={homeHref} className="flex items-center gap-2.5" aria-label="ARKS" onClick={() => setMenuOpen(false)}>
          <LogoMark size={30} />
          <span className="mkt-display text-[17px] font-bold tracking-tight">ARKS</span>
        </Link>

        <nav className="ml-4 hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="mkt-navlink rounded-lg px-3 py-2 text-sm">
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link href={langHref} className="mkt-navlink hidden items-center gap-1.5 rounded-lg px-2.5 py-2 text-sm sm:inline-flex" hrefLang={locale === "ar" ? "en" : "ar"}>
            <Languages className="size-4" /> {tt.other}
          </Link>

          {authed ? (
            <Link href="/dashboard" className="mkt-btn mkt-btn-primary">{tt.dash}</Link>
          ) : (
            <>
              <span className="hidden sm:inline-flex">
                <Link href="/login" className="mkt-btn mkt-btn-ghost">{tt.signin}</Link>
              </span>
              <Link href={locale === "ar" ? "/signup" : "/signup"} className="mkt-btn mkt-btn-primary">{tt.start}</Link>
            </>
          )}

          <span className="inline-flex md:hidden">
            <button
              type="button"
              className="mkt-btn mkt-btn-ghost"
              aria-label={tt.menu}
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

      {menuOpen && (
        <nav
          id="mkt-mobile-menu"
          className="md:hidden"
          style={{ borderTop: "1px solid var(--ink-line)", background: "color-mix(in srgb, var(--ink) 96%, transparent)" }}
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-1 px-5 py-3">
            {links.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setMenuOpen(false)} className="mkt-navlink rounded-lg px-3 py-2.5 text-[15px]">
                {l.label}
              </Link>
            ))}
            <Link href={langHref} onClick={() => setMenuOpen(false)} className="mkt-navlink flex items-center gap-1.5 rounded-lg px-3 py-2.5 text-[15px]">
              <Languages className="size-4" /> {tt.other}
            </Link>
            {!authed && (
              <Link href="/login" onClick={() => setMenuOpen(false)} className="mkt-navlink rounded-lg px-3 py-2.5 text-[15px] sm:hidden">
                {tt.signin}
              </Link>
            )}
          </div>
        </nav>
      )}
    </header>
  );
}
