import { NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/server/api-key";
import { verifyAccessToken, originOf } from "@/lib/server/oauth";
import { MCP_TOOLS, MCP_TOOL_BY_NAME } from "@/lib/mcp/tools";

export const runtime = "nodejs";

/**
 * Remote MCP server (Model Context Protocol) over Streamable HTTP, stateless.
 * Any MCP client — Claude, ChatGPT, Gemini — can connect their AI directly to
 * ARKS. Authentication reuses the workspace API key as a bearer token, so tools
 * run scoped to that tenant. See docs/mcp.md.
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "arks-einvoicing", version: "1.0.0" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

type Id = string | number | null;
type RpcMessage = { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, unknown> };

function result(id: Id, value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}
function error(id: Id, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

async function dispatch(msg: RpcMessage, orgId: string): Promise<object | null> {
  const { method } = msg;
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined || msg.id === null;

  switch (method) {
    case "initialize": {
      const requested = (msg.params?.protocolVersion as string) ?? PROTOCOL_VERSIONS[0];
      const version = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return result(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "ARKS UAE e-invoicing. Start with list_entities to get an entityId, then create/validate/send invoices. Money is in minor units (fils; 1 AED = 100).",
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notification — no response
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "resources/list":
      return result(id, { resources: [] });
    case "prompts/list":
      return result(id, { prompts: [] });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const tool = MCP_TOOL_BY_NAME.get(name);
      if (!tool) return error(id, -32602, `Unknown tool: ${name}`);
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const value = await tool.handler(orgId, args);
        return result(id, {
          content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
          structuredContent: value && typeof value === "object" ? value : { value },
        });
      } catch (e) {
        // Tool-level failures are returned as isError content, not protocol errors.
        return result(id, {
          content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : "tool failed"}` }],
          isError: true,
        });
      }
    }
    default:
      return isNotification ? null : error(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Authenticate a request by bearer token — either an OAuth 2.1 access token
 * (JWT, from the sign-in flow) or a workspace API key. Returns the tenant orgId.
 */
async function authenticate(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  const jwt = await verifyAccessToken(token);
  if (jwt) return jwt.orgId;
  try {
    const { orgId } = await authenticateApiKey(req);
    return orgId;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const orgId = await authenticate(req);
  if (!orgId) {
    // Advertise the OAuth authorization server per RFC 9728 so sign-in clients discover it.
    const resourceMeta = `${originOf(req)}/.well-known/oauth-protected-resource`;
    return NextResponse.json(error(null, -32001, "Unauthorized"), {
      status: 401,
      headers: { ...CORS, "WWW-Authenticate": `Bearer resource_metadata="${resourceMeta}"` },
    });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(error(null, -32700, "Parse error"), { status: 400, headers: CORS });
  }

  const messages = Array.isArray(body) ? (body as RpcMessage[]) : [body as RpcMessage];
  const responses: object[] = [];
  for (const msg of messages) {
    const res = await dispatch(msg, orgId);
    if (res) responses.push(res);
  }

  // All notifications → 202 Accepted with no body (per Streamable HTTP spec).
  if (responses.length === 0) {
    return new NextResponse(null, { status: 202, headers: CORS });
  }
  const payload = Array.isArray(body) ? responses : responses[0];
  return NextResponse.json(payload, { headers: { ...CORS, "Content-Type": "application/json" } });
}

/** No server-initiated SSE stream in this stateless server. */
export function GET() {
  return NextResponse.json(
    error(null, -32000, "This MCP endpoint uses POST (Streamable HTTP). Connect an MCP client."),
    { status: 405, headers: { ...CORS, Allow: "POST, OPTIONS" } },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
