import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { receivablesAgeing } from "@/lib/server/ledger/ar";
import { LedgerError } from "@/lib/server/ledger/post";

export const runtime = "nodejs";

/** Receivables ageing, derived from the ledger rather than from the documents. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    const asOf = url.searchParams.get("asOf");
    return json(await receivablesAgeing({ orgId, entityId, asOf: asOf ? new Date(asOf) : undefined }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
