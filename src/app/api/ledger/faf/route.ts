import { requireSession } from "@/lib/server/session";
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
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!entityId || !from || !to) {
      return json({ error: "entityId, from and to are required to produce an audit file." }, 400);
    }

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
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
