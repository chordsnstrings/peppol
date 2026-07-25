import { prisma } from "@/lib/server/prisma";
import { json, handleError, assertStore } from "@/lib/server/http";
import { requireWritableSession } from "@/lib/server/org-status";
import { requireEffectiveSession } from "@/lib/server/effective-session";
import { assertSameOrigin } from "@/lib/server/platform-admin";

export const runtime = "nodejs";

/**
 * Strip fields a tenant must never own, and pin server-authoritative state from
 * the existing row. The document store is a write-anything JSON sink, so this is
 * the guard that stops a tenant fabricating payment/compliance state in their own
 * records. Payment state and (post-send) transmission status come only from the
 * server pipelines, never a client write.
 */
function sanitizeRecord(store: string, body: Record<string, unknown>, prev: Record<string, unknown> | null): Record<string, unknown> {
  const clean = { ...body };
  delete clean.orgId; // always re-stamped from the session

  if (store === "invoices") {
    // AR/payment fields are only set by the payment webhook / mark-paid routes.
    clean.amountPaidMinor = prev?.amountPaidMinor;
    clean.paymentStatus = prev?.paymentStatus;
    clean.paidAt = prev?.paidAt;
    if (!prev) {
      // On create, compliance state is always initial — a tenant can't mint a
      // "delivered & reported" invoice; only the send pipeline advances these.
      clean.exchangeStatus = "NOT_SENT";
      clean.reportingStatusC2 = "NOT_REPORTED";
      clean.sentAt = undefined;
      clean.deliveredAt = undefined;
      clean.reportedAt = undefined;
      clean.lockedAt = undefined;
    } else if (prev.lockedAt) {
      // Once locked (sent), the two status dimensions + timestamps are authoritative.
      clean.lifecycleStatus = prev.lifecycleStatus;
      clean.exchangeStatus = prev.exchangeStatus;
      clean.reportingStatusC2 = prev.reportingStatusC2;
      clean.sentAt = prev.sentAt;
      clean.deliveredAt = prev.deliveredAt;
      clean.reportedAt = prev.reportedAt;
      clean.lockedAt = prev.lockedAt;
    }
  }
  return clean;
}

/** List records in a store for the current tenant (or the impersonated tenant). */
export async function GET(req: Request, ctx: { params: Promise<{ store: string }> }) {
  try {
    const { store } = await ctx.params;
    assertStore(store);
    const { orgId } = await requireEffectiveSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId") ?? undefined;
    const invoiceId = url.searchParams.get("invoiceId") ?? undefined;

    const rows = await prisma.record.findMany({
      where: { orgId, store, ...(entityId ? { entityId } : {}), ...(invoiceId ? { invoiceId } : {}) },
    });
    return json({ items: rows.map((r) => JSON.parse(r.data)) });
  } catch (e) {
    return handleError(e);
  }
}

/** Upsert a single record. orgId is always taken from the session (never trusted from the body). */
export async function POST(req: Request, ctx: { params: Promise<{ store: string }> }) {
  try {
    const { store } = await ctx.params;
    assertStore(store);
    await assertSameOrigin(req);
    const { orgId } = await requireWritableSession();
    const body = (await req.json()) as Record<string, unknown>;
    const id = body.id as string | undefined;
    if (!id) return json({ error: "Record must have an id" }, 400);

    // Guard against cross-tenant overwrites: a record id may only be written by its owner.
    const existing = await prisma.record.findUnique({ where: { store_id: { store, id } } });
    if (existing && existing.orgId !== orgId) return json({ error: "Forbidden" }, 403);

    const prev = existing ? (JSON.parse(existing.data) as Record<string, unknown>) : null;
    const clean = sanitizeRecord(store, body, prev);
    const entityId = (clean.entityId as string | undefined) ?? null;
    const invoiceId = (clean.invoiceId as string | undefined) ?? null;
    const data = JSON.stringify({ ...clean, orgId });

    const saved = await prisma.record.upsert({
      where: { store_id: { store, id } },
      create: { id, orgId, store, entityId, invoiceId, data },
      update: { data, entityId, invoiceId },
    });
    return json({ item: JSON.parse(saved.data) });
  } catch (e) {
    return handleError(e);
  }
}
