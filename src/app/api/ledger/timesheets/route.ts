import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  recordTime, approveTime, writeOffTime, markInvoiced, runWip,
  timesheetRegister, utilisation, type NewTimeEntry, type EntryStatus,
} from "@/lib/server/ledger/timesheets";

export const runtime = "nodejs";

/** The timesheet register with the work in progress it supports, or utilisation. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);

    if (q.get("view") === "utilisation") {
      const from = q.get("from");
      const to = q.get("to");
      if (!from || !to) return json({ error: "Utilisation needs the dates it covers." }, 400);
      return json(ledgerJson(await utilisation({ orgId, entityId, from, to })));
    }

    return json(ledgerJson(await timesheetRegister({
      orgId, entityId,
      asOf: q.get("asOf") ?? undefined,
      status: (q.get("status") as EntryStatus) ?? undefined,
      projectCode: q.get("projectCode") ?? undefined,
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
      action?: "record" | "approve" | "writeOff" | "invoice" | "wip";
      entityId?: string;
      entry?: NewTimeEntry;
      ids?: string[];
      reason?: string;
      invoiceId?: string;
      period?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId: b.entityId };

    switch (b.action) {
      case "record":
        if (!b.entry) return json({ error: "There is no time to record." }, 400);
        return json(ledgerJson({ entry: await recordTime({ ...scope, entry: b.entry }) }));

      case "approve":
        if (!b.ids?.length) return json({ error: "Which entries?" }, 400);
        return json(ledgerJson(await approveTime({ ...scope, ids: b.ids })));

      case "writeOff":
        if (!b.ids?.length) return json({ error: "Which entries?" }, 400);
        return json(ledgerJson(await writeOffTime({ ...scope, ids: b.ids, reason: b.reason ?? "" })));

      case "invoice":
        if (!b.ids?.length || !b.invoiceId) return json({ error: "Which entries, and onto which invoice?" }, 400);
        return json(ledgerJson(await markInvoiced({ ...scope, ids: b.ids, invoiceId: b.invoiceId })));

      case "wip":
        if (!b.period) return json({ error: "A work-in-progress run needs the month." }, 400);
        return json(ledgerJson(await runWip({ ...scope, period: b.period, actorId: userId })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
