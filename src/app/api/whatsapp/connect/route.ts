import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getRecord, putRecord } from "@/lib/server/store";
import { getWhatsApp } from "@/lib/whatsapp/registry";
import { waConfigId } from "@/lib/whatsapp/port";
import type { Entity, WhatsAppConfig } from "@/lib/domain/types";

export const runtime = "nodejs";

/**
 * Connect a tenant's WhatsApp number. The config is keyed by entityId so each
 * entity in the workspace can send from its own number. In the mock driver no
 * credentials are required; the Meta driver stores the tenant's phone-number id.
 */
export async function POST(req: Request) {
  try {
    const { orgId } = await requireSession();
    const body = (await req.json().catch(() => ({}))) as {
      entityId?: string;
      displayNumber?: string;
      phoneNumberId?: string;
    };
    const entityId = body.entityId?.trim();
    const displayNumber = (body.displayNumber ?? "").trim();
    if (!entityId) return json({ error: "entityId is required" }, 400);
    if (!displayNumber) return json({ error: "A WhatsApp number is required" }, 400);

    const entity = await getRecord<Entity>(orgId, "entities", entityId);
    if (!entity) return json({ error: "Entity not found" }, 404);

    const now = new Date().toISOString();
    const configId = waConfigId(entityId);
    const existing = await getRecord<WhatsAppConfig>(orgId, "whatsapp", configId);
    const driver = getWhatsApp().driver;

    const config: WhatsAppConfig = {
      id: configId,
      orgId,
      entityId,
      connected: true,
      displayNumber,
      phoneNumberId: body.phoneNumberId?.trim() || existing?.phoneNumberId,
      provider: driver,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await putRecord(orgId, "whatsapp", config);
    return json({ config, live: driver === "meta" });
  } catch (e) {
    return handleError(e);
  }
}
