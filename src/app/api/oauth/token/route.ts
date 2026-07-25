import { NextResponse } from "next/server";
import {
  getClient,
  verifyClientSecret,
  consumeAuthCode,
  verifyPkceS256,
  issueAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  originOf,
  SCOPE,
  ACCESS_TTL_SECONDS,
} from "@/lib/server/oauth";
import { clientIp, rateLimit, tooManyResponse } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization" };

function oauthError(error: string, description?: string, status = 400) {
  return NextResponse.json({ error, ...(description ? { error_description: description } : {}) }, { status, headers: CORS });
}

/** Parse form-encoded or JSON body into a flat map. */
async function readBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v ?? "")]));
  }
  const text = await req.text();
  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

/** RFC 6749 §3.2 token endpoint: authorization_code (PKCE) + refresh_token. */
export async function POST(req: Request) {
  try {
    // Throttle code/secret guessing per IP.
    const rl = rateLimit(`oauth:token:${clientIp(req)}`, 30, 5 * 60_000);
    if (!rl.ok) return tooManyResponse(rl.retryAfter, CORS);

    const body = await readBody(req);
    const grant = body.grant_type;

    // Client auth: id from body (or Basic header), secret optional for public clients.
    let clientId = body.client_id ?? "";
    let clientSecret = body.client_secret;
    const basic = req.headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      const [id, secret] = Buffer.from(basic.slice(6), "base64").toString().split(":");
      clientId = clientId || id;
      clientSecret = clientSecret ?? secret;
    }
    const client = await getClient(clientId);
    if (!client) return oauthError("invalid_client", "Unknown client", 401);
    if (!verifyClientSecret(client, clientSecret)) return oauthError("invalid_client", "Bad client secret", 401);

    const origin = originOf(req);

    if (grant === "authorization_code") {
      const { code, redirect_uri, code_verifier } = body;
      if (!code || !redirect_uri || !code_verifier) return oauthError("invalid_request", "Missing code, redirect_uri or code_verifier");
      const consumed = await consumeAuthCode(code, clientId, redirect_uri);
      if (!consumed) return oauthError("invalid_grant", "Authorization code is invalid, used or expired");
      if (!verifyPkceS256(code_verifier, consumed.codeChallenge)) return oauthError("invalid_grant", "PKCE verification failed");

      const accessToken = await issueAccessToken({
        userId: consumed.userId,
        orgId: consumed.orgId,
        clientId,
        scope: consumed.scope,
        issuer: origin,
      });
      const refreshToken = await issueRefreshToken({ clientId, orgId: consumed.orgId, userId: consumed.userId, scope: consumed.scope });
      return NextResponse.json(
        { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refreshToken, scope: consumed.scope },
        { headers: { ...CORS, "Cache-Control": "no-store" } },
      );
    }

    if (grant === "refresh_token") {
      const { refresh_token } = body;
      if (!refresh_token) return oauthError("invalid_request", "Missing refresh_token");
      const rotated = await rotateRefreshToken(refresh_token, clientId);
      if (!rotated) return oauthError("invalid_grant", "Refresh token is invalid, revoked or expired");
      const accessToken = await issueAccessToken({
        userId: rotated.userId,
        orgId: rotated.orgId,
        clientId,
        scope: rotated.scope,
        issuer: origin,
      });
      return NextResponse.json(
        { access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: rotated.refreshToken, scope: rotated.scope ?? SCOPE },
        { headers: { ...CORS, "Cache-Control": "no-store" } },
      );
    }

    return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grant}`);
  } catch (e) {
    console.error("[oauth/token]", e);
    return oauthError("server_error", "Token request failed", 500);
  }
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
