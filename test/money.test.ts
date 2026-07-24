import { describe, it, expect } from "vitest";
import { halfUp, parseMoneyToMinor, minorToMajor, formatMoney } from "@/lib/domain/money";

describe("halfUp", () => {
  it("rounds half up, away from zero", () => {
    expect(halfUp(2.5)).toBe(3);
    expect(halfUp(2.4)).toBe(2);
    expect(halfUp(0.5)).toBe(1);
    expect(halfUp(0.49)).toBe(0);
    expect(halfUp(-2.5)).toBe(-3);
    expect(halfUp(100)).toBe(100);
  });
});

describe("parseMoneyToMinor", () => {
  it("parses formatted strings to integer minor units", () => {
    expect(parseMoneyToMinor("1,234.56")).toBe(123456);
    expect(parseMoneyToMinor("10")).toBe(1000);
    expect(parseMoneyToMinor("0.05")).toBe(5);
    expect(parseMoneyToMinor(12.5)).toBe(1250);
  });
  it("returns 0 for junk", () => {
    expect(parseMoneyToMinor("abc")).toBe(0);
    expect(parseMoneyToMinor("")).toBe(0);
  });
});

describe("minorToMajor / formatMoney", () => {
  it("converts and formats", () => {
    expect(minorToMajor(123456)).toBeCloseTo(1234.56);
    const s = formatMoney(105000, "AED");
    expect(s).toContain("AED");
    expect(s).toContain("1,050.00");
  });
});
