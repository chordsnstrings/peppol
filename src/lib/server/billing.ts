import { prisma } from "./prisma";
import { includedFor, isPlanCode, type PlanCode } from "@/lib/domain/billing";

/**
 * Server-side billing meter. Usage is a COUNT over UsageEvent rows (one per
 * billable exchange, idempotent per invoice), so it can't drift from reality the
 * way a client-side invoice count could.
 */

export function currentBillingYear(): number {
  return new Date().getUTCFullYear();
}

/** Record a billable exchange. Idempotent per (invoiceId, kind) — safe to call on re-send. */
export async function recordExchange(orgId: string, entityId: string, invoiceId: string): Promise<void> {
  try {
    await prisma.usageEvent.create({
      data: { orgId, entityId, invoiceId, kind: "EXCHANGE", year: currentBillingYear() },
    });
  } catch (e) {
    // Unique violation on (invoiceId, kind) → already counted; ignore.
    if ((e as { code?: string }).code !== "P2002") throw e;
  }
}

/** Billable exchanges used by one entity in a given year (defaults to this year). */
export async function usageFor(orgId: string, entityId: string, year = currentBillingYear()): Promise<number> {
  return prisma.usageEvent.count({ where: { orgId, entityId, year } });
}

export async function getPlan(orgId: string): Promise<PlanCode> {
  const row = await prisma.orgBilling.findUnique({ where: { orgId } });
  return row && isPlanCode(row.plan) ? row.plan : "FREE_MANDATE";
}

export async function setPlan(orgId: string, plan: PlanCode): Promise<void> {
  await prisma.orgBilling.upsert({
    where: { orgId },
    create: { orgId, plan },
    update: { plan },
  });
}

export interface UsageSummary {
  entityId: string;
  year: number;
  used: number;
  included: number;
  plan: PlanCode;
  remaining: number;
  overage: number;
}

export async function usageSummary(orgId: string, entityId: string): Promise<UsageSummary> {
  const year = currentBillingYear();
  const [used, plan] = await Promise.all([usageFor(orgId, entityId, year), getPlan(orgId)]);
  const included = includedFor(plan);
  return {
    entityId,
    year,
    used,
    included,
    plan,
    remaining: Math.max(0, included - used),
    overage: Math.max(0, used - included),
  };
}
