import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { cashForecast, cashPosition, paymentBehaviour } from "@/lib/server/ledger/forecast";

export const runtime = "nodejs";

/**
 * The projection, the cash position behind it, or what the ledger says about
 * how late customers actually pay. One request, because a forecast screen that
 * needs three round trips is a forecast screen nobody waits for.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId };

    if (q.get("view") === "behaviour") {
      const b = await paymentBehaviour(scope);
      return json(ledgerJson({ overall: b.overall, byCustomer: [...b.byMemo.values()] }));
    }

    const today = new Date().toISOString().slice(0, 10);
    const from = q.get("from") ?? today;
    const to = q.get("to") ?? new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const bucket = q.get("bucket") === "month" ? "month" : "week";
    const basis = q.get("basis") === "behaviour" ? "behaviour" : "due";

    const [forecast, position] = await Promise.all([
      cashForecast({ ...scope, from, to, bucket, basis }),
      cashPosition({ ...scope, asOf: from }),
    ]);
    return json(ledgerJson({ forecast, position }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
