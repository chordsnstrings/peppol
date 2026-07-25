/**
 * The signing key for all HS256 tokens (session, impersonation, OAuth access).
 * Fail-closed: in production a missing/weak AUTH_SECRET throws rather than
 * silently using a public default — a shared default would let anyone forge
 * sessions and impersonation tokens for any tenant.
 */
const DEV_FALLBACK = "dev-insecure-session-secret-change-in-production-0001";

export function authSecretKey(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (!raw || raw.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET must be set to a strong value (>=16 chars) in production");
    }
    return new TextEncoder().encode(DEV_FALLBACK);
  }
  return new TextEncoder().encode(raw);
}
