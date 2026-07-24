import { randomBytes } from "node:crypto";
import { prisma } from "./prisma";
import { sha256Hex } from "./crypto";

/**
 * Public API keys. The plaintext (`arks_live_<hex>`) is returned once at
 * creation and never stored — only its SHA-256 hash and a display prefix are
 * persisted. Authentication hashes the presented key and looks it up.
 */

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function generatePlaintext(): string {
  return `arks_live_${randomBytes(24).toString("hex")}`;
}

export async function createApiKey(orgId: string, name: string): Promise<{ plaintext: string; view: ApiKeyView }> {
  const plaintext = generatePlaintext();
  const row = await prisma.apiKey.create({
    data: {
      orgId,
      name: name.trim() || "Untitled key",
      prefix: plaintext.slice(0, 18),
      hash: sha256Hex(plaintext),
    },
  });
  return {
    plaintext,
    view: { id: row.id, name: row.name, prefix: row.prefix, createdAt: row.createdAt.toISOString(), lastUsedAt: null },
  };
}

export async function listApiKeys(orgId: string): Promise<ApiKeyView[]> {
  const rows = await prisma.apiKey.findMany({
    where: { orgId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }));
}

/** Revoke a key. Org-scoped: a tenant can only revoke its own keys. */
export async function revokeApiKey(orgId: string, id: string): Promise<boolean> {
  const res = await prisma.apiKey.updateMany({
    where: { id, orgId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count > 0;
}

export class ApiKeyError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name = "ApiKeyError";
    this.status = status;
  }
}

/**
 * Authenticate a request by its `Authorization: Bearer <key>` header. Returns the
 * owning orgId. Throws ApiKeyError (401) when missing/invalid/revoked. Touches
 * lastUsedAt best-effort.
 */
export async function authenticateApiKey(req: Request): Promise<{ orgId: string; keyId: string }> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const presented = match?.[1]?.trim();
  if (!presented) throw new ApiKeyError("Missing API key. Send 'Authorization: Bearer <key>'.");

  const row = await prisma.apiKey.findUnique({ where: { hash: sha256Hex(presented) } });
  if (!row || row.revokedAt) throw new ApiKeyError("Invalid or revoked API key.");

  // Best-effort last-used stamp; never block the request on it.
  prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { orgId: row.orgId, keyId: row.id };
}
