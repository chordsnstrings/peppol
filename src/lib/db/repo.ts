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
  Product,
} from "@/lib/domain/types";
import { getById, put, remove, touch } from "./database";

/* ---------------- Entity ---------------- */
/* Organizations are created server-side at registration (see /api/auth/register). */

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

/** Build a credit note that references a source invoice (§8.2.2 correction path). */
export function makeCreditNote(entity: Entity, source: Invoice): Invoice {
  const draft = makeDraft(entity);
  draft.docType = "TAX_CREDIT_NOTE";
  draft.buyer = source.buyer;
  draft.customerId = source.customerId;
  draft.currency = source.currency;
  draft.fx = source.fx;
  draft.lines = source.lines.map((l) => ({ ...l, id: id("ln") }));
  draft.precedingInvoices = [
    { number: source.number, issueDate: source.issueDate, invoiceId: source.id },
  ];
  draft.creditReason = "PRICE";
  draft.notes = `Credit note for ${source.number}`;
  return recalc(draft);
}

/** Clone a failed/rejected invoice into a fresh corrected draft. */
export function makeCorrectedCopy(entity: Entity, source: Invoice): Invoice {
  const draft = makeDraft(entity);
  draft.buyer = source.buyer;
  draft.customerId = source.customerId;
  draft.currency = source.currency;
  draft.fx = source.fx;
  draft.lines = source.lines.map((l) => ({ ...l, id: id("ln") }));
  draft.notes = source.notes;
  return recalc(draft);
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
 * Send an invoice through the real server-side pipeline: it validates, generates
 * the PINT AE UBL + Tax Data Document, submits the exchange leg (buyer's ASP) and
 * the reporting leg (TDD to the FTA) via the active gateway (mock or Taxilla),
 * records the transmission, and applies the returned MLS. The mock gateway
 * completes synchronously (sandbox); a live gateway leaves the invoice SENT until
 * its webhook confirms delivery + reporting.
 */
export async function sendInvoice(inv: Invoice, _entity: Entity): Promise<Invoice> {
  // Fast client-side check so blocking issues surface without a round-trip.
  const result = validateInvoice(inv);
  if (!result.canSend) {
    throw Object.assign(new Error("Invoice has blocking errors"), { issues: result.issues });
  }
  const res = await fetch(`/api/invoices/${inv.id}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (res.status === 422) {
    const body = (await res.json().catch(() => ({}))) as { issues?: unknown };
    throw Object.assign(new Error("Invoice has blocking errors"), { issues: body.issues });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Send failed");
  }
  const { invoice } = (await res.json()) as { invoice: Invoice };
  touch("invoices");
  touch("invoiceEvents");
  touch("notifications");
  return invoice;
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
