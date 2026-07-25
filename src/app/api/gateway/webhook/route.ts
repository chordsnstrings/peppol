import { randomUUID } from "node:crypto";
import { json, handleError } from "@/lib/server/http";
import { getRecord, putRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import { getGateway } from "@/lib/gateway/registry";
import { applyGatewayEvents, eventNarratives } from "@/lib/gateway/apply";
import { isFirstDelivery } from "@/lib/server/webhook-dedup";
import type { AppNotification, Invoice, InvoiceEvent } from "@/lib/domain/types";

export const runtime = "nodejs";

/**
 * Inbound gateway webhook (unauthenticated — verified by the driver's signature).
 * Events carry a gatewayRef; the Transmission row maps it back to the owning
 * tenant + invoice, so the status update lands on the right record.
 */
export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const headers = Object.fromEntries(req.headers.entries());
    const gw = getGateway();

    let events;
    try {
      events = await gw.parseWebhook(headers, rawBody);
    } catch {
      return json({ error: "Invalid signature" }, 401);
    }

    // Replay protection: process a given signed body at most once.
    if (!(await isFirstDelivery(`gateway:${gw.driver}`, rawBody))) {
      return json({ ok: true, deduped: true });
    }

    for (const e of events) {
      const tx = await prisma.transmission.findUnique({ where: { gatewayRef: e.gatewayRef } });
      if (!tx) continue;
      const invoice = await getRecord<Invoice>(tx.orgId, "invoices", tx.invoiceId);
      if (!invoice) continue;

      const updated = applyGatewayEvents(invoice, [e]);
      await putRecord(tx.orgId, "invoices", updated);

      for (const n of eventNarratives([e])) {
        const ev: InvoiceEvent = { id: randomUUID(), invoiceId: invoice.id, type: "mls", detail: n.detail, actor: "gateway", at: e.at, tone: n.tone };
        await putRecord(tx.orgId, "invoiceEvents", ev);
      }
      await prisma.transmission.update({
        where: { gatewayRef: e.gatewayRef },
        data: { exchangeStatus: updated.exchangeStatus, reportingStatus: updated.reportingStatusC2, lastEventAt: new Date().toISOString() },
      });

      if (updated.lifecycleStatus === "COMPLETED" || updated.lifecycleStatus === "FAILED") {
        const n: Omit<AppNotification, "id" | "orgId" | "createdAt"> =
          updated.lifecycleStatus === "COMPLETED"
            ? { type: "invoice.completed", title: `${updated.number} delivered & reported`, href: `/invoices/${updated.id}`, tone: "success" }
            : { type: "invoice.failed", title: `${updated.number} was rejected`, href: `/invoices/${updated.id}`, tone: "error" };
        await putRecord(tx.orgId, "notifications", { id: randomUUID(), orgId: tx.orgId, createdAt: new Date().toISOString(), ...n });
      }
    }

    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
