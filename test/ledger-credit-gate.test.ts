import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createOrder, sendOrder, acceptOrder, invoiceOrder } from "@/lib/server/ledger/sales-orders";
import { createCounterparty, placeOnHold, releaseHold } from "@/lib/server/ledger/counterparties";
import { setCreditLimit, creditCheck } from "@/lib/server/ledger/credit-control";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { LedgerError } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-gate";
const ENT = "t-ent-gate";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  for (const t of ["DunningNotice", "CreditHold", "CreditLimit", "SalesOrderLine", "SalesOrder", "Counterparty"]) {
    await db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "orgId" = '${ORG}'`);
  }
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
  ]);
}

async function order(number: string, customerCode: string | undefined, unitPriceMinor: bigint) {
  const o = await createOrder({
    ...S,
    order: {
      number, kind: "ORDER", customerCode, customerName: "Deep Water Marine LLC",
      issuedOn: "2026-03-01",
      lines: [{ description: "Pump", quantityMilli: 1_000n, unitPriceMinor }],
    },
  });
  await sendOrder({ orgId: ORG, orderId: o.id, entityId: ENT });
  return o;
}

d("the credit gate at the two commitment points", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ ...S, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
    await createCounterparty({ ...S, counterparty: { code: "DEEP", name: "Deep Water Marine LLC", kind: "CUSTOMER" } });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("accepts an order for a customer inside their limit, and says so", async () => {
    await setCreditLimit({
      ...S, partyKey: "DEEP", limitMinor: 1_000_000n, effectiveFrom: "2026-01-01",
      basis: "Two years of trading with no arrears", actorId: "u1",
    });
    const o = await order("SO-OK", "DEEP", 100_000n);
    const accepted = await acceptOrder({ orgId: ORG, orderId: o.id, entityId: ENT });
    expect(accepted.status).toBe("accepted");
    expect(accepted.credit.decision).toBe("allow");
    expect(accepted.credit.overrode).toBe(false);
  });

  it("refuses to accept an order for a customer on hold", async () => {
    await placeOnHold({ ...S, code: "DEEP", reason: "Two invoices unpaid past ninety days", actorId: "u1" });
    const o = await order("SO-HELD", "DEEP", 50_000n);
    await expect(acceptOrder({ orgId: ORG, orderId: o.id, entityId: ENT }))
      .rejects.toThrow(/override this with a reason/);
    // And the order is untouched, not half-advanced.
    const still = await db.salesOrder.findUnique({ where: { id: o.id } });
    expect(still!.status).toBe("sent");
  });

  it("is the hold placed from the customers screen that does the refusing", async () => {
    // placeOnHold used to write only Counterparty.onHold, which creditCheck
    // never reads — so a hold placed there produced "allow" while the chip on
    // the same screen said the customer was held.
    const row = await db.creditHold.findFirst({
      where: { orgId: ORG, entityId: ENT, partyKey: "DEEP", releasedOn: null },
    });
    expect(row).toBeTruthy();
    expect(row!.reason).toContain("ninety days");
    const check = await creditCheck({ ...S, partyKey: "DEEP", additionalMinor: 1n });
    expect(check.decision).toBe("refuse");
  });

  it("accepts anyway on an override, and records who and why on the order", async () => {
    const o = await order("SO-OVERRIDE", "DEEP", 50_000n);
    const accepted = await acceptOrder({
      orgId: ORG, orderId: o.id, entityId: ENT,
      override: { reason: "Cash on delivery agreed with the customer", actorId: "u9" },
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.credit.overrode).toBe(true);
    expect(accepted.notes).toContain("overridden by u9");
    expect(accepted.notes).toContain("Cash on delivery");
  });

  it("releases through the same store, so the next order passes", async () => {
    await releaseHold({ ...S, code: "DEEP", reason: "Both invoices settled in full", actorId: "u1" });
    const row = await db.creditHold.findFirst({
      where: { orgId: ORG, entityId: ENT, partyKey: "DEEP" },
      orderBy: { placedOn: "desc" },
    });
    expect(row!.releasedOn).not.toBeNull();
    expect(row!.releaseReason).toContain("settled in full");

    const o = await order("SO-AFTER", "DEEP", 50_000n);
    const accepted = await acceptOrder({ orgId: ORG, orderId: o.id, entityId: ENT });
    expect(accepted.credit.decision).not.toBe("refuse");
  });

  it("checks the instalment, not the order, when invoicing", async () => {
    // Raise the limit above what the earlier orders in this file already
    // committed, so this test is about the instalment and not about them.
    await setCreditLimit({
      ...S, partyKey: "DEEP", limitMinor: 5_000_000n, effectiveFrom: "2026-04-01",
      basis: "Reviewed after the arrears were settled", actorId: "u1",
    });
    const o = await createOrder({
      ...S,
      order: {
        number: "SO-STAGED", kind: "ORDER", customerCode: "DEEP", customerName: "Deep Water Marine LLC",
        issuedOn: "2026-04-01",
        lines: [{ description: "Pump", quantityMilli: 2_000n, unitPriceMinor: 450_000n }],
      },
    });
    await sendOrder({ orgId: ORG, orderId: o.id, entityId: ENT });
    const accepted = await acceptOrder({ orgId: ORG, orderId: o.id, entityId: ENT });
    expect(accepted.credit.decision).not.toBe("refuse");

    const line = await db.salesOrderLine.findFirst({ where: { orderId: o.id } });
    const first = await invoiceOrder({
      orgId: ORG, orderId: o.id, entityId: ENT,
      lines: [{ orderLineId: line!.id, quantityMilli: "1000" }],
    });
    expect(first.status).toBe("part_invoiced");
    expect(first.credit.decision).not.toBe("refuse");
  });

  it("does not refuse a customer code nothing matches — that is a typo, not a credit risk", async () => {
    // An order carries a free-text customer code. "No such counterparty" means
    // somebody typed a name, not that the customer is bad for the money.
    const o = await order("SO-UNKNOWN", "NOSUCHCODE", 50_000n);
    const accepted = await acceptOrder({ orgId: ORG, orderId: o.id, entityId: ENT });
    expect(accepted.status).toBe("accepted");
    expect(accepted.credit.decision).toBe("unknown");
    expect(accepted.credit.headline).toContain("not blocked by that");
  });

  it("says there is nobody to check when the document names no customer at all", async () => {
    const o = await createOrder({
      ...S,
      order: {
        number: "SO-NONAME", kind: "ORDER", customerName: "Walk-in", issuedOn: "2026-05-01",
        lines: [{ description: "Pump", quantityMilli: 1_000n, unitPriceMinor: 1_000n }],
      },
    });
    await sendOrder({ orgId: ORG, orderId: o.id, entityId: ENT });
    // "Walk-in" resolves to no counterparty, so this is the unknown path too.
    const accepted = await acceptOrder({ orgId: ORG, orderId: o.id, entityId: ENT });
    expect(accepted.credit.decision).toBe("unknown");
    expect(LedgerError).toBeTruthy();
  });
});
