import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { applyPaymentToInvoice } from "@/lib/payments/apply";
import { applySubscriptionPayment } from "@/lib/server/subscription-apply";

export const runtime = "nodejs";

/**
 * Complete a mock (sandbox) payment from the self-hosted /pay page. Only valid
 * for the mock driver; real providers post to /api/payments/webhook instead.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await ctx.params;
    const { outcome } = (await req.json().catch(() => ({}))) as { outcome?: "success" | "fail" };
    const payment = await prisma.payment.findUnique({ where: { id: token } });
    if (!payment) return json({ error: "Not found" }, 404);
    if (payment.provider !== "mock") return json({ error: "Not a sandbox payment" }, 400);
    if (payment.status === "PAID") return json({ ok: true, status: "PAID" });

    if (outcome === "fail") {
      await prisma.payment.update({ where: { id: token }, data: { status: "FAILED" } });
      return json({ ok: true, status: "FAILED" });
    }

    const at = new Date().toISOString();
    // Atomic flip: only the caller that actually moves the row off a non-PAID
    // status applies the payment, so concurrent duplicate completions can't
    // stack two subscription periods (or double-credit an invoice) for one token.
    const flip = await prisma.payment.updateMany({
      where: { id: token, status: { not: "PAID" } },
      data: { status: "PAID", method: "CARD", paidAt: new Date() },
    });
    if (flip.count === 0) return json({ ok: true, status: "PAID" });
    if (payment.kind === "subscription" && payment.tier) {
      await applySubscriptionPayment(payment.orgId, payment.tier, payment.id);
    } else if (payment.invoiceId) {
      await applyPaymentToInvoice(payment.orgId, payment.invoiceId, { amountMinor: payment.amountMinor, method: "Card (sandbox)", at });
    }
    return json({ ok: true, status: "PAID" });
  } catch (e) {
    return handleError(e);
  }
}
