import { json, handleError } from "@/lib/server/http";
import { getRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import type { Invoice } from "@/lib/domain/types";

export const runtime = "nodejs";

/** Public payment-page info (no auth) — minimal details needed to pay. */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const payment = await prisma.payment.findUnique({ where: { id: token } });
    if (!payment) return json({ error: "Not found" }, 404);
    const invoice = await getRecord<Invoice>(payment.orgId, "invoices", payment.invoiceId);
    if (!invoice) return json({ error: "Not found" }, 404);

    return json({
      token,
      driver: payment.provider,
      status: payment.status,
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
