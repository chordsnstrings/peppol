"use client";

import { touch } from "@/lib/db/database";

export async function createPaymentLink(invoiceId: string): Promise<{ url: string; driver: string }> {
  const res = await fetch(`/api/invoices/${invoiceId}/payment-link`, { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Couldn't create payment link");
  touch("invoices");
  return body;
}

export async function markPaid(invoiceId: string, method?: string): Promise<void> {
  const res = await fetch(`/api/invoices/${invoiceId}/mark-paid`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Couldn't mark as paid");
  }
  touch("invoices");
  touch("invoiceEvents");
  touch("notifications");
}

export async function sendReminder(invoiceId: string): Promise<void> {
  await fetch(`/api/invoices/${invoiceId}/remind`, { method: "POST" });
  touch("invoices");
  touch("invoiceEvents");
}

export async function runReminders(): Promise<number> {
  const res = await fetch(`/api/reminders/run`, { method: "POST" });
  const body = await res.json();
  touch("invoices");
  touch("invoiceEvents");
  touch("notifications");
  return body.sent ?? 0;
}
