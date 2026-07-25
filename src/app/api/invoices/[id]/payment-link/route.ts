import { requireWritableSession } from "@/lib/server/org-status";
import { json, handleError } from "@/lib/server/http";
import { getRecord, putRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import { getPaymentProvider } from "@/lib/payments/registry";
import { outstandingMinor } from "@/lib/domain/ar";
import type { Invoice } from "@/lib/domain/types";

export const runtime = "nodejs";

/** Create a hosted payment link for an invoice via the active payment provider. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { orgId } = await requireWritableSession();
    const invoice = await getRecord<Invoice>(orgId, "invoices", id);
    if (!invoice) return json({ error: "Invoice not found" }, 404);
    if (invoice.paymentStatus === "PAID") return json({ error: "Already paid" }, 409);

    const amountMinor = outstandingMinor(invoice) || invoice.totals.taxInclusiveMinor;
    const provider = getPaymentProvider();
    const origin = new URL(req.url).origin;

    const payment = await prisma.payment.create({
      data: { orgId, invoiceId: id, provider: provider.driver, amountMinor, currency: invoice.currency, status: "PENDING" },
    });

    const link = await provider.createPaymentLink({
      invoiceId: id,
      reference: invoice.number,
      amountMinor,
      currency: invoice.currency,
      description: `Invoice ${invoice.number}`,
      customerName: invoice.buyer.nameEn,
      customerEmail: invoice.buyer.email,
      token: payment.id,
      origin,
      returnUrl: `${origin}/pay/${payment.id}?done=1`,
    });

    await prisma.payment.update({
      where: { id: payment.id },
      data: { paymentUrl: link.paymentUrl, providerRef: link.providerRef },
    });
    await putRecord(orgId, "invoices", { ...invoice, paymentLinkUrl: link.paymentUrl, updatedAt: new Date().toISOString() });

    return json({ url: link.paymentUrl, token: payment.id, driver: provider.driver });
  } catch (e) {
    return handleError(e);
  }
}
