import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { json, handleError } from "@/lib/server/http";
import { equityAndNotes } from "@/lib/server/ledger/equity";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";

export const runtime = "nodejs";

/**
 * The statement of changes in equity for a fiscal year, and the notes.
 *
 * There is no `from` and `to` here, unlike the other statements: IAS 1.106 is a
 * statement for the reporting period, and the reporting period is the fiscal
 * year. An arbitrary window would produce an opening balance that is not the
 * previous balance sheet's closing one, and a "profit for the period" that no
 * close will ever carry to retained earnings.
 *
 * As with the cash flow statement, it is returned whether or not it reconciles.
 * A statement that does not tie to the equity section of the balance sheet
 * carries `reconciles: false`, the difference, and a warning naming the account
 * that was missed — refusing to return it would withhold the one report that
 * can find the gap.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    /* The statement of changes in equity and its notes: a read. */
    await requirePermission({ orgId, userId, permission: "ledger.read" });
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);
    // Absent means the most recent year the ledger holds, which is what the
    // screen wants on first load.
    const fiscalYear = url.searchParams.get("fiscalYear")?.trim() || undefined;

    return json(ledgerJson({ equity: await equityAndNotes({ orgId, entityId, fiscalYear }) }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
