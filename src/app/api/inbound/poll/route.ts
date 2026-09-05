import { requireWritableSession } from "@/lib/server/org-status";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { pollInbound } from "@/lib/server/inbound";

export const runtime = "nodejs";

/**
 * Ask the gateway what is waiting for this entity's participant.
 *
 * A driver that pushes over its webhook answers with nothing and that is the
 * correct answer; the mock answers with a sample so a deployment that has never
 * been on the network can still see the receiving path work end to end.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId } = await requireWritableSession();
    const { entityId } = (await req.json().catch(() => ({}))) as { entityId?: string };
    if (!entityId) return json({ error: "entityId required" }, 400);

    const result = await pollInbound(orgId, entityId);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({
      received: result.received,
      duplicates: result.duplicates,
      skipped: result.skipped,
      simulated: result.simulated,
    });
  } catch (e) {
    return handleError(e);
  }
}
