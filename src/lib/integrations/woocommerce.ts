import { hashInvoice, type AccountingProviderPort, type ExternalInvoice, type SyncResult, type TokenSet } from "./port";

/**
 * WooCommerce connector — REST API with consumer key/secret (no OAuth redirect).
 * Configured via env (WOO_URL / WOO_KEY / WOO_SECRET); authorizeUrl bounces to
 * the callback and completeAuth validates the store credentials. Orders → invoices.
 */
const URL_ = () => process.env.WOO_URL ?? "";

function basic(): string {
  return Buffer.from(`${process.env.WOO_KEY ?? ""}:${process.env.WOO_SECRET ?? ""}`).toString("base64");
}
function toMinor(v: unknown): number {
  const n = parseFloat(String(v ?? "0"));
  return Math.round((Number.isNaN(n) ? 0 : n) * 100);
}

export const wooDriver: AccountingProviderPort = {
  id: "WOOCOMMERCE",

  authorizeUrl({ redirectUri, state }) {
    const u = new URL(redirectUri);
    u.searchParams.set("code", "woo");
    u.searchParams.set("state", state);
    return u.toString();
  },

  async completeAuth(): Promise<TokenSet> {
    // Validate the store is reachable with the configured keys.
    const res = await fetch(`${URL_()}/wp-json/wc/v3/system_status`, {
      headers: { Authorization: `Basic ${basic()}` },
    }).catch(() => null);
    if (!res || !res.ok) throw new Error("WooCommerce authentication failed");
    return { accessToken: basic(), meta: { url: URL_(), mode: "live" } };
  },

  async refresh(token) {
    return token;
  },

  async listInvoices(token): Promise<SyncResult> {
    const base = token.meta?.url ?? URL_();
    const res = await fetch(`${base}/wp-json/wc/v3/orders?per_page=25&orderby=date&order=desc`, {
      headers: { Authorization: `Basic ${token.accessToken}` },
    });
    if (!res.ok) throw new Error(`WooCommerce orders failed (${res.status})`);
    const orders = (await res.json()) as WooOrder[];
    const invoices: ExternalInvoice[] = orders.map((o) => {
      const taxed = parseFloat(String(o.total_tax ?? "0")) > 0;
      const inv: ExternalInvoice = {
        externalId: String(o.id),
        number: o.number ?? String(o.id),
        date: (o.date_created ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10),
        currency: o.currency ?? "AED",
        customer: {
          externalId: String(o.customer_id ?? ""),
          name: [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" ") || o.billing?.company || "Online customer",
          email: o.billing?.email,
        },
        lines: (o.line_items ?? []).map((li) => ({
          description: li.name,
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

interface WooOrder {
  id: number;
  number?: string;
  date_created?: string;
  currency?: string;
  total_tax?: string;
  customer_id?: number;
  billing?: { first_name?: string; last_name?: string; company?: string; email?: string };
  line_items?: Array<{ name: string; quantity: number | string; price: string | number }>;
}
