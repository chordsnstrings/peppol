import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { authSecretKey } from "./secret";
import { prisma } from "./prisma";

const COOKIE = "arks_session";
const ALG = "HS256";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function secret(): Uint8Array {
  return authSecretKey();
}

export interface Session {
  userId: string;
  orgId: string;
}

export async function createSession(session: Session): Promise<void> {
  const token = await new SignJWT({ ...session })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: [ALG] });
    if (typeof payload.userId === "string" && typeof payload.orgId === "string") {
      return { userId: payload.userId, orgId: payload.orgId };
    }
    return null;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}

/** Throwing guard for API routes. */
/** The session's (userId, orgId) still corresponds to a real membership. */
export async function membershipValid(userId: string, orgId: string): Promise<boolean> {
  const m = await prisma.membership.findUnique({
    where: { userId_orgId: { userId, orgId } },
    select: { userId: true },
  });
  return Boolean(m);
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  // A 30-day token outlives membership changes; re-check so a removed member
  // (or deleted org) loses access immediately rather than at token expiry.
  if (!(await membershipValid(session.userId, session.orgId))) throw new UnauthorizedError();
  return session;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}
