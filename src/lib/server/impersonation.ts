import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { authSecretKey } from "./secret";

/**
 * Operator impersonation ("view as tenant"). A short-lived, read-only, separate
 * cookie so it never widens the operator's own tenant session. Reads resolve to
 * the target org; writes are blocked while impersonating.
 */
const COOKIE = "arks_impersonation";
const TTL_SECONDS = 15 * 60; // 15 minutes
const ALG = "HS256";

function key(): Uint8Array {
  return authSecretKey();
}

export interface Impersonation {
  adminUserId: string;
  orgId: string;
}

export async function startImpersonation(adminUserId: string, orgId: string): Promise<void> {
  const token = await new SignJWT({ act_as: true, org: orgId })
    .setProtectedHeader({ alg: ALG })
    .setSubject(adminUserId)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(key());
  const jar = await cookies();
  jar.set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: TTL_SECONDS });
}

export async function stopImpersonation(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

export async function getImpersonation(): Promise<Impersonation | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: [ALG] });
    if (payload.act_as === true && typeof payload.sub === "string" && typeof payload.org === "string") {
      return { adminUserId: payload.sub, orgId: payload.org };
    }
    return null;
  } catch {
    return null;
  }
}

export async function isImpersonating(): Promise<boolean> {
  return (await getImpersonation()) !== null;
}
