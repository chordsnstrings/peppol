import type { Invoice } from "@/lib/domain/types";
import type { GatewayEvent } from "./port";

/**
 * Apply gateway MLS events to an invoice's two status dimensions (exchange leg +
 * C2 reporting leg) and derive the headline lifecycle status (spec §7.2). Pure.
 */
export function applyGatewayEvents(inv: Invoice, events: GatewayEvent[]): Invoice {
  const next: Invoice = { ...inv };

  for (const e of events) {
    if (e.kind === "EXCHANGE_MLS") {
      next.exchangeStatus = e.status === "ACCEPTED" ? "DELIVERED" : "REJECTED_BY_C3";
      if (e.status === "ACCEPTED") next.deliveredAt = e.at;
    } else if (e.kind === "REPORTING_MLS" && e.leg === "C2") {
      next.reportingStatusC2 = e.status === "ACCEPTED" ? "ACCEPTED" : "REJECTED";
      if (e.status === "ACCEPTED") next.reportedAt = e.at;
    } else if (e.kind === "DELIVERY_FAILED") {
      next.exchangeStatus = "DELIVERY_FAILED";
    }
  }

  const exchangeOk = next.exchangeStatus === "DELIVERED";
  const reportOk = next.reportingStatusC2 === "ACCEPTED";
  const rejected =
    next.exchangeStatus === "REJECTED_BY_C3" ||
    next.exchangeStatus === "DELIVERY_FAILED" ||
    next.reportingStatusC2 === "REJECTED";

  if (rejected) next.lifecycleStatus = "FAILED";
  else if (exchangeOk && reportOk) next.lifecycleStatus = "COMPLETED";
  else next.lifecycleStatus = "SENT";

  next.updatedAt = new Date().toISOString();
  return next;
}

/** Human-readable timeline lines for a batch of events. */
export function eventNarratives(events: GatewayEvent[]): { detail: string; tone: "success" | "error" | "neutral" }[] {
  return events.map((e) => {
    if (e.kind === "EXCHANGE_MLS") {
      return e.status === "ACCEPTED"
        ? { detail: "Delivered to the buyer's Access Point", tone: "success" as const }
        : { detail: `Rejected by the buyer's provider${e.code ? ` (${e.code})` : ""}`, tone: "error" as const };
    }
    if (e.kind === "REPORTING_MLS") {
      return e.status === "ACCEPTED"
        ? { detail: `Tax Data Document accepted by the FTA (${e.leg})`, tone: "success" as const }
        : { detail: `FTA rejected the report${e.code ? ` (${e.code})` : ""}`, tone: "error" as const };
    }
    return { detail: `Delivery failed: ${e.reason}`, tone: "error" as const };
  });
}
