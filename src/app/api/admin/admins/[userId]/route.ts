import { requirePlatformAdmin, isSuper, assertSameOrigin, auditData, requestIp } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

/** Revoke a platform admin (DB row). Super only. Audited (fail-closed). */
export async function DELETE(req: Request, ctx: { params: Promise<{ userId: string }> }) {
  try {
    const admin = await requirePlatformAdmin();
    if (!isSuper(admin.role)) return json({ error: "Only super admins can manage operators" }, 403);
    await assertSameOrigin(req);
    const { userId } = await ctx.params;

    const prior = await prisma.platformAdmin.findUnique({ where: { userId } });
    if (!prior) return json({ error: "Not an operator" }, 404);
    if (userId === admin.userId) return json({ error: "You can't revoke your own access" }, 400);

    const ip = await requestIp();
    await prisma.$transaction([
      prisma.platformAdmin.delete({ where: { userId } }),
      prisma.adminAuditLog.create({
        data: auditData(admin, { action: "admin.revoke", targetId: userId, metadata: { priorRole: prior.role } }, ip),
      }),
    ]);
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
