import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

/**
 * Full tenant data export (portability). If an SME leaves, they keep their
 * statutory records. Returns every domain record + transmission documents for
 * the organization as one JSON archive.
 */
export async function GET() {
  try {
    const { orgId } = await requireSession();
    const [org, records, transmissions] = await Promise.all([
      prisma.organization.findUnique({ where: { id: orgId } }),
      prisma.record.findMany({ where: { orgId } }),
      prisma.transmission.findMany({ where: { orgId } }),
    ]);

    const byStore: Record<string, unknown[]> = {};
    for (const r of records) {
      (byStore[r.store] ??= []).push(JSON.parse(r.data));
    }

    return json({
      exportedAt: new Date().toISOString(),
      organization: org ? { id: org.id, name: org.name, slug: org.slug } : null,
      data: byStore,
      transmissions: transmissions.map((t) => ({
        invoiceId: t.invoiceId,
        gatewayRef: t.gatewayRef,
        driver: t.driver,
        exchangeStatus: t.exchangeStatus,
        reportingStatus: t.reportingStatus,
        ublXml: t.ublXml,
        tddXml: t.tddXml,
        createdAt: t.createdAt,
      })),
    });
  } catch (e) {
    return handleError(e);
  }
}
