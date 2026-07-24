import type { AccountingProviderPort, ProviderId } from "./port";
import { makeMockDriver } from "./mock";
import { zohoDriver } from "./zoho";

/** Provider config: whether live credentials are present for each. */
export function providerHasCredentials(id: ProviderId): boolean {
  switch (id) {
    case "ZOHO_BOOKS":
      return Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET);
    default:
      return false; // QBO/Xero/Odoo adapters land next; mock until then
  }
}

/**
 * Resolve the active driver for a provider. Uses the real adapter when its
 * credentials are configured, otherwise the credential-free mock driver so the
 * flow is always runnable.
 */
export function getDriver(id: ProviderId): { driver: AccountingProviderPort; mode: "live" | "mock" } {
  if (id === "ZOHO_BOOKS" && providerHasCredentials("ZOHO_BOOKS")) {
    return { driver: zohoDriver, mode: "live" };
  }
  return { driver: makeMockDriver(id), mode: "mock" };
}

const SLUG_TO_PROVIDER: Record<string, ProviderId> = {
  zoho: "ZOHO_BOOKS",
  qbo: "QBO",
  xero: "XERO",
  odoo: "ODOO",
};

export function providerFromSlug(slug: string): ProviderId | null {
  return SLUG_TO_PROVIDER[slug] ?? null;
}

export function slugFromProvider(id: ProviderId): string {
  return Object.entries(SLUG_TO_PROVIDER).find(([, v]) => v === id)?.[0] ?? "zoho";
}
