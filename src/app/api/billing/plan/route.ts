import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getPlan, setPlan } from "@/lib/server/billing";
import { isPlanCode } from "@/lib/domain/billing";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { orgId } = await requireSession();
    return json({ plan: await getPlan(orgId) });
  } catch (e) {
    return handleError(e);
  }
}

/** Change the tenant's plan. Owner/admin gate is enforced client-side today; the
 * write is org-scoped so a tenant can only change its own plan. */
export async function PUT(req: Request) {
  try {
    const { orgId } = await requireSession();
    const body = (await req.json().catch(() => ({}))) as { plan?: string };
    if (!body.plan || !isPlanCode(body.plan)) return json({ error: "Unknown plan" }, 400);
    await setPlan(orgId, body.plan);
    return json({ plan: body.plan });
  } catch (e) {
    return handleError(e);
  }
}
