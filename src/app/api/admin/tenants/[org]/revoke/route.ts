import { requireAdminWrite, auditData, requestIp } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";

/**
 * Revoke a tenant's credentials: an API key, all OAuth grants, or an integration
 * connection. Org-scoped so it can only touch the named tenant. Audited.
 */
export async function POST(req: Request, ctx: { params: Promise<{ org: string }> }) {
  try {
    const admin = await requireAdminWrite(req);
    const { org } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { target?: string; id?: string; reason?: string };
    const target = body.target;
    const id = body.id;
    const now = new Date();
    const ip = await requestIp();

    const ops: Prisma.PrismaPromise<unknown>[] = [];
    if (target === "apiKey") {
      if (!id) return json({ error: "id required" }, 400);
      ops.push(prisma.apiKey.updateMany({ where: { id, orgId: org, revokedAt: null }, data: { revokedAt: now } }));
    } else if (target === "oauth") {
      ops.push(prisma.oAuthRefreshToken.updateMany({ where: { orgId: org, revokedAt: null }, data: { revokedAt: now } }));
    } else if (target === "integration") {
      if (!id) return json({ error: "id required" }, 400);
      ops.push(prisma.integrationToken.deleteMany({ where: { id, orgId: org } }));
      ops.push(prisma.record.deleteMany({ where: { id, orgId: org, store: "connections" } }));
    } else {
      return json({ error: "target must be apiKey | oauth | integration" }, 400);
    }
    ops.push(prisma.adminAuditLog.create({ data: auditData(admin, { action: `tenant.revoke.${target}`, targetOrgId: org, targetId: id ?? null, reason: body.reason ?? null }, ip) }));

    await prisma.$transaction(ops);
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
