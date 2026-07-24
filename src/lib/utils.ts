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

/** Today's date as YYYY-MM-DD in Asia/Dubai calendar terms (approx via local). */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Add days to an ISO date, returning YYYY-MM-DD. */
export function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
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
