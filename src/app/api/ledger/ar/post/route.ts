import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
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
      return json(result);
    }

    // An invoice only reaches the books once it is a real document. A draft can
    // still change, and revenue recognised from something that can still change
    // is revenue that will have to be un-recognised.
    if (invoice.lifecycleStatus === "DRAFT") {
      return json({ error: `Invoice ${invoice.number} is still a draft. Finalise it before posting it to the ledger.` }, 422);
    }

    const result = await postInvoice({ orgId, invoice, actorType: "HUMAN", actorId: userId });
    return json(result);
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
