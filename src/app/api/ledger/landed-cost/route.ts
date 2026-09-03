import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  createVoucher, applyVoucher, cancelVoucher, voucherDetail, voucherList,
  landedCostReport, recordMeasure, measureList,
  type NewVoucher,
} from "@/lib/server/ledger/landed-cost";

export const runtime = "nodejs";

/** The report, the list of vouchers, one voucher, or what each item weighs. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);

    const view = q.get("view");

    if (view === "voucher") {
      const number = q.get("number");
      if (!number) return json({ error: "Which voucher?" }, 400);
      return json(ledgerJson(await voucherDetail({ orgId, entityId, number })));
    }

    if (view === "measures") {
      return json(ledgerJson(await measureList({ orgId, entityId })));
    }

    if (view === "vouchers") {
      return json(ledgerJson(await voucherList({ orgId, entityId, status: q.get("status") ?? undefined })));
    }

    return json(ledgerJson(await landedCostReport({
      orgId, entityId,
      from: q.get("from") ?? undefined,
      to: q.get("to") ?? undefined,
    })));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "create" | "apply" | "cancel" | "measure";
      entityId?: string;
      voucher?: NewVoucher;
      number?: string;
      reason?: string;
      sku?: string;
      unitWeightMilli?: string | null;
      unitVolumeMilli?: string | null;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId: b.entityId };

    switch (b.action) {
      case "create":
        if (!b.voucher) return json({ error: "There is no voucher to raise." }, 400);
        return json(ledgerJson({ voucher: await createVoucher({ ...scope, voucher: b.voucher }) }));

      case "apply":
        if (!b.number) return json({ error: "Which voucher?" }, 400);
        return json(ledgerJson(await applyVoucher({ ...scope, number: b.number, actorId: userId })));

      case "cancel":
        if (!b.number) return json({ error: "Which voucher?" }, 400);
        return json(ledgerJson({ voucher: await cancelVoucher({ ...scope, number: b.number, reason: b.reason }) }));

      case "measure":
        if (!b.sku) return json({ error: "Which item?" }, 400);
        return json(ledgerJson({
          measure: await recordMeasure({
            ...scope, sku: b.sku,
            unitWeightMilli: b.unitWeightMilli ?? null,
            unitVolumeMilli: b.unitVolumeMilli ?? null,
          }),
        }));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
