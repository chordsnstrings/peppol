import { requirePlatformAdmin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { auditLog } from "@/lib/server/admin-store";

export const runtime = "nodejs";

/** The admin audit trail. Filter by ?action= (prefix) or ?orgId=. */
export async function GET(req: Request) {
  try {
    await requirePlatformAdmin();
    const u = new URL(req.url).searchParams;
    return json({ entries: await auditLog({ action: u.get("action") ?? undefined, orgId: u.get("orgId") ?? undefined, limit: Number(u.get("limit") ?? 200) }) });
  } catch (e) {
    return handleError(e);
  }
}
