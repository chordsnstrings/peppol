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

/** Normalized events the drivers emit (spec §5.6). */
export type GatewayEvent =
  | { kind: "EXCHANGE_MLS"; gatewayRef: string; status: "ACCEPTED" | "REJECTED"; code?: string; reasons?: MlsReason[]; at: string }
  | { kind: "REPORTING_MLS"; gatewayRef: string; leg: "C2" | "C3"; status: "ACCEPTED" | "REJECTED"; code?: string; reasons?: MlsReason[]; at: string }
  | { kind: "DELIVERY_FAILED"; gatewayRef: string; reason: string; retryable: boolean; at: string };

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
}

/** UAE PINT AE document-type / process identifiers (loaded from vendored artefacts in prod). */
export const PINT_AE = {
  invoiceDocTypeId:
    "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2::Invoice##urn:peppol:pint:billing-1@ae-1::2.1",
  creditNoteDocTypeId:
    "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2::CreditNote##urn:peppol:pint:billing-1@ae-1::2.1",
  processId: "urn:peppol:bis:billing",
};
