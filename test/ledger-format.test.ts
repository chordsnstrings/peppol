import { describe, it, expect } from "vitest";
import { fmtMinor, parseAmount, toInput, exponentOf, toMinor } from "@/lib/ledger/format";

describe("ledger figure formatting", () => {
  it("groups thousands and keeps the currency's minor unit", () => {
    expect(fmtMinor("123456789", "AED")).toBe("1,234,567.89");
    expect(fmtMinor("123456789", "KWD")).toBe("123,456.789"); // 3 decimals
    expect(fmtMinor("1234", "JPY")).toBe("1,234");            // 0 decimals
  });

  it("shows negatives in parentheses, not with a minus", () => {
    expect(fmtMinor("-4500", "AED")).toBe("(45.00)");
    expect(fmtMinor("-4500", "AED", { sign: "minus" })).toBe("-45.00");
  });

  it("renders a zero as an en dash in statements", () => {
    expect(fmtMinor(0n)).toBe("–");
    expect(fmtMinor(0n, "AED", { zero: "zero" })).toBe("0.00");
    expect(fmtMinor(0n, "AED", { zero: "blank" })).toBe("");
  });

  it("pads amounts smaller than one unit", () => {
    expect(fmtMinor("5", "AED", { zero: "zero" })).toBe("0.05");
    expect(fmtMinor("5", "KWD", { zero: "zero" })).toBe("0.005");
  });

  it("survives amounts past 2^53 without losing precision", () => {
    // 90,071,992,547,409.93 AED — one fil past Number.MAX_SAFE_INTEGER.
    expect(fmtMinor("9007199254740993")).toBe("90,071,992,547,409.93");
  });

  it("round-trips through the editable form", () => {
    for (const v of ["0", "1", "99", "100", "-4500", "123456789"]) {
      expect(toMinor(parseAmount(toInput(v), "AED"))).toBe(BigInt(v));
    }
  });

  it("knows the exponent of the Gulf currencies", () => {
    expect(exponentOf("aed")).toBe(2);
    expect(exponentOf("BHD")).toBe(3);
    expect(exponentOf("ZZZ")).toBe(2); // sane default
  });
});

describe("what a bookkeeper types", () => {
  it("takes a plain amount", () => {
    expect(parseAmount("1250.75")).toBe(125075n);
    expect(parseAmount("1,250.75")).toBe(125075n);
    expect(parseAmount("")).toBe(0n);
  });

  it("does the arithmetic so a calculator is not needed", () => {
    expect(parseAmount("1200/3")).toBe(40000n);
    expect(parseAmount("(450+80)*1.05")).toBe(55650n);
    expect(parseAmount("100 + 200 - 50")).toBe(25000n);
    expect(parseAmount("2*3*4")).toBe(2400n);
  });

  it("rounds half up at the minor unit", () => {
    expect(parseAmount("0.005")).toBe(1n);
    expect(parseAmount("100/3")).toBe(3333n);
    expect(parseAmount("0.004")).toBe(0n);
  });

  it("keeps a negative, so a minus typed in Debit can move to Credit", () => {
    expect(parseAmount("-45")).toBe(-4500n);
    expect(parseAmount("-(10+5)")).toBe(-1500n);
  });

  it("reads a parenthesised figure as negative, the way every ledger writes it", () => {
    expect(parseAmount("(2,000.00)")).toBe(-200000n);
    expect(parseAmount("(45)")).toBe(-4500n);
    expect(parseAmount("( 45.50 )")).toBe(-4550n);
    // The round trip has to close: what we print, we must read back.
    expect(parseAmount(fmtMinor(-4500n, "AED"))).toBe(-4500n);
  });

  it("still treats parentheses as grouping when they hold an expression", () => {
    expect(parseAmount("(450+80)*1.05")).toBe(55650n);
    expect(parseAmount("(10+5)")).toBe(1500n);
    expect(parseAmount("(100)/2")).toBe(5000n);
  });

  it("refuses anything that is not an amount instead of silently zeroing", () => {
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("12abc")).toBeNull();
    expect(parseAmount("(1+2")).toBeNull();
    expect(parseAmount("1/0")).toBeNull();
    expect(parseAmount("+")).toBeNull();
  });

  it("cannot be made to execute anything", () => {
    // Every one of these is rejected by the character allowlist before the
    // parser ever sees it — there is no eval() to reach.
    for (const hostile of [
      "process.exit(1)",
      "1;alert(1)",
      "constructor",
      "`${1}`",
      "fetch('/x')",
    ]) {
      expect(parseAmount(hostile)).toBeNull();
    }
  });
});
