import { NextResponse } from "next/server";
import { UnauthorizedError } from "./session";

export function json(data: unknown, init?: number | ResponseInit) {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init);
}

export function handleError(e: unknown) {
  if (e instanceof UnauthorizedError) return json({ error: "Unauthorized" }, 401);
  // Errors carrying an explicit HTTP status (e.g. ApiKeyError) honor it.
  if (e instanceof Error && typeof (e as unknown as { status?: unknown }).status === "number") {
    return json({ error: e.message }, (e as unknown as { status: number }).status);
  }
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
  "recurring",
]);

export function assertStore(store: string) {
  if (!ALLOWED_STORES.has(store)) {
    throw new Error(`Unknown store: ${store}`);
  }
}
