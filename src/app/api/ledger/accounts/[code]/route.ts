import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { generalLedger } from "@/lib/server/ledger/reports";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/** General-ledger detail for one account — the drill-down target. */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    const { orgId } = await requireSession();
    const { code } = await ctx.params;
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    return json(ledgerJson(await generalLedger({
      orgId, entityId, accountCode: code,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: Math.min(Number(url.searchParams.get("limit") ?? 200), 1000),
    })));
  } catch (e) {
    return handleError(e);
  }
}
