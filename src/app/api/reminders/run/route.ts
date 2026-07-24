import { randomUUID } from "node:crypto";
import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { listRecords, putRecord } from "@/lib/server/store";
import { remindable } from "@/lib/domain/ar";
import type { Invoice } from "@/lib/domain/types";

export const runtime = "nodejs";

/**
 * Run the dunning cycle: send reminders for every overdue, unpaid invoice due
 * for one. Idempotent (respects lastReminderAt). Trigger from the UI now; a
 * worker would call this on a schedule in production.
 */
export async function POST() {
  try {
    const { orgId } = await requireSession();
    const invoices = await listRecords<Invoice>(orgId, "invoices");
    const due = remindable(invoices);
    const at = new Date().toISOString();

    for (const inv of due) {
      await putRecord(orgId, "invoices", { ...inv, lastReminderAt: at, updatedAt: at });
      await putRecord(orgId, "invoiceEvents", {
        id: randomUUID(),
        invoiceId: inv.id,
        type: "reminder",
        detail: `Automated payment reminder sent to ${inv.buyer.nameEn || "the customer"}`,
        actor: "system",
        at,
        tone: "neutral",
      });
    }
    if (due.length > 0) {
      await putRecord(orgId, "notifications", {
        id: randomUUID(),
        orgId,
        type: "reminders.sent",
        title: `${due.length} payment reminder${due.length === 1 ? "" : "s"} sent`,
        body: "Overdue invoices were chased automatically.",
        href: "/payments",
        tone: "neutral",
        createdAt: at,
      });
    }
    return json({ sent: due.length });
  } catch (e) {
    return handleError(e);
  }
}
