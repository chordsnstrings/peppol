"use client";

import { touch } from "@/lib/db/database";

/** Trigger generation of all due recurring templates for the tenant. */
export async function runRecurring(): Promise<{ generated: number; sent: number }> {
  const res = await fetch("/api/recurring/run", { method: "POST" });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Couldn't run recurring");
  ["invoices", "recurring", "invoiceEvents", "notifications", "entities"].forEach((s) =>
    touch(s as Parameters<typeof touch>[0]),
  );
  return body;
}
