import { json, handleError } from "@/lib/server/http";
import { getRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import { SUB_BY_TIER, type SubTier } from "@/lib/domain/billing";
import type { Invoice } from "@/lib/domain/types";

export const runtime = "nodejs";

/** Public payment-page info (no auth) — minimal details needed to pay. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const payment = await prisma.payment.findUnique({ where: { id: token } });
    if (!payment) return json({ error: "Not found" }, 404);

    // Subscription checkout — no invoice.
    if (payment.kind === "subscription") {
      const plan = payment.tier && payment.tier in SUB_BY_TIER ? SUB_BY_TIER[payment.tier as SubTier] : null;
      return json({
        token,
        driver: payment.provider,
        status: payment.status,
        kind: "subscription",
        sellerName: "ARKS e-Invoicing",
        invoiceNumber: `ARKS ${plan?.name ?? "subscription"}`,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        buyerName: "Your workspace",
        paidAt: payment.paidAt,
      });
    }

    const invoice = payment.invoiceId ? await getRecord<Invoice>(payment.orgId, "invoices", payment.invoiceId) : null;
    if (!invoice) return json({ error: "Not found" }, 404);

    return json({
      token,
      driver: payment.provider,
      status: payment.status,
      kind: "invoice",
      sellerName: invoice.seller.nameEn,
      invoiceNumber: invoice.number,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      buyerName: invoice.buyer.nameEn,
      paidAt: payment.paidAt,
    });
  } catch (e) {
    return handleError(e);
  }
}
