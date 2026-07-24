import { NextResponse } from "next/server";
import { getSession } from "@/lib/server/session";
import { getDriver, providerFromSlug } from "@/lib/integrations/registry";

export const runtime = "nodejs";

/** Redirect the user to the provider's OAuth consent screen. */
export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const id = providerFromSlug(provider);
  if (!id) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });

  const session = await getSession();
  if (!session) return NextResponse.redirect(new URL("/login", req.url));

  const url = new URL(req.url);
  const connectionId = url.searchParams.get("connectionId");
  if (!connectionId) return NextResponse.json({ error: "connectionId required" }, { status: 400 });

  const redirectUri = `${url.origin}/api/integrations/${provider}/callback`;
  const { driver } = getDriver(id);
  const consentUrl = driver.authorizeUrl({ redirectUri, state: connectionId });
  return NextResponse.redirect(consentUrl);
}
