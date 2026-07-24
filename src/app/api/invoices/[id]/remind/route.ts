import { randomUUID } from "node:crypto";
import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { getRecord, putRecord } from "@/lib/server/store";
import type { Invoice } from "@/lib/domain/types";

export const runtime = "nodejs";

/** Send a payment reminder for one invoice (dunning). Email/WhatsApp when configured. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const { orgId } = await requireSession();
    const invoice = await getRecord<Invoice>(orgId, "invoices", id);
    if (!invoice) return json({ error: "Invoice not found" }, 404);

    const at = new Date().toISOString();
    await putRecord(orgId, "invoices", { ...invoice, lastReminderAt: at, updatedAt: at });
    await putRecord(orgId, "invoiceEvents", {
      id: randomUUID(),
      invoiceId: id,
      type: "reminder",
      detail: `Payment reminder sent to ${invoice.buyer.nameEn || "the customer"}`,
      actor: "user",
      at,
      tone: "neutral",
    });
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
