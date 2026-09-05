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
 *
 * Every event it emits carries `simulated: true`. That flag is the whole reason
 * the rest of the product can be honest about a rehearsal: this driver's
 * "ACCEPTED" is a value assigned in this file, not an acknowledgement from the
 * buyer's Access Point or the FTA, and an acceptance nobody sent is exactly the
 * thing a user must never be shown as fact.
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
      { kind: "EXCHANGE_MLS", gatewayRef, status: "ACCEPTED", at, simulated: true },
      { kind: "REPORTING_MLS", gatewayRef, leg: "C2", status: "ACCEPTED", at, simulated: true },
    ];
  },

  async parseWebhook(_headers, rawBody: string): Promise<GatewayEvent[]> {
    try {
      const parsed = JSON.parse(rawBody);
      const events = (Array.isArray(parsed) ? parsed : [parsed]) as GatewayEvent[];
      // This driver verifies no signature, so anything that reaches it is a
      // hand-posted body. The flag is re-stamped here rather than trusted from
      // the payload: a caller must not be able to launder an event into looking
      // like a real one by leaving the field out.
      return events.map((e) => ({ ...e, simulated: true }));
    } catch {
      return [];
    }
  },

  async healthcheck(): Promise<HealthStatus> {
    return { ok: true, detail: "mock gateway — simulated, reaches no network" };
  },
};
