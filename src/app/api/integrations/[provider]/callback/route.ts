import { NextResponse } from "next/server";
import { getSession } from "@/lib/server/session";
import { getDriver, providerFromSlug } from "@/lib/integrations/registry";
import { saveToken } from "@/lib/integrations/token-store";

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
  const connectionId = url.searchParams.get("state"); // we set state = connectionId
  const err = url.searchParams.get("error");

  if (err || !code || !connectionId) {
    return NextResponse.redirect(new URL(`/integrations?error=${err ?? "denied"}`, req.url));
  }

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
