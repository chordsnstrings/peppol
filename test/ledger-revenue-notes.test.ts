import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { contractBalancesNote, remainingObligations } from "@/lib/server/ledger/revenue";
import { LedgerError } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-rn";
const ENT = "t-ent-rn";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$executeRawUnsafe(`DELETE FROM "PerformanceObligation" WHERE "orgId" = '${ORG}'`);
  await db.$executeRawUnsafe(`DELETE FROM "RevenueContract" WHERE "orgId" = '${ORG}'`);
}

async function contract(code: string, price: bigint, obligations: {
  seq: number; allocated: bigint; recognised: bigint; timing?: string;
}[], status = "active") {
  const c = await db.revenueContract.create({
    data: {
      orgId: ORG, entityId: ENT, code, customerName: `Customer ${code}`,
      priceMinor: price, billedMinor: 0n, signedOn: new Date("2026-01-01"), status,
    },
  });
  for (const o of obligations) {
    await db.performanceObligation.create({
      data: {
        orgId: ORG, contractId: c.id, seq: o.seq, description: `Obligation ${o.seq}`,
        standalonePriceMinor: o.allocated, allocatedMinor: o.allocated,
        recognisedMinor: o.recognised, timing: o.timing ?? "POINT_IN_TIME",
      },
    });
  }
  return c;
}

d("what is still owed to the customer — IFRS 15.120", () => {
  beforeAll(async () => {
    await wipe();
    // 100,000 allocated across two obligations, 30,000 recognised.
    await contract("C-1", 10_000_000n, [
      { seq: 1, allocated: 6_000_000n, recognised: 3_000_000n, timing: "OVER_TIME" },
      { seq: 2, allocated: 4_000_000n, recognised: 0n },
    ]);
    // Fully delivered: nothing remains, so it does not appear at all.
    await contract("C-DONE", 1_000_000n, [{ seq: 1, allocated: 1_000_000n, recognised: 1_000_000n }]);
    // Cancelled: nothing is owed to a customer whose contract has ended.
    await contract("C-CANCELLED", 5_000_000n, [{ seq: 1, allocated: 5_000_000n, recognised: 0n }], "cancelled");
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("totals what has been allocated and not yet recognised", async () => {
    const r = await remainingObligations(S);
    // 10,000,000 allocated less 3,000,000 recognised on the live contract.
    expect(r.totalMinor).toBe(7_000_000n);
    expect(r.contracts.map((c) => c.code)).toEqual(["C-1"]);
  });

  it("leaves out a contract with nothing left, and one that was cancelled", async () => {
    const r = await remainingObligations(S);
    expect(r.contracts.some((c) => c.code === "C-DONE")).toBe(false);
    // Nothing is owed to a customer whose contract has ended.
    expect(r.contracts.some((c) => c.code === "C-CANCELLED")).toBe(false);
  });

  it("lists only the obligations that still have something in them", async () => {
    const r = await remainingObligations(S);
    const c = r.contracts[0];
    expect(c.obligations.map((o) => o.seq)).toEqual([1, 2]);
    expect(c.obligations[0].remainingMinor).toBe(3_000_000n);
    expect(c.obligations[1].remainingMinor).toBe(4_000_000n);
  });

  it("splits by how it will be recognised, because nothing records when", async () => {
    const r = await remainingObligations(S);
    // A contract with any over-time obligation left is over time.
    expect(r.byTiming).toHaveLength(1);
    expect(r.byTiming[0].timing).toBe("OVER_TIME");
    expect(r.byTiming[0].totalMinor).toBe(7_000_000n);
  });

  it("says plainly what it cannot derive", async () => {
    const r = await remainingObligations(S);
    expect(r.basis).toBe("IFRS 15.120");
    expect(r.notDerivable.join(" ")).toContain("expected completion date");
    expect(r.notDerivable.join(" ")).toContain("measured at today");
  });

  it("cannot be given a negative remainder, because the database refuses one", async () => {
    // The clamp in the module is belt and braces; this is the belt. Recognising
    // more than was allocated is refused by a CHECK constraint, so a negative
    // remainder cannot reach the note to net off an obligation that genuinely
    // is outstanding.
    await expect(contract("C-OVER", 1_000_000n, [
      { seq: 1, allocated: 100_000n, recognised: 900_000n },
    ])).rejects.toThrow();
    const r = await remainingObligations(S);
    expect(r.contracts.every((c) => c.remainingMinor >= 0n)).toBe(true);
  });
});

d("the contract balances note — IFRS 15.116-118", () => {
  afterAll(async () => { await db.$disconnect(); });

  it("refuses a period that ends before it starts", async () => {
    await expect(contractBalancesNote({ ...S, from: "2026-12-31", to: "2026-01-01" }))
      .rejects.toThrow(LedgerError);
  });

  it("reads the balances from the ledger, so it can be drawn at a date", async () => {
    const n = await contractBalancesNote({ ...S, from: "2026-01-01", to: "2026-12-31" });
    // No postings in this fixture, so every figure is nil — and that is the
    // point: it came from the ledger rather than from the contract rows, which
    // do carry figures.
    expect(n.openingAssetMinor).toBe(0n);
    expect(n.closingAssetMinor).toBe(0n);
    expect(n.assetMovementMinor).toBe(0n);
    expect(n.basis).toContain("IFRS 15.116");
  });

  it("names the split it cannot make", async () => {
    const n = await contractBalancesNote({ ...S, from: "2026-01-01", to: "2026-12-31" });
    expect(n.notDerivable.join(" ")).toContain("corrects to a target");
    expect(n.notDerivable.join(" ")).toContain("15.118");
  });
});
