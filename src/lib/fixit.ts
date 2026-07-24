"use client";

import { validateInvoice } from "@/lib/domain/validation";
import type { FixitItem, Invoice } from "@/lib/domain/types";

/**
 * Fix-it items are DERIVED live from real invoice state — no fabricated content.
 * Every module that can block compliance contributes here (§8.7).
 */
export function deriveFixits(invoices: Invoice[]): FixitItem[] {
  const items: FixitItem[] = [];

  for (const inv of invoices) {
    if (inv.lifecycleStatus === "CANCELLED" || inv.lifecycleStatus === "COMPLETED") continue;

    // Validation errors on drafts/ready invoices
    if (inv.lifecycleStatus === "DRAFT" || inv.lifecycleStatus === "READY") {
      const res = validateInvoice(inv);
      const blocking = res.issues.filter((i) => i.severity === "ERROR");
      if (blocking.length > 0) {
        items.push({
          id: `fx-val-${inv.id}`,
          orgId: inv.orgId,
          entityId: inv.entityId,
          kind: "VALIDATION",
          ref: inv.id,
          refLabel: inv.number || "Untitled draft",
          severity: "ERROR",
          title: `${inv.number || "Draft"} can't be sent yet`,
          body: blocking[0].message + (blocking.length > 1 ? ` (+${blocking.length - 1} more)` : ""),
          status: "OPEN",
          createdAt: inv.updatedAt,
        });
      }
    }

    // Compliance clock (REG-01)
    if (inv.compliance.breached && inv.direction === "OUTBOUND") {
      items.push({
        id: `fx-clock-${inv.id}`,
        orgId: inv.orgId,
        entityId: inv.entityId,
        kind: "CLOCK",
        ref: inv.id,
        refLabel: inv.number || "Draft",
        severity: "WARNING",
        title: `${inv.number || "Draft"} is past the 14-day window`,
        body: "You can still issue it — history is history — but send it soon to stay tidy.",
        status: "OPEN",
        createdAt: inv.updatedAt,
      });
    }

    // Buyer not reachable on the network (REG-07)
    if (inv.exchangeStatus === "UNDELIVERABLE_NO_PARTICIPANT") {
      items.push({
        id: `fx-net-${inv.id}`,
        orgId: inv.orgId,
        entityId: inv.entityId,
        kind: "DELIVERY",
        ref: inv.id,
        refLabel: inv.number,
        severity: "WARNING",
        title: `${inv.buyer.nameEn || "The buyer"} isn't on the network yet`,
        body: "You can't deliver until the buyer appoints a service provider. Re-check their status, or notify them to onboard.",
        status: "OPEN",
        createdAt: inv.updatedAt,
      });
    }

    // Stuck in transit (submitted but no terminal MLS after a while) — live gateway only
    if (
      (inv.lifecycleStatus === "SENT" || inv.lifecycleStatus === "SENDING" || inv.lifecycleStatus === "QUEUED") &&
      inv.sentAt &&
      Date.now() - new Date(inv.sentAt).getTime() > 30 * 60 * 1000
    ) {
      items.push({
        id: `fx-stuck-${inv.id}`,
        orgId: inv.orgId,
        entityId: inv.entityId,
        kind: "SYSTEM",
        ref: inv.id,
        refLabel: inv.number,
        severity: "WARNING",
        title: `${inv.number} is taking longer than expected`,
        body: "No delivery/reporting confirmation yet. We'll keep reconciling — you can also re-check now.",
        status: "OPEN",
        createdAt: inv.updatedAt,
      });
    }

    // Failed sends
    if (inv.lifecycleStatus === "FAILED") {
      items.push({
        id: `fx-fail-${inv.id}`,
        orgId: inv.orgId,
        entityId: inv.entityId,
        kind: "DELIVERY",
        ref: inv.id,
        refLabel: inv.number,
        severity: "ERROR",
        title: `${inv.number} failed to send`,
        body: "The exchange or reporting leg reported a problem. Review and resend as a corrected copy.",
        status: "OPEN",
        createdAt: inv.updatedAt,
      });
    }
  }

  // Most severe + most recent first
  const rank = { ERROR: 0, WARNING: 1, INFO: 2 } as const;
  return items.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || b.createdAt.localeCompare(a.createdAt),
  );
}
