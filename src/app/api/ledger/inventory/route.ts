import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  addItem, receive, issue, adjust, assessNrv, setCostMethod, stockValuation, itemHistory,
  addLocation, updateLocation, closeLocation, locationList, stockByLocation, transferStock,
  batchRegister, expiringStock, sweepExpired, belowReorderLevel, setReorderLevel, setDefaultLocation,
} from "@/lib/server/ledger/inventory";

export const runtime = "nodejs";

/**
 * The stock valuation, one item's movement history, or the stocking picture —
 * where the goods are, which lots they are in, what is about to go off and what
 * needs ordering.
 *
 * The stocking reads come back together because the screen shows them together
 * and four round trips to draw one page is four chances for the four halves of
 * it to disagree about what "now" means.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The stock valuation is a balance sheet figure and the rest of these reads
     * explain it. Reading them is reading the books. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    if (url.searchParams.get("view") === "stocking") {
      const within = Number(url.searchParams.get("within") ?? 30);
      const [locations, byLocation, batches, expiring, reorder] = await Promise.all([
        locationList({ orgId, entityId }),
        stockByLocation({ orgId, entityId }),
        batchRegister({ orgId, entityId }),
        expiringStock({ orgId, entityId, within: Number.isInteger(within) && within >= 0 ? within : 30 }),
        belowReorderLevel({ orgId, entityId }),
      ]);
      return json({ ...locations, byLocation, ...batches, expiring, reorder });
    }

    const sku = url.searchParams.get("sku");
    if (sku) return json(await itemHistory({ orgId, entityId, sku }));
    return json(await stockValuation({ orgId, entityId, asOf: url.searchParams.get("asOf") ?? undefined }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Add an item, move stock, transfer it between locations, assess its net
 * realisable value, sweep what has expired, or change how it is costed and when
 * it is reordered.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?:
        | "add" | "receive" | "issue" | "count" | "nrv" | "method"
        | "add-location" | "update-location" | "close-location" | "default-location"
        | "transfer" | "reorder" | "sweep";
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
      /** Where the stock moved, and which lot it was. */
      location?: string;
      batch?: string;
      batchKind?: string;
      expiresOn?: string | null;
      /** A location's own fields. */
      code?: string;
      address?: string;
      isDefault?: boolean;
      /** A transfer's two ends. */
      from?: string;
      to?: string;
      /** Thousandths, or null to say nobody has set a level. */
      reorderLevelMilli?: number | string | null;
      sweepAction?: "quarantine" | "write_off";
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);

    /* Two keys, and the line between them is whether the action is a purchase.
     *
     * A goods receipt is the purchase side — it is the same act procurement.ts
     * records against an order, reached here without one — so it takes the
     * purchase-ledger key.
     *
     * Everything else takes `ledger.post`, because everything else either
     * writes a journal into the general ledger (an issue to cost of sales, a
     * count difference to stock variance, an NRV write-down under IAS 2, a
     * sweep that writes expired stock off) or decides what a future journal
     * will say (a cost method, a location, a reorder level, a transfer that
     * moves the stock the valuation is built from). None of it is a bill to a
     * supplier, so `ap.manage` would be the wrong key for it.
     *
     * What I would have wanted is an `inventory.manage` key for the master
     * data — adding a SKU or naming a warehouse is not really posting — but the
     * catalogue has no such key, and `ledger.post` is the closest one held by
     * the people who keep stock records. */
    await requirePermission({
      orgId, userId, entityId: b.entityId,
      permission: b.action === "receive" ? "ap.manage" : "ledger.post",
    });

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
          contraAccount: b.contraAccount, reference: b.reference, memo: b.memo,
          location: b.location,
          batch: b.batch?.trim() ? { code: b.batch, kind: b.batchKind, expiresOn: b.expiresOn } : undefined,
          actorId: userId,
        }));

      case "issue":
        if (!b.sku || !b.movedOn || b.quantityMilli === undefined) {
          return json({ error: "An issue needs an item, a date and a quantity." }, 400);
        }
        return json(await issue({
          orgId, entityId: b.entityId, sku: b.sku, movedOn: b.movedOn,
          quantityMilli: b.quantityMilli, reference: b.reference, memo: b.memo,
          location: b.location, batch: b.batch, actorId: userId,
        }));

      case "count":
        if (!b.sku || !b.movedOn || b.countedMilli === undefined) {
          return json({ error: "A stock count needs an item, a date and the quantity counted." }, 400);
        }
        return json(await adjust({
          orgId, entityId: b.entityId, sku: b.sku, movedOn: b.movedOn,
          countedMilli: b.countedMilli, reference: b.reference, reason: b.memo,
          location: b.location, batch: b.batch, actorId: userId,
        }));

      case "transfer":
        if (!b.sku || !b.from || !b.to || b.quantityMilli === undefined || !b.movedOn) {
          return json({ error: "A transfer needs an item, where it left, where it went, a quantity and a date." }, 400);
        }
        return json(await transferStock({
          orgId, entityId: b.entityId, sku: b.sku, from: b.from, to: b.to,
          quantityMilli: b.quantityMilli, on: b.movedOn,
          batch: b.batch, reference: b.reference, memo: b.memo, actorId: userId,
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

      case "add-location":
        if (!b.code || !b.name) return json({ error: "A location needs a code and a name." }, 400);
        return json({
          location: await addLocation({
            orgId, entityId: b.entityId, code: b.code, name: b.name,
            nameAr: b.nameAr, address: b.address, isDefault: b.isDefault,
          }),
        });

      case "update-location":
        if (!b.code) return json({ error: "Say which location." }, 400);
        return json({
          location: await updateLocation({
            orgId, entityId: b.entityId, code: b.code,
            name: b.name, nameAr: b.nameAr, address: b.address, isDefault: b.isDefault,
          }),
        });

      case "close-location":
        if (!b.code) return json({ error: "Say which location." }, 400);
        return json({ location: await closeLocation({ orgId, entityId: b.entityId, code: b.code }) });

      case "default-location":
        if (!b.sku) return json({ error: "Say which item." }, 400);
        return json(await setDefaultLocation({
          orgId, entityId: b.entityId, sku: b.sku, location: b.location ?? null,
        }));

      case "reorder":
        // Undefined is not nil: leaving the field out is a request with nothing
        // in it, whereas an explicit null says nobody is watching this item.
        if (!b.sku || b.reorderLevelMilli === undefined) {
          return json({ error: "A reorder level needs an item and a level — or an explicit nil to clear it." }, 400);
        }
        return json(await setReorderLevel({
          orgId, entityId: b.entityId, sku: b.sku, reorderLevelMilli: b.reorderLevelMilli,
        }));

      case "sweep":
        if (!b.movedOn) return json({ error: "A sweep needs the date it was made." }, 400);
        return json(await sweepExpired({
          orgId, entityId: b.entityId, on: b.movedOn,
          action: b.sweepAction ?? "quarantine", reason: b.memo, actorId: userId,
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
