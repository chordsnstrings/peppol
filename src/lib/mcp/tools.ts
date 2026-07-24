import { getRecord, listRecords, putRecord } from "@/lib/server/store";
import { buildInvoiceFromApi, type ApiInvoiceInput } from "@/lib/server/invoice-build";
import { runSendPipeline } from "@/lib/server/send";
import { validateInvoice } from "@/lib/domain/validation";
import { usageSummary } from "@/lib/server/billing";
import { TAX_PROFILES } from "@/lib/domain/tax";
import type { Customer, Entity, Invoice } from "@/lib/domain/types";

/**
 * ARKS capabilities exposed as MCP tools. Each handler runs with an authenticated
 * tenant (orgId from the API key), reusing the exact same server logic as the
 * public REST API — so an AI client and a script behave identically.
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (orgId: string, args: Record<string, unknown>) => Promise<unknown>;
}

const TAX_CODES = Object.keys(TAX_PROFILES);

const lineSchema = {
  type: "object",
  properties: {
    description: { type: "string" },
    qty: { type: "number", description: "Quantity" },
    unitPriceMinor: { type: "integer", description: "Unit price in minor units (fils; 1 AED = 100)" },
    taxProfileCode: { type: "string", enum: TAX_CODES, description: "Defaults to STANDARD_5" },
    unitCode: { type: "string", description: "UN/ECE unit code, default C62 (each)" },
  },
  required: ["description", "qty", "unitPriceMinor"],
};

const buyerSchema = {
  type: "object",
  properties: {
    nameEn: { type: "string" },
    nameAr: { type: "string" },
    trn: { type: "string", description: "15-digit UAE tax registration number" },
    peppolId: { type: "string", description: "Peppol participant id, e.g. 0235:100..." },
    email: { type: "string" },
    phone: { type: "string" },
  },
  required: ["nameEn"],
};

function compactInvoice(i: Invoice) {
  return {
    id: i.id,
    number: i.number,
    docType: i.docType,
    status: i.lifecycleStatus,
    exchangeStatus: i.exchangeStatus,
    reportingStatus: i.reportingStatusC2,
    buyer: i.buyer?.nameEn,
    currency: i.currency,
    totalMinor: i.totals?.taxInclusiveMinor,
    paymentStatus: i.paymentStatus,
    issueDate: i.issueDate,
    dueDate: i.dueDate,
  };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_entities",
    description:
      "List the businesses (entities) in this ARKS workspace. Use an entity's id as `entityId` in other tools.",
    inputSchema: { type: "object", properties: {} },
    async handler(orgId) {
      const entities = await listRecords<Entity>(orgId, "entities");
      return entities.map((e) => ({
        id: e.id,
        legalNameEn: e.legalNameEn,
        legalNameAr: e.legalNameAr,
        trn: e.trn,
        defaultCurrency: e.defaultCurrency,
        einvoicingStatus: e.einvoicingStatus,
      }));
    },
  },
  {
    name: "list_customers",
    description: "List customers, optionally scoped to one entity.",
    inputSchema: {
      type: "object",
      properties: { entityId: { type: "string" } },
    },
    async handler(orgId, args) {
      const entityId = typeof args.entityId === "string" ? args.entityId : undefined;
      const customers = await listRecords<Customer>(orgId, "customers", entityId ? { entityId } : undefined);
      return customers.map((c) => ({
        id: c.id,
        displayName: c.displayName,
        trn: c.trn,
        peppolId: c.peppolId,
        participantStatus: c.participantStatus,
        email: c.emails?.[0],
      }));
    },
  },
  {
    name: "list_invoices",
    description:
      "List invoices (compact). Optional filters: entityId, and status (DRAFT, READY, SENT, DELIVERED, COMPLETED, FAILED, CANCELLED).",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        status: { type: "string" },
      },
    },
    async handler(orgId, args) {
      const entityId = typeof args.entityId === "string" ? args.entityId : undefined;
      const status = typeof args.status === "string" ? args.status : undefined;
      let invoices = await listRecords<Invoice>(orgId, "invoices", entityId ? { entityId } : undefined);
      if (status) invoices = invoices.filter((i) => i.lifecycleStatus === status);
      invoices.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      return invoices.slice(0, 100).map(compactInvoice);
    },
  },
  {
    name: "get_invoice",
    description: "Fetch one full invoice by id, including line items, totals, timeline status and payment state.",
    inputSchema: {
      type: "object",
      properties: { invoiceId: { type: "string" } },
      required: ["invoiceId"],
    },
    async handler(orgId, args) {
      const id = String(args.invoiceId ?? "");
      const invoice = await getRecord<Invoice>(orgId, "invoices", id);
      if (!invoice) throw new Error(`Invoice ${id} not found`);
      return invoice;
    },
  },
  {
    name: "validate_invoice",
    description:
      "Validate an invoice payload WITHOUT saving it. Returns whether it can be sent, any blocking/warning issues, computed totals and the derived document type. Use before create_invoice to check for problems.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string" },
        currency: { type: "string" },
        buyer: buyerSchema,
        lines: { type: "array", items: lineSchema },
      },
      required: ["entityId", "lines"],
    },
    async handler(orgId, args) {
      const entity = await getRecord<Entity>(orgId, "entities", String(args.entityId ?? ""));
      if (!entity) throw new Error("Entity not found");
      const invoice = buildInvoiceFromApi(entity, args as unknown as ApiInvoiceInput);
      const r = validateInvoice(invoice);
      return { canSend: r.canSend, issues: r.issues, totals: invoice.totals, docType: invoice.docType };
    },
  },
  {
    name: "create_invoice",
    description:
      "Create a UAE-compliant invoice. Amounts are integer minor units (fils). Totals, VAT per category and document type are computed automatically. Set `send: true` to also transmit it to the FTA/Peppol network (validate first). Returns the created invoice.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "The billing business — see list_entities" },
        number: { type: "string", description: "Invoice number; omit to leave blank for a draft" },
        currency: { type: "string", description: "Defaults to the entity's currency" },
        buyer: buyerSchema,
        lines: { type: "array", items: lineSchema },
        notes: { type: "string" },
        send: { type: "boolean", description: "Transmit after creating" },
      },
      required: ["entityId", "buyer", "lines"],
    },
    async handler(orgId, args) {
      const entity = await getRecord<Entity>(orgId, "entities", String(args.entityId ?? ""));
      if (!entity) throw new Error("Entity not found");
      const invoice = buildInvoiceFromApi(entity, args as unknown as ApiInvoiceInput);
      await putRecord(orgId, "invoices", invoice);
      if (args.send === true) {
        const outcome = await runSendPipeline(orgId, invoice.id);
        if (!outcome.ok) return { invoice, sendError: outcome.error, issues: outcome.issues };
        return { invoice: outcome.invoice, blocked: outcome.blocked };
      }
      return { invoice };
    },
  },
  {
    name: "send_invoice",
    description:
      "Send an existing invoice: validate → generate PINT AE UBL + Tax Data Document → transmit the exchange leg to the buyer and the reporting leg to the FTA. Returns the updated invoice with its new status.",
    inputSchema: {
      type: "object",
      properties: { invoiceId: { type: "string" } },
      required: ["invoiceId"],
    },
    async handler(orgId, args) {
      const outcome = await runSendPipeline(orgId, String(args.invoiceId ?? ""));
      if (!outcome.ok) throw new Error(outcome.error ?? "Send failed");
      return { invoice: outcome.invoice, blocked: outcome.blocked };
    },
  },
  {
    name: "get_usage",
    description:
      "Get this year's billable-exchange usage and plan allowance for an entity (used, included, remaining, overage).",
    inputSchema: {
      type: "object",
      properties: { entityId: { type: "string" } },
      required: ["entityId"],
    },
    async handler(orgId, args) {
      return usageSummary(orgId, String(args.entityId ?? ""));
    },
  },
];

export const MCP_TOOL_BY_NAME = new Map(MCP_TOOLS.map((t) => [t.name, t]));
