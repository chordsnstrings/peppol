import { requirePlatformAdmin, isSuper, logAdminAction } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

/** Export a workspace's data (portability / support). Super only. Audited. */
export async function GET(_req: Request, ctx: { params: Promise<{ org: string }> }) {
  try {
    const admin = await requirePlatformAdmin();
    if (!isSuper(admin.role)) return json({ error: "Only super admins can export a tenant" }, 403);
    const { org } = await ctx.params;

    const organization = await prisma.organization.findUnique({ where: { id: org } });
    if (!organization) return json({ error: "Workspace not found" }, 404);

    const [records, billing, memberships, transmissions, payments] = await Promise.all([
      prisma.record.findMany({ where: { orgId: org } }),
      prisma.orgBilling.findUnique({ where: { orgId: org } }),
      prisma.membership.findMany({ where: { orgId: org } }),
      prisma.transmission.findMany({ where: { orgId: org }, select: { id: true, invoiceId: true, gatewayRef: true, exchangeStatus: true, reportingStatus: true, createdAt: true } }),
      prisma.payment.findMany({ where: { orgId: org }, select: { id: true, invoiceId: true, provider: true, status: true, amountMinor: true, currency: true, paidAt: true } }),
    ]);

    await logAdminAction(admin, { action: "tenant.export", targetOrgId: org, metadata: { records: records.length } });

    return json(
      {
        exportedAt: new Date().toISOString(),
        organization: { id: organization.id, name: organization.name, slug: organization.slug, status: organization.status, createdAt: organization.createdAt },
        billing,
        memberships,
        records: records.map((r) => ({ store: r.store, id: r.id, data: JSON.parse(r.data) })),
        transmissions,
        payments,
      },
      { headers: { "Content-Disposition": `attachment; filename="arks-tenant-${org}.json"` } },
    );
  } catch (e) {
    return handleError(e);
  }
}
