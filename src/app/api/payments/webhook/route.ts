import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { getPaymentProvider } from "@/lib/payments/registry";
import { applyPaymentToInvoice } from "@/lib/payments/apply";
import { isFirstDelivery } from "@/lib/server/webhook-dedup";

export const runtime = "nodejs";

/** Payment provider callback (Network/noqodi). Verified by the driver's signature. */
export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const headers = Object.fromEntries(req.headers.entries());
    const provider = getPaymentProvider();

    let events;
    try {
      events = await provider.parseWebhook(headers, rawBody);
    } catch {
      return json({ error: "Invalid signature" }, 401);
    }

    // Replay protection: process a given signed body at most once.
    if (!(await isFirstDelivery(`payments:${provider.driver}`, rawBody))) {
      return json({ ok: true, deduped: true });
    }

    for (const e of events) {
      const payment = e.providerRef
        ? await prisma.payment.findFirst({ where: { providerRef: e.providerRef } })
        : e.token
          ? await prisma.payment.findUnique({ where: { id: e.token } })
          : null;
      if (!payment || payment.status === "PAID") continue;

      const status = e.status === "PAID" ? "PAID" : e.status;
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status, method: e.method, paidAt: e.status === "PAID" ? new Date() : null },
      });
      if (e.status === "PAID") {
        await applyPaymentToInvoice(payment.orgId, payment.invoiceId, {
          amountMinor: e.amountMinor ?? payment.amountMinor,
          method: e.method ?? provider.driver,
          at: e.at,
        });
      }
    }
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
