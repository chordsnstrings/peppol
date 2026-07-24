import { computeTotals, recomputeLines } from "@/lib/domain/tax";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

export function line(partial: Partial<InvoiceLine> = {}): InvoiceLine {
  return {
    id: uid("ln"),
    lineNo: partial.lineNo ?? 1,
    description: partial.description ?? "Service",
    qty: partial.qty ?? 1,
    unitCode: partial.unitCode ?? "C62",
    unitPriceMinor: partial.unitPriceMinor ?? 50000,
    taxProfileCode: (partial.taxProfileCode ?? "STANDARD_5") as TaxProfileCode,
    exemptionReason: partial.exemptionReason,
    lineNetMinor: 0,
    lineVatMinor: 0,
  };
}

/** Build a fully-formed invoice; totals are computed from the given lines. */
export function invoice(partial: Partial<Invoice> = {}): Invoice {
  const lines = recomputeLines(partial.lines ?? [line()]);
  const now = "2026-07-01T00:00:00.000Z";
  return {
    id: partial.id ?? uid("inv"),
    orgId: partial.orgId ?? "org-1",
    entityId: partial.entityId ?? "ent-1",
    direction: partial.direction ?? "OUTBOUND",
    docType: partial.docType ?? "TAX_INVOICE",
    number: partial.number ?? "INV2026-00001",
    issueDate: partial.issueDate ?? "2026-07-01",
    supplyDate: partial.supplyDate ?? "2026-07-01",
    dueDate: partial.dueDate,
    currency: partial.currency ?? "AED",
    fx: partial.fx,
    customerId: partial.customerId,
    buyer: partial.buyer ?? { nameEn: "Buyer FZE" },
    seller: partial.seller ?? { nameEn: "Seller LLC", trn: "100123456700003" },
    lines,
    totals: partial.totals ?? computeTotals(lines),
    notes: partial.notes,
    lifecycleStatus: partial.lifecycleStatus ?? "DRAFT",
    exchangeStatus: partial.exchangeStatus ?? "NOT_SENT",
    reportingStatusC2: partial.reportingStatusC2 ?? "NOT_REPORTED",
    source: partial.source ?? "EDITOR",
    compliance: partial.compliance ?? { taxableEventDate: "2026-07-01", daysRemaining: 10, breached: false },
    paymentStatus: partial.paymentStatus,
    amountPaidMinor: partial.amountPaidMinor,
    paidAt: partial.paidAt,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}
