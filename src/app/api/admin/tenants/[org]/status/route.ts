import { requireAdminWrite, auditData, requestIp } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

const STATUSES = ["active", "suspended", "readonly"];

/** Suspend / reactivate / set read-only. Enforced on tenant writes + sends. Audited. */
export async function POST(req: Request, ctx: { params: Promise<{ org: string }> }) {
  try {
    const admin = await requireAdminWrite(req);
    const { org } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { status?: string; reason?: string };
    if (!body.status || !STATUSES.includes(body.status)) return json({ error: "status must be active | suspended | readonly" }, 400);
    if (body.status !== "active" && !body.reason?.trim()) return json({ error: "A reason is required to suspend or lock a workspace" }, 400);

    const orgRow = await prisma.organization.findUnique({ where: { id: org }, select: { id: true, status: true } });
    if (!orgRow) return json({ error: "Workspace not found" }, 404);
    const ip = await requestIp();
    await prisma.$transaction([
      prisma.organization.update({
        where: { id: org },
        data: { status: body.status, suspendedReason: body.status === "active" ? null : body.reason?.trim() },
      }),
      prisma.adminAuditLog.create({
        data: auditData(admin, { action: "tenant.status.change", targetOrgId: org, metadata: { from: orgRow.status, to: body.status }, reason: body.reason ?? null }, ip),
      }),
    ]);
    return json({ ok: true, status: body.status });
  } catch (e) {
    return handleError(e);
  }
}
