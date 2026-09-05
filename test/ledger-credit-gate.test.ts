import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

/**
 * Who is signed in for the route calls at the foot of this file.
 *
 * Hoisted because `vi.mock` is, and written as literals for the same reason —
 * nothing else in this module has been evaluated yet. The workspace configures
 * no roles, which is the shipped default and the state most workspaces are in,
 * so every guard the route calls answers "allowed"; what is under test here is
 * that the gate binds, not who holds what.
 */
const seat = vi.hoisted(() => ({ orgId: "t-org-gate", userId: "u-sales" }));

vi.mock("@/lib/server/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/session")>();
  return { ...actual, requireSession: async () => ({ orgId: seat.orgId, userId: seat.userId }) };
});

import { GET as gateGet, POST as gatePost } from "@/app/api/ledger/credit-control/invoice/route";
import { createOrder, sendOrder, acceptOrder, invoiceOrder } from "@/lib/server/ledger/sales-orders";
import { createCounterparty, placeOnHold, releaseHold } from "@/lib/server/ledger/counterparties";
import {
  setCreditLimit, creditCheck, invoiceCreditGate, overrideNarrative,
  CREDIT_OVERRIDE_PERMISSION,
} from "@/lib/server/ledger/credit-control";
import { postInvoice } from "@/lib/server/ledger/ar";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { LedgerError } from "@/lib/server/ledger/post";
import type { Invoice, InvoiceLine } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-gate";
const ENT = "t-ent-gate";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  for (const t of ["DunningNotice", "CreditHold", "CreditLimit", "SalesOrderLine", "SalesOrder", "Counterparty", "Record"]) {
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

/** The entity whose books have never been opened, so account 1100 does not exist. */
const NOBOOKS = "t-ent-gate-nobooks";

let docSeq = 0;
const line = (net: number, vat: number): InvoiceLine => ({
  id: `gl${++docSeq}`, lineNo: docSeq, description: "Hull survey", qty: 1, unitCode: "C62",
  unitPriceMinor: net, taxProfileCode: "STANDARD_5", lineNetMinor: net, lineVatMinor: vat,
});

function doc(over: Partial<Invoice>, net: number, vat: number): Invoice {
  return {
    id: `gate-${++docSeq}`, orgId: ORG, entityId: ENT, direction: "OUTBOUND", docType: "TAX_INVOICE",
    number: `INV-${docSeq}`, issueDate: "2026-03-01", supplyDate: "2026-03-01", currency: "AED",
    buyer: { nameEn: "Marina Works LLC" }, seller: { nameEn: "Our Company" },
    lines: [line(net, vat)],
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "DRAFT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED", source: "EDITOR",
    compliance: { taxableEventDate: "2026-03-01", daysRemaining: 14, breached: false },
    createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z",
    ...over,
  } as Invoice;
}

/** Put the document in the tenant store and on the books, as a real sale would be. */
async function issue(inv: Invoice) {
  await db.record.create({
    data: { id: inv.id, orgId: ORG, store: "invoices", entityId: inv.entityId, data: JSON.stringify(inv) },
  });
  await postInvoice({ orgId: ORG, invoice: { ...inv, lifecycleStatus: "SENT" } });
  return inv;
}

/** Put a draft in the tenant store, where the route reads it from. */
async function draftInStore(inv: Invoice) {
  await db.record.create({
    data: { id: inv.id, orgId: ORG, store: "invoices", entityId: inv.entityId, data: JSON.stringify(inv) },
  });
  return inv;
}

const stored = async (id: string) =>
  JSON.parse((await db.record.findUnique({ where: { store_id: { store: "invoices", id } } }))!.data) as Invoice;

async function timelineOf(invoiceId: string) {
  const rows = await db.record.findMany({ where: { orgId: ORG, store: "invoiceEvents", invoiceId } });
  // Read back by type rather than by position: the store returns rows in no
  // order of its own, and which of two events written in the same second sorts
  // first is not what any of this is about.
  return rows.map((r) => JSON.parse(r.data) as { type: string; detail: string; actor: string; tone: string });
}

const eventTypes = (t: { type: string }[]) => [...t.map((e) => e.type)].sort();

interface RouteAnswer {
  status: number;
  body: {
    error?: string;
    alreadyFinalised?: boolean;
    invoice?: Invoice;
    gate?: { decision: string; allowed: boolean; overrode: boolean; creditLimitMinor: string | null; exposureMinor: string | null; reasons: { code: string }[] } | null;
    finalised?: boolean;
  };
}

async function finalise(invoiceId: string, overrideReason?: string): Promise<RouteAnswer> {
  const res = await gatePost(
    new Request("http://localhost/api/ledger/credit-control/invoice", {
      method: "POST",
      body: JSON.stringify({ invoiceId, ...(overrideReason ? { overrideReason } : {}) }),
    }),
  );
  return { status: res.status, body: (await res.json()) as RouteAnswer["body"] };
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

  /* ------------------------------ the gate where there is no sales order */

  /*
   * The other commitment point, and the hole this half of the file exists for.
   *
   * `creditCheck` had exactly one enforcing caller — the order gate above — so
   * a business that raises invoices without raising orders first had limits set
   * and holds placed and nothing that ever consulted either. Not one of the
   * tests below creates an order.
   *
   * Every one of them states `asOf`, because the gate reads exposure as at the
   * day the commitment is made and "today" moves.
   */

  it("refuses an invoice that would take the customer past their limit, and says by how much", async () => {
    await createCounterparty({
      ...S, counterparty: { code: "MARINA", name: "Marina Works LLC", kind: "CUSTOMER", paymentTerms: 30 },
    });
    await setCreditLimit({
      ...S, partyKey: "MARINA", limitMinor: 200_000n, effectiveFrom: "2026-01-01",
      basis: "One year of trade, references taken", actorId: "u1",
    });
    // Already on the sales ledger: 105,000 of it.
    await issue(doc({ number: "INV-M1", customerId: "MARINA", dueDate: "2026-03-31" }, 100_000, 5_000));

    const draft = doc({ number: "INV-M2", customerId: "MARINA", dueDate: "2026-03-31" }, 100_000, 5_000);
    const gate = await invoiceCreditGate({ ...S, invoice: draft, asOf: "2026-03-15" });

    expect(gate.decision).toBe("refuse");
    expect(gate.allowed).toBe(false);
    // A refusal that does not carry these four figures is a refusal people work
    // around: the salesperson cannot tell "ten thousand over" from "nobody has
    // ever assessed this account" without them.
    expect(gate.creditLimitMinor).toBe("200000");
    expect(gate.exposureMinor).toBe("105000");
    expect(gate.additionalMinor).toBe("105000");
    expect(gate.wouldBeMinor).toBe("210000");
    expect(gate.overByMinor).toBe("10000");
    expect(gate.reasons.map((r) => r.code)).toContain("would_exceed_limit");
    expect(gate.reasons.find((r) => r.code === "would_exceed_limit")!.blocking).toBe(true);
    // And who to go and ask, which is the difference between a refusal and a
    // dead end. It is not the grant that raises the invoice.
    expect(gate.overridePermission).toBe(CREDIT_OVERRIDE_PERMISSION);
    expect(gate.overridePermission).toBe("ar.credit_hold");
  });

  it("lets it through on an override, and the record carries the figures it was taken against", async () => {
    const draft = doc({ number: "INV-M3", customerId: "MARINA", dueDate: "2026-03-31" }, 100_000, 5_000);
    const gate = await invoiceCreditGate({
      ...S, invoice: draft, asOf: "2026-03-15",
      override: { reason: "Cash on delivery agreed with the customer", actorId: "u9" },
    });
    expect(gate.decision).toBe("refuse");
    expect(gate.allowed).toBe(true);
    expect(gate.overrode).toBe(true);
    expect(gate.override).toEqual({ reason: "Cash on delivery agreed with the customer", actorId: "u9" });

    // What goes on the document's timeline. The exposure will have moved by the
    // time anybody reads it back, so the narrative carries the figures rather
    // than pointing at a check that would now answer differently.
    const note = overrideNarrative(gate, "u9");
    expect(note).toContain("u9");
    expect(note).toContain("Cash on delivery agreed with the customer");
    expect(note).toContain("2,000.00");  // the limit
    expect(note).toContain("1,050.00");  // what they already carried
    expect(note).toContain("over their limit");
  });

  it("refuses an invoice to a customer on hold — the hole that let one be raised anyway", async () => {
    await createCounterparty({
      ...S, counterparty: { code: "HELDCO", name: "Held Company LLC", kind: "CUSTOMER" },
    });
    await placeOnHold({ ...S, code: "HELDCO", reason: "Cheque returned unpaid twice", actorId: "u1" });

    const draft = doc(
      { number: "INV-H1", customerId: "HELDCO", buyer: { nameEn: "Held Company LLC" } },
      10_000, 500,
    );
    const gate = await invoiceCreditGate({ ...S, invoice: draft, asOf: "2026-03-15" });
    expect(gate.decision).toBe("refuse");
    expect(gate.allowed).toBe(false);
    expect(gate.reasons.map((r) => r.code)).toContain("on_hold");
    expect(gate.headline).toContain("Cheque returned unpaid twice");
  });

  it("does not gate a credit note — it is the document that brings them back under the limit", async () => {
    const note = doc(
      { number: "CRN-M1", customerId: "MARINA", docType: "TAX_CREDIT_NOTE" },
      100_000, 5_000,
    );
    const gate = await invoiceCreditGate({ ...S, invoice: note, asOf: "2026-03-15" });
    expect(gate.allowed).toBe(true);
    expect(gate.decision).toBe("unknown");
    expect(gate.headline).toContain("credit note");
  });

  it("does not refuse a buyer nothing matches — that is a typo, not a credit risk", async () => {
    const draft = doc({ number: "INV-X1", buyer: { nameEn: "Nobody In Particular LLC" } }, 10_000, 500);
    const gate = await invoiceCreditGate({ ...S, invoice: draft, asOf: "2026-03-15" });
    expect(gate.decision).toBe("unknown");
    expect(gate.allowed).toBe(true);
    expect(gate.headline).toContain("not blocked by that");
  });

  it("does not refuse because the entity has never opened its books", async () => {
    // A credit control that fires hardest where there is no credit information
    // at all would stop every invoice in a workspace that has not opened a
    // ledger — which is most of them on the first day.
    await createCounterparty({
      orgId: ORG, entityId: NOBOOKS,
      counterparty: { code: "FRESH", name: "Fresh Start LLC", kind: "CUSTOMER" },
    });
    const draft = doc(
      { number: "INV-F1", entityId: NOBOOKS, customerId: "FRESH", buyer: { nameEn: "Fresh Start LLC" } },
      10_000, 500,
    );
    const gate = await invoiceCreditGate({ orgId: ORG, entityId: NOBOOKS, invoice: draft, asOf: "2026-03-15" });
    expect(gate.decision).toBe("unknown");
    expect(gate.allowed).toBe(true);
    expect(gate.headline).toContain("1100");
  });

  it("says so rather than guessing when the document cannot be converted into the book's currency", async () => {
    const draft = doc(
      { number: "INV-M4", customerId: "MARINA", currency: "USD", dueDate: "2026-03-31" },
      100_000, 5_000,
    );
    const gate = await invoiceCreditGate({ ...S, invoice: draft, asOf: "2026-03-15" });
    // Nothing was added to the exposure, and the answer says why rather than
    // converting at a rate nobody has stated.
    expect(gate.additionalMinor).toBe("0");
    expect(gate.caveat).toContain("carries no rate");
    expect(gate.exposureMinor).toBe("105000");
  });

  it("still lets the ledger record an invoice the gate refused", async () => {
    // The gate stops the sale; it does not stop the books. Refusing to post a
    // document the customer is already holding would leave the ledger denying
    // it, which is the reasoning postInvoice states for not calling the check.
    const raised = doc({ number: "INV-M5", customerId: "MARINA", dueDate: "2026-03-31" }, 100_000, 5_000);
    const gate = await invoiceCreditGate({ ...S, invoice: raised, asOf: "2026-03-15" });
    expect(gate.allowed).toBe(false);

    // Issued regardless, as it would be after an override: into the store, and
    // onto the books. From here Marina carries 210,000 against a 200,000 limit,
    // which is what the route tests below are refusing.
    await issue(raised);
    const posted = await postInvoice({ orgId: ORG, invoice: { ...raised, lifecycleStatus: "SENT" } });
    expect(posted.alreadyPosted).toBe(true);
    expect(posted.reference).toMatch(/-/);
  });

  /* --------------------------------------- the gate as the route enforces it */

  /*
   * The defect was not that the check was wrong. It was that nothing on the
   * invoice path called it: a limit could be set, a hold placed, and an invoice
   * raised for that customer with nothing said. So these drive the route, which
   * is where the check and the DRAFT → READY transition are the same act — a
   * gate the client is trusted to consult before doing the thing anyway is a
   * suggestion, and these are what stop it becoming one again.
   */

  it("finalises a draft that is inside the limit, and says so on the timeline", async () => {
    await createCounterparty({
      ...S, counterparty: { code: "CLEANCO", name: "Clean Slate Trading LLC", kind: "CUSTOMER", paymentTerms: 30 },
    });
    await setCreditLimit({
      ...S, partyKey: "CLEANCO", limitMinor: 500_000n, effectiveFrom: "2026-01-01",
      basis: "New account, opened on a bank reference", actorId: "u1",
    });
    const draft = await draftInStore(
      doc({ number: "INV-C1", customerId: "CLEANCO", buyer: { nameEn: "Clean Slate Trading LLC" } }, 10_000, 500),
    );

    const r = await finalise(draft.id);
    expect(r.status).toBe(200);
    expect(r.body.gate!.decision).toBe("allow");
    expect((await stored(draft.id)).lifecycleStatus).toBe("READY");

    const timeline = await timelineOf(draft.id);
    expect(eventTypes(timeline)).toEqual(["ready"]);
    expect(timeline[0].actor).toBe("u-sales");
  });

  it("refuses to finalise over the limit, and leaves the draft exactly where it was", async () => {
    // MARINA already carries 210,000 against a limit of 200,000 by this point.
    const draft = await draftInStore(doc({ number: "INV-M6", customerId: "MARINA" }, 10_000, 500));

    const r = await finalise(draft.id);
    expect(r.status).toBe(409);
    expect(r.body.gate!.allowed).toBe(false);
    expect(r.body.gate!.decision).toBe("refuse");
    // The answer a person can act on: what they may owe and what they owe.
    expect(r.body.gate!.creditLimitMinor).toBe("200000");
    expect(r.body.gate!.exposureMinor).toBe("210000");
    expect(r.body.error).toContain("over their credit limit");

    // Nothing moved. Not the document, and not its timeline.
    expect((await stored(draft.id)).lifecycleStatus).toBe("DRAFT");
    expect(await timelineOf(draft.id)).toEqual([]);
  });

  it("finalises on an override, and writes the override where the next person reads it", async () => {
    const draft = await draftInStore(doc({ number: "INV-M7", customerId: "MARINA" }, 10_000, 500));

    const r = await finalise(draft.id, "Director agreed cash on delivery for this one order");
    expect(r.status).toBe(200);
    expect(r.body.gate!.overrode).toBe(true);
    expect((await stored(draft.id)).lifecycleStatus).toBe("READY");

    const timeline = await timelineOf(draft.id);
    expect(eventTypes(timeline)).toEqual(["credit_override", "ready"]);
    const override = timeline.find((e) => e.type === "credit_override")!;
    expect(override.tone).toBe("warning");
    expect(override.detail).toContain("Director agreed cash on delivery");
    expect(override.detail).toContain("u-sales");
    // The figures it was taken against, because the check will answer
    // differently by the time anybody reads this back.
    expect(override.detail).toContain("2,000.00");
    expect(override.detail).toContain("2,100.00");
    expect(override.detail).toContain("Grounds:");
  });

  it("is idempotent, so a second press finds the work done rather than doing it twice", async () => {
    const draft = await draftInStore(doc({ number: "INV-C2", customerId: "CLEANCO" }, 10_000, 500));
    expect((await finalise(draft.id)).status).toBe(200);

    const again = await finalise(draft.id);
    expect(again.status).toBe(200);
    expect(again.body.alreadyFinalised).toBe(true);
    // One transition, one line on the timeline.
    expect(await timelineOf(draft.id)).toHaveLength(1);
  });

  it("answers where the customer stands without writing anything", async () => {
    const draft = await draftInStore(doc({ number: "INV-M8", customerId: "MARINA" }, 10_000, 500));
    const res = await gateGet(
      new Request(`http://localhost/api/ledger/credit-control/invoice?invoiceId=${draft.id}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RouteAnswer["body"];
    expect(body.finalised).toBe(false);
    expect(body.gate!.decision).toBe("refuse");
    // Asking changed nothing: that is the whole difference between the read and
    // the finalisation, and a read that recorded a refusal would be a read
    // people learn to avoid.
    expect((await stored(draft.id)).lifecycleStatus).toBe("DRAFT");
    expect(await timelineOf(draft.id)).toEqual([]);
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
