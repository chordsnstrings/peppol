import { randomUUID } from "node:crypto";
import type { WhatsAppPort, WhatsAppSendRequest } from "./port";

/** Mock: records the send without contacting WhatsApp. */
export const mockWhatsApp: WhatsAppPort = {
  driver: "mock",
  async send() {
    return { providerRef: `wa-mock-${randomUUID().slice(0, 8)}` };
  },
  async healthcheck() {
    return { ok: true, detail: "mock whatsapp" };
  },
};

/**
 * Meta WhatsApp Cloud API. The platform holds one WhatsApp Business account +
 * system-user token (WHATSAPP_TOKEN); each tenant sends from its own registered
 * phone-number id. Graph API: POST /{phoneNumberId}/messages.
 */
const GRAPH = () => process.env.WHATSAPP_GRAPH_BASE ?? "https://graph.facebook.com/v19.0";

export const metaWhatsApp: WhatsAppPort = {
  driver: "meta",
  async send(config, req: WhatsAppSendRequest) {
    const phoneNumberId = config.phoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? "";
    const res = await fetch(`${GRAPH()}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN ?? ""}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: req.to.replace(/[^\d]/g, ""),
        type: "text",
        text: { preview_url: true, body: req.text },
      }),
    });
    if (!res.ok) throw new Error(`WhatsApp send failed (${res.status})`);
    const j = (await res.json()) as { messages?: Array<{ id: string }> };
    return { providerRef: j.messages?.[0]?.id ?? "sent" };
  },
  async healthcheck() {
    return { ok: Boolean(process.env.WHATSAPP_TOKEN), detail: "meta cloud" };
  },
};
