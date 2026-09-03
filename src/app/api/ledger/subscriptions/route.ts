import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  createSubscription, pauseSubscription, resumeSubscription, endSubscription,
  dueSubscriptions, issueDue, issueAllDue, subscriptionRegister,
  type NewSubscription,
} from "@/lib/server/ledger/subscriptions";

export const runtime = "nodejs";

/** The register, or what is due to be raised as at a date. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    const asOf = q.get("asOf") ?? undefined;

    if (q.get("view") === "due") {
      return json(ledgerJson(await dueSubscriptions({ orgId, entityId, asOf })));
    }
    return json(ledgerJson(await subscriptionRegister({ orgId, entityId, asOf })));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Raising invoices needs the sales-ledger permission, not a separate one: a
 * subscription run is the ordinary act of invoicing a customer, done on a
 * schedule rather than by hand, and inventing a second permission for it would
 * be a way around the first.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "create" | "pause" | "resume" | "end" | "issue" | "issueAll";
      entityId?: string;
      code?: string;
      asOf?: string;
      on?: string;
      subscription?: NewSubscription;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ar.manage" });
    const scope = { orgId, entityId: b.entityId };

    switch (b.action) {
      case "create":
        if (!b.subscription) return json({ error: "There is no subscription to create." }, 400);
        return json(ledgerJson({ subscription: await createSubscription({ ...scope, subscription: b.subscription }) }));

      case "pause":
        if (!b.code) return json({ error: "Which subscription?" }, 400);
        return json(ledgerJson({ subscription: await pauseSubscription({ ...scope, code: b.code }) }));

      case "resume":
        if (!b.code) return json({ error: "Which subscription?" }, 400);
        return json(ledgerJson(await resumeSubscription({ ...scope, code: b.code, asOf: b.asOf })));

      case "end":
        if (!b.code) return json({ error: "Which subscription?" }, 400);
        return json(ledgerJson({ subscription: await endSubscription({ ...scope, code: b.code, on: b.on }) }));

      case "issue":
        if (!b.code) return json({ error: "Which subscription?" }, 400);
        return json(ledgerJson(await issueDue({ ...scope, code: b.code, asOf: b.asOf, actorId: userId })));

      case "issueAll":
        return json(ledgerJson(await issueAllDue({ ...scope, asOf: b.asOf, actorId: userId })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
