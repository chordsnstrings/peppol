/**
 * Canonical domain types (a pragmatic projection of the CIM in the build spec §7.1).
 * These are the real shapes persisted and computed on — no fabricated content.
 */

export type Locale = "en" | "ar";

export type DocType = "TAX_INVOICE" | "TAX_CREDIT_NOTE" | "COMMERCIAL_INVOICE";

export type Direction = "OUTBOUND" | "INBOUND";

export type LifecycleStatus =
  | "DRAFT"
  | "READY"
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type ExchangeStatus =
  | "NOT_SENT"
  | "SUBMITTED"
  | "DELIVERED"
  | "REJECTED_BY_C3"
  | "DELIVERY_FAILED"
  | "UNDELIVERABLE_NO_PARTICIPANT";

export type ReportingStatus = "NOT_REPORTED" | "SUBMITTED" | "ACCEPTED" | "REJECTED";

/** Tax profile codes (seeded, system profiles). */
export type TaxProfileCode =
  | "STANDARD_5"
  | "ZERO_EXPORT"
  | "ZERO_OTHER"
  | "EXEMPT"
  | "OUT_OF_SCOPE"
  | "REVERSE_CHARGE";

export interface TaxProfile {
  code: TaxProfileCode;
  label: string;
  categoryCode: string; // PINT AE tax category code
  ratePercent: number; // e.g. 5, 0
  requiresExemptionReason: boolean;
  isTaxable: boolean; // contributes VAT / forces TAX_INVOICE
  hint: string;
}

export interface Address {
  street?: string;
  additional?: string;
  city?: string;
  emirate?: string; // AE emirate code
  poBox?: string;
  country: string; // ISO, default AE
}

export interface Party {
  nameEn: string;
  nameAr?: string;
  trn?: string;
  tin?: string;
  peppolId?: string;
  address?: Address;
  email?: string;
  phone?: string;
}

export interface InvoiceLine {
  id: string;
  lineNo: number;
  description: string;
  qty: number;
  unitCode: string; // UN/ECE Rec 20, default C62 (each)
  unitPriceMinor: number; // exclusive of VAT
  taxProfileCode: TaxProfileCode;
  exemptionReason?: string;
  // computed
  lineNetMinor: number;
  lineVatMinor: number;
  productId?: string;
}

export interface CategoryBreakdown {
  categoryCode: string;
  profileCode: TaxProfileCode;
  ratePercent: number;
  taxableMinor: number;
  vatMinor: number;
}

export interface InvoiceTotals {
  taxExclusiveMinor: number;
  vatMinor: number;
  taxInclusiveMinor: number;
  payableMinor: number;
  perCategory: CategoryBreakdown[];
  vatMinorAED?: number;
  payableMinorAED?: number;
}

export interface FxInfo {
  rateToAED: string;
  source: "CBUAE" | "MANUAL";
  rateDate: string;
}

export interface PrecedingInvoice {
  number: string;
  issueDate?: string;
  invoiceId?: string;
}

/** The persisted invoice record. */
export interface Invoice {
  id: string;
  orgId: string;
  entityId: string;
  direction: Direction;
  docType: DocType;
  number: string;
  issueDate: string;
  supplyDate: string;
  dueDate?: string;
  currency: string;
  fx?: FxInfo;
  customerId?: string;
  buyer: Party;
  seller: Party;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  notes?: string;
  precedingInvoices?: PrecedingInvoice[];
  creditReason?: string;

  lifecycleStatus: LifecycleStatus;
  exchangeStatus: ExchangeStatus;
  reportingStatusC2: ReportingStatus;

  source: "EDITOR" | "INGEST" | "INTEGRATION" | "API";
  compliance: {
    taxableEventDate: string;
    daysRemaining: number;
    breached: boolean;
  };
  lockedAt?: string;
  sentAt?: string;
  deliveredAt?: string;
  reportedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceEvent {
  id: string;
  invoiceId: string;
  type: string;
  detail?: string;
  actor: string;
  at: string;
  tone?: "neutral" | "success" | "warning" | "error";
}

export interface Customer {
  id: string;
  orgId: string;
  entityId: string;
  displayName: string;
  legalNameEn?: string;
  legalNameAr?: string;
  trn?: string;
  tin?: string;
  peppolId?: string;
  participantStatus: "UNKNOWN" | "LOOKUP_OK" | "NOT_ON_NETWORK" | "LOOKUP_FAILED";
  address?: Address;
  emails?: string[];
  phone?: string;
  defaultCurrency?: string;
  paymentTermsDays?: number;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  orgId: string;
  entityId: string;
  nameEn: string;
  nameAr?: string;
  sku?: string;
  unitCode: string;
  unitPriceMinor: number;
  currency: string;
  taxProfileCode: TaxProfileCode;
  createdAt: string;
  updatedAt: string;
}

export interface Entity {
  id: string;
  orgId: string;
  legalNameEn: string;
  legalNameAr?: string;
  tradeLicenseNo?: string;
  trn?: string;
  tin?: string;
  peppolParticipantId?: string;
  vatRegistered: boolean;
  taxGroup: boolean;
  address?: Address;
  email?: string;
  phone?: string;
  defaultCurrency: string;
  logoDataUrl?: string;
  einvoicingStatus: "NOT_ONBOARDED" | "SANDBOX" | "LIVE";
  emaratLinked: boolean;
  numberingPrefix: string;
  numberingSeq: number;
  activationChecklist: {
    detailsComplete: boolean;
    sandboxTestSent: boolean;
    emaratConfirmed: boolean;
    agreementAccepted: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  defaultLocale: Locale;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  id: string;
  orgId: string;
  email: string;
  name: string;
  role: "OWNER" | "ADMIN" | "FINANCE" | "CLERK" | "VIEWER" | "ACCOUNTANT_EXTERNAL";
  status: "ACTIVE" | "INVITED";
  createdAt: string;
}

export interface Connection {
  id: string;
  orgId: string;
  entityId: string;
  provider: "ZOHO_BOOKS" | "QBO" | "XERO" | "ODOO" | "TALLY_FILE";
  status: "CONNECTED" | "EXPIRED" | "REVOKED" | "ERROR" | "PAUSED" | "PENDING";
  mode?: "live" | "mock";
  autoSend: boolean;
  lastSyncAt?: string;
  lastError?: string;
  syncedCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SyncLink {
  id: string; // `${connectionId}:${externalId}`
  orgId: string;
  entityId: string;
  connectionId: string;
  provider: string;
  objectType: "INVOICE" | "CUSTOMER";
  externalId: string;
  internalId: string;
  hash?: string;
  createdAt: string;
}

export type FixitKind =
  | "VALIDATION"
  | "DELIVERY"
  | "REPORTING"
  | "SYNC"
  | "BILLING"
  | "CLOCK"
  | "SYSTEM";

export interface FixitItem {
  id: string;
  orgId: string;
  entityId?: string;
  kind: FixitKind;
  ref?: string; // invoice/upload/connection id
  refLabel?: string;
  severity: "ERROR" | "WARNING" | "INFO";
  title: string;
  body: string;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "DISMISSED";
  createdAt: string;
  resolvedAt?: string;
}

export interface InboundDoc {
  id: string;
  orgId: string;
  entityId: string;
  senderName: string;
  senderParticipantId: string;
  totalMinor: number;
  currency: string;
  status: "VALID" | "HAS_ISSUES";
  buyerAction: "NONE" | "ACKNOWLEDGED" | "EXPORTED" | "DISPUTED";
  receivedAt: string;
  invoice?: Partial<Invoice>;
}

export interface AppNotification {
  id: string;
  orgId: string;
  type: string;
  title: string;
  body?: string;
  href?: string;
  readAt?: string;
  tone?: "neutral" | "success" | "warning" | "error";
  createdAt: string;
}
