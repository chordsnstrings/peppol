/**
 * PeppolGatewayPort (build spec §5.6) — the single abstraction over the Peppol
 * 5-corner network + FTA (C5) reporting. Nothing above this port knows which
 * driver is active (mock | taxilla | own-ap). The send pipeline maps a document
 * to a SubmitRequest and applies the returned GatewayEvents to the invoice's
 * two status dimensions (exchange leg + reporting leg).
 */

export type GatewayDriverId = "mock" | "taxilla";

export interface ParticipantCapability {
  participantId: string;
  onNetwork: boolean;
  supportedDocTypes?: string[];
  checkedAt: string;
}

export interface MlsReason {
  code: string;
  message: string;
}

export interface SubmitRequest {
  /** Our idempotency key — drivers MUST dedupe on it. */
  idempotencyKey: string;
  senderParticipantId: string; // 0235:XXXXXXXXXX
  receiverParticipantId: string;
  docTypeId: string; // full Peppol document type identifier for PINT AE
  processId: string;
  /** Final PINT AE UBL (raw XML). */
  xml: string;
  /** UAE Tax Data Document for the C5 reporting leg (raw XML). */
  tdd: string;
}

export interface SubmitResult {
  gatewayRef: string;
}

/**
 * A document that arrived FOR one of our participants — corner 4.
 *
 * The five-corner model has two halves and this port only ever described one:
 * every type above is about a document WE sent. A mandated business is also
 * required to be reachable, so a supplier's invoice addressed to one of our
 * participants is a first-class thing the network hands us, not an anomaly.
 *
 * The header fields below are what the DRIVER read off the delivery envelope;
 * `xml` is the document itself. They are kept apart on purpose, because the
 * receiver checks one against the other rather than trusting the summary — a
 * driver that reads a total wrongly then produces a document flagged as
 * disagreeing with its own envelope, instead of a wrong figure on a screen.
 */
export interface InboundDocument {
  senderParticipantId: string;
  receiverParticipantId: string;
  docTypeId: string;
  /** The document exactly as it was delivered. This is the record of what arrived. */
  xml: string;
  /** Envelope header fields, where the driver supplies them. */
  senderName?: string;
  number?: string;
  issueDate?: string;
  currency?: string;
  /** Integer minor units, as the driver read them off the envelope. */
  totalMinor?: number;
}

/**
 * Normalized events the drivers emit (spec §5.6).
 *
 * `simulated` marks an outcome a driver invented instead of reading off the
 * network. It travels on the event itself rather than being re-derived later,
 * because the question "was this real?" is asked in four places (the timeline
 * narrative, the notification, the status chips, the evidence bundle) and two
 * of them run long after the send — a webhook delivery, an auditor opening a
 * bundle from last quarter. An absent flag therefore has to mean "real", so it
 * is set by the mock and by nothing else.
 *
 * DOCUMENT_RECEIVED is the one event that is not about a document we sent, so
 * its `gatewayRef` is the gateway's reference for the DELIVERY rather than for
 * a Transmission row — nothing in this deployment will match it to one, and a
 * consumer that looks one up must branch on `kind` before it tries.
 */
export type GatewayEvent =
  | { kind: "EXCHANGE_MLS"; gatewayRef: string; status: "ACCEPTED" | "REJECTED"; code?: string; reasons?: MlsReason[]; at: string; simulated?: boolean }
  | { kind: "REPORTING_MLS"; gatewayRef: string; leg: "C2" | "C3"; status: "ACCEPTED" | "REJECTED"; code?: string; reasons?: MlsReason[]; at: string; simulated?: boolean }
  | { kind: "DELIVERY_FAILED"; gatewayRef: string; reason: string; retryable: boolean; at: string; simulated?: boolean }
  | { kind: "DOCUMENT_RECEIVED"; gatewayRef: string; document: InboundDocument; at: string; simulated?: boolean };

/** What a recipient may say back about a document that arrived. */
export type ReceiptDecision = "ACCEPTED" | "REJECTED";

/**
 * The recipient's answer, on its way back to the supplier.
 *
 * A buyer who cannot refuse a document has not received it in any sense the
 * mandate cares about: the supplier is owed the answer, because a rejection is
 * what tells them to issue a corrected document rather than chase a payment.
 * The direction is the reverse of `SubmitRequest`, hence `from`/`to` rather
 * than sender/receiver — "sender" on an answer to an invoice is ambiguous in
 * exactly the place it must not be.
 */
export interface ReceiptRequest {
  /** Our idempotency key — drivers MUST dedupe on it. */
  idempotencyKey: string;
  /** The delivery being answered, as the gateway referred to it. */
  gatewayRef: string;
  /** Us: the participant the document was delivered to. */
  fromParticipantId: string;
  /** The supplier who sent it, and who has to hear the answer. */
  toParticipantId: string;
  decision: ReceiptDecision;
  /** The recipient's own words. Carried verbatim: it is why the document was refused. */
  reason?: string;
  at: string;
}

export interface ReceiptResult {
  receiptRef: string;
}

export interface HealthStatus {
  ok: boolean;
  detail?: string;
}

export interface PeppolGatewayPort {
  driver: GatewayDriverId;
  /** SMP/directory capability lookup for the receiver. */
  lookupParticipant(participantId: string): Promise<ParticipantCapability>;
  /** Idempotent submission of the exchange + reporting job for one document. */
  submitDocument(req: SubmitRequest): Promise<SubmitResult>;
  /** Pull reconciliation for drivers without webhooks (mock returns terminal events immediately). */
  fetchStatusUpdates(gatewayRef: string): Promise<GatewayEvent[]>;
  /** Verify + parse an inbound webhook into normalized events. */
  parseWebhook(headers: Record<string, string>, rawBody: string): Promise<GatewayEvent[]>;
  healthcheck(): Promise<HealthStatus>;

  /**
   * Documents waiting for one of our participants, for drivers that are polled
   * rather than pushed (and for the mock, which delivers a sample so the
   * receiving path can be exercised with no network). Returns DOCUMENT_RECEIVED
   * events; a driver that pushes everything over its webhook returns nothing.
   */
  fetchInboundDocuments?(participantId: string): Promise<GatewayEvent[]>;

  /**
   * Transmit the recipient's accept/reject back to the supplier.
   *
   * Optional, and it has to be: a driver that has no channel for this must be
   * able to say so by not implementing it. The alternative — a stub that
   * resolves — would let the product record "rejected" and tell the buyer the
   * supplier was told, which is the one thing a receiving corner must never
   * get wrong.
   */
  sendReceipt?(req: ReceiptRequest): Promise<ReceiptResult>;
}

/** UAE PINT AE document-type / process identifiers (loaded from vendored artefacts in prod). */
export const PINT_AE = {
  invoiceDocTypeId:
    "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:peppol:pint:billing-1@ae-1::2.1",
  creditNoteDocTypeId:
    "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2::CreditNote##urn:peppol:pint:billing-1@ae-1::2.1",
  processId: "urn:peppol:bis:billing",
};
