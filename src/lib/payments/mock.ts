import type { PaymentEvent, PaymentProviderPort, PaymentRequest } from "./port";

/**
 * Credential-free payment driver. The hosted page is our own /pay/[token] route,
 * so the full collect → pay → webhook flow runs with no PSP account.
 */
export const mockPayments: PaymentProviderPort = {
  driver: "mock",

  async createPaymentLink(req: PaymentRequest) {
    return { paymentUrl: `${req.origin}/pay/${req.token}`, providerRef: `MOCK-${req.token}` };
  },

  async getStatus(): Promise<PaymentEvent | null> {
    return null; // status is applied via /pay/[token]/complete in mock mode
  },

  async parseWebhook(_headers, rawBody): Promise<PaymentEvent[]> {
    try {
      const parsed = JSON.parse(rawBody);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  },

  async healthcheck() {
    return { ok: true, detail: "mock payments" };
  },
};
