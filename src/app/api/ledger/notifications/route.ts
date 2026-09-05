import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  notificationCentre,
  notificationHistory,
  acknowledge,
  snooze,
  bringBack,
} from "@/lib/server/ledger/notifications";

export const runtime = "nodejs";

/**
 * The whole queue in one response.
 *
 * One request rather than one per source, for the same reason the attention
 * list is one request: a queue that costs eight round trips arrives in eight
 * pieces and is read as eight screens. The sources run concurrently on the
 * server and one that cannot be read comes back as a row inside the list rather
 * than as an HTTP error — the entire point is that a missing account costs one
 * row instead of the page, and a 500 here would undo that on the way out.
 *
 * `asOf` is accepted so a queue can be reproduced. "We were told this on the
 * 3rd" is a question people ask about a nag list, and a screen that can only
 * ever show today cannot answer it.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;

    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);
    /* The queue is assembled out of reads of one entity's books, so it is one. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    const asOf = q.get("asOf") ?? undefined;

    // One notification's history: who dealt with it, when, and why. Asked for
    // by key rather than filtered out of the list, because the log outlives the
    // finding — a row nobody can see any more still has a history.
    const key = q.get("key");
    if (key) return json(ledgerJson(await notificationHistory({ orgId, entityId, key })));

    return json(ledgerJson(await notificationCentre({ orgId, entityId, asOf })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Acknowledge, snooze, or put a row back on the queue.
 *
 * Each returns the whole centre rather than the one row it touched. Dealing
 * with a notification changes the counts, the digest and what is due this week,
 * and a screen that had to ask again for those would show a stale summary above
 * a fresh list for as long as the second request took.
 *
 * Who did it comes from the session and never from the body. An acknowledgement
 * naming somebody who did not make it is worse than no acknowledgement, and a
 * body the client controls is not evidence of anything.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "acknowledge" | "snooze" | "clear";
      entityId?: string;
      key?: string;
      reason?: string;
      until?: string;
      asOf?: string;
    };

    if (!b.entityId) return json({ error: "entityId is required." }, 400);
    if (!b.key) return json({ error: "Which notification?" }, 400);

    /* This one writes: acknowledging or snoozing a row takes a finding off
     * everybody's queue, not just the acknowledger's. There is no notifications
     * key in the catalogue and "notifications.manage" is what this would have
     * asked for. Of the twenty-one that exist the read key is the closest — the
     * people who work this queue are bookkeepers and accountants, and putting it
     * behind the setup key would lock the queue's own audience out of it.
     *
     * Checked after the body is read because the queue being cleared is one
     * entity's: everybody's queue is everybody working on that entity, and a
     * grant on a sister company is not one of them. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.read" });

    const act = {
      orgId,
      entityId: b.entityId,
      key: b.key,
      actorId: userId,
      reason: b.reason,
      asOf: b.asOf,
    };

    switch (b.action) {
      case "acknowledge":
        return json(ledgerJson(await acknowledge(act)));

      case "snooze":
        // Not defaulted to a week. A snooze is a person naming the day they
        // want the thing back, and a date the screen picked for them is a date
        // nobody meant.
        if (!b.until) return json({ error: "Which day should it come back?" }, 400);
        return json(ledgerJson(await snooze({ ...act, until: b.until })));

      case "clear":
        return json(ledgerJson(await bringBack(act)));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
