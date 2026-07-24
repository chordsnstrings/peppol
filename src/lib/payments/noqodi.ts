import { createHmac, timingSafeEqual } from "node:crypto";
import { minorToMajor } from "@/lib/domain/money";
import type { PaymentEvent, PaymentProviderPort, PaymentRequest } from "./port";

/**
 * noqodi — UAE digital payment gateway (hosted checkout + callback). Built
 * against the assumed contract in docs/payment-contract.md; reconcile with
 * noqodi's real merchant-integration docs on sign-up. Activated when
 * NOQODI_API_KEY (+ NOQODI_API_BASE) are configured.
 */
const BASE = () => process.env.NOQODI_API_BASE ?? "https://api.noqodi.com";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.NOQODI_API_KEY ?? ""}`,
    "X-Merchant-Id": process.env.NOQODI_MERCHANT_ID ?? "",
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function mapStatus(s?: string): PaymentEvent["status"] {
  switch ((s ?? "").toUpperCase()) {
    case "PAID":
    case "SUCCESS":
    case "COMPLETED":
      return "PAID";
    case "FAILED":
    case "DECLINED":
      return "FAILED";
    case "REFUNDED":
      return "REFUNDED";
    case "EXPIRED":
    case "CANCELLED":
      return "EXPIRED";
    default:
      return "PENDING";
  }
}

export const noqodiPayments: PaymentProviderPort = {
  driver: "noqodi",

  async createPaymentLink(req: PaymentRequest) {
    const res = await fetch(`${BASE()}/api/v1/checkout`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        amount: minorToMajor(req.amountMinor).toFixed(2),
        currency: req.currency,
        reference: req.reference,
        description: req.description,
        customerName: req.customerName,
        customerEmail: req.customerEmail,
        returnUrl: req.returnUrl,
        callbackUrl: `${req.origin}/api/payments/webhook`,
      }),
    });
    if (!res.ok) throw new Error(`noqodi checkout failed (${res.status})`);
    const j = (await res.json()) as { paymentUrl?: string; checkoutUrl?: string; referenceId?: string; id?: string };
    const paymentUrl = j.paymentUrl ?? j.checkoutUrl;
    if (!paymentUrl) throw new Error("noqodi returned no checkout URL");
    return { paymentUrl, providerRef: j.referenceId ?? j.id };
  },

  async getStatus(providerRef): Promise<PaymentEvent | null> {
    const res = await fetch(`${BASE()}/api/v1/payments/${encodeURIComponent(providerRef)}`, {
      headers: headers(),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { status?: string; method?: string };
    return { providerRef, status: mapStatus(j.status), method: j.method, at: new Date().toISOString() };
  },

  async parseWebhook(hdrs, rawBody): Promise<PaymentEvent[]> {
    const secret = process.env.NOQODI_WEBHOOK_SECRET;
    if (secret) {
      const sig = hdrs["x-noqodi-signature"] ?? "";
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid noqodi signature");
    }
    const j = JSON.parse(rawBody) as { referenceId?: string; id?: string; status?: string; method?: string; amount?: string };
    return [
      {
        providerRef: j.referenceId ?? j.id,
        status: mapStatus(j.status),
        method: j.method,
        amountMinor: j.amount ? Math.round(parseFloat(j.amount) * 100) : undefined,
        at: new Date().toISOString(),
      },
    ];
  },

  async healthcheck() {
    return { ok: Boolean(process.env.NOQODI_API_KEY), detail: "noqodi" };
  },
};
