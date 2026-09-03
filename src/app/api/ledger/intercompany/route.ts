import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { groupList } from "@/lib/server/ledger/consolidation";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  matchReport,
  eliminationSchedule,
  unrealisedProfit,
  type StockOnHand,
} from "@/lib/server/ledger/intercompany";

export const runtime = "nodejs";

/**
 * Intercompany matching and elimination for one consolidation group.
 *
 * Read-only, and there is deliberately no POST. Every other route in this
 * product that produces a journal has a way to post it; this one must not, and
 * the absence is the point rather than an omission — an elimination belongs to
 * the group's working papers, not to any member's ledger, and a POST here would
 * be a way to write a group adjustment into a legal entity's statutory
 * accounts. The module explains why at length; the route simply gives nobody
 * the option.
 *
 * The groups come back on every request so a screen can fill its picker and
 * draw its report from one read, exactly as the segments route returns its
 * dimensions.
 *
 * The match report and the elimination schedule are produced together, because
 * the schedule is built out of the matches and a screen that asked twice could
 * show one against the other's period. `stock` is accepted on the query string
 * as `seller:holder:quantity:price[:cost]` triples — the quantities cannot be
 * derived from the ledger (see `unrealisedProfit`), so they have to arrive from
 * whoever counted the stock.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const group = url.searchParams.get("group");

    if (!group) return json({ groups: await groupList({ orgId }) });

    const to = url.searchParams.get("to");
    const from = url.searchParams.get("from");
    if (!from || !to) {
      return json({ error: "from and to are required — matching runs over a period, never over all of history." }, 400);
    }

    let stock: StockOnHand[];
    try {
      stock = parseStock(url.searchParams.getAll("stock"));
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }

    const [report, schedule] = await Promise.all([
      matchReport({ orgId, groupCode: group, from, to }),
      eliminationSchedule({ orgId, groupCode: group, asOf: to, from, stock }),
    ]);
    const unrealised = stock.length
      ? await unrealisedProfit({ orgId, groupCode: group, asOf: to, from, stock })
      : undefined;

    return json(ledgerJson({ groups: await groupList({ orgId }), report, schedule, unrealised }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * `seller:holder:quantity:unitPrice[:unitCost]`, one per `stock` parameter.
 *
 * Parsed here rather than accepted as JSON in a POST body because this is a
 * read: a group accountant types the count into the screen, the screen puts it
 * in the URL, and the URL can then be shared, bookmarked and re-run — which is
 * what somebody asking "where did that elimination come from" actually needs.
 * A malformed triple is refused with the triple in the message; guessing at
 * what was meant would put a made-up quantity into an elimination.
 */
function parseStock(raw: string[]): StockOnHand[] {
  return raw.filter((s) => s.trim() !== "").map((s) => {
    const parts = s.split(":").map((p) => p.trim());
    if (parts.length < 4 || parts.length > 5) {
      throw new Error(
        `"${s}" is not a stock line. Each one is seller:holder:quantity:unitPrice, with an optional unit cost ` +
          `after it — for example t-ent-a:t-ent-b:120:4500:3000.`,
      );
    }
    const [sellerEntityId, holderEntityId, quantity, unitTransferPriceMinor, unitCostMinor] = parts;
    for (const [label, value] of [["quantity", quantity], ["unit price", unitTransferPriceMinor]] as const) {
      if (!/^\d+$/.test(value)) {
        throw new Error(`"${s}" carries "${value}" as its ${label}, which is not a whole number.`);
      }
    }
    if (unitCostMinor !== undefined && !/^\d+$/.test(unitCostMinor)) {
      throw new Error(`"${s}" carries "${unitCostMinor}" as its unit cost, which is not a whole number.`);
    }
    return {
      sellerEntityId,
      holderEntityId,
      quantity,
      unitTransferPriceMinor,
      unitCostMinor: unitCostMinor ?? null,
    };
  });
}
