/**
 * Money is always integer minor units internally (fils for AED; 1 AED = 100 fils).
 * Floating point for money is forbidden past the parse boundary — we round to
 * integer minor units at defined points only (§7.5).
 */

export const MINOR_PER_MAJOR = 100;

/** HALF_UP rounding of a (possibly fractional) minor-unit amount to a whole integer. */
export function halfUp(minor: number): number {
  const sign = minor < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(minor) + 0.5 + 1e-6);
}

/** Parse a user-entered major-unit string ("1,234.56") to integer minor units. */
export function parseMoneyToMinor(input: string | number): number {
  if (typeof input === "number") return halfUp(input * MINOR_PER_MAJOR);
  const cleaned = input
    .replace(/[^\d.,-]/g, "")
    .replace(/,(?=\d{3}\b)/g, "") // thousands
    .replace(/,/g, "."); // decimal comma fallback
  const n = Number.parseFloat(cleaned);
  if (Number.isNaN(n)) return 0;
  return halfUp(n * MINOR_PER_MAJOR);
}

/** Convert integer minor units to a major-unit number (for display math only). */
export function minorToMajor(minor: number): number {
  return minor / MINOR_PER_MAJOR;
}

const symbolMap: Record<string, string> = {
  AED: "AED",
  USD: "$",
  EUR: "€",
  GBP: "£",
  SAR: "SAR",
};

/** Format integer minor units as a currency string. Latin digits by default. */
export function formatMoney(
  minor: number,
  currency = "AED",
  opts: { locale?: string; withSymbol?: boolean; sign?: boolean } = {},
): string {
  const { locale = "en-AE", withSymbol = true } = opts;
  const major = minorToMajor(minor);
  const num = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: opts.sign ? "always" : "auto",
  }).format(major);
  if (!withSymbol) return num;
  const sym = symbolMap[currency] ?? currency;
  // Symbol-prefixed for consistency (AED 1,234.56)
  return `${sym} ${num}`;
}

/** Compact money for KPI tiles: AED 12.4k / 1.2M. */
export function formatMoneyCompact(minor: number, currency = "AED"): string {
  const major = minorToMajor(minor);
  const num = new Intl.NumberFormat("en-AE", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(major);
  const sym = symbolMap[currency] ?? currency;
  return `${sym} ${num}`;
}

export function formatNumber(n: number, opts: Intl.NumberFormatOptions = {}) {
  return new Intl.NumberFormat("en-AE", opts).format(n);
}
