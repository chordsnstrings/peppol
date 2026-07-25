import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentEvent, PaymentProviderPort, PaymentRequest } from "./port";

/**
 * Network International — N-Genius Online (hosted payment page). Built against
 * the documented N-Genius flow (docs/payment-contract.md): obtain an access
 * token from the service-account API key, create an order, and redirect the
 * payer to `_links.payment.href`. Order state arrives via webhook. Activated
 * when NETWORK_API_KEY + NETWORK_OUTLET_REF are configured.
 */
const BASE = () => process.env.NETWORK_API_BASE ?? "https://api-gateway.ngenius-payments.com";

async function accessToken(): Promise<string> {
  const res = await fetch(`${BASE()}/identity/auth/access-token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${process.env.NETWORK_API_KEY ?? ""}`,
      "Content-Type": "application/vnd.ni-identity.v1+json",
      Accept: "application/vnd.ni-identity.v1+json",
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`N-Genius auth failed (${res.status})`);
  const j = (await res.json()) as { access_token: string };
  return j.access_token;
}

function mapState(state?: string): PaymentEvent["status"] {
  switch ((state ?? "").toUpperCase()) {
    case "CAPTURED":
    case "PURCHASED":
    case "PAID":
      return "PAID";
    case "FAILED":
    case "DECLINED":
      return "FAILED";
    case "REFUNDED":
      return "REFUNDED";
    case "EXPIRED":
      return "EXPIRED";
    default:
      return "PENDING";
  }
}

export const networkPayments: PaymentProviderPort = {
  driver: "network",

  async createPaymentLink(req: PaymentRequest) {
    const token = await accessToken();
    const outlet = process.env.NETWORK_OUTLET_REF ?? "";
    const res = await fetch(`${BASE()}/transactions/outlets/${outlet}/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.ni-payment.v2+json",
        Accept: "application/vnd.ni-payment.v2+json",
      },
      body: JSON.stringify({
        action: "SALE",
        amount: { currencyCode: req.currency, value: req.amountMinor },
        emailAddress: req.customerEmail,
        merchantOrderReference: req.reference,
        merchantAttributes: { redirectUrl: req.returnUrl, skipConfirmationPage: true },
      }),
    });
    if (!res.ok) throw new Error(`N-Genius order failed (${res.status})`);
    const j = (await res.json()) as {
      reference?: string;
      _links?: { payment?: { href?: string }; ["payment-authorization"]?: { href?: string } };
    };
    const paymentUrl = j._links?.payment?.href;
    if (!paymentUrl) throw new Error("N-Genius returned no payment link");
    return { paymentUrl, providerRef: j.reference };
  },

  async getStatus(providerRef): Promise<PaymentEvent | null> {
    const token = await accessToken();
    const outlet = process.env.NETWORK_OUTLET_REF ?? "";
    const res = await fetch(`${BASE()}/transactions/outlets/${outlet}/orders/${providerRef}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.ni-payment.v2+json" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { reference?: string; _embedded?: { payment?: Array<{ state?: string }> } };
    const state = j._embedded?.payment?.[0]?.state;
    return { providerRef, status: mapState(state), at: new Date().toISOString() };
  },

  async parseWebhook(headers, rawBody): Promise<PaymentEvent[]> {
    // Fail-closed: a live gateway MUST have a webhook secret, and the HMAC over
    // the raw body must match. Without this, anyone could POST a forged "PAID".
    const secret = process.env.NETWORK_WEBHOOK_SECRET ?? "";
    if (!secret) throw new Error("NETWORK_WEBHOOK_SECRET is not configured");
    const provided = headers["x-ngenius-signature"] ?? headers["x-webhook-signature"] ?? "";
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Bad webhook signature");

    const j = JSON.parse(rawBody) as { order?: { reference?: string; amount?: { value?: number } }; eventName?: string; state?: string };
    const providerRef = j.order?.reference;
    return [
      {
        providerRef,
        status: mapState(j.state ?? j.eventName),
        amountMinor: j.order?.amount?.value,
        at: new Date().toISOString(),
      },
    ];
  },

  async healthcheck() {
    try {
      await accessToken();
      return { ok: true, detail: "network (n-genius)" };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : "unreachable" };
    }
  },
};
