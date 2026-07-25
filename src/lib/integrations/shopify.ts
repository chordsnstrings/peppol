import { hashInvoice, type AccountingProviderPort, type ExternalInvoice, type SyncResult, type TokenSet } from "./port";

/**
 * Shopify connector — pulls store orders and maps them to invoices (order →
 * tax invoice). OAuth per shop. Built against Shopify's Admin API; activated
 * when SHOPIFY_API_KEY / SHOPIFY_API_SECRET / SHOPIFY_SHOP are configured.
 */
const SHOP = () => process.env.SHOPIFY_SHOP ?? "";

/**
 * A Shopify store handle is a single DNS label. Reject anything containing `/`,
 * `@`, `:`, `#`, `.` etc. so an attacker-supplied `shop` from the OAuth callback
 * can't break out the host (SSRF) while carrying the store access token.
 */
function safeShop(shop: string): string {
  const handle = shop.replace(/\.myshopify\.com$/i, "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(handle)) {
    throw new Error("Invalid Shopify store handle");
  }
  return handle;
}
const shopHost = (shop: string) => `https://${safeShop(shop)}.myshopify.com`;

function toMinor(v: unknown): number {
  const n = parseFloat(String(v ?? "0"));
  return Math.round((Number.isNaN(n) ? 0 : n) * 100);
}

export const shopifyDriver: AccountingProviderPort = {
  id: "SHOPIFY",

  authorizeUrl({ redirectUri, state }) {
    const p = new URLSearchParams({
      client_id: process.env.SHOPIFY_API_KEY ?? "",
      scope: "read_orders,read_customers",
      redirect_uri: redirectUri,
      state,
    });
    return `${shopHost(SHOP())}/admin/oauth/authorize?${p.toString()}`;
  },

  async completeAuth({ code, query }) {
    const shop = safeShop(query?.shop ?? SHOP()); // reject host-breakout values up front
    const res = await fetch(`${shopHost(shop)}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: process.env.SHOPIFY_API_KEY, client_secret: process.env.SHOPIFY_API_SECRET, code }),
    });
    if (!res.ok) throw new Error(`Shopify token exchange failed (${res.status})`);
    const j = (await res.json()) as { access_token: string };
    return { accessToken: j.access_token, meta: { shop, mode: "live" } };
  },

  async refresh(token) {
    return token; // Shopify offline tokens don't expire
  },

  async listInvoices(token): Promise<SyncResult> {
    const shop = token.meta?.shop ?? SHOP();
    const res = await fetch(`${shopHost(shop)}/admin/api/2024-01/orders.json?status=any&limit=25`, {
      headers: { "X-Shopify-Access-Token": token.accessToken, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Shopify orders failed (${res.status})`);
    const j = (await res.json()) as { orders?: ShopifyOrder[] };
    const invoices: ExternalInvoice[] = (j.orders ?? []).map((o) => {
      const taxed = (o.tax_lines ?? []).length > 0;
      const inv: ExternalInvoice = {
        externalId: String(o.id),
        number: o.name ?? `#${o.order_number}`,
        date: (o.created_at ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10),
        currency: o.currency ?? "AED",
        customer: {
          externalId: String(o.customer?.id ?? ""),
          name: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") || o.email || "Online customer",
          email: o.email,
        },
        lines: (o.line_items ?? []).map((li) => ({
          description: li.title,
          qty: Number(li.quantity) || 1,
          unitPriceMinor: toMinor(li.price),
          taxRatePercent: taxed ? 5 : 0,
        })),
        hash: "",
      };
      inv.hash = hashInvoice({ ...inv, hash: undefined });
      return inv;
    });
    return { invoices };
  },
};

interface ShopifyOrder {
  id: number;
  name?: string;
  order_number?: number;
  created_at?: string;
  currency?: string;
  email?: string;
  customer?: { id?: number; first_name?: string; last_name?: string };
  tax_lines?: unknown[];
  line_items?: Array<{ title: string; quantity: number | string; price: string | number }>;
}
