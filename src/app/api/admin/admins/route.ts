import { requirePlatformAdmin, isSuper, assertSameOrigin, auditData, requestIp, allowlistEmails, type PlatformRole } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

const ROLES: PlatformRole[] = ["super", "support", "read_only"];

/** List platform admins (allowlist roots + DB rows). */
export async function GET() {
  try {
    await requirePlatformAdmin();
    const rows = await prisma.platformAdmin.findMany({ orderBy: { createdAt: "asc" } });
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, email: true, name: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    const admins = rows.map((r) => ({
      userId: r.userId,
      email: byId.get(r.userId)?.email ?? "(unknown)",
      name: byId.get(r.userId)?.name ?? "",
      role: r.role,
      createdAt: r.createdAt.toISOString(),
    }));
    return json({ allowlist: allowlistEmails(), admins });
  } catch (e) {
    return handleError(e);
  }
}

/** Add or update a platform admin by email. Super only. Audited (fail-closed). */
export async function POST(req: Request) {
  try {
    const admin = await requirePlatformAdmin();
    if (!isSuper(admin.role)) return json({ error: "Only super admins can manage operators" }, 403);
    await assertSameOrigin(req);
    const body = (await req.json().catch(() => ({}))) as { email?: string; role?: string };
    const email = body.email?.trim().toLowerCase();
    const role = (body.role && ROLES.includes(body.role as PlatformRole) ? body.role : "support") as PlatformRole;
    if (!email) return json({ error: "email is required" }, 400);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return json({ error: "No user with that email has signed up yet" }, 404);

    const prior = await prisma.platformAdmin.findUnique({ where: { userId: user.id } });
    const ip = await requestIp();
    await prisma.$transaction([
      prisma.platformAdmin.upsert({
        where: { userId: user.id },
        create: { userId: user.id, role, addedBy: admin.userId },
        update: { role },
      }),
      prisma.adminAuditLog.create({
        data: auditData(admin, { action: "admin.grant", targetId: user.id, metadata: { email, role, priorRole: prior?.role ?? null } }, ip),
      }),
    ]);
    return json({ ok: true, userId: user.id, email, role });
  } catch (e) {
    return handleError(e);
  }
}
