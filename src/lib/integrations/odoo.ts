import {
  hashInvoice,
  type AccountingProviderPort,
  type ExternalInvoice,
  type SyncResult,
  type TokenSet,
} from "./port";

/**
 * Odoo adapter (JSON-RPC, API-key auth — no OAuth consent screen; spec §8.5.3,
 * §8.5.6). Configured entirely via env (ODOO_URL / ODOO_DB / ODOO_USERNAME /
 * ODOO_API_KEY); authorizeUrl just bounces to our callback, and completeAuth
 * authenticates over JSON-RPC to obtain a uid. Invoices come from account.move.
 */
const URL_ = () => process.env.ODOO_URL ?? "";
const DB = () => process.env.ODOO_DB ?? "";
const USER = () => process.env.ODOO_USERNAME ?? "";
const KEY = () => process.env.ODOO_API_KEY ?? "";

async function rpc(method: string, args: unknown[]): Promise<unknown> {
  const res = await fetch(`${URL_()}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service: method === "authenticate" ? "common" : "object", method, args }, id: 1 }),
  });
  if (!res.ok) throw new Error(`Odoo RPC failed (${res.status})`);
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "Odoo RPC error");
  return j.result;
}

function toMinor(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  return Math.round((Number.isNaN(n) ? 0 : n) * 100);
}

export const odooDriver: AccountingProviderPort = {
  id: "ODOO",

  authorizeUrl({ redirectUri, state }) {
    // No consent screen — bounce straight back to the callback.
    const u = new URL(redirectUri);
    u.searchParams.set("code", "odoo");
    u.searchParams.set("state", state);
    return u.toString();
  },

  async completeAuth(): Promise<TokenSet> {
    const uid = (await rpc("authenticate", [DB(), USER(), KEY(), {}])) as number | false;
    if (!uid) throw new Error("Odoo authentication failed");
    return {
      accessToken: KEY(),
      meta: { url: URL_(), db: DB(), uid: String(uid), mode: "live" },
    };
  },

  async refresh(token) {
    return token; // API-key auth doesn't expire
  },

  async listInvoices(token): Promise<SyncResult> {
    const uid = Number(token.meta?.uid ?? 0);
    const moves = (await rpc("execute_kw", [
      DB(),
      uid,
      token.accessToken,
      "account.move",
      "search_read",
      [[["move_type", "=", "out_invoice"], ["state", "=", "posted"]]],
      { fields: ["name", "invoice_date", "currency_id", "partner_id", "amount_untaxed", "amount_tax"], limit: 25, order: "invoice_date desc" },
    ])) as OdooMove[];

    const invoices: ExternalInvoice[] = moves.map((m) => {
      const rate = (m.amount_tax ?? 0) > 0 ? 5 : 0;
      const mapped: ExternalInvoice = {
        externalId: String(m.id),
        number: m.name ?? String(m.id),
        date: m.invoice_date || new Date().toISOString().slice(0, 10),
        currency: Array.isArray(m.currency_id) ? m.currency_id[1] : "AED",
        customer: {
          externalId: Array.isArray(m.partner_id) ? String(m.partner_id[0]) : "",
          name: Array.isArray(m.partner_id) ? m.partner_id[1] : "Customer",
        },
        // Summary line preserving net + tax (line-level detail can be expanded later).
        lines: [{ description: m.name ?? "Invoice", qty: 1, unitPriceMinor: toMinor(m.amount_untaxed), taxRatePercent: rate }],
        hash: "",
      };
      mapped.hash = hashInvoice({ ...mapped, hash: undefined });
      return mapped;
    });
    return { invoices };
  },
};

interface OdooMove {
  id: number;
  name?: string;
  invoice_date?: string;
  currency_id?: [number, string] | false;
  partner_id?: [number, string] | false;
  amount_untaxed?: number;
  amount_tax?: number;
}
