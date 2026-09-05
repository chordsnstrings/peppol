import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { directCashFlow } from "@/lib/server/ledger/cashflow-direct";

export const runtime = "nodejs";

/** Cash flows by the direct method, with the IAS 7.20 reconciliation beside them. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    const from = q.get("from");
    const to = q.get("to");
    if (!entityId) return json({ error: "entityId required" }, 400);
    if (!from || !to) return json({ error: "A cash flow statement needs the dates it covers." }, 400);
    /* The same statement by the other method, and the same read — of the one
     * entity named in the query. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    return json(ledgerJson(await directCashFlow({
      orgId, entityId, from, to, bookCode: q.get("bookCode") ?? undefined,
    })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
