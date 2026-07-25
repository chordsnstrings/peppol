import { requireWritableSession } from "@/lib/server/org-status";
import { json, handleError } from "@/lib/server/http";
import { getRecord, listRecords, putRecord } from "@/lib/server/store";
import { buildInvoiceFromApi } from "@/lib/server/invoice-build";
import { runSendPipeline } from "@/lib/server/send";
import { advanceDate, isDue } from "@/lib/domain/recurring";
import type { Entity, Invoice, RecurringTemplate } from "@/lib/domain/types";

export const runtime = "nodejs";

function nextNumber(entity: Entity, seq: number): string {
  return `${entity.numberingPrefix}${new Date().getFullYear()}-${String(seq).padStart(5, "0")}`;
}

/**
 * Generate invoices for every active recurring template that's due. Creates a
 * draft (or sends it when the template is auto-send), then advances the
 * template's next-run date by its cadence. Idempotent-ish: a template only
 * generates once per run, and re-running the same day is a no-op once advanced.
 */
export async function POST() {
  try {
    const { orgId } = await requireWritableSession();
    const templates = await listRecords<RecurringTemplate>(orgId, "recurring");
    const entities = await listRecords<Entity>(orgId, "entities");
    const entityById = new Map(entities.map((e) => [e.id, e]));

    let generated = 0;
    let sent = 0;
    const nowIso = new Date().toISOString();

    for (const t of templates) {
      if (!t.active || !isDue(t.nextRunDate)) continue;
      const entity = entityById.get(t.entityId);
      if (!entity) continue;

      // Consume an invoice number and persist the bumped sequence on the entity.
      const seq = entity.numberingSeq + 1;
      const number = nextNumber(entity, seq);
      const bumped = { ...entity, numberingSeq: seq, updatedAt: nowIso };
      await putRecord(orgId, "entities", bumped);
      entityById.set(entity.id, bumped);

      const invoice = buildInvoiceFromApi(bumped, {
        entityId: entity.id,
        number,
        currency: t.currency,
        buyer: t.buyer,
        notes: t.notes,
        lines: t.lines.map((l) => ({
          description: l.description,
          qty: l.qty,
          unitPriceMinor: l.unitPriceMinor,
          taxProfileCode: l.taxProfileCode,
          unitCode: l.unitCode,
          exemptionReason: l.exemptionReason,
        })),
      });
      if (t.customerId) invoice.customerId = t.customerId;
      await putRecord(orgId, "invoices", invoice);
      generated++;

      if (t.autoSend) {
        const outcome = await runSendPipeline(orgId, invoice.id);
        if (outcome.ok && outcome.invoice?.lifecycleStatus !== "DRAFT" && !outcome.blocked) sent++;
      }

      await putRecord(orgId, "recurring", {
        ...t,
        nextRunDate: advanceDate(t.nextRunDate, t.cadence),
        lastRunAt: nowIso,
        generatedCount: (t.generatedCount ?? 0) + 1,
        updatedAt: nowIso,
      });
    }

    return json({ generated, sent });
  } catch (e) {
    return handleError(e);
  }
}
