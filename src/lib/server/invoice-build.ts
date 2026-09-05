import { randomUUID } from "node:crypto";
import { recomputeLines, computeTotals, deriveDocType, TAX_PROFILES } from "@/lib/domain/tax";
import { computeCompliance } from "@/lib/domain/validation";
import type { Address, Entity, Invoice, InvoiceLine, Party, TaxProfileCode } from "@/lib/domain/types";

export interface ApiLineInput {
  description?: string;
  qty?: number;
  unitPriceMinor?: number;
  taxProfileCode?: string;
  unitCode?: string;
  exemptionReason?: string;
  /**
   * What the item cost, for a margin-scheme line. Article 29 taxes the margin,
   * so without this the tax cannot be worked out at all — and it was dropped
   * here, which meant an invoice raised through the API or by a recurring
   * template lost the one figure the scheme needs even when the caller sent it.
   */
  marginPurchaseMinor?: number;
}

export interface ApiInvoiceInput {
  entityId: string;
  number?: string;
  currency?: string;
  issueDate?: string;
  supplyDate?: string;
  dueDate?: string;
  buyer?: Partial<Party> & { nameEn?: string };
  lines?: ApiLineInput[];
  notes?: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}
function validProfile(code: string | undefined): TaxProfileCode {
  return code && code in TAX_PROFILES ? (code as TaxProfileCode) : "STANDARD_5";
}

/**
 * Build a persistable Invoice from a public-API payload, reusing the same pure
 * domain math as the editor (recomputeLines → computeTotals → deriveDocType).
 * Returns a DRAFT; the caller decides whether to also run the send pipeline.
 */
export function buildInvoiceFromApi(entity: Entity, input: ApiInvoiceInput): Invoice {
  const nowIso = new Date().toISOString();
  const issueDate = input.issueDate || isoDate(new Date());
  const supplyDate = input.supplyDate || issueDate;
  const dueDate = input.dueDate || addDays(supplyDate, 30);

  const rawLines: InvoiceLine[] = (input.lines ?? []).map((l, i) => ({
    id: randomUUID(),
    lineNo: i + 1,
    description: (l.description ?? "").trim(),
    qty: Number(l.qty ?? 1),
    unitCode: l.unitCode || "C62",
    unitPriceMinor: Math.round(Number(l.unitPriceMinor ?? 0)),
    taxProfileCode: validProfile(l.taxProfileCode),
    exemptionReason: l.exemptionReason,
    marginPurchaseMinor:
      l.marginPurchaseMinor === undefined || l.marginPurchaseMinor === null
        ? undefined
        : Math.round(Number(l.marginPurchaseMinor)),
    lineNetMinor: 0,
    lineVatMinor: 0,
  }));

  const lines = recomputeLines(rawLines);
  const totals = computeTotals(lines);
  const docType = deriveDocType(lines);

  const buyerAddress = input.buyer?.address as Address | undefined;
  const buyer: Party = {
    nameEn: input.buyer?.nameEn ?? "",
    nameAr: input.buyer?.nameAr,
    trn: input.buyer?.trn,
    tin: input.buyer?.tin,
    peppolId: input.buyer?.peppolId,
    email: input.buyer?.email,
    phone: input.buyer?.phone,
    address: buyerAddress,
  };

  return {
    id: `inv_${randomUUID()}`,
    orgId: entity.orgId,
    entityId: entity.id,
    direction: "OUTBOUND",
    docType,
    number: input.number ?? "",
    issueDate,
    supplyDate,
    dueDate,
    currency: input.currency || entity.defaultCurrency,
    buyer,
    seller: {
      nameEn: entity.legalNameEn,
      nameAr: entity.legalNameAr,
      trn: entity.trn,
      tin: entity.tin,
      peppolId: entity.peppolParticipantId,
      address: entity.address,
      email: entity.email,
      phone: entity.phone,
    },
    lines,
    totals,
    notes: input.notes,
    lifecycleStatus: "DRAFT",
    exchangeStatus: "NOT_SENT",
    reportingStatusC2: "NOT_REPORTED",
    source: "API",
    compliance: computeCompliance(supplyDate),
    paymentStatus: "UNPAID",
    amountPaidMinor: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}
