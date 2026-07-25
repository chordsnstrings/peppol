import { prisma } from "@/lib/server/prisma";
import { json, handleError, assertStore } from "@/lib/server/http";
import { requireWritableSession } from "@/lib/server/org-status";
import { requireEffectiveSession } from "@/lib/server/effective-session";

export const runtime = "nodejs";

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
    const { orgId } = await requireWritableSession();
    const body = (await req.json()) as Record<string, unknown>;
    const id = body.id as string | undefined;
    if (!id) return json({ error: "Record must have an id" }, 400);

    const entityId = (body.entityId as string | undefined) ?? null;
    const invoiceId = (body.invoiceId as string | undefined) ?? null;
    const data = JSON.stringify({ ...body, orgId });

    // Guard against cross-tenant overwrites: a record id may only be written by its owner.
    const existing = await prisma.record.findUnique({ where: { store_id: { store, id } } });
    if (existing && existing.orgId !== orgId) return json({ error: "Forbidden" }, 403);

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
