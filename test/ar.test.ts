import { describe, it, expect } from "vitest";
import { outstandingMinor, isReceivable, paymentState, arSummary } from "@/lib/domain/ar";
import { invoice } from "./helpers";

describe("outstandingMinor", () => {
  it("is total minus paid, floored at zero", () => {
    const inv = invoice({ amountPaidMinor: 40000 }); // total 52500 (1 line 50000 + 5% vat)
    expect(outstandingMinor(inv)).toBe(inv.totals.taxInclusiveMinor - 40000);
    expect(outstandingMinor(invoice({ amountPaidMinor: 999999 }))).toBe(0);
  });
});

describe("isReceivable", () => {
  it("only for sent, unpaid, outbound invoices", () => {
    expect(isReceivable(invoice({ lifecycleStatus: "SENT" }))).toBe(true);
    expect(isReceivable(invoice({ lifecycleStatus: "DRAFT" }))).toBe(false);
    expect(isReceivable(invoice({ lifecycleStatus: "SENT", paymentStatus: "PAID" }))).toBe(false);
    expect(isReceivable(invoice({ lifecycleStatus: "SENT", direction: "INBOUND" }))).toBe(false);
  });
});

describe("paymentState", () => {
  it("marks past-due invoices overdue", () => {
    expect(paymentState(invoice({ paymentStatus: "PAID" }))).toBe("PAID");
    expect(paymentState(invoice({ dueDate: "2000-01-01" }))).toBe("OVERDUE");
    expect(paymentState(invoice({ dueDate: "2999-01-01" }))).toBe("DUE");
  });
});

describe("arSummary", () => {
  it("sums outstanding across receivables and buckets the overdue ones", () => {
    const s = arSummary([
      invoice({ lifecycleStatus: "SENT", dueDate: "2000-01-01" }), // long overdue
      invoice({ lifecycleStatus: "SENT", dueDate: "2999-01-01" }), // not due
      invoice({ lifecycleStatus: "DRAFT" }), // not a receivable
    ]);
    expect(s.receivables).toHaveLength(2);
    expect(s.outstandingMinor).toBeGreaterThan(0);
    expect(s.overdueMinor).toBeGreaterThan(0);
    // the 90+ bucket should have caught the long-overdue one
    expect(s.buckets.find((b) => b.key === "90+")!.count).toBe(1);
    expect(s.buckets.find((b) => b.key === "current")!.count).toBe(1);
  });
});
