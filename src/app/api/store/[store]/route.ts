import { prisma } from "@/lib/server/prisma";
import { json, handleError, assertStore } from "@/lib/server/http";
import { requireWritableSession } from "@/lib/server/org-status";
import { requireEffectiveSession } from "@/lib/server/effective-session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { gatewayIsLive } from "@/lib/gateway/registry";
import { SIMULATED_ACTIVATION_BLOCK } from "@/lib/gateway/disclosure";

export const runtime = "nodejs";

/**
 * Strip fields a tenant must never own, and pin server-authoritative state from
 * the existing row. The document store is a write-anything JSON sink, so this is
 * the guard that stops a tenant fabricating payment/compliance state in their own
 * records. Payment state and (post-send) transmission status come only from the
 * server pipelines, never a client write.
 */
/** Lifecycle states only ever reached via the server send pipeline. */
const SERVER_LIFECYCLE = new Set(["QUEUED", "SENDING", "SENT", "DELIVERED", "COMPLETED", "FAILED"]);

function sanitizeRecord(store: string, body: Record<string, unknown>, prev: Record<string, unknown> | null): Record<string, unknown> {
  const clean = { ...body };
  delete clean.orgId; // always re-stamped from the session

  if (store === "invoices") {
    // Payment/AR fields: only the payment webhook / mark-paid routes set these.
    clean.amountPaidMinor = prev?.amountPaidMinor;
    clean.paymentStatus = prev?.paymentStatus;
    clean.paidAt = prev?.paidAt;

    // The two compliance dimensions + their timestamps are ALWAYS server-owned,
    // regardless of lockedAt — only send.ts / the gateway webhook advance them
    // (both via putRecord, which bypasses this sanitizer). A tenant can never
    // mint "delivered/reported" state on their own record.
    clean.exchangeStatus = prev ? prev.exchangeStatus : "NOT_SENT";
    clean.reportingStatusC2 = prev ? prev.reportingStatusC2 : "NOT_REPORTED";
    clean.sentAt = prev?.sentAt;
    clean.deliveredAt = prev?.deliveredAt;
    clean.reportedAt = prev?.reportedAt;

    // Lifecycle: a server-terminal state (SENT…COMPLETED) is only ever reached via
    // the send pipeline. If already there it's pinned; the client may otherwise
    // transition DRAFT ↔ READY ↔ CANCELLED but can never jump straight to a
    // sent/terminal state on its own record.
    const prevLc = prev ? String(prev.lifecycleStatus) : null;
    if (prevLc && SERVER_LIFECYCLE.has(prevLc)) {
      clean.lifecycleStatus = prev!.lifecycleStatus;
      clean.lockedAt = prev!.lockedAt;
    } else if (SERVER_LIFECYCLE.has(String(clean.lifecycleStatus))) {
      clean.lifecycleStatus = prevLc ?? "DRAFT";
      if (!prev) clean.lockedAt = undefined;
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

    /* Going live is a claim about the deployment, not about the entity.
     *
     * The dashboard disables the control and says why, but a disabled button is
     * a courtesy and this is the only server path that persists an entity — so
     * without this an activation is one hand-written POST away, and the reward
     * is a LIVE badge, a vanished sandbox banner, and an evidence bundle whose
     * only honest field is the one nobody reads.
     *
     * Only the TRANSITION is refused. An entity already marked LIVE keeps
     * round-tripping through the settings screen, because demoting somebody's
     * row as a side effect of them editing their address would be its own kind
     * of surprise; send.ts refuses those at send time instead, which is the
     * moment the claim would actually be made to the FTA. */
    if (
      store === "entities" &&
      body.einvoicingStatus === "LIVE" &&
      prev?.einvoicingStatus !== "LIVE" &&
      !gatewayIsLive()
    ) {
      return json({ error: SIMULATED_ACTIVATION_BLOCK }, 409);
    }

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
