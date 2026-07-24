import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { createApiKey, listApiKeys } from "@/lib/server/api-key";

export const runtime = "nodejs";

/** List the tenant's API keys (never returns the secret). */
export async function GET() {
  try {
    const { orgId } = await requireSession();
    return json({ keys: await listApiKeys(orgId) });
  } catch (e) {
    return handleError(e);
  }
}

/** Create a key — returns the plaintext exactly once. */
export async function POST(req: Request) {
  try {
    const { orgId } = await requireSession();
    const body = (await req.json().catch(() => ({}))) as { name?: string };
    const { plaintext, view } = await createApiKey(orgId, body.name ?? "");
    return json({ key: view, plaintext });
  } catch (e) {
    return handleError(e);
  }
}
