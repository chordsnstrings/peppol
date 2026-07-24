/**
 * AccountingProviderPort (build spec §8.5). Nothing above this port knows which
 * provider is active. Adapters live in ./{provider}.ts; a credential-free mock
 * driver (./mock.ts) makes the whole OAuth+sync flow runnable without setup.
 */

export type ProviderId = "ZOHO_BOOKS" | "QBO" | "XERO" | "ODOO";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  meta?: Record<string, string>; // e.g. { apiDomain, organizationId }
}

export interface ExternalCustomer {
  externalId: string;
  name: string;
  trn?: string;
  email?: string;
}

export interface ExternalInvoiceLine {
  description: string;
  qty: number;
  unitPriceMinor: number; // exclusive of tax
  taxRatePercent: number;
}

export interface ExternalInvoice {
  externalId: string;
  number: string;
  date: string; // YYYY-MM-DD
  currency: string;
  customer: ExternalCustomer;
  lines: ExternalInvoiceLine[];
  hash: string; // change-detection over the mapped content
}

export interface SyncResult {
  invoices: ExternalInvoice[];
  cursor?: string;
}

export interface AccountingProviderPort {
  id: ProviderId;
  /** Build the OAuth consent URL to redirect the user to. */
  authorizeUrl(params: { redirectUri: string; state: string }): string;
  /**
   * Exchange an authorization code for tokens. `query` carries any extra params
   * the provider adds to the callback (e.g. QuickBooks `realmId`).
   */
  completeAuth(params: {
    code: string;
    redirectUri: string;
    query?: Record<string, string>;
  }): Promise<TokenSet>;
  /** Refresh an expired access token. */
  refresh(token: TokenSet): Promise<TokenSet>;
  /** Pull invoices (+ embedded customers) since an optional cursor. */
  listInvoices(token: TokenSet, cursor?: string): Promise<SyncResult>;
}

/** Stable content hash for change detection (no crypto needed). */
export function hashInvoice(parts: unknown): string {
  const s = JSON.stringify(parts);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
