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

export function DocTypeChip({ invoice }: { invoice: Invoice }) {
  return (
    <span className="text-xs font-medium text-muted-foreground">
      {DOC_TYPE_LABEL[invoice.docType]}
    </span>
  );
}

export { EXCHANGE_META, REPORTING_META, LIFECYCLE_META };
