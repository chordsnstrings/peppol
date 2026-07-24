"use client";

import { touch } from "@/lib/db/database";
import type { WhatsAppConfig } from "@/lib/domain/types";

export async function connectWhatsApp(input: {
  entityId: string;
  displayNumber: string;
  phoneNumberId?: string;
}): Promise<WhatsAppConfig> {
  const res = await fetch(`/api/whatsapp/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Couldn't connect WhatsApp");
  touch("whatsapp");
  return body.config as WhatsAppConfig;
}

export async function disconnectWhatsApp(entityId: string): Promise<void> {
  const res = await fetch(`/api/whatsapp/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entityId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Couldn't disconnect WhatsApp");
  }
  touch("whatsapp");
}

export async function sendInvoiceWhatsApp(
  invoiceId: string,
  to?: string,
): Promise<{ to: string; paymentLinkUrl: string | null }> {
  const res = await fetch(`/api/invoices/${invoiceId}/whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Couldn't send on WhatsApp");
  touch("invoices");
  touch("invoiceEvents");
  touch("notifications");
  return body;
}
