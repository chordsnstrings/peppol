import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  deferredTaxNote,
  deriveFromAssets,
  position,
  postDeferredTax,
  recordItems,
  reportingDates,
  type DeferredTaxItemInput,
} from "@/lib/server/ledger/deferred-tax";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/**
 * The deferred tax register, the position it produces, and the entry that puts
 * the movement on the ledger.
 *
 * Every handler passes both the session's org and the request's entity through
 * to the module. The entity id arrives from the client and is never trusted on
 * its own — it is only ever a filter applied inside the caller's org, so a
 * guessed id reads nothing.
 */

export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const params = new URL(req.url).searchParams;
    const entityId = params.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);
    /* The register, the position and the IAS 12 note are a report over the
     * ledger, and reading the reports is `ledger.read`. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    // The date picker needs the register's dates before it can choose one, so
    // this view answers without an asOf.
    if (params.get("view") === "dates") {
      return json(ledgerJson({ dates: await reportingDates({ orgId, entityId }) }));
    }

    const asOf = params.get("asOf");
    if (!asOf) return json({ error: "asOf is required — a deferred tax position is measured at a reporting date." }, 400);

    if (params.get("view") === "derive") {
      const rate = params.get("taxDepreciationRateBps");
      if (rate === null || rate.trim() === "") {
        return json(
          { error: "taxDepreciationRateBps is required. UAE tax depreciation is not implemented, so the rate is an input." },
          400,
        );
      }
      const taxRate = params.get("taxRateBps");
      return json(
        ledgerJson(
          await deriveFromAssets({
            orgId,
            entityId,
            asOf,
            taxDepreciationRateBps: Number(rate),
            ...(taxRate !== null && taxRate.trim() !== "" ? { taxRateBps: Number(taxRate) } : {}),
          }),
        ),
      );
    }

    // The position and the note are read together because they have to agree,
    // and two round trips is two chances for them to be read at different
    // moments and disagree on screen.
    const [pos, note, dates] = await Promise.all([
      position({ orgId, entityId, asOf }),
      deferredTaxNote({ orgId, entityId, asOf }),
      reportingDates({ orgId, entityId }),
    ]);
    return json(ledgerJson({ position: pos, note, dates }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Record the register at a reporting date, or post the movement to it. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "record" | "post";
      entityId?: string;
      asOf?: string;
      items?: DeferredTaxItemInput[];
    };
    if (!b.entityId) return json({ error: "entityId is required." }, 400);
    if (!b.asOf) return json({ error: "asOf is required — a deferred tax position is measured at a reporting date." }, 400);
    /* Deferred tax posts to the ledger and belongs to no subledger, so
     * `ledger.post` — and deliberately not `tax.file`. Nothing here reaches a
     * return: an IAS 12 position is a measurement made for the financial
     * statements and the FTA never sees it. `record` writes no journal of its
     * own, but it fixes the figure `post` puts on the ledger, so guarding the
     * two differently would be guarding the second door only. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });

    switch (b.action) {
      case "record": {
        // An absent list and an empty one are different: an empty register at a
        // date is a measurement saying every difference has reversed, and it
        // has to be possible to say that. A missing list is a malformed request.
        if (!Array.isArray(b.items)) {
          return json({ error: "items must be a list, even an empty one — an empty register is a measurement too." }, 400);
        }
        return json(ledgerJson(await recordItems({ orgId, entityId: b.entityId, asOf: b.asOf, items: b.items })));
      }

      case "post":
        return json(
          ledgerJson(await postDeferredTax({ orgId, entityId: b.entityId, asOf: b.asOf, actorId: userId })),
        );

      default:
        return json({ error: "Unknown action. Use \"record\" to measure a reporting date, or \"post\" to put its movement on the ledger." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
