import { json, handleError } from "@/lib/server/http";
import { authenticateApiKey } from "@/lib/server/api-key";
import { getRecord, listRecords, putRecord } from "@/lib/server/store";
import { buildInvoiceFromApi, type ApiInvoiceInput } from "@/lib/server/invoice-build";
import { runSendPipeline } from "@/lib/server/send";
import type { Entity, Invoice } from "@/lib/domain/types";

export const runtime = "nodejs";

/** GET /api/v1/invoices — list invoices (optionally ?entityId=, ?status=). */
export async function GET(req: Request) {
  try {
    const { orgId } = await authenticateApiKey(req);
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    let invoices = await listRecords<Invoice>(orgId, "invoices", entityId ? { entityId } : undefined);
    if (status) invoices = invoices.filter((i) => i.lifecycleStatus === status);
    return json({ invoices });
  } catch (e) {
    return handleError(e);
  }
}

/**
 * POST /api/v1/invoices — create an invoice from a JSON payload. Pass
 * `"send": true` to also run the send pipeline (validate → UBL+TDD → gateway).
 */
export async function POST(req: Request) {
  try {
    const { orgId } = await authenticateApiKey(req);
    const body = (await req.json().catch(() => null)) as (ApiInvoiceInput & { send?: boolean }) | null;
    if (!body?.entityId) return json({ error: "entityId is required" }, 400);

    const entity = await getRecord<Entity>(orgId, "entities", body.entityId);
    if (!entity) return json({ error: "Entity not found" }, 404);

    const invoice = buildInvoiceFromApi(entity, body);
    await putRecord(orgId, "invoices", invoice);

    if (body.send) {
      const outcome = await runSendPipeline(orgId, invoice.id);
      if (!outcome.ok) return json({ invoice, sendError: outcome.error, issues: outcome.issues }, outcome.status);
      return json({ invoice: outcome.invoice, blocked: outcome.blocked }, 201);
    }
    return json({ invoice }, 201);
  } catch (e) {
    return handleError(e);
  }
}
