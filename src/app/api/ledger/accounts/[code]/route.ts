import { requireSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/ledger/permissions";
import { json, handleError } from "@/lib/server/http";
import { generalLedger } from "@/lib/server/ledger/reports";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/** General-ledger detail for one account — the drill-down target. */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  try {
    const { orgId, userId } = await requireSession();
    const { code } = await ctx.params;
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The general ledger behind one account is a read of the books, and it is
     * read on one entity's chart — so the grant has to cover that entity. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
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
