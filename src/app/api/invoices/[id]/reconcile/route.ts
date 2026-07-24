import { randomUUID } from "node:crypto";
import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getRecord, putRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import { getGateway } from "@/lib/gateway/registry";
import { applyGatewayEvents, eventNarratives } from "@/lib/gateway/apply";
import type { Invoice, InvoiceEvent } from "@/lib/domain/types";

export const runtime = "nodejs";

/** Reconcile a stuck transmission: pull the latest status from the gateway and apply it. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { orgId } = await requireSession();

    const invoice = await getRecord<Invoice>(orgId, "invoices", id);
    if (!invoice) return json({ error: "Invoice not found" }, 404);

    const tx = await prisma.transmission.findFirst({
      where: { orgId, invoiceId: id },
      orderBy: { createdAt: "desc" },
    });
    if (!tx) return json({ error: "No transmission to reconcile" }, 409);

    const events = await getGateway().fetchStatusUpdates(tx.gatewayRef);
    if (!events.length) return json({ invoice, changed: false });

    const updated = applyGatewayEvents(invoice, events);
    await putRecord(orgId, "invoices", updated);
    for (const n of eventNarratives(events)) {
      const ev: InvoiceEvent = { id: randomUUID(), invoiceId: id, type: "reconcile", detail: n.detail, actor: "system", at: new Date().toISOString(), tone: n.tone };
      await putRecord(orgId, "invoiceEvents", ev);
    }
    await prisma.transmission.update({
      where: { gatewayRef: tx.gatewayRef },
      data: { exchangeStatus: updated.exchangeStatus, reportingStatus: updated.reportingStatusC2, lastEventAt: new Date().toISOString() },
    });
    return json({ invoice: updated, changed: true });
  } catch (e) {
    return handleError(e);
  }
}
