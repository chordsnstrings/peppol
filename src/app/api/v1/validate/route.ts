import { json, handleError } from "@/lib/server/http";
import { authenticateApiKey } from "@/lib/server/api-key";
import { getRecord } from "@/lib/server/store";
import { buildInvoiceFromApi, type ApiInvoiceInput } from "@/lib/server/invoice-build";
import { validateInvoice } from "@/lib/domain/validation";
import type { Entity } from "@/lib/domain/types";

export const runtime = "nodejs";

/** POST /api/v1/validate — validate a payload without persisting anything. */
export async function POST(req: Request) {
  try {
    const { orgId } = await authenticateApiKey(req);
    const body = (await req.json().catch(() => null)) as ApiInvoiceInput | null;
    if (!body?.entityId) return json({ error: "entityId is required" }, 400);

    const entity = await getRecord<Entity>(orgId, "entities", body.entityId);
    if (!entity) return json({ error: "Entity not found" }, 404);

    const invoice = buildInvoiceFromApi(entity, body);
    const result = validateInvoice(invoice);
    return json({
      canSend: result.canSend,
      issues: result.issues,
      totals: invoice.totals,
      docType: invoice.docType,
    });
  } catch (e) {
    return handleError(e);
  }
}
