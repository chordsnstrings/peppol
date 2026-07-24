import { createHash } from "node:crypto";
import type {
  GatewayEvent,
  HealthStatus,
  ParticipantCapability,
  PeppolGatewayPort,
  SubmitRequest,
  SubmitResult,
} from "./port";

/**
 * In-process mock gateway (spec §5.6). Runs the full send pipeline with no
 * external calls: submit returns a ref and fetchStatusUpdates returns a terminal
 * ACCEPTED on both legs, so a sandbox send completes end-to-end. Configurable
 * failure can be added later via the mock-network simulator.
 */
export const mockGateway: PeppolGatewayPort = {
  driver: "mock",

  async lookupParticipant(participantId: string): Promise<ParticipantCapability> {
    const onNetwork = /^\d{4}:\d{6,}$/.test(participantId);
    return {
      participantId,
      onNetwork,
      supportedDocTypes: ["PINT_AE_INVOICE", "PINT_AE_CREDIT_NOTE"],
      checkedAt: new Date().toISOString(),
    };
  },

  async submitDocument(req: SubmitRequest): Promise<SubmitResult> {
    const ref = "MOCK-" + createHash("sha1").update(req.idempotencyKey).digest("hex").slice(0, 16).toUpperCase();
    return { gatewayRef: ref };
  },

  async fetchStatusUpdates(gatewayRef: string): Promise<GatewayEvent[]> {
    const at = new Date().toISOString();
    return [
      { kind: "EXCHANGE_MLS", gatewayRef, status: "ACCEPTED", at },
      { kind: "REPORTING_MLS", gatewayRef, leg: "C2", status: "ACCEPTED", at },
    ];
  },

  async parseWebhook(_headers, rawBody: string): Promise<GatewayEvent[]> {
    try {
      const parsed = JSON.parse(rawBody);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  },

  async healthcheck(): Promise<HealthStatus> {
    return { ok: true, detail: "mock gateway" };
  },
};
