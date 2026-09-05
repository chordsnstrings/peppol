import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { postBill, postSupplierPayment } from "@/lib/server/ledger/ap";
import { LedgerError } from "@/lib/server/ledger/post";
import type { Invoice } from "@/lib/domain/types";

export const runtime = "nodejs";

/** Post a supplier bill, or a payment against one. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      billId?: string;
      kind?: "bill" | "payment";
      paymentId?: string;
      paidOn?: string;
      bankAmountMinor?: number;
      clearedAmountMinor?: number;
      bankAccount?: string;
      /** { lineId: accountCode } — how the bill has been coded. */
      coding?: Record<string, string>;
    };
    if (!b.billId) return json({ error: "Which bill?" }, 400);

    const row = await prisma.record.findUnique({ where: { store_id: { store: "invoices", id: b.billId } } });
    if (!row || row.orgId !== orgId) return json({ error: "That bill does not exist." }, 404);
    const bill = JSON.parse(row.data) as Invoice;

    /* Posting a bill or a supplier payment.
     *
     * Checked after the bill is loaded, because until then there is no entity
     * to check against: the request names a bill id and nothing else, and the
     * books the posting lands in are the ones on the bill. Reading the entity
     * off the document rather than off the request is the same rule the
     * reversal route follows — a caller who could name the entity could name
     * one they hold `ap.manage` on and post into another.
     *
     * The 404 above stays above this on purpose. If the permission were
     * checked first, a bill somebody may not touch and a bill that does not
     * exist would answer differently, and the difference would tell an
     * outsider which bill ids are real. */
    await requirePermission({ orgId, userId, entityId: bill.entityId, permission: "ap.manage" });

    if (b.kind === "payment") {
      if (!b.paymentId || b.bankAmountMinor === undefined) {
        return json({ error: "A payment needs a reference and an amount." }, 400);
      }
      return json(await postSupplierPayment({
        orgId, entityId: bill.entityId, billId: bill.id, billNumber: bill.number,
        paymentId: b.paymentId, paidOn: b.paidOn ?? new Date(),
        bankAmountMinor: b.bankAmountMinor, clearedAmountMinor: b.clearedAmountMinor,
        bankAccount: b.bankAccount, actorType: "HUMAN", actorId: userId,
      }));
    }

    const coding = b.coding ?? {};
    return json(await postBill({
      orgId, bill,
      accountFor: (line) => coding[line.id],
      actorType: "HUMAN", actorId: userId,
    }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
