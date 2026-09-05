import { Prisma } from "@prisma/client";

/**
 * Ledger amounts are BigInt minor units, which JSON.stringify refuses. They are
 * serialised as strings rather than numbers so a large balance can never lose
 * precision crossing the wire — the client formats from the string.
 *
 * The same reasoning covers the two other types Prisma hands back that are
 * objects rather than primitives.
 *
 * A `Prisma.Decimal` used to be walked like any other object, so an exchange
 * rate of 3.6729 reached the client as `{"s":1,"e":0,"d":[3,6729000]}` — the
 * library's own internal representation, which no client can read and which
 * silently renders as "[object Object]" or NaN wherever it lands. Three columns
 * in this schema are Decimal: `fxRate` on a journal line, `ratePercent` on a
 * tax profile, and `rate` on an exchange rate. Every one of them is a number
 * somebody checks a figure against.
 *
 * Decimal is stringified rather than turned into a JavaScript number for
 * exactly the reason BigInt is: `fxRate` is Decimal(20,10) and a float cannot
 * hold ten decimal places of a twenty-digit number without losing some of it.
 *
 * Bytes are the other one. A Buffer or Uint8Array walked as an object comes out
 * as `{"0":72,"1":105,…}`, which is both wrong and enormous.
 */
export function ledgerJson<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(ledgerJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = ledgerJson(v);
    return out;
  }
  return value;
}
