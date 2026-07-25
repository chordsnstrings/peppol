import { requirePlatformAdmin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";

export const runtime = "nodejs";

/** The current operator's identity + role, or 403 if not a platform admin. */
export async function GET() {
  try {
    const admin = await requirePlatformAdmin();
    return json({ admin: { userId: admin.userId, email: admin.email, name: admin.name, role: admin.role, viaAllowlist: admin.viaAllowlist } });
  } catch (e) {
    return handleError(e);
  }
}
