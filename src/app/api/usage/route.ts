import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { usageSummary } from "@/lib/server/billing";

export const runtime = "nodejs";

/** Authoritative billing meter for one entity this year. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const entityId = new URL(req.url).searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    return json(await usageSummary(orgId, entityId));
  } catch (e) {
    return handleError(e);
  }
}
