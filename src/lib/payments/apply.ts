import { randomUUID } from "node:crypto";
import { getRecord, putRecord } from "@/lib/server/store";
import { formatMoney } from "@/lib/domain/money";
import type { Invoice } from "@/lib/domain/types";

/** Apply a received payment to an invoice: update AR status + timeline + notify. */
export async function applyPaymentToInvoice(
  orgId: string,
  invoiceId: string,
  input: { amountMinor: number; method?: string; at?: string },
): Promise<Invoice | null> {
  const invoice = await getRecord<Invoice>(orgId, "invoices", invoiceId);
  if (!invoice) return null;

  const at = input.at ?? new Date().toISOString();
  const total = invoice.totals.taxInclusiveMinor;
  const paid = Math.min(total, (invoice.amountPaidMinor ?? 0) + input.amountMinor);
  const status: Invoice["paymentStatus"] = paid >= total ? "PAID" : "PARTIAL";

  const updated: Invoice = {
    ...invoice,
    amountPaidMinor: paid,
    paymentStatus: status,
    paidAt: status === "PAID" ? at : invoice.paidAt,
    updatedAt: at,
  };
  await putRecord(orgId, "invoices", updated);

  await putRecord(orgId, "invoiceEvents", {
    id: randomUUID(),
    invoiceId,
    type: "payment",
    detail:
      status === "PAID"
        ? `Paid in full — ${formatMoney(input.amountMinor, invoice.currency)} (${input.method ?? "payment"})`
        : `Partial payment — ${formatMoney(input.amountMinor, invoice.currency)} (${input.method ?? "payment"})`,
    actor: "system",
    at,
    tone: "success",
  });

  await putRecord(orgId, "notifications", {
    id: randomUUID(),
    orgId,
    type: "invoice.paid",
    title: status === "PAID" ? `${invoice.number} paid` : `${invoice.number} part-paid`,
    body: `${formatMoney(input.amountMinor, invoice.currency)} received.`,
    href: `/invoices/${invoiceId}`,
    tone: "success",
    createdAt: at,
  });

  return updated;
}
