import { NextResponse } from "next/server";
import { originOf, SCOPE } from "@/lib/server/oauth";

export const runtime = "nodejs";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };

/** RFC 9728 Protected Resource Metadata — points MCP clients at our auth server. */
export function GET(req: Request) {
  const origin = originOf(req);
  return NextResponse.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
    },
    { headers: CORS },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
