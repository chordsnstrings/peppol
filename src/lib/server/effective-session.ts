import { getSession, membershipValid, UnauthorizedError } from "./session";
import { getImpersonation } from "./impersonation";
import { resolvePlatformRole } from "./platform-admin";

/**
 * The session a READ should use. During a valid operator impersonation (the
 * cookie's admin matches the logged-in user AND they're still a platform admin),
 * reads resolve to the target org. Otherwise it's the normal tenant session.
 * Writes must NOT use this — they use requireWritableSession(), which blocks
 * while impersonating.
 */
export interface EffectiveSession {
  userId: string;
  orgId: string;
  impersonating: boolean;
  realOrgId: string;
}

export async function getEffectiveSession(): Promise<EffectiveSession | null> {
  const session = await getSession();
  if (!session) return null;
  const imp = await getImpersonation();
  if (imp && imp.adminUserId === session.userId) {
    const role = await resolvePlatformRole(session.userId); // re-check: revocation is immediate
    if (role) return { userId: session.userId, orgId: imp.orgId, impersonating: true, realOrgId: session.orgId };
  }
  // Normal tenant read: verify the membership still exists (immediate revocation).
  if (!(await membershipValid(session.userId, session.orgId))) return null;
  return { userId: session.userId, orgId: session.orgId, impersonating: false, realOrgId: session.orgId };
}

export async function requireEffectiveSession(): Promise<EffectiveSession> {
  const s = await getEffectiveSession();
  if (!s) throw new UnauthorizedError();
  return s;
}
