import {
  hashInvoice,
  type AccountingProviderPort,
  type ExternalInvoice,
  type SyncResult,
  type TokenSet,
} from "./port";

/**
 * QuickBooks Online adapter (Intuit OAuth2). Gotchas (spec §8.5.3): realmId
 * arrives as a callback query param (not in the token response); tax lives in
 * TxnTaxDetail rather than per line. Activated when QBO_CLIENT_ID/SECRET are set.
 */
const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

function apiBase(): string {
  return (process.env.QBO_ENVIRONMENT ?? "sandbox") === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

function basicAuth(): string {
  const raw = `${process.env.QBO_CLIENT_ID ?? ""}:${process.env.QBO_CLIENT_SECRET ?? ""}`;
  return Buffer.from(raw).toString("base64");
}

function toMinor(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  return Math.round((Number.isNaN(n) ? 0 : n) * 100);
}

export const qboDriver: AccountingProviderPort = {
  id: "QBO",

  authorizeUrl({ redirectUri, state }) {
    const p = new URLSearchParams({
      client_id: process.env.QBO_CLIENT_ID ?? "",
      response_type: "code",
      scope: SCOPE,
      redirect_uri: redirectUri,
      state,
    });
    return `${AUTH_BASE}?${p.toString()}`;
  },

  async completeAuth({ code, redirectUri, query }) {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
    });
    if (!res.ok) throw new Error(`QBO token exchange failed (${res.status})`);
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const realmId = query?.realmId ?? "";
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
      meta: { realmId, apiBase: apiBase(), mode: "live" },
    };
  },

  async refresh(token) {
    if (!token.refreshToken) return token;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken }),
    });
    if (!res.ok) throw new Error(`QBO refresh failed (${res.status})`);
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    return {
      ...token,
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? token.refreshToken,
      expiresAt: j.expires_in ? Date.now() + j.expires_in * 1000 : undefined,
    };
  },

  async listInvoices(token): Promise<SyncResult> {
    const base = token.meta?.apiBase ?? apiBase();
    const realmId = token.meta?.realmId ?? "";
    const q = encodeURIComponent("SELECT * FROM Invoice ORDERBY TxnDate DESC MAXRESULTS 25");
    const res = await fetch(`${base}/v3/company/${realmId}/query?query=${q}&minorversion=65`, {
      headers: { Authorization: `Bearer ${token.accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`QBO invoices query failed (${res.status})`);
    const j = (await res.json()) as { QueryResponse?: { Invoice?: QboInvoice[] } };

    const invoices: ExternalInvoice[] = (j.QueryResponse?.Invoice ?? []).map((inv) => {
      const taxed = (inv.TxnTaxDetail?.TotalTax ?? 0) > 0;
      const mapped: ExternalInvoice = {
        externalId: inv.Id,
        number: inv.DocNumber ?? inv.Id,
        date: inv.TxnDate,
        currency: inv.CurrencyRef?.value ?? "AED",
        customer: { externalId: inv.CustomerRef?.value ?? "", name: inv.CustomerRef?.name ?? "Customer" },
        lines: (inv.Line ?? [])
          .filter((l) => l.DetailType === "SalesItemLineDetail")
          .map((l) => ({
            description: l.Description ?? l.SalesItemLineDetail?.ItemRef?.name ?? "Item",
            qty: Number(l.SalesItemLineDetail?.Qty ?? 1) || 1,
            unitPriceMinor: toMinor(
              l.SalesItemLineDetail?.UnitPrice ?? (l.Amount ?? 0) / (Number(l.SalesItemLineDetail?.Qty) || 1),
            ),
            taxRatePercent: taxed ? 5 : 0,
          })),
        hash: "",
      };
      mapped.hash = hashInvoice({ ...mapped, hash: undefined });
      return mapped;
    });
    return { invoices };
  },
};

interface QboInvoice {
  Id: string;
  DocNumber?: string;
  TxnDate: string;
  CurrencyRef?: { value: string };
  CustomerRef?: { value: string; name: string };
  TxnTaxDetail?: { TotalTax?: number };
  Line?: Array<{
    DetailType: string;
    Description?: string;
    Amount?: number;
    SalesItemLineDetail?: {
      Qty?: number | string;
      UnitPrice?: number | string;
      ItemRef?: { name?: string };
    };
  }>;
}
