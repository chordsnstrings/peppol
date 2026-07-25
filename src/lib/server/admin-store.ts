import { prisma } from "./prisma";
import { includedFor, PLAN_BY_CODE, isPlanCode, type PlanCode } from "@/lib/domain/billing";

/**
 * Cross-tenant read helpers for the operator console. THIS IS THE ONLY PLACE
 * that reads across org boundaries — every function here must be called behind
 * requirePlatformAdmin(). No writes live here; mutations are audited per-route.
 */

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86400_000);
}
function currentYear(): number {
  return new Date().getUTCFullYear();
}

/* ------------------------------ Overview ------------------------------ */

export async function platformCounts() {
  const [orgs, users, entities, invoices, transmissions, payments] = await Promise.all([
    prisma.organization.count(),
    prisma.user.count(),
    prisma.record.count({ where: { store: "entities" } }),
    prisma.record.count({ where: { store: "invoices" } }),
    prisma.transmission.count(),
    prisma.payment.count(),
  ]);
  return { orgs, users, entities, invoices, transmissions, payments };
}

export async function signups() {
  const [d7, d30] = await Promise.all([
    prisma.organization.count({ where: { createdAt: { gte: daysAgo(7) } } }),
    prisma.organization.count({ where: { createdAt: { gte: daysAgo(30) } } }),
  ]);
  return { last7: d7, last30: d30 };
}

/** Exchange + reporting status breakdown and a headline success rate. */
export async function transmissionHealth() {
  const [byExchange, byReporting, total, recent] = await Promise.all([
    prisma.transmission.groupBy({ by: ["exchangeStatus"], _count: { _all: true } }),
    prisma.transmission.groupBy({ by: ["reportingStatus"], _count: { _all: true } }),
    prisma.transmission.count(),
    prisma.transmission.count({ where: { createdAt: { gte: daysAgo(30) } } }),
  ]);
  const exchange: Record<string, number> = {};
  for (const r of byExchange) exchange[r.exchangeStatus] = r._count._all;
  const reporting: Record<string, number> = {};
  for (const r of byReporting) reporting[r.reportingStatus] = r._count._all;
  const delivered = (exchange.DELIVERED ?? 0) + (exchange.ACCEPTED ?? 0);
  const failures = (exchange.REJECTED_BY_C3 ?? 0) + (exchange.DELIVERY_FAILED ?? 0) + (exchange.UNDELIVERABLE_NO_PARTICIPANT ?? 0);
  const successRate = total > 0 ? Math.round(((total - failures) / total) * 1000) / 10 : 100;
  return { total, recent30d: total ? recent : 0, exchange, reporting, delivered, failures, successRate };
}

/** Payments grouped by status, with paid volume per currency. */
export async function paymentStats() {
  const byStatus = await prisma.payment.groupBy({ by: ["status"], _count: { _all: true } });
  const paidByCurrency = await prisma.payment.groupBy({
    by: ["currency"],
    where: { status: "PAID" },
    _sum: { amountMinor: true },
    _count: { _all: true },
  });
  const status: Record<string, number> = {};
  for (const r of byStatus) status[r.status] = r._count._all;
  const volume = paidByCurrency.map((r) => ({ currency: r.currency, amountMinor: r._sum.amountMinor ?? 0, count: r._count._all }));
  return { status, volume };
}

/** Plan mix + ARR/MRR (plans are annual; orgs without a billing row are free). */
export async function revenue() {
  const [totalOrgs, billingRows] = await Promise.all([
    prisma.organization.count(),
    prisma.orgBilling.findMany(),
  ]);
  const dist: Record<PlanCode, number> = { FREE_MANDATE: 0, STARTER: 0, GROWTH: 0, SCALE: 0 };
  let annualMinor = 0;
  for (const row of billingRows) {
    const plan = isPlanCode(row.plan) ? row.plan : "FREE_MANDATE";
    dist[plan] += 1;
    annualMinor += PLAN_BY_CODE[plan]?.priceMinor ?? 0;
  }
  // Orgs with no billing row are on the free plan.
  dist.FREE_MANDATE += Math.max(0, totalOrgs - billingRows.length);
  return { distribution: dist, arrMinor: annualMinor, mrrMinor: Math.round(annualMinor / 12) };
}

export async function overview() {
  const [counts, signup, tx, pay, rev] = await Promise.all([
    platformCounts(),
    signups(),
    transmissionHealth(),
    paymentStats(),
    revenue(),
  ]);
  return { counts, signups: signup, transmissions: tx, payments: pay, revenue: rev };
}

/* ------------------------------- Tenants ------------------------------ */

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
  users: number;
  entities: number;
  invoices: number;
  plan: PlanCode;
  usage: number;
  allowance: number;
  lastActivityAt: string | null;
}

export async function listTenants(opts: { search?: string; limit?: number } = {}): Promise<TenantRow[]> {
  const where = opts.search
    ? { OR: [{ name: { contains: opts.search, mode: "insensitive" as const } }, { slug: { contains: opts.search, mode: "insensitive" as const } }] }
    : {};
  const orgs = await prisma.organization.findMany({ where, orderBy: { createdAt: "desc" }, take: opts.limit ?? 200 });
  const ids = orgs.map((o) => o.id);
  if (ids.length === 0) return [];

  const year = currentYear();
  const [members, invRows, entRows, billing, usage, lastAct] = await Promise.all([
    prisma.membership.groupBy({ by: ["orgId"], where: { orgId: { in: ids } }, _count: { _all: true } }),
    prisma.record.groupBy({ by: ["orgId"], where: { orgId: { in: ids }, store: "invoices" }, _count: { _all: true } }),
    prisma.record.groupBy({ by: ["orgId"], where: { orgId: { in: ids }, store: "entities" }, _count: { _all: true } }),
    prisma.orgBilling.findMany({ where: { orgId: { in: ids } } }),
    prisma.usageEvent.groupBy({ by: ["orgId"], where: { orgId: { in: ids }, year }, _count: { _all: true } }),
    prisma.record.groupBy({ by: ["orgId"], where: { orgId: { in: ids } }, _max: { updatedAt: true } }),
  ]);
  const m = (rows: { orgId: string; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.orgId, r._count._all]));
  const memberMap = m(members), invMap = m(invRows), entMap = m(entRows), usageMap = m(usage);
  const planMap = new Map(billing.map((b) => [b.orgId, (isPlanCode(b.plan) ? b.plan : "FREE_MANDATE") as PlanCode]));
  const actMap = new Map(lastAct.map((r) => [r.orgId, r._max.updatedAt]));

  return orgs.map((o) => {
    const plan = planMap.get(o.id) ?? "FREE_MANDATE";
    return {
      id: o.id,
      name: o.name,
      slug: o.slug,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      users: memberMap.get(o.id) ?? 0,
      entities: entMap.get(o.id) ?? 0,
      invoices: invMap.get(o.id) ?? 0,
      plan,
      usage: usageMap.get(o.id) ?? 0,
      allowance: includedFor(plan),
      lastActivityAt: actMap.get(o.id)?.toISOString() ?? null,
    };
  });
}

export async function tenantDetail(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return null;
  const year = currentYear();

  const [memberships, entityRecords, invoiceCount, txByExchange, payByStatus, connectionRecords, apiKeyRows, billing, usage, integrationTokens, oauthGrants] =
    await Promise.all([
      prisma.membership.findMany({ where: { orgId }, orderBy: { createdAt: "asc" } }),
      prisma.record.findMany({ where: { orgId, store: "entities" } }),
      prisma.record.count({ where: { orgId, store: "invoices" } }),
      prisma.transmission.groupBy({ by: ["exchangeStatus"], where: { orgId }, _count: { _all: true } }),
      prisma.payment.groupBy({ by: ["status"], where: { orgId }, _count: { _all: true }, _sum: { amountMinor: true } }),
      prisma.record.findMany({ where: { orgId, store: "connections" } }),
      prisma.apiKey.findMany({ where: { orgId, revokedAt: null }, orderBy: { createdAt: "desc" } }),
      prisma.orgBilling.findUnique({ where: { orgId } }),
      prisma.usageEvent.count({ where: { orgId, year } }),
      prisma.integrationToken.count({ where: { orgId } }),
      prisma.oAuthRefreshToken.count({ where: { orgId, revokedAt: null } }),
    ]);

  const userIds = memberships.map((m) => m.userId);
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } });
  const userMap = new Map(users.map((u) => [u.id, u]));

  const plan: PlanCode = billing && isPlanCode(billing.plan) ? (billing.plan as PlanCode) : "FREE_MANDATE";
  const allowance = billing?.allowanceOverride ?? includedFor(plan);
  const parse = <T>(r: { data: string }): T | null => {
    try {
      return JSON.parse(r.data) as T;
    } catch {
      return null;
    }
  };

  return {
    org: { id: org.id, name: org.name, slug: org.slug, status: org.status, suspendedReason: org.suspendedReason, createdAt: org.createdAt.toISOString() },
    members: memberships.map((m) => ({ userId: m.userId, email: userMap.get(m.userId)?.email ?? "(unknown)", name: userMap.get(m.userId)?.name ?? "", role: m.role })),
    entities: entityRecords.map((r) => {
      const e = parse<{ id: string; legalNameEn: string; trn?: string; einvoicingStatus: string; defaultCurrency: string }>(r);
      return e ? { id: e.id, legalNameEn: e.legalNameEn, trn: e.trn, einvoicingStatus: e.einvoicingStatus, currency: e.defaultCurrency } : null;
    }).filter(Boolean),
    invoiceCount,
    transmissions: Object.fromEntries(txByExchange.map((r) => [r.exchangeStatus, r._count._all])),
    payments: payByStatus.map((r) => ({ status: r.status, count: r._count._all, amountMinor: r._sum.amountMinor ?? 0 })),
    connections: connectionRecords.map((r) => {
      const c = parse<{ id: string; provider: string; status: string; mode?: string }>(r);
      return c ? { id: c.id, provider: c.provider, status: c.status, mode: c.mode } : null;
    }).filter(Boolean),
    apiKeys: apiKeyRows.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, lastUsedAt: k.lastUsedAt?.toISOString() ?? null })),
    integrationTokens,
    oauthGrants,
    billing: { plan, usage, allowance, override: billing?.allowanceOverride ?? null, overage: Math.max(0, usage - allowance) },
  };
}
