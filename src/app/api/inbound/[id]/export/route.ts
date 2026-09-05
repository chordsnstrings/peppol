import { requireWritableSession } from "@/lib/server/org-status";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { markInboundExported } from "@/lib/server/inbound";

export const runtime = "nodejs";

/**
 * Mark an arrival as taken into the books.
 *
 * A marker and nothing more — see `markInboundExported`. It is a server route
 * rather than a client store write so the browser never posts the whole record
 * back, which is the only way the fields the receiver owns stay the receiver's.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    await assertSameOrigin(req);
    const { orgId } = await requireWritableSession();
    const result = await markInboundExported(orgId, id);
    if (!result.ok) return json({ error: result.error }, result.status);
    return json({ doc: result.doc });
  } catch (e) {
    return handleError(e);
  }
}
