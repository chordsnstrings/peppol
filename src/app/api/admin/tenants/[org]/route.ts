import { requirePlatformAdmin, logAdminAction } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { tenantDetail } from "@/lib/server/admin-store";

export const runtime = "nodejs";

/** Full drill-down for one workspace. Viewing tenant data is audited (PII access). */
export async function GET(_req: Request, ctx: { params: Promise<{ org: string }> }) {
  try {
    const admin = await requirePlatformAdmin();
    const { org } = await ctx.params;
    const detail = await tenantDetail(org);
    if (!detail) return json({ error: "Workspace not found" }, 404);
    await logAdminAction(admin, { action: "tenant.view", targetOrgId: org });
    return json(detail);
  } catch (e) {
    return handleError(e);
  }
}
