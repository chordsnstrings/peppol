import { randomUUID } from "node:crypto";
import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { getRecord, putRecord } from "@/lib/server/store";
import { invoiceCreditGate, overrideNarrative } from "@/lib/server/ledger/credit-control";
import type { Invoice, InvoiceEvent } from "@/lib/domain/types";

export const runtime = "nodejs";

/**
 * The credit gate on an invoice, and the finalisation it guards.
 *
 * **Why the check and the transition are one route.** `creditCheck` had exactly
 * one enforcing caller — the sales-order gate — so a business that invoices
 * without raising orders had limits and holds that nothing consulted. Adding a
 * second endpoint that only answers would have left the same hole: a gate the
 * client is trusted to consult before doing the thing anyway is a suggestion.
 * So the draft becomes READY here, on the far side of the check, and there is
 * no path through this route that finalises without it.
 *
 * That is not yet the same as the transition being impossible elsewhere: the
 * document store still accepts a DRAFT ↔ READY write on `POST /api/store/invoices`,
 * because that is how the editor saves. Closing that is a change to the store
 * route, which this one does not own; what this route does own is that the
 * screens go through it.
 *
 * **The invoice is read from the store, never from the body.** A caller that
 * could hand over the amount could hand over a small one and be told the
 * customer is well inside their limit.
 *
 * **The override needs a different pair of hands.** Finalising is `ar.manage`,
 * which the shipped Bookkeeper holds; letting a refusal through is
 * `ar.credit_hold`, which it does not. The person who raised the invoice
 * therefore cannot clear their own credit refusal, which is the whole of the
 * control — and the override goes on the document's own timeline with the
 * limit, the exposure and the grounds in it, because "credit override" with no
 * figures is not something anybody can weigh six months later.
 */

/** The document, or the reason there is nothing to answer about. */
async function load(orgId: string, invoiceId: string | undefined) {
  if (!invoiceId) return { error: json({ error: "Which invoice?" }, 400) } as const;
  const invoice = await getRecord<Invoice>(orgId, "invoices", invoiceId);
  // "No such invoice" and "not your invoice" answer the same, so that nobody
  // can map which ids exist without being allowed to read one.
  if (!invoice) return { error: json({ error: "That invoice does not exist." }, 404) } as const;
  return { invoice } as const;
}

/**
 * Where does this customer stand, if this draft were finalised today?
 *
 * A question, and only a question: it reads the ledger, answers, and writes
 * nothing. The screen asks it while the draft is still open so the salesperson
 * finds out before the customer does.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const loaded = await load(orgId, q.get("invoiceId") ?? undefined);
    if (loaded.error) return loaded.error;
    const invoice = loaded.invoice;

    /* The exposure, the limits and the holds are all read from the sales
     * ledger of the entity the invoice belongs to, so that is the entity the
     * grant has to cover — not one the caller named. */
    await requirePermission({ orgId, userId, entityId: invoice.entityId, permission: "ledger.read" });

    const gate = await invoiceCreditGate({ orgId, entityId: invoice.entityId, invoice });
    return json(ledgerJson({ gate, finalised: invoice.lifecycleStatus !== "DRAFT" }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Finalise the draft: DRAFT → READY, through the gate.
 *
 * A refusal comes back 409 with the whole answer — the limit, what the customer
 * carries now, what this document would take them to, and every ground
 * separately — because a refusal that says only "refused" sends the salesperson
 * to accounts and accounts back to the salesperson, and the second time that
 * happens somebody sends the invoice from a spreadsheet instead.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      invoiceId?: string;
      /** Finalise anyway, on the record, when the check refuses. */
      overrideReason?: string;
    };
    const loaded = await load(orgId, b.invoiceId);
    if (loaded.error) return loaded.error;
    const invoice = loaded.invoice;

    /* Raising a sales document is the sales ledger, the same grant
     * /api/ledger/ar/post asks for to put one on the books, scoped to the
     * entity whose receivables it would land in. */
    await requirePermission({ orgId, userId, entityId: invoice.entityId, permission: "ar.manage" });

    if (invoice.lifecycleStatus === "CANCELLED") {
      return json({ error: `${invoice.number || "This document"} was cancelled, so there is nothing to finalise.` }, 422);
    }
    if (invoice.lifecycleStatus !== "DRAFT") {
      // Idempotent rather than an error: a double-click, or a retry after a
      // dropped response, should find the work done rather than be told off.
      return json(ledgerJson({ alreadyFinalised: true, invoice, gate: null }));
    }

    const reason = (b.overrideReason ?? "").trim();
    const gate = await invoiceCreditGate({
      orgId,
      entityId: invoice.entityId,
      invoice,
      override: reason ? { reason, actorId: userId } : null,
    });

    if (!gate.allowed) {
      return json(ledgerJson({ error: gate.headline, gate }), 409);
    }

    if (gate.overrode) {
      /* Letting a refusal through is the same power as releasing a hold, and
       * deliberately not the power that raised the invoice. Checked here rather
       * than at the top, so somebody who cannot override is refused for the
       * credit reason and told who to ask — not told they may not finalise
       * invoices, which they may. */
      try {
        await requirePermission({ orgId, userId, entityId: invoice.entityId, permission: gate.overridePermission });
      } catch (e) {
        if (!(e instanceof PermissionError)) throw e;
        /* Answered with the gate, not just the permission sentence, so the
         * screen keeps the grounds and the figures in front of the person
         * instead of replacing a credit refusal with an access refusal. The
         * override is stripped back out of it: it was tendered and it did not
         * take, and a payload still claiming `allowed` would be reporting an
         * override that never happened. */
        return json(
          ledgerJson({ error: e.message, gate: { ...gate, allowed: false, overrode: false, override: null } }),
          403,
        );
      }
    }

    const now = new Date().toISOString();
    const event = async (type: string, detail: string, tone: InvoiceEvent["tone"]) => {
      const ev: InvoiceEvent = { id: randomUUID(), invoiceId: invoice.id, type, detail, actor: userId, at: new Date().toISOString(), tone };
      await putRecord(orgId, "invoiceEvents", ev);
    };

    /* The override is written before the transition, so a failure between the
     * two leaves a recorded override and an unfinalised draft rather than a
     * finalised invoice nobody can see was overridden. */
    if (gate.overrode) await event("credit_override", overrideNarrative(gate, userId), "warning");

    /* The totals are not recomputed here. Every write of an invoice goes
     * through `persistInvoice`, which recomputes lines, totals and doc type on
     * the way in, so what is stored is already the recomputed document — and
     * recomputing it on a second path would be a second opinion about the
     * arithmetic on a document that is about to be locked. */
    const finalised: Invoice = { ...invoice, lifecycleStatus: "READY", lockedAt: now, updatedAt: now };
    await putRecord(orgId, "invoices", finalised);

    await event(
      "ready",
      gate.decision === "unknown"
        ? `Marked ready to send. ${gate.headline}`
        : `Marked ready to send. Credit: ${gate.headline}`,
      gate.overrode ? "warning" : "neutral",
    );

    return json(ledgerJson({ alreadyFinalised: false, invoice: finalised, gate }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
