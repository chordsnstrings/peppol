import { requirePlatformAdmin, isSuper, logAdminAction, allowlistEmails, type PlatformRole } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

const ROLES: PlatformRole[] = ["super", "support", "read_only"];

/** List platform admins (allowlist roots + DB rows). */
export async function GET() {
  try {
    await requirePlatformAdmin();
    const rows = await prisma.platformAdmin.findMany({ orderBy: { createdAt: "asc" } });
    const userIds = rows.map((r) => r.userId);
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    const dbAdmins = rows.map((r) => ({
      userId: r.userId,
      email: byId.get(r.userId)?.email ?? "(unknown)",
      name: byId.get(r.userId)?.name ?? "",
      role: r.role,
      source: "db" as const,
      createdAt: r.createdAt.toISOString(),
    }));
    return json({ allowlist: allowlistEmails(), admins: dbAdmins });
  } catch (e) {
    return handleError(e);
  }
}

/** Add or update a platform admin by email. Super only. Audited. */
export async function POST(req: Request) {
  try {
    const admin = await requirePlatformAdmin();
    if (!isSuper(admin.role)) return json({ error: "Only super admins can manage operators" }, 403);
    const body = (await req.json().catch(() => ({}))) as { email?: string; role?: string };
    const email = body.email?.trim().toLowerCase();
    const role = (body.role && ROLES.includes(body.role as PlatformRole) ? body.role : "support") as PlatformRole;
    if (!email) return json({ error: "email is required" }, 400);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return json({ error: "No user with that email has signed up yet" }, 404);

    await prisma.platformAdmin.upsert({
      where: { userId: user.id },
      create: { userId: user.id, role, addedBy: admin.userId },
      update: { role },
    });
    await logAdminAction(admin, { action: "admin.grant", targetId: user.id, metadata: { email, role } });
    return json({ ok: true, userId: user.id, email, role });
  } catch (e) {
    return handleError(e);
  }
}
