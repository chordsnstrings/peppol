/**
 * Ledger figures on the client.
 *
 * Amounts cross the wire as decimal strings of minor units (see
 * `ledgerJson`), never as JS numbers — 2^53 minor units is only about
 * 90 trillion fils, and a group consolidation can reach that. Everything here
 * works in BigInt and only becomes a string at the point of display.
 */

/** Currencies whose minor unit is not 1/100. Extend as the ledger meets them. */
const EXPONENT: Record<string, number> = {
  AED: 2, USD: 2, EUR: 2, GBP: 2, SAR: 2, INR: 2, SEK: 2,
  BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3, IQD: 3, LYD: 3,
  JPY: 0, KRW: 0, VND: 0, ISK: 0, CLP: 0,
};

export function exponentOf(currency: string): number {
  return EXPONENT[currency.toUpperCase()] ?? 2;
}

/** Parse a wire value ("−12345", 12345, undefined) into minor units. */
export function toMinor(v: string | number | bigint | null | undefined): bigint {
  if (v === null || v === undefined || v === "") return 0n;
  if (typeof v === "bigint") return v;
  return BigInt(typeof v === "number" ? Math.trunc(v) : v.trim());
}

/**
 * Format minor units for display. Negatives are shown in parentheses — the
 * accounting convention, and the only negative marker that survives a
 * photocopier, a colour-blind reader and a printed PDF alike. Colour is applied
 * separately and is never the sole signal.
 */
export function fmtMinor(
  v: string | number | bigint | null | undefined,
  currency = "AED",
  opts: { zero?: "dash" | "zero" | "blank"; sign?: "paren" | "minus" } = {},
): string {
  const minor = toMinor(v);
  const zero = opts.zero ?? "dash";
  if (minor === 0n) return zero === "dash" ? "–" : zero === "blank" ? "" : fmtAbs(0n, currency);
  const neg = minor < 0n;
  const body = fmtAbs(neg ? -minor : minor, currency);
  if (!neg) return body;
  return (opts.sign ?? "paren") === "paren" ? `(${body})` : `-${body}`;
}

function fmtAbs(abs: bigint, currency: string): string {
  const exp = exponentOf(currency);
  const s = abs.toString().padStart(exp + 1, "0");
  const whole = exp === 0 ? s : s.slice(0, -exp);
  const frac = exp === 0 ? "" : s.slice(-exp);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return exp === 0 ? grouped : `${grouped}.${frac}`;
}

/** Minor units as a plain editable decimal — what goes back into an input. */
export function toInput(v: string | number | bigint | null | undefined, currency = "AED"): string {
  const minor = toMinor(v);
  if (minor === 0n) return "";
  const neg = minor < 0n;
  return (neg ? "-" : "") + fmtAbs(neg ? -minor : minor, currency).replace(/,/g, "");
}

/**
 * Turn what a bookkeeper actually types into minor units.
 *
 * Amount cells accept arithmetic — `1200/3`, `(450+80)*1.05` — because the
 * alternative is a calculator app open beside the ledger, and a number
 * transcribed by hand is a number that can be transcribed wrong. Only digits
 * and `+ - * / ( ) . ,` are allowed through, and the expression is evaluated by
 * a small recursive-descent parser rather than by `eval`, so a pasted cell can
 * never execute anything.
 *
 * Returns null when the text is not a valid amount, so a caller can keep the
 * user's text on screen instead of silently zeroing it.
 */
export function parseAmount(text: string, currency = "AED"): bigint | null {
  const src = text.trim();
  if (src === "") return 0n;
  if (!/^[0-9+\-*/(). ,]+$/.test(src)) return null;
  try {
    const value = evalExpr(src.replace(/,/g, ""));
    if (!Number.isFinite(value)) return null;
    return roundToMinor(value, exponentOf(currency));
  } catch {
    return null;
  }
}

/** Half-up rounding at the currency's minor unit, done on the decimal string. */
function roundToMinor(value: number, exp: number): bigint {
  const neg = value < 0;
  const abs = Math.abs(value);
  // toFixed at exp+1 then round the last digit by hand keeps this away from
  // binary-float surprises at the .005 boundary.
  const fixed = abs.toFixed(exp + 2);
  const [w, f = ""] = fixed.split(".");
  const keep = f.slice(0, exp);
  const next = Number(f[exp] ?? "0");
  let minor = BigInt(w + keep.padEnd(exp, "0"));
  if (next >= 5) minor += 1n;
  return neg ? -minor : minor;
}

/* --- expression parser: expr := term (('+'|'-') term)* ------------------- */

function evalExpr(s: string): number {
  let i = 0;
  const peek = () => s[i];
  const skip = () => { while (i < s.length && s[i] === " ") i++; };

  function expr(): number {
    let v = term();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "+" && op !== "-") return v;
      i++;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
  }
  function term(): number {
    let v = unary();
    for (;;) {
      skip();
      const op = peek();
      if (op !== "*" && op !== "/") return v;
      i++;
      const r = unary();
      if (op === "/" && r === 0) throw new Error("divide by zero");
      v = op === "*" ? v * r : v / r;
    }
  }
  function unary(): number {
    skip();
    if (peek() === "-") { i++; return -unary(); }
    if (peek() === "+") { i++; return unary(); }
    return atom();
  }
  function atom(): number {
    skip();
    if (peek() === "(") {
      i++;
      const v = expr();
      skip();
      if (peek() !== ")") throw new Error("unbalanced");
      i++;
      return v;
    }
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    if (i === start) throw new Error("expected a number");
    const n = Number(s.slice(start, i));
    if (Number.isNaN(n)) throw new Error("not a number");
    return n;
  }

  const out = expr();
  skip();
  if (i !== s.length) throw new Error("trailing input");
  return out;
}
