import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { profitAndLoss, balanceSheet } from "@/lib/server/ledger/statements";
import { LedgerError } from "@/lib/server/ledger/post";

export const runtime = "nodejs";

/**
 * The profit and loss and the balance sheet, produced from one read so they can
 * never tell different stories about the same month.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!entityId || !from || !to) return json({ error: "entityId, from and to are required." }, 400);

    const [pl, bs] = await Promise.all([
      profitAndLoss({ orgId, entityId, from, to }),
      balanceSheet({ orgId, entityId, asOf: to }),
    ]);
    return json({ profitAndLoss: pl, balanceSheet: bs });
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
