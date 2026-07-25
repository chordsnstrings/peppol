import { requireAdminWrite, isSuper, auditData, requestIp } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

/**
 * Permanently delete a workspace and all its data. Super only. Requires a reason
 * and a typed confirmation of the workspace name. Audited (the log row survives).
 */
export async function POST(req: Request, ctx: { params: Promise<{ org: string }> }) {
  try {
    const admin = await requireAdminWrite(req);
    if (!isSuper(admin.role)) return json({ error: "Only super admins can delete a tenant" }, 403);
    const { org } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { reason?: string; confirmName?: string };
    if (!body.reason?.trim()) return json({ error: "A reason is required" }, 400);

    const organization = await prisma.organization.findUnique({ where: { id: org } });
    if (!organization) return json({ error: "Workspace not found" }, 404);
    if (body.confirmName?.trim() !== organization.name) {
      return json({ error: `Type the workspace name exactly to confirm: "${organization.name}"` }, 400);
    }

    const ip = await requestIp();
    await prisma.$transaction([
      // Audit FIRST so the record exists even though the org is about to vanish.
      prisma.adminAuditLog.create({ data: auditData(admin, { action: "tenant.delete", targetOrgId: org, reason: body.reason.trim(), metadata: { name: organization.name, slug: organization.slug } }, ip) }),
      prisma.record.deleteMany({ where: { orgId: org } }),
      prisma.transmission.deleteMany({ where: { orgId: org } }),
      prisma.payment.deleteMany({ where: { orgId: org } }),
      prisma.usageEvent.deleteMany({ where: { orgId: org } }),
      prisma.orgBilling.deleteMany({ where: { orgId: org } }),
      prisma.oAuthRefreshToken.deleteMany({ where: { orgId: org } }),
      prisma.oAuthAuthCode.deleteMany({ where: { orgId: org } }),
      prisma.apiKey.deleteMany({ where: { orgId: org } }),
      prisma.integrationToken.deleteMany({ where: { orgId: org } }),
      // Deleting the org cascades its memberships.
      prisma.organization.delete({ where: { id: org } }),
    ]);
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
