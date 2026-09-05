import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { json, handleError } from "@/lib/server/http";
import { ftaAuditFile } from "@/lib/server/ledger/faf";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";

export const runtime = "nodejs";

/**
 * The FTA Audit File for a period.
 *
 * Two representations of one thing. `format=csv` returns the file itself as a
 * download; anything else returns the structured summary — the company record,
 * the section counts and totals, the reconciliation and the warnings — which is
 * what the screen shows before anyone downloads it.
 *
 * The reconciliation result travels on the CSV response as a header as well, so
 * an integration that only ever takes the file still learns that it did not
 * agree with the ledger instead of discovering it from the FTA.
 *
 * This serves a file. It does not submit anything to the FTA.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!entityId || !from || !to) {
      return json({ error: "entityId, from and to are required to produce an audit file." }, 400);
    }
    /* Every transaction in the period in one file for the FTA. Like the export,
     * this is the widest read in the product rather than a narrow one, and the
     * read key is what it takes. It files nothing; it only serves the file.
     * Wide as it is, it is still one taxable person's file, so the grant has to
     * cover that entity — a role held on a sister company is not authority to
     * hand this one's every transaction to somebody. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    const file = await ftaAuditFile({ orgId, entityId, from, to });

    if (url.searchParams.get("format") === "csv") {
      // The TRN is in the name because an audit file that reaches the FTA
      // detached from the taxable person it belongs to is a file nobody can use.
      const name = `FAF-${file.company.trn}-${from}-to-${to}.csv`;
      return new Response(file.csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${name}"`,
          "x-faf-reconciles": String(file.reconciles),
          "x-faf-warnings": String(file.warnings.length),
          "cache-control": "no-store",
        },
      });
    }

    return json(ledgerJson(file));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
