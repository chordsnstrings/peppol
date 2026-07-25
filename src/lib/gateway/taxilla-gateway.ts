import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  GatewayEvent,
  HealthStatus,
  MlsReason,
  ParticipantCapability,
  PeppolGatewayPort,
  SubmitRequest,
  SubmitResult,
} from "./port";

/**
 * Taxilla partner gateway (Route A). Implemented against our ASSUMED REST
 * contract in docs/partner-contract.md so that swapping in Taxilla's real API is
 * localized to this one file (spec §5.6). Activated with GATEWAY_DRIVER=taxilla
 * + TAXILLA_* credentials. Not exercised until real sandbox credentials exist.
 */
const BASE = () => process.env.TAXILLA_BASE_URL ?? "";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.TAXILLA_API_KEY ?? ""}`,
    "X-Client-Id": process.env.TAXILLA_CLIENT_ID ?? "",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

interface TaxillaStatus {
  reference: string;
  exchange?: { status?: string; code?: string; reasons?: MlsReason[] };
  reporting?: {
    c2?: { status?: string; code?: string; reasons?: MlsReason[] };
    c3?: { status?: string; code?: string; reasons?: MlsReason[] };
  };
}

function norm(s?: string): "ACCEPTED" | "REJECTED" | null {
  if (!s) return null;
  const u = s.toUpperCase();
  if (["ACCEPTED", "DELIVERED", "SUCCESS", "REPORTED"].includes(u)) return "ACCEPTED";
  if (["REJECTED", "FAILED", "ERROR"].includes(u)) return "REJECTED";
  return null;
}

function mapStatus(j: TaxillaStatus): GatewayEvent[] {
  const at = new Date().toISOString();
  const events: GatewayEvent[] = [];
  const ex = norm(j.exchange?.status);
  if (ex) events.push({ kind: "EXCHANGE_MLS", gatewayRef: j.reference, status: ex, code: j.exchange?.code, reasons: j.exchange?.reasons, at });
  const c2 = norm(j.reporting?.c2?.status);
  if (c2) events.push({ kind: "REPORTING_MLS", gatewayRef: j.reference, leg: "C2", status: c2, code: j.reporting?.c2?.code, reasons: j.reporting?.c2?.reasons, at });
  const c3 = norm(j.reporting?.c3?.status);
  if (c3) events.push({ kind: "REPORTING_MLS", gatewayRef: j.reference, leg: "C3", status: c3, code: j.reporting?.c3?.code, reasons: j.reporting?.c3?.reasons, at });
  return events;
}

export const taxillaGateway: PeppolGatewayPort = {
  driver: "taxilla",

  async lookupParticipant(participantId): Promise<ParticipantCapability> {
    const res = await fetch(`${BASE()}/v1/participants/${encodeURIComponent(participantId)}`, {
      headers: headers(),
    });
    if (!res.ok) {
      return { participantId, onNetwork: false, checkedAt: new Date().toISOString() };
    }
    const j = (await res.json()) as { registered?: boolean; onNetwork?: boolean; documentTypes?: string[] };
    return {
      participantId,
      onNetwork: Boolean(j.registered ?? j.onNetwork),
      supportedDocTypes: j.documentTypes,
      checkedAt: new Date().toISOString(),
    };
  },

  async submitDocument(req: SubmitRequest): Promise<SubmitResult> {
    const res = await fetch(`${BASE()}/v1/documents`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        idempotencyKey: req.idempotencyKey,
        sender: req.senderParticipantId,
        receiver: req.receiverParticipantId,
        documentTypeId: req.docTypeId,
        processId: req.processId,
        payload: b64(req.xml),
        payloadFormat: "UBL",
        reporting: { taxDataDocument: b64(req.tdd) },
      }),
    });
    if (!res.ok) throw new Error(`Taxilla submit failed (${res.status})`);
    const j = (await res.json()) as { reference?: string; gatewayRef?: string };
    const gatewayRef = j.reference ?? j.gatewayRef;
    if (!gatewayRef) throw new Error("Taxilla submit returned no reference");
    return { gatewayRef };
  },

  async fetchStatusUpdates(gatewayRef): Promise<GatewayEvent[]> {
    const res = await fetch(`${BASE()}/v1/documents/${encodeURIComponent(gatewayRef)}`, {
      headers: headers(),
    });
    if (!res.ok) return [];
    return mapStatus((await res.json()) as TaxillaStatus);
  },

  async parseWebhook(hdrs, rawBody): Promise<GatewayEvent[]> {
    // Fail-closed: a live gateway webhook must be signed and verified.
    const secret = process.env.TAXILLA_WEBHOOK_SECRET;
    if (!secret) throw new Error("TAXILLA_WEBHOOK_SECRET is not configured");
    const sig = hdrs["x-taxilla-signature"] ?? hdrs["X-Taxilla-Signature"] ?? "";
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("Invalid Taxilla webhook signature");
    }
    return mapStatus(JSON.parse(rawBody) as TaxillaStatus);
  },

  async healthcheck(): Promise<HealthStatus> {
    try {
      const res = await fetch(`${BASE()}/v1/health`, { headers: headers() });
      return { ok: res.ok, detail: `taxilla ${res.status}` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "unreachable" };
    }
  },
};
