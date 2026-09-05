import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { json, handleError } from "@/lib/server/http";
import { payablesAgeing } from "@/lib/server/ledger/ap";
import { LedgerError } from "@/lib/server/ledger/post";

export const runtime = "nodejs";

/** Payables ageing, derived from the ledger. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* What we owe and how late it is, read out of the ledger. Reading it is not
     * the same power as raising a bill, so it takes the read key. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    const asOf = url.searchParams.get("asOf");
    return json(await payablesAgeing({ orgId, entityId, asOf: asOf ? new Date(asOf) : undefined }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
