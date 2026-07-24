import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";

/* ------------------------------- Hashing ----------------------------- */

/** SHA-256 hex digest — used to store API keys (lookup by hash, never plaintext). */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/* ----------------------------- Passwords ----------------------------- */

/** Hash a password with scrypt. Returns `salt:hash` (hex). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/* --------------------------- Token encryption --------------------------- */

function key(): Buffer {
  const secret = process.env.ENCRYPTION_KEY ?? "dev-insecure-token-encryption-key-change-in-prod-02";
  // Derive a stable 32-byte key from whatever secret is configured.
  return createHash("sha256").update(secret).digest();
}

/** Encrypt a secret (e.g. an OAuth token) → `iv:tag:ciphertext` (hex). */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString(
    "utf8",
  );
}
