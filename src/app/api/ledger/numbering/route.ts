import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { numberingOverview, previewSeries, configureSeries, type SeriesPatch } from "@/lib/server/ledger/numbering";

export const runtime = "nodejs";

/**
 * The number series an entity uses, and what a proposed change to one would
 * produce. Both are reads: a preview writes nothing, which is the point of it.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The document sequences and what the next number would be. Changing a
     * sequence is `setup.manage` on the POST — a gapless series is a control,
     * and moving it is a decision about the books. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    if (q.get("view") === "preview") {
      const scope = q.get("scope");
      if (!scope) return json({ error: "Which series?" }, 400);
      // An absent parameter means "leave it as it is"; an empty prefix is a
      // real setting and has to survive the round trip as one.
      const patch: SeriesPatch = {
        ...(q.has("prefix") ? { prefix: q.get("prefix") ?? "" } : {}),
        ...(q.has("padding") ? { padding: Number(q.get("padding")) } : {}),
        ...(q.has("restartYearly") ? { restartYearly: q.get("restartYearly") === "true" } : {}),
      };
      return json(ledgerJson({ preview: await previewSeries({ orgId, entityId, scope, patch }) }));
    }

    return json(ledgerJson(await numberingOverview({ orgId, entityId })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Change a series' format. Only the format: a body that tries to move the
 * counter is refused by the module, by name, rather than ignored — a request
 * that silently does nothing is worse than one that is turned down.
 */
export async function PATCH(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const entityId = typeof body.entityId === "string" ? body.entityId : null;
    const scope = typeof body.scope === "string" ? body.scope : null;
    if (!entityId) return json({ error: "entityId required" }, 400);
    if (!scope) return json({ error: "Which series?" }, 400);

    // Numbering is part of setting the books up: it decides what every
    // document in them is called.
    await requirePermission({ orgId, userId, entityId, permission: "setup.manage" });

    const patch = { ...body };
    delete patch.entityId;
    delete patch.scope;

    return json(ledgerJson(await configureSeries({
      orgId, entityId, scope,
      patch: patch as SeriesPatch & Record<string, unknown>,
      actorId: userId,
    })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
