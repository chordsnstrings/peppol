import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { deleteToken } from "@/lib/integrations/token-store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { orgId } = await requireSession();
    const { connectionId } = (await req.json()) as { connectionId: string };
    if (connectionId) await deleteToken(connectionId, orgId);
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
