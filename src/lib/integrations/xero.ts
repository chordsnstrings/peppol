import {
  hashInvoice,
  type AccountingProviderPort,
  type ExternalInvoice,
  type SyncResult,
  type TokenSet,
} from "./port";

/**
 * Xero adapter (OAuth2). Gotchas (spec §8.5.3): multi-tenant — resolve the
 * tenant via /connections after token; LineAmountTypes = Exclusive/Inclusive/
 * NoTax drives whether UnitAmount includes tax. Activated when XERO_CLIENT_ID/
 * SECRET are set.
 */
const AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const CONNECTIONS_URL = "https://api.xero.com/connections";
const API = "https://api.xero.com/api.xro/2.0";
const SCOPE = "openid accounting.transactions.read accounting.contacts.read offline_access";

function basicAuth(): string {
  const raw = `${process.env.XERO_CLIENT_ID ?? ""}:${process.env.XERO_CLIENT_SECRET ?? ""}`;
  return Buffer.from(raw).toString("base64");
}

function toMinor(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  return Math.round((Number.isNaN(n) ? 0 : n) * 100);
}

async function exchange(body: URLSearchParams): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth()}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Xero token request failed (${res.status})`);
  return res.json();
}

export const xeroDriver: AccountingProviderPort = {
  id: "XERO",

  authorizeUrl({ redirectUri, state }) {
    const p = new URLSearchParams({
      response_type: "code",
      client_id: process.env.XERO_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
    });
    return `${AUTH_URL}?${p.toString()}`;
  },

  async completeAuth({ code, redirectUri }) {
    const j = await exchange(
      new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    );
    // Resolve the tenant to address subsequent calls.
    const connRes = await fetch(CONNECTIONS_URL, {
      headers: { Authorization: `Bearer ${j.access_token}`, Accept: "application/json" },
    });
    const conns = connRes.ok ? ((await connRes.json()) as Array<{ tenantId: string }>) : [];
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
      meta: { tenantId: conns[0]?.tenantId ?? "", mode: "live" },
    };
  },

  async refresh(token) {
    if (!token.refreshToken) return token;
    const j = await exchange(
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken }),
    );
    return {
      ...token,
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? token.refreshToken,
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    };
  },

  async listInvoices(token): Promise<SyncResult> {
    const tenantId = token.meta?.tenantId ?? "";
    const res = await fetch(`${API}/Invoices?where=${encodeURIComponent('Type=="ACCREC"')}&page=1`, {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(`Xero invoices failed (${res.status})`);
    const j = (await res.json()) as { Invoices?: XeroInvoice[] };

    const invoices: ExternalInvoice[] = (j.Invoices ?? []).slice(0, 25).map((inv) => {
      const inclusive = inv.LineAmountTypes === "Inclusive";
      const noTax = inv.LineAmountTypes === "NoTax";
      const mapped: ExternalInvoice = {
        externalId: inv.InvoiceID,
        number: inv.InvoiceNumber ?? inv.InvoiceID,
        date: (inv.DateString ?? inv.Date ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10),
        currency: inv.CurrencyCode ?? "AED",
        customer: { externalId: inv.Contact?.ContactID ?? "", name: inv.Contact?.Name ?? "Customer", trn: inv.Contact?.TaxNumber },
        lines: (inv.LineItems ?? []).map((li) => {
          const rate = noTax ? 0 : 5;
          const unit = Number(li.UnitAmount) || 0;
          const excl = inclusive ? unit / (1 + rate / 100) : unit;
          return {
            description: li.Description ?? "Item",
            qty: Number(li.Quantity) || 1,
            unitPriceMinor: toMinor(excl),
            taxRatePercent: rate,
          };
        }),
        hash: "",
      };
      mapped.hash = hashInvoice({ ...mapped, hash: undefined });
      return mapped;
    });
    return { invoices };
  },
};

interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber?: string;
  DateString?: string;
  Date?: string;
  CurrencyCode?: string;
  LineAmountTypes?: "Exclusive" | "Inclusive" | "NoTax";
  Contact?: { ContactID?: string; Name?: string; TaxNumber?: string };
  LineItems?: Array<{ Description?: string; Quantity?: number | string; UnitAmount?: number | string }>;
}
