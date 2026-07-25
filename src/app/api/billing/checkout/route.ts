import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { getPaymentProvider } from "@/lib/payments/registry";
import { isSubTier, SUB_BY_TIER } from "@/lib/domain/billing";

export const runtime = "nodejs";

/**
 * Start a self-serve subscription checkout for `tier`. Creates a subscription
 * Payment and returns a hosted payment URL. On PAID (webhook, or the mock
 * /pay complete route) the subscription is activated — no human involved.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId } = await requireSession();
    const body = (await req.json().catch(() => ({}))) as { tier?: string };
    if (!body.tier || !isSubTier(body.tier)) return json({ error: "Unknown plan" }, 400);
    const plan = SUB_BY_TIER[body.tier];

    const provider = getPaymentProvider();
    const origin = new URL(req.url).origin;
    const payment = await prisma.payment.create({
      data: { orgId, kind: "subscription", tier: body.tier, provider: provider.driver, amountMinor: plan.priceMinor, currency: "AED", status: "PENDING" },
    });

    const link = await provider.createPaymentLink({
      invoiceId: payment.id,
      reference: `ARKS-${body.tier}`,
      amountMinor: plan.priceMinor,
      currency: "AED",
      description: `ARKS subscription — ${plan.name}`,
      token: payment.id,
      origin,
      returnUrl: `${origin}/settings/billing?checkout=done`,
    });

    await prisma.payment.update({ where: { id: payment.id }, data: { paymentUrl: link.paymentUrl, providerRef: link.providerRef } });
    return json({ url: link.paymentUrl, token: payment.id, driver: provider.driver });
  } catch (e) {
    return handleError(e);
  }
}
