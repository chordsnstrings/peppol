import { randomUUID } from "node:crypto";
import { requireAdminWrite, auditData, requestIp } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { startImpersonation } from "@/lib/server/impersonation";

export const runtime = "nodejs";

/**
 * Begin a read-only "view as tenant" session (15 min). A reason is required.
 * Logged to the admin audit AND to the tenant's own notifications (transparency).
 */
export async function POST(req: Request, ctx: { params: Promise<{ org: string }> }) {
  try {
    const admin = await requireAdminWrite(req);
    const { org } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { reason?: string };
    const reason = body.reason?.trim();
    if (!reason) return json({ error: "A reason is required to view a tenant's workspace" }, 400);

    const orgRow = await prisma.organization.findUnique({ where: { id: org }, select: { id: true } });
    if (!orgRow) return json({ error: "Workspace not found" }, 404);

    const at = new Date().toISOString();
    const ip = await requestIp();
    await prisma.$transaction([
      prisma.adminAuditLog.create({ data: auditData(admin, { action: "tenant.impersonate.start", targetOrgId: org, reason, metadata: { ttlMinutes: 15 } }, ip) }),
      // Transparency: the tenant sees this in their own activity feed.
      prisma.record.create({
        data: {
          id: randomUUID(),
          orgId: org,
          store: "notifications",
          data: JSON.stringify({
            id: randomUUID(),
            orgId: org,
            type: "support.access",
            title: "A support operator accessed your workspace",
            body: `Reason: ${reason}`,
            tone: "warning",
            createdAt: at,
          }),
        },
      }),
    ]);

    await startImpersonation(admin.userId, org);
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
