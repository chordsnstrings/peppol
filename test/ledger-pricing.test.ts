import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createPriceList, setPrices, closePrice, assignPriceList, unassignPriceList,
  resolvePrice, quoteLines, priceVariance, priceListRegister, partyKeyOf,
} from "@/lib/server/ledger/pricing";
import { LedgerError } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-pl";
const ENT = "t-ent-pl";
const OTHER = "t-org-pl-2";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  for (const org of [ORG, OTHER]) {
    await db.$executeRawUnsafe(`DELETE FROM "PriceListAssignment" WHERE "orgId" = '${org}'`);
    await db.$executeRawUnsafe(`DELETE FROM "PriceListEntry" WHERE "orgId" = '${org}'`);
    await db.$executeRawUnsafe(`DELETE FROM "PriceList" WHERE "orgId" = '${org}'`);
  }
}

/** The standard list every test starts from: a base price and a break at 100. */
async function seedDefault() {
  await createPriceList({
    ...S,
    list: { code: "LIST", name: "Standard list", validFrom: "2026-01-01", isDefault: true },
  });
  await setPrices({
    ...S, listCode: "LIST",
    prices: [
      { itemCode: "WIDGET", unitPriceMinor: 10_000n },                              // 100.00
      { itemCode: "WIDGET", unitPriceMinor: 9_000n, minQuantityMilli: 100_000n },   //  90.00 from 100
      { itemCode: "BOLT", unitPriceMinor: 250n },                                   //   2.50
    ],
  });
}

d("price list codes and windows", () => {
  beforeAll(wipe);
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("refuses a code that is not a code", async () => {
    await expect(createPriceList({ ...S, list: { code: "trade list", name: "x", validFrom: "2026-01-01" } }))
      .rejects.toThrow(/not a price-list code/);
  });

  it("refuses a list that ends before it starts", async () => {
    await expect(createPriceList({
      ...S, list: { code: "BACKWARDS", name: "x", validFrom: "2026-06-01", validTo: "2026-01-01" },
    })).rejects.toThrow(/ends before it starts/);
  });

  it("refuses a second list with the same code", async () => {
    await createPriceList({ ...S, list: { code: "TWICE", name: "First", validFrom: "2026-01-01" } });
    await expect(createPriceList({ ...S, list: { code: "TWICE", name: "Second", validFrom: "2026-01-01" } }))
      .rejects.toThrow(/already a price list TWICE/);
  });

  it("refuses two defaults in force at once", async () => {
    await createPriceList({ ...S, list: { code: "D1", name: "First default", validFrom: "2026-01-01", isDefault: true } });
    await expect(createPriceList({
      ...S, list: { code: "D2", name: "Second default", validFrom: "2026-06-01", isDefault: true },
    })).rejects.toThrow(/already a default/);
  });

  it("allows a default that starts the day the old one ended", async () => {
    // Half-open ranges: a list ending on the 31st and one starting on the 1st
    // do not overlap, which is how anybody would describe them in words.
    await db.$executeRawUnsafe(`UPDATE "PriceList" SET "validTo" = DATE '2026-05-31' WHERE "orgId" = '${ORG}' AND "code" = 'D1'`);
    await expect(createPriceList({
      ...S, list: { code: "D3", name: "Successor", validFrom: "2026-06-01", isDefault: true },
    })).resolves.toBeTruthy();
  });

  it("does not treat a buy list as clashing with a sell list", async () => {
    await expect(createPriceList({
      ...S, list: { code: "BUYLIST", name: "Supplier prices", kind: "BUY", validFrom: "2026-01-01", isDefault: true },
    })).resolves.toBeTruthy();
  });
});

d("setting prices", () => {
  beforeAll(async () => { await wipe(); await seedDefault(); });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("refuses a negative price", async () => {
    await expect(setPrices({ ...S, listCode: "LIST", prices: [{ itemCode: "X", unitPriceMinor: -1n }] }))
      .rejects.toThrow(/negative price is a credit/);
  });

  it("refuses a discount above a hundred per cent", async () => {
    await expect(setPrices({ ...S, listCode: "LIST", prices: [{ itemCode: "X", unitPriceMinor: 100n, discountBps: 10_001 }] }))
      .rejects.toThrow(/outside nought and a hundred/);
  });

  it("refuses a price that starts before the list does", async () => {
    await expect(setPrices({
      ...S, listCode: "LIST", prices: [{ itemCode: "X", unitPriceMinor: 100n, validFrom: "2025-12-31" }],
    })).rejects.toThrow(/before the list itself does/);
  });

  it("refuses a price overlapping one already there", async () => {
    // WIDGET at break 0 is already open-ended from 2026-01-01.
    await expect(setPrices({
      ...S, listCode: "LIST", prices: [{ itemCode: "WIDGET", unitPriceMinor: 11_000n, validFrom: "2026-07-01" }],
    })).rejects.toThrow(/overlaps one already on LIST/);
  });

  it("takes the new price once the old one is closed", async () => {
    const rows = await db.priceListEntry.findMany({ where: { orgId: ORG, itemCode: "WIDGET", minQuantityMilli: 0n } });
    expect(rows).toHaveLength(1);
    await closePrice({ ...S, entryId: rows[0].id, validTo: "2026-06-30" });
    await expect(setPrices({
      ...S, listCode: "LIST", prices: [{ itemCode: "WIDGET", unitPriceMinor: 11_000n, validFrom: "2026-07-01" }],
    })).resolves.toMatchObject({ added: 1 });
  });

  it("prices the old and the new period from the same list", async () => {
    const before = await resolvePrice({ ...S, itemCode: "WIDGET", on: "2026-03-01" });
    const after = await resolvePrice({ ...S, itemCode: "WIDGET", on: "2026-08-01" });
    expect(before.unitPriceMinor).toBe(10_000n);
    expect(after.unitPriceMinor).toBe(11_000n);
  });

  it("refuses to end a price before it starts", async () => {
    const row = await db.priceListEntry.findFirst({ where: { orgId: ORG, itemCode: "BOLT" } });
    await expect(closePrice({ ...S, entryId: row!.id, validTo: "2025-01-01" }))
      .rejects.toThrow(/cannot end before it starts/);
  });
});

d("resolving a price", () => {
  beforeAll(async () => { await wipe(); await seedDefault(); });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("takes the base price below the break", async () => {
    const q = await resolvePrice({ ...S, itemCode: "WIDGET", quantityMilli: 10_000n, on: "2026-03-01" });
    expect(q.found).toBe(true);
    expect(q.unitPriceMinor).toBe(10_000n);
    // Ten at 100.00 is 1,000.00.
    expect(q.netMinor).toBe(100_000n);
    expect(q.source?.minQuantityMilli).toBe(0n);
    expect(q.why).toContain("The default list LIST");
  });

  it("takes the break at exactly the break quantity", async () => {
    const q = await resolvePrice({ ...S, itemCode: "WIDGET", quantityMilli: 100_000n, on: "2026-03-01" });
    expect(q.unitPriceMinor).toBe(9_000n);
    // A hundred at 90.00 is 9,000.00.
    expect(q.netMinor).toBe(900_000n);
    expect(q.why).toContain("at the break from 100 units");
  });

  it("takes the highest break the quantity reaches, not the first row found", async () => {
    await setPrices({
      ...S, listCode: "LIST",
      prices: [{ itemCode: "WIDGET", unitPriceMinor: 8_000n, minQuantityMilli: 500_000n }],
    });
    const q = await resolvePrice({ ...S, itemCode: "WIDGET", quantityMilli: 500_000n, on: "2026-03-01" });
    expect(q.unitPriceMinor).toBe(8_000n);
    const mid = await resolvePrice({ ...S, itemCode: "WIDGET", quantityMilli: 499_000n, on: "2026-03-01" });
    expect(mid.unitPriceMinor).toBe(9_000n);
  });

  it("says nothing was found rather than guessing, for an item off the list", async () => {
    const q = await resolvePrice({ ...S, itemCode: "NOTHING", on: "2026-03-01" });
    expect(q.found).toBe(false);
    expect(q.netMinor).toBe(0n);
    expect(q.why).toContain("Neither LIST prices NOTHING");
  });

  it("does not fall back to a base price that does not exist", async () => {
    await createPriceList({ ...S, list: { code: "BREAKONLY", name: "Bulk only", validFrom: "2026-01-01" } });
    await setPrices({
      ...S, listCode: "BREAKONLY",
      prices: [{ itemCode: "PALLET", unitPriceMinor: 5_000n, minQuantityMilli: 20_000n }],
    });
    await assignPriceList({ ...S, partyKey: "BULKCO", listCode: "BREAKONLY" });
    const q = await resolvePrice({ ...S, itemCode: "PALLET", quantityMilli: 5_000n, partyKey: "BULKCO", on: "2026-03-01" });
    expect(q.found).toBe(false);
    expect(q.why).toContain("only from 20 units");
  });

  it("applies a discount the list carries, rounding once", async () => {
    await createPriceList({ ...S, list: { code: "TENOFF", name: "Ten per cent off", validFrom: "2026-01-01" } });
    await setPrices({
      ...S, listCode: "TENOFF",
      prices: [{ itemCode: "ODD", unitPriceMinor: 333n, discountBps: 1_000 }],
    });
    await assignPriceList({ ...S, partyKey: "DISCOUNTCO", listCode: "TENOFF" });
    // Three at 3.33 less 10% is 8.991, which rounds to 8.99. Rounding the unit
    // price first would give 3.00 × 3 = 9.00, a fil out on three units.
    const q = await resolvePrice({
      ...S, itemCode: "ODD", quantityMilli: 3_000n, partyKey: "DISCOUNTCO", on: "2026-03-01",
    });
    expect(q.discountBps).toBe(1_000);
    expect(q.netMinor).toBe(899n);
    expect(q.why).toContain("less 10% carried by the list");
  });

  it("prices from the party's own list before the default", async () => {
    await createPriceList({ ...S, list: { code: "SPECIAL", name: "Agreed prices", validFrom: "2026-01-01" } });
    await setPrices({ ...S, listCode: "SPECIAL", prices: [{ itemCode: "WIDGET", unitPriceMinor: 7_500n }] });
    await assignPriceList({ ...S, partyKey: "Acme Trading", listCode: "SPECIAL" });
    const q = await resolvePrice({ ...S, itemCode: "WIDGET", partyKey: "acme trading", on: "2026-03-01" });
    expect(q.unitPriceMinor).toBe(7_500n);
    expect(q.source?.assigned).toBe(true);
    expect(q.why).toContain("The party's own list SPECIAL");
    // And what the default would have charged, so the concession is visible.
    expect(q.defaultUnitPriceMinor).toBe(10_000n);
  });

  it("falls back to the default for an item the party's list does not price", async () => {
    const q = await resolvePrice({ ...S, itemCode: "BOLT", partyKey: "ACME TRADING", on: "2026-03-01" });
    expect(q.unitPriceMinor).toBe(250n);
    expect(q.source?.listCode).toBe("LIST");
    expect(q.source?.assigned).toBe(false);
  });

  it("folds the party key, so ACME and acme are one arrangement", () => {
    expect(partyKeyOf("  ACME Trading ")).toBe("acme trading");
  });

  it("refuses one party two sell lists", async () => {
    await expect(assignPriceList({ ...S, partyKey: "acme trading", listCode: "TENOFF" }))
      .rejects.toThrow(/already priced from SPECIAL/);
  });

  it("lets a party have a sell list and a buy list at once", async () => {
    await createPriceList({ ...S, list: { code: "SUPPLY", name: "What they charge us", kind: "BUY", validFrom: "2026-01-01" } });
    await expect(assignPriceList({ ...S, partyKey: "acme trading", listCode: "SUPPLY" })).resolves.toBeTruthy();
  });

  it("does not convert a list in another currency", async () => {
    await createPriceList({
      ...S, list: { code: "USDLIST", name: "Dollar prices", currency: "USD", validFrom: "2026-01-01" },
    });
    await setPrices({ ...S, listCode: "USDLIST", prices: [{ itemCode: "WIDGET", unitPriceMinor: 2_700n }] });
    await assignPriceList({ ...S, partyKey: "DOLLARCO", listCode: "USDLIST" });
    const q = await resolvePrice({ ...S, itemCode: "WIDGET", partyKey: "DOLLARCO", currency: "AED", on: "2026-03-01" });
    expect(q.found).toBe(false);
    expect(q.why).toContain("prices in USD");
    expect(q.why).toContain("not converted");
  });

  it("prices from that list when the document is in its currency", async () => {
    const q = await resolvePrice({ ...S, itemCode: "WIDGET", partyKey: "DOLLARCO", currency: "USD", on: "2026-03-01" });
    expect(q.found).toBe(true);
    expect(q.unitPriceMinor).toBe(2_700n);
    expect(q.currency).toBe("USD");
  });

  it("says so when no list is in force at all on the date", async () => {
    const q = await resolvePrice({ ...S, itemCode: "WIDGET", on: "2025-06-01" });
    expect(q.found).toBe(false);
    expect(q.why).toContain("No sell price list is in force");
  });

  it("does not price a sell item from a buy list", async () => {
    await setPrices({ ...S, listCode: "SUPPLY", prices: [{ itemCode: "WIDGET", unitPriceMinor: 6_000n }] });
    const sell = await resolvePrice({ ...S, itemCode: "WIDGET", partyKey: "acme trading", on: "2026-03-01" });
    expect(sell.unitPriceMinor).toBe(7_500n);
    const buy = await resolvePrice({ ...S, itemCode: "WIDGET", partyKey: "acme trading", kind: "BUY", on: "2026-03-01" });
    expect(buy.unitPriceMinor).toBe(6_000n);
  });

  it("quotes a whole document in one pass", async () => {
    const qs = await quoteLines({
      ...S, on: "2026-03-01", partyKey: "acme trading",
      lines: [
        { itemCode: "WIDGET", quantityMilli: 1_000n },
        { itemCode: "BOLT", quantityMilli: 40_000n },
        { itemCode: "NOTHING", quantityMilli: 1_000n },
      ],
    });
    expect(qs.map((q) => q.found)).toEqual([true, true, false]);
    expect(qs[0].netMinor).toBe(7_500n);
    // Forty bolts at 2.50 is 100.00.
    expect(qs[1].netMinor).toBe(10_000n);
  });

  it("keeps one org's prices out of another's", async () => {
    const q = await resolvePrice({ orgId: OTHER, entityId: ENT, itemCode: "WIDGET", on: "2026-03-01" });
    expect(q.found).toBe(false);
  });

  it("stops pricing a party once the assignment is removed", async () => {
    await unassignPriceList({ ...S, partyKey: "acme trading", listCode: "SPECIAL" });
    const q = await resolvePrice({ ...S, itemCode: "WIDGET", partyKey: "acme trading", on: "2026-03-01" });
    expect(q.source?.listCode).toBe("LIST");
    expect(q.unitPriceMinor).toBe(10_000n);
    await expect(unassignPriceList({ ...S, partyKey: "acme trading", listCode: "SPECIAL" }))
      .rejects.toThrow(LedgerError);
  });
});

d("what was charged against what the list says", () => {
  beforeAll(async () => { await wipe(); await seedDefault(); });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("measures a discount nobody recorded as a discount", async () => {
    const v = await priceVariance({
      ...S, on: "2026-03-01",
      lines: [
        // Ten widgets: list says 1,000.00, the invoice says 900.00.
        { itemCode: "WIDGET", quantityMilli: 10_000n, chargedMinor: 90_000n },
      ],
    });
    expect(v.lines[0].listMinor).toBe(100_000n);
    expect(v.lines[0].varianceMinor).toBe(-10_000n);
    expect(v.lines[0].varianceBps).toBe(-1_000);
    expect(v.totals.varianceMinor).toBe(-10_000n);
  });

  it("gives no variance for a line the list has no opinion about", async () => {
    const v = await priceVariance({
      ...S, on: "2026-03-01",
      lines: [
        { itemCode: "WIDGET", quantityMilli: 10_000n, chargedMinor: 90_000n },
        { itemCode: "CONSULTANCY", quantityMilli: 1_000n, chargedMinor: 500_000n },
      ],
    });
    expect(v.lines[1].listMinor).toBeNull();
    expect(v.lines[1].varianceBps).toBeNull();
    // The unpriced line is out of the totals: including it at nil variance
    // would make the discount on the priced line look smaller than it is.
    expect(v.totals.pricedLines).toBe(1);
    expect(v.totals.unpricedLines).toBe(1);
    expect(v.totals.chargedMinor).toBe(90_000n);
    expect(v.totals.varianceBps).toBe(-1_000);
  });

  it("reports charging above the list as a positive variance", async () => {
    const v = await priceVariance({
      ...S, on: "2026-03-01",
      lines: [{ itemCode: "BOLT", quantityMilli: 100_000n, chargedMinor: 30_000n }],
    });
    // A hundred bolts at 2.50 is 250.00; 300.00 was charged.
    expect(v.lines[0].listMinor).toBe(25_000n);
    expect(v.lines[0].varianceMinor).toBe(5_000n);
    expect(v.lines[0].varianceBps).toBe(2_000);
  });
});

d("the register", () => {
  beforeAll(async () => { await wipe(); await seedDefault(); });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("counts what each list prices and who it prices for", async () => {
    const r = await priceListRegister({ ...S, on: "2026-03-01" });
    const list = r.lists.find((l) => l.code === "LIST")!;
    expect(list.isDefault).toBe(true);
    expect(list.inForce).toBe(true);
    expect(list.livePriceCount).toBe(3);
    expect(list.partyCount).toBe(0);
  });

  it("says when a list is in force and prices nobody", async () => {
    await createPriceList({ ...S, list: { code: "ORPHAN", name: "Nobody's list", validFrom: "2026-01-01" } });
    await setPrices({ ...S, listCode: "ORPHAN", prices: [{ itemCode: "WIDGET", unitPriceMinor: 1n }] });
    const r = await priceListRegister({ ...S, on: "2026-03-01" });
    expect(r.findings.some((f) => f.includes("ORPHAN is in force but no party"))).toBe(true);
  });

  it("says when a list is in force and prices nothing", async () => {
    await createPriceList({ ...S, list: { code: "EMPTY", name: "Nothing on it", validFrom: "2026-01-01" } });
    const r = await priceListRegister({ ...S, on: "2026-03-01" });
    expect(r.findings.some((f) => f.includes("EMPTY is in force and prices nothing"))).toBe(true);
  });

  it("says when there is no default at all, because then nothing is priced", async () => {
    const r = await priceListRegister({ ...S, on: "2025-06-01" });
    expect(r.findings[0]).toContain("No default sell list is in force");
  });

  it("narrows the prices to one list when asked", async () => {
    const r = await priceListRegister({ ...S, on: "2026-03-01", listCode: "orphan" });
    expect(r.prices).toHaveLength(1);
    expect(r.prices[0].listCode).toBe("ORPHAN");
  });
});
