import { randomUUID } from "node:crypto";
import { requireWritableSession } from "@/lib/server/org-status";
import { json, handleError } from "@/lib/server/http";
import { getRecord, putRecord } from "@/lib/server/store";
import { prisma } from "@/lib/server/prisma";
import { getWhatsApp } from "@/lib/whatsapp/registry";
import { waConfigId } from "@/lib/whatsapp/port";
import { getPaymentProvider } from "@/lib/payments/registry";
import { outstandingMinor } from "@/lib/domain/ar";
import { formatMoney } from "@/lib/domain/money";
import type { Invoice, WhatsAppConfig } from "@/lib/domain/types";

export const runtime = "nodejs";

/**
 * Send an invoice to the buyer over WhatsApp, through the tenant's own connected
 * number. If the invoice is unpaid a hosted payment link is created and included
 * so the buyer can pay from the chat. Falls back to a plain notice if the buyer
 * has no phone number on file.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { orgId } = await requireWritableSession();
    const body = (await req.json().catch(() => ({}))) as { to?: string };

    const invoice = await getRecord<Invoice>(orgId, "invoices", id);
    if (!invoice) return json({ error: "Invoice not found" }, 404);

    const config = await getRecord<WhatsAppConfig>(orgId, "whatsapp", waConfigId(invoice.entityId));
    if (!config?.connected) {
      return json({ error: "WhatsApp is not connected for this business" }, 409);
    }

    const to = (body.to ?? invoice.buyer.phone ?? "").trim();
    if (!to) return json({ error: "No WhatsApp number for the customer" }, 400);

    const now = new Date().toISOString();
    const origin = new URL(req.url).origin;

    // Create / reuse a payment link when there is a balance outstanding.
    let payUrl = invoice.paymentLinkUrl;
    const outstanding = outstandingMinor(invoice);
    if (invoice.paymentStatus !== "PAID" && outstanding > 0 && !payUrl) {
      const provider = getPaymentProvider();
      const payment = await prisma.payment.create({
        data: { orgId, invoiceId: id, provider: provider.driver, amountMinor: outstanding, currency: invoice.currency, status: "PENDING" },
      });
      const link = await provider.createPaymentLink({
        invoiceId: id,
        reference: invoice.number,
        amountMinor: outstanding,
        currency: invoice.currency,
        description: `Invoice ${invoice.number}`,
        customerName: invoice.buyer.nameEn,
        customerEmail: invoice.buyer.email,
        token: payment.id,
        origin,
        returnUrl: `${origin}/pay/${payment.id}?done=1`,
      });
      await prisma.payment.update({ where: { id: payment.id }, data: { paymentUrl: link.paymentUrl, providerRef: link.providerRef } });
      payUrl = link.paymentUrl;
    }

    const amountLabel = formatMoney(invoice.totals.taxInclusiveMinor, invoice.currency);
    const lines = [
      `${invoice.seller.nameEn || "Your supplier"} — invoice ${invoice.number}`,
      `Amount: ${amountLabel}`,
      invoice.dueDate ? `Due: ${invoice.dueDate}` : "",
      payUrl ? `Pay securely: ${payUrl}` : "",
      "Thank you for your business.",
    ].filter(Boolean);
    const text = lines.join("\n");

    const result = await getWhatsApp().send({ phoneNumberId: config.phoneNumberId }, { to, text });

    const patch: Invoice = { ...invoice, updatedAt: now };
    if (payUrl && !invoice.paymentLinkUrl) patch.paymentLinkUrl = payUrl;
    await putRecord(orgId, "invoices", patch);

    await putRecord(orgId, "invoiceEvents", {
      id: randomUUID(),
      invoiceId: id,
      type: "whatsapp",
      detail: `Sent to ${to} via WhatsApp${payUrl ? " with a payment link" : ""}`,
      actor: "user",
      at: now,
      tone: "success",
    });
    await putRecord(orgId, "notifications", {
      id: randomUUID(),
      orgId,
      type: "invoice.whatsapp",
      title: `${invoice.number} sent on WhatsApp`,
      body: `Delivered to ${to}.`,
      href: `/invoices/${id}`,
      tone: "success",
      createdAt: now,
    });

    return json({ ok: true, to, providerRef: result.providerRef, paymentLinkUrl: payUrl ?? null });
  } catch (e) {
    return handleError(e);
  }
}
