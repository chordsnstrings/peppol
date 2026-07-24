import type { WhatsAppDriverId, WhatsAppPort } from "./port";
import { mockWhatsApp, metaWhatsApp } from "./drivers";

/**
 * Resolve the active WhatsApp driver from WHATSAPP_DRIVER. Defaults to the mock
 * driver so messaging runs credential-free; set WHATSAPP_DRIVER=meta (+ a
 * WHATSAPP_TOKEN system-user token) to send through the Meta Cloud API. Each
 * tenant still connects its own number (phone-number id) under the platform BA.
 */
export function getWhatsApp(): WhatsAppPort {
  const driver = (process.env.WHATSAPP_DRIVER ?? "mock").toLowerCase();
  if (driver === "meta" && process.env.WHATSAPP_TOKEN) return metaWhatsApp;
  return mockWhatsApp;
}

export function whatsappIsLive(): boolean {
  return (process.env.WHATSAPP_DRIVER ?? "mock").toLowerCase() === "meta" && Boolean(process.env.WHATSAPP_TOKEN);
}

export const WHATSAPP_DRIVERS: { id: WhatsAppDriverId; label: string }[] = [
  { id: "mock", label: "Sandbox (test)" },
  { id: "meta", label: "Meta WhatsApp Cloud API" },
];
