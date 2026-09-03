import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { vatReturn } from "@/lib/server/ledger/vat";
import { LedgerError } from "@/lib/server/ledger/post";

export const runtime = "nodejs";

/** The VAT 201 return for a period, computed from the ledger. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!entityId || !from || !to) return json({ error: "entityId, from and to are required." }, 400);
    return json(await vatReturn({ orgId, entityId, from, to }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
