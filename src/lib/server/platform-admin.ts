import { headers } from "next/headers";
import { prisma } from "./prisma";
import { getSession } from "./session";

/**
 * Platform-operator (super admin) identity, guard and audit. This layer
 * deliberately transcends tenant isolation, so it lives apart from the
 * org-scoped session/store helpers and everything privileged is audited.
 *
 * Identity model (per the spec): the PLATFORM_ADMINS env allowlist is the
 * break-glass root — any listed email is treated as `super` and can seed
 * PlatformAdmin rows for teammates (with role super | support | read_only).
 */

export type PlatformRole = "super" | "support" | "read_only";

export interface PlatformAdminContext {
  userId: string;
  email: string;
  name: string;
  role: PlatformRole;
  /** True when granted via the env allowlist (root), not a DB row. */
  viaAllowlist: boolean;
}

export class PlatformForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "PlatformForbiddenError";
  }
}

/** Emails in PLATFORM_ADMINS (comma/space separated), lower-cased. */
export function allowlistEmails(): string[] {
  return (process.env.PLATFORM_ADMINS ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowlisted(email: string): boolean {
  return allowlistEmails().includes(email.toLowerCase());
}

/** Resolve a user's platform role, or null if they aren't an operator. */
export async function resolvePlatformRole(userId: string, email: string): Promise<PlatformRole | null> {
  if (isAllowlisted(email)) return "super";
  const row = await prisma.platformAdmin.findUnique({ where: { userId } });
  return (row?.role as PlatformRole | undefined) ?? null;
}

/** Throwing guard for /api/admin/* routes and /admin server components. */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const session = await getSession();
  if (!session) throw new PlatformForbiddenError();
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) throw new PlatformForbiddenError();
  const role = await resolvePlatformRole(user.id, user.email);
  if (!role) throw new PlatformForbiddenError();
  return { userId: user.id, email: user.email, name: user.name, role, viaAllowlist: isAllowlisted(user.email) };
}

/** Non-throwing check for layout gating. */
export async function getPlatformAdmin(): Promise<PlatformAdminContext | null> {
  try {
    return await requirePlatformAdmin();
  } catch {
    return null;
  }
}

/** Roles allowed to perform write/destructive actions. */
export function canWrite(role: PlatformRole): boolean {
  return role === "super" || role === "support";
}

/** Roles allowed to manage other admins / do the most dangerous actions. */
export function isSuper(role: PlatformRole): boolean {
  return role === "super";
}

/* ------------------------------- Audit -------------------------------- */

export interface AuditInput {
  action: string;
  targetOrgId?: string | null;
  targetId?: string | null;
  metadata?: unknown;
  reason?: string | null;
}

/** Append an entry to the admin audit log. Never throws into the request path. */
export async function logAdminAction(admin: PlatformAdminContext, input: AuditInput): Promise<void> {
  try {
    let ip: string | null = null;
    try {
      const h = await headers();
      ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
    } catch {
      /* headers() unavailable outside a request */
    }
    await prisma.adminAuditLog.create({
      data: {
        adminUserId: admin.userId,
        adminEmail: admin.email,
        action: input.action,
        targetOrgId: input.targetOrgId ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
        reason: input.reason ?? null,
        ip,
      },
    });
  } catch (e) {
    // Auditing must not break the operation, but we surface failures in logs.
    console.error("admin audit write failed", e);
  }
}
