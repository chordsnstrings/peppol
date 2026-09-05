import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

/** Open the books for an entity: a fiscal year with periods, a book, and a chart. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const body = (await req.json().catch(() => ({}))) as {
      entityId?: string; fiscalYear?: string; startsOn?: string; functionalCurrency?: string;
    };
    if (!body.entityId) return json({ error: "Choose which entity to open books for." }, 400);
    /* Opening the books for an entity: a fiscal year, a book and a chart. The
     * entity is in the body, so the guard waits for the body — otherwise a
     * grant on one entity would open the books for any of them. */
    await requirePermission({ orgId, userId, entityId: body.entityId, permission: "setup.manage" });

    const label = body.fiscalYear ?? String(new Date().getUTCFullYear());
    const startsOn = body.startsOn ?? `${label}-01-01`;

    const existing = await prisma.fiscalYear.findFirst({ where: { orgId, entityId: body.entityId, label } });
    if (!existing) {
      await openFiscalYear({ orgId, entityId: body.entityId, label, startsOn });
    }
    const { book, accounts } = await openBooks({
      orgId, entityId: body.entityId, functionalCurrency: body.functionalCurrency,
    });
    return json({ book: { id: book.id, code: book.code, functionalCurrency: book.functionalCurrency }, accounts, fiscalYear: label });
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
