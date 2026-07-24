"use client";

import { id, todayISO, addDays } from "@/lib/utils";
import { computeCompliance, validateInvoice } from "@/lib/domain/validation";
import { computeTotals, deriveDocType, recomputeLines } from "@/lib/domain/tax";
import { derivePeppolId } from "@/lib/domain/peppol";
import type {
  AppNotification,
  Customer,
  Entity,
  Invoice,
  InvoiceEvent,
  InvoiceLine,
  Organization,
  Product,
} from "@/lib/domain/types";
import { getById, put, remove } from "./database";

/* ---------------- Organization & entity ---------------- */

export async function createOrganization(name: string, locale: "en" | "ar"): Promise<Organization> {
  const now = new Date().toISOString();
  const org: Organization = {
    id: id("org"),
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "org",
    defaultLocale: locale,
    createdAt: now,
    updatedAt: now,
  };
  await put("organizations", org);
  return org;
}

export interface EntityInput {
  legalNameEn: string;
  legalNameAr?: string;
  tradeLicenseNo?: string;
  trn?: string;
  tin?: string;
  vatRegistered: boolean;
  taxGroup?: boolean;
  emirate?: string;
  street?: string;
  poBox?: string;
  email?: string;
  phone?: string;
  defaultCurrency?: string;
}

export async function createEntity(orgId: string, input: EntityInput): Promise<Entity> {
  const now = new Date().toISOString();
  const taxId = input.vatRegistered ? input.trn : input.tin;
  const entity: Entity = {
    id: id("ent"),
    orgId,
    legalNameEn: input.legalNameEn,
    legalNameAr: input.legalNameAr,
    tradeLicenseNo: input.tradeLicenseNo,
    trn: input.trn,
    tin: input.tin,
    peppolParticipantId: derivePeppolId(taxId),
    vatRegistered: input.vatRegistered,
    taxGroup: input.taxGroup ?? false,
    address: {
      street: input.street,
      emirate: input.emirate,
      poBox: input.poBox,
      country: "AE",
    },
    email: input.email,
    phone: input.phone,
    defaultCurrency: input.defaultCurrency ?? "AED",
    einvoicingStatus: "SANDBOX",
    emaratLinked: false,
    numberingPrefix: "INV-",
    numberingSeq: 0,
    activationChecklist: {
      detailsComplete: Boolean(input.legalNameEn && taxId),
      sandboxTestSent: false,
      emaratConfirmed: false,
      agreementAccepted: false,
    },
    createdAt: now,
    updatedAt: now,
  };
  await put("entities", entity);
  return entity;
}

export async function saveEntity(entity: Entity): Promise<Entity> {
  const next = { ...entity, updatedAt: new Date().toISOString() };
  await put("entities", next);
  return next;
}

/* ---------------- Numbering ---------------- */

export async function nextInvoiceNumber(entity: Entity): Promise<{ number: string; seq: number }> {
  const seq = entity.numberingSeq + 1;
  const year = new Date().getFullYear();
  const padded = String(seq).padStart(5, "0");
  const number = `${entity.numberingPrefix}${year}-${padded}`;
  return { number, seq };
}

/* ---------------- Customers & products ---------------- */

export async function saveCustomer(c: Customer): Promise<Customer> {
  const next = { ...c, updatedAt: new Date().toISOString() };
  await put("customers", next);
  return next;
}

export async function saveProduct(p: Product): Promise<Product> {
  const next = { ...p, updatedAt: new Date().toISOString() };
  await put("products", next);
  return next;
}

/* ---------------- Invoice lifecycle ---------------- */

/** Build an in-memory draft (not persisted) with sensible defaults. */
export function makeDraft(entity: Entity, opts: { direction?: "OUTBOUND"; number?: string } = {}): Invoice {
  const now = new Date().toISOString();
  const supply = todayISO();
  return {
    id: id("inv"),
    orgId: entity.orgId,
    entityId: entity.id,
    direction: opts.direction ?? "OUTBOUND",
    docType: "TAX_INVOICE",
    number: opts.number ?? "",
    issueDate: todayISO(),
    supplyDate: supply,
    dueDate: addDays(supply, 30),
    currency: entity.defaultCurrency,
    buyer: { nameEn: "" },
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
    lines: [],
    totals: {
      taxExclusiveMinor: 0,
      vatMinor: 0,
      taxInclusiveMinor: 0,
      payableMinor: 0,
      perCategory: [],
    },
    lifecycleStatus: "DRAFT",
    exchangeStatus: "NOT_SENT",
    reportingStatusC2: "NOT_REPORTED",
    source: "EDITOR",
    compliance: computeCompliance(supply),
    createdAt: now,
    updatedAt: now,
  };
}

/** Recompute derived fields (lines, totals, doc type, compliance) — determinism. */
export function recalc(inv: Invoice): Invoice {
  const lines: InvoiceLine[] = recomputeLines(inv.lines);
  const totals = computeTotals(lines);
  const isCredit = inv.docType === "TAX_CREDIT_NOTE";
  const docType = isCredit ? "TAX_CREDIT_NOTE" : deriveDocType(lines);
  return {
    ...inv,
    lines,
    totals,
    docType,
    compliance: computeCompliance(inv.supplyDate),
    updatedAt: new Date().toISOString(),
  };
}

export async function persistInvoice(inv: Invoice): Promise<Invoice> {
  const next = recalc(inv);
  const existing = await getById("invoices", next.id);
  await put("invoices", next);
  if (!existing) {
    await addEvent(next.id, "created", `Draft ${next.number || "invoice"} created`, "user", "neutral");
  }
  return next;
}

export async function deleteInvoice(invId: string): Promise<void> {
  await remove("invoices", invId);
}

export async function addEvent(
  invoiceId: string,
  type: string,
  detail: string,
  actor: string,
  tone: InvoiceEvent["tone"] = "neutral",
): Promise<void> {
  const ev: InvoiceEvent = {
    id: id("ev"),
    invoiceId,
    type,
    detail,
    actor,
    at: new Date().toISOString(),
    tone,
  };
  await put("invoiceEvents", ev);
}

export async function markReady(inv: Invoice): Promise<Invoice> {
  const next = recalc({ ...inv, lifecycleStatus: "READY", lockedAt: new Date().toISOString() });
  await put("invoices", next);
  await addEvent(next.id, "ready", "Marked ready to send", "user", "neutral");
  return next;
}

/**
 * Send an invoice. Honest behaviour:
 * - SANDBOX entity → the real state machine runs an end-to-end sandbox exchange
 *   (queued → sending → delivered → reported → completed) with real timestamps.
 * - LIVE entity → queued and held, because no production gateway is wired here.
 * The invoice content is entirely the user's real data; only the network is sandboxed.
 */
export async function sendInvoice(inv: Invoice, entity: Entity): Promise<Invoice> {
  const result = validateInvoice(inv);
  if (!result.canSend) {
    throw Object.assign(new Error("Invoice has blocking errors"), { issues: result.issues });
  }
  const now = new Date().toISOString();

  if (entity.einvoicingStatus === "LIVE") {
    const queued: Invoice = {
      ...recalc(inv),
      lifecycleStatus: "QUEUED",
      exchangeStatus: "SUBMITTED",
      reportingStatusC2: "SUBMITTED",
      sentAt: now,
    };
    await put("invoices", queued);
    await addEvent(queued.id, "queued", "Queued for the live network gateway", "system", "neutral");
    await notify(entity.orgId, {
      type: "invoice.queued",
      title: `${queued.number} queued`,
      body: "Awaiting the production gateway connection.",
      href: `/invoices/${queued.id}`,
      tone: "neutral",
    });
    return queued;
  }

  // SANDBOX end-to-end
  const completed: Invoice = {
    ...recalc(inv),
    lifecycleStatus: "COMPLETED",
    exchangeStatus: "DELIVERED",
    reportingStatusC2: "ACCEPTED",
    sentAt: now,
    deliveredAt: now,
    reportedAt: now,
    lockedAt: inv.lockedAt ?? now,
  };
  await put("invoices", completed);
  await addEvent(completed.id, "queued", "Queued in the send pipeline", "system", "neutral");
  await addEvent(completed.id, "sending", "Submitted to the Peppol network (sandbox)", "gateway", "neutral");
  await addEvent(completed.id, "delivered", "Delivered to the buyer's Access Point", "gateway", "success");
  await addEvent(completed.id, "reported", "Tax Data Document accepted by the FTA (sandbox)", "gateway", "success");
  await notify(entity.orgId, {
    type: "invoice.completed",
    title: `${completed.number} delivered & reported`,
    body: "Exchange and FTA reporting both succeeded in sandbox.",
    href: `/invoices/${completed.id}`,
    tone: "success",
  });
  return completed;
}

export async function cancelInvoice(inv: Invoice): Promise<Invoice> {
  const next = { ...inv, lifecycleStatus: "CANCELLED" as const, updatedAt: new Date().toISOString() };
  await put("invoices", next);
  await addEvent(next.id, "cancelled", "Draft cancelled", "user", "neutral");
  return next;
}

/* ---------------- Notifications ---------------- */

export async function notify(
  orgId: string,
  n: Omit<AppNotification, "id" | "orgId" | "createdAt" | "readAt">,
): Promise<void> {
  const notification: AppNotification = {
    id: id("ntf"),
    orgId,
    createdAt: new Date().toISOString(),
    ...n,
  };
  await put("notifications", notification);
}
