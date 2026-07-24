import { daysBetween, todayISO } from "@/lib/utils";
import type { Invoice } from "./types";

/** Is this invoice a live receivable (sent, not fully paid, not cancelled)? */
export function isReceivable(inv: Invoice): boolean {
  if (inv.direction !== "OUTBOUND") return false;
  if (inv.paymentStatus === "PAID") return false;
  return ["SENT", "DELIVERED", "COMPLETED", "SENDING", "QUEUED"].includes(inv.lifecycleStatus);
}

export type PaymentState = "PAID" | "PARTIAL" | "DUE" | "OVERDUE";

export function paymentState(inv: Invoice): PaymentState {
  if (inv.paymentStatus === "PAID") return "PAID";
  const overdue = inv.dueDate ? daysBetween(inv.dueDate, todayISO()) > 0 : false;
  if (inv.paymentStatus === "PARTIAL") return overdue ? "OVERDUE" : "PARTIAL";
  return overdue ? "OVERDUE" : "DUE";
}

export function outstandingMinor(inv: Invoice): number {
  return Math.max(0, inv.totals.taxInclusiveMinor - (inv.amountPaidMinor ?? 0));
}

export interface AgingBucket {
  key: string;
  label: string;
  count: number;
  amountMinor: number;
}

export interface ArSummary {
  outstandingMinor: number;
  overdueMinor: number;
  paidThisMonthMinor: number;
  dso: number; // days sales outstanding (simple)
  buckets: AgingBucket[];
  receivables: Invoice[];
}

/** Accounts-receivable summary derived from real invoices. */
export function arSummary(invoices: Invoice[]): ArSummary {
  const today = todayISO();
  const receivables = invoices.filter(isReceivable);

  const buckets: AgingBucket[] = [
    { key: "current", label: "Not due", count: 0, amountMinor: 0 },
    { key: "1-30", label: "1–30 days", count: 0, amountMinor: 0 },
    { key: "31-60", label: "31–60 days", count: 0, amountMinor: 0 },
    { key: "61-90", label: "61–90 days", count: 0, amountMinor: 0 },
    { key: "90+", label: "90+ days", count: 0, amountMinor: 0 },
  ];

  let outstanding = 0;
  let overdue = 0;
  for (const inv of receivables) {
    const amt = outstandingMinor(inv);
    outstanding += amt;
    const overdueDays = inv.dueDate ? daysBetween(inv.dueDate, today) : 0;
    let b: AgingBucket;
    if (overdueDays <= 0) b = buckets[0];
    else if (overdueDays <= 30) b = buckets[1];
    else if (overdueDays <= 60) b = buckets[2];
    else if (overdueDays <= 90) b = buckets[3];
    else b = buckets[4];
    b.count++;
    b.amountMinor += amt;
    if (overdueDays > 0) overdue += amt;
  }

  const month = today.slice(0, 7);
  const paidThisMonth = invoices
    .filter((i) => i.paymentStatus === "PAID" && (i.paidAt ?? "").slice(0, 7) === month)
    .reduce((s, i) => s + i.totals.taxInclusiveMinor, 0);

  // Simple DSO: average days-to-pay of paid invoices in the last 90 days.
  const paid = invoices.filter((i) => i.paymentStatus === "PAID" && i.paidAt && i.issueDate);
  const dso =
    paid.length > 0
      ? Math.round(
          paid.reduce((s, i) => s + Math.max(0, daysBetween(i.issueDate, i.paidAt!.slice(0, 10))), 0) /
            paid.length,
        )
      : 0;

  return {
    outstandingMinor: outstanding,
    overdueMinor: overdue,
    paidThisMonthMinor: paidThisMonth,
    dso,
    buckets,
    receivables: receivables.sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "")),
  };
}

/** Invoices that are overdue and due for a dunning reminder (>=N days since last). */
export function remindable(invoices: Invoice[], minDaysBetween = 3): Invoice[] {
  const today = todayISO();
  return invoices.filter((inv) => {
    if (!isReceivable(inv)) return false;
    const overdue = inv.dueDate ? daysBetween(inv.dueDate, today) > 0 : false;
    if (!overdue) return false;
    if (!inv.lastReminderAt) return true;
    return daysBetween(inv.lastReminderAt.slice(0, 10), today) >= minDaysBetween;
  });
}
