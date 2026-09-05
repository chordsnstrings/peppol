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

/**
 * Divide rounding halves away from zero, in BigInt so the multiplication
 * happens before the division and no money passes through a float. Rounding
 * once at the end is what keeps a converted figure within half a minor unit,
 * and it makes a refund and a sale of the same size round to the same figure.
 */
export function divHalfUp(value: bigint, divisor: bigint): bigint {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const out = (abs * 2n + divisor) / (divisor * 2n);
  return neg ? -out : out;
}

/**
 * An exchange rate as an exact integer and the power of ten it is scaled by,
 * so "3.6725" is 36725 over 10^4 and never 3.6724999999999999.
 *
 * Anything that is not a plain positive decimal comes back undefined rather
 * than as a silent 1 or 0 — the rate is typed by hand in the editor, and a
 * half-typed one must stop the conversion, not convert at a made-up rate.
 */
function parseRate(raw: string | number): { units: bigint; scale: bigint } | undefined {
  const text = typeof raw === "number" ? (Number.isFinite(raw) ? String(raw) : "") : raw.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return undefined;
  const frac = m[2] ?? "";
  const units = BigInt(m[1] + frac);
  if (units <= 0n) return undefined;
  return { units, scale: 10n ** BigInt(frac.length) };
}

/**
 * Convert a minor-unit amount at a decimal exchange rate, rounding half away
 * from zero — the rounding the FTA applies to a converted tax figure.
 *
 * Both sides stay in minor units, which is only sound while the two currencies
 * share an exponent. AED has two decimal places and so does every currency this
 * product offers (`CURRENCIES` in `./peppol`), so the product of a rate and a
 * fils amount is a fils amount. A zero-decimal currency such as JPY would need
 * the exponents to be carried explicitly; none is offered, and this is the
 * comment that has to be read before one is.
 *
 * Undefined where the rate is unusable, so a caller can tell "not converted"
 * from "converts to nothing" instead of printing a nought it cannot stand behind.
 */
export function convertMinorAtRate(minor: number, rate: string | number): number | undefined {
  const parsed = parseRate(rate);
  if (!parsed) return undefined;
  return Number(divHalfUp(BigInt(Math.round(minor)) * parsed.units, parsed.scale));
}
