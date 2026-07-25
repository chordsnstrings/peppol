import { NextResponse } from "next/server";
import { registerClient } from "@/lib/server/oauth";
import { clientIp, rateLimit, tooManyResponse } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization" };

/** A redirect_uri must be https (real clients), or http(s)://localhost for dev. */
function redirectUriAllowed(u: URL): boolean {
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

/** RFC 7591 Dynamic Client Registration. Open registration; PKCE public clients. */
export async function POST(req: Request) {
  try {
    // Bound open-registration abuse (unbounded client-row creation) per IP.
    const rl = rateLimit(`oauth:register:${clientIp(req)}`, 10, 60 * 60_000);
    if (!rl.ok) return tooManyResponse(rl.retryAfter, CORS);

    const body = (await req.json().catch(() => ({}))) as {
      redirect_uris?: unknown;
      client_name?: string;
      token_endpoint_auth_method?: string;
      grant_types?: string[];
    };
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (redirectUris.length === 0 || redirectUris.length > 10) {
      return NextResponse.json({ error: "invalid_redirect_uri", error_description: "1–10 redirect_uris required" }, { status: 400, headers: CORS });
    }
    for (const u of redirectUris) {
      let parsed: URL;
      try {
        parsed = new URL(u);
      } catch {
        return NextResponse.json({ error: "invalid_redirect_uri", error_description: "A redirect_uri is not a valid URL" }, { status: 400, headers: CORS });
      }
      if (!redirectUriAllowed(parsed)) {
        return NextResponse.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must use https (or http://localhost for development)" }, { status: 400, headers: CORS });
      }
    }
    const method = body.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none";
    const { client, secret } = await registerClient({
      redirectUris,
      name: body.client_name ?? "MCP client",
      tokenAuthMethod: method,
      grantTypes: body.grant_types,
    });

    return NextResponse.json(
      {
        client_id: client.id,
        ...(secret ? { client_secret: secret } : {}),
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
        redirect_uris: redirectUris,
        grant_types: client.grantTypes.split(","),
        response_types: ["code"],
        token_endpoint_auth_method: client.tokenAuthMethod,
        client_name: client.name,
      },
      { status: 201, headers: CORS },
    );
  } catch (e) {
    console.error("[oauth/register]", e);
    return NextResponse.json({ error: "server_error", error_description: "Registration failed" }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
