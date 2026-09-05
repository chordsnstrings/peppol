import type { Invoice } from "@/lib/domain/types";
import type { GatewayEvent } from "./port";

/**
 * Apply gateway MLS events to an invoice's two status dimensions (exchange leg +
 * C2 reporting leg) and derive the headline lifecycle status (spec §7.2). Pure.
 *
 * A simulated event advances the same dimensions as a real one, deliberately: a
 * rehearsal is only worth running if it runs the whole way, and stopping the
 * status short would leave a sandbox user unable to see what a completed send
 * looks like. What must not be simulated is what the product SAYS — so the
 * `simulated` flag is carried into the narratives below and into every line
 * built on them, rather than into the status itself.
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

/**
 * Human-readable timeline lines for a batch of events.
 *
 * A simulated outcome is named as one in the FIRST word, not softened with a
 * trailing "(sandbox)". A reader scanning a timeline takes the leading verb and
 * the tone colour; a qualifier at the end of the line is read last or not at
 * all, which is how the product came to have one honest string and four
 * confident ones. A simulated outcome is never toned as a success either — an
 * acceptance nobody sent is not good news, and a rejection nobody sent is not
 * bad news, so both are warnings.
 */
export function eventNarratives(events: GatewayEvent[]): { detail: string; tone: "success" | "warning" | "error" | "neutral" }[] {
  return events.map((e) => {
    const simulated = e.simulated === true;
    if (e.kind === "EXCHANGE_MLS") {
      if (e.status === "ACCEPTED") {
        return simulated
          ? { detail: "Simulated delivery to the buyer's Access Point — nothing was transmitted", tone: "warning" as const }
          : { detail: "Delivered to the buyer's Access Point", tone: "success" as const };
      }
      const code = e.code ? ` (${e.code})` : "";
      return simulated
        ? { detail: `Simulated rejection by the buyer's provider${code} — no provider saw this document`, tone: "warning" as const }
        : { detail: `Rejected by the buyer's provider${code}`, tone: "error" as const };
    }
    if (e.kind === "REPORTING_MLS") {
      if (e.status === "ACCEPTED") {
        return simulated
          ? { detail: `Simulated FTA acceptance of the Tax Data Document (${e.leg}) — nothing was reported`, tone: "warning" as const }
          : { detail: `Tax Data Document accepted by the FTA (${e.leg})`, tone: "success" as const };
      }
      const code = e.code ? ` (${e.code})` : "";
      return simulated
        ? { detail: `Simulated FTA rejection of the report${code} — the FTA never saw it`, tone: "warning" as const }
        : { detail: `FTA rejected the report${code}`, tone: "error" as const };
    }
    return simulated
      ? { detail: `Simulated delivery failure: ${e.reason}`, tone: "warning" as const }
      : { detail: `Delivery failed: ${e.reason}`, tone: "error" as const };
  });
}
