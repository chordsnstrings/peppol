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
/**
 * How many proxies sit in front of this app.
 *
 * X-Forwarded-For is appended to by each hop, so the addresses a proxy we
 * control wrote are the LAST ones in the list, and everything before them was
 * supplied by the client and can say anything at all. Taking the left-most
 * entry — which is what this did — lets anybody rotate their own rate-limit
 * bucket with a header, which is to say it lets anybody turn the limiter off.
 *
 * The right entry is counted from the right: with one trusted proxy it is the
 * last, with two the second from last. That number is a property of the
 * deployment and nothing in the request can tell us it, so it is configuration.
 * The default is 1, which is what a single load balancer or CDN in front of a
 * Next.js app gives you.
 *
 * Setting it to 0 means the app is exposed directly and the header is not to be
 * trusted at all.
 */
const TRUSTED_PROXY_HOPS = (() => {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  if (raw === undefined) return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 1;
})();

/**
 * The address to rate-limit against.
 *
 * Falls back to "unknown" when there is nothing trustworthy, and that is
 * deliberate: every such caller then shares one bucket, which throttles them
 * collectively rather than letting them all through. A limiter that fails open
 * is not a limiter.
 */
export function clientIp(req: Request): string {
  if (TRUSTED_PROXY_HOPS > 0) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
      // Count from the right. Where the header is shorter than the number of
      // hops we expect, something is wrong with either the header or the
      // configuration, and the left-most entry is the least-bad answer that is
      // still bounded by the list the proxy actually wrote.
      const ip = hops[Math.max(0, hops.length - TRUSTED_PROXY_HOPS)];
      if (ip) return ip;
    }
    // Written by the proxy itself and not appended to, so it carries no
    // client-supplied prefix to strip.
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  return "unknown";
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
