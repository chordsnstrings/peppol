import { requireWritableSession } from "@/lib/server/org-status";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { recordInboundDecision } from "@/lib/server/inbound";
import type { ReceiptDecision } from "@/lib/gateway/port";

export const runtime = "nodejs";

/**
 * Accept or reject a document a supplier sent us — the other half of corner 4.
 *
 * The decision is recorded here and transmitted where the gateway can carry it;
 * the answer says which of those two happened, because "rejected" on a screen
 * has to mean the supplier was told or say plainly that they were not.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await assertSameOrigin(req);
    const { orgId, userId } = await requireWritableSession();
    const body = (await req.json().catch(() => ({}))) as { decision?: string; reason?: string };

    const outcome: ReceiptDecision | null =
      body.decision === "ACCEPTED" || body.decision === "REJECTED" ? body.decision : null;
    if (!outcome) return json({ error: "decision must be ACCEPTED or REJECTED" }, 400);

    const result = await recordInboundDecision(orgId, id, { outcome, reason: body.reason, actor: userId });
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ doc: result.doc });
  } catch (e) {
    return handleError(e);
  }
}
