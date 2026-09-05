import { randomUUID } from "node:crypto";
import { getRecord, putRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import { validateInvoice } from "@/lib/domain/validation";
import { generateUBL } from "@/lib/domain/ubl";
import { buildTDD } from "@/lib/gateway/tdd";
import { getGateway, isSimulatedTransmission } from "@/lib/gateway/registry";
import { LIVE_ENTITY_ON_SIMULATOR, SIMULATED_SEND_NOTE } from "@/lib/gateway/disclosure";
import { PINT_AE } from "@/lib/gateway/port";
import { applyGatewayEvents, eventNarratives } from "@/lib/gateway/apply";
import { recordExchange } from "@/lib/server/billing";
import { isOrgWritable } from "@/lib/server/org-status";
import { isEntitled } from "@/lib/server/subscription";
import { isFlagOn } from "@/lib/server/flags";
import type { AppNotification, Entity, Invoice, InvoiceEvent } from "@/lib/domain/types";

export interface SendOutcome {
  ok: boolean;
  status: number;
  invoice?: Invoice;
  blocked?: string;
  error?: string;
  issues?: unknown;
  upgradeUrl?: string;
  /**
   * True when the driver that handled this send invents its own outcome. A
   * caller that reports the result to a person has to repeat the qualifier;
   * this is how an API client or another route learns it without re-reading
   * the environment.
   */
  simulated?: boolean;
}

/**
 * Send pipeline (spec §3.2, §7): validate → generate PINT AE UBL + Tax Data
 * Document → submit the exchange leg (to the buyer's ASP / C3) and the reporting
 * leg (TDD to the FTA / C5) through the gateway → record the transmission and
 * apply the returned MLS to the invoice's two status dimensions.
 *
 * Shared by the session send route and the public API so both behave identically.
 * `orgId` must be the authoritative tenant id (session or authenticated API key).
 */
export async function runSendPipeline(orgId: string, invoiceId: string): Promise<SendOutcome> {
  if (await isFlagOn("sending_paused")) {
    return { ok: false, status: 503, error: "Sending is temporarily paused platform-wide. Please try again shortly." };
  }
  if (!(await isOrgWritable(orgId))) {
    return { ok: false, status: 423, error: "This workspace is locked (suspended or read-only). Contact support." };
  }
  // The FTA paywall: no active subscription (or trial/grace) → no transmission.
  if (!(await isEntitled(orgId))) {
    return {
      ok: false,
      status: 402,
      error: "Your subscription is inactive. Subscribe to keep transmitting to the FTA.",
      upgradeUrl: "/settings/billing",
    };
  }
  const invoice = await getRecord<Invoice>(orgId, "invoices", invoiceId);
  if (!invoice) return { ok: false, status: 404, error: "Invoice not found" };
  if (invoice.docType === "PROFORMA") {
    return { ok: false, status: 422, error: "Proforma invoices aren't transmitted. Convert it to a tax invoice first." };
  }
  const entity = await getRecord<Entity>(orgId, "entities", invoice.entityId);
  if (!entity) return { ok: false, status: 400, error: "Entity not found" };

  const gw = getGateway();
  const simulated = isSimulatedTransmission(gw.driver);

  // The one combination that produces a lie: an entity whose owner has been told
  // real invoices transmit, on a deployment where every acceptance is written by
  // the driver itself. Under the DCTCE mandate an unreported Tax Data Document
  // is a penalty the user gets no signal about, so this refuses rather than
  // rehearses. A SANDBOX entity may rehearse as much as it likes — it is only
  // the claim of being live that has to be earned. This guard is here, in the
  // pipeline shared by the session route and the public API, because a control
  // on the activation screen is a courtesy and this is the actual control.
  if (entity.einvoicingStatus === "LIVE" && simulated) {
    return { ok: false, status: 503, error: LIVE_ENTITY_ON_SIMULATOR, simulated };
  }

  const validation = validateInvoice(invoice);
  if (!validation.canSend) {
    return { ok: false, status: 422, error: "Invoice has blocking issues", issues: validation.issues };
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

  const sender = entity.peppolParticipantId ?? "";
  const receiver = invoice.buyer.peppolId ?? "";

  // Network preflight (REG-07): block-with-guidance if the buyer isn't reachable.
  const cap = receiver ? await gw.lookupParticipant(receiver) : { onNetwork: false, participantId: receiver, checkedAt: now };
  if (!receiver || !cap.onNetwork) {
    const blocked: Invoice = { ...invoice, exchangeStatus: "UNDELIVERABLE_NO_PARTICIPANT", updatedAt: now };
    await putRecord(orgId, "invoices", blocked);
    // The simulator answers this lookup from a regular expression, so the
    // reason has to say whose answer it is: "not on the network" is a claim
    // about the SMP directory, and no directory was asked.
    await event(
      "preflight",
      simulated
        ? `The simulator reports ${invoice.buyer.nameEn || "the buyer"} as unreachable — no SMP lookup was made`
        : `${invoice.buyer.nameEn || "The buyer"} isn't reachable on the Peppol network yet`,
      "gateway",
      "warning",
    );
    await notify({
      type: "invoice.blocked",
      title: `${invoice.number} can't be delivered yet`,
      body: simulated
        ? "The simulated gateway found no registration for this buyer. Nothing was looked up on the real Peppol network."
        : "The buyer isn't registered on the network. We'll retry, or you can confirm their Peppol ID.",
      href: `/invoices/${invoice.id}`,
      tone: "warning",
    });
    return { ok: true, status: 200, invoice: blocked, blocked: "NOT_ON_NETWORK", simulated };
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
    // Meter the billable exchange (idempotent per invoice, so re-sends don't double-count).
    await recordExchange(orgId, invoice.entityId, invoice.id);
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
  await event(
    "sending",
    simulated
      ? "Submitted to the in-process simulator — no document left this deployment"
      : "Submitted to the Peppol network via Taxilla",
    "gateway",
    simulated ? "warning" : "neutral",
  );

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

  // The notification is the line most users actually read — it is the one that
  // reaches the phone — so a simulated outcome is never titled as a delivery and
  // never toned as a success. "Delivered & reported" about a document that never
  // left the process is the single worst sentence this product can print.
  const href = `/invoices/${updated.id}`;
  if (updated.lifecycleStatus === "COMPLETED") {
    await notify(
      simulated
        ? { type: "invoice.completed", title: `${updated.number} completed in simulation`, body: SIMULATED_SEND_NOTE, href, tone: "warning" }
        : { type: "invoice.completed", title: `${updated.number} delivered & reported`, body: "Exchange and FTA reporting both succeeded.", href, tone: "success" },
    );
  } else if (updated.lifecycleStatus === "FAILED") {
    await notify(
      simulated
        ? { type: "invoice.failed", title: `${updated.number} was rejected in simulation`, body: SIMULATED_SEND_NOTE, href, tone: "warning" }
        : { type: "invoice.failed", title: `${updated.number} was rejected`, body: "See the fix-it queue for the reason and a corrected-copy path.", href, tone: "error" },
    );
  } else {
    await notify(
      simulated
        ? { type: "invoice.sent", title: `${updated.number} submitted to the simulator`, body: SIMULATED_SEND_NOTE, href, tone: "warning" }
        : { type: "invoice.sent", title: `${updated.number} submitted`, body: "Awaiting delivery and FTA reporting confirmation.", href, tone: "neutral" },
    );
  }

  return { ok: true, status: 200, invoice: updated, simulated };
}
