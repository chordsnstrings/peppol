import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { json, handleError } from "@/lib/server/http";
import { ledgerAnalytics } from "@/lib/server/ledger/analytics";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";

export const runtime = "nodejs";

/**
 * Every analytical test over the ledger, in one response.
 *
 * One request rather than one per test, for the same reason the attention list
 * is one request: a screen assembled from ten round trips arrives in ten pieces
 * and is read as ten screens. The tests share a single read of the ledger, so
 * splitting them would also mean reading the same entries ten times over.
 *
 * A test that fails comes back in `runs` with an outcome of "failed" rather
 * than as an HTTP error. The whole point of the module is that a missing
 * account costs one row instead of the page, and a 500 here would undo that on
 * the way out. The only things that produce an error status are a date that is
 * not a date and a window that runs backwards — both of which are the caller's
 * question being wrong rather than the answer.
 *
 * `from` and `to` are accepted so a finding can be reproduced: "the duplicate
 * we found in the second quarter" is only useful to somebody else if the link
 * they are sent shows them the same thing. `from` omitted means everything the
 * ledger holds, which is what the unusual-pairing test wants — frequency
 * against the entity's own history is only honest over as much history as there
 * is.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);
    /* Every test in here reads one entity's journals and writes nothing. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    const from = url.searchParams.get("from") ?? undefined;
    const to = url.searchParams.get("to") ?? undefined;

    return json(ledgerJson(await ledgerAnalytics({ orgId, entityId, from, to })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
