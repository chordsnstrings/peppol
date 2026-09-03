import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  createDeliveryNote, dispatchNote, confirmDelivery, cancelDeliveryNote,
  returnGoods, outstandingOnOrder, deliveredNotInvoiced, deliveryRegister,
  type NewDeliveryNote, type NoteStatus,
} from "@/lib/server/ledger/deliveries";

export const runtime = "nodejs";

/** The register, what is delivered and unbilled, or what an order still owes. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);

    const view = q.get("view");

    if (view === "unbilled") {
      return json(ledgerJson(await deliveredNotInvoiced({ orgId, entityId, asOf: q.get("asOf") ?? undefined })));
    }

    if (view === "order") {
      const orderId = q.get("orderId");
      if (!orderId) return json({ error: "Which order?" }, 400);
      return json(ledgerJson(await outstandingOnOrder({ orgId, orderId })));
    }

    return json(ledgerJson(await deliveryRegister({
      orgId, entityId,
      from: q.get("from") ?? undefined,
      to: q.get("to") ?? undefined,
      status: (q.get("status") as NoteStatus) ?? undefined,
    })));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "create" | "dispatch" | "confirm" | "cancel" | "return";
      entityId?: string;
      note?: NewDeliveryNote;
      number?: string;
      signedBy?: string;
      signedOn?: string;
      reason?: string;
      returnedOn?: string;
      reference?: string;
      lines?: { lineNo: number; quantityMilli: string }[];
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId: b.entityId };

    switch (b.action) {
      case "create":
        if (!b.note) return json({ error: "There is no note to create." }, 400);
        return json(ledgerJson({ note: await createDeliveryNote({ ...scope, note: b.note }) }));

      case "dispatch":
        if (!b.number) return json({ error: "Which note?" }, 400);
        return json(ledgerJson(await dispatchNote({ ...scope, number: b.number, actorId: userId })));

      case "confirm":
        if (!b.number || !b.signedBy) return json({ error: "Which note, and who signed?" }, 400);
        return json(ledgerJson({
          note: await confirmDelivery({ ...scope, number: b.number, signedBy: b.signedBy, signedOn: b.signedOn }),
        }));

      case "cancel":
        if (!b.number) return json({ error: "Which note?" }, 400);
        return json(ledgerJson({ note: await cancelDeliveryNote({ ...scope, number: b.number, reason: b.reason }) }));

      case "return":
        if (!b.number) return json({ error: "Which note?" }, 400);
        return json(ledgerJson(await returnGoods({
          ...scope, number: b.number, lines: b.lines,
          returnedOn: b.returnedOn, reference: b.reference, actorId: userId,
        })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
