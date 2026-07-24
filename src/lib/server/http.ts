import { NextResponse } from "next/server";
import { UnauthorizedError } from "./session";

export function json(data: unknown, init?: number | ResponseInit) {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init);
}

export function handleError(e: unknown) {
  if (e instanceof UnauthorizedError) return json({ error: "Unauthorized" }, 401);
  const message = e instanceof Error ? e.message : "Server error";
  return json({ error: message }, 400);
}

/** Domain document stores the client may read/write (all tenant-scoped by orgId). */
export const ALLOWED_STORES = new Set([
  "entities",
  "customers",
  "products",
  "invoices",
  "invoiceEvents",
  "connections",
  "syncLinks",
  "fixits",
  "inbound",
  "notifications",
  "members",
  "whatsapp",
]);

export function assertStore(store: string) {
  if (!ALLOWED_STORES.has(store)) {
    throw new Error(`Unknown store: ${store}`);
  }
}
