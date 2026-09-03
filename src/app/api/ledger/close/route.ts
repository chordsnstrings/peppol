import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { previewClose, closeYear, openNextYear } from "@/lib/server/ledger/close";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/** What closing this year would do, and what currently stops it. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const fiscalYear = url.searchParams.get("fiscalYear");
    if (!entityId || !fiscalYear) return json({ error: "entityId and fiscalYear are required." }, 400);
    return json(ledgerJson(await previewClose({ orgId, entityId, fiscalYear })));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Close a year, or open the one after it. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "close" | "open-next";
      entityId?: string;
      fiscalYear?: string;
      lockPeriods?: boolean;
    };
    if (!b.entityId || !b.fiscalYear) return json({ error: "entityId and fiscalYear are required." }, 400);

    if (b.action === "open-next") {
      return json(await openNextYear({ orgId, entityId: b.entityId, afterFiscalYear: b.fiscalYear }));
    }
    return json(await closeYear({
      orgId, entityId: b.entityId, fiscalYear: b.fiscalYear,
      lockPeriods: b.lockPeriods === true, actorId: userId,
    }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
