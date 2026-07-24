import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getGateway, gatewayIsLive } from "@/lib/gateway/registry";

export const runtime = "nodejs";

/** Gateway health — surfaced so an SME can see the compliance channel is up. */
export async function GET() {
  try {
    await requireSession();
    const gw = getGateway();
    const health = await gw.healthcheck();
    return json({ driver: gw.driver, live: gatewayIsLive(), ...health });
  } catch (e) {
    return handleError(e);
  }
}
