import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  listDimensions,
  createDimension,
  addValue,
  requireDimensionOn,
  dimensionalProfitAndLoss,
  dimensionSummary,
  dimensionalTrialBalance,
  type SummaryBasis,
} from "@/lib/server/ledger/dimensions";

export const runtime = "nodejs";

const BASES = new Set(["expenses", "revenue", "netProfit"]);

/**
 * Cost-centre reporting. The dimensions themselves come back on every request
 * so a screen can fill its picker and draw its report from one read, and the
 * profit and loss arrives with its summary, which is derived from it rather
 * than computed again — the two cannot disagree.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);

    const dimensions = await listDimensions({ orgId });
    const dimension = url.searchParams.get("dimension");
    if (!dimension) return json({ dimensions });

    const period = url.searchParams.get("period");
    if (period) {
      const trialBalance = await dimensionalTrialBalance({
        orgId, entityId, periodLabel: period, dimensionCode: dimension,
        valueCode: url.searchParams.get("value") ?? undefined,
      });
      return json({ dimensions, trialBalance });
    }

    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!from || !to) return json({ error: "from and to are required for a dimensional profit and loss." }, 400);

    const basisParam = url.searchParams.get("basis");
    if (basisParam && !BASES.has(basisParam)) {
      return json({ error: `Shares can be taken of expenses, revenue or netProfit — not "${basisParam}".` }, 400);
    }
    const basis = (basisParam ?? undefined) as SummaryBasis | undefined;

    const summary = await dimensionSummary({ orgId, entityId, from, to, dimensionCode: dimension, basis });
    const profitAndLoss = await dimensionalProfitAndLoss({ orgId, entityId, from, to, dimensionCode: dimension });
    return json({ dimensions, profitAndLoss, summary });
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Define a dimension, add a value to one, or make one mandatory on an account. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "create-dimension" | "add-value" | "require-on-account";
      entityId?: string;
      code?: string;
      name?: string;
      isRequired?: boolean;
      values?: { code: string; name: string }[];
      dimension?: string;
      accountCode?: string;
    };

    switch (b.action) {
      case "create-dimension":
        if (!b.code || !b.name) return json({ error: "A dimension needs a code and a name." }, 400);
        return json({
          dimension: await createDimension({
            orgId, code: b.code, name: b.name, isRequired: b.isRequired, values: b.values,
          }),
        });

      case "add-value":
        if (!b.dimension || !b.code || !b.name) return json({ error: "A value needs its dimension, a code and a name." }, 400);
        return json({ value: await addValue({ orgId, dimensionCode: b.dimension, code: b.code, name: b.name }) });

      case "require-on-account": {
        if (!b.entityId || !b.dimension || !b.accountCode) {
          return json({ error: "Say which entity, which account and which dimension." }, 400);
        }
        const account = await requireDimensionOn({
          orgId, entityId: b.entityId, accountCode: b.accountCode, dimensionCode: b.dimension,
        });
        return json({ account: { code: account.code, name: account.name, requiresDimension: account.requiresDimension } });
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
