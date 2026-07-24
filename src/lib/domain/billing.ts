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
