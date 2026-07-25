import { requireWritableSession } from "@/lib/server/org-status";
import { json, handleError } from "@/lib/server/http";
import { getRecord, putRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
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
    const { orgId } = await requireWritableSession();
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

    // Ownership: a phone-number id may not be claimed by two different tenants
    // (it sends with the platform token, so cross-claim = sending as someone else).
    const phoneNumberId = body.phoneNumberId?.trim() || existing?.phoneNumberId;
    if (phoneNumberId) {
      const clash = await prisma.record.findFirst({
        where: { store: "whatsapp", data: { contains: `"phoneNumberId":"${phoneNumberId}"` }, orgId: { not: orgId } },
        select: { id: true },
      });
      if (clash) return json({ error: "This WhatsApp number is already connected to another workspace." }, 409);
    }

    const config: WhatsAppConfig = {
      id: configId,
      orgId,
      entityId,
      connected: true,
      displayNumber,
      phoneNumberId,
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
