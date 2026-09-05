import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { ledgerJson } from "@/lib/server/ledger/serialize";

describe("what crosses the wire", () => {
  it("sends a BigInt as a string, so a large balance cannot lose precision", () => {
    // 9,007,199,254,740,993 is the first integer a double cannot hold.
    expect(ledgerJson(9_007_199_254_740_993n)).toBe("9007199254740993");
    expect(ledgerJson({ minor: -1_050n })).toEqual({ minor: "-1050" });
  });

  it("sends a Decimal as the number a person would read", () => {
    // It used to be walked like any other object, so an exchange rate reached
    // the client as {"s":1,"e":0,"d":[3,6729000]} — the library's own internal
    // representation, which renders as "[object Object]" or NaN wherever it
    // lands. Three columns in this schema are Decimal and every one of them is
    // a figure somebody checks against something.
    expect(ledgerJson(new Prisma.Decimal("3.6729"))).toBe("3.6729");
    expect(ledgerJson({ fxRate: new Prisma.Decimal("0.0000000001") })).toEqual({ fxRate: "1e-10" });
  });

  it("keeps every one of a Decimal(20,10)'s digits", () => {
    // A float cannot hold ten decimal places of a twenty-digit number, which
    // is why this is a string and not a number.
    // A trailing zero is not a digit Decimal keeps, and should not be — it
    // carries no value. So the case is built without one.
    const wide = "1234567890.1234567891";
    expect(ledgerJson(new Prisma.Decimal(wide))).toBe(wide);
    // The same value through a double loses the last two digits.
    expect(Number(wide).toString()).toBe("1234567890.1234567");
  });

  it("sends bytes as base64 rather than as a numbered object", () => {
    // A Buffer walked as an object comes out as {"0":72,"1":105,…}, which is
    // both wrong and very large.
    expect(ledgerJson(Buffer.from("Hi"))).toBe("SGk=");
  });

  it("walks arrays and nested objects", () => {
    expect(ledgerJson({ rows: [{ a: 1n }, { a: 2n }] })).toEqual({ rows: [{ a: "1" }, { a: "2" }] });
  });

  it("leaves null, undefined and the primitives alone", () => {
    expect(ledgerJson(null)).toBeNull();
    expect(ledgerJson(undefined)).toBeUndefined();
    expect(ledgerJson("x")).toBe("x");
    expect(ledgerJson(false)).toBe(false);
    expect(ledgerJson(3)).toBe(3);
  });

  it("sends a Date as an ISO string", () => {
    expect(ledgerJson(new Date("2026-03-10T00:00:00.000Z"))).toBe("2026-03-10T00:00:00.000Z");
  });
});
