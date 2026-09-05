import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  importStatement, suggestMatches, confirmMatch, unmatch, postFromBankLine, reconcile,
  type ImportLine,
} from "@/lib/server/ledger/bank";

export const runtime = "nodejs";

/** The reconciliation statement, plus suggested matches for what is still open. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const accountCode = url.searchParams.get("account") ?? "1010";
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* Reconciling the bank is one job, and its own key. The suggestions this
     * returns are the matches somebody is about to make, so reading them is
     * part of the same act rather than a separate, looser one. */
    await requirePermission({ orgId, userId, entityId, permission: "bank.reconcile" });
    const asOf = url.searchParams.get("asOf");

    const [statement, suggestions] = await Promise.all([
      reconcile({ orgId, entityId, accountCode, asOf: asOf ? new Date(asOf) : undefined }),
      suggestMatches({ orgId, entityId, accountCode }),
    ]);
    return json({ statement, suggestions });
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Import a statement, or act on one of its lines.
 *
 * Matching and posting are separate actions on purpose. Agreeing that two
 * records describe the same event is not the same decision as deciding what an
 * unexplained debit was for.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "import" | "match" | "unmatch" | "post";
      entityId?: string;
      account?: string;
      lines?: ImportLine[];
      batch?: string;
      bankLineId?: string;
      journalLineId?: string;
      contraAccount?: string;
      memo?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    /* Matching, unmatching and posting against a statement line — against one
     * entity's bank account, which is named in the body, so the guard waits for
     * the body rather than settling for the org-wide answer. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "bank.reconcile" });

    switch (b.action) {
      case "import":
        if (!Array.isArray(b.lines) || b.lines.length === 0) {
          return json({ error: "There are no statement lines to import." }, 400);
        }
        return json(await importStatement({
          orgId, entityId: b.entityId, accountCode: b.account ?? "1010",
          lines: b.lines, batch: b.batch,
        }));

      case "match":
        if (!b.bankLineId || !b.journalLineId) {
          return json({ error: "A match needs both a bank line and a posting." }, 400);
        }
        await confirmMatch({ orgId, bankLineId: b.bankLineId, journalLineId: b.journalLineId, userId });
        return json({ matched: true });

      case "unmatch":
        if (!b.bankLineId) return json({ error: "Which bank line?" }, 400);
        await unmatch({ orgId, bankLineId: b.bankLineId });
        return json({ matched: false });

      case "post":
        if (!b.bankLineId || !b.contraAccount) {
          return json({ error: "Posting a bank line needs the account it belongs to." }, 400);
        }
        return json(await postFromBankLine({
          orgId, entityId: b.entityId, bankLineId: b.bankLineId,
          contraAccount: b.contraAccount, memo: b.memo, userId,
        }));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
