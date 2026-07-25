import { SignJWT, jwtVerify } from "jose";
import { authSecretKey } from "@/lib/server/secret";

/**
 * The accounting-OAuth `state` must be an unguessable, session-bound anti-CSRF
 * token — not a caller-chosen connectionId. We sign {userId, orgId, connectionId}
 * at authorize and verify it (incl. that it matches the current session) at the
 * callback, so an attacker can't have a victim's session process a foreign code.
 */
const ALG = "HS256";

export async function signIntegrationState(input: {
  userId: string;
  orgId: string;
  connectionId: string;
  provider: string;
}): Promise<string> {
  return new SignJWT({ ...input, kind: "int_state" })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(authSecretKey());
}

export async function verifyIntegrationState(
  token: string,
): Promise<{ userId: string; orgId: string; connectionId: string; provider: string } | null> {
  try {
    const { payload } = await jwtVerify(token, authSecretKey(), { algorithms: [ALG] });
    if (
      payload.kind !== "int_state" ||
      typeof payload.userId !== "string" ||
      typeof payload.orgId !== "string" ||
      typeof payload.connectionId !== "string" ||
      typeof payload.provider !== "string"
    ) {
      return null;
    }
    return { userId: payload.userId, orgId: payload.orgId, connectionId: payload.connectionId, provider: payload.provider };
  } catch {
    return null;
  }
}
