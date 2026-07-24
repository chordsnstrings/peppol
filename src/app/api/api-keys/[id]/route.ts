import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { revokeApiKey } from "@/lib/server/api-key";

export const runtime = "nodejs";

/** Revoke an API key. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { orgId } = await requireSession();
    const ok = await revokeApiKey(orgId, id);
    return json({ ok });
  } catch (e) {
    return handleError(e);
  }
}
