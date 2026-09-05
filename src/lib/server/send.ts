import { randomUUID } from "node:crypto";
import { getRecord, putRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import { validateInvoice } from "@/lib/domain/validation";
import { generateUBL } from "@/lib/domain/ubl";
import { buildTDD } from "@/lib/gateway/tdd";
import { getGateway, isSimulatedTransmission } from "@/lib/gateway/registry";
import { LIVE_ENTITY_ON_SIMULATOR, SIMULATED_PREFLIGHT_NOTE, SIMULATED_SEND_NOTE } from "@/lib/gateway/disclosure";
import { PINT_AE } from "@/lib/gateway/port";
import { applyGatewayEvents, eventNarratives } from "@/lib/gateway/apply";
import { recordExchange } from "@/lib/server/billing";
import { isOrgWritable } from "@/lib/server/org-status";
import { isEntitled } from "@/lib/server/subscription";
import { isFlagOn } from "@/lib/server/flags";
import { invoiceCreditGate, overrideNarrative, type InvoiceCreditGate } from "@/lib/server/ledger/credit-control";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { fmtMinor } from "@/lib/ledger/format";
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
 * What the caller knows that the pipeline cannot work out for itself.
 *
 * Only the credit gate reads either of these, and both are optional because
 * most callers have neither: an API key authenticates a workspace and names
 * nobody, and no caller sends over a credit refusal unless a person asked for
 * it in those words.
 */
export interface SendOptions {
  /** The signed-in person, as a permission check would name them. */
  actorId?: string | null;
  /** Send over a credit refusal, on a reason that goes onto the invoice's timeline. */
  creditOverrideReason?: string | null;
}

/**
 * A credit refusal, written for a caller that has no panel to draw the gate in.
 *
 * The finalisation route hands the whole gate back and the invoice screen draws
 * it — a verdict, the four figures the argument is actually about, and every
 * ground separately. None of the other doors into this pipeline has that panel:
 * a bulk send, the fix-it queue, the recurring runner and an API client all get
 * one string. "Credit refused" on its own is what sends the salesperson to
 * accounts and accounts back to the salesperson, and the second time that
 * happens somebody invoices from a spreadsheet instead — so the figures and the
 * name of the grant that can let it through travel in the sentence.
 */
function creditRefusal(gate: InvoiceCreditGate): string {
  const money = (v: string | null) =>
    v === null ? "an amount this check could not read" : `${gate.currency} ${fmtMinor(v, gate.currency, { zero: "zero" })}`;
  // Only where the check actually ran. An unresolved customer or an entity with
  // no receivables account produces no exposure and no limit, and printing a
  // row of nils there would read as "they owe nothing" rather than "not asked".
  const standing =
    gate.exposureMinor === null
      ? ""
      : ` ${gate.name} carries ${money(gate.exposureMinor)} against ` +
        (gate.creditLimitMinor === null ? "no limit assessed" : `a limit of ${money(gate.creditLimitMinor)}`) +
        `, and ${gate.documentNumber} would take them to ${money(gate.wouldBeMinor)}.`;
  return (
    `${gate.documentNumber} was not sent. ${gate.headline}${standing} ` +
    `Whoever holds "${gate.overridePermission}" can finalise it anyway from the invoice, on a reason that goes ` +
    `onto its timeline — which is deliberately not the grant that raises one, so the person who raised this ` +
    `cannot clear their own refusal.`
  );
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
export async function runSendPipeline(orgId: string, invoiceId: string, opts: SendOptions = {}): Promise<SendOutcome> {
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
  /* A cancelled document was abandoned, and transmitting one would put it in
   * the buyer's hands and in front of the FTA after the business decided not to
   * issue it. The finalisation route refuses the same transition in the same
   * words. It also matters to the credit gate below: cancelling is a move a
   * client may make on its own record, so without this a refused draft could be
   * cancelled and then sent, arriving here in a state the gate does not read. */
  if (invoice.lifecycleStatus === "CANCELLED") {
    return { ok: false, status: 422, error: `${invoice.number || "This document"} was cancelled, so it isn't sent.` };
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

  const now = new Date().toISOString();
  const event = async (type: string, detail: string, actor: string, tone: InvoiceEvent["tone"]) => {
    const ev: InvoiceEvent = { id: randomUUID(), invoiceId: invoice.id, type, detail, actor, at: new Date().toISOString(), tone };
    await putRecord(orgId, "invoiceEvents", ev);
  };
  const notify = async (n: Omit<AppNotification, "id" | "orgId" | "createdAt">) => {
    await putRecord(orgId, "notifications", { id: randomUUID(), orgId, createdAt: now, ...n });
  };

  /* The credit gate, at the last door out.
   *
   * It binds at finalisation on the invoice screen, which is the moment the
   * business commits — but five other paths send without ever finalising
   * through it: bulk send from the list, create-and-send, the fix-it queue, the
   * recurring runner and the public API. A control on one door out of six is
   * not a control, so it binds here as well, in the pipeline all six pass
   * through, rather than six times over in the screens.
   *
   * Only for a document still in draft, and that is the whole of the agreement
   * with the screen. Sending a draft finalises it — it is locked and taken to
   * SENT below — so this is the same commitment point reached by a different
   * door. A document already READY has been through the gate on the route that
   * finalised it, and its answer, including an override somebody put their name
   * to, is already on its timeline; asking again would refuse the same sale
   * twice and leave the second refusal somewhere with no way to override it.
   */
  if (invoice.lifecycleStatus === "DRAFT") {
    const reason = (opts.creditOverrideReason ?? "").trim();
    const gate = await invoiceCreditGate({
      orgId,
      entityId: invoice.entityId,
      invoice,
      override: reason ? { reason, actorId: opts.actorId ?? null } : null,
    });

    if (gate.overrode) {
      /* Letting a refusal through is the same power as releasing a hold and
       * deliberately not the power that raises the invoice, so it is checked
       * rather than taken on the caller's word. An API key authenticates a
       * workspace and names nobody, and an override nobody can be held to is
       * not an override — so a caller with no actor is refused on the credit
       * grounds, with the permission sentence added rather than substituted:
       * the reason the sale is stopped is still the customer, not the login. */
      let denial: string | null = null;
      if (!opts.actorId) {
        denial =
          `An override has to be somebody's. This request authenticated a workspace rather than a person, so ` +
          `there is nobody to hold "${gate.overridePermission}".`;
      } else {
        try {
          await requirePermission({
            orgId,
            userId: opts.actorId,
            entityId: invoice.entityId,
            permission: gate.overridePermission,
          });
        } catch (e) {
          if (!(e instanceof PermissionError)) throw e;
          denial = e.message;
        }
      }
      if (denial) return { ok: false, status: 403, error: `${denial} ${creditRefusal(gate)}` };
    }

    if (!gate.allowed) return { ok: false, status: 409, error: creditRefusal(gate) };

    /* Written before anything is submitted, so a failure between the two leaves
     * a recorded override and an unsent draft rather than a transmitted invoice
     * nobody can see was overridden — the same order the finalisation route
     * writes them in, and for the same reason. The narrative carries the limit,
     * the exposure and the grounds rather than the words "credit override",
     * because the check will answer differently by the time anybody reads it
     * back and "over their limit" without the figures is not weighable. */
    if (gate.overrode) {
      const actor = opts.actorId!; // Never null: an override naming nobody was refused above.
      await event("credit_override", overrideNarrative(gate, actor), actor, "warning");
    }
  }

  const validation = validateInvoice(invoice);
  if (!validation.canSend) {
    return { ok: false, status: 422, error: "Invoice has blocking issues", issues: validation.issues };
  }

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
        ? SIMULATED_PREFLIGHT_NOTE
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
