import { prisma } from "@/lib/server/prisma";
import { json, handleError, assertStore } from "@/lib/server/http";
import { requireWritableSession } from "@/lib/server/org-status";
import { requireEffectiveSession } from "@/lib/server/effective-session";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ store: string; id: string }> }) {
  try {
    const { store, id } = await ctx.params;
    assertStore(store);
    const { orgId } = await requireEffectiveSession();
    const row = await prisma.record.findFirst({ where: { id, orgId, store } });
    if (!row) return json({ error: "Not found" }, 404);
    return json({ item: JSON.parse(row.data) });
  } catch (e) {
    return handleError(e);
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ store: string; id: string }> }) {
  try {
    const { store, id } = await ctx.params;
    assertStore(store);
    const { orgId } = await requireWritableSession();
    // deleteMany scoped by orgId → cannot delete another tenant's record
    await prisma.record.deleteMany({ where: { id, orgId, store } });
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
