import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  budgetVsActual,
  budgetSummary,
  setBudget,
  copyScenario,
  type BudgetLineInput,
} from "@/lib/server/ledger/budget";

export const runtime = "nodejs";

/**
 * The budget: what was planned, what actually happened, and which way the
 * difference points.
 *
 * The actuals in these responses are the profit and loss for the same dates —
 * the same read, not a second one — so this endpoint and /api/ledger/statements
 * cannot disagree.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const scenario = url.searchParams.get("scenario") ?? undefined;
    if (!entityId) return json({ error: "entityId is required." }, 400);

    if (url.searchParams.get("view") === "summary") {
      const fiscalYear = url.searchParams.get("fiscalYear");
      if (!fiscalYear) return json({ error: "fiscalYear is required for the year-to-date summary." }, 400);
      return json(
        await budgetSummary({
          orgId, entityId, scenario, fiscalYear,
          asOf: url.searchParams.get("asOf") ?? undefined,
        }),
      );
    }

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) return json({ error: "from and to are required." }, 400);
    return json(await budgetVsActual({ orgId, entityId, scenario, from, to }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Set a scenario's lines, or clone one scenario onto another. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "set" | "copy";
      entityId?: string;
      scenario?: string;
      fiscalYear?: string;
      lines?: BudgetLineInput[];
      from?: string;
      to?: string;
      toFiscalYear?: string;
      upliftBps?: number;
      overwrite?: boolean;
      note?: string;
    };
    if (!b.entityId || !b.fiscalYear) return json({ error: "entityId and fiscalYear are required." }, 400);

    if (b.action === "copy") {
      if (!b.from || !b.to) return json({ error: "A copy needs a source scenario and a target scenario." }, 400);
      return json(
        await copyScenario({
          orgId, entityId: b.entityId, from: b.from, to: b.to,
          fiscalYear: b.fiscalYear, toFiscalYear: b.toFiscalYear,
          upliftBps: b.upliftBps, overwrite: b.overwrite === true, note: b.note,
        }),
      );
    }

    if (!Array.isArray(b.lines) || b.lines.length === 0) {
      return json({ error: "A budget needs at least one line." }, 400);
    }
    return json(
      await setBudget({
        orgId, entityId: b.entityId, scenario: b.scenario,
        fiscalYear: b.fiscalYear, lines: b.lines,
      }),
    );
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
