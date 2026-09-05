import { describe, it, expect } from "vitest";
import { clientIp } from "@/lib/server/rate-limit";

const req = (headers: Record<string, string>) => new Request("https://x.test/", { headers });

describe("which address the limiter counts against", () => {
  it("takes the entry the trusted proxy wrote, not the one the client did", () => {
    // X-Forwarded-For is appended to by each hop, so the client's own claim is
    // on the LEFT and the proxy's observation is on the RIGHT. Reading the
    // left-most entry — which this used to do — lets anybody rotate their own
    // bucket with a header, which is to say turn the limiter off.
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("is not fooled by a client supplying several fake hops", () => {
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 8.8.8.8, 7.7.7.7, 203.0.113.9" })))
      .toBe("203.0.113.9");
  });

  it("takes the only entry when there is one", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("falls back to x-real-ip, which a proxy writes rather than appends to", () => {
    expect(clientIp(req({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("returns a single shared bucket when there is nothing trustworthy", () => {
    // Every anonymous caller then shares one bucket, throttling them
    // collectively rather than letting them all through. A limiter that fails
    // open is not a limiter.
    expect(clientIp(req({}))).toBe("unknown");
  });

  it("ignores empty entries a proxy may leave behind", () => {
    expect(clientIp(req({ "x-forwarded-for": " , 203.0.113.9" }))).toBe("203.0.113.9");
  });
});
