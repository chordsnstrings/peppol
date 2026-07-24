import { describe, it, expect } from "vitest";
import { includedFor, isPlanCode, MANDATE_FREE_FLOOR, PLAN_BY_CODE } from "@/lib/domain/billing";

describe("billing plans", () => {
  it("includes the mandate floor for the free plan", () => {
    expect(includedFor("FREE_MANDATE")).toBe(MANDATE_FREE_FLOOR);
  });
  it("scales the allowance for paid plans", () => {
    expect(includedFor("GROWTH")).toBe(2400);
    expect(includedFor("SCALE")).toBe(12000);
  });
  it("never drops below the mandate floor", () => {
    expect(includedFor("STARTER")).toBeGreaterThanOrEqual(MANDATE_FREE_FLOOR);
  });
  it("validates plan codes", () => {
    expect(isPlanCode("GROWTH")).toBe(true);
    expect(isPlanCode("bogus")).toBe(false);
  });
  it("exposes prices in minor units", () => {
    expect(PLAN_BY_CODE.FREE_MANDATE.priceMinor).toBe(0);
    expect(PLAN_BY_CODE.GROWTH.priceMinor).toBeGreaterThan(0);
  });
});
