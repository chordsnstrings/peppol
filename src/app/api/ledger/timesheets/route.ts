import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
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
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* A timesheet is operational data, not payroll — so `ledger.read`.
     *
     * The decision was taken deliberately and it is the opposite of the one
     * taken for leave next door. A time entry names who worked, on what, for
     * how many minutes, at a charge-out rate and an optional cost rate, and
     * every one of those arrives on the entry itself: this module never reads
     * the Employee table and never sees a wage. A cost rate is a management
     * figure for valuing work in progress, not a salary — and the charge-out
     * rate is what the client pays, which is the opposite of confidential.
     *
     * Guarding it with `payroll.read` would be a real cost rather than a
     * cautious default. Of the shipped roles only OWNER holds that key, so the
     * accountant who has to value work in progress at the month end and the
     * manager who has to see their own team's week would both be refused, and
     * the register exists precisely to be reconciled against account 1330. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

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
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
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
        /* Recorded time becomes work in progress on account 1330, so keying it
         * writes into the books. `ledger.post` is the closest key; a
         * `timesheet.record` is what I would have wanted, because writing down
         * your own week should not require the power to post a journal by
         * hand. */
        await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });
        if (!b.entry) return json({ error: "There is no time to record." }, 400);
        return json(ledgerJson({ entry: await recordTime({ ...scope, entry: b.entry }) }));

      case "approve":
        /* `expense.approve` was considered and rejected: its effect names
         * approving "a colleague's claim for reimbursement", which is a claim
         * and not a timesheet, and the effect sentence is what the key means.
         * Approved time is what the work-in-progress run will carry, so it
         * takes the same key as recording it. */
        await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });
        if (!b.ids?.length) return json({ error: "Which entries?" }, 400);
        return json(ledgerJson(await approveTime({ ...scope, ids: b.ids })));

      case "writeOff":
        /* A write-off is a decision that work already done will never be
         * billed, and it takes value straight off the balance sheet at the
         * next run. Same key as the rest of the register's writes. */
        await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });
        if (!b.ids?.length) return json({ error: "Which entries?" }, 400);
        return json(ledgerJson(await writeOffTime({ ...scope, ids: b.ids, reason: b.reason ?? "" })));

      case "invoice":
        /* Guarded differently on purpose: putting time onto a customer's
         * invoice is sales-ledger work, and `ar.manage` is "post invoices and
         * receipts, and manage customers". Under the shipped roles the same
         * three people hold it as hold `ledger.post`, so this narrows nothing
         * today — it says which duty the action belongs to, so that a
         * workspace which splits billing out from bookkeeping gets the split
         * it asked for. */
        await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ar.manage" });
        if (!b.ids?.length || !b.invoiceId) return json({ error: "Which entries, and onto which invoice?" }, 400);
        return json(ledgerJson(await markInvoiced({ ...scope, ids: b.ids, invoiceId: b.invoiceId })));

      case "wip":
        /* This one genuinely posts a journal — the movement on 1330 — so
         * `ledger.post` is exact rather than merely closest. */
        await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });
        if (!b.period) return json({ error: "A work-in-progress run needs the month." }, 400);
        return json(ledgerJson(await runWip({ ...scope, period: b.period, actorId: userId })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
