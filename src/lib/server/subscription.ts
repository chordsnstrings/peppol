import { prisma } from "./prisma";
import { TRIAL_DAYS, GRACE_DAYS, type SubTier, SUB_BY_TIER } from "@/lib/domain/billing";

/**
 * Subscription state machine — the FTA paywall. Entitlement to transmit derives
 * ONLY from server-authoritative billing rows (never client data), and is
 * computed from timestamps so it's correct even if the dunning cron lags:
 *   trialing  → entitled while now < trialEndsAt
 *   active    → entitled while now < currentPeriodEnd + grace  (implicit grace)
 *   grace     → same window; label set by cron for dunning
 *   canceled  → not entitled (cut off)
 */
export type SubStatus = "trialing" | "active" | "grace" | "canceled" | "none";

const DAY = 24 * 60 * 60 * 1000;

export class PaymentRequiredError extends Error {
  status = 402;
  upgradeUrl = "/settings/billing";
  constructor(message = "An active subscription is required to transmit to the FTA.") {
    super(message);
    this.name = "PaymentRequiredError";
  }
}

export interface SubState {
  status: SubStatus;
  tier: SubTier | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  entitled: boolean;
  /** ms until the current entitlement lapses (for banners), or null. */
  entitledUntil: string | null;
}

type Row = {
  subStatus: string;
  subTier: string | null;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  graceEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
};

/** Pure entitlement computation from a billing row. */
export function entitlementFrom(row: Row, now = Date.now()): { entitled: boolean; until: Date | null } {
  if (row.subStatus === "trialing") {
    const until = row.trialEndsAt;
    return { entitled: Boolean(until && until.getTime() > now), until };
  }
  if (row.subStatus === "active" || row.subStatus === "grace") {
    // Implicit grace after the period end, independent of the cron.
    const end = row.currentPeriodEnd ? new Date(row.currentPeriodEnd.getTime() + GRACE_DAYS * DAY) : null;
    return { entitled: Boolean(end && end.getTime() > now), until: end };
  }
  return { entitled: false, until: null }; // canceled | none
}

/** Read (and lazily initialise) the org's billing row, starting a trial if new. */
export async function ensureBilling(orgId: string): Promise<Row & { orgId: string }> {
  const existing = await prisma.orgBilling.findUnique({ where: { orgId } });
  if (existing) return existing;
  // No row yet — start a trial anchored to the org's creation date.
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { createdAt: true } });
  const base = org?.createdAt ?? new Date();
  const trialEndsAt = new Date(base.getTime() + TRIAL_DAYS * DAY);
  return prisma.orgBilling.upsert({
    where: { orgId },
    create: { orgId, subStatus: "trialing", trialEndsAt },
    update: {},
  });
}

export async function getSubState(orgId: string): Promise<SubState> {
  const row = await ensureBilling(orgId);
  const { entitled, until } = entitlementFrom(row);
  return {
    status: row.subStatus as SubStatus,
    tier: (row.subTier as SubTier | null) ?? null,
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    graceEndsAt: row.graceEndsAt?.toISOString() ?? null,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    entitled,
    entitledUntil: until?.toISOString() ?? null,
  };
}

export async function isEntitled(orgId: string): Promise<boolean> {
  const row = await ensureBilling(orgId);
  return entitlementFrom(row).entitled;
}

/** The paywall guard — throws 402 when the org may not transmit. */
export async function assertEntitled(orgId: string): Promise<void> {
  if (!(await isEntitled(orgId))) throw new PaymentRequiredError();
}

/** Start a fresh trial (called at registration). */
export async function startTrial(orgId: string): Promise<void> {
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * DAY);
  await prisma.orgBilling.upsert({
    where: { orgId },
    create: { orgId, subStatus: "trialing", trialEndsAt },
    update: { subStatus: "trialing", trialEndsAt },
  });
}

/** Activate/renew a paid subscription for `tier`, extending the period. */
export async function activateSubscription(
  orgId: string,
  tier: SubTier,
  opts: { providerSubscriptionId?: string; providerCustomerId?: string } = {},
): Promise<void> {
  const months = SUB_BY_TIER[tier].months;
  const now = new Date();
  // Extend from the later of now or an existing future period end.
  const existing = await prisma.orgBilling.findUnique({ where: { orgId }, select: { currentPeriodEnd: true } });
  const from = existing?.currentPeriodEnd && existing.currentPeriodEnd > now ? existing.currentPeriodEnd : now;
  const currentPeriodEnd = new Date(from);
  currentPeriodEnd.setUTCMonth(currentPeriodEnd.getUTCMonth() + months);

  await prisma.orgBilling.upsert({
    where: { orgId },
    create: {
      orgId, subStatus: "active", subTier: tier, currentPeriodEnd, lastPaymentAt: now,
      providerSubscriptionId: opts.providerSubscriptionId, providerCustomerId: opts.providerCustomerId,
    },
    update: {
      subStatus: "active", subTier: tier, currentPeriodEnd, lastPaymentAt: now,
      graceEndsAt: null, cancelAtPeriodEnd: false, dunningStage: 0,
      providerSubscriptionId: opts.providerSubscriptionId ?? undefined,
      providerCustomerId: opts.providerCustomerId ?? undefined,
    },
  });
}

/** Move a lapsed subscription into the dunning/grace window. */
export async function enterGrace(orgId: string): Promise<void> {
  const graceEndsAt = new Date(Date.now() + GRACE_DAYS * DAY);
  await prisma.orgBilling.update({ where: { orgId }, data: { subStatus: "grace", graceEndsAt } });
}

/** Cut off — grace exhausted or hard cancel. */
export async function cancelSubscription(orgId: string): Promise<void> {
  await prisma.orgBilling.update({ where: { orgId }, data: { subStatus: "canceled" } });
}
