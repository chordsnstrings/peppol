import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getSubState } from "@/lib/server/subscription";
import { SUB_TIERS } from "@/lib/domain/billing";

export const runtime = "nodejs";

/** The current org's subscription status + the tiers on offer. */
export async function GET() {
  try {
    const { orgId } = await requireSession();
    const state = await getSubState(orgId);
    return json({ subscription: state, tiers: SUB_TIERS });
  } catch (e) {
    return handleError(e);
  }
}
