import { requirePlatformAdmin, assertSameOrigin, logAdminAction } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { getImpersonation, stopImpersonation } from "@/lib/server/impersonation";

export const runtime = "nodejs";

/** End the current impersonation session. */
export async function POST(req: Request) {
  try {
    const admin = await requirePlatformAdmin();
    await assertSameOrigin(req);
    const imp = await getImpersonation();
    await stopImpersonation();
    if (imp) await logAdminAction(admin, { action: "tenant.impersonate.stop", targetOrgId: imp.orgId });
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
