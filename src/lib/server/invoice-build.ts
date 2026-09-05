import { randomUUID } from "node:crypto";
import { convertMinorAtRate } from "@/lib/domain/money";
import { recomputeLines, computeTotals, deriveDocType, TAX_PROFILES } from "@/lib/domain/tax";
import { computeCompliance } from "@/lib/domain/validation";
import type { Address, Entity, FxInfo, Invoice, InvoiceLine, Party, TaxProfileCode } from "@/lib/domain/types";

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
  /**
   * The rate this document converts to AED at, for an invoice raised in any
   * other currency.
   *
   * There was no field for it, so an invoice raised through this API in a
   * foreign currency could never state the AED tax that Article 69 of Federal
   * Decree-Law 8/2017 and Article 59(1)(k) of the Executive Regulation both
   * require — however complete the rest of the payload was, the one particular
   * that makes a foreign-currency tax invoice valid had no way in.
   */
  fx?: FxInfo;
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
 * The rate the payload states, as the document will carry it.
 *
 * The body reaches this module as unchecked JSON — the route hands it straight
 * over, which is why `validProfile` and the `Math.round(Number(...))` below
 * exist — so the rate is read the same defensive way. Anything that is not a
 * positive decimal is dropped rather than repaired: `convertMinorAtRate` will
 * not convert at one, so an invoice carrying it would look like it states a
 * conversion while stating none, and `validateInvoice` asks for a usable rate
 * before the document can be sent.
 *
 * `source` is recorded as CBUAE only where the caller says so. It is a claim
 * about where the rate came from and this API cannot check it, so anything else
 * — including nothing — is the manual entry the printed invoice will call it.
 * The date falls back to the supply date because Article 69 fixes the
 * conversion at the date of supply, so a rate sent without one is a rate for
 * that day.
 */
function readFx(fx: FxInfo | undefined, supplyDate: string): FxInfo | undefined {
  if (!fx) return undefined;
  const raw = fx as Partial<FxInfo> & { rateToAED?: string | number };
  const rateToAED = typeof raw.rateToAED === "number" ? String(raw.rateToAED) : (raw.rateToAED ?? "").trim();
  if (convertMinorAtRate(0, rateToAED) === undefined) return undefined;
  return {
    rateToAED,
    source: raw.source === "CBUAE" ? "CBUAE" : "MANUAL",
    rateDate: (raw.rateDate ?? "").trim() || supplyDate,
  };
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
  const currency = input.currency || entity.defaultCurrency;
  const fx = readFx(input.fx, supplyDate);
  const totals = computeTotals(lines, { currency, fx });
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
    currency,
    ...(fx ? { fx } : {}),
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
