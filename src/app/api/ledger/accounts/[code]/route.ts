import { requireSession } from "@/lib/server/session";
import { requirePermission } from "@/lib/server/ledger/permissions";
import { json, handleError } from "@/lib/server/http";
import { generalLedger } from "@/lib/server/ledger/reports";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/** A date from the query string, or undefined when the caller gave none. */
function day(value: string | null, name: string) {
  if (!value) return undefined;
  const d = new Date(value);
  /* An unparseable date reaches Prisma as an Invalid Date and comes back as a
   * 500 with no explanation, which tells the caller their books are broken
   * when in fact their query string is. */
  if (Number.isNaN(d.getTime())) throw new Error(`${name} is not a date I can read: ${value}`);
  return d;
}

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
    const limit = url.searchParams.get("limit");
    /* The limit is clamped by generalLedger(), which is the one place that has
     * to survive a caller asking for the whole account; here it is only read.
     * Whatever it comes to, the balances the screen presents are aggregates
     * over the whole account rather than totals of the page. */
    return json(ledgerJson(await generalLedger({
      orgId, entityId, accountCode: code,
      from: day(url.searchParams.get("from"), "from"),
      to: day(url.searchParams.get("to"), "to"),
      limit: limit === null ? undefined : Number(limit),
    })));
  } catch (e) {
    return handleError(e);
  }
}
