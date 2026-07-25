/**
 * The signing key for all HS256 tokens (session, impersonation, OAuth access).
 * Fail-closed: in production a missing/weak AUTH_SECRET throws rather than
 * silently using a public default — a shared default would let anyone forge
 * sessions and impersonation tokens for any tenant.
 */
const DEV_FALLBACK = "dev-insecure-session-secret-change-in-production-0001";
const DEV_ENC_FALLBACK = "dev-insecure-token-encryption-key-change-in-prod-02";

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

/**
 * The raw secret for AES-256-GCM token encryption (integration OAuth tokens).
 * Fail-closed in production exactly like AUTH_SECRET: a public default would let
 * anyone with the source decrypt every stored integration token.
 */
export function encryptionSecret(): string {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ENCRYPTION_KEY must be set to a strong value (>=16 chars) in production");
    }
    return DEV_ENC_FALLBACK;
  }
  return raw;
}
