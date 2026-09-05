import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { listDimensions } from "@/lib/server/ledger/dimensions";
import { segmentReport, segmentBalanceSheet, segmentTrend } from "@/lib/server/ledger/segments";

export const runtime = "nodejs";

/**
 * Segment reporting (IFRS 8).
 *
 * Read-only, and there is no POST: nothing here posts, nothing here creates a
 * segment. A segment *is* a dimension value, so it is created through
 * /api/ledger/dimensions like any other — one place where dimensions are
 * defined, rather than two that can disagree about which values exist.
 *
 * The dimensions come back on every request so a screen can fill its picker and
 * draw its report from one read. The segment balance sheet is produced from the
 * same request as the profit and loss, because IFRS 8.28 reconciles both and a
 * screen that had to ask twice could show one of them against the other's
 * period.
 *
 * The trend is opt-in — `months` — because it is one dimensional read per month
 * and nobody should pay for twelve of them to look at one period's note.
 *
 * Every amount is already a decimal string of minor units (BigInt never leaves
 * the module as a BigInt), so there is nothing here for JSON to round.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);
    /* The IFRS 8 note, read-only by construction — there is no POST here. The
     * note is one entity's, so the grant has to be one on that entity. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    const dimensions = await listDimensions({ orgId });
    const dimension = url.searchParams.get("dimension");
    if (!dimension) return json({ dimensions });

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) {
      return json({ error: "from and to are required — a segment note is always for a period." }, 400);
    }

    const monthsParam = url.searchParams.get("months");
    let months: number | null = null;
    if (monthsParam !== null) {
      months = Number(monthsParam);
      if (!Number.isInteger(months) || months < 1 || months > 60) {
        return json({ error: `A trend runs over 1 to 60 months — "${monthsParam}" is not a number of months.` }, 400);
      }
    }

    const report = await segmentReport({ orgId, entityId, from, to, dimensionCode: dimension });
    // As at the end of the period the profit and loss covers, so the two halves
    // of the note describe the same moment.
    const balanceSheet = await segmentBalanceSheet({ orgId, entityId, asOf: to, dimensionCode: dimension });
    const trend = months === null
      ? undefined
      : await segmentTrend({ orgId, entityId, dimensionCode: dimension, periods: months, to });

    return json({ dimensions, report, balanceSheet, trend });
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
