import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { reverse, LedgerError } from "@/lib/server/ledger/post";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { prisma } from "@/lib/server/prisma";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/** Correction is reversal-only — the original entry is never edited. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const { id } = await ctx.params;
    const b = (await req.json().catch(() => ({}))) as { entryDate?: string; memo?: string };
    // The entity is on the entry, not in the request: a reversal is scoped by
    // what it reverses, and taking it from the caller would let somebody name
    // an entity they do hold the permission on and reverse an entry in one
    // they do not.
    const original = await prisma.journalEntry.findFirst({ where: { id, orgId }, select: { entityId: true } });
    if (!original) return json({ error: "That entry does not exist." }, 404);
    await requirePermission({ orgId, userId, entityId: original.entityId, permission: "ledger.reverse" });

    const entry = await reverse({ orgId, entryId: id, entryDate: b.entryDate, memo: b.memo, actorId: userId });
    return json(ledgerJson({ entry }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
