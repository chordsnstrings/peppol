import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getDriver, providerFromSlug } from "@/lib/integrations/registry";
import { loadToken, saveToken } from "@/lib/integrations/token-store";

export const runtime = "nodejs";

/**
 * Pull invoices from the provider and return normalized DTOs. The client maps
 * them into the tenant store — the server never writes domain records.
 */
export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await ctx.params;
    const id = providerFromSlug(provider);
    if (!id) return json({ error: "Unknown provider" }, 404);

    const { orgId } = await requireSession();
    const { connectionId } = (await req.json()) as { connectionId: string };
    if (!connectionId) return json({ error: "connectionId required" }, 400);

    let token = await loadToken(connectionId, orgId);
    if (!token) return json({ error: "Not connected" }, 409);

    const { driver, mode } = getDriver(id);

    // Refresh if expired.
    if (token.expiresAt && token.expiresAt < Date.now() && token.refreshToken) {
      token = await driver.refresh(token);
      await saveToken(connectionId, orgId, id, token);
    }

    const { invoices } = await driver.listInvoices(token);
    return json({ mode, invoices });
  } catch (e) {
    return handleError(e);
  }
}
