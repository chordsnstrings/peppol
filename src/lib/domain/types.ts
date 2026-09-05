/**
 * Canonical domain types (a pragmatic projection of the CIM in the build spec §7.1).
 * These are the real shapes persisted and computed on — no fabricated content.
 */

export type Locale = "en" | "ar";

export type DocType = "TAX_INVOICE" | "TAX_CREDIT_NOTE" | "COMMERCIAL_INVOICE" | "PROFORMA";

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

/** Tax profile codes a DOCUMENT line can carry (seeded, system profiles). */
export type TaxProfileCode =
  | "STANDARD_5"
  | "ZERO_EXPORT"
  | "ZERO_OTHER"
  | "EXEMPT"
  | "OUT_OF_SCOPE"
  | "REVERSE_CHARGE"
  | "DESIGNATED_ZONE"
  | "MARGIN_SCHEME";

/**
 * Treatments only a purchase can carry.
 *
 * Import of goods is one of them. Goods brought into the UAE are taxed at
 * import, and Article 48 of Federal Decree-Law 8/2017 puts the tax on the
 * importer rather than on the seller: the importer accounts for the output tax
 * itself and recovers the same amount as input tax, which is what makes boxes
 * 6, 7 and 10 of the VAT 201 the only place the transaction appears. Nothing an
 * entity SELLS is ever an import of its own, so the code is kept out of
 * `TaxProfileCode`: three screens render every member of that union in the tax
 * dropdown of a sales document, and a code that cannot be right on the document
 * it is offered on is a code somebody will eventually pick.
 */
export type PurchaseTaxProfileCode = "IMPORT_GOODS";

/** Every treatment the tax computation knows, whichever side of the book raises it. */
export type AnyTaxProfileCode = TaxProfileCode | PurchaseTaxProfileCode;

export interface TaxProfile {
  code: TaxProfileCode;
  label: string;
  categoryCode: string; // PINT AE tax category code
  ratePercent: number; // e.g. 5, 0
  requiresExemptionReason: boolean;
  isTaxable: boolean; // contributes VAT / forces TAX_INVOICE
  hint: string;
}

/** A profile that may be one of the purchase-only treatments. */
export interface AnyTaxProfile extends Omit<TaxProfile, "code"> {
  code: AnyTaxProfileCode;
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
  /**
   * What the goods on this line cost to buy, for a profit-margin-scheme line.
   *
   * The tax under the scheme is a share of the margin (Article 29 of Federal
   * Decree-Law 8/2017, Article 43 of the Executive Regulation), and the margin
   * is the selling price less this. Without it there is no margin to tax and
   * nothing to compute, which is why it is carried on the line rather than
   * inferred: the purchase price of second-hand goods is a fact about how they
   * were acquired, and no rate table holds it.
   *
   * Ignored on every other treatment.
   */
  marginPurchaseMinor?: number;
  // computed
  lineNetMinor: number;
  lineVatMinor: number;
  productId?: string;
}

/**
 * A line as the tax computation sees it: an invoice line, or a purchase line
 * carrying a treatment only a purchase can carry.
 *
 * Every `InvoiceLine` is one of these, so a caller holding invoice lines needs
 * no change; the widening exists so a bill bearing an import of goods can be
 * totalled by the same arithmetic as everything else rather than by a second
 * copy of it kept somewhere in the purchase ledger.
 */
export type TaxableLine = Omit<InvoiceLine, "taxProfileCode"> & {
  taxProfileCode: AnyTaxProfileCode;
};

export interface CategoryBreakdown {
  categoryCode: string;
  profileCode: AnyTaxProfileCode;
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
  /**
   * The tax total converted to AED, in fils, at the rate the document states.
   *
   * Article 69 of Federal Decree-Law 8/2017 requires the tax on a document
   * issued in another currency to be converted to AED, and Article 59(1)(k) of
   * the Executive Regulation requires the converted amount to appear on the
   * document beside the rate used. Recorded by `computeTotals` when it is given
   * the document's currency and rate; absent on an AED document, and absent
   * where no usable rate has been captured yet, because a nought here would
   * read as a conversion that was made and came to nothing.
   */
  vatMinorAED?: number;
  /** The payable total converted to AED, in fils, at the same rate. */
  payableMinorAED?: number;
  /**
   * The tax inside the margin on profit-margin-scheme lines, which the supplier
   * accounts for and the buyer never sees.
   *
   * It is deliberately not part of `vatMinor` or `payableMinor`. Executive
   * Regulation Article 43 forbids stating a tax amount on a margin-scheme
   * invoice, and the price the buyer pays already contains this tax — adding it
   * to the payable would charge it a second time.
   */
  marginTaxMinor?: number;
  /**
   * How many margin-scheme lines carry no purchase cost, so no margin could be
   * computed and no tax worked out. Reported rather than assumed away: the
   * alternative is a document that quietly claims nil tax on a real margin.
   */
  marginLinesWithoutCostCount?: number;
  /**
   * The tax the importer must account for on goods it brought into the UAE.
   *
   * Not part of `vatMinor` or `payableMinor`, for the same reason reverse
   * charge is not: the overseas supplier charged nothing, so nothing is owed to
   * them. Article 48 of Federal Decree-Law 8/2017 puts the tax on the importer,
   * who declares it as output tax and recovers the same figure as input tax —
   * boxes 6 and 10 of the VAT 201. Adding it to the payable would ask the
   * business to pay its supplier the FTA's money.
   */
  importVatMinor?: number;
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
  // Payment / AR
  paymentStatus?: "UNPAID" | "PARTIAL" | "PAID";
  amountPaidMinor?: number;
  paidAt?: string;
  paymentLinkUrl?: string;
  lastReminderAt?: string;
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
  provider: "ZOHO_BOOKS" | "QBO" | "XERO" | "ODOO" | "TALLY_FILE" | "SHOPIFY" | "WOOCOMMERCE";
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

export type RecurringCadence = "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

/** A template that generates invoices on a schedule. */
export interface RecurringTemplate {
  id: string;
  orgId: string;
  entityId: string;
  name: string;
  customerId?: string;
  buyer: Party;
  currency: string;
  lines: InvoiceLine[];
  notes?: string;
  cadence: RecurringCadence;
  nextRunDate: string; // ISO date (YYYY-MM-DD)
  autoSend: boolean;
  active: boolean;
  lastRunAt?: string;
  generatedCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppConfig {
  id: string; // `wa:<entityId>` — namespaced so it never collides with the entity row
  orgId: string;
  entityId: string;
  connected: boolean;
  displayNumber: string;
  phoneNumberId?: string;
  provider: "mock" | "meta";
  createdAt: string;
  updatedAt: string;
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

/**
 * The recipient's answer to a document a supplier sent them.
 *
 * `transmitted` is the only field here that claims anything about the outside
 * world, and it is false unless a live gateway driver accepted the receipt. A
 * decision a simulator "sent" still records `receiptRef`, exactly as a
 * simulated send records a MOCK- reference against the transmission: the
 * reference is real as an identifier and worthless as evidence, and `simulated`
 * is what says so.
 */
export interface InboundDecision {
  outcome: "ACCEPTED" | "REJECTED";
  /** The recipient's own words. Required for a rejection — it is why. */
  reason?: string;
  decidedAt: string;
  decidedBy: string;
  transmitted: boolean;
  simulated: boolean;
  receiptRef?: string;
  /** What may be said about the transmission, or nothing where it went. */
  note?: string;
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
  /**
   * What the recipient has done about it.
   *
   * REJECTED and DISPUTED are not the same answer and must not share a member.
   * A rejection is final and is sent back over the network: the document is
   * refused, and the supplier's remedy is to issue a corrected one. A dispute
   * is a conversation still open about a document that stands — the quantity is
   * wrong, the purchase order is missing — and it settles in an email, not in a
   * receipt. Recording one as the other misstates whether the supplier is owed
   * an answer or a correction.
   */
  buyerAction: "NONE" | "ACKNOWLEDGED" | "EXPORTED" | "DISPUTED" | "REJECTED";
  receivedAt: string;
  invoice?: Partial<Invoice>;

  /*
   * What the corner-4 receiver writes onto the same record.
   *
   * Every one of them is optional, because a row stored before the receiving
   * half existed carries none of them — and because the screen has to render
   * such a row rather than fail on it. The receiver's own `InboundRecord` makes
   * the four it always writes required; they are declared here so that the
   * inbox, which reads this type, can see what the server actually persisted
   * instead of reaching for the server module to find out.
   */

  /** The gateway's reference for the DELIVERY, not for any transmission of ours. */
  gatewayRef?: string;
  receiverParticipantId?: string;
  docTypeId?: string;
  /** True when the driver that delivered this invents its own outcomes. */
  simulated?: boolean;
  /** One line per failed check; the reason `status` is HAS_ISSUES. */
  issues?: string[];
  /** The document exactly as it arrived — the evidence of what was received. */
  xml?: string;
  xmlSha256?: string;
  /**
   * What this deployment may say about how the document got here, written the
   * moment it arrived and kept on the row. Stored rather than re-derived for
   * the same reason `simulated` travels on the event instead of being worked
   * out later: a deployment that goes live next month must still describe last
   * month's sample as the sample it was, and no screen may hold its own copy of
   * the sentence to drift from.
   */
  note?: string;
  decision?: InboundDecision;
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
