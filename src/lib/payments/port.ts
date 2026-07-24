/**
 * PaymentProviderPort — the seam over payment collection. Same pattern as the
 * Peppol gateway: a credential-free mock driver plus real drivers (Network
 * International / N-Genius, noqodi) built against an assumed contract
 * (docs/payment-contract.md) so the real API is a one-file swap.
 */

export type PaymentDriverId = "mock" | "network" | "noqodi";

export interface PaymentRequest {
  invoiceId: string;
  reference: string; // invoice number
  amountMinor: number;
  currency: string;
  description: string;
  customerName?: string;
  customerEmail?: string;
  /** Our Payment id — doubles as the hosted-page token for the mock driver. */
  token: string;
  /** App origin, e.g. https://app.example.com */
  origin: string;
  /** Where to send the payer after they finish. */
  returnUrl: string;
}

export interface PaymentLink {
  paymentUrl: string;
  providerRef?: string;
}

export type PaymentEventStatus = "PAID" | "FAILED" | "PENDING" | "REFUNDED" | "EXPIRED";

export interface PaymentEvent {
  providerRef?: string;
  token?: string;
  status: PaymentEventStatus;
  method?: string;
  amountMinor?: number;
  at: string;
}

export interface PaymentProviderPort {
  driver: PaymentDriverId;
  /** Create a hosted payment link for an invoice. */
  createPaymentLink(req: PaymentRequest): Promise<PaymentLink>;
  /** Pull current status by provider reference (reconciliation). */
  getStatus(providerRef: string): Promise<PaymentEvent | null>;
  /** Verify + parse a provider webhook/callback into normalized events. */
  parseWebhook(headers: Record<string, string>, rawBody: string): Promise<PaymentEvent[]>;
  healthcheck(): Promise<{ ok: boolean; detail?: string }>;
}
