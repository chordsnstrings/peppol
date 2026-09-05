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
 *
 * Two stores need the guard for opposite reasons. On `invoices` the tenant owns
 * the document and the server owns what has happened to it, so the server's
 * fields are pinned onto whatever the client posts. On `inbound` the tenant owns
 * nothing but their own answer: every other field is the provenance of a
 * document somebody else sent them, so the direction is reversed and the body is
 * read for one field only.
 */
/** Lifecycle states only ever reached via the server send pipeline. */
const SERVER_LIFECYCLE = new Set(["QUEUED", "SENDING", "SENT", "DELIVERED", "COMPLETED", "FAILED"]);

/**
 * Where an invoice may be taken by a client write.
 *
 * READY is not in it. Finalising is where the credit limit is checked
 * (`/api/ledger/credit-control/invoice`), and a transition a client can make
 * for itself on this route is a check the busy day skips — so the editor saves
 * the document and the gated route moves it. CANCELLED stays, because
 * abandoning a draft commits nothing and needs no permission.
 */
const CLIENT_LIFECYCLE = new Set(["DRAFT", "CANCELLED"]);

/** The four answers `InboundDoc.buyerAction` has. Anything else is not a state. */
const BUYER_ACTIONS = new Set(["NONE", "ACKNOWLEDGED", "EXPORTED", "DISPUTED"]);

function sanitizeRecord(store: string, body: Record<string, unknown>, prev: Record<string, unknown> | null): Record<string, unknown> {
  const clean = { ...body };
  delete clean.orgId; // always re-stamped from the session

  if (store === "inbound") {
    /* An arrival is not a record a tenant writes. It is the account of what a
     * supplier sent them, written by the receiving pipeline in inbound.ts: the
     * gateway's delivery reference, both participant ids, the document type,
     * the XML and its hash, the issues found in it, whether a simulator
     * produced it, the note saying so — and the decision, whose `transmitted`
     * is the one field on this row that claims something about the outside
     * world. A client that re-posted a record it holds could flip every one of
     * them, and the prize is a business able to show that it rejected a
     * supplier's invoice and told them so.
     *
     * So the row stands as the server left it and only `buyerAction` is taken
     * from the body — whether the recipient has dealt with it, which is theirs
     * to say and claims nothing about the network. `prev` is never null: POST
     * refuses a create on this store, because an arrival nobody delivered is
     * the forgery in its purest form.
     */
    const asked = String(body.buyerAction ?? "");
    return {
      ...(prev ?? {}),
      id: body.id,
      buyerAction: BUYER_ACTIONS.has(asked) ? asked : (prev?.buyerAction ?? "NONE"),
    };
  }

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

    // When a document was locked is written by the transition that locked it —
    // finalisation, or the send pipeline — and never by the editor saving it.
    clean.lockedAt = prev?.lockedAt;

    // Lifecycle: a server-terminal state (SENT…COMPLETED) is only ever reached
    // via the send pipeline, and READY only via the finalisation route. If the
    // row is already in a server state it is pinned there; otherwise the client
    // may move it between the states it owns, and an attempt to enter one it
    // does not own leaves the row where it was rather than failing the save —
    // the editor is posting a whole document, and refusing the write would lose
    // the lines somebody just typed over a field they never touched.
    const prevLc = prev ? String(prev.lifecycleStatus) : null;
    const asked = String(clean.lifecycleStatus);
    if (prevLc && SERVER_LIFECYCLE.has(prevLc)) {
      clean.lifecycleStatus = prev!.lifecycleStatus;
    } else if (asked !== prevLc && !CLIENT_LIFECYCLE.has(asked)) {
      clean.lifecycleStatus = prevLc ?? "DRAFT";
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

    /* A document arrives; it is not created. Every inbound row is written by
     * the receiving pipeline out of a delivery the gateway made, so a POST for
     * an id that does not exist yet is a tenant inventing a supplier's invoice
     * — and unlike the fields the sanitizer pins, there is nothing here to pin
     * it back to. Refused rather than quietly emptied, because a row that says
     * nothing would still sit in somebody's inbox. */
    if (store === "inbound" && !prev) {
      return json(
        { error: "An inbound document is written when one is delivered to you. It cannot be created here." },
        403,
      );
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
