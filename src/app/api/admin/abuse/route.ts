import { requirePlatformAdmin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { abuseSignals } from "@/lib/server/admin-store";

export const runtime = "nodejs";

/** Fraud / abuse signals (duplicate TRNs, suspended count, recent signups). */
export async function GET() {
  try {
    await requirePlatformAdmin();
    return json(await abuseSignals());
  } catch (e) {
    return handleError(e);
  }
}
