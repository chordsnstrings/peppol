import { describe, it, expect } from "vitest";
import { advanceDate, isDue, cadenceLabel } from "@/lib/domain/recurring";

describe("advanceDate", () => {
  it("advances by cadence, calendar-correct", () => {
    expect(advanceDate("2026-01-15", "WEEKLY")).toBe("2026-01-22");
    expect(advanceDate("2026-01-15", "MONTHLY")).toBe("2026-02-15");
    expect(advanceDate("2026-01-15", "QUARTERLY")).toBe("2026-04-15");
    expect(advanceDate("2026-01-15", "YEARLY")).toBe("2027-01-15");
  });
  it("rolls over year boundaries", () => {
    expect(advanceDate("2026-12-10", "MONTHLY")).toBe("2027-01-10");
  });
});

describe("isDue", () => {
  it("is due on or before today", () => {
    expect(isDue("2000-01-01", "2026-07-24")).toBe(true);
    expect(isDue("2026-07-24", "2026-07-24")).toBe(true);
    expect(isDue("2999-01-01", "2026-07-24")).toBe(false);
  });
});

describe("cadenceLabel", () => {
  it("labels cadences", () => {
    expect(cadenceLabel("MONTHLY")).toBe("Monthly");
    expect(cadenceLabel("QUARTERLY")).toBe("Quarterly");
  });
});
