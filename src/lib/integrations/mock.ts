import {
  hashInvoice,
  type AccountingProviderPort,
  type ExternalInvoice,
  type ProviderId,
  type SyncResult,
  type TokenSet,
} from "./port";

/**
 * Credential-free test driver (spec §8.5.7). It exercises the full OAuth + sync
 * flow with no external calls, returning a small, clearly-labelled SANDBOX
 * sample so the pipeline is verifiable. When real provider credentials are
 * configured, the live adapter replaces this — see registry.ts.
 */
const SAMPLE: ExternalInvoice[] = [
  {
    externalId: "mock-1001",
    number: "ZB-1001",
    date: "2026-03-04",
    currency: "AED",
    customer: { externalId: "c-1", name: "Sandbox Retail LLC", trn: "100200300400003", email: "ap@sandbox.ae" },
    lines: [{ description: "Consulting services (sandbox)", qty: 1, unitPriceMinor: 750000, taxRatePercent: 5 }],
    hash: "",
  },
  {
    externalId: "mock-1002",
    number: "ZB-1002",
    date: "2026-03-06",
    currency: "AED",
    customer: { externalId: "c-2", name: "Sandbox Logistics FZE", trn: "100500600700003" },
    lines: [
      { description: "Freight (sandbox)", qty: 2, unitPriceMinor: 120000, taxRatePercent: 5 },
      { description: "Handling (sandbox)", qty: 1, unitPriceMinor: 45000, taxRatePercent: 5 },
    ],
    hash: "",
  },
  {
    externalId: "mock-1003",
    number: "ZB-1003",
    date: "2026-03-09",
    currency: "USD",
    customer: { externalId: "c-3", name: "Sandbox Exports Ltd" },
    lines: [{ description: "Export of goods (sandbox)", qty: 10, unitPriceMinor: 90000, taxRatePercent: 0 }],
    hash: "",
  },
].map((inv) => ({ ...inv, hash: hashInvoice(inv) }));

export function makeMockDriver(id: ProviderId): AccountingProviderPort {
  return {
    id,
    authorizeUrl({ redirectUri, state }) {
      // Simulate instant consent: bounce straight to our callback with a fake code.
      const u = new URL(redirectUri);
      u.searchParams.set("code", "mock-code");
      u.searchParams.set("state", state);
      return u.toString();
    },
    async completeAuth(): Promise<TokenSet> {
      return { accessToken: "mock-access", refreshToken: "mock-refresh", meta: { mode: "mock" } };
    },
    async refresh(token: TokenSet): Promise<TokenSet> {
      return token;
    },
    async listInvoices(): Promise<SyncResult> {
      return { invoices: SAMPLE };
    },
  };
}
