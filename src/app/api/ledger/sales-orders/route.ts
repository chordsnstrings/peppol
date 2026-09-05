import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  createOrder, updateOrder,
  sendOrder, acceptOrder, declineOrder, cancelOrder,
  convertToOrder, invoiceOrder, expireQuotes,
  listOrders, orderDetail,
  type NewSalesOrder, type OrderPatch, type InvoiceLineInput,
  type SalesOrderKind, type SalesOrderStatus,
} from "@/lib/server/ledger/sales-orders";

export const runtime = "nodejs";

/**
 * The quotation and order list, or one document in full.
 *
 * The list carries the totals it is a list of, so the screen never has to add
 * the rows up itself: a figure computed twice is a figure that can disagree
 * with itself, and the one the customer quotes back is always the other one.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    /* Looking at what has been quoted and ordered is reading the books. The
     * entity is optional on a single-document read, so the check falls back to
     * whatever the person holds anywhere in the workspace. */
    await requirePermission({ orgId, userId, entityId: q.get("entityId") ?? undefined, permission: "ledger.read" });

    const orderId = q.get("orderId");
    if (orderId) {
      const entityId = q.get("entityId") ?? undefined;
      return json(ledgerJson(await orderDetail({ orgId, orderId, entityId })));
    }

    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);

    return json(ledgerJson(await listOrders({
      orgId,
      entityId,
      status: (q.get("status") as SalesOrderStatus | null) ?? undefined,
      kind: (q.get("kind") as SalesOrderKind | null) ?? undefined,
      customerCode: q.get("customerCode") ?? undefined,
    })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Raise a document, change it, move it along, invoice part of it, or sweep the
 * quotes that have lapsed.
 *
 * Every action carries the entity as well as the document id. The id alone is
 * not authority to touch a document — it is a string that can be copied out of
 * one workspace and pasted into another — so the module filters on the
 * organisation and, where it is known, the entity too.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "create" | "update" | "send" | "accept" | "decline" | "cancel" | "convert" | "invoice" | "expire";
      entityId?: string;
      orderId?: string;
      order?: NewSalesOrder;
      patch?: OrderPatch;
      reason?: string;
      reference?: string;
      acceptedOn?: string;
      invoiceLines?: InvoiceLineInput[];
      asOf?: string;
      /** Accept or invoice anyway when credit refuses. The reason is recorded. */
      overrideReason?: string;
    };

    const entityId = b.entityId;

    /* Quoting, ordering, dispatching the paperwork and invoicing it are all the
     * sales ledger, so every action here needs that key. */
    await requirePermission({ orgId, userId, entityId, permission: "ar.manage" });

    /* An override is a second power, and it belongs to somebody else.
     *
     * `creditGate` refuses an acceptance or an invoice when the customer is on
     * hold, and an override with a reason is what lets the sale through anyway.
     * That is releasing the hold for this one sale, reached through "accept"
     * instead of through "release" — so it takes the same key the hold itself
     * takes, and the person who may raise the invoice cannot also decide that
     * the stop on the account does not apply to it. It also covers a refusal on
     * the credit limit, which is the same decision about the same customer. */
    if (b.overrideReason?.trim()) {
      await requirePermission({ orgId, userId, entityId, permission: "ar.credit_hold" });
    }

    switch (b.action) {
      case "create": {
        if (!entityId) return json({ error: "entityId required" }, 400);
        if (!b.order) return json({ error: "A quotation needs a customer and an issue date." }, 400);
        const order = await createOrder({ orgId, entityId, order: b.order });
        return json(ledgerJson({ order: { id: order.id, number: order.number, kind: order.kind, status: order.status } }));
      }

      case "update": {
        if (!b.orderId || !b.patch) return json({ error: "Which document, and what change?" }, 400);
        const order = await updateOrder({ orgId, orderId: b.orderId, entityId, patch: b.patch });
        return json(ledgerJson({ order: { id: order.id, number: order.number, status: order.status } }));
      }

      case "send":
      case "accept":
      case "decline":
      case "cancel": {
        if (!b.orderId) return json({ error: "Which document?" }, 400);
        const args = { orgId, orderId: b.orderId, entityId };
        // The actor comes from the session, never from the body: an override
        // signed by whoever the client says signed it is not a control.
        const override = b.overrideReason?.trim()
          ? { reason: b.overrideReason.trim(), actorId: userId }
          : null;
        const order =
          b.action === "send" ? await sendOrder(args)
          : b.action === "accept" ? await acceptOrder({ ...args, acceptedOn: b.acceptedOn, reference: b.reference, override })
          : b.action === "decline" ? await declineOrder({ ...args, reason: b.reason })
          : await cancelOrder({ ...args, reason: b.reason });
        return json(ledgerJson({
          order: { id: order.id, number: order.number, status: order.status },
          // Present on acceptance only. The screen shows the sentence whether
          // the answer was allow, review or an override — a review nobody is
          // shown is a review that did not happen.
          credit: "credit" in order ? order.credit : undefined,
        }));
      }

      case "convert": {
        if (!b.orderId) return json({ error: "Which quotation?" }, 400);
        const order = await convertToOrder({ orgId, quoteId: b.orderId, entityId });
        return json(ledgerJson({ order: { id: order.id, number: order.number, kind: order.kind, status: order.status } }));
      }

      case "invoice": {
        if (!b.orderId) return json({ error: "Which order?" }, 400);
        return json(ledgerJson(await invoiceOrder({
          orgId, orderId: b.orderId, entityId, lines: b.invoiceLines,
          override: b.overrideReason?.trim() ? { reason: b.overrideReason.trim(), actorId: userId } : null,
        })));
      }

      case "expire": {
        if (!entityId) return json({ error: "entityId required" }, 400);
        return json(ledgerJson(await expireQuotes({ orgId, entityId, asOf: b.asOf })));
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
