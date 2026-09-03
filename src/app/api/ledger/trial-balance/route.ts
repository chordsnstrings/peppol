import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { trialBalance } from "@/lib/server/ledger/reports";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const period = url.searchParams.get("period");
    if (!entityId || !period) return json({ error: "entityId and period are required." }, 400);
    return json(ledgerJson(await trialBalance({ orgId, entityId, periodLabel: period })));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
