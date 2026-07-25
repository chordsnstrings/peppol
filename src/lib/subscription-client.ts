"use client";

import type { SubTier, SubPlan } from "@/lib/domain/billing";

export interface SubscriptionState {
  status: "trialing" | "active" | "grace" | "canceled" | "none";
  tier: SubTier | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  entitled: boolean;
  entitledUntil: string | null;
}

export async function getSubscription(): Promise<{ subscription: SubscriptionState; tiers: SubPlan[] }> {
  const res = await fetch("/api/billing/subscription", { credentials: "same-origin" });
  if (!res.ok) throw new Error("Couldn't load subscription");
  return res.json();
}

/** Start checkout and return the hosted payment URL to redirect to. */
export async function startCheckout(tier: SubTier): Promise<string> {
  const res = await fetch("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ tier }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Couldn't start checkout");
  return body.url as string;
}
