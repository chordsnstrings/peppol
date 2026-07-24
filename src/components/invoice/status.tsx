"use client";

import { StatusBadge } from "@/components/ui/badge";
import { DOC_TYPE_LABEL } from "@/lib/domain/tax";
import { EXCHANGE_META, LIFECYCLE_META, REPORTING_META } from "@/lib/domain/status";
import type { Invoice } from "@/lib/domain/types";

export function InvoiceStatus({ invoice, size = "md" }: { invoice: Invoice; size?: "sm" | "md" }) {
  const meta = LIFECYCLE_META[invoice.lifecycleStatus];
  return (
    <StatusBadge
      label={meta.label}
      tone={meta.tone}
      size={size}
      pulse={invoice.lifecycleStatus === "SENDING" || invoice.lifecycleStatus === "QUEUED"}
    />
  );
}

const PAY_TONE: Record<string, { tone: "success" | "warning" | "error" | "neutral"; label: string }> = {
  PAID: { tone: "success", label: "Paid" },
  PARTIAL: { tone: "warning", label: "Part-paid" },
  DUE: { tone: "neutral", label: "Awaiting payment" },
  OVERDUE: { tone: "error", label: "Overdue" },
};

export function PaymentBadge({ invoice, size = "md" }: { invoice: Invoice; size?: "sm" | "md" }) {
  // Only meaningful once an outbound invoice has been sent.
  if (invoice.direction !== "OUTBOUND") return null;
  const sent = ["SENT", "DELIVERED", "COMPLETED", "SENDING", "QUEUED"].includes(invoice.lifecycleStatus);
  if (!sent && invoice.paymentStatus !== "PAID") return null;
  const state = paymentStateOf(invoice);
  const m = PAY_TONE[state];
  return <StatusBadge label={m.label} tone={m.tone} size={size} />;
}

function paymentStateOf(inv: Invoice): "PAID" | "PARTIAL" | "DUE" | "OVERDUE" {
  if (inv.paymentStatus === "PAID") return "PAID";
  const overdue = inv.dueDate ? new Date(inv.dueDate) < new Date(new Date().toISOString().slice(0, 10)) : false;
  if (inv.paymentStatus === "PARTIAL") return overdue ? "OVERDUE" : "PARTIAL";
  return overdue ? "OVERDUE" : "DUE";
}

export function DocTypeChip({ invoice }: { invoice: Invoice }) {
  return (
    <span className="text-xs font-medium text-muted-foreground">
      {DOC_TYPE_LABEL[invoice.docType]}
    </span>
  );
}

export { EXCHANGE_META, REPORTING_META, LIFECYCLE_META };
