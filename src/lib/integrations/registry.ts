import type { AccountingProviderPort, ProviderId } from "./port";
import { makeMockDriver } from "./mock";
import { zohoDriver } from "./zoho";
import { qboDriver } from "./qbo";
import { xeroDriver } from "./xero";
import { odooDriver } from "./odoo";
import { shopifyDriver } from "./shopify";
import { wooDriver } from "./woocommerce";

const LIVE_DRIVERS: Record<ProviderId, AccountingProviderPort> = {
  ZOHO_BOOKS: zohoDriver,
  QBO: qboDriver,
  XERO: xeroDriver,
  ODOO: odooDriver,
  SHOPIFY: shopifyDriver,
  WOOCOMMERCE: wooDriver,
};

/** Whether live credentials are configured for a provider. */
export function providerHasCredentials(id: ProviderId): boolean {
  switch (id) {
    case "ZOHO_BOOKS":
      return Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET);
    case "QBO":
      return Boolean(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET);
    case "XERO":
      return Boolean(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET);
    case "ODOO":
      return Boolean(
        process.env.ODOO_URL &&
          process.env.ODOO_DB &&
          process.env.ODOO_USERNAME &&
          process.env.ODOO_API_KEY,
      );
    case "SHOPIFY":
      return Boolean(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET && process.env.SHOPIFY_SHOP);
    case "WOOCOMMERCE":
      return Boolean(process.env.WOO_URL && process.env.WOO_KEY && process.env.WOO_SECRET);
    default:
      return false;
  }
}

/**
 * Resolve the active driver for a provider: the real adapter when its
 * credentials are configured, otherwise the credential-free mock driver so the
 * flow is always runnable.
 */
export function getDriver(id: ProviderId): { driver: AccountingProviderPort; mode: "live" | "mock" } {
  if (providerHasCredentials(id)) {
    return { driver: LIVE_DRIVERS[id], mode: "live" };
  }
  return { driver: makeMockDriver(id), mode: "mock" };
}

const SLUG_TO_PROVIDER: Record<string, ProviderId> = {
  zoho: "ZOHO_BOOKS",
  qbo: "QBO",
  xero: "XERO",
  odoo: "ODOO",
  shopify: "SHOPIFY",
  woo: "WOOCOMMERCE",
};

export function providerFromSlug(slug: string): ProviderId | null {
  return SLUG_TO_PROVIDER[slug] ?? null;
}

export function slugFromProvider(id: ProviderId): string {
  return Object.entries(SLUG_TO_PROVIDER).find(([, v]) => v === id)?.[0] ?? "zoho";
}
