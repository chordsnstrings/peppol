import { prisma } from "@/lib/server/prisma";
import { encryptSecret, decryptSecret } from "@/lib/server/crypto";
import type { ProviderId, TokenSet } from "./port";

/**
 * Tokens are keyed by `orgId:connectionId` so a connection id can never collide
 * across tenants — each client's integration is fully separate.
 */
function tokenKey(orgId: string, connectionId: string): string {
  return `${orgId}:${connectionId}`;
}

export async function saveToken(
  connectionId: string,
  orgId: string,
  provider: ProviderId,
  token: TokenSet,
): Promise<void> {
  const enc = {
    accessTokenEnc: encryptSecret(token.accessToken),
    refreshTokenEnc: token.refreshToken ? encryptSecret(token.refreshToken) : null,
    expiresAt: token.expiresAt ? new Date(token.expiresAt) : null,
    meta: token.meta ? JSON.stringify(token.meta) : null,
  };
  await prisma.integrationToken.upsert({
    where: { id: tokenKey(orgId, connectionId) },
    create: { id: tokenKey(orgId, connectionId), orgId, provider, ...enc },
    update: { provider, ...enc },
  });
}

export async function loadToken(connectionId: string, orgId: string): Promise<TokenSet | null> {
  const row = await prisma.integrationToken.findFirst({
    where: { id: tokenKey(orgId, connectionId), orgId },
  });
  if (!row) return null;
  return {
    accessToken: decryptSecret(row.accessTokenEnc),
    refreshToken: row.refreshTokenEnc ? decryptSecret(row.refreshTokenEnc) : undefined,
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : undefined,
    meta: row.meta ? (JSON.parse(row.meta) as Record<string, string>) : undefined,
  };
}

export async function deleteToken(connectionId: string, orgId: string): Promise<void> {
  await prisma.integrationToken.deleteMany({ where: { id: tokenKey(orgId, connectionId), orgId } });
}
