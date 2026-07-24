import { NextResponse } from "next/server";
import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getClient, redirectUriAllowed, createAuthCode, SCOPE } from "@/lib/server/oauth";

export const runtime = "nodejs";

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state?: string;
  resource?: string;
}

function readParams(src: URLSearchParams | Record<string, unknown>): AuthorizeParams {
  const get = (k: string) =>
    src instanceof URLSearchParams ? src.get(k) ?? undefined : (src[k] as string | undefined);
  return {
    clientId: get("client_id") ?? "",
    redirectUri: get("redirect_uri") ?? "",
    responseType: get("response_type") ?? "code",
    codeChallenge: get("code_challenge") ?? "",
    codeChallengeMethod: get("code_challenge_method") ?? "",
    scope: get("scope") ?? SCOPE,
    state: get("state") ?? undefined,
    resource: get("resource") ?? undefined,
  };
}

async function validate(p: AuthorizeParams): Promise<{ ok: true; clientName: string } | { ok: false; error: string }> {
  if (p.responseType !== "code") return { ok: false, error: "unsupported_response_type" };
  if (!p.codeChallenge || p.codeChallengeMethod !== "S256") return { ok: false, error: "PKCE (S256) is required" };
  const client = await getClient(p.clientId);
  if (!client) return { ok: false, error: "Unknown client" };
  if (!redirectUriAllowed(client, p.redirectUri)) return { ok: false, error: "redirect_uri not registered for this client" };
  return { ok: true, clientName: client.name };
}

/** Validation + client info for the consent screen (no session needed). */
export async function GET(req: Request) {
  const p = readParams(new URL(req.url).searchParams);
  const v = await validate(p);
  if (!v.ok) return json({ ok: false, error: v.error }, 400);
  return json({ ok: true, clientName: v.clientName, scope: p.scope });
}

function appendParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [k, val] of Object.entries(params)) if (val !== undefined) url.searchParams.set(k, val);
  return url.toString();
}

/** Mint the authorization code (or deny). Requires a logged-in ARKS user. */
export async function POST(req: Request) {
  try {
    const { userId, orgId } = await requireSession();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const p = readParams(body);
    const decision = String(body.decision ?? "allow");

    const v = await validate(p);
    if (!v.ok) return json({ error: v.error }, 400);

    if (decision !== "allow") {
      return json({ redirectTo: appendParams(p.redirectUri, { error: "access_denied", state: p.state }) });
    }

    const code = await createAuthCode({
      clientId: p.clientId,
      orgId,
      userId,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      scope: p.scope,
      resource: p.resource,
    });
    return json({ redirectTo: appendParams(p.redirectUri, { code, state: p.state }) });
  } catch (e) {
    return handleError(e);
  }
}
