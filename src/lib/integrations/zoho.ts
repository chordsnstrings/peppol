import {
  hashInvoice,
  type AccountingProviderPort,
  type ExternalInvoice,
  type SyncResult,
  type TokenSet,
} from "./port";

/**
 * Zoho Books adapter (build spec §8.5.3 gotchas: datacenter-specific base URLs +
 * organization_id header). Real OAuth2 + REST. Activated only when
 * ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET are configured; otherwise the mock driver
 * runs. Not exercised in CI without sandbox credentials.
 */
const ACCOUNTS = () => process.env.ZOHO_ACCOUNTS_DOMAIN ?? "https://accounts.zoho.com";
const SCOPES = "ZohoBooks.invoices.READ,ZohoBooks.contacts.READ,ZohoBooks.settings.READ";

function toMinor(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  return Math.round((Number.isNaN(n) ? 0 : n) * 100);
}

export const zohoDriver: AccountingProviderPort = {
  id: "ZOHO_BOOKS",

  authorizeUrl({ redirectUri, state }) {
    const p = new URLSearchParams({
      scope: SCOPES,
      client_id: process.env.ZOHO_CLIENT_ID ?? "",
      response_type: "code",
      redirect_uri: redirectUri,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${ACCOUNTS()}/oauth/v2/auth?${p.toString()}`;
  },

  async completeAuth({ code, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.ZOHO_CLIENT_ID ?? "",
      client_secret: process.env.ZOHO_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri,
      code,
    });
    const res = await fetch(`${ACCOUNTS()}/oauth/v2/token`, { method: "POST", body });
    if (!res.ok) throw new Error(`Zoho token exchange failed (${res.status})`);
    const j = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      api_domain?: string;
      expires_in?: number;
    };
    const apiDomain = j.api_domain ?? process.env.ZOHO_API_DOMAIN ?? "https://www.zohoapis.com";
    const orgId = await fetchOrgId(j.access_token, apiDomain);
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
      meta: { apiDomain, organizationId: orgId, mode: "live" },
    };
  },

  async refresh(token) {
    if (!token.refreshToken) return token;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: process.env.ZOHO_CLIENT_ID ?? "",
      client_secret: process.env.ZOHO_CLIENT_SECRET ?? "",
      refresh_token: token.refreshToken,
    });
    const res = await fetch(`${ACCOUNTS()}/oauth/v2/token`, { method: "POST", body });
    if (!res.ok) throw new Error(`Zoho refresh failed (${res.status})`);
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    return {
      ...token,
      accessToken: j.access_token,
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    };
  },

  async listInvoices(token): Promise<SyncResult> {
    const apiDomain = token.meta?.apiDomain ?? "https://www.zohoapis.com";
    const orgId = token.meta?.organizationId ?? "";
    const headers = { Authorization: `Zoho-oauthtoken ${token.accessToken}` };

    const listRes = await fetch(
      `${apiDomain}/books/v3/invoices?organization_id=${orgId}&per_page=25`,
      { headers },
    );
    if (!listRes.ok) throw new Error(`Zoho invoices list failed (${listRes.status})`);
    const list = (await listRes.json()) as { invoices?: Array<{ invoice_id: string }> };

    const invoices: ExternalInvoice[] = [];
    for (const summary of list.invoices ?? []) {
      const detRes = await fetch(
        `${apiDomain}/books/v3/invoices/${summary.invoice_id}?organization_id=${orgId}`,
        { headers },
      );
      if (!detRes.ok) continue;
      const { invoice } = (await detRes.json()) as { invoice: ZohoInvoice };
      const mapped: ExternalInvoice = {
        externalId: invoice.invoice_id,
        number: invoice.invoice_number,
        date: invoice.date,
        currency: invoice.currency_code ?? "AED",
        customer: {
          externalId: invoice.customer_id,
          name: invoice.customer_name,
          trn: invoice.cf_trn || invoice.tax_reg_no || undefined,
        },
        lines: (invoice.line_items ?? []).map((li) => ({
          description: li.description || li.name,
          qty: Number(li.quantity) || 1,
          unitPriceMinor: toMinor(li.rate),
          taxRatePercent: Number(li.tax_percentage) || 0,
        })),
        hash: "",
      };
      mapped.hash = hashInvoice({ ...mapped, hash: undefined });
      invoices.push(mapped);
    }
    return { invoices };
  },
};

async function fetchOrgId(accessToken: string, apiDomain: string): Promise<string> {
  const res = await fetch(`${apiDomain}/books/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  if (!res.ok) throw new Error("Could not read Zoho organizations");
  const j = (await res.json()) as { organizations?: Array<{ organization_id: string }> };
  return j.organizations?.[0]?.organization_id ?? "";
}

interface ZohoInvoice {
  invoice_id: string;
  invoice_number: string;
  date: string;
  currency_code?: string;
  customer_id: string;
  customer_name: string;
  cf_trn?: string;
  tax_reg_no?: string;
  line_items?: Array<{
    name: string;
    description?: string;
    quantity: number | string;
    rate: number | string;
    tax_percentage?: number | string;
  }>;
}
