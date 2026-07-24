import { prisma } from "./prisma";

/**
 * Server-side access to the tenant document store (mirrors /api/store) for use
 * inside route handlers that already hold a trusted orgId (send pipeline,
 * gateway webhooks). Always pass the session/authoritative orgId.
 */
export async function getRecord<T>(orgId: string, store: string, id: string): Promise<T | undefined> {
  const row = await prisma.record.findFirst({ where: { id, orgId, store } });
  return row ? (JSON.parse(row.data) as T) : undefined;
}

export async function listRecords<T>(
  orgId: string,
  store: string,
  filter?: { entityId?: string; invoiceId?: string },
): Promise<T[]> {
  const rows = await prisma.record.findMany({
    where: { orgId, store, ...(filter?.entityId ? { entityId: filter.entityId } : {}), ...(filter?.invoiceId ? { invoiceId: filter.invoiceId } : {}) },
  });
  return rows.map((r) => JSON.parse(r.data) as T);
}

export async function putRecord<T extends { id: string; entityId?: string; invoiceId?: string }>(
  orgId: string,
  store: string,
  obj: T,
): Promise<T> {
  const data = JSON.stringify({ ...obj, orgId });
  // Guard against cross-tenant overwrites even on trusted paths.
  const existing = await prisma.record.findUnique({ where: { id: obj.id } });
  if (existing && existing.orgId !== orgId) {
    throw new Error("Forbidden: record belongs to another tenant");
  }
  await prisma.record.upsert({
    where: { id: obj.id },
    create: { id: obj.id, orgId, store, entityId: obj.entityId ?? null, invoiceId: obj.invoiceId ?? null, data },
    update: { data, store, entityId: obj.entityId ?? null, invoiceId: obj.invoiceId ?? null },
  });
  return obj;
}
