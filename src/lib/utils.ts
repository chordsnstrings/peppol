import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware className combiner. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** ULID-ish sortable id (timestamp prefix + random). Deterministic enough for local use. */
export function id(prefix = ""): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}${prefix ? "_" : ""}${t}${r}`;
}

/** Clamp a number between min and max. */
export function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), max);
}

/** Format an ISO date (YYYY-MM-DD or full ISO) for display. */
export function formatDate(
  value?: string | number | Date | null,
  opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" },
  locale = "en-AE",
) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

/** Relative time (e.g. "3 min ago", "in 2 days"). */
export function timeAgo(value?: string | number | Date | null, locale = "en") {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  const diff = d.getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(diff);
  const mins = 60 * 1000;
  const hours = 60 * mins;
  const days = 24 * hours;
  if (abs < hours) return rtf.format(Math.round(diff / mins), "minute");
  if (abs < days) return rtf.format(Math.round(diff / hours), "hour");
  if (abs < 30 * days) return rtf.format(Math.round(diff / days), "day");
  return formatDate(d);
}

/**
 * The offset the books are kept at. The UAE observes no daylight saving, so
 * UTC+4 is a fixed offset all year and not an approximation of one; the server
 * keeps its own copy of this in `businessDay()` in the petty cash module, and
 * the two have to agree or a screen offers a date its own ledger would date
 * differently.
 */
const BUSINESS_UTC_OFFSET_MINUTES = 4 * 60;

/**
 * Today's date as YYYY-MM-DD, on the Gulf calendar the books are kept on.
 *
 * This used to slice `new Date().toISOString()`, which is UTC and not local at
 * all: between midnight and four in the morning here it is still yesterday in
 * UTC. Every date field that defaults from this — an invoice issue date, a
 * receipt, a payment, a petty cash chit — pre-filled the previous day for
 * anybody working late, and the previous day can be in the previous VAT
 * quarter or in a period that has since been closed.
 *
 * Shifting the instant by the offset and then reading its UTC calendar day is
 * the whole of it: what comes back is the date somebody in Dubai would write
 * down.
 */
export function todayISO(): string {
  return new Date(Date.now() + BUSINESS_UTC_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

/**
 * Add days to an ISO date, returning YYYY-MM-DD.
 *
 * The arithmetic is done in UTC because the input is a plain date and so is the
 * answer — no clock belongs anywhere near it. Parsing "2026-01-01T00:00:00" as
 * a local instant and then printing it back through `toISOString()` returns the
 * day before for every reader east of Greenwich, which is every reader of this
 * product: local midnight in Dubai is 20:00 UTC on the previous day.
 */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Days between two ISO dates (b - a). */
export function daysBetween(aISO: string, bISO: string): number {
  const a = new Date(aISO + "T00:00:00").getTime();
  const b = new Date(bISO + "T00:00:00").getTime();
  return Math.round((b - a) / (24 * 60 * 60 * 1000));
}

/** Initials from a name, up to 2 chars. */
export function initials(name?: string) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic hue from a string, for avatar tints. */
export function hueFromString(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function pluralize(n: number, singular: string, plural?: string) {
  return n === 1 ? singular : plural ?? `${singular}s`;
}

export function titleCase(s: string) {
  return s
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
