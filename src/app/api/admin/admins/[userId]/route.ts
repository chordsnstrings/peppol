import { requirePlatformAdmin, isSuper, logAdminAction } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

/** Revoke a platform admin (DB row). Super only. Allowlist roots can't be removed here. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ userId: string }> }) {
  try {
    const admin = await requirePlatformAdmin();
    if (!isSuper(admin.role)) return json({ error: "Only super admins can manage operators" }, 403);
    const { userId } = await ctx.params;
    await prisma.platformAdmin.deleteMany({ where: { userId } });
    await logAdminAction(admin, { action: "admin.revoke", targetId: userId });
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
