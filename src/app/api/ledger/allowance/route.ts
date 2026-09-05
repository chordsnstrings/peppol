import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { allowanceView, raiseAllowance, BAND_ORDER, type LossRates } from "@/lib/server/ledger/allowance";

export const runtime = "nodejs";

/**
 * The allowance for doubtful debts, and the provision matrix behind it.
 *
 * The loss rates arrive as whole basis points, one per ageing band. They are
 * counts rather than money, so unlike every amount on this API they are
 * ordinary numbers — but they are still checked for integrality by the module
 * before anything is computed with them, because 2.5 basis points is not a rate
 * anybody meant to enter. `Number()` rather than `parseInt` for exactly that
 * reason: it lets "2.5" through as 2.5 to be refused for what it is, instead of
 * silently truncating it to 2.
 */
function ratesFrom(source: { get(band: string): unknown }): Partial<LossRates> | undefined {
  const out: Partial<LossRates> = {};
  for (const band of BAND_ORDER) {
    const v = source.get(band);
    if (v === undefined || v === null || v === "") continue;
    out[band] = Number(v);
  }
  return Object.keys(out).length ? out : undefined;
}

/** One parameter per band on the query string, so a read can be linked to. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The ageing, the matrix over it and the allowance carried against it —
     * all of it is the ledger, read. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    return json(ledgerJson(await allowanceView({
      orgId,
      entityId,
      asOf: q.get("asOf") ?? undefined,
      rates: ratesFrom(q),
    })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const entityId = typeof body.entityId === "string" ? body.entityId : "";
    if (!entityId) return json({ error: "entityId required" }, 400);
    const asOf = typeof body.asOf === "string" ? body.asOf : "";
    if (!asOf) return json({ error: "An allowance is measured at a date. Which one?" }, 400);

    /*
     * Measuring the allowance takes `ar.manage`, the key that raised the
     * invoices it is measured over.
     *
     * `ledger.post` was the other candidate and it is the weaker one. Deciding
     * how much of the sales ledger will never arrive is a judgement about
     * customers — the same judgement, made in advance, that `ar.manage` lets a
     * person act on when they write one specific debt off. It also lands
     * directly on the reported result, so it is not a bookkeeping entry
     * somebody keys on request: whoever runs the sales ledger owns it.
     */
    await requirePermission({ orgId, userId, entityId, permission: "ar.manage" });

    const rates = body.rates && typeof body.rates === "object"
      ? ratesFrom({ get: (band) => (body.rates as Record<string, unknown>)[band] })
      : undefined;

    return json(ledgerJson(await raiseAllowance({
      orgId, entityId, asOf, rates, actorId: userId, actorType: "HUMAN",
    })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
