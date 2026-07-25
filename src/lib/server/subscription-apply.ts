import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { putRecord } from "./store";
import { activateSubscription } from "./subscription";
import { SUB_BY_TIER, type SubTier } from "@/lib/domain/billing";
import { formatMoney } from "@/lib/domain/money";

/**
 * Apply a PAID subscription payment: activate/renew the subscription and drop an
 * in-app receipt. (Issuing ARKS's own PINT AE tax invoice to the customer — the
 * dogfood step — is a follow-up; the VAT-inclusive amount is recorded here.)
 */
export async function applySubscriptionPayment(orgId: string, tier: string, paymentId: string): Promise<void> {
  if (!(tier in SUB_BY_TIER)) return;
  const plan = SUB_BY_TIER[tier as SubTier];
  await activateSubscription(orgId, tier as SubTier, { providerSubscriptionId: paymentId });

  await putRecord(orgId, "notifications", {
    id: randomUUID(),
    orgId,
    type: "subscription.active",
    title: "Subscription active",
    body: `Your ${plan.name.toLowerCase()} ARKS plan is active — ${formatMoney(plan.priceMinor, "AED")} (VAT incl.). You're clear to transmit to the FTA.`,
    href: "/settings/billing",
    tone: "success",
    createdAt: new Date().toISOString(),
  });
}
