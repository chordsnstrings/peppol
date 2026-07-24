import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getRecord, putRecord } from "@/lib/server/store";
import { waConfigId } from "@/lib/whatsapp/port";
import type { WhatsAppConfig } from "@/lib/domain/types";

export const runtime = "nodejs";

/** Disconnect a tenant's WhatsApp number (keeps the record, flips `connected`). */
export async function POST(req: Request) {
  try {
    const { orgId } = await requireSession();
    const body = (await req.json().catch(() => ({}))) as { entityId?: string };
    const entityId = body.entityId?.trim();
    if (!entityId) return json({ error: "entityId is required" }, 400);

    const existing = await getRecord<WhatsAppConfig>(orgId, "whatsapp", waConfigId(entityId));
    if (!existing) return json({ ok: true });

    await putRecord(orgId, "whatsapp", { ...existing, connected: false, updatedAt: new Date().toISOString() });
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
