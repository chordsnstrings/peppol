import { claimOperator, assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";

export const runtime = "nodejs";

/**
 * One-time operator bootstrap: an allowlisted, signed-in user who presents the
 * PLATFORM_BOOTSTRAP_TOKEN is elevated to `super`. Not behind the admin guard
 * (that's the chicken-and-egg it solves), but requires a valid session + secret.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const body = (await req.json().catch(() => ({}))) as { token?: string };
    const result = await claimOperator(String(body.token ?? ""));
    if (result === "ok" || result === "already") return json({ ok: true, result });
    const status = result === "no_session" ? 401 : 403;
    const message =
      result === "bad_token" ? "Incorrect bootstrap token." : result === "not_allowlisted" ? "This account isn't on the operator allowlist." : "Sign in first.";
    return json({ ok: false, result, error: message }, status);
  } catch (e) {
    return handleError(e);
  }
}
