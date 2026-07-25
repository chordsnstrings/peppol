import { prisma } from "./prisma";
import { requireSession, type Session } from "./session";
import { isImpersonating } from "./impersonation";

/** Thrown when a workspace is suspended/read-only and a write is attempted. */
export class OrgLockedError extends Error {
  status = 423; // Locked
  constructor(message: string) {
    super(message);
    this.name = "OrgLockedError";
  }
}

/** True if the org may perform writes (create/send). Unknown org → allowed. */
export async function isOrgWritable(orgId: string): Promise<boolean> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { status: true } });
  return !org || org.status === "active";
}

/** Throwing guard for tenant write paths (store writes, send). Handled as 423. */
export async function assertOrgWritable(orgId: string): Promise<void> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { status: true } });
  if (!org || org.status === "active") return;
  if (org.status === "suspended") throw new OrgLockedError("This workspace has been suspended. Contact support.");
  throw new OrgLockedError("This workspace is read-only. Contact support.");
}

/** requireSession + writable check + no-impersonation, for tenant write routes. */
export async function requireWritableSession(): Promise<Session> {
  const session = await requireSession();
  if (await isImpersonating()) {
    throw new OrgLockedError("Read-only while viewing as a tenant. Exit impersonation to make changes.");
  }
  await assertOrgWritable(session.orgId);
  return session;
}
