import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { UnauthorizedError } from "./session";
import { PlatformForbiddenError } from "./platform-admin";

export function json(data: unknown, init?: number | ResponseInit) {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init);
}

/**
 * An error whose message is SAFE to show the client. Anything that isn't an
 * AppError (or one of the known typed errors) is treated as internal and
 * returned as a generic message — never leak Prisma/stack/internal detail.
 */
export class AppError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AppError";
    this.status = status;
  }
}

export function handleError(e: unknown) {
  if (e instanceof UnauthorizedError) return json({ error: "Unauthorized" }, 401);
  if (e instanceof PlatformForbiddenError) return json({ error: "Forbidden" }, 403);
  if (e instanceof AppError) return json({ error: e.message }, e.status);
  // Typed errors carrying an explicit HTTP status (e.g. ApiKeyError).
  if (e instanceof Error && typeof (e as unknown as { status?: unknown }).status === "number") {
    return json({ error: e.message }, (e as unknown as { status: number }).status);
  }
  // Zod → safe per-field messages (useful for forms, no internal structure leak).
  if (e instanceof ZodError) {
    return json({ error: "Please check the submitted fields.", fields: e.flatten().fieldErrors }, 400);
  }
  // Prisma / anything else → generic, logged server-side only.
  if (e instanceof Error && e.name.startsWith("PrismaClient")) {
    console.error("[db error]", e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
  // Plain developer-authored Error messages are intended for the client
  // (e.g. "Invoice not found"); everything else is opaque.
  if (e instanceof Error && e.constructor === Error) {
    return json({ error: e.message }, 400);
  }
  console.error("[unhandled error]", e);
  return json({ error: "Something went wrong. Please try again." }, 500);
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
