import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { directCashFlow } from "@/lib/server/ledger/cashflow-direct";

export const runtime = "nodejs";

/** Cash flows by the direct method, with the IAS 7.20 reconciliation beside them. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    const from = q.get("from");
    const to = q.get("to");
    if (!entityId) return json({ error: "entityId required" }, 400);
    if (!from || !to) return json({ error: "A cash flow statement needs the dates it covers." }, 400);

    return json(ledgerJson(await directCashFlow({
      orgId, entityId, from, to, bookCode: q.get("bookCode") ?? undefined,
    })));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
