import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  createPriceList, setPrices, closePrice, closePriceList, assignPriceList, unassignPriceList,
  quoteLines, priceVariance, priceListRegister,
  type NewPriceList, type NewPrice, type ListKind,
} from "@/lib/server/ledger/pricing";

export const runtime = "nodejs";

/** The lists, their prices, who is priced from them, and what is wrong with the set. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* Looking at what things are sold for changes nothing. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    return json(ledgerJson(await priceListRegister({
      orgId, entityId,
      on: q.get("on") ?? undefined,
      listCode: q.get("listCode") ?? undefined,
    })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "createList" | "setPrices" | "closePrice" | "closeList" | "assign" | "unassign" | "quote" | "variance";
      entityId?: string;
      list?: NewPriceList;
      listCode?: string;
      prices?: NewPrice[];
      entryId?: string;
      validTo?: string;
      partyKey?: string;
      on?: string;
      currency?: string;
      kind?: ListKind;
      lines?: { itemCode: string; quantityMilli?: string; chargedMinor?: string }[];
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId: b.entityId };

    /* Two of these actions are questions, and they are not guarded as writes.
     * `quote` prices a basket and `variance` measures what was charged against
     * the list; neither stores anything, and the screen calls them while
     * somebody types. What a thing sells for is the sales ledger's business, so
     * the rest take that key.
     *
     * One caveat worth stating: a list may be a BUY list, and setting the price
     * a supplier charges is arguably the purchase ledger. The route cannot tell
     * which kind a stored list is without a second read, and every role that
     * keeps prices at all holds both keys, so this stays on one. */
    if (b.action === "quote" || b.action === "variance") {
      await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.read" });
    } else {
      await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ar.manage" });
    }

    switch (b.action) {
      case "createList":
        if (!b.list) return json({ error: "There is no list to create." }, 400);
        return json(ledgerJson({ list: await createPriceList({ ...scope, list: b.list }) }));

      case "setPrices":
        if (!b.listCode || !b.prices?.length) return json({ error: "Which list, and which prices?" }, 400);
        return json(ledgerJson(await setPrices({ ...scope, listCode: b.listCode, prices: b.prices })));

      case "closePrice":
        if (!b.entryId || !b.validTo) return json({ error: "Which price, and to what date?" }, 400);
        return json(ledgerJson({ price: await closePrice({ ...scope, entryId: b.entryId, validTo: b.validTo }) }));

      case "closeList":
        if (!b.listCode || !b.validTo) return json({ error: "Which list, and to what date?" }, 400);
        return json(ledgerJson({ list: await closePriceList({ ...scope, listCode: b.listCode, validTo: b.validTo }) }));

      case "assign":
        if (!b.partyKey || !b.listCode) return json({ error: "Which party, and which list?" }, 400);
        return json(ledgerJson({ assignment: await assignPriceList({ ...scope, partyKey: b.partyKey, listCode: b.listCode }) }));

      case "unassign":
        if (!b.partyKey || !b.listCode) return json({ error: "Which party, and which list?" }, 400);
        return json(ledgerJson(await unassignPriceList({ ...scope, partyKey: b.partyKey, listCode: b.listCode })));

      case "quote":
        if (!b.lines?.length) return json({ error: "There is nothing to price." }, 400);
        return json(ledgerJson({
          quotes: await quoteLines({
            ...scope, partyKey: b.partyKey, on: b.on, currency: b.currency, kind: b.kind,
            lines: b.lines.map((l) => ({ itemCode: l.itemCode, quantityMilli: l.quantityMilli })),
          }),
        }));

      case "variance": {
        if (!b.lines?.length) return json({ error: "There is nothing to measure." }, 400);
        const lines = b.lines.map((l) => ({
          itemCode: l.itemCode,
          quantityMilli: l.quantityMilli ?? "1000",
          chargedMinor: l.chargedMinor ?? "0",
        }));
        return json(ledgerJson(await priceVariance({
          ...scope, partyKey: b.partyKey, on: b.on, currency: b.currency, kind: b.kind, lines,
        })));
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
