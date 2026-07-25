import { NextResponse } from "next/server";
import { getSession } from "@/lib/server/session";
import { getDriver, providerFromSlug } from "@/lib/integrations/registry";
import { saveToken } from "@/lib/integrations/token-store";
import { verifyIntegrationState } from "@/lib/integrations/oauth-state";

export const runtime = "nodejs";

/** OAuth redirect target: exchange the code for tokens and store them. */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const id = providerFromSlug(provider);
  if (!id) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });

  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/login", req.url));

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  if (err || !code || !state) {
    return NextResponse.redirect(new URL(`/integrations?error=${err ?? "denied"}`, req.url));
  }

  // Anti-CSRF: the signed state must be valid AND bound to THIS session/provider.
  const verified = await verifyIntegrationState(state);
  if (!verified || verified.userId !== session.userId || verified.orgId !== session.orgId || verified.provider !== provider) {
    return NextResponse.redirect(new URL(`/integrations?error=bad_state`, req.url));
  }
  const connectionId = verified.connectionId;

  try {
    const redirectUri = `${url.origin}/api/integrations/${provider}/callback`;
    const { driver, mode } = getDriver(id);
    const query = Object.fromEntries(url.searchParams.entries());
    const token = await driver.completeAuth({ code, redirectUri, query });
    await saveToken(connectionId, session.orgId, id, token);
    return NextResponse.redirect(
      new URL(`/integrations?connected=${connectionId}&provider=${provider}&mode=${mode}`, req.url),
    );
  } catch {
    return NextResponse.redirect(new URL(`/integrations?error=exchange_failed`, req.url));
  }
}
