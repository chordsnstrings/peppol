import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getPlan } from "@/lib/server/billing";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { orgId } = await requireSession();
    return json({ plan: await getPlan(orgId) });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * Entitlement is NOT self-service. Previously any member could raise their own
 * plan (and free allowance) for free — an entitlement-escalation bug. Plan
 * changes now happen only through paid checkout (see /api/billing/checkout);
 * this endpoint no longer mutates the plan.
 */
export async function PUT() {
  return json({ error: "Plan changes are made at checkout." }, 405);
}
