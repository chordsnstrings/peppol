import { randomUUID } from "node:crypto";
import { json, handleError } from "@/lib/server/http";
import { getRecord, putRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import { getGateway } from "@/lib/gateway/registry";
import { applyGatewayEvents, eventNarratives } from "@/lib/gateway/apply";
import { isFirstDelivery } from "@/lib/server/webhook-dedup";
import { receiveInboundDocument } from "@/lib/server/inbound";
import type { AppNotification, Invoice, InvoiceEvent } from "@/lib/domain/types";

export const runtime = "nodejs";

/**
 * Inbound gateway webhook (unauthenticated — verified by the driver's signature).
 * Events carry a gatewayRef; the Transmission row maps it back to the owning
 * tenant + invoice, so the status update lands on the right record.
 *
 * Not every event is about a document we sent. A DOCUMENT_RECEIVED event is a
 * supplier's document addressed to one of our participants, and it has no
 * Transmission to be matched against — it used to fall through the lookup below
 * and be dropped in silence, which is how a product with an inbox screen came
 * to have no way of ever putting anything in it.
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

    /* What could not be acted on, and why. An event this deployment cannot
     * place is a fact about the deployment — a document for a participant no
     * entity claims, a status for a transmission that is not ours — and it is
     * returned rather than swallowed, so the sending gateway's own delivery log
     * shows the same gap ours does. */
    const unplaced: { gatewayRef: string; kind: string; reason: string }[] = [];
    let received = 0;
    let applied = 0;

    for (const e of events) {
      if (e.kind === "DOCUMENT_RECEIVED") {
        const arrival = await receiveInboundDocument(e);
        if (!arrival.ok) {
          const reason = arrival.reason ?? "The document could not be placed.";
          console.warn(`[gateway webhook] inbound ${e.gatewayRef} not placed — ${reason}`);
          unplaced.push({ gatewayRef: e.gatewayRef, kind: e.kind, reason });
        } else if (!arrival.duplicate) {
          received++;
        }
        continue;
      }

      const tx = await prisma.transmission.findUnique({ where: { gatewayRef: e.gatewayRef } });
      if (!tx) {
        const reason = "No transmission in this deployment carries that gateway reference.";
        console.warn(`[gateway webhook] ${e.kind} ${e.gatewayRef} unmatched — ${reason}`);
        unplaced.push({ gatewayRef: e.gatewayRef, kind: e.kind, reason });
        continue;
      }
      const invoice = await getRecord<Invoice>(tx.orgId, "invoices", tx.invoiceId);
      if (!invoice) {
        const reason = `Transmission ${tx.id} points at invoice ${tx.invoiceId}, which is not in the store.`;
        console.warn(`[gateway webhook] ${e.kind} ${e.gatewayRef} unmatched — ${reason}`);
        unplaced.push({ gatewayRef: e.gatewayRef, kind: e.kind, reason });
        continue;
      }

      const updated = applyGatewayEvents(invoice, [e]);
      await putRecord(tx.orgId, "invoices", updated);
      applied++;

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

    return json({ ok: true, applied, received, unplaced });
  } catch (e) {
    return handleError(e);
  }
}
