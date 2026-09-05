import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { prisma } from "@/lib/server/prisma";
import { postInvoice, postReceipt } from "@/lib/server/ledger/ar";
import { LedgerError } from "@/lib/server/ledger/post";
import type { Invoice } from "@/lib/domain/types";

export const runtime = "nodejs";

/**
 * Post an invoice, or a receipt against one, to the general ledger.
 *
 * The invoice is read from the document store by id rather than accepted from
 * the request body. A client that could hand us the amounts could book revenue
 * that never appeared on any document.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      invoiceId?: string;
      kind?: "invoice" | "receipt";
      paymentId?: string;
      receivedOn?: string;
      bankAmountMinor?: number;
      clearedAmountMinor?: number;
      bankAccount?: string;
    };
    if (!b.invoiceId) return json({ error: "Which invoice?" }, 400);

    const row = await prisma.record.findUnique({
      where: { store_id: { store: "invoices", id: b.invoiceId } },
    });
    if (!row || row.orgId !== orgId) return json({ error: "That invoice does not exist." }, 404);
    const invoice = JSON.parse(row.data) as Invoice;

    /* Putting an invoice or a receipt into the books is the sales ledger, and
     * it is the mirror of the guard on /api/ledger/ap/post.
     *
     * Checked after the invoice is loaded, for the reason the file already
     * gives for reading the invoice from the store instead of the body: the
     * document is the authority, not the caller. The entity on it is the
     * entity the revenue lands in, so it is the one the grant has to cover.
     *
     * The 404 above stays above this. Answering "no such invoice" and "not
     * your invoice" differently would let somebody map which invoice ids
     * exist without ever being allowed to see one. */
    await requirePermission({ orgId, userId, entityId: invoice.entityId, permission: "ar.manage" });

    if (b.kind === "receipt") {
      if (!b.paymentId || b.bankAmountMinor === undefined) {
        return json({ error: "A receipt needs a payment reference and an amount." }, 400);
      }
      const result = await postReceipt({
        orgId,
        entityId: invoice.entityId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        paymentId: b.paymentId,
        receivedOn: b.receivedOn ?? new Date(),
        bankAmountMinor: b.bankAmountMinor,
        clearedAmountMinor: b.clearedAmountMinor,
        bankAccount: b.bankAccount,
        actorType: "HUMAN",
        actorId: userId,
      });
      // Through `ledgerJson`, like every other ledger route. The receipt result
      // carries BigInts — a minor-unit amount is a BigInt everywhere in this
      // ledger — and `JSON.stringify` throws on one, so posting a customer
      // receipt answered 500 with "Something went wrong. Please try again."
      // and the money had already moved.
      return json(ledgerJson(result));
    }

    // An invoice only reaches the books once it is a real document. A draft can
    // still change, and revenue recognised from something that can still change
    // is revenue that will have to be un-recognised.
    if (invoice.lifecycleStatus === "DRAFT") {
      return json({ error: `Invoice ${invoice.number} is still a draft. Finalise it before posting it to the ledger.` }, 422);
    }

    const result = await postInvoice({ orgId, invoice, actorType: "HUMAN", actorId: userId });
    return json(ledgerJson(result));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
