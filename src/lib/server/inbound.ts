import { createHash, randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { getRecord, putRecord } from "./store";
import { getGateway, isSimulatedTransmission } from "@/lib/gateway/registry";
import { SIMULATED_SEND_NOTE } from "@/lib/gateway/disclosure";
import { PINT_AE } from "@/lib/gateway/port";
import type { GatewayEvent, InboundDocument, ReceiptDecision } from "@/lib/gateway/port";
import { isWellFormedPeppolId } from "@/lib/domain/peppol";
import { parseMoneyToMinor } from "@/lib/domain/money";
import type { AppNotification, Entity, InboundDoc } from "@/lib/domain/types";

/**
 * Corner 4: receiving.
 *
 * Under the five-corner model every mandated business is both C1 and C4 — it
 * must be REACHABLE, and it must be able to accept or refuse what arrives.
 * This product had the sending half only: the inbox screen read a store that
 * nothing on the server ever wrote, so a supplier's invoice reached the gateway
 * webhook, matched no Transmission this org had sent, and was dropped without a
 * trace. A screen with no possible content is worse than no screen, because it
 * reads as "nobody has invoiced you" rather than "this deployment cannot
 * receive".
 *
 * There is no Prisma model for an inbound document and there should not be one:
 * the inbox reads the "inbound" client store, which persists through the generic
 * Record table via /api/store/*. This writes into the same table through
 * `putRecord`, so the screen that already exists is the screen that shows it.
 *
 * Nothing here is entitlement- or lock-gated, deliberately. A suspended
 * workspace or a lapsed subscription is a matter between the tenant and us; a
 * document a supplier put on the network has arrived whether or not the invoice
 * for this product was paid, and dropping it would leave the recipient with a
 * legal obligation they cannot see.
 */

/**
 * What may be said about a document the simulator produced rather than the
 * network delivered. `SIMULATED_SEND_NOTE` covers a send; an arrival needs its
 * own sentence because "nothing was transmitted" answers the wrong question
 * when the thing in front of the reader claims to be an invoice from a
 * supplier. The claim being corrected here is that a supplier sent it.
 */
export const SIMULATED_ARRIVAL_NOTE =
  "This document was produced by this deployment's simulated gateway driver. Nothing arrived from the Peppol network and no supplier sent it.";

/** Said when the driver is real but has no channel for an answer back to the supplier. */
export const RECEIPT_NOT_TRANSMITTED =
  "This deployment's gateway driver has no channel for sending a decision back to the supplier, so the decision is recorded here only. The supplier has not been told.";

/** Said when the channel exists and the gateway refused the answer. */
export const RECEIPT_SEND_FAILED =
  "The gateway did not accept the decision, so the supplier has not been told. The decision is recorded here; send it again once the gateway is reachable.";

/** Said when a driver cannot be asked for post at all. */
export const FETCH_UNSUPPORTED =
  "This deployment's gateway driver cannot be asked for inbound documents. Documents it receives arrive over its webhook instead.";

/**
 * The recipient's answer, as it stands on the record.
 *
 * `transmitted` is the only field that claims anything about the outside world,
 * and it is false unless a live driver accepted the receipt. A simulated
 * decision still records `receiptRef`, exactly as a simulated send records a
 * MOCK- gateway reference on its Transmission row: the reference is real as an
 * identifier and worthless as evidence, and `simulated` is what says so.
 */
export interface InboundDecisionRecord {
  outcome: ReceiptDecision;
  /** The recipient's own words. Required for a rejection — it is why. */
  reason?: string;
  decidedAt: string;
  decidedBy: string;
  transmitted: boolean;
  simulated: boolean;
  receiptRef?: string;
  /** What the screen is allowed to say about the transmission, or nothing when it went. */
  note?: string;
}

/**
 * The stored shape of an arrival.
 *
 * `InboundDoc` in the domain types is what the inbox screen already reads and
 * is unchanged; everything a receiving corner needs beyond it is added here and
 * persists as extra JSON on the same record. The fields below are all
 * server-owned — see the note in the handoff about pinning them in the store
 * route's sanitizer, which currently lets a tenant write this store freely.
 */
export interface InboundRecord extends InboundDoc {
  /** The gateway's reference for the DELIVERY (not for any Transmission of ours). */
  gatewayRef: string;
  receiverParticipantId: string;
  docTypeId: string;
  /** True when the driver that delivered this invents its own outcomes. */
  simulated: boolean;
  /** One line per failed check; the reason `status` is HAS_ISSUES. */
  issues?: string[];
  /** The document exactly as it arrived — the evidence of what was received. */
  xml?: string;
  xmlSha256?: string;
  /**
   * What this deployment may say about how the document got here, written the
   * moment it arrived and kept on the row. Stored rather than re-derived for
   * the same reason `simulated` travels on the event instead of being worked
   * out later: a deployment that goes live next month must still describe last
   * month's sample as the sample it was, and the screen must not have its own
   * copy of the sentence to drift from.
   */
  note?: string;
  decision?: InboundDecisionRecord;
}

/* ------------------------------------------------------------------ */
/* Reading the document itself                                         */
/* ------------------------------------------------------------------ */

/** What the arriving XML says about itself, as far as it can be read without a parser. */
export interface DocumentFacts {
  root: "Invoice" | "CreditNote" | null;
  number?: string;
  issueDate?: string;
  currency?: string;
  payableMinor?: number;
  supplierName?: string;
  supplierParticipantId?: string;
}

function unesc(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(xml);
  return m ? unesc(m[1]).trim() || undefined : undefined;
}

/**
 * Read the handful of facts a receiving corner has to have from the document.
 *
 * Regex over UBL rather than a parser, and the limits are worth being plain
 * about: this reads the document header (everything before the first `cac:`
 * group, which is where UBL's sequence puts the identifiers) plus the supplier
 * party and the payable total. It is not schema validation and does not pretend
 * to be — what it is for is having the document's OWN account of itself to set
 * against the envelope the driver summarised, so a disagreement between the two
 * is visible to the recipient rather than silently resolved in favour of
 * whichever one the screen happened to read.
 */
export function readDocumentFacts(xml: string): DocumentFacts {
  const rootMatch = /<(?:\w+:)?(Invoice|CreditNote)[\s>]/.exec(xml);
  const root = rootMatch ? (rootMatch[1] as "Invoice" | "CreditNote") : null;

  const firstGroup = xml.indexOf("<cac:");
  const header = firstGroup > 0 ? xml.slice(0, firstGroup) : xml;

  const supplierBlock = /<cac:AccountingSupplierParty>([\s\S]*?)<\/cac:AccountingSupplierParty>/.exec(xml)?.[1] ?? "";
  const endpoint = /<cbc:EndpointID(?:\s[^>]*schemeID="([^"]*)")?[^>]*>([^<]*)<\/cbc:EndpointID>/.exec(supplierBlock);

  const payable = /<cbc:PayableAmount(?:\s[^>]*)?>([^<]*)<\/cbc:PayableAmount>/.exec(xml);

  return {
    root,
    number: tag(header, "cbc:ID"),
    issueDate: tag(header, "cbc:IssueDate"),
    currency: tag(header, "cbc:DocumentCurrencyCode"),
    // `parseMoneyToMinor` is the same half-up conversion the rest of the product
    // uses at its parse boundary, so a document reading 1234.56 lands on the
    // same integer here as it would anywhere else.
    payableMinor: payable ? parseMoneyToMinor(payable[1]) : undefined,
    supplierName: tag(supplierBlock, "cbc:RegistrationName"),
    supplierParticipantId:
      endpoint && endpoint[2].trim()
        ? endpoint[1]
          ? `${endpoint[1]}:${endpoint[2].trim()}`
          : endpoint[2].trim()
        : undefined,
  };
}

/**
 * Everything wrong with an arrival, in sentences a recipient can act on.
 *
 * A failed check never rejects the delivery: the document arrived, and a
 * receiving corner that discards what it cannot understand leaves the sender
 * believing it was received and the recipient unable to see that it was. Issues
 * are recorded on the record, the status becomes HAS_ISSUES, and the person
 * decides — which is exactly what the accept-or-reject half of corner 4 is for.
 */
export function validateArrival(doc: InboundDocument, facts: DocumentFacts): string[] {
  const issues: string[] = [];

  if (!isWellFormedPeppolId(doc.senderParticipantId)) {
    issues.push(`The sender's participant id (${doc.senderParticipantId || "empty"}) is not a well-formed Peppol id.`);
  }
  if (!isWellFormedPeppolId(doc.receiverParticipantId)) {
    issues.push(`The recipient participant id (${doc.receiverParticipantId || "empty"}) is not a well-formed Peppol id.`);
  }

  if (facts.root === null) {
    issues.push("The payload is not a UBL Invoice or Credit Note, so nothing could be read from it.");
  }

  const knownType = doc.docTypeId === PINT_AE.invoiceDocTypeId || doc.docTypeId === PINT_AE.creditNoteDocTypeId;
  if (!knownType) {
    issues.push(`It arrived under document type ${doc.docTypeId || "(none)"}, which is not PINT AE billing.`);
  } else {
    const expectedRoot = doc.docTypeId === PINT_AE.creditNoteDocTypeId ? "CreditNote" : "Invoice";
    if (facts.root && facts.root !== expectedRoot) {
      issues.push(`The envelope declares a ${expectedRoot} and the payload is a ${facts.root}.`);
    }
  }

  // The envelope is the driver's summary and the document is the document. Where
  // they disagree the recipient is told, because the alternative is a screen
  // showing a total that the thing they are about to pay does not contain.
  if (facts.supplierParticipantId && facts.supplierParticipantId !== doc.senderParticipantId) {
    issues.push(
      `The envelope says it came from ${doc.senderParticipantId}; the document names ${facts.supplierParticipantId}.`,
    );
  }
  if (doc.currency && facts.currency && doc.currency !== facts.currency) {
    issues.push(`The envelope says ${doc.currency}; the document is denominated in ${facts.currency}.`);
  }
  if (!doc.currency && !facts.currency) {
    issues.push("Neither the envelope nor the document states a currency.");
  }
  if (
    typeof doc.totalMinor === "number" &&
    typeof facts.payableMinor === "number" &&
    doc.totalMinor !== facts.payableMinor
  ) {
    issues.push("The total on the envelope does not match the payable amount in the document.");
  }
  if (typeof doc.totalMinor === "number" && !Number.isSafeInteger(doc.totalMinor)) {
    issues.push("The envelope total is not a whole number of minor units.");
  }

  return issues;
}

/* ------------------------------------------------------------------ */
/* Resolving the recipient                                             */
/* ------------------------------------------------------------------ */

interface Recipient {
  orgId: string;
  entity: Entity;
}

/**
 * Which entity in this deployment IS the participant the document was sent to.
 *
 * The webhook carries no session, so this is the only thing that decides whose
 * inbox a document lands in — and a participant id is the network's name for a
 * business, which makes it the right key. Entities live as JSON in the shared
 * Record table, so the id is matched inside the document after a `contains`
 * narrows the scan; the exact comparison is done in TypeScript because a LIKE
 * on "0235:100" would also match "0235:1009988776".
 *
 * Two entities claiming one participant id is refused rather than guessed.
 * Delivering a supplier's invoice into the wrong tenant's inbox is not a
 * recoverable mistake, and it is a configuration error somebody must fix.
 */
export async function resolveRecipient(participantId: string): Promise<{ recipient?: Recipient; reason?: string }> {
  // `String(...)` rather than a bare `.trim()`: on the mock driver the webhook
  // verifies no signature, so what reaches this is whatever was posted.
  const wanted = String(participantId ?? "").trim();
  if (!wanted) return { reason: "The delivery names no recipient participant id." };

  const rows = await prisma.record.findMany({ where: { store: "entities", data: { contains: wanted } } });
  const matches = rows
    .map((r) => ({ orgId: r.orgId, entity: JSON.parse(r.data) as Entity }))
    .filter((m) => (m.entity.peppolParticipantId ?? "").trim() === wanted);

  if (matches.length === 0) {
    return { reason: `No entity in this deployment is registered as ${wanted}.` };
  }
  if (matches.length > 1) {
    return { reason: `${matches.length} entities are registered as ${wanted}, so the recipient is ambiguous.` };
  }
  return { recipient: matches[0] };
}

/* ------------------------------------------------------------------ */
/* Receiving                                                           */
/* ------------------------------------------------------------------ */

export interface InboundArrival {
  ok: boolean;
  /** Why nothing was stored — written to be read in a server log and in a route's answer. */
  reason?: string;
  /** True when this delivery had already been received (a webhook replay, a second poll). */
  duplicate?: boolean;
  doc?: InboundRecord;
}

/**
 * The record id for a delivery.
 *
 * Derived from the gateway's delivery reference so the same delivery is the
 * same row however often it is handed to us — the webhook may retry, a poll may
 * return a document already stored, and neither may produce a second invoice in
 * somebody's inbox. Hashed rather than used raw because the id goes in a URL.
 */
function inboundId(gatewayRef: string): string {
  return "in_" + createHash("sha256").update(gatewayRef).digest("hex").slice(0, 24);
}

/**
 * Take delivery of a document addressed to one of our participants.
 *
 * Resolve → validate → store → tell somebody. It never throws for a document it
 * cannot place: an unresolvable recipient comes back as a reason, so the caller
 * (the webhook, which has no session and no screen) can log it rather than
 * return a 500 to the gateway and be sent the same document again forever.
 */
export async function receiveInboundDocument(
  event: Extract<GatewayEvent, { kind: "DOCUMENT_RECEIVED" }>,
): Promise<InboundArrival> {
  const doc = event.document;
  if (!doc || typeof doc.receiverParticipantId !== "string") {
    return { ok: false, reason: `Delivery ${event.gatewayRef} carried no addressable document.` };
  }

  const { recipient, reason } = await resolveRecipient(doc.receiverParticipantId);
  if (!recipient) return { ok: false, reason };

  const { orgId, entity } = recipient;
  const id = inboundId(event.gatewayRef);

  const already = await getRecord<InboundRecord>(orgId, "inbound", id);
  if (already) return { ok: true, duplicate: true, doc: already };

  const facts = readDocumentFacts(doc.xml ?? "");
  const issues = validateArrival(doc, facts);

  // The driver's own claim about itself is not taken at face value: an event
  // that reached us through a simulated driver is simulated whether or not the
  // flag survived the trip, because the failure that matters is the one where a
  // rehearsal is presented as a supplier's invoice.
  const simulated = event.simulated === true || isSimulatedTransmission(getGateway().driver);

  const record: InboundRecord = {
    id,
    orgId,
    entityId: entity.id,
    // The document's own account of the supplier is preferred over the envelope
    // summary; the participant id is the fallback, because a blank name on an
    // inbox row tells the recipient nothing about who is invoicing them.
    senderName: facts.supplierName ?? doc.senderName ?? doc.senderParticipantId,
    senderParticipantId: doc.senderParticipantId,
    receiverParticipantId: doc.receiverParticipantId,
    docTypeId: doc.docTypeId,
    totalMinor: facts.payableMinor ?? doc.totalMinor ?? 0,
    currency: facts.currency ?? doc.currency ?? entity.defaultCurrency,
    status: issues.length ? "HAS_ISSUES" : "VALID",
    buyerAction: "NONE",
    receivedAt: event.at,
    gatewayRef: event.gatewayRef,
    simulated,
    ...(issues.length ? { issues } : {}),
    ...(doc.xml
      ? { xml: doc.xml, xmlSha256: createHash("sha256").update(doc.xml).digest("hex") }
      : {}),
    ...(simulated ? { note: SIMULATED_ARRIVAL_NOTE } : {}),
    invoice: {
      number: facts.number ?? doc.number,
      issueDate: facts.issueDate ?? doc.issueDate,
      currency: facts.currency ?? doc.currency,
    },
  };

  try {
    await putRecord(orgId, "inbound", record);
  } catch {
    // putRecord refuses a row that belongs to another tenant. That means two
    // orgs resolved from one delivery reference, which is a bug rather than a
    // document, and it must not become an exception the gateway retries.
    return { ok: false, reason: `Delivery ${event.gatewayRef} is already stored under another tenant.` };
  }

  const label = record.invoice?.number ? `${record.invoice.number} ` : "";
  const notification: AppNotification = {
    id: randomUUID(),
    orgId,
    createdAt: new Date().toISOString(),
    type: "inbound.received",
    // A rehearsal is never titled as an arrival and never toned as neutral news:
    // "an invoice arrived" about a document this deployment wrote for itself is
    // the receiving half of the sentence the send pipeline refuses to print.
    title: simulated
      ? `Simulated inbound document ${label}from ${record.senderName}`
      : `${label}arrived from ${record.senderName}`,
    body: simulated
      ? SIMULATED_ARRIVAL_NOTE
      : issues.length
        ? "It arrived with issues — open the inbox to see what disagrees before you accept it."
        : undefined,
    href: "/inbox",
    tone: simulated ? "warning" : issues.length ? "warning" : "neutral",
  };
  await putRecord(orgId, "notifications", notification);

  return { ok: true, doc: record };
}

/* ------------------------------------------------------------------ */
/* Asking the gateway for post                                         */
/* ------------------------------------------------------------------ */

export interface PollOutcome {
  ok: boolean;
  status: number;
  error?: string;
  received: number;
  duplicates: number;
  /** Deliveries the gateway offered that could not be placed, with the reason. */
  skipped: string[];
  /** True while the documents this returns are ones a simulator produced. */
  simulated: boolean;
}

/**
 * Ask the gateway what is waiting for this entity's participant.
 *
 * The live path for a pushed driver is the webhook; this is for drivers that
 * are polled, and for the mock, which is the only way a deployment on the
 * simulator ever sees the receiving path work.
 */
export async function pollInbound(orgId: string, entityId: string): Promise<PollOutcome> {
  const gw = getGateway();
  const simulated = isSimulatedTransmission(gw.driver);
  const empty = { received: 0, duplicates: 0, skipped: [] as string[], simulated };

  const entity = await getRecord<Entity>(orgId, "entities", entityId);
  if (!entity) return { ok: false, status: 404, error: "Entity not found", ...empty };

  const participantId = entity.peppolParticipantId?.trim();
  if (!participantId) {
    return {
      ok: false,
      status: 409,
      error: "This entity has no Peppol participant id, so nothing can be addressed to it.",
      ...empty,
    };
  }
  if (!gw.fetchInboundDocuments) {
    return { ok: false, status: 501, error: FETCH_UNSUPPORTED, ...empty };
  }

  const events = await gw.fetchInboundDocuments(participantId);
  let received = 0;
  let duplicates = 0;
  const skipped: string[] = [];
  for (const e of events) {
    if (e.kind !== "DOCUMENT_RECEIVED") continue;
    const arrival = await receiveInboundDocument(e);
    if (!arrival.ok) skipped.push(arrival.reason ?? `Delivery ${e.gatewayRef} could not be placed.`);
    else if (arrival.duplicate) duplicates++;
    else received++;
  }

  return { ok: true, status: 200, received, duplicates, skipped, simulated };
}

/* ------------------------------------------------------------------ */
/* Accept or reject                                                    */
/* ------------------------------------------------------------------ */

export interface DecisionInput {
  outcome: ReceiptDecision;
  reason?: string;
  /** The user id recorded against the decision. */
  actor: string;
}

export interface DecisionOutcome {
  ok: boolean;
  status: number;
  error?: string;
  doc?: InboundRecord;
}

/** Longer than this is a conversation, not a reason, and it travels on the wire. */
const MAX_REASON = 500;

/**
 * Record the recipient's answer and, where the gateway can carry it, send it.
 *
 * The two halves are deliberately separable. A decision that could not be
 * transmitted is still a decision the recipient made and must be able to see;
 * what must never happen is the screen implying the supplier heard it. So
 * `transmitted` is set only for a live driver that accepted the receipt, and
 * everything else carries the sentence explaining what did not happen.
 *
 * A second decision is refused once the first has been transmitted — the
 * supplier has been told, and the way to change that answer is a new document,
 * not a rewritten row. Before then the same outcome may be sent again, which is
 * what makes "send it again once the gateway is reachable" a true instruction.
 */
export async function recordInboundDecision(
  orgId: string,
  id: string,
  input: DecisionInput,
): Promise<DecisionOutcome> {
  const record = await getRecord<InboundRecord>(orgId, "inbound", id);
  if (!record) return { ok: false, status: 404, error: "This inbound document is not in your inbox." };

  const previous = record.decision;
  if (previous && previous.outcome !== input.outcome) {
    return {
      ok: false,
      status: 409,
      error: `This document was already ${previous.outcome.toLowerCase()} on ${previous.decidedAt.slice(0, 10)}.`,
    };
  }
  if (previous?.transmitted) {
    return { ok: false, status: 409, error: "The supplier has already been told. Nothing was changed." };
  }

  // On a retry the reason stands as it was given: the decision was made once,
  // and letting the second attempt rewrite why would leave the supplier holding
  // one reason and the recipient's record showing another.
  const reason = previous?.reason ?? input.reason?.trim().slice(0, MAX_REASON);
  if (input.outcome === "REJECTED" && !reason) {
    return {
      ok: false,
      status: 422,
      error: "A rejection has to say why — the supplier is sent the reason so they can correct the document.",
    };
  }

  const gw = getGateway();
  const simulated = isSimulatedTransmission(gw.driver);
  const at = new Date().toISOString();

  let transmitted = false;
  let receiptRef: string | undefined;
  let note: string | undefined;

  if (!gw.sendReceipt) {
    note = RECEIPT_NOT_TRANSMITTED;
  } else {
    try {
      const result = await gw.sendReceipt({
        idempotencyKey: `receipt:${record.id}:${input.outcome}`,
        gatewayRef: record.gatewayRef,
        fromParticipantId: record.receiverParticipantId,
        toParticipantId: record.senderParticipantId,
        decision: input.outcome,
        reason,
        at,
      });
      receiptRef = result.receiptRef;
      // The simulator answers this call the way it answers a submission: with a
      // reference it made up. Whether anything left the deployment is decided by
      // the driver, never by the call having returned.
      transmitted = !simulated;
      note = simulated ? SIMULATED_SEND_NOTE : undefined;
    } catch {
      note = RECEIPT_SEND_FAILED;
    }
  }

  const decision: InboundDecisionRecord = {
    outcome: input.outcome,
    ...(reason ? { reason } : {}),
    decidedAt: previous?.decidedAt ?? at,
    decidedBy: previous?.decidedBy ?? input.actor,
    transmitted,
    simulated,
    ...(receiptRef ? { receiptRef } : {}),
    ...(note ? { note } : {}),
  };

  const updated: InboundRecord = {
    ...record,
    // `buyerAction` is what the existing screen and the shell's badge count read.
    // DISPUTED is the nearest thing the domain type has to a rejection; see the
    // handoff note asking for a REJECTED member on InboundDoc.
    buyerAction: input.outcome === "REJECTED" ? "DISPUTED" : "ACKNOWLEDGED",
    decision,
  };
  await putRecord(orgId, "inbound", updated);
  return { ok: true, status: 200, doc: updated };
}

/**
 * Mark an arrival as taken into the books.
 *
 * This sets a marker and nothing else — no document is created and nothing is
 * sent anywhere, which is why the screen says so in those words. It lives on
 * the server rather than as a client store write so that the browser never
 * round-trips the whole record: `/api/store/inbound` accepts whatever a client
 * posts, and a client that re-posts a record it holds can flip the fields this
 * module owns, `decision.transmitted` first among them.
 */
export async function markInboundExported(orgId: string, id: string): Promise<DecisionOutcome> {
  const record = await getRecord<InboundRecord>(orgId, "inbound", id);
  if (!record) return { ok: false, status: 404, error: "This inbound document is not in your inbox." };
  if (record.decision?.outcome === "REJECTED") {
    return { ok: false, status: 409, error: "A rejected document isn't taken into the books." };
  }
  const updated: InboundRecord = { ...record, buyerAction: "EXPORTED" };
  await putRecord(orgId, "inbound", updated);
  return { ok: true, status: 200, doc: updated };
}
