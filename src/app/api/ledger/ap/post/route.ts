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
    /* Posting a bill or a supplier payment. */
    await requirePermission({ orgId, userId, permission: "ap.manage" });
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
