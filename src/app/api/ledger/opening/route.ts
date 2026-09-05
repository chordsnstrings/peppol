import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  previewOpeningBalances, importOpeningBalances, parseTrialBalance, type OpeningLine,
} from "@/lib/server/ledger/opening";

export const runtime = "nodejs";

/**
 * Opening balances.
 *
 * POST previews or imports. Previewing is a POST rather than a GET because the
 * trial balance being checked is the request body — it can be hundreds of rows,
 * and it is the customer's own financial data, which does not belong in a URL
 * or in an access log.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "preview" | "import" | "parse";
      entityId?: string;
      asOf?: string;
      lines?: OpeningLine[];
      text?: string;
    };

    /* Loading the balances the books start from — and previewing or parsing what
     * would be loaded, which is the same screen a step earlier.
     *
     * The guard waits for the body because the entity being opened is in it.
     * Parsing pasted text names no entity and legitimately cannot: it reads a
     * file and touches no books, so `b.entityId` is undefined there and the
     * check falls back to the org-wide answer, exactly as it behaved before. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "setup.manage" });

    if (b.action === "parse") {
      if (!b.text) return json({ error: "There is nothing to read." }, 400);
      return json(parseTrialBalance(b.text));
    }

    if (!b.entityId || !b.asOf) return json({ error: "entityId and asOf are required." }, 400);
    const lines = Array.isArray(b.lines) ? b.lines : [];

    if (b.action === "import") {
      return json(await importOpeningBalances({
        orgId, entityId: b.entityId, asOf: b.asOf, lines, actorId: userId,
      }));
    }
    return json(await previewOpeningBalances({ orgId, entityId: b.entityId, asOf: b.asOf, lines }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
