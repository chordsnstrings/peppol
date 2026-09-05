import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { addAsset, runDepreciation, disposeAsset, assetRegister, type NewAsset } from "@/lib/server/ledger/assets";

export const runtime = "nodejs";

/** The asset register, with the ledger balances it should agree with. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const entityId = new URL(req.url).searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The register and the ledger balances it is reconciled against are a
     * report. Reading it is `ledger.read`, not `asset.manage` — a Viewer who
     * may read the balance sheet may see what makes up the fixed assets on
     * it, and refusing that would hide a line of the accounts from somebody
     * who can already read the total. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    return json(await assetRegister({ orgId, entityId }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Register an asset, run a month of depreciation, or dispose of one. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "add" | "depreciate" | "dispose";
      entityId?: string;
      asset?: NewAsset;
      period?: string;
      assetCode?: string;
      disposedOn?: string;
      proceedsMinor?: number;
      proceedsAccount?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    /* "Add, revalue, depreciate and dispose of assets" is `asset.manage` word
     * for word, and add / depreciate / dispose are exactly the three actions
     * here. One guard, because no action among them lets somebody do less
     * than the others. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "asset.manage" });

    switch (b.action) {
      case "add": {
        if (!b.asset?.code || !b.asset?.name || !b.asset?.acquiredOn) {
          return json({ error: "An asset needs a code, a name and the date it was acquired." }, 400);
        }
        const asset = await addAsset({ orgId, entityId: b.entityId, asset: b.asset });
        return json({ asset: { id: asset.id, code: asset.code, name: asset.name } });
      }

      case "depreciate":
        if (!b.period) return json({ error: "Which month?" }, 400);
        return json(await runDepreciation({
          orgId, entityId: b.entityId, period: b.period, actorType: "HUMAN", actorId: userId,
        }));

      case "dispose":
        if (!b.assetCode || !b.disposedOn || b.proceedsMinor === undefined) {
          return json({ error: "A disposal needs the asset, the date and the proceeds." }, 400);
        }
        return json(await disposeAsset({
          orgId, entityId: b.entityId, assetCode: b.assetCode,
          disposedOn: b.disposedOn, proceedsMinor: b.proceedsMinor,
          proceedsAccount: b.proceedsAccount, actorId: userId,
        }));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
