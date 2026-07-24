import { json, handleError } from "@/lib/server/http";
import { authenticateApiKey } from "@/lib/server/api-key";
import { runSendPipeline } from "@/lib/server/send";

export const runtime = "nodejs";

/** POST /api/v1/invoices/:id/send — run the send pipeline for an existing invoice. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { orgId } = await authenticateApiKey(req);
    const { id } = await ctx.params;
    const outcome = await runSendPipeline(orgId, id);
    if (!outcome.ok) return json({ error: outcome.error, issues: outcome.issues }, outcome.status);
    return json({ invoice: outcome.invoice, blocked: outcome.blocked });
  } catch (e) {
    return handleError(e);
  }
}
