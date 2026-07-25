import { requirePlatformAdmin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { overview } from "@/lib/server/admin-store";

export const runtime = "nodejs";

/** Platform-wide KPIs. Aggregate metrics — not audited per-read. */
export async function GET() {
  try {
    await requirePlatformAdmin();
    return json(await overview());
  } catch (e) {
    return handleError(e);
  }
}
