/**
 * Ledger amounts are BigInt minor units, which JSON.stringify refuses. They are
 * serialised as strings rather than numbers so a large balance can never lose
 * precision crossing the wire — the client formats from the string.
 */
export function ledgerJson<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(ledgerJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = ledgerJson(v);
    return out;
  }
  return value;
}
