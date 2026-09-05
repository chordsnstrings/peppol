import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { json, handleError } from "@/lib/server/http";
import { vatReturn } from "@/lib/server/ledger/vat";
import { LedgerError } from "@/lib/server/ledger/post";

export const runtime = "nodejs";

/** The VAT 201 return for a period, computed from the ledger. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!entityId || !from || !to) return json({ error: "entityId, from and to are required." }, 400);
    /* Reading the return, not signing it — so this is `ledger.read` and not
     * `tax.file`.
     *
     * The return is nothing but journal lines `ledger.read` already covers,
     * grouped by the tax treatment each was raised under; the module computes
     * it from the same rows as the trial balance precisely so the two cannot
     * disagree. A bookkeeper who may open every journal and every statement
     * can already add the boxes up by hand, so putting `tax.file` on the total
     * would stop nobody — it would only send them to the accountant to have a
     * screen read out to them.
     *
     * `tax.file` guards the act its own sentence names: marking a return
     * filed, which is the tax-periods route, and locking a computation, which
     * is corptax. Preparing figures and signing for them are two jobs, and the
     * shipped BOOKKEEPER holds the first without the second. Nothing here
     * writes anything. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    return json(await vatReturn({ orgId, entityId, from, to }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
