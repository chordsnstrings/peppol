import { requirePlatformAdmin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { listTenants } from "@/lib/server/admin-store";

export const runtime = "nodejs";

/** List all workspaces with rollup stats. */
export async function GET(req: Request) {
  try {
    await requirePlatformAdmin();
    const search = new URL(req.url).searchParams.get("q") ?? undefined;
    return json({ tenants: await listTenants({ search, limit: 300 }) });
  } catch (e) {
    return handleError(e);
  }
}
