import { randomUUID } from "node:crypto";
import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getRecord, putRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import { validateInvoice } from "@/lib/domain/validation";
import { generateUBL } from "@/lib/domain/ubl";
import { buildTDD } from "@/lib/gateway/tdd";
import { getGateway } from "@/lib/gateway/registry";
import { PINT_AE } from "@/lib/gateway/port";
import { applyGatewayEvents, eventNarratives } from "@/lib/gateway/apply";
import type { AppNotification, Entity, Invoice, InvoiceEvent } from "@/lib/domain/types";

export const runtime = "nodejs";

/**
 * Send pipeline (spec §3.2, §7): validate → generate PINT AE UBL + Tax Data
 * Document → submit the exchange leg (to the buyer's ASP / C3) and the reporting
 * leg (TDD to the FTA / C5) through the gateway → record the transmission and
 * apply the returned MLS to the invoice's two status dimensions.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { orgId } = await requireSession();

    const invoice = await getRecord<Invoice>(orgId, "invoices", id);
    if (!invoice) return json({ error: "Invoice not found" }, 404);
    const entity = await getRecord<Entity>(orgId, "entities", invoice.entityId);
    if (!entity) return json({ error: "Entity not found" }, 400);

    const validation = validateInvoice(invoice);
    if (!validation.canSend) {
      return json({ error: "Invoice has blocking issues", issues: validation.issues }, 422);
    }

    const now = new Date().toISOString();
    const event = async (type: string, detail: string, actor: string, tone: InvoiceEvent["tone"]) => {
      const ev: InvoiceEvent = { id: randomUUID(), invoiceId: invoice.id, type, detail, actor, at: new Date().toISOString(), tone };
      await putRecord(orgId, "invoiceEvents", ev);
    };
    const notify = async (n: Omit<AppNotification, "id" | "orgId" | "createdAt">) => {
      await putRecord(orgId, "notifications", { id: randomUUID(), orgId, createdAt: now, ...n });
    };

    // Build the compliant documents.
    const ubl = generateUBL(invoice);
    const tdd = buildTDD(invoice, ubl);

    const gw = getGateway();
    const sender = entity.peppolParticipantId ?? "";
    const receiver = invoice.buyer.peppolId ?? "";

    // Network preflight (REG-07): block-with-guidance if the buyer isn't reachable.
    const cap = receiver ? await gw.lookupParticipant(receiver) : { onNetwork: false, participantId: receiver, checkedAt: now };
    if (!receiver || !cap.onNetwork) {
      const blocked: Invoice = { ...invoice, exchangeStatus: "UNDELIVERABLE_NO_PARTICIPANT", updatedAt: now };
      await putRecord(orgId, "invoices", blocked);
      await event("preflight", `${invoice.buyer.nameEn || "The buyer"} isn't reachable on the Peppol network yet`, "gateway", "warning");
      await notify({ type: "invoice.blocked", title: `${invoice.number} can't be delivered yet`, body: "The buyer isn't registered on the network. We'll retry, or you can confirm their Peppol ID.", href: `/invoices/${invoice.id}`, tone: "warning" });
      return json({ invoice: blocked, blocked: "NOT_ON_NETWORK" });
    }

    // Idempotent submission.
    const idempotencyKey = `send:${invoice.id}`;
    const existing = await prisma.transmission.findUnique({ where: { idempotencyKey } });
    let gatewayRef: string;
    if (existing) {
      gatewayRef = existing.gatewayRef;
    } else {
      const submit = await gw.submitDocument({
        idempotencyKey,
        senderParticipantId: sender,
        receiverParticipantId: receiver,
        docTypeId: invoice.docType === "TAX_CREDIT_NOTE" ? PINT_AE.creditNoteDocTypeId : PINT_AE.invoiceDocTypeId,
        processId: PINT_AE.processId,
        xml: ubl,
        tdd,
      });
      gatewayRef = submit.gatewayRef;
      await prisma.transmission.create({
        data: { orgId, invoiceId: invoice.id, gatewayRef, idempotencyKey, driver: gw.driver, ublXml: ubl, tddXml: tdd },
      });
    }

    // Mark submitted on both legs.
    let updated: Invoice = {
      ...invoice,
      lifecycleStatus: "SENT",
      exchangeStatus: "SUBMITTED",
      reportingStatusC2: "SUBMITTED",
      sentAt: now,
      lockedAt: invoice.lockedAt ?? now,
      updatedAt: now,
    };
    await event("queued", "Queued in the send pipeline", "system", "neutral");
    await event("sending", gw.driver === "mock" ? "Submitted to the Peppol network (sandbox)" : "Submitted to the Peppol network via Taxilla", "gateway", "neutral");

    // Pull status: mock returns terminal MLS immediately; a live gateway returns
    // nothing until its webhook fires (status stays SENT until then).
    const statusEvents = await gw.fetchStatusUpdates(gatewayRef);
    if (statusEvents.length) {
      updated = applyGatewayEvents(updated, statusEvents);
      for (const n of eventNarratives(statusEvents)) await event("mls", n.detail, "gateway", n.tone);
      await prisma.transmission.update({
        where: { gatewayRef },
        data: { exchangeStatus: updated.exchangeStatus, reportingStatus: updated.reportingStatusC2, lastEventAt: now },
      });
    }

    await putRecord(orgId, "invoices", updated);

    if (updated.lifecycleStatus === "COMPLETED") {
      await notify({ type: "invoice.completed", title: `${updated.number} delivered & reported`, body: "Exchange and FTA reporting both succeeded.", href: `/invoices/${updated.id}`, tone: "success" });
    } else if (updated.lifecycleStatus === "FAILED") {
      await notify({ type: "invoice.failed", title: `${updated.number} was rejected`, body: "See the fix-it queue for the reason and a corrected-copy path.", href: `/invoices/${updated.id}`, tone: "error" });
    } else {
      await notify({ type: "invoice.sent", title: `${updated.number} submitted`, body: "Awaiting delivery and FTA reporting confirmation.", href: `/invoices/${updated.id}`, tone: "neutral" });
    }

    return json({ invoice: updated });
  } catch (e) {
    return handleError(e);
  }
}
