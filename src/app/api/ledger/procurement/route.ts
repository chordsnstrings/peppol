import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  createOrder, addLine, issueOrder, cancelOrder,
  receiveGoods, matchInvoice, postMatchedInvoice,
  grniReport, orderList, orderDetail,
  type NewOrder, type NewOrderLine, type OrderStatus,
  type ReceiptLineInput, type MatchLineInput, type MatchTolerance,
} from "@/lib/server/ledger/procurement";

export const runtime = "nodejs";

/**
 * The order list with the GRNI reconciliation, or one order in full.
 *
 * The reconciliation comes back with the list rather than on a screen of its
 * own: what is sitting in 1250 unexplained is the question a buyer should be
 * made to look at, not one they have to go looking for.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const q = new URL(req.url).searchParams;

    const orderId = q.get("orderId");
    if (orderId) return json(ledgerJson(await orderDetail({ orgId, orderId })));

    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);

    const asOf = q.get("asOf") ?? undefined;
    const status = (q.get("status") as OrderStatus | null) ?? undefined;
    const [orders, grni] = await Promise.all([
      orderList({ orgId, entityId, status }),
      grniReport({ orgId, entityId, asOf }),
    ]);
    return json(ledgerJson({ ...orders, grni }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Raise, issue or cancel an order; record a delivery; test an invoice against
 * both; post it.
 *
 * `match` is deliberately separate from `post`: a buyer has to be able to ask
 * what the three documents say without that question having any effect, and the
 * screen calls it on every keystroke.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "create" | "addLine" | "issue" | "cancel" | "receive" | "match" | "post";
      entityId?: string;
      orderId?: string;
      order?: NewOrder;
      line?: NewOrderLine;
      reason?: string;
      /** Goods receipt. */
      receivedOn?: string;
      number?: string;
      notes?: string;
      receiptLines?: ReceiptLineInput[];
      /** Invoice match. */
      billId?: string;
      invoiceNumber?: string;
      invoicedOn?: string;
      invoiceLines?: MatchLineInput[];
      invoiceTotalMinor?: string | number;
      vatMinor?: string | number;
      tolerance?: MatchTolerance;
      overrideReason?: string;
      varianceAccount?: string;
    };

    switch (b.action) {
      case "create": {
        if (!b.entityId) return json({ error: "entityId required" }, 400);
        if (!b.order) return json({ error: "An order needs a number, a supplier and a date." }, 400);
        const order = await createOrder({ orgId, entityId: b.entityId, order: b.order });
        return json(ledgerJson({ order: { id: order.id, number: order.number, status: order.status } }));
      }

      case "addLine": {
        if (!b.orderId || !b.line) return json({ error: "Which order, and what line?" }, 400);
        return json(ledgerJson({ line: await addLine({ orgId, orderId: b.orderId, line: b.line }) }));
      }

      case "issue": {
        if (!b.orderId) return json({ error: "Which order?" }, 400);
        const order = await issueOrder({ orgId, orderId: b.orderId });
        return json(ledgerJson({ order: { id: order.id, number: order.number, status: order.status } }));
      }

      case "cancel": {
        if (!b.orderId) return json({ error: "Which order?" }, 400);
        const order = await cancelOrder({ orgId, orderId: b.orderId, reason: b.reason });
        return json(ledgerJson({ order: { id: order.id, number: order.number, status: order.status } }));
      }

      case "receive": {
        if (!b.orderId || !b.receivedOn || !b.receiptLines?.length) {
          return json({ error: "A goods receipt needs an order, a date and at least one line." }, 400);
        }
        return json(ledgerJson(await receiveGoods({
          orgId, orderId: b.orderId, receivedOn: b.receivedOn, number: b.number,
          lines: b.receiptLines, notes: b.notes, actorType: "HUMAN", actorId: userId,
        })));
      }

      case "match": {
        if (!b.orderId || !b.invoiceLines?.length || b.invoiceTotalMinor === undefined) {
          return json({ error: "A match needs an order, the invoice lines and the invoice total." }, 400);
        }
        return json(ledgerJson(await matchInvoice({
          orgId, orderId: b.orderId, billId: b.billId, invoiceNumber: b.invoiceNumber,
          lines: b.invoiceLines, invoiceTotalMinor: b.invoiceTotalMinor,
          vatMinor: b.vatMinor, tolerance: b.tolerance,
        })));
      }

      case "post": {
        if (!b.orderId || !b.invoiceNumber || !b.invoicedOn || !b.invoiceLines?.length || b.invoiceTotalMinor === undefined) {
          return json({ error: "Posting an invoice needs an order, the invoice number and date, its lines and its total." }, 400);
        }
        return json(ledgerJson(await postMatchedInvoice({
          orgId, orderId: b.orderId, invoiceNumber: b.invoiceNumber, invoicedOn: b.invoicedOn,
          billId: b.billId, lines: b.invoiceLines, invoiceTotalMinor: b.invoiceTotalMinor,
          vatMinor: b.vatMinor, tolerance: b.tolerance,
          overrideReason: b.overrideReason, varianceAccount: b.varianceAccount,
          actorType: "HUMAN", actorId: userId,
        })));
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
