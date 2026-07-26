/**
 * Minimal, framework-free i18n for the marketing surface. English is served at
 * the root (`/x`); Arabic is prefixed (`/ar/x`) and rendered RTL. Kept tiny and
 * static so marketing pages stay fully SSG. Only the core conversion + compliance
 * pages are mirrored to Arabic; long-tail pages are EN-first.
 */

export type Locale = "en" | "ar";

export const LOCALES: Locale[] = ["en", "ar"];
export const DEFAULT_LOCALE: Locale = "en";

/** A translatable string. */
export type Dict = { en: string; ar: string };

export function t(d: Dict, locale: Locale): string {
  return d[locale];
}

export function isLocale(v: string): v is Locale {
  return v === "en" || v === "ar";
}

export function dir(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

export function htmlLang(locale: Locale): string {
  return locale === "ar" ? "ar-AE" : "en-AE";
}

/** Map an English path to its localized URL. EN unprefixed, AR under `/ar`. */
export function localizedPath(enPath: string, locale: Locale): string {
  const p = enPath.startsWith("/") ? enPath : `/${enPath}`;
  if (locale === "en") return p;
  return p === "/" ? "/ar" : `/ar${p}`;
}

/**
 * `alternates` for a page that HAS both an EN and an AR variant. Pass the English
 * path; `forLocale` selects which variant is the canonical self-reference. Only
 * use on pages that genuinely have both variants (no hreflang to missing pages).
 */
export function bilingualAlternates(enPath: string, forLocale: Locale) {
  const en = localizedPath(enPath, "en");
  const ar = localizedPath(enPath, "ar");
  return {
    canonical: forLocale === "ar" ? ar : en,
    languages: { "en-AE": en, "ar-AE": ar, "x-default": en } as Record<string, string>,
  };
}
