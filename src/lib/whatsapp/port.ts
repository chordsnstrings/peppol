/**
 * WhatsAppPort — send messages on behalf of a tenant. Each tenant connects its
 * own WhatsApp number (its phone-number id under our platform's WhatsApp
 * Business account), and messages are sent through the platform. Mock driver
 * runs credential-free; the Meta Cloud driver is the real path.
 */
export type WhatsAppDriverId = "mock" | "meta";

/**
 * Deterministic id for a tenant's WhatsApp config. It MUST be namespaced so it
 * never collides with the entity's own id — the document store shares one global
 * primary key across every store, so `id: entityId` would overwrite the entity.
 */
export function waConfigId(entityId: string): string {
  return `wa:${entityId}`;
}

export interface WhatsAppSendRequest {
  to: string; // E.164 number
  text: string;
}

export interface WhatsAppPort {
  driver: WhatsAppDriverId;
  send(config: { phoneNumberId?: string }, req: WhatsAppSendRequest): Promise<{ providerRef: string }>;
  healthcheck(): Promise<{ ok: boolean; detail?: string }>;
}
