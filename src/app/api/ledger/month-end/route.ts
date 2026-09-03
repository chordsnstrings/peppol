import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { monthEnd, closeMonth } from "@/lib/server/ledger/month-end";

export const runtime = "nodejs";

/** What is still stopping this month from being closed. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    const period = q.get("period") ?? new Date().toISOString().slice(0, 7);
    if (!entityId) return json({ error: "entityId required" }, 400);
    return json(ledgerJson(await monthEnd({ orgId, entityId, period })));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Close the month. The checks run again here rather than being trusted from
 * the screen: a checklist read five minutes ago is one somebody else may have
 * invalidated since, and this is the action that shuts the door.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      entityId?: string;
      period?: string;
      acceptAdvisories?: boolean;
    };
    if (!b.entityId || !b.period) return json({ error: "entityId and period are required." }, 400);
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "period.close" });

    return json(ledgerJson(await closeMonth({
      orgId, entityId: b.entityId, period: b.period, acceptAdvisories: b.acceptAdvisories === true,
    })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
