import { requireAdminWrite, auditData, requestIp } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

/** Set or clear an allowance override (comp extra exchanges). null clears it. Audited. */
export async function POST(req: Request, ctx: { params: Promise<{ org: string }> }) {
  try {
    const admin = await requireAdminWrite(req);
    const { org } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { allowance?: number | null; reason?: string };
    const allowance = body.allowance === null || body.allowance === undefined ? null : Math.max(0, Math.floor(Number(body.allowance)));
    if (allowance !== null && !Number.isFinite(allowance)) return json({ error: "allowance must be a number or null" }, 400);

    const orgRow = await prisma.organization.findUnique({ where: { id: org }, select: { id: true } });
    if (!orgRow) return json({ error: "Workspace not found" }, 404);
    const ip = await requestIp();
    await prisma.$transaction([
      prisma.orgBilling.upsert({
        where: { orgId: org },
        create: { orgId: org, plan: "FREE_MANDATE", allowanceOverride: allowance },
        update: { allowanceOverride: allowance },
      }),
      prisma.adminAuditLog.create({
        data: auditData(admin, { action: "tenant.allowance.override", targetOrgId: org, metadata: { allowance }, reason: body.reason ?? null }, ip),
      }),
    ]);
    return json({ ok: true, allowance });
  } catch (e) {
    return handleError(e);
  }
}
