import { json, handleError } from "@/lib/server/http";
import { authenticateApiKey } from "@/lib/server/api-key";
import { getRecord } from "@/lib/server/store";
import type { Invoice } from "@/lib/domain/types";

export const runtime = "nodejs";

/** GET /api/v1/invoices/:id — fetch one invoice. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { orgId } = await authenticateApiKey(req);
    const { id } = await ctx.params;
    const invoice = await getRecord<Invoice>(orgId, "invoices", id);
    if (!invoice) return json({ error: "Not found" }, 404);
    return json({ invoice });
  } catch (e) {
    return handleError(e);
  }
}
