import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  comparativeBalanceSheet,
  comparativeLayout,
  comparativeProfitAndLoss,
  commonSize,
  ratios,
  trend,
  type PeriodComparison,
  type PointComparison,
} from "@/lib/server/ledger/comparatives";

export const runtime = "nodejs";

/**
 * Everything the comparatives screen shows, in one response.
 *
 * One request rather than six, for the reason the analytics route gives: a
 * screen assembled from six round trips arrives in six pieces and is read as six
 * screens. It matters more here than there, because the whole claim of this page
 * is that the figures on it agree with each other — two columns, their
 * proportions, the ratios drawn from them and the months behind them. Fetched
 * separately they would be six reads of a moving ledger, and a posting landing
 * between two of them would put a difference on screen that exists nowhere in
 * the books.
 *
 * `against` names the comparative: the immediately preceding span of the same
 * length, the same dates a year earlier, or explicit dates in `priorFrom` and
 * `priorTo`. The whole state is in the URL so a comparison can be sent to
 * somebody and show them the same thing.
 *
 * The common-size proportions are produced for both columns rather than for the
 * current one alone. Comparing proportions across the two periods is the entire
 * point of expressing them as proportions; one column of them would be a
 * statistic rather than a comparison.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!entityId || !from || !to) return json({ error: "entityId, from and to are required." }, 400);

    const mode = url.searchParams.get("against") ?? "prior_year";
    const priorFrom = url.searchParams.get("priorFrom");
    const priorTo = url.searchParams.get("priorTo");
    if (mode !== "prior_period" && mode !== "prior_year" && mode !== "explicit") {
      return json({ error: `A comparative is drawn against "prior_period", "prior_year" or "explicit" dates.` }, 400);
    }
    if (mode === "explicit" && !(priorFrom && priorTo)) {
      return json({ error: "Comparing against explicit dates needs both priorFrom and priorTo." }, 400);
    }

    const periodAgainst: PeriodComparison =
      mode === "explicit" ? { from: priorFrom!, to: priorTo! } : mode;
    // A balance sheet is a moment: an explicit comparative period is read at its
    // end, which is the only end a sheet can be drawn at.
    const pointAgainst: PointComparison = mode === "explicit" ? { asOf: priorTo! } : mode;

    const monthsParam = url.searchParams.get("months");
    const months = monthsParam ? Number(monthsParam) : 12;
    if (!Number.isInteger(months) || months < 1 || months > 60) {
      return json({ error: "A trend covers between 1 and 60 months." }, 400);
    }

    const layoutCode = url.searchParams.get("layout");

    const [pl, bs, sizeNow, ratioSet, series] = await Promise.all([
      comparativeProfitAndLoss({ orgId, entityId, from, to, against: periodAgainst }),
      comparativeBalanceSheet({ orgId, entityId, asOf: to, against: pointAgainst }),
      commonSize({ orgId, entityId, from, to }),
      ratios({ orgId, entityId, asOf: to, from }),
      trend({ orgId, entityId, months, to }),
    ]);

    // The prior column's proportions are only asked for once the comparative is
    // known to exist — the alternative is a second refusal for the same absence
    // the profit and loss has already explained.
    const sizeThen = pl.prior
      ? await commonSize({ orgId, entityId, from: pl.prior.from, to: pl.prior.to })
      : null;

    // A layout is optional and fails on its own. A report the user has not asked
    // for must not be able to blank the two statements they have.
    let layout = null;
    let layoutError: string | null = null;
    if (layoutCode) {
      try {
        layout = await comparativeLayout({ orgId, entityId, code: layoutCode, from, to, against: periodAgainst });
      } catch (e) {
        layoutError = e instanceof LedgerError ? e.message : "That layout could not be drawn.";
      }
    }

    return json(
      ledgerJson({
        profitAndLoss: pl,
        balanceSheet: bs,
        commonSize: { current: sizeNow, prior: sizeThen },
        ratios: ratioSet,
        trend: series,
        layout,
        layoutError,
      }),
    );
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
