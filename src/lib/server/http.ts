import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { UnauthorizedError } from "./session";
import { PlatformForbiddenError } from "./platform-admin";

/**
 * A JSON response, with BigInt handled rather than fatal.
 *
 * Every amount in this ledger is a BigInt — minor units, never a float — and
 * `JSON.stringify` throws on one. So a route that returned a module's result
 * without putting it through `ledgerJson` first answered 500 with "Something
 * went wrong. Please try again." The customer receipt route did exactly that,
 * and it did it AFTER the money had moved and the entry had posted: the books
 * were right, the caller was told the request had failed, and the obvious next
 * step was to try again.
 *
 * `ledgerJson` is still the right thing to call at a route that also has Dates
 * and Decimals to convert, and most do. This is the floor beneath it, so the
 * failure mode of forgetting is a slightly different shape of number rather
 * than a 500 over a posting that succeeded.
 *
 * A BigInt becomes a decimal string, which is what `ledgerJson` does with one
 * and what every client here already reads.
 */
export function json(data: unknown, init?: number | ResponseInit) {
  const status = typeof init === "number" ? { status: init } : init;
  return new NextResponse(
    JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    { ...status, headers: { "content-type": "application/json", ...(status?.headers ?? {}) } },
  );
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
