import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { corporateTaxComputation, postTaxProvision, type SuppliedFigures } from "@/lib/server/ledger/corptax";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/**
 * The corporate tax computation for a tax period, and the provision entry.
 *
 * The GET computes; it does not file. Nothing here talks to EmaraTax — the
 * return is submitted by a human, on figures they have looked at.
 */

/** Adjustments the ledger cannot derive arrive as minor-unit strings. */
const SUPPLIED_FIELDS = [
  "finesAndPenaltiesMinor",
  "entertainmentMinor",
  "nonQualifyingDonationsMinor",
  "exemptIncomeMinor",
  "netInterestExpenditureMinor",
] as const;

function suppliedFrom(params: URLSearchParams): SuppliedFigures {
  const out: SuppliedFigures = {};
  for (const f of SUPPLIED_FIELDS) {
    const v = params.get(f);
    // An absent parameter and an empty one both mean "not supplied", which is
    // not the same as a supplied zero — the computation reports the difference.
    if (v !== null && v.trim() !== "") out[f] = v.trim();
  }
  return out;
}

export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!entityId || !from || !to) return json({ error: "entityId, from and to are required." }, 400);

    return json(
      ledgerJson(
        await corporateTaxComputation({
          orgId,
          entityId,
          from,
          to,
          adjustments: suppliedFrom(url.searchParams),
          // The relief is an election, so it is only ever applied when the
          // request asks for it in as many words.
          smallBusinessRelief: url.searchParams.get("smallBusinessRelief") === "true",
        }),
      ),
    );
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Post the year's provision: Dr corporate tax expense, Cr 2400. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      entityId?: string;
      fiscalYear?: string;
      amountMinor?: string | number;
    };
    if (!b.entityId || !b.fiscalYear || b.amountMinor === undefined || b.amountMinor === null) {
      return json({ error: "entityId, fiscalYear and amountMinor are required." }, 400);
    }
    /* Preparing and locking a tax computation. A taxable person is an entity,
     * so the guard waits for the body that names which one — the provision is
     * posted into that entity's ledger and answers to a grant held there. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "tax.file" });
    return json(
      ledgerJson(
        await postTaxProvision({
          orgId,
          entityId: b.entityId,
          fiscalYear: b.fiscalYear,
          amountMinor: b.amountMinor,
          actorId: userId,
        }),
      ),
    );
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
