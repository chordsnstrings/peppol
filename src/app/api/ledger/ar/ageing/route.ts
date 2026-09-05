import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { json, handleError } from "@/lib/server/http";
import { receivablesAgeing } from "@/lib/server/ledger/ar";
import { LedgerError } from "@/lib/server/ledger/post";

export const runtime = "nodejs";

/** Receivables ageing, derived from the ledger rather than from the documents. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* An ageing is a report read out of the ledger and nothing more. Who owes
     * what is part of reading the books, not part of running the sales ledger. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    const asOf = url.searchParams.get("asOf");
    return json(await receivablesAgeing({ orgId, entityId, asOf: asOf ? new Date(asOf) : undefined }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
