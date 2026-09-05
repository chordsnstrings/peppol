import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { json, handleError } from "@/lib/server/http";
import { cashFlowStatement } from "@/lib/server/ledger/cashflow";
import { LedgerError } from "@/lib/server/ledger/post";

export const runtime = "nodejs";

/**
 * The cash flow statement for a period, by the indirect method.
 *
 * It is returned whether or not it reconciles. A statement that does not tie to
 * the movement on the cash accounts carries `reconciles: false`, the difference
 * and a warning naming what was missed — refusing to return it would hide the
 * one report that can find the coding gap.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    /* A statement, drawn from entries already posted: a read. */
    await requirePermission({ orgId, userId, permission: "ledger.read" });
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!entityId || !from || !to) return json({ error: "entityId, from and to are required." }, 400);

    const cashFlow = await cashFlowStatement({ orgId, entityId, from, to });
    return json({ cashFlow });
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
