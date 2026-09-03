import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  addItem, receive, issue, adjust, assessNrv, setCostMethod, stockValuation, itemHistory,
} from "@/lib/server/ledger/inventory";

export const runtime = "nodejs";

/** The stock valuation, or one item's movement history. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);

    const sku = url.searchParams.get("sku");
    if (sku) return json(await itemHistory({ orgId, entityId, sku }));
    return json(await stockValuation({ orgId, entityId, asOf: url.searchParams.get("asOf") ?? undefined }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Add an item, move stock, assess its net realisable value, or change how it is costed. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "add" | "receive" | "issue" | "count" | "nrv" | "method";
      entityId?: string;
      sku?: string;
      name?: string;
      nameAr?: string;
      uom?: string;
      costMethod?: string;
      movedOn?: string;
      quantityMilli?: number | string;
      valueMinor?: number | string;
      countedMilli?: number | string;
      nrvMinor?: number | string | null;
      contraAccount?: string;
      reference?: string;
      memo?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);

    switch (b.action) {
      case "add": {
        if (!b.sku || !b.name) return json({ error: "An item needs a SKU and a name." }, 400);
        const item = await addItem({
          orgId, entityId: b.entityId,
          item: { sku: b.sku, name: b.name, nameAr: b.nameAr, uom: b.uom, costMethod: b.costMethod },
        });
        return json({ item: { sku: item.sku, name: item.name, uom: item.uom, costMethod: item.costMethod } });
      }

      case "receive":
        if (!b.sku || !b.movedOn || b.quantityMilli === undefined || b.valueMinor === undefined) {
          return json({ error: "A receipt needs an item, a date, a quantity and what it cost." }, 400);
        }
        return json(await receive({
          orgId, entityId: b.entityId, sku: b.sku, movedOn: b.movedOn,
          quantityMilli: b.quantityMilli, valueMinor: b.valueMinor,
          contraAccount: b.contraAccount, reference: b.reference, memo: b.memo, actorId: userId,
        }));

      case "issue":
        if (!b.sku || !b.movedOn || b.quantityMilli === undefined) {
          return json({ error: "An issue needs an item, a date and a quantity." }, 400);
        }
        return json(await issue({
          orgId, entityId: b.entityId, sku: b.sku, movedOn: b.movedOn,
          quantityMilli: b.quantityMilli, reference: b.reference, memo: b.memo, actorId: userId,
        }));

      case "count":
        if (!b.sku || !b.movedOn || b.countedMilli === undefined) {
          return json({ error: "A stock count needs an item, a date and the quantity counted." }, 400);
        }
        return json(await adjust({
          orgId, entityId: b.entityId, sku: b.sku, movedOn: b.movedOn,
          countedMilli: b.countedMilli, reference: b.reference, reason: b.memo, actorId: userId,
        }));

      case "nrv":
        // nrvMinor is deliberately not defaulted: nobody having assessed the
        // item and somebody assessing it at nothing are different facts, and
        // the module refuses to guess which one an empty field meant.
        if (!b.sku || !b.movedOn) {
          return json({ error: "An assessment needs an item and the date it was made." }, 400);
        }
        return json(await assessNrv({
          orgId, entityId: b.entityId, sku: b.sku, on: b.movedOn,
          nrvMinor: b.nrvMinor, memo: b.memo, actorId: userId,
        }));

      case "method":
        if (!b.sku || !b.costMethod) return json({ error: "Say which item, and which cost method." }, 400);
        return json(await setCostMethod({ orgId, entityId: b.entityId, sku: b.sku, costMethod: b.costMethod }));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
