import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  revalueAsset, releaseSurplus, revaluationRegister, revaluationHistory,
} from "@/lib/server/ledger/asset-revaluation";

export const runtime = "nodejs";

/** The revaluation register with the equity balance it must agree with, or one asset's history. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The revaluation register and one asset's history are a read of the
     * books, the same as the fixed asset register they belong beside. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    const code = q.get("code");
    if (code) return json(ledgerJson(await revaluationHistory({ orgId, entityId, code })));
    return json(ledgerJson(await revaluationRegister({ orgId, entityId })));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Value an asset, or realise a surplus.
 *
 * There is no "impair" action. Whether a movement is a revaluation, an
 * impairment or a reversal is what the same act is called afterwards, given
 * which way the value moved and what happened to this asset before — asking
 * somebody to pick the label first would be asking them to apply the rule this
 * exists to apply.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "revalue" | "release";
      entityId?: string;
      code?: string;
      on?: string;
      fairValueMinor?: string;
      amountMinor?: string;
      basis?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "asset.manage" });
    const scope = { orgId, entityId: b.entityId };

    switch (b.action) {
      case "revalue":
        if (!b.code || !b.on || b.fairValueMinor === undefined) {
          return json({ error: "A valuation needs the asset, the date, and what it was assessed to be worth." }, 400);
        }
        return json(ledgerJson(await revalueAsset({
          ...scope, code: b.code, on: b.on, fairValueMinor: b.fairValueMinor, basis: b.basis, actorId: userId,
        })));

      case "release":
        if (!b.code || !b.on) return json({ error: "A transfer needs the asset and the date." }, 400);
        return json(ledgerJson(await releaseSurplus({
          ...scope, code: b.code, on: b.on, amountMinor: b.amountMinor, actorId: userId,
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
