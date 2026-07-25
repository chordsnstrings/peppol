import { NextResponse } from "next/server";

/**
 * Minimal in-process fixed-window rate limiter for brute-force / abuse control.
 * Single-instance only — a multi-instance deployment should back this with a
 * shared store (Redis/Upstash). Fail-open on internal error (never block a
 * legitimate request because the limiter broke), but count aggressively.
 */
interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

export interface RateResult {
  ok: boolean;
  retryAfter: number; // seconds
  remaining: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  // Opportunistic prune so the map can't grow unbounded.
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0, remaining: limit - 1 };
  }
  if (b.count >= limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)), remaining: 0 };
  }
  b.count += 1;
  return { ok: true, retryAfter: 0, remaining: limit - b.count };
}

/** Read-only check (does NOT count). Use to gate before knowing success/failure. */
export function peek(key: string, limit: number): RateResult {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) return { ok: true, retryAfter: 0, remaining: limit };
  if (b.count >= limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)), remaining: 0 };
  return { ok: true, retryAfter: 0, remaining: limit - b.count };
}

/** Increment a counter (e.g. record a failed attempt) without gating. */
export function record(key: string, windowMs: number): void {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) buckets.set(key, { count: 1, resetAt: now + windowMs });
  else b.count += 1;
}

/** Best-effort client IP from the proxy hop. */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function tooManyResponse(retryAfter: number, extraHeaders?: Record<string, string>) {
  return NextResponse.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    { status: 429, headers: { "Retry-After": String(retryAfter), ...(extraHeaders ?? {}) } },
  );
}

/**
 * Convenience: enforce a limit for `key`; returns a ready 429 response when
 * exceeded, or null to proceed.
 */
export function enforce(key: string, limit: number, windowMs: number): NextResponse | null {
  const r = rateLimit(key, limit, windowMs);
  return r.ok ? null : tooManyResponse(r.retryAfter);
}
