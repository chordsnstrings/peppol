import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { post, LedgerError, type PostLine } from "@/lib/server/ledger/post";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/** Journal register. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    const take = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

    const entries = await prisma.journalEntry.findMany({
      where: { orgId, entityId, ...(url.searchParams.get("status") ? { status: String(url.searchParams.get("status")) } : {}) },
      orderBy: [{ entryDate: "desc" }, { number: "desc" }],
      take,
      include: {
        period: { select: { label: true, status: true } },
        lines: { include: { account: { select: { code: true, name: true } } }, orderBy: { lineNo: "asc" } },
      },
    });
    return json(ledgerJson({ entries }));
  } catch (e) {
    return handleError(e);
  }
}

/** Post a manual journal. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      entityId?: string; entryDate?: string; memo?: string; lines?: PostLine[];
    };
    if (!b.entityId || !b.entryDate || !Array.isArray(b.lines)) {
      return json({ error: "A journal needs an entity, a date and at least two lines." }, 400);
    }
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });
    const entry = await post({
      orgId, entityId: b.entityId, entryDate: b.entryDate, memo: b.memo,
      source: "manual", actorType: "HUMAN", actorId: userId, lines: b.lines,
    });
    return json(ledgerJson({ entry }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
