import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  setRate, ratesOnFile, revaluationPreview, runRevaluation, reverseRevaluation,
} from "@/lib/server/ledger/revaluation";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/**
 * What revaluing at a date would do, and the rates it would use.
 *
 * The rates come back with the preview because the commonest reason a
 * revaluation is blocked is a currency with nothing on file, and the fix is on
 * the same screen.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const asOf = url.searchParams.get("asOf");
    if (!entityId || !asOf) return json({ error: "entityId and asOf are required." }, 400);
    /* A preview of what revaluing would do, plus the rates on file. It posts
     * nothing, so `ledger.read`. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    const [preview, rates] = await Promise.all([
      revaluationPreview({ orgId, entityId, asOf, bookCode: url.searchParams.get("bookCode") ?? undefined }),
      ratesOnFile({ orgId, entityId }),
    ]);
    return json(ledgerJson({ ...preview, rates }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Record a rate, post the revaluation, or reverse one early. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "set-rate" | "revalue" | "reverse";
      entityId?: string;
      asOf?: string;
      bookCode?: string;
      currency?: string;
      rate?: number | string;
      rateDate?: string;
      source?: string;
      reversalDate?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    /* Period-end foreign currency revaluation posts a gain or a loss into
     * accounts no subledger owns, so `ledger.post`.
     *
     * The route name misleads and it is worth saying out loud: this is IAS 21
     * retranslation of monetary balances, NOT the IAS 16 revaluation of fixed
     * assets. That one lives at /api/ledger/asset-revaluation and is rightly
     * guarded by `asset.manage`. Nothing here touches an asset — the module
     * skips non-monetary items on purpose — so `asset.manage` would be the
     * wrong key however similar the two screens sound.
     *
     * `set-rate` takes the same key as the postings rather than a lighter one,
     * because the rate on file IS the size of the journal. Somebody who could
     * write a rate without being able to post could move the period's profit
     * and would only have to wait for somebody else to press revalue. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });

    switch (b.action) {
      case "set-rate": {
        if (!b.currency || b.rate === undefined || b.rate === "" || !b.rateDate) {
          return json({ error: "A rate needs the currency, the rate itself and the date it applies to." }, 400);
        }
        const row = await setRate({
          orgId, entityId: b.entityId, currency: b.currency,
          rate: b.rate, rateDate: b.rateDate, source: b.source,
        });
        return json({
          currency: row.currency,
          rate: row.rate.toFixed(),
          rateDate: row.rateDate.toISOString().slice(0, 10),
          source: row.source,
        });
      }

      case "revalue":
        if (!b.asOf) return json({ error: "As at which date?" }, 400);
        return json(ledgerJson(await runRevaluation({
          orgId, entityId: b.entityId, asOf: b.asOf, bookCode: b.bookCode,
          actorType: "HUMAN", actorId: userId,
        })));

      case "reverse":
        if (!b.asOf) return json({ error: "Which revaluation should be reversed?" }, 400);
        return json(ledgerJson(await reverseRevaluation({
          orgId, entityId: b.entityId, asOf: b.asOf, bookCode: b.bookCode,
          reversalDate: b.reversalDate, actorType: "HUMAN", actorId: userId,
        })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
