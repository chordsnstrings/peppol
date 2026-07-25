/**
 * Billing plans (pure data, shared by the billing page and the server meter).
 * Prices are in AED minor units. `included` is the number of billable exchanges
 * per entity per year. MD 64 mandates a floor of 100 free exchanges per entity
 * per year regardless of plan — compliance never stops for a billing issue.
 */
export type PlanCode = "FREE_MANDATE" | "STARTER" | "GROWTH" | "SCALE";

export interface Plan {
  code: PlanCode;
  name: string;
  priceMinor: number;
  included: number;
  features: string[];
}

export const MANDATE_FREE_FLOOR = 100;

export const PLANS: Plan[] = [
  { code: "FREE_MANDATE", name: "Free mandate", priceMinor: 0, included: 100, features: ["100 exchanges / entity / yr", "All compliance features", "Email support"] },
  { code: "STARTER", name: "Starter", priceMinor: 240000, included: 600, features: ["600 exchanges / entity / yr", "Excel importer", "2 integrations"] },
  { code: "GROWTH", name: "Growth", priceMinor: 600000, included: 2400, features: ["2,400 exchanges / entity / yr", "All integrations", "Priority support", "API access"] },
  { code: "SCALE", name: "Scale", priceMinor: 1500000, included: 12000, features: ["12,000 exchanges / entity / yr", "Multi-entity", "SLA & onboarding"] },
];

export const PLAN_BY_CODE: Record<PlanCode, Plan> = Object.fromEntries(
  PLANS.map((p) => [p.code, p]),
) as Record<PlanCode, Plan>;

export function isPlanCode(v: string): v is PlanCode {
  return v === "FREE_MANDATE" || v === "STARTER" || v === "GROWTH" || v === "SCALE";
}

/** Exchanges included for a plan, never below the mandate floor. */
export function includedFor(code: PlanCode): number {
  return Math.max(MANDATE_FREE_FLOOR, PLAN_BY_CODE[code]?.included ?? MANDATE_FREE_FLOOR);
}

/* ------------------------ Subscription (the paywall) ------------------ */

/**
 * ARKS subscription tiers. Unlimited FTA transmission; one flat price, billed
 * upfront (annual / 6-mo) or monthly. Prices in AED minor units. A 14-day trial
 * precedes the paywall; a 7-day grace + dunning precedes cutoff.
 */
export type SubTier = "MONTHLY" | "SEMIANNUAL" | "ANNUAL";

export interface SubPlan {
  tier: SubTier;
  name: string;
  priceMinor: number;
  months: number;
  perMonthMinor: number;
  /** % saved vs paying monthly, for the pricing page anchor. */
  savingsPct: number;
  highlight?: boolean;
}

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 7;
/** Anti-abuse soft cap on "unlimited" — flags anomalous volume, not a hard block. */
export const FAIR_USE_MONTHLY = 100_000;
/** Our subscription is VAT-inclusive (5%); we issue the customer a tax invoice. */
export const SUB_VAT_RATE = 0.05;

const MONTHLY_MINOR = 29900;
export const SUB_TIERS: SubPlan[] = [
  { tier: "MONTHLY", name: "Monthly", priceMinor: MONTHLY_MINOR, months: 1, perMonthMinor: 29900, savingsPct: 0 },
  { tier: "SEMIANNUAL", name: "6 months", priceMinor: 150000, months: 6, perMonthMinor: 25000, savingsPct: 16 },
  { tier: "ANNUAL", name: "Annual", priceMinor: 240000, months: 12, perMonthMinor: 20000, savingsPct: 33, highlight: true },
];

export const SUB_BY_TIER = Object.fromEntries(SUB_TIERS.map((t) => [t.tier, t])) as Record<SubTier, SubPlan>;

export function isSubTier(v: string): v is SubTier {
  return v === "MONTHLY" || v === "SEMIANNUAL" || v === "ANNUAL";
}
