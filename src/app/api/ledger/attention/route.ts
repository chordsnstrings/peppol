import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { attentionList } from "@/lib/server/ledger/attention";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";

export const runtime = "nodejs";

/**
 * Everything waiting for somebody, in one response.
 *
 * One request rather than one per check, because a dashboard that costs eight
 * round trips arrives in eight pieces and is read as eight screens. The checks
 * run concurrently on the server and a check that fails comes back in `failed`
 * rather than as an HTTP error — the whole point of the list is that a missing
 * account degrades one row instead of the page, and a 500 here would undo that
 * on the way out.
 *
 * `asOf` is accepted so a finding can be reproduced later: "we were told this
 * on the 3rd" is a question people ask about a nag list, and a screen that can
 * only ever show today cannot answer it.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);
    const asOf = url.searchParams.get("asOf") ?? undefined;

    return json(ledgerJson(await attentionList({ orgId, entityId, asOf })));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
