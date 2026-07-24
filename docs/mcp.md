# Connect your AI to ARKS (MCP server)

ARKS exposes a **remote MCP server** (Model Context Protocol) so you can connect
an AI assistant — Claude, ChatGPT, or Gemini — directly to your workspace and
have it create, validate, send, and look up UAE-compliant invoices in natural
language.

- **Endpoint:** `https://<your-arks-host>/api/mcp`
- **Transport:** Streamable HTTP (stateless), JSON-RPC 2.0
- **Auth (two options):**
  1. **Sign in with OAuth** — for connector UIs (Claude, ChatGPT) that offer a
     "Connect / Sign in" button. Just paste the endpoint URL; the client
     discovers the OAuth server, registers itself, and walks you through a
     consent screen. Nothing to copy.
  2. **API key** as a bearer token (`Authorization: Bearer arks_live_…`) — for
     API/SDK integrations. Create one in **Settings → API**.

The AI acts as your workspace: every tool call is scoped to your org, and you can
revoke an API key (or, for OAuth, the refresh token) to cut access instantly.

## OAuth 2.1 (sign-in)

The endpoint is a full OAuth 2.1 authorization server built for MCP:

- **Discovery:** `GET /.well-known/oauth-protected-resource` (RFC 9728) and
  `GET /.well-known/oauth-authorization-server` (RFC 8414). An unauthenticated
  call to `/api/mcp` returns `401` with a `WWW-Authenticate: … resource_metadata=…`
  header so clients find these automatically.
- **Dynamic Client Registration** (RFC 7591) at `/api/oauth/register` — clients
  self-register; no manual client_id/secret setup.
- **Authorization code + PKCE (S256)** at `/oauth/authorize` — you sign in to
  ARKS and approve the client on a consent screen.
- **Tokens** at `/api/oauth/token` — short-lived JWT access tokens (1h) and
  rotating refresh tokens.

Most connector UIs need only the endpoint URL; they handle the rest.

## Tools exposed

| Tool | What it does |
|------|--------------|
| `list_entities` | List your businesses; get an `entityId` for the other tools |
| `list_customers` | List customers (optionally per entity) |
| `list_invoices` | List invoices (filter by entity / status) |
| `get_invoice` | Fetch one full invoice |
| `validate_invoice` | Check a payload (totals, issues, can-send) without saving |
| `create_invoice` | Create an invoice; `send: true` also transmits it to the FTA/Peppol |
| `send_invoice` | Send an existing invoice (UBL + Tax Data Document → gateway) |
| `get_usage` | This year's billable-exchange usage vs. plan allowance |

Amounts are integer **minor units** (fils; 1 AED = 100).

## Connect from each client

### Claude (API — Messages `mcp_servers`)
```json
{
  "mcp_servers": [
    {
      "type": "url",
      "url": "https://<your-arks-host>/api/mcp",
      "name": "arks",
      "authorization_token": "arks_live_…"
    }
  ]
}
```

### Claude.ai / Claude Desktop (custom connector)
Add a custom connector → remote MCP server → URL `https://<your-arks-host>/api/mcp`,
and set an `Authorization: Bearer arks_live_…` header.

### ChatGPT (Responses API `mcp` tool)
```json
{
  "tools": [
    {
      "type": "mcp",
      "server_label": "arks",
      "server_url": "https://<your-arks-host>/api/mcp",
      "headers": { "Authorization": "Bearer arks_live_…" }
    }
  ]
}
```

### Gemini (google-genai SDK with an MCP client)
Point any MCP client transport at the URL with an `Authorization` header, then
pass the session to Gemini as a tool. Example (Python, `mcp` + `google-genai`):
```python
from mcp.client.streamable_http import streamablehttp_client
client = streamablehttp_client(
    "https://<your-arks-host>/api/mcp",
    headers={"Authorization": "Bearer arks_live_…"},
)
```

## Try it

Once connected, ask your assistant things like:

- *"List my businesses in ARKS."*
- *"Create a draft invoice for Acme FZE: 2 hours consulting at AED 500, 5% VAT."*
- *"Validate it, then send it to the FTA."*
- *"How many e-invoice exchanges have I used this year?"*

## Notes

- Two auth paths are supported: **OAuth 2.1 sign-in** (for connector UIs) and a
  **bearer API key** (for API/SDK use). Both resolve to the same tenant-scoped
  tools.
- The endpoint is stateless and does not open a server→client SSE stream (`GET`
  returns 405); it's a request/response tool server, which is all these tools need.
- CORS is open so browser-based MCP clients can connect; tools always require a
  valid OAuth token or API key, so an open origin can't reach data on its own.
