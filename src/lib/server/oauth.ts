import { randomBytes, createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { prisma } from "./prisma";
import { sha256Hex } from "./crypto";

/**
 * OAuth 2.1 authorization server for the MCP endpoint. Authorization-code + PKCE
 * (S256) is the only interactive grant; refresh tokens rotate. Access tokens are
 * stateless JWTs (HS256, AUTH_SECRET) so the resource server validates them with
 * no DB round-trip; refresh tokens are opaque and stored hashed so they can be
 * revoked.
 */

export const SCOPE = "mcp";
export const ACCESS_TTL_SECONDS = 3600; // 1h
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30d
const CODE_TTL_SECONDS = 600; // 10m
const ALG = "HS256";

function key(): Uint8Array {
  return new TextEncoder().encode(
    process.env.AUTH_SECRET ?? "dev-insecure-session-secret-change-in-production-0001",
  );
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE S256 check: base64url(sha256(verifier)) === challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = base64url(createHash("sha256").update(verifier).digest());
  return computed === challenge;
}

/* ------------------------------- Clients ------------------------------ */

export interface ClientRegistration {
  redirectUris: string[];
  name: string;
  tokenAuthMethod: "none" | "client_secret_post" | "client_secret_basic";
  grantTypes?: string[];
}

export async function registerClient(reg: ClientRegistration) {
  const clientId = `mcp_${randomBytes(16).toString("hex")}`;
  const isPublic = reg.tokenAuthMethod === "none";
  const secret = isPublic ? null : `sec_${randomBytes(24).toString("hex")}`;
  const row = await prisma.oAuthClient.create({
    data: {
      id: clientId,
      secretHash: secret ? sha256Hex(secret) : null,
      name: reg.name.slice(0, 200) || "MCP client",
      redirectUris: JSON.stringify(reg.redirectUris),
      grantTypes: (reg.grantTypes ?? ["authorization_code", "refresh_token"]).join(","),
      tokenAuthMethod: reg.tokenAuthMethod,
    },
  });
  return { client: row, secret };
}

export async function getClient(clientId: string) {
  if (!clientId) return null;
  return prisma.oAuthClient.findUnique({ where: { id: clientId } });
}

export function clientRedirectUris(client: { redirectUris: string }): string[] {
  try {
    const v = JSON.parse(client.redirectUris);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function redirectUriAllowed(client: { redirectUris: string }, uri: string): boolean {
  return clientRedirectUris(client).includes(uri);
}

export function verifyClientSecret(client: { secretHash: string | null }, secret?: string): boolean {
  if (!client.secretHash) return true; // public client
  return Boolean(secret) && sha256Hex(secret!) === client.secretHash;
}

/* ---------------------------- Auth codes ------------------------------ */

export interface NewAuthCode {
  clientId: string;
  orgId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope?: string;
  resource?: string;
}

export async function createAuthCode(input: NewAuthCode): Promise<string> {
  const code = base64url(randomBytes(32));
  await prisma.oAuthAuthCode.create({
    data: {
      codeHash: sha256Hex(code),
      clientId: input.clientId,
      orgId: input.orgId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scope: input.scope ?? SCOPE,
      resource: input.resource,
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
    },
  });
  return code;
}

/** Single-use consume + validate an auth code. Returns null when invalid. */
export async function consumeAuthCode(
  code: string,
  clientId: string,
  redirectUri: string,
): Promise<{ orgId: string; userId: string; codeChallenge: string; scope: string } | null> {
  const row = await prisma.oAuthAuthCode.findUnique({ where: { codeHash: sha256Hex(code) } });
  if (!row || row.usedAt || row.expiresAt < new Date()) return null;
  if (row.clientId !== clientId || row.redirectUri !== redirectUri) return null;
  await prisma.oAuthAuthCode.update({ where: { codeHash: row.codeHash }, data: { usedAt: new Date() } });
  return { orgId: row.orgId, userId: row.userId, codeChallenge: row.codeChallenge, scope: row.scope };
}

/* --------------------------- Access tokens ---------------------------- */

export async function issueAccessToken(input: {
  userId: string;
  orgId: string;
  clientId: string;
  scope: string;
  issuer: string;
  resource?: string;
}): Promise<string> {
  return new SignJWT({ org: input.orgId, scope: input.scope, client_id: input.clientId, token_type: "access" })
    .setProtectedHeader({ alg: ALG })
    .setSubject(input.userId)
    .setIssuer(input.issuer)
    .setAudience(input.resource ?? `${input.issuer}/api/mcp`)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(key());
}

export async function verifyAccessToken(
  token: string,
): Promise<{ userId: string; orgId: string; scope: string; clientId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, key());
    if (payload.token_type !== "access" || typeof payload.sub !== "string" || typeof payload.org !== "string") {
      return null;
    }
    return {
      userId: payload.sub,
      orgId: payload.org,
      scope: typeof payload.scope === "string" ? payload.scope : SCOPE,
      clientId: typeof payload.client_id === "string" ? payload.client_id : "",
    };
  } catch {
    return null;
  }
}

/* --------------------------- Refresh tokens --------------------------- */

export async function issueRefreshToken(input: {
  clientId: string;
  orgId: string;
  userId: string;
  scope: string;
}): Promise<string> {
  const token = `rt_${base64url(randomBytes(32))}`;
  await prisma.oAuthRefreshToken.create({
    data: {
      tokenHash: sha256Hex(token),
      clientId: input.clientId,
      orgId: input.orgId,
      userId: input.userId,
      scope: input.scope,
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    },
  });
  return token;
}

/** Validate + rotate a refresh token (the old one is revoked). Returns null if invalid. */
export async function rotateRefreshToken(
  token: string,
  clientId: string,
): Promise<{ orgId: string; userId: string; scope: string; refreshToken: string } | null> {
  const row = await prisma.oAuthRefreshToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
  if (!row || row.revokedAt || row.expiresAt < new Date() || row.clientId !== clientId) return null;
  await prisma.oAuthRefreshToken.update({ where: { tokenHash: row.tokenHash }, data: { revokedAt: new Date() } });
  const refreshToken = await issueRefreshToken({ clientId, orgId: row.orgId, userId: row.userId, scope: row.scope });
  return { orgId: row.orgId, userId: row.userId, scope: row.scope, refreshToken };
}

/* ------------------------------- Origin ------------------------------- */

/** Public origin of a request, honoring the reverse proxy. */
export function originOf(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}
