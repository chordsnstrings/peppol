import { NextResponse } from "next/server";
import { registerClient } from "@/lib/server/oauth";

export const runtime = "nodejs";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization" };

/** RFC 7591 Dynamic Client Registration. Open registration; PKCE public clients. */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      redirect_uris?: unknown;
      client_name?: string;
      token_endpoint_auth_method?: string;
      grant_types?: string[];
    };
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === "string")
      : [];
    if (redirectUris.length === 0) {
      return NextResponse.json({ error: "invalid_redirect_uri", error_description: "redirect_uris is required" }, { status: 400, headers: CORS });
    }
    for (const u of redirectUris) {
      try {
        new URL(u);
      } catch {
        return NextResponse.json({ error: "invalid_redirect_uri", error_description: `Bad redirect_uri: ${u}` }, { status: 400, headers: CORS });
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
    return NextResponse.json({ error: "server_error", error_description: e instanceof Error ? e.message : "error" }, { status: 500, headers: CORS });
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
