import { requireAdminWrite, auditData, requestIp } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { isPlanCode } from "@/lib/domain/billing";

export const runtime = "nodejs";

/** Change a workspace's plan. Audited (fail-closed). */
export async function POST(req: Request, ctx: { params: Promise<{ org: string }> }) {
  try {
    const admin = await requireAdminWrite(req);
    const { org } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { plan?: string; reason?: string };
    if (!body.plan || !isPlanCode(body.plan)) return json({ error: "Unknown plan" }, 400);

    const orgRow = await prisma.organization.findUnique({ where: { id: org }, select: { id: true } });
    if (!orgRow) return json({ error: "Workspace not found" }, 404);
    const prior = await prisma.orgBilling.findUnique({ where: { orgId: org } });
    const ip = await requestIp();
    await prisma.$transaction([
      prisma.orgBilling.upsert({ where: { orgId: org }, create: { orgId: org, plan: body.plan }, update: { plan: body.plan } }),
      prisma.adminAuditLog.create({
        data: auditData(admin, { action: "tenant.plan.change", targetOrgId: org, metadata: { from: prior?.plan ?? "FREE_MANDATE", to: body.plan }, reason: body.reason ?? null }, ip),
      }),
    ]);
    return json({ ok: true, plan: body.plan });
  } catch (e) {
    return handleError(e);
  }
}
