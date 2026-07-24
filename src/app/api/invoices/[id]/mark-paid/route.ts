import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import { applyPaymentToInvoice } from "@/lib/payments/apply";
import { outstandingMinor } from "@/lib/domain/ar";
import type { Invoice } from "@/lib/domain/types";

export const runtime = "nodejs";

/** Manually mark an invoice as paid (e.g. received a bank transfer). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { orgId } = await requireSession();
    const { method } = (await req.json().catch(() => ({}))) as { method?: string };
    const invoice = await getRecord<Invoice>(orgId, "invoices", id);
    if (!invoice) return json({ error: "Invoice not found" }, 404);
    const amount = outstandingMinor(invoice);
    if (amount <= 0) return json({ error: "Nothing outstanding" }, 409);

    await prisma.payment.create({
      data: { orgId, invoiceId: id, provider: "manual", amountMinor: amount, currency: invoice.currency, status: "PAID", method: method ?? "BANK_TRANSFER", paidAt: new Date() },
    });
    const updated = await applyPaymentToInvoice(orgId, id, { amountMinor: amount, method: method ?? "Bank transfer" });
    return json({ invoice: updated });
  } catch (e) {
    return handleError(e);
  }
}
