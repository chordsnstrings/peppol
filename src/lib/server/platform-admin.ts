import { timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { prisma } from "./prisma";
import { sha256Hex } from "./crypto";
import { getSession } from "./session";

/**
 * Platform-operator (super admin) identity, guard and audit. This layer
 * deliberately transcends tenant isolation, so it lives apart from the
 * org-scoped session/store helpers and everything privileged is audited.
 *
 * Identity model: privilege is NEVER derived from a self-asserted email alone
 * (registration is open + unverified). Instead:
 *   1. PLATFORM_ADMINS lists which emails are *permitted* to become operators.
 *   2. A one-time claim at /admin-setup requires the PLATFORM_BOOTSTRAP_TOKEN
 *      server secret AND an allowlisted email → writes a `super` PlatformAdmin row.
 *   3. From then on, the DB `PlatformAdmin` table is the sole source of truth;
 *      claimed supers grant teammates in-app.
 * So an attacker who registers an allowlisted email can't elevate without the
 * bootstrap token (a secret they don't have).
 */

export type PlatformRole = "super" | "support" | "read_only";

export interface PlatformAdminContext {
  userId: string;
  email: string;
  name: string;
  role: PlatformRole;
  /** True when the email is in the allowlist (informational; role comes from the DB). */
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

function bootstrapTokenMatches(provided: string): boolean {
  const expected = process.env.PLATFORM_BOOTSTRAP_TOKEN ?? "";
  if (!expected || !provided) return false;
  const a = Buffer.from(sha256Hex(provided), "hex");
  const b = Buffer.from(sha256Hex(expected), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Resolve a user's platform role from the DB ONLY — never from the raw
 * allowlist. Returns null if they aren't a provisioned operator.
 */
export async function resolvePlatformRole(userId: string): Promise<PlatformRole | null> {
  const row = await prisma.platformAdmin.findUnique({ where: { userId } });
  return (row?.role as PlatformRole | undefined) ?? null;
}

/** Throwing guard for /api/admin/* routes and /admin server components. */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
  const session = await getSession();
  if (!session) throw new PlatformForbiddenError();
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) throw new PlatformForbiddenError();
  const role = await resolvePlatformRole(user.id);
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

export function canWrite(role: PlatformRole): boolean {
  return role === "super" || role === "support";
}
export function isSuper(role: PlatformRole): boolean {
  return role === "super";
}

/* ------------------------------ Bootstrap ----------------------------- */

export type ClaimResult = "ok" | "already" | "bad_token" | "not_allowlisted" | "no_session";

/**
 * One-time claim: elevate the signed-in user to `super` iff their email is
 * allowlisted and the bootstrap token matches. Audited in the same transaction.
 */
export async function claimOperator(token: string): Promise<ClaimResult> {
  const session = await getSession();
  if (!session) return "no_session";
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user) return "no_session";
  if (!isAllowlisted(user.email)) return "not_allowlisted";
  if (!bootstrapTokenMatches(token)) return "bad_token";

  const existing = await prisma.platformAdmin.findUnique({ where: { userId: user.id } });
  if (existing?.role === "super") return "already";

  const ip = await requestIp();
  await prisma.$transaction([
    prisma.platformAdmin.upsert({
      where: { userId: user.id },
      create: { userId: user.id, role: "super", addedBy: "bootstrap" },
      update: { role: "super" },
    }),
    prisma.adminAuditLog.create({
      data: auditData({ userId: user.id, email: user.email }, { action: "admin.bootstrap", targetId: user.id, metadata: { via: "bootstrap-token" } }, ip),
    }),
  ]);
  return "ok";
}

/* ------------------------------- CSRF --------------------------------- */

/**
 * Defense-in-depth beyond SameSite cookies: reject browser cross-origin writes.
 * A request with no Origin (curl / server-to-server) is allowed — CSRF is a
 * browser-only attack.
 */
export async function assertSameOrigin(req: Request): Promise<void> {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const h = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  try {
    if (new URL(origin).host !== h) throw new PlatformForbiddenError();
  } catch {
    throw new PlatformForbiddenError();
  }
}

/* ------------------------------- Audit -------------------------------- */

export interface AuditInput {
  action: string;
  targetOrgId?: string | null;
  targetId?: string | null;
  metadata?: unknown;
  reason?: string | null;
}

/** Source IP from the trusted proxy hop. NOTE: only trustworthy if a trusted
 * proxy overwrites x-forwarded-for; treat as best-effort otherwise. */
export async function requestIp(): Promise<string | null> {
  try {
    const h = await headers();
    return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null;
  } catch {
    return null;
  }
}

/** Build an AdminAuditLog `data` object — for use inside a $transaction. */
export function auditData(
  admin: { userId: string; email: string },
  input: AuditInput,
  ip: string | null,
) {
  return {
    adminUserId: admin.userId,
    adminEmail: admin.email,
    action: input.action,
    targetOrgId: input.targetOrgId ?? null,
    targetId: input.targetId ?? null,
    metadata: input.metadata !== undefined ? JSON.stringify(input.metadata) : null,
    reason: input.reason ?? null,
    ip,
  };
}

/**
 * Best-effort audit for READS (never breaks the request). For privileged
 * WRITES, write the audit row inside the mutation's $transaction with auditData()
 * instead, so a log failure rolls the action back (fail-closed).
 */
export async function logAdminAction(admin: PlatformAdminContext, input: AuditInput): Promise<void> {
  try {
    const ip = await requestIp();
    await prisma.adminAuditLog.create({ data: auditData(admin, input, ip) });
  } catch (e) {
    console.error("admin audit write failed", e);
  }
}
