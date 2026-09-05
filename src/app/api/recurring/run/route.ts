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
 * Generate invoices for every active recurring template that is due.
 *
 * A template that is behind produces one invoice per missed period, each dated
 * on the period it belongs to.
 *
 * It used to raise exactly one invoice per run and date it today, then advance
 * the next-run date by a single cadence — so a monthly template two months
 * untouched produced one invoice, in the wrong VAT period, and stayed a month
 * behind. Every subsequent run repeated that, and the template never caught up
 * while the return it belonged in was filed without it. This is the same
 * catch-up the ledger's own subscriptions module already does, and for the same
 * reason: a late run should reconstruct exactly what a nightly scheduler would
 * have produced, not a compressed summary of it.
 *
 * The loop is bounded. A template whose next-run date is years in the past —
 * from a bad import, or a clock — would otherwise raise hundreds of invoices
 * and consume hundreds of numbers before anybody saw it. It stops at the cap
 * and says how many are still owed rather than silently doing part of the job.
 */
const MAX_CATCH_UP = 24;

export async function POST() {
  try {
    const { orgId } = await requireWritableSession();
    const templates = await listRecords<RecurringTemplate>(orgId, "recurring");
    const entities = await listRecords<Entity>(orgId, "entities");
    const entityById = new Map(entities.map((e) => [e.id, e]));

    let generated = 0;
    let sent = 0;
    const nowIso = new Date().toISOString();
    /** Templates still behind after the cap, and by how many periods. */
    const stillBehind: { id: string; periods: number }[] = [];

    for (const t of templates) {
      if (!t.active || !isDue(t.nextRunDate)) continue;
      const entity = entityById.get(t.entityId);
      if (!entity) continue;

      let runDate = t.nextRunDate;
      let raised = 0;

      while (isDue(runDate) && raised < MAX_CATCH_UP) {
        // Consume an invoice number and persist the bumped sequence on the entity.
        const seq = (entityById.get(entity.id) ?? entity).numberingSeq + 1;
        const number = nextNumber(entityById.get(entity.id) ?? entity, seq);
        const bumped = { ...(entityById.get(entity.id) ?? entity), numberingSeq: seq, updatedAt: nowIso };
        await putRecord(orgId, "entities", bumped);
        entityById.set(entity.id, bumped);

        const invoice = buildInvoiceFromApi(bumped, {
          // The date the period fell due, not the date somebody happened to run
          // this. An invoice for March raised in May belongs in March's return.
          issueDate: runDate.slice(0, 10),
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
            marginPurchaseMinor: l.marginPurchaseMinor,
          })),
        });
        if (t.customerId) invoice.customerId = t.customerId;
        await putRecord(orgId, "invoices", invoice);
        generated++;
        raised++;

        if (t.autoSend) {
          const outcome = await runSendPipeline(orgId, invoice.id);
          if (outcome.ok && outcome.invoice?.lifecycleStatus !== "DRAFT" && !outcome.blocked) sent++;
        }

        runDate = advanceDate(runDate, t.cadence);

        // Written every time round rather than once at the end: a run that dies
        // halfway must not re-raise what it already raised, and an invoice number
        // consumed is consumed whatever happens next.
        await putRecord(orgId, "recurring", {
          ...t,
          nextRunDate: runDate,
          lastRunAt: nowIso,
          generatedCount: (t.generatedCount ?? 0) + raised,
          updatedAt: nowIso,
        });
      }

      if (isDue(runDate)) {
        // Count what is left rather than guessing at it, so the number in the
        // response is one somebody can act on.
        let behind = 0;
        let probe = runDate;
        while (isDue(probe) && behind < 1000) { behind++; probe = advanceDate(probe, t.cadence); }
        stillBehind.push({ id: t.id, periods: behind });
      }
    }

    return json({
      generated,
      sent,
      ...(stillBehind.length
        ? {
            stillBehind,
            note:
              `${stillBehind.length} template${stillBehind.length === 1 ? " is" : "s are"} still behind after ` +
              `${MAX_CATCH_UP} invoices each. Run this again to continue, or check whether the next-run date is ` +
              `right — a template years in the past is usually an import, not a backlog.`,
          }
        : {}),
    });
  } catch (e) {
    return handleError(e);
  }
}
